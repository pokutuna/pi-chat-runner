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
import type { EgressRouter } from "../egress/router.js";
import type { ReactionState, TurnReactor } from "../egress/turn-reactor.js";
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
  type TurnStatus,
  turnStatusFromAgentEnd,
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
import type { PiPermissionConfig } from "./spawn.js";

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

/** セッション横断で不変の依存・設定一式。SessionRunner のコンストラクタで
 * options から一度だけ組み立て、以後は使い回す (SessionRunnerOptions の再梱包を
 * kick / ActiveSession 構築のたびに繰り返さないための束ね役)。ActiveSession は
 * これを `#ctx` 1 フィールドとして保持し、個々の値は展開しない。static* な値
 * (mentionFormat/piBinary/piEntrypoint/agentUid/agentGid) は StartArgs にはもう
 * 積まない — プロセス起動中に変わらないのでここから直接参照する */
export interface SessionContext {
  store: StateStore;
  router: EgressRouter;
  reactor: TurnReactor;
  workdirStorage: WorkdirStorage;
  sharedStorage: SharedStorage | undefined;
  logger: Logger;
  lingerMs: number;
  turnTimeoutMs: number;
  leaseTtlMs: number;
  progressNoticeIntervalMs: number;
  /** ユーザーへの言及をレンダリングする関数 (返信本文に埋め込む記法) */
  mentionFormat: MentionFormat;
  /** 明示的に差し替える pi バイナリ。テストや埋め込み用途向け */
  piBinary: string | undefined;
  /** 解決済みの pi 本体 entrypoint JS */
  piEntrypoint: string | undefined;
  /** allowlist (PATH/HOME) に追加で pi 子プロセスへ渡す env (kick 時に HOME を
   * agentHomeReal で上書きしたものを都度合成するための素材) */
  extraEnv: Record<string, string> | undefined;
  /** pi 子プロセスの実行 uid/gid (両方指定時のみ有効) */
  agentUid: number | undefined;
  agentGid: number | undefined;
  agentHome: string;
  piPermission: PiPermissionConfig | undefined;
}

/** ActiveSession の構築に必要な依存一式。同一性 (sessionKey/channelId/threadTs/
 * triggerMessageId/workdir/policy) と lease/host/sharedStagingDir はセッションごとに
 * 決まる値、ctx はセッション横断の共有コンテキスト (SessionContext)。 */
export interface ActiveSessionOptions {
  sessionKey: string;
  channelId: string;
  threadTs: string;
  /** セッションを起こしたトリガーメッセージの ID (セッション同一性・sessions.put 用) */
  triggerMessageId: string;
  workdir: string;
  /** kick 時に導出した session.mode / reply.mode。promptPending / start から
   * 参照して宛先登録・フォールバック登録に使う (session-model.md §3) */
  policy: SessionPolicy;
  /** このプロセスが保持する実行ロック。renew に失敗したら排他を失っている */
  lease: Lease;
  host: SessionHost;
  /** チャンネル共有ディレクトリの staging パス (docs/design/shared.md §1) */
  sharedStagingDir: string | undefined;
  ctx: SessionContext;
}

/** start() に渡す、spawn 準備 (spawn.ts の関数群) の結果と per-kick な設定。
 * ActiveSession は spawn 準備を自分では持たない — runner の kick 相当が
 * prepareWorkdir / buildSpawnOptions / loadMemoryIndex を呼んだ結果を束ねて渡す。
 * mentionFormat/piBinary/piEntrypoint/agentUid/agentGid のような静的設定は
 * ctx (SessionContext) 側にあるためここには含まない */
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
  /** allowlist に追加で pi 子プロセスへ渡す env (HOME=agentHomeReal を含む、
   * per-kick に合成されたもの) */
  extraEnv: Record<string, string>;
}

export class ActiveSession {
  readonly sessionKey: string;
  readonly channelId: string;
  readonly threadTs: string;
  /** セッションを起こしたトリガーメッセージの ID (セッション同一性・sessions.put 用) */
  readonly triggerMessageId: string;
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
  /** このターンで prompt/steer した入力メッセージの ID (event.id)。ターンの成否が
   * 確定したら (agent_end) これらのメッセージへ ✅/❌ を付けてクリアする。
   * #promptedIds (dedupe キー = event_id、セッション累積) とは軸も寿命も別物 —
   * リアクション対象は「メッセージそのもの」なので event.id、寿命は #turnEpoch と
   * 同じ 1 ターン。両者を 1 つの器に相乗りさせない (persistence.md §1) */
  #turnMessageIds: string[] = [];
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
  readonly #sharedStagingDir: string | undefined;
  readonly #ctx: SessionContext;

  constructor(options: ActiveSessionOptions) {
    this.sessionKey = options.sessionKey;
    this.channelId = options.channelId;
    this.threadTs = options.threadTs;
    this.triggerMessageId = options.triggerMessageId;
    this.workdir = options.workdir;
    this.policy = options.policy;
    this.#startedAt = Date.now();
    this.#lease = options.lease;
    this.#host = options.host;
    this.#sharedStagingDir = options.sharedStagingDir;
    this.#ctx = options.ctx;
    this.#progress = new ProgressNotice({
      sessionKey: options.sessionKey,
      router: options.ctx.router,
      intervalMs: options.ctx.progressNoticeIntervalMs,
      logger: options.ctx.logger,
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
      extraEnv,
    } = args;
    const { mentionFormat, piBinary, piEntrypoint, agentUid, agentGid } =
      this.#ctx;

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
      logger: (line) =>
        this.#ctx.logger.debug({ sessionKey, line }, "pi stderr"),
    });

    proc.on("event", (piEvent) => {
      // ペイロード全体はログに残さない (大きい・機微を含みうる)。イベント種別ごとの
      // 概要フィールドだけ出す。ストリーミング差分は null が返るのでログしない
      const logFields = piEventLogFields(piEvent);
      if (logFields !== null) {
        this.#ctx.logger.debug(
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
              this.#ctx.router.deliver(
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
              this.#ctx.logger.warn(
                { sessionKey, threadKeyPayload: payload.thread_key, err },
                "reply delivery failed",
              );
            });
        }
        return;
      }
      if (isAgentEnd(piEvent)) {
        // willRetry: true の agent_end はターン終端ではない (AgentSession の自動
        // リトライが走り、リトライ後にもう一度 agent_end が来る)。ここで畳むと
        // リトライ前にセッションを終わらせてしまうので、この中間 agent_end は
        // 何もせず素通しし、成否判定・flush/ack・終了判定は次の agent_end に委ねる
        if (piEvent.willRetry === true) return;
        // ターン内の LLM 呼び出し失敗は agent_end としては正常終了になるので、
        // ここで拾わないとログに一切残らない (pi-events.ts extractTurnErrors)
        for (const errorMessage of extractTurnErrors(piEvent)) {
          this.#ctx.logger.error(
            { sessionKey, errorMessage },
            "assistant turn ended with error",
          );
        }
        // agent_end.messages は毎回全履歴を返すため、この totals はターンの増分では
        // なくセッション累計 (pi-events.ts extractUsageTotals)
        const totals = extractUsageTotals(piEvent);
        this.#usageTotals = totals;
        this.#ctx.logger.info({ sessionKey, ...totals }, "turn usage");
        // 進捗タイマーは agent_end を受けた時点で即止める。onAgentEnd の
        // teardown まで待つと、その間の await の隙間でタイマー tick がもう一件
        // 発火し、deliver 済みの reply の後に古いツール名で新規投稿してしまう
        this.#progress.clear();
        // 最終 assistant の stopReason からターンの成否を判定し、そのターンを
        // 起こした各メッセージへ ✅/❌ で返す (pi-events.ts turnStatusFromAgentEnd)
        const status = turnStatusFromAgentEnd(piEvent);
        void this.#onAgentEnd(proc, status).catch((err) => {
          this.#ctx.logger.warn(
            { sessionKey, err },
            "agent_end handling failed",
          );
        });
      }
    });
    proc.on("response", (response) => {
      // success: true は prompt/steer の受理応答に過ぎない (agent_end が本当の
      // 終端)。debug ログのみで十分
      if (response.success) {
        this.#ctx.logger.debug(
          { sessionKey, command: response.command },
          "pi command accepted",
        );
        return;
      }
      // success: false は pi 側が「動けない」と判断したケース (認証エラー等)。
      // pi は生きたまま次コマンドを待つが、agent_end が来ないので何もしなければ
      // runner は永久に無音ハングする → ここで異常終了として扱いプロセスを止める
      this.#ctx.logger.error(
        { sessionKey, command: response.command, error: response.error },
        "pi command failed",
      );
      void this.#failSession(proc, response.error).catch((err) => {
        this.#ctx.logger.warn(
          { sessionKey, err },
          "failSession handling failed",
        );
      });
    });
    proc.on("invalid", (raw, error) => {
      this.#ctx.logger.debug(
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
        void this.#ctx.router.clearProgress(sessionKey).catch((err) => {
          this.#ctx.logger.warn({ sessionKey, err }, "clear progress failed");
        });
        // このターンで prompt 済みだった item は ack して捨てる。retry しない
        // (session-model.md §6)。捨てないと未 ack のまま inbox に残り、次の新規
        // イベントの drain が巻き込んで再 prompt するため、workdir/transcript を
        // 使い回す構造上「同じ入力で pi が再クラッシュし続ける」ループになりうる。
        // 異常終了はユーザーに ❌ で伝わるので、必要なら本人が言い直せばよい。
        // abnormalShutdown (failSession / timeoutSession) と同じ規則 — プロセスが
        // 既に死んでいる分ここでは kill せず lease 解放から始める点だけが違う
        const toAck = [...this.#promptedIds];
        if (toAck.length > 0) {
          void this.#ctx.store.inbox.ack(sessionKey, toAck).catch((err) => {
            this.#ctx.logger.warn({ sessionKey, err }, "inbox ack failed");
          });
        }
        void this.#ctx.store.leases.release(this.#lease).catch((err) => {
          this.#ctx.logger.warn({ sessionKey, err }, "lease release failed");
        });
        void this.#host.markEnded(this.channelId, sessionKey);
        this.#ctx.logger.warn(
          { sessionKey, code, signal },
          "pi exited unexpectedly",
        );
        // pi のクラッシュはユーザーから見えない (返信なしで無音になる) ので、
        // このターンを起こした各メッセージに ❌ を付けて失敗を伝える
        void this.#reactMessages(this.#turnMessageIds, "error");
        this.#turnMessageIds = [];
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
      this.#ctx.router.register(sessionKey, { channelId });
    } else {
      this.#ctx.router.register(sessionKey, { channelId, threadTs });
    }

    // enqueue 済みの入力 (spawn 準備中に積まれた分を含む) を束ねて初回 prompt にする。
    // トリガーイベント自身も enqueue 済みなので通常 drain 経由で届く。
    // ChannelDoc.context は初回のみ先頭に注入する (config.md §4)
    const items = (await this.#ctx.store.inbox.drain(sessionKey)).filter(
      (i) => !this.#promptedIds.has(i.id),
    );
    let body: string;
    if (items.length > 0) {
      for (const i of items)
        await this.#beginTurnMessage(i.event, i.id, policy);
      body = renderItems(items);
    } else {
      // drain が空 (Store 実装の遅延など)。トリガーイベントに直接フォールバック
      // するが、ack 対象には含める (二重 prompt を防ぐ)
      const triggerKey = await this.#beginTurnMessage(
        triggerEvent,
        inboxItemId(triggerEvent),
        policy,
      );
      body = renderEvent(triggerEvent, triggerKey);
    }
    this.#turnEpoch += 1;
    this.#resetTurnTimeout();
    this.#progress.reset();
    proc.prompt(prependContext(body, doc));

    await this.#ctx.store.sessions.put(sessionKey, {
      channelId,
      threadTs,
      triggerMessageId: this.triggerMessageId,
      status: "active",
      updatedAt: new Date(),
    });
    this.#ctx.logger.info(
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
    await this.#ctx.router.clearProgress(this.sessionKey);
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
    const items = await this.#ctx.store.inbox.drain(sessionKey);
    const pending = items.filter((i) => !this.#promptedIds.has(i.id));
    if (pending.length > 0) {
      // steer 前に宛先登録 (session-model.md §3 の境界規則) と 👀 付け
      for (const p of pending) {
        await this.#beginTurnMessage(p.event, p.id, this.policy);
      }
      this.#turnEpoch += 1;
      this.#resetTurnTimeout();
      this.#progress.reset();
      proc.steer(renderItems(pending));
      this.#ctx.logger.info(
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
        this.#ctx.logger.warn(
          { sessionKey, path: file },
          "reply file path escapes workdir; dropped",
        );
        continue;
      }
      let fileStat: Awaited<ReturnType<typeof lstat>>;
      try {
        fileStat = await lstat(abs);
      } catch {
        this.#ctx.logger.warn(
          { sessionKey, path: file },
          "reply file does not exist; dropped",
        );
        continue;
      }
      if (!fileStat.isFile()) {
        this.#ctx.logger.warn(
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
        this.#ctx.logger.warn(
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
  async #onAgentEnd(proc: PiProcess, status: TurnStatus): Promise<void> {
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
    // promptedIds へ追加した item を「そのターンの flush 前」に ack しない。
    // リアクション対象 (このターンを起こしたメッセージ) も同じ境界でスナップショット
    // して即クリアする — promptPending が次ターンとして新しい message id を push する前に
    const toAck = [...this.#promptedIds];
    const reactTargets = this.#turnMessageIds;
    this.#turnMessageIds = [];
    await this.#ctx.workdirStorage.flush(sessionKey, this.workdir);
    // shared も同じ境界で棚へ書き戻す (docs/design/shared.md §2)。異常終了パス
    // (exit / abnormalShutdown / renew 失敗) で書き戻さないのは workdir と同じ理由
    if (
      this.#ctx.sharedStorage !== undefined &&
      this.#sharedStagingDir !== undefined
    ) {
      await this.#ctx.sharedStorage.flush(
        this.channelId,
        this.#sharedStagingDir,
      );
    }
    if (toAck.length > 0) {
      await this.#ctx.store.inbox.ack(sessionKey, toAck);
      for (const id of toAck) this.#promptedIds.delete(id);
    }
    // このターンの成否を、起こした各メッセージへ ✅ (ok) / ❌ (error) で返す。
    // flush/ack でターンの成果が確定した後に付ける。以降 continue しても linger 後に
    // 終了しても、このターンのフィードバックは付け終わっている
    await this.#reactMessages(reactTargets, status);

    // 3. 新規入力があれば同一プロセスで継続 (flush/ack は次の agent_end で行う)
    if (await this.#promptPending(proc)) return;
    // flush/ack の await 中に steer 済みなら、そのターンの agent_end に終了判定を譲る
    if (this.#turnEpoch !== epoch) return;

    // 4. linger: agent_end 直後に届いた追いメッセージを拾ってから終える。
    // この間レコードは Map に残す (新イベントは steer パスに入りうる)
    await sleep(this.#ctx.lingerMs);
    if (this.#disposed || this.#process !== proc) return;
    if (await this.#promptPending(proc)) return;
    if (this.#turnEpoch !== epoch) return;

    // 5. 終了処理。✅/❌ は各ターンの agent_end で既に付けてあるので、ここでは
    // セッションを畳むだけ (セッション終了そのものにはリアクションを付けない)
    this.#state = "stopping";
    await this.#ctx.store.sessions.put(sessionKey, {
      channelId: this.channelId,
      threadTs: this.threadTs,
      triggerMessageId: this.triggerMessageId,
      status: "finished",
      updatedAt: new Date(),
    });
    await proc.stop();
    this.#clearAllTimers();
    await this.#ctx.router.clearProgress(sessionKey);
    await this.#ctx.store.leases.release(this.#lease);
    this.#dispose();
    // windowSec の起点 (session-model.md §3。以降このレーンは窓内なら resume 合流できる)
    await this.#host.markEnded(this.channelId, sessionKey);
    this.#ctx.logger.info(
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
   * ここで能動的にセッションを畳む。クリーンアップの中身は abnormalShutdown に
   * 共通化している (timeoutSession と共有)
   */
  async #failSession(
    proc: PiProcess,
    error: string | undefined,
  ): Promise<void> {
    await this.#abnormalShutdown(proc, {
      noticeText: `:warning: セッションが異常終了しました: ${error ?? "unknown error"}`,
      logMessage: "session failed",
    });
  }

  /**
   * ターンタイムアウト (turnTimeoutMs 超過) の異常終了処理。クリーンアップの中身は
   * failSession と共通 (abnormalShutdown)
   */
  async #timeoutSession(proc: PiProcess): Promise<void> {
    this.#ctx.logger.error(
      { sessionKey: this.sessionKey, turnTimeoutMs: this.#ctx.turnTimeoutMs },
      "turn timed out",
    );
    await this.#abnormalShutdown(proc, {
      noticeText: `:warning: ターンがタイムアウトしました (${this.#ctx.turnTimeoutMs}ms)。セッションを終了します`,
      logMessage: "session timed out",
    });
  }

  /**
   * 異常終了の共通クリーンアップ (failSession / timeoutSession から呼ばれる)。
   * exit ハンドラの「running のまま exit したら異常終了」と同じ後始末を行う:
   * このターンで prompt 済みだった item を ack して捨て (retry しない)、lease を解放し、
   * renew・timeout タイマーを止めて Map から削除する。flush はしない。
   * 異常終了は種別 (command failed / turn timeout) によらずこのターンの入力を捨てる —
   * 同じ入力を残すと次イベントの drain が巻き込んで同一 workdir/transcript で再び
   * 失敗・timeout する毒ループになりうる。失敗は ❌ と通知でユーザーに伝わるので、
   * 必要なら本人が言い直せばよい (session-model.md §6)。プロセスは使い捨て設計
   * (session-runtime.md §6) なので常に kill でよい。state を先に "stopping" にしておく
   * ことで、kill が引き起こす exit イベントが二重にクリーンアップを走らせない
   * (exit ハンドラは state !== "stopping" のときだけ動く)
   */
  async #abnormalShutdown(
    proc: PiProcess,
    options: {
      noticeText: string;
      logMessage: string;
    },
  ): Promise<void> {
    const sessionKey = this.sessionKey;
    if (this.#disposed || this.#process !== proc) return;

    this.#state = "stopping";
    this.#clearAllTimers();

    // register 済み (kick で必ず register している) なので deliver できる。
    // 通知の配達が失敗してもセッションの畳み込みは続ける
    await this.#ctx.router
      .deliver({ thread_key: sessionKey, text: options.noticeText }, sessionKey)
      .catch((err) => {
        this.#ctx.logger.warn(
          { sessionKey, err },
          "failure notice delivery failed",
        );
      });
    await this.#ctx.router.clearProgress(sessionKey);
    // このターンを起こした各メッセージに ❌ を付けて失敗を伝える
    await this.#reactMessages(this.#turnMessageIds, "error");
    this.#turnMessageIds = [];

    // このターンで prompt 済みだった item は ack して捨てる (retry しない)
    const toAck = [...this.#promptedIds];
    if (toAck.length > 0) {
      await this.#ctx.store.inbox.ack(sessionKey, toAck).catch((err) => {
        this.#ctx.logger.warn({ sessionKey, err }, "inbox ack failed");
      });
    }
    await this.#ctx.store.leases.release(this.#lease).catch((err) => {
      this.#ctx.logger.warn({ sessionKey, err }, "lease release failed");
    });
    proc.kill();
    this.#ctx.logger.warn(
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
    const items = (await this.#ctx.store.inbox.drain(sessionKey)).filter(
      (i) => !this.#promptedIds.has(i.id),
    );
    if (items.length === 0) return false;
    for (const i of items)
      await this.#beginTurnMessage(i.event, i.id, this.policy);
    this.#turnEpoch += 1;
    // lingering (agent_end 後の終了判定中) からの復帰。ここで拾う item は
    // trySteerExisting が steer せず enqueue のみで残していたものを含む
    this.#state = "running";
    this.#resetTurnTimeout();
    this.#progress.reset();
    proc.prompt(renderItems(items));
    this.#ctx.logger.info(
      { sessionKey, items: items.length },
      "session continued",
    );
    return true;
  }

  /** lease の renew を ttl/3 間隔で回す。false は排他喪失 = 別の保持者が動いて
   * いる可能性があるため、flush せずプロセスを止める (書き戻さない) */
  #startRenewTimer(): void {
    const sessionKey = this.sessionKey;
    const intervalMs = Math.max(1, Math.floor(this.#ctx.leaseTtlMs / 3));
    const timer = setInterval(() => {
      void (async () => {
        if (this.#disposed) return;
        const ok = await this.#ctx.store.leases.renew(
          this.#lease,
          this.#ctx.leaseTtlMs,
        );
        if (ok) return;
        if (this.#disposed) return;
        this.#ctx.logger.error(
          { sessionKey, owner: this.#lease.owner },
          "lease renew failed; stopping session without flush",
        );
        this.#state = "stopping";
        this.#dispose();
        this.#clearAllTimers();
        await this.#ctx.router.clearProgress(sessionKey);
        await this.#process?.stop();
        await this.#host.markEnded(this.channelId, sessionKey);
      })().catch((err) => {
        this.#ctx.logger.error(
          { sessionKey, err },
          "lease renew handling failed",
        );
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
        this.#ctx.logger.warn(
          { sessionKey: this.sessionKey, err },
          "timeoutSession handling failed",
        );
      });
    }, this.#ctx.turnTimeoutMs);
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

  /** ターンに 1 件の入力メッセージを取り込む共通処理 (start / steerPending /
   * promptPending 共通)。宛先登録 (session-model.md §3) → dedupe 記録 (promptedIds、
   * キーは event_id) → リアクション対象の記録 (turnMessageIds、キーはメッセージ ID) →
   * 👀 を付ける、をまとめる。register の戻り (thread_key) を返すので、フォールバックの
   * renderEvent はこれを使う */
  async #beginTurnMessage(
    event: InboundMessage,
    dedupeId: string,
    policy: SessionPolicy,
  ): Promise<string> {
    const threadKey = registerReplyDestination(this.#ctx.router, event, policy);
    this.#promptedIds.add(dedupeId);
    this.#turnMessageIds.push(event.id);
    await this.#react(event.id, "kick");
    return threadKey;
  }

  /** ターンの成否を、そのターンを起こした各メッセージへ返す (ok / error)。kick は
   * prompt/steer 時点で付けてあるので、これで kick → ok/error が揃う。1 ターンに
   * 複数メッセージが合流していれば全件に付く */
  async #reactMessages(
    messageIds: string[],
    status: TurnStatus,
  ): Promise<void> {
    for (const messageId of messageIds) await this.#react(messageId, status);
  }

  /** TurnReactor 経由でメッセージにターン状態を返す。装飾なので、失敗しても
   * セッションは止めない */
  async #react(messageId: string, state: ReactionState): Promise<void> {
    try {
      await this.#ctx.reactor.react(this.channelId, messageId, state);
    } catch (err) {
      this.#ctx.logger.warn(
        { sessionKey: this.sessionKey, state, err },
        "failed to react to turn state",
      );
    }
  }
}
