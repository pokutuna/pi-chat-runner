// ActiveSession — 1 セッションの生存期間 (spawn → ターン実行 → 終了) を自分で
// 管理する主語 (Step 4)。SessionRunner はレーン解決とレジストリ
// (Map<sessionKey, ActiveSession>) だけを持ち、1 セッションの遷移はここに閉じる。
//
// docs/design/architecture.md §1 (event は「きっかけ係」、session が「処理の担い手」)、
// §6 (起動と steering のフロー)、docs/design/session-runtime.md §1 (kick シーケンス)、
// §3 (tmpfs + 境界 flush)、§6 (turn timeout)、docs/design/persistence.md §3 (flush → ack
// の順序)。

import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ChannelDoc } from "../config/channel-doc.js";
import type { Reactions } from "../egress/reactions.js";
import type { EgressRouter } from "../egress/router.js";
import type { InboundMessage } from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import { inboxItemId } from "../store/state/inbox-item.js";
import type { Lease, StateStore } from "../store/state/interfaces.js";
import type { SharedStorage, WorkdirStorage } from "../store/workdir.js";
import {
  extractReply,
  extractTurnErrors,
  extractUsageTotals,
  piEventLogFields,
  type UsageTotals,
} from "./pi-events.js";
import { renderEvent, renderItems, type SessionPolicy } from "./policy.js";
import { ProgressNotice } from "./progress.js";
import {
  buildSystemPrompt,
  type MentionFormat,
  prependContext,
} from "./prompt.js";
import { registerReplyDestination } from "./reply-destination.js";
import { isAgentEnd, isToolExecutionEnd, isToolExecutionStart } from "./rpc.js";
import { PiProcess, type PiPermissionOptions } from "./runtime.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ActiveSession がレジストリ (SessionRunner) に対して要求する操作。全終了経路の
 * Map delete と markSessionPointerEnded の呼び出しをこのポート経由に集約する */
export interface SessionHost {
  /** レジストリから自分を外す (全終了経路の Map delete の置き換え) */
  remove(session: ActiveSession): void;
  /** windowSec 起点の記録 (旧 markSessionPointerEnded の呼び出し) */
  markEnded(channelId: string, sessionKey: string): Promise<void>;
}

/** ActiveSession の構築に必要な依存一式。identity 一式・lease は runner
 * (acquireLeaseAndKick) が取得してから渡す */
export interface ActiveSessionOptions {
  sessionKey: string;
  channelId: string;
  threadTs: string;
  /** トリガーメッセージの ts (👀 / ✅ の対象) */
  triggerTs: string;
  workdir: string;
  /** kick 時に導出した session.mode / reply.mode。promptPending / start から
   * 参照して宛先登録・フォールバック登録に使う (session-model.md §3) */
  policy: SessionPolicy;
  /** このプロセスが保持する実行ロック。renew に失敗したら排他を失っている */
  lease: Lease;
  host: SessionHost;
  store: StateStore;
  router: EgressRouter;
  reactions: Reactions;
  workdirStorage: WorkdirStorage;
  sharedStorage: SharedStorage | undefined;
  /** チャンネル共有ディレクトリの staging パス (docs/design/shared.md §1) */
  sharedStagingDir: string | undefined;
  lingerMs: number;
  turnTimeoutMs: number;
  leaseTtlMs: number;
  progressNoticeIntervalMs: number;
  logger: Logger;
}

/** start() に渡す、spawn 準備 (spawn.ts の関数群) の結果と PiProcess 生成に必要な
 * 設定。ActiveSession は spawn 準備を自分では持たない — runner の kick 相当が
 * prepareWorkdir / buildSpawnOptions / loadMemoryIndex を呼んだ結果を束ねて渡す */
export interface StartArgs {
  triggerEvent: InboundMessage;
  doc: ChannelDoc | null;
  /** PiProcess construction 用 */
  sessionPath: string;
  extensionPaths: string[];
  workdirReal: string;
  sharedDirReal: string | undefined;
  skillPaths: string[];
  permission: PiPermissionOptions | undefined;
  memoryIndex: string | undefined;
  /** kick 開始時点で session.jsonl が既に存在したか ("session started" ログ用) */
  resumed: boolean;
  model: string | undefined;
  mentionFormat: MentionFormat;
  /** allowlist に追加で pi 子プロセスへ渡す env (HOME=agentHomeReal を含む) */
  extraEnv: Record<string, string>;
  piBinary: string | undefined;
  piEntrypoint: string | undefined;
  agentUid: number | undefined;
  agentGid: number | undefined;
}

export class ActiveSession {
  readonly sessionKey: string;
  readonly channelId: string;
  readonly threadTs: string;
  /** トリガーメッセージの ts (👀 / ✅ の対象) */
  readonly triggerTs: string;
  readonly workdir: string;
  /** kick 時に導出した session.mode / reply.mode。promptPending / start から
   * 参照して宛先登録・フォールバック登録に使う (session-model.md §3) */
  readonly policy: SessionPolicy;

  /** starting = spawn 準備中 (多重起動防止のため Map 登録済み)、
   * running = PiProcess がターンを実行中、lingering = agent_end 後の終了判定中
   * (アイドルな pi。promptPending が prompt を送ると running に戻る)、
   * stopping = 終了処理中 (exit を異常扱いしない) */
  #state: "starting" | "running" | "lingering" | "stopping" = "starting";
  #process?: PiProcess;
  /** kick 開始時刻 (finished ログの durationMs 算出用) */
  readonly #startedAt: number;
  /** このプロセスが保持する実行ロック。renew に失敗したら排他を失っている */
  readonly #lease: Lease;
  /** このセッションで prompt/steer 済みの item id。drain は非破壊 (未 ack 全件を
   * 返す) なので、重複除外はこのインメモリ記憶で行う (persistence.md §1) */
  readonly #promptedIds = new Set<string>();
  /** prompt/steer を送るたびに増える世代。agent_end 処理中に増えていたら
   * 新しいターンが走り出しているので、終了判定をそのターンの agent_end に譲る */
  #turnEpoch = 0;
  #renewTimer: NodeJS.Timeout | undefined;
  /** 現ターンの timeout タイマー。prompt/steer 送信 (turnEpoch 増加箇所) ごとに
   * リセットし、agent_end 冒頭でクリアする。セッション終了パスでも必ずクリアする
   * (session-runtime.md §6 の turn timeout) */
  #turnTimeoutTimer: NodeJS.Timeout | undefined;
  /** 進捗通知 (progress-notice.md)。タイマーの寿命は turnTimeoutTimer と同じく
   * prompt/steer 送信ごとに reset、agent_end 冒頭で clear。currentTool/toolCallCount/
   * lastText の状態は内部に閉じる */
  readonly #progress: ProgressNotice;
  /** 直近の agent_end から集計した usage の累計 (agent_end.messages は毎回全履歴
   * を返すため、ターンごとの増分ではなくセッション累計になる) */
  #usageTotals?: UsageTotals;

  /** レジストリから外れた (旧: this.sessions.get(sessionKey) !== record)。全終了
   * 経路の Map delete の代わりに立てるフラグ。stale チェックの主語になる */
  #disposed = false;

  readonly #host: SessionHost;
  readonly #store: StateStore;
  readonly #router: EgressRouter;
  readonly #reactions: Reactions;
  readonly #workdirStorage: WorkdirStorage;
  readonly #sharedStorage: SharedStorage | undefined;
  readonly #sharedStagingDir: string | undefined;
  readonly #lingerMs: number;
  readonly #turnTimeoutMs: number;
  readonly #leaseTtlMs: number;
  readonly #logger: Logger;

  constructor(options: ActiveSessionOptions) {
    this.sessionKey = options.sessionKey;
    this.channelId = options.channelId;
    this.threadTs = options.threadTs;
    this.triggerTs = options.triggerTs;
    this.workdir = options.workdir;
    this.policy = options.policy;
    this.#startedAt = Date.now();
    this.#lease = options.lease;
    this.#host = options.host;
    this.#store = options.store;
    this.#router = options.router;
    this.#reactions = options.reactions;
    this.#workdirStorage = options.workdirStorage;
    this.#sharedStorage = options.sharedStorage;
    this.#sharedStagingDir = options.sharedStagingDir;
    this.#lingerMs = options.lingerMs;
    this.#turnTimeoutMs = options.turnTimeoutMs;
    this.#leaseTtlMs = options.leaseTtlMs;
    this.#logger = options.logger;
    this.#progress = new ProgressNotice({
      sessionKey: options.sessionKey,
      router: options.router,
      intervalMs: options.progressNoticeIntervalMs,
      logger: options.logger,
    });
  }

  get state(): "starting" | "running" | "lingering" | "stopping" {
    return this.#state;
  }

  /** PiProcess がターンを実行中か (steer 可否判定に使う。旧 record.process?.running) */
  get processRunning(): boolean {
    return this.#process?.running === true;
  }

  /** kick 後半 (session-runtime.md §1: PiProcess 生成〜イベントハンドラ登録〜start〜
   * register〜初回 prompt〜sessions.put〜started ログ)。spawn 準備 (spawn.ts の
   * 関数群) の結果は args で受け取る — ActiveSession は spawn 準備を持たない */
  async start(args: StartArgs): Promise<void> {
    const sessionKey = this.sessionKey;
    const { channelId, threadTs, workdir, policy } = this;
    const {
      triggerEvent,
      doc,
      sessionPath,
      extensionPaths,
      workdirReal,
      sharedDirReal,
      skillPaths,
      permission,
      memoryIndex,
      resumed,
      model,
      mentionFormat,
      extraEnv,
      piBinary,
      piEntrypoint,
      agentUid,
      agentGid,
    } = args;

    const proc = new PiProcess({
      sessionPath,
      extensionPaths,
      cwd: workdirReal,
      appendSystemPrompt: buildSystemPrompt(
        sessionKey,
        doc,
        mentionFormat,
        sharedDirReal !== undefined,
        memoryIndex,
      ),
      ...(piBinary !== undefined ? { piBinary } : {}),
      ...(piEntrypoint !== undefined ? { piEntrypoint } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(doc?.tools !== undefined ? { tools: doc.tools } : {}),
      ...(doc?.excludeTools !== undefined
        ? { excludeTools: doc.excludeTools }
        : {}),
      ...(skillPaths.length > 0 ? { skillPaths } : {}),
      ...(extraEnv !== undefined ? { extraEnv } : {}),
      ...(agentUid !== undefined ? { uid: agentUid } : {}),
      ...(agentGid !== undefined ? { gid: agentGid } : {}),
      ...(permission !== undefined ? { permission } : {}),
      // pi は正常時にも stderr へ出すことがあるため warn ではなく debug
      logger: (line) => this.#logger.debug({ sessionKey, line }, "pi stderr"),
    });

    proc.on("event", (piEvent) => {
      // ペイロード全体はログに残さない (大きい・機微を含みうる)。イベント種別ごとの
      // 概要フィールドだけ出す。ストリーミング差分は null が返るのでログしない
      const logFields = piEventLogFields(piEvent);
      if (logFields !== null) {
        this.#logger.debug(
          { sessionKey, eventType: piEvent.type, ...logFields },
          "pi event",
        );
      }
      // 進捗通知 (progress-notice.md) のための状態更新のみ。LLM 呼び出しも
      // session.jsonl への書き込みも発生しない — pi の RPC イベントの観測だけ
      if (isToolExecutionStart(piEvent)) {
        // reply は「最終回答を作っている」段階であり進捗表示の対象外
        // (progress-notice.md)。currentTool/toolCallCount を更新せず、直前の
        // スナップショットのまま据え置く — reply 実行中の表示がターン最後の
        // 進捗として残るのを避ける。ターン最初のツールが reply なら currentTool
        // は undefined のままで ":thinking_face: ... (step 0)" 側の表示になる
        if (piEvent.toolName !== "reply") {
          this.#progress.onToolStart(piEvent.toolName, piEvent.args);
        }
      }
      if (isToolExecutionEnd(piEvent)) {
        const payload = extractReply(piEvent);
        if (payload !== null) {
          // files は必ず resolveReplyFiles の結果で上書きする。payload.files には
          // agent が渡した生の相対パスが残っているため、全件除外時 (files === undefined)
          // にそれをそのまま poster へ流すと境界チェックを素通りしてしまう
          this.#resolveReplyFiles(sessionKey, workdirReal, payload.files)
            .then((files) =>
              this.#router.deliver(
                {
                  thread_key: payload.thread_key,
                  text: payload.text,
                  ...(files !== undefined ? { files } : {}),
                },
                sessionKey,
              ),
            )
            .then(() => {
              // reply の tool_execution_end を受けた時点で、agent_end を待たず
              // タイマーを即止める (progressConsumed の真偽によらず)。待つとその間に
              // タイマーが再発火し、進捗メッセージを消費済みなら (古いツール名のまま)
              // 跡地に新規投稿し、消費対象が無かった短いターンでも reply 完了後に
              // ノイズとなる進捗メッセージを新規投稿してしまう (progress-notice.md)
              this.#progress.clear();
            })
            .catch((err) => {
              this.#logger.warn(
                { sessionKey, threadKeyPayload: payload.thread_key, err },
                "reply delivery failed",
              );
            });
        }
        return;
      }
      if (isAgentEnd(piEvent)) {
        // ターン内の LLM 呼び出し失敗は agent_end としては正常終了になるので、
        // ここで拾わないとログに一切残らない (pi-events.ts extractTurnErrors)
        for (const errorMessage of extractTurnErrors(piEvent)) {
          this.#logger.error(
            { sessionKey, errorMessage },
            "assistant turn ended with error",
          );
        }
        // agent_end.messages は毎回全履歴を返すため、この totals はターンの増分では
        // なくセッション累計 (pi-events.ts extractUsageTotals)
        const totals = extractUsageTotals(piEvent);
        this.#usageTotals = totals;
        this.#logger.info({ sessionKey, ...totals }, "turn usage");
        // 進捗タイマーは agent_end を受けた時点で即止める。onAgentEnd の
        // teardown まで待つと、その間の await の隙間でタイマー tick がもう一件
        // 発火し、deliver 済みの reply の後に古いツール名で新規投稿してしまう
        this.#progress.clear();
        void this.#onAgentEnd(proc).catch((err) => {
          this.#logger.warn({ sessionKey, err }, "agent_end handling failed");
        });
      }
    });
    proc.on("response", (response) => {
      // success: true は prompt/steer の受理応答に過ぎない (agent_end が本当の
      // 終端)。debug ログのみで十分
      if (response.success) {
        this.#logger.debug(
          { sessionKey, command: response.command },
          "pi command accepted",
        );
        return;
      }
      // success: false は pi 側が「動けない」と判断したケース (認証エラー等)。
      // pi は生きたまま次コマンドを待つが、agent_end が来ないので何もしなければ
      // runner は永久に無音ハングする → ここで異常終了として扱いプロセスを止める
      this.#logger.error(
        { sessionKey, command: response.command, error: response.error },
        "pi command failed",
      );
      void this.#failSession(proc, response.error).catch((err) => {
        this.#logger.warn({ sessionKey, err }, "failSession handling failed");
      });
    });
    proc.on("invalid", (raw, error) => {
      this.#logger.debug(
        { sessionKey, raw: raw.slice(0, 500), error },
        "pi stdout line invalid",
      );
    });
    proc.on("exit", (code, signal) => {
      // 正常終了パス (onAgentEnd) では state を stopping にしてから stop している。
      // running のまま exit したら異常終了。lease を解いて次のイベントで拾い直せるようにする
      // (flush はしない)
      if (
        !this.#disposed &&
        this.#process === proc &&
        this.#state !== "stopping"
      ) {
        this.#dispose();
        this.#clearAllTimers();
        void this.#router.clearProgress(sessionKey).catch((err) => {
          this.#logger.warn({ sessionKey, err }, "clear progress failed");
        });
        // このターンで prompt 済みだった item は ack して捨てる。retry しない
        // (session-model.md §6)。捨てないと未 ack のまま inbox に残り、次の新規
        // イベントの drain が巻き込んで再 prompt するため、workdir/transcript を
        // 使い回す構造上「同じ入力で pi が再クラッシュし続ける」ループになりうる。
        // 異常終了はユーザーに ❌ で伝わるので、必要なら本人が言い直せばよい
        const toAck = [...this.#promptedIds];
        if (toAck.length > 0) {
          void this.#store.inbox.ack(sessionKey, toAck).catch((err) => {
            this.#logger.warn({ sessionKey, err }, "inbox ack failed");
          });
        }
        void this.#store.leases.release(this.#lease).catch((err) => {
          this.#logger.warn({ sessionKey, err }, "lease release failed");
        });
        void this.#host.markEnded(this.channelId, sessionKey);
        this.#logger.warn(
          { sessionKey, code, signal },
          "pi exited unexpectedly",
        );
        // pi のクラッシュはユーザーから見えない (返信なしで無音になる) ので、
        // トリガーメッセージに ❌ を付けて失敗を伝える
        void this.#safeReact(
          () => this.#reactions.addX(this.channelId, this.triggerTs),
          sessionKey,
          "x",
        );
      }
    });

    proc.start();
    this.#state = "running";
    this.#process = proc;
    this.#startRenewTimer();

    // sessionKey でのフォールバック登録 (abnormalShutdown が thread_key: sessionKey で
    // 通知を送るために必要)。sessionMode "channel" かつ replyMode "flat" ならチャンネル
    // 直下、それ以外はトリガーのスレッドへ (session-model.md §3)
    if (policy.sessionMode === "channel" && policy.replyMode === "flat") {
      this.#router.register(sessionKey, { channelId });
    } else {
      this.#router.register(sessionKey, { channelId, threadTs });
    }
    await this.#safeReact(
      () => this.#reactions.addEyes(channelId, this.triggerTs),
      sessionKey,
      "eyes",
    );

    // enqueue 済みの入力 (spawn 準備中に積まれた分を含む) を束ねて初回 prompt にする。
    // トリガーイベント自身も enqueue 済みなので通常 drain 経由で届く。
    // ChannelDoc.context は初回のみ先頭に注入する (config.md §4)
    const items = (await this.#store.inbox.drain(sessionKey)).filter(
      (i) => !this.#promptedIds.has(i.id),
    );
    let body: string;
    if (items.length > 0) {
      for (const i of items) {
        registerReplyDestination(this.#router, i.event, policy);
        this.#promptedIds.add(i.id);
      }
      body = renderItems(items);
    } else {
      // drain が空 (Store 実装の遅延など)。トリガーイベントに直接フォールバック
      // するが、ack 対象には含める (二重 prompt を防ぐ)
      const triggerKey = registerReplyDestination(
        this.#router,
        triggerEvent,
        policy,
      );
      this.#promptedIds.add(inboxItemId(triggerEvent));
      body = renderEvent(triggerEvent, triggerKey);
    }
    this.#turnEpoch += 1;
    this.#resetTurnTimeout();
    this.#progress.reset();
    proc.prompt(prependContext(body, doc));

    await this.#store.sessions.put(sessionKey, {
      channelId,
      threadTs,
      triggerTs: this.triggerTs,
      status: "active",
      updatedAt: new Date(),
    });
    this.#logger.info(
      {
        sessionKey,
        workdir,
        resumed,
        model,
        items: items.length,
      },
      "session started",
    );
  }

  /** start() が throw したときのロールバック (旧 acquireLeaseAndKick の catch 節の
   * セッション所有部分)。timer/process の後始末と progress レーンのクリアを行い、
   * disposed を立ててレジストリから外す。lease の release / markEnded / warn ログは
   * 呼び出し元 (runner) が現行と同じ順序で続けて行う。best-effort — stop の失敗は
   * spawn 途中の失敗などで起こりうるので飲み込む */
  async abort(): Promise<void> {
    this.#dispose();
    this.#clearAllTimers();
    await this.#router.clearProgress(this.sessionKey);
    try {
      await this.#process?.stop();
    } catch {
      // spawn 途中の失敗など。stop は best-effort でよい
    }
  }

  /** running なレーンへの steer 配達 (trySteerExisting の後半)。呼び出し元 (runner)
   * が state === "running" && processRunning を確認済みで、enqueue / dedupe /
   * touchSessionPointer を済ませてから呼ぶ。drain → 未 prompt 抽出 → 宛先登録 →
   * steer を行う */
  async steerPending(): Promise<void> {
    const sessionKey = this.sessionKey;
    const proc = this.#process;
    if (proc === undefined) return;
    const items = await this.#store.inbox.drain(sessionKey);
    const pending = items.filter((i) => !this.#promptedIds.has(i.id));
    if (pending.length > 0) {
      // steer 前に宛先登録 (session-model.md §3 の境界規則)
      for (const p of pending) {
        registerReplyDestination(this.#router, p.event, this.policy);
      }
      for (const p of pending) this.#promptedIds.add(p.id);
      this.#turnEpoch += 1;
      this.#resetTurnTimeout();
      this.#progress.reset();
      proc.steer(renderItems(pending));
      this.#logger.info(
        { sessionKey, items: pending.length },
        "session steered",
      );
    }
  }

  /** reply の files (agent が渡した workdir 相対パス) を workdirReal 基準の絶対パスへ
   * 解決し、workdir 外へ出るパス (`../` エスケープ、絶対パス指定) は除外して warn する
   * (trust boundary: agent は semi-trusted)。加えて symlink 越しの workdir 外ファイル
   * 参照 (例: `/proc/1/environ` への symlink を workdir 内に作る) を防ぐため、lstat で
   * symlink/非通常ファイルを拒否し、realpath 済みの実体が workdir 配下にあることも
   * 確認する。files 未指定、または全件除外後に空なら undefined を返し、text だけの
   * 従来 payload として deliver させる */
  async #resolveReplyFiles(
    sessionKey: string,
    workdirReal: string,
    files: string[] | undefined,
  ): Promise<string[] | undefined> {
    if (files === undefined) return undefined;
    const resolved: string[] = [];
    for (const file of files) {
      const abs = resolve(workdirReal, file);
      const rel = relative(workdirReal, abs);
      const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
      if (!inside) {
        this.#logger.warn(
          { sessionKey, path: file },
          "reply file path escapes workdir; dropped",
        );
        continue;
      }
      let fileStat: Awaited<ReturnType<typeof lstat>>;
      try {
        fileStat = await lstat(abs);
      } catch {
        this.#logger.warn(
          { sessionKey, path: file },
          "reply file does not exist; dropped",
        );
        continue;
      }
      if (!fileStat.isFile()) {
        this.#logger.warn(
          { sessionKey, path: file },
          "reply file is a symlink or not a regular file; dropped",
        );
        continue;
      }
      const real = await realpath(abs);
      const realRel = relative(workdirReal, real);
      const realInside =
        realRel !== "" && !realRel.startsWith("..") && !isAbsolute(realRel);
      if (!realInside) {
        this.#logger.warn(
          { sessionKey, path: file },
          "reply file resolves outside workdir; dropped",
        );
        continue;
      }
      resolved.push(abs);
    }
    return resolved.length > 0 ? resolved : undefined;
  }

  /**
   * agent_end: flush → ack (この順序が正。逆にするとクラッシュで入力が消える) →
   * 残り入力があれば次の prompt、無ければ linger して再確認、それでも無ければ ✅ で終了
   * (persistence.md §3, session-model.md §4 の linger)
   */
  async #onAgentEnd(proc: PiProcess): Promise<void> {
    const sessionKey = this.sessionKey;
    if (this.#disposed || this.#process !== proc) return;
    const epoch = this.#turnEpoch;
    // ターンが正常に終わったので timeout タイマーをクリア (リークさせない)。
    // 以降 promptPending で継続する場合は都度リセットされる
    this.#clearTurnTimeout();
    // アイドルな pi への steer はターンを開始しない (キューに積まれるだけ) ため、
    // ここから終了処理完了までは trySteerExisting に steer させず enqueue のみに
    // させる。promptPending が新ターンとして拾い、そこで running に戻す
    this.#state = "lingering";

    // 1. ターン境界の flush → 2. flush 成功後に ack (persistence.md §3)。
    // ack 対象は flush 前のスナップショット — flush の await 中に steer が
    // promptedIds へ追加した item を「そのターンの flush 前」に ack しない
    const toAck = [...this.#promptedIds];
    await this.#workdirStorage.flush(sessionKey, this.workdir);
    // shared も同じ境界で棚へ書き戻す (docs/design/shared.md §2)。異常終了パス
    // (exit / abnormalShutdown / renew 失敗) で書き戻さないのは workdir と同じ理由
    if (
      this.#sharedStorage !== undefined &&
      this.#sharedStagingDir !== undefined
    ) {
      await this.#sharedStorage.flush(this.channelId, this.#sharedStagingDir);
    }
    if (toAck.length > 0) {
      await this.#store.inbox.ack(sessionKey, toAck);
      for (const id of toAck) this.#promptedIds.delete(id);
    }

    // 3. 新規入力があれば同一プロセスで継続 (flush/ack は次の agent_end で行う)
    if (await this.#promptPending(proc)) return;
    // flush/ack の await 中に steer 済みなら、そのターンの agent_end に終了判定を譲る
    if (this.#turnEpoch !== epoch) return;

    // 4. linger: agent_end 直後に届いた追いメッセージを拾ってから終える。
    // この間レコードは Map に残す (新イベントは steer パスに入りうる)
    await sleep(this.#lingerMs);
    if (this.#disposed || this.#process !== proc) return;
    if (await this.#promptPending(proc)) return;
    if (this.#turnEpoch !== epoch) return;

    // 5. 終了処理。reply が 1 度も呼ばれなくても沈黙のまま ✅ を付けて終える
    this.#state = "stopping";
    await this.#safeReact(
      () => this.#reactions.addCheck(this.channelId, this.triggerTs),
      sessionKey,
      "check",
    );
    await this.#store.sessions.put(sessionKey, {
      channelId: this.channelId,
      threadTs: this.threadTs,
      triggerTs: this.triggerTs,
      status: "finished",
      updatedAt: new Date(),
    });
    await proc.stop();
    this.#clearAllTimers();
    await this.#router.clearProgress(sessionKey);
    await this.#store.leases.release(this.#lease);
    this.#dispose();
    // windowSec の起点 (session-model.md §3。以降このレーンは窓内なら resume 合流できる)
    await this.#host.markEnded(this.channelId, sessionKey);
    this.#logger.info(
      {
        sessionKey,
        durationMs: Date.now() - this.#startedAt,
        ...(this.#usageTotals !== undefined
          ? {
              totalTokens: this.#usageTotals.totalTokens,
              costTotal: this.#usageTotals.costTotal,
              cacheRead: this.#usageTotals.cacheRead,
            }
          : {}),
      },
      "session finished",
    );
  }

  /**
   * pi が response.success=false を返したときの異常終了処理 (例: Cloud Run で
   * ADC が見つからず認証エラーになるケース)。agent_end が来ない見込みなので
   * ここで能動的にセッションを畳む。pi は生きたまま次コマンドを待っているだけなので
   * graceful stop (proc.stop()) で十分止まる。クリーンアップの中身は abnormalShutdown
   * に共通化している (timeoutSession と共有)
   */
  async #failSession(
    proc: PiProcess,
    error: string | undefined,
  ): Promise<void> {
    await this.#abnormalShutdown(proc, {
      noticeText: `:warning: セッションが異常終了しました: ${error ?? "unknown error"}`,
      logMessage: "session failed",
      stop: () => proc.stop(),
      // 認証エラー等は再実行しても同じく失敗するので、このターンの入力は捨てる
      dropPromptedItems: true,
    });
  }

  /**
   * ターンタイムアウト (turnTimeoutMs 超過) の異常終了処理。pi が応答しない可能性がある
   * ため graceful stop ではなく強制 kill する (session-runtime.md §6:
   * 「プロセスは使い捨て設計なので kill してよい。inbox の入力は残るため再実行可能」)。
   * クリーンアップの中身は failSession と共通 (abnormalShutdown)
   */
  async #timeoutSession(proc: PiProcess): Promise<void> {
    this.#logger.error(
      { sessionKey: this.sessionKey, turnTimeoutMs: this.#turnTimeoutMs },
      "turn timed out",
    );
    await this.#abnormalShutdown(proc, {
      noticeText: `:warning: ターンがタイムアウトしました (${this.#turnTimeoutMs}ms)。セッションを終了します`,
      logMessage: "session timed out",
      // timeout は「重い処理で時間切れ」= 再実行で完了しうるため入力は残す (retry させる)
      dropPromptedItems: false,
      stop: () => {
        proc.kill();
        return Promise.resolve();
      },
    });
  }

  /**
   * 異常終了の共通クリーンアップ (failSession / timeoutSession から呼ばれる)。
   * exit ハンドラの「running のまま exit したら異常終了」と同じ後始末 (lease 解放 /
   * renew・timeout タイマー停止 / Map から削除) を行うが、flush はしない (このターンの
   * 入力は inbox に残したまま次回に再実行させる)。state を先に "stopping" にしておくことで、
   * stop() が引き起こす exit イベントが二重にクリーンアップを走らせない
   * (exit ハンドラは state !== "stopping" のときだけ動く)
   */
  async #abnormalShutdown(
    proc: PiProcess,
    options: {
      noticeText: string;
      logMessage: string;
      stop: () => Promise<void>;
      /** このターンで prompt 済みだった item を ack して捨てるか (session-model.md §6)。
       * command failed (認証エラー等、再実行しても同じく失敗) は捨てる。turn timeout は
       * 「重い処理で時間切れ」= 再実行で完了しうるため残し、次イベントで拾い直させる */
      dropPromptedItems: boolean;
    },
  ): Promise<void> {
    const sessionKey = this.sessionKey;
    if (this.#disposed || this.#process !== proc) return;

    this.#state = "stopping";
    this.#clearAllTimers();

    // register 済み (kick で必ず register している) なので deliver できる。
    // 通知の配達が失敗してもセッションの畳み込みは続ける
    await this.#router
      .deliver({ thread_key: sessionKey, text: options.noticeText }, sessionKey)
      .catch((err) => {
        this.#logger.warn(
          { sessionKey, err },
          "failure notice delivery failed",
        );
      });
    await this.#router.clearProgress(sessionKey);
    await this.#safeReact(
      () => this.#reactions.addX(this.channelId, this.triggerTs),
      sessionKey,
      "x",
    );

    if (options.dropPromptedItems) {
      const toAck = [...this.#promptedIds];
      if (toAck.length > 0) {
        await this.#store.inbox.ack(sessionKey, toAck).catch((err) => {
          this.#logger.warn({ sessionKey, err }, "inbox ack failed");
        });
      }
    }
    await this.#store.leases.release(this.#lease).catch((err) => {
      this.#logger.warn({ sessionKey, err }, "lease release failed");
    });
    await options.stop();
    this.#logger.warn(
      { sessionKey, durationMs: Date.now() - this.#startedAt },
      options.logMessage,
    );
    // activeSessionCount (テストの waitFor 等) がこのログの後で 0 になるよう、
    // Map からの削除はクリーンアップ完了後に行う
    this.#dispose();
    await this.#host.markEnded(this.channelId, sessionKey);
  }

  /** 未 prompt の item があれば prompt して true (drain は非破壊なので
   * promptedIds で除外する)。無ければ false */
  async #promptPending(proc: PiProcess): Promise<boolean> {
    const sessionKey = this.sessionKey;
    const items = (await this.#store.inbox.drain(sessionKey)).filter(
      (i) => !this.#promptedIds.has(i.id),
    );
    if (items.length === 0) return false;
    for (const i of items) {
      registerReplyDestination(this.#router, i.event, this.policy);
      this.#promptedIds.add(i.id);
    }
    this.#turnEpoch += 1;
    // lingering (agent_end 後の終了判定中) からの復帰。ここで拾う item は
    // trySteerExisting が steer せず enqueue のみで残していたものを含む
    this.#state = "running";
    this.#resetTurnTimeout();
    this.#progress.reset();
    proc.prompt(renderItems(items));
    this.#logger.info({ sessionKey, items: items.length }, "session continued");
    return true;
  }

  /** lease の renew を ttl/3 間隔で回す。false は排他喪失 = 別の保持者が動いて
   * いる可能性があるため、flush せずプロセスを止める (書き戻さない) */
  #startRenewTimer(): void {
    const sessionKey = this.sessionKey;
    const intervalMs = Math.max(1, Math.floor(this.#leaseTtlMs / 3));
    const timer = setInterval(() => {
      void (async () => {
        if (this.#disposed) return;
        const ok = await this.#store.leases.renew(
          this.#lease,
          this.#leaseTtlMs,
        );
        if (ok) return;
        if (this.#disposed) return;
        this.#logger.error(
          { sessionKey, owner: this.#lease.owner },
          "lease renew failed; stopping session without flush",
        );
        this.#state = "stopping";
        this.#dispose();
        this.#clearAllTimers();
        await this.#router.clearProgress(sessionKey);
        await this.#process?.stop();
        await this.#host.markEnded(this.channelId, sessionKey);
      })().catch((err) => {
        this.#logger.error({ sessionKey, err }, "lease renew handling failed");
      });
    }, intervalMs);
    timer.unref();
    this.#renewTimer = timer;
  }

  #stopRenewTimer(): void {
    if (this.#renewTimer !== undefined) {
      clearInterval(this.#renewTimer);
      this.#renewTimer = undefined;
    }
  }

  /** turn timeout タイマーをリセットする (prompt/steer 送信ごとに呼ぶ。既存タイマーが
   * あれば止めて張り直す)。発火したら timeoutSession でセッションを異常終了させる */
  #resetTurnTimeout(): void {
    this.#clearTurnTimeout();
    const timer = setTimeout(() => {
      const proc = this.#process;
      if (proc === undefined) return;
      void this.#timeoutSession(proc).catch((err) => {
        this.#logger.warn(
          { sessionKey: this.sessionKey, err },
          "timeoutSession handling failed",
        );
      });
    }, this.#turnTimeoutMs);
    timer.unref();
    this.#turnTimeoutTimer = timer;
  }

  #clearTurnTimeout(): void {
    if (this.#turnTimeoutTimer !== undefined) {
      clearTimeout(this.#turnTimeoutTimer);
      this.#turnTimeoutTimer = undefined;
    }
  }

  /** 全終了経路の共通後始末: 3 タイマー (renew / turn timeout / progress notice) を
   * まとめて止める。どの経路でもこの 3 つは隣接して呼ばれるため無条件に畳める。
   * progress レーンの clearProgress / lease の release / markEnded / ログは経路ごとに
   * 位置も有無も異なる意図的な差異なのでここには含めない */
  #clearAllTimers(): void {
    this.#stopRenewTimer();
    this.#clearTurnTimeout();
    this.#progress.clear();
  }

  /** レジストリからの離脱 (disposed フラグ + host.remove)。呼び出し位置は経路ごとに
   * 異なる — abnormalShutdown はログ後 (activeSessionCount がログの後で 0 になるよう)、
   * exit / renew 失敗 / abort は先頭側。activeSessionCount を観測するテストに影響する
   * ので、各経路の現在位置から動かさないこと */
  #dispose(): void {
    this.#disposed = true;
    this.#host.remove(this);
  }

  /** リアクションは装飾なので、失敗してもセッションを止めない */
  async #safeReact(
    fn: () => Promise<void>,
    sessionKey: string,
    label: string,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.#logger.warn({ sessionKey, label, err }, "failed to add reaction");
    }
  }
}
