// Session — 1 Session の生存期間 (spawn → Turn 実行 → 終了) を自分で管理する主語。
// Dispatcher は Session の選択とレジストリ (Map<sessionKey, Session>) だけを持ち、
// 1 Session の遷移はここに閉じる。
//
// docs/design/architecture.md §6 (event は「きっかけ係」、Session が「処理の担い手」)、
// docs/design/session-model.md §7 (Turn)、docs/design/message-dispatch.md §7.1 (起動の
// フロー)、§5 (steering)、§7.2 (Turn 境界の順序: flush → ack)、§7.4 (turn timeout)、
// docs/design/runtime.md §1 (起動シーケンス)、docs/design/state.md §7 (tmpfs + 境界 flush)。
//
// Turn は型ではなくこのクラスのフィールド群 (#turnEpoch / #turnMessageIds /
// #turnTimeoutTimer) として表す (session-model.md §7)。

import type { ResolvedChannel } from "../config/config-source.js";
import {
  renderEvent,
  renderItems,
  type SessionPolicy,
} from "../dispatch/policy.js";
import {
  sessionFailedNoticeText,
  turnTimeoutNoticeText,
} from "../egress/notices.js";
import { registerReplyDestination } from "../egress/reply-destination.js";
import type { EgressRouter } from "../egress/router.js";
import type { ReactionState, TurnReactor } from "../egress/turn-reactor.js";
import type { InboundMessage } from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import type { RuntimeConfig } from "../runtime/config.js";
import type { PiPermissionOptions } from "../runtime/pi-args.js";
import {
  extractReply,
  extractTurnErrors,
  extractUsageTotals,
  piEventLogFields,
  type TurnStatus,
  turnStatusFromAgentEnd,
  type UsageTotals,
} from "../runtime/pi-events.js";
import { PiProcess } from "../runtime/pi-process.js";
import {
  buildSystemPrompt,
  type MentionFormat,
  prependContext,
} from "../runtime/prompt.js";
import { resolveReplyFiles } from "../runtime/reply-files.js";
import {
  isAgentEnd,
  isToolExecutionEnd,
  isToolExecutionStart,
} from "../runtime/rpc.js";
import type { SharedStore, WorkdirStore } from "../state/agent/interfaces.js";
import { inboxItemId } from "../state/control/inbox-item.js";
import type { ControlState, Lease } from "../state/control/interfaces.js";
import { ProgressNotice } from "./progress.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Session がライフサイクルの節目を知らせる先 (実装は Dispatcher)。全終了経路の
 * レジストリ離脱と、windowSec 起点の記録をこのポート経由に集約する。
 * Session は Dispatcher を import せず、この 2 つのコールバックだけを知る */
export interface SessionObserver {
  /** Session がレジストリから外れた (全終了経路の Map delete の置き換え) */
  onDisposed(session: Session): void;
  /** Session が終了した (windowSec 起点の記録、message-dispatch.md §3.2) */
  onEnded(channelId: string, sessionKey: string): Promise<void>;
}

/** Session 横断で不変の依存・設定一式。Dispatcher のコンストラクタで options から
 * 一度だけ組み立て、以後は使い回す (DispatcherOptions の再梱包を Session 構築の
 * たびに繰り返さないための束ね役)。Session はこれを `#ctx` 1 フィールドとして
 * 保持し、個々の値は展開しない。static* な値
 * (mentionFormat/piBinary/piEntrypoint/agentUid/agentGid) は StartArgs にはもう
 * 積まない — プロセス起動中に変わらないのでここから直接参照する */
export interface SessionContext {
  controlState: ControlState;
  router: EgressRouter;
  reactor: TurnReactor;
  workdirStore: WorkdirStore;
  sharedStore: SharedStore | undefined;
  logger: Logger;
  lingerMs: number;
  turnTimeoutMs: number;
  leaseTtlMs: number;
  progressNoticeIntervalMs: number;
  /** ユーザーへの言及をレンダリングする関数 (返信本文に埋め込む記法) */
  mentionFormat: MentionFormat;
  /** Runtime レイヤの静的設定 (pi のパス・env allowlist・UID 分離・Permission
   * Model・workdir のルート。runtime.md §1)。Channel ごとの Agent Config の env
   * (config.md §1.3) と HOME=agentHomeReal は起動時に runtime.extraEnv の上へ
   * 重ねて合成する (dispatch/dispatcher.ts) */
  runtime: RuntimeConfig;
}

/** Session の構築に必要な依存一式。同一性 (sessionKey/channelId/threadTs/
 * triggerMessageId/workdir/policy) と lease/host/sharedStagingDir はセッションごとに
 * 決まる値、ctx はセッション横断の共有コンテキスト (SessionContext)。 */
export interface SessionOptions {
  sessionKey: string;
  channelId: string;
  threadTs: string;
  /** セッションを起こしたトリガーメッセージの ID (セッション同一性・sessions.put 用) */
  triggerMessageId: string;
  workdir: string;
  /** 起動時に導出した session.mode / reply.mode。promptPending / start から
   * 参照して宛先登録・フォールバック登録に使う (session-model.md §3) */
  policy: SessionPolicy;
  /** このプロセスが保持する実行ロック。renew に失敗したら排他を失っている */
  lease: Lease;
  observer: SessionObserver;
  /** チャンネル共有ディレクトリの staging パス (docs/design/state.md §6) */
  sharedStagingDir: string | undefined;
  ctx: SessionContext;
}

/** start() に渡す、spawn 準備 (runtime/prepare.ts の関数群) の結果と起動ごとの設定。
 * Session は spawn 準備を自分では持たない — Dispatcher が prepareWorkdir /
 * buildSpawnOptions / loadMemoryIndex を呼んだ結果を束ねて渡す。
 * mentionFormat や RuntimeConfig のような静的設定は ctx (SessionContext) 側に
 * あるためここには含まない */
export interface StartArgs {
  triggerEvent: InboundMessage;
  channel: ResolvedChannel | null;
  /** PiProcess construction 用 */
  sessionPath: string;
  extensionPaths: string[];
  workdirReal: string;
  sharedDirReal: string | undefined;
  skillPaths: string[];
  permission: PiPermissionOptions | undefined;
  memoryIndex: string | undefined;
  /** 起動時点で session.jsonl が既に存在したか ("session started" ログ用) */
  resumed: boolean;
  /** この起動で Transcript が新しく始まったか (世代交代した、または Session の
   * 記録がまだ無い)。SessionRecord の startedAt を置き直す条件
   * (session-model.md §6, state.md §3.2) */
  freshTranscript: boolean;
  model: string | undefined;
  /** allowlist に追加で pi 子プロセスへ渡す env (HOME=agentHomeReal を含む、
   * 起動ごとに合成されたもの) */
  extraEnv: Record<string, string>;
}

/** 1 つの sessionKey に対して実行中の pi プロセスと、その Turn の状態を持つ実体
 * (message-dispatch.md §7, session-model.md §7)。Dispatcher が lease を取ってから
 * 1 つだけ作り、Session が畳まれるときに observer 経由で Dispatcher へ返る。
 *
 * Inbox の読み出しについて: 起動と各 Turn の入力組み立ては Session 自身が
 * `controlState.inbox.drain()` で行う (flush → ack の境界も Session が握るため、
 * drain と ack を同じ場所に置く)。Dispatcher は「この sessionKey を起動/再開してよい」
 * という判断と lease だけを渡し、どの item を prompt に載せるかには関与しない
 * (message-dispatch.md §7.2)。 */
export class Session {
  readonly sessionKey: string;
  readonly channelId: string;
  readonly threadTs: string;
  /** セッションを起こしたトリガーメッセージの ID (セッション同一性・sessions.put 用) */
  readonly triggerMessageId: string;
  readonly workdir: string;
  /** 起動時に導出した session.mode / reply.mode。promptPending / start から
   * 参照して宛先登録・フォールバック登録に使う (session-model.md §3) */
  readonly policy: SessionPolicy;

  /** starting = spawn 準備中 (多重起動防止のため Map 登録済み)、
   * running = PiProcess がターンを実行中、lingering = agent_end 後の終了判定中
   * (アイドルな pi。promptPending が prompt を送ると running に戻る)、
   * stopping = 終了処理中 (exit を異常扱いしない) */
  #state: "starting" | "running" | "lingering" | "stopping" = "starting";
  #process?: PiProcess;
  /** 起動時刻 (finished ログの durationMs 算出用) */
  readonly #startedAt: number;
  /** この起動で Transcript が新しく始まったか (StartArgs.freshTranscript)。
   * #putRecord が startedAt を置き直すかの判断に使う (session-model.md §6) */
  #freshTranscript = false;
  /** このプロセスが保持する実行ロック。renew に失敗したら排他を失っている */
  readonly #lease: Lease;
  /** このセッションで prompt/steer 済みの item id。drain は非破壊 (未 ack 全件を
   * 返す) なので、重複除外はこのインメモリ記憶で行う (state.md §3.1) */
  readonly #promptedIds = new Set<string>();
  /** このターンで prompt/steer した入力メッセージの ID (event.id)。ターンの成否が
   * 確定したら (agent_end) これらのメッセージへ ✅/❌ を付けてクリアする。
   * #promptedIds (dedupe キー = event_id、セッション累積) とは軸も寿命も別物 —
   * リアクション対象は「メッセージそのもの」なので event.id、寿命は #turnEpoch と
   * 同じ 1 ターン。両者を 1 つの器に相乗りさせない (session-model.md §7.2) */
  #turnMessageIds: string[] = [];
  /** prompt/steer を送るたびに増える世代。agent_end 処理中に増えていたら
   * 新しいターンが走り出しているので、終了判定をそのターンの agent_end に譲る */
  #turnEpoch = 0;
  #renewTimer: NodeJS.Timeout | undefined;
  /** 現ターンの timeout タイマー。prompt/steer 送信 (turnEpoch 増加箇所) ごとに
   * リセットし、agent_end 冒頭でクリアする。セッション終了パスでも必ずクリアする
   * (message-dispatch.md §7.4 の turn timeout) */
  #turnTimeoutTimer: NodeJS.Timeout | undefined;
  /** 進捗通知 (ingress-egress.md §8)。タイマーの寿命は turnTimeoutTimer と同じく
   * prompt/steer 送信ごとに reset、agent_end 冒頭で clear。currentTool/toolCallCount/
   * lastText の状態は内部に閉じる */
  readonly #progress: ProgressNotice;
  /** 直近の agent_end から集計した usage の累計 (agent_end.messages は毎回全履歴
   * を返すため、ターンごとの増分ではなくセッション累計になる) */
  #usageTotals?: UsageTotals;

  /** レジストリから外れたことを示すフラグ。全終了経路の Map delete の代わりに
   * 立て、stale チェックの主語になる */
  #disposed = false;

  readonly #observer: SessionObserver;
  readonly #sharedStagingDir: string | undefined;
  readonly #ctx: SessionContext;

  constructor(options: SessionOptions) {
    this.sessionKey = options.sessionKey;
    this.channelId = options.channelId;
    this.threadTs = options.threadTs;
    this.triggerMessageId = options.triggerMessageId;
    this.workdir = options.workdir;
    this.policy = options.policy;
    this.#startedAt = Date.now();
    this.#lease = options.lease;
    this.#observer = options.observer;
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

  /** PiProcess がターンを実行中か (steer 可否判定に使う) */
  get processRunning(): boolean {
    return this.#process?.running === true;
  }

  /** 起動シーケンス後半 (runtime.md §1: PiProcess 生成〜イベントハンドラ登録〜start〜
   * register〜初回 prompt〜sessions.put〜started ログ)。spawn 準備
   * (runtime/prepare.ts の関数群) の結果は args で受け取る — Session は spawn 準備を
   * 持たない */
  async start(args: StartArgs): Promise<void> {
    const sessionKey = this.sessionKey;
    const { channelId, threadTs, workdir, policy } = this;
    const {
      triggerEvent,
      channel,
      sessionPath,
      extensionPaths,
      workdirReal,
      sharedDirReal,
      skillPaths,
      permission,
      memoryIndex,
      resumed,
      freshTranscript,
      model,
      extraEnv,
    } = args;
    this.#freshTranscript = freshTranscript;
    const { mentionFormat } = this.#ctx;
    const { piBinary, piEntrypoint, agentUid, agentGid } = this.#ctx.runtime;

    const proc = new PiProcess({
      sessionPath,
      extensionPaths,
      cwd: workdirReal,
      appendSystemPrompt: buildSystemPrompt(
        sessionKey,
        channel,
        mentionFormat,
        sharedDirReal !== undefined,
        memoryIndex,
      ),
      ...(piBinary !== undefined ? { piBinary } : {}),
      ...(piEntrypoint !== undefined ? { piEntrypoint } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(channel?.agent.tools !== undefined
        ? { tools: channel.agent.tools }
        : {}),
      ...(channel?.agent.excludeTools !== undefined
        ? { excludeTools: channel.agent.excludeTools }
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
      // 進捗通知 (ingress-egress.md §8) のための状態更新のみ。LLM 呼び出しも
      // session.jsonl への書き込みも発生しない — pi の RPC イベントの観測だけ
      if (isToolExecutionStart(piEvent)) {
        // reply は「最終回答を作っている」段階であり進捗表示の対象外
        // (ingress-egress.md §8)。currentTool/toolCallCount を更新せず、直前の
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
          resolveReplyFiles(workdirReal, payload.files, (path, reason) =>
            this.#ctx.logger.warn({ sessionKey, path }, reason),
          )
            .then((files) =>
              this.#ctx.router.deliver(
                {
                  thread_key: payload.thread_key,
                  text: payload.text,
                  ...(files !== undefined ? { files } : {}),
                },
                // progressThreadKey は sessionKey 固定ではなく、実際に進捗が
                // 出ている先 (#progress.currentKey) を渡す — reset(leadKey) で
                // sessionKey と異なるキーに差し替わっている場合 (DM の
                // session.mode=channel + reply.mode=flat など)、sessionKey を
                // 渡すと tryUpdateProgress の宛先突合が成立せず上書きされない
                this.#progress.currentKey,
              ),
            )
            .then(() => {
              // reply の tool_execution_end を受けた時点で、agent_end を待たず
              // タイマーを即止める (progressConsumed の真偽によらず)。待つとその間に
              // タイマーが再発火し、進捗メッセージを消費済みなら (古いツール名のまま)
              // 跡地に新規投稿し、消費対象が無かった短いターンでも reply 完了後に
              // ノイズとなる進捗メッセージを新規投稿してしまう (ingress-egress.md §8)
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
        // Turn 内のある pi turn の LLM 呼び出し失敗は agent_end としては正常終了に
        // なるので、ここで拾わないとログに一切残らない (pi-events.ts extractTurnErrors)
        for (const errorMessage of extractTurnErrors(piEvent)) {
          this.#ctx.logger.error(
            { sessionKey, errorMessage },
            "pi turn ended with error",
          );
        }
        // agent_end.messages は毎回全履歴を返すため、この totals はターンの増分では
        // なくセッション累計 (pi-events.ts extractUsageTotals)
        const totals = extractUsageTotals(piEvent);
        this.#usageTotals = totals;
        this.#ctx.logger.info({ sessionKey, ...totals }, "session usage");
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
          "session failure handling failed",
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
        const progressKey = this.#progress.currentKey;
        this.#clearAllTimers();
        void this.#ctx.router.clearProgress(progressKey).catch((err) => {
          this.#ctx.logger.warn(
            { sessionKey, progressKey, err },
            "clear progress failed",
          );
        });
        // このターンで prompt 済みだった item は ack して捨てる。retry しない
        // (message-dispatch.md §7.4)。捨てないと未 ack のまま inbox に残り、次の新規
        // イベントの drain が巻き込んで再 prompt するため、workdir/transcript を
        // 使い回す構造上「同じ入力で pi が再クラッシュし続ける」ループになりうる。
        // 異常終了はユーザーに ❌ で伝わるので、必要なら本人が言い直せばよい。
        // abnormalShutdown (failSession / timeoutSession) と同じ規則 — プロセスが
        // 既に死んでいる分ここでは kill せず lease 解放から始める点だけが違う
        const toAck = [...this.#promptedIds];
        if (toAck.length > 0) {
          void this.#ctx.controlState.inbox
            .ack(sessionKey, toAck)
            .catch((err) => {
              this.#ctx.logger.warn({ sessionKey, err }, "inbox ack failed");
            });
        }
        void this.#ctx.controlState.leases.release(this.#lease).catch((err) => {
          this.#ctx.logger.warn({ sessionKey, err }, "lease release failed");
        });
        void this.#observer.onEnded(this.channelId, sessionKey);
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
    // AgentConfig.context は初回のみ先頭に注入する (config.md §1.3)
    const items = (await this.#ctx.controlState.inbox.drain(sessionKey)).filter(
      (i) => !this.#promptedIds.has(i.id),
    );
    let body: string;
    let leadKey: string;
    if (items.length > 0) {
      const keys: string[] = [];
      for (const i of items)
        keys.push(await this.#beginTurnMessage(i.event, i.id, policy));
      leadKey = keys[0]!;
      body = renderItems(items);
    } else {
      // drain が空 (Store 実装の遅延など)。トリガーイベントに直接フォールバック
      // するが、ack 対象には含める (二重 prompt を防ぐ)
      leadKey = await this.#beginTurnMessage(
        triggerEvent,
        inboxItemId(triggerEvent),
        policy,
      );
      body = renderEvent(triggerEvent, leadKey);
    }
    this.#turnEpoch += 1;
    this.#resetTurnTimeout();
    // このターンの進捗投稿先を先頭発言の宛先にする (progress.ts の reset 参照)
    this.#progress.reset(leadKey);
    proc.prompt(prependContext(body, channel));

    // Session の実行状況 (state.md §3.2)。startedAt は sessionKey に紐づく Session の
    // 開始時刻なので、resume では既存のものを引き継ぐ (#putRecord)。
    // endedAt を書かない = 稼働中
    await this.#putRecord({ endedAt: undefined });
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

  /** start() が throw したときのロールバック (Session が所有する分)。timer/process の
   * 後始末と進捗通知のクリアを行い、disposed を立ててレジストリから外す。lease の
   * release / onEnded / warn ログは呼び出し元 (Dispatcher) が続けて行う。
   * best-effort — stop の失敗は spawn 途中の失敗などで起こりうるので飲み込む */
  async abort(): Promise<void> {
    this.#dispose();
    const progressKey = this.#progress.currentKey;
    this.#clearAllTimers();
    await this.#ctx.router.clearProgress(progressKey);
    try {
      await this.#process?.stop();
    } catch {
      // spawn 途中の失敗など。stop は best-effort でよい
    }
  }

  /** running な Session への steer 配達 (message-dispatch.md §5)。呼び出し元
   * (Dispatcher) が state === "running" && processRunning を確認済みで、
   * enqueue / dedupe / 直近 Session の記録を済ませてから呼ぶ。drain → 未 prompt
   * 抽出 → 宛先登録 → steer を行う */
  async steerPending(): Promise<void> {
    const sessionKey = this.sessionKey;
    const proc = this.#process;
    if (proc === undefined) return;
    const items = await this.#ctx.controlState.inbox.drain(sessionKey);
    const pending = items.filter((i) => !this.#promptedIds.has(i.id));
    if (pending.length > 0) {
      // steer 前に宛先登録 (session-model.md §3 の境界規則) と 👀 付け
      for (const p of pending) {
        await this.#beginTurnMessage(p.event, p.id, this.policy);
      }
      this.#turnEpoch += 1;
      this.#resetTurnTimeout();
      // steer は進捗投稿先を差し替えない (progress.ts の reset 参照) —
      // 合流した追い討ちの宛先がこのターンの先頭発言と異なっていても、
      // 進捗メッセージは元のスレッドに留まる
      this.#progress.reset();
      proc.steer(renderItems(pending));
      this.#ctx.logger.info(
        { sessionKey, items: pending.length },
        "turn steered",
      );
    }
  }

  /**
   * agent_end: flush → ack (この順序が正。逆にするとクラッシュで入力が消える) →
   * 残り入力があれば次の prompt、無ければ linger して再確認、それでも無ければ ✅ で終了
   * (state.md §7, message-dispatch.md §7.3 の linger)
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

    // 1. ターン境界の flush → 2. flush 成功後に ack (state.md §7)。
    // ack 対象は flush 前のスナップショット — flush の await 中に steer が
    // promptedIds へ追加した item を「そのターンの flush 前」に ack しない。
    // リアクション対象 (このターンを起こしたメッセージ) も同じ境界でスナップショット
    // して即クリアする — promptPending が次ターンとして新しい message id を push する前に
    const toAck = [...this.#promptedIds];
    const reactTargets = this.#turnMessageIds;
    this.#turnMessageIds = [];
    await this.#ctx.workdirStore.flush(sessionKey, this.workdir);
    // shared も同じ境界で archive へ書き戻す (docs/design/state.md §7)。異常終了パス
    // (exit / abnormalShutdown / renew 失敗) で書き戻さないのは workdir と同じ理由
    if (
      this.#ctx.sharedStore !== undefined &&
      this.#sharedStagingDir !== undefined
    ) {
      await this.#ctx.sharedStore.flush(this.channelId, this.#sharedStagingDir);
    }
    if (toAck.length > 0) {
      await this.#ctx.controlState.inbox.ack(sessionKey, toAck);
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
    await this.#putRecord({ endedAt: new Date() });
    await proc.stop();
    const progressKey = this.#progress.currentKey;
    this.#clearAllTimers();
    await this.#ctx.router.clearProgress(progressKey);
    await this.#ctx.controlState.leases.release(this.#lease);
    this.#dispose();
    // windowSec の起点 (message-dispatch.md §3.2。以降この Session は窓内なら resume 合流できる)
    await this.#observer.onEnded(this.channelId, sessionKey);
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
      noticeText: sessionFailedNoticeText(error),
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
      noticeText: turnTimeoutNoticeText(this.#ctx.turnTimeoutMs),
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
   * 必要なら本人が言い直せばよい (message-dispatch.md §7.4)。プロセスは使い捨て設計
   * (runtime.md §1) なので常に kill でよい。state を先に "stopping" にしておく
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
    const progressKey = this.#progress.currentKey;
    this.#clearAllTimers();

    // register 済み (起動時に必ず register している) なので deliver できる。
    // 通知の配達が失敗してもセッションの畳み込みは続ける。progressThreadKey は
    // 実際に進捗メッセージが出ている先 (progressKey) を渡す — reset(leadKey) で
    // sessionKey から差し替わっていた場合、sessionKey を渡すと取り残される
    await this.#ctx.router
      .deliver(
        { thread_key: sessionKey, text: options.noticeText },
        progressKey,
      )
      .catch((err) => {
        this.#ctx.logger.warn(
          { sessionKey, err },
          "failure notice delivery failed",
        );
      });
    await this.#ctx.router.clearProgress(progressKey);
    // このターンを起こした各メッセージに ❌ を付けて失敗を伝える
    await this.#reactMessages(this.#turnMessageIds, "error");
    this.#turnMessageIds = [];

    // このターンで prompt 済みだった item は ack して捨てる (retry しない)
    const toAck = [...this.#promptedIds];
    if (toAck.length > 0) {
      await this.#ctx.controlState.inbox.ack(sessionKey, toAck).catch((err) => {
        this.#ctx.logger.warn({ sessionKey, err }, "inbox ack failed");
      });
    }
    await this.#ctx.controlState.leases.release(this.#lease).catch((err) => {
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
    await this.#observer.onEnded(this.channelId, sessionKey);
  }

  /** 未 prompt の item があれば prompt して true (drain は非破壊なので
   * promptedIds で除外する)。無ければ false */
  async #promptPending(proc: PiProcess): Promise<boolean> {
    const sessionKey = this.sessionKey;
    const items = (await this.#ctx.controlState.inbox.drain(sessionKey)).filter(
      (i) => !this.#promptedIds.has(i.id),
    );
    if (items.length === 0) return false;
    const keys: string[] = [];
    for (const i of items)
      keys.push(await this.#beginTurnMessage(i.event, i.id, this.policy));
    this.#turnEpoch += 1;
    // lingering (agent_end 後の終了判定中) からの復帰。ここで拾う item は
    // trySteerExisting が steer せず enqueue のみで残していたものを含む
    this.#state = "running";
    this.#resetTurnTimeout();
    // 新しいターンなので進捗投稿先を先頭発言の宛先に差し替える (start と同様)
    this.#progress.reset(keys[0]!);
    proc.prompt(renderItems(items));
    this.#ctx.logger.info(
      { sessionKey, items: items.length },
      "turn started (continued)",
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
        const ok = await this.#ctx.controlState.leases.renew(
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
        const progressKey = this.#progress.currentKey;
        this.#dispose();
        this.#clearAllTimers();
        await this.#ctx.router.clearProgress(progressKey);
        await this.#process?.stop();
        await this.#observer.onEnded(this.channelId, sessionKey);
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
          "turn timeout handling failed",
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

  /** SessionRecord (state.md §3.2) の書き込み。Session の同一性は sessionKey であり、
   * 起動ごとに変わる triggerMessageId ではない (session-model.md §5.1)。よって
   * startedAt は resume をまたいで引き継ぎ、Transcript が新しく始まったとき
   * (世代交代、または記録がまだ無いとき。session-model.md §6) だけこの起動時刻へ
   * 置き直す。lastActiveAt は書き込みのたびに更新する。rotateRequestedAt は
   * Dispatcher の管轄なので既存値をそのまま残す */
  async #putRecord(args: { endedAt: Date | undefined }): Promise<void> {
    const now = new Date();
    const previous = await this.#ctx.controlState.sessions.get(this.sessionKey);
    await this.#ctx.controlState.sessions.put(this.sessionKey, {
      channelId: this.channelId,
      threadTs: this.threadTs,
      triggerMessageId: this.triggerMessageId,
      startedAt:
        this.#freshTranscript || previous === null
          ? new Date(this.#startedAt)
          : previous.startedAt,
      lastActiveAt: now,
      ...(args.endedAt !== undefined && { endedAt: args.endedAt }),
      ...(previous?.rotateRequestedAt !== undefined && {
        rotateRequestedAt: previous.rotateRequestedAt,
      }),
    });
  }

  /** 全終了経路の共通後始末: 3 タイマー (renew / turn timeout / progress notice) を
   * まとめて止める。どの経路でもこの 3 つは隣接して呼ばれるため無条件に畳める。
   * 進捗通知の clearProgress / lease の release / onEnded / ログは経路ごとに
   * 位置も有無も異なる意図的な差異なのでここには含めない */
  #clearAllTimers(): void {
    this.#stopRenewTimer();
    this.#clearTurnTimeout();
    this.#progress.clear();
  }

  /** レジストリからの離脱 (disposed フラグ + observer.onDisposed)。呼び出し位置は経路ごとに
   * 異なる — abnormalShutdown はログ後 (activeSessionCount がログの後で 0 になるよう)、
   * exit / renew 失敗 / abort は先頭側。activeSessionCount を観測するテストに影響する
   * ので、各経路の現在位置から動かさないこと */
  #dispose(): void {
    this.#disposed = true;
    this.#observer.onDisposed(this);
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
    await this.#react(event.id, "start");
    return threadKey;
  }

  /** ターンの成否を、そのターンを起こした各メッセージへ返す (ok / error)。start は
   * prompt/steer 時点で付けてあるので、これで start → ok/error が揃う。1 ターンに
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
