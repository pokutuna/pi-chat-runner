// Dispatcher — Inbox に届いたメッセージを処理する Session を決め、その Session を
// 排他的に起動または再開する (docs/design/message-dispatch.md)。
//
// docs/design/architecture.md §2, §6 (パイプラインのステージと、event は「きっかけ係」・
// Session が「処理の担い手」)、message-dispatch.md §3 (Session の選択)、§4 (debounce)、
// §5 (steering)、§6 (lease)、§7 (起動と Turn 境界)、docs/design/runtime.md §1
// (起動シーケンス)、docs/design/state.md §3 (Store 群)、§7 (flush → ack の順序)。
//
// スコープ: Session の選択 (sessionKey の導出 → Thread → Session 対応 → affinity 合流)、
// Inbox への enqueue と dedupe、debounce、実行中 Session への steering、lease による
// 多重起動の排他と Session の起動/再開、コマンドの振り分け。
// Gate 評価は Gate ステージ (src/gate/evaluate.ts) が、1 Session の生存期間は
// Session (src/session/session.ts) が持つ。

import { hostname } from "node:os";
import { join } from "node:path";

import type { ClassifierClient } from "../classifier/client.js";
import type { ResolvedChannel } from "../config/config-source.js";
import type { ConfigSource } from "../config/config-source.js";
import type { EgressRouter } from "../egress/router.js";
import type { TurnReactor } from "../egress/turn-reactor.js";
import type { FetchMessage } from "../gate/evaluate.js";
import { GateEvaluator } from "../gate/evaluate.js";
import type { ChatEvent, InboundMessage } from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import { rootLogger } from "../logger.js";
import type { RuntimeConfig } from "../runtime/config.js";
import {
  buildSpawnOptions,
  loadMemoryIndex,
  prepareWorkdir,
  resolveBuiltinExtensionPaths,
  resolveBuiltinMemorySkillPath,
  warnPolicyMismatches,
} from "../runtime/prepare.js";
import type { MentionFormat } from "../runtime/prompt.js";
import {
  Session,
  type SessionContext,
  type SessionObserver,
} from "../session/session.js";
import type { SharedStore, WorkdirStore } from "../state/agent/interfaces.js";
import { inboxItemId } from "../state/control/inbox-item.js";
import type { ControlState, InboxItem } from "../state/control/interfaces.js";
import {
  type CommandHandlerDeps,
  handleNewCommand,
  handleToggleCommand,
  parseCommand,
  rejectNewWhileRunning,
} from "./commands.js";
import {
  computeDispatchDelayMs,
  resolveSessionPolicy,
  type SessionPolicy,
  sessionKeyOf,
} from "./policy.js";

export interface DispatcherOptions {
  configSource: ConfigSource;
  /** Control State の Store 群 (inbox / sessions / threads / leases / channels)。state.md §3 */
  controlState: ControlState;
  router: EgressRouter;
  reactor: TurnReactor;
  /** workdir の境界退避。 */
  workdirStore: WorkdirStore;
  /** チャンネル単位の共有ディレクトリの境界退避 (docs/design/state.md §9)。
   * 未指定なら shared 機能ごと無効 — staging の作成・skill 配線・system prompt
   * への言及をすべて行わない (createSharedStore が設定から解決する) */
  sharedStore?: SharedStore;
  /** Runtime レイヤの静的設定 (pi のパス・env allowlist・UID 分離・Permission Model・
   * workdir のルート)。組み立ては composition root の担当 (runtime/resolve.ts の
   * createRuntimeConfig)。runtime.md §1 */
  runtime: RuntimeConfig;
  /** lease の TTL。既定 60_000ms。renew は ttl/3 間隔 */
  leaseTtlMs?: number;
  /** 長時間ターンの進捗通知の間隔 (ingress-egress.md §8)。初回発火までの猶予も同じ値を使う。
   * 既定 30_000ms。0 を渡すと機能自体を無効化する (負値は指定しない想定) */
  progressNoticeIntervalMs?: number;
  /** agent_end 後に追いメッセージを待つ時間。既定 20_000ms */
  lingerMs?: number;
  /** 1 ターン (prompt/steer 送信から agent_end まで) の上限。既定 600_000ms (10 分)。
   * 超過したら pi を kill してセッションを異常終了として畳む
   * (runtime.md §5.1: 「ターンにタイムアウトを設け、超過したら pi を kill」) */
  turnTimeoutMs?: number;
  /** lease の owner 識別子。既定 `hostname:pid` */
  owner?: string;
  /** ユーザーへの言及をレンダリングする関数 (返信本文に埋め込む記法)。プラットフォーム
   * ごとに記法が異なるため必須 (Runner が ChatPlatform の記法を渡す。それ以外の
   * 利用者は自分で実装を渡す) */
  mentionFormat: MentionFormat;
  /** reaction の対象メッセージ本文を取得する port (message-dispatch.md §1)。Gate を
   * 通過した reaction を message の形へ均すために Gate ステージが使う。省略時は
   * 常に null を返す = reaction 起動は成立しない */
  fetchMessage?: FetchMessage;
  logger?: Logger;
  /** classifier gate 用の LLM client。省略時は classifier gate を使う channel で
   * createGate が throw する (config.md §4.1)。 */
  classifierClient?: ClassifierClient;
}

/** debounce 待機中の Session の状態 (session.affinity.debounceSec、
 * message-dispatch.md §4: 連投バーストの途中で不完全な入力のまま Session を
 * 起動しないよう、静まるまで dispatch を遅らせる)。item は dispatch 前から inbox に
 * enqueue 済みなので、この状態自体はプロセス死からの復旧対象ではない
 * (拾い直しは既存の inbox 経路に乗る) */
interface PendingDispatch {
  timer: NodeJS.Timeout;
  /** hard cap 算出の基準 (最初に滞留させたメッセージの到着時刻) */
  firstPendingAtMs: number;
  debounceSec: number;
  /** タイマー発火時に dispatch する対象。直近のイベントで都度更新する */
  triggerEvent: InboundMessage;
  channel: ResolvedChannel | null;
  channelId: string;
}

export class Dispatcher implements SessionObserver {
  private readonly sessions = new Map<string, Session>();
  /** debounceSec 待機中の Session (sessionKey → 保留状態。message-dispatch.md §4:
   * Session 非稼働で Gate 通過 → inbox enqueue した後、即 dispatch する代わりに
   * Session ごとのタイマーで dispatch を遅らせる) */
  private readonly pendingDispatches = new Map<string, PendingDispatch>();
  /** Gate ステージ (src/gate/evaluate.ts)。Channel 有効状態・実行中 Session・
   * Gate 木の順序判定と、reaction の message 化をここに委ねる — Dispatcher は
   * 個々の Gate を呼ばない */
  private readonly gate: GateEvaluator;
  /** コマンドハンドラ (`/new` `/enable` `/disable`) の依存一式 */
  private readonly commandDeps: CommandHandlerDeps;
  /** 組み込み memory skill の絶対パス。shared 有効時のみ解決する (無効時 undefined) */
  private readonly memorySkillPath: string | undefined;
  private readonly extensionPaths: string[];
  private readonly owner: string;
  /** Session 横断の依存・設定一式 (session/session.ts の SessionContext)。
   * options から一度だけ組み立て、Session の構築のたびに ctx ごと渡す —
   * options.* を毎回 Session のオプションへ再梱包しない */
  private readonly ctx: SessionContext;
  /** Dispatcher 自身のログ (component: "dispatcher")。Session 側のログは
   * ctx.logger (component: "session")、Runtime 準備のログは runtimeLogger
   * (component: "runtime") を使う — レイヤごとにログを絞り込めるようにする */
  private readonly logger: Logger;
  /** Runtime 層 (workdir 準備 / spawn オプション組み立て) へ渡すログ */
  private readonly runtimeLogger: Logger;

  constructor(options: DispatcherOptions) {
    // memory skill は書き先が ../shared/ なので shared 前提。有効時は boot で解決して
    // 配置壊れを fail-loud にする (チャンネル別の opt-out は起動時に channel.memory で判定)
    this.memorySkillPath =
      options.sharedStore !== undefined
        ? resolveBuiltinMemorySkillPath()
        : undefined;
    // 組み込み extension (reply/permission-gate/export) は常時注入で外せない
    // (permission-gate は事故防止層なので無効化オプションを持たない)。利用者の
    // 追加 extension は $AGENT_HOME/.pi/agent/extensions/ 規約で拾う
    // (startOrResumeSession() 参照)
    this.extensionPaths = resolveBuiltinExtensionPaths();
    this.owner = options.owner ?? `${hostname()}:${process.pid}`;
    this.ctx = {
      controlState: options.controlState,
      router: options.router,
      reactor: options.reactor,
      workdirStore: options.workdirStore,
      sharedStore: options.sharedStore,
      logger: (options.logger ?? rootLogger).child({ component: "session" }),
      lingerMs: options.lingerMs ?? 20_000,
      turnTimeoutMs: options.turnTimeoutMs ?? 600_000,
      leaseTtlMs: options.leaseTtlMs ?? 60_000,
      progressNoticeIntervalMs: options.progressNoticeIntervalMs ?? 30_000,
      mentionFormat: options.mentionFormat,
      runtime: options.runtime,
    };
    const logger = (options.logger ?? rootLogger).child({
      component: "dispatcher",
    });
    this.logger = logger;
    this.runtimeLogger = (options.logger ?? rootLogger).child({
      component: "runtime",
    });
    this.gate = new GateEvaluator({
      configSource: options.configSource,
      controlState: options.controlState,
      // fetchMessage 未注入なら reaction 起動は成立しない (常に「対象メッセージ
      // 不在」として drop される)
      fetchMessage: options.fetchMessage ?? (async () => null),
      logger: (options.logger ?? rootLogger).child({ component: "gate" }),
      ...(options.classifierClient !== undefined
        ? { classifierClient: options.classifierClient }
        : {}),
    });
    this.commandDeps = {
      controlState: options.controlState,
      router: options.router,
      logger,
      owner: this.owner,
    };
  }

  /** 実行中 (起動中を含む) の Session 数。テスト・観測用 */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /** SessionObserver: Session の全終了経路からレジストリ (Map) より自分を外す。
   * sessionKey で登録されている Session が呼び出し元自身のときだけ消す
   * (別の Session を巻き込まない) */
  onDisposed(session: Session): void {
    const current = this.sessions.get(session.sessionKey);
    if (current === session) this.sessions.delete(session.sessionKey);
  }

  /** SessionObserver: Session の終了を windowSec の起点として記録する
   * (threads.markLatestEnded、message-dispatch.md §3.2) */
  onEnded(channelId: string, sessionKey: string): Promise<void> {
    return this.markLatestSessionEnded(channelId, sessionKey);
  }

  /** message 1 件の処理 (message-dispatch.md §1)。Session の選択 → allowBots →
   * 実行中 Session へのコマンド → Gate ステージ → コマンド or dispatch。
   * Gate の段の並び (Channel 有効状態 → 実行中 Session → Gate 木) は
   * GateEvaluator.admit が持つ */
  async handle(event: InboundMessage): Promise<void> {
    const channelId = event.conversation.channelId;
    const isDm = event.conversation.isDm === true;
    // DM は channelId 個別の channel ではなく予約名 "dm" の channel を全 DM 共通で参照する
    // (config.md §3.1, §1.2)。Session 自体は実 channelId (D...) で管理する
    const channel = await this.gate.channelConfig(channelId, isDm);
    const policy = resolveSessionPolicy(channel, isDm);

    // bot 投稿 (自己エコーは Ingress で除外済み) は allowBots opt-in の
    // channel でのみ Gate 評価・steer に乗せる (config.md §4.3)
    if (event.sender.isBot && !this.gate.allowsBots(channel)) {
      this.logger.debug(
        { channelId, sessionKey: await this.selectSession(event, policy) },
        "bot message ignored (allowBots not enabled)",
      );
      return;
    }

    // コマンド (session-model.md §5)。Gate を通過したメッセージにのみ意味を
    // 持たせる (mention gate のチャンネルでは `@bot /new` 等) ため、Gate 評価より
    // 前に判定するのはここまで — 実行中 Session への /new 拒否、および実行中でも
    // 効く /enable /disable だけは Gate をバイパスする。
    // bot に Session を切らせない (session-model.md §5) ため bot 送信者ではコマンド化しない
    const cmd = event.sender.isBot ? null : parseCommand(event.text);
    if (cmd !== null) {
      const sessionKey = await this.selectSession(event, policy);
      if (this.sessions.has(sessionKey)) {
        if (cmd.kind === "new") {
          await rejectNewWhileRunning(
            this.commandDeps,
            sessionKey,
            event,
            policy,
          );
          return;
        }
        // enable/disable は状態書き込みのみで Session と競合しないため、
        // 実行中でも即座に処理する (session-model.md §5.2)
        await handleToggleCommand(
          this.commandDeps,
          sessionKey,
          channelId,
          policy,
          event,
          cmd,
        );
        return;
      }
    }

    // Gate ステージ。`/enable` `/disable` だけは Channel 無効中も復帰経路として
    // 通し、Gate (mention) を経て処理する (session-model.md §5.2)。`/new` も
    // 無効中は効かない
    const isToggleCommand = cmd !== null && cmd.kind !== "new";
    const outcome = await this.gate.admit({
      event,
      resolveSessionKey: (message) => this.selectSession(message, policy),
      deliverToRunningSession: (message, sessionKey) =>
        this.trySteerExisting(sessionKey, this.inboxItemOf(message)),
      ...(isToggleCommand ? { bypassChannelDisabled: true } : {}),
    });
    if (outcome.kind === "drop") return;
    const { sessionKey } = outcome;

    if (cmd !== null) {
      if (cmd.kind === "new") {
        const rest = await handleNewCommand(
          this.commandDeps,
          sessionKey,
          channelId,
          policy,
          event,
          cmd,
        );
        if (rest !== null) {
          const restEvent: InboundMessage = { ...event, text: rest.rest };
          await this.dispatchTriggered(
            sessionKey,
            channelId,
            policy,
            restEvent,
            channel,
            this.inboxItemOf(restEvent),
            // /new は明示的な新規開始なので affinity 合流させない
            // (session-model.md §5.1)
            { skipAffinity: true },
          );
        }
      } else {
        await handleToggleCommand(
          this.commandDeps,
          sessionKey,
          channelId,
          policy,
          event,
          cmd,
        );
      }
      return;
    }

    await this.dispatchTriggered(
      sessionKey,
      channelId,
      policy,
      event,
      channel,
      this.inboxItemOf(event),
    );
  }

  /** reaction によるリアクション起動 (message-dispatch.md §1「人間によるリアクション
   * 起動」)。Gate ステージが reaction event を trigger.when の Gate 木で評価し、
   * trigger したときにのみ対象メッセージ本文を fetch して synthetic InboundMessage に
   * 変換するので、Dispatcher は message と同じ配送経路 (trySteerExisting /
   * dispatchTriggered) にそれを流すだけでよい */
  async handleReaction(event: ChatEvent): Promise<void> {
    if (event.kind !== "reaction") return;
    const channelId = event.conversation.channelId;
    const isDm = event.conversation.isDm === true;
    const channel = await this.gate.channelConfig(channelId, isDm);
    const policy = resolveSessionPolicy(channel, isDm);

    const outcome = await this.gate.admit({
      event,
      resolveSessionKey: (message) => this.selectSession(message, policy),
      deliverToRunningSession: (message, sessionKey) =>
        this.trySteerExisting(sessionKey, this.inboxItemOf(message)),
    });
    if (outcome.kind === "drop") return;

    await this.dispatchTriggered(
      outcome.sessionKey,
      channelId,
      policy,
      outcome.message,
      channel,
      this.inboxItemOf(outcome.message),
    );
  }

  /** Session の選択 (message-dispatch.md §3)。sessionKey の導出 → Thread → Session
   * 対応の解決。affinity 合流は Gate 通過後の dispatchTriggered で行う
   * (Gate 非通過のメッセージで合流先を書き換えないため) */
  private async selectSession(
    event: InboundMessage,
    policy: SessionPolicy,
  ): Promise<string> {
    // affinity で合流したスレッド内の追い発言は合流先 Session の発言として扱う
    // (message-dispatch.md §3.1 Thread → Session の対応)
    return this.resolveBoundSession(sessionKeyOf(event, policy));
  }

  /** InboxItem 1 件の組み立て (id は dedupe キー、state.md §3.1) */
  private inboxItemOf(event: InboundMessage): InboxItem {
    return { id: inboxItemId(event), event, enqueuedAt: new Date() };
  }

  /** 実行中 (起動中を含む) Session への enqueue + steer 配達
   * (message-dispatch.md §2, §5。後続発言は追加指示として扱う)。enqueue は「Session あり」の
   * ときだけ行う — Gate 非通過の全メッセージを永続 store に溜め込まない (dedupe は enqueue 時に
   * 効く)。戻り値 true はこの Session で処理済み (呼び出し元は return してよい) を示す */
  private async trySteerExisting(
    sessionKey: string,
    item: InboxItem,
  ): Promise<boolean> {
    const existing = this.sessions.get(sessionKey);
    if (existing === undefined) return false;

    const fresh = await this.ctx.controlState.inbox.enqueue(sessionKey, item);
    if (!fresh) {
      this.logger.debug(
        { sessionKey, itemId: item.id },
        "inbox duplicate skip",
      );
      return true;
    }
    // steer 配達も Session の活動 (message-dispatch.md §3.2 の直近 Session の記録)
    await this.touchLatestSession(
      item.event.conversation.channelId,
      sessionKey,
    );
    // starting 中は初回 prompt の drain が拾う。running なら steer で即配達する。
    // lingering (agent_end 後の終了判定中) は enqueue のみ — onAgentEnd の
    // promptPending が prompt で新ターンとして拾う。アイドルな pi への steer は
    // ターンを開始しないため (キューに積まれるだけで宙吊りになる)
    if (existing.state === "running" && existing.processRunning) {
      await existing.steerPending();
    }
    return true;
  }

  /** Gate 通過が確定した後の affinity 合流解決 → enqueue → 多重起動チェック →
   * debounce or 即 dispatch (handle / handleReaction の共通経路。message-dispatch.md
   * §3.2, §4)。item はここで永続 store へ積む (dedupe = at-least-once の再送吸収)。
   * この後 debounce タイマーで dispatch を遅らせても、item は既に永続化済みなので
   * プロセス死で消えない (拾い直しは既存の inbox 経路に乗る)。skipAffinity は
   * `/new` の明示新規 (合流の逃げ道、session-model.md §5.1) 用 */
  private async dispatchTriggered(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    channel: ResolvedChannel | null,
    item: InboxItem,
    options?: { skipAffinity?: boolean },
  ): Promise<void> {
    // affinity 合流 (message-dispatch.md §3.2): チャンネル直下投稿を直近 Session へ
    // 差し替える。以降は既存の配達経路 (steer / debounce / dispatch = start or resume)
    // がそのまま働く
    if (options?.skipAffinity !== true) {
      const target = await this.resolveAffinityTarget(
        sessionKey,
        channelId,
        event,
        channel,
      );
      if (target !== sessionKey) {
        // このイベントのスレッドを合流先 Session に束ね、以降のスレッド内の追い
        // 発言も合流先へ届くようにする (message-dispatch.md §3.1)。Control State に
        // 記録するので Runner の実行インスタンスが入れ替わっても対応は保たれる
        await this.bindThread(sessionKey, target);
        this.logger.info(
          {
            channelId,
            sessionKey: target,
            naturalKey: sessionKey,
            itemId: item.id,
          },
          "affinity attach",
        );
        sessionKey = target;
        // 合流先が生きていれば steer 経路で配達して終わり (running なら即 steer、
        // starting/lingering なら enqueue のみで既存の drain が拾う)
        if (await this.trySteerExisting(sessionKey, item)) return;
      }
    }

    const fresh = await this.ctx.controlState.inbox.enqueue(sessionKey, item);
    if (!fresh) {
      this.logger.debug(
        { sessionKey, itemId: item.id },
        "inbox duplicate skip",
      );
      return;
    }
    // Session の発生 (debounce 待機開始 / dispatch) を直近 Session の記録へ反映
    await this.touchLatestSession(channelId, sessionKey);

    // 多重起動防止: Gate 評価の await 中に別イベントが dispatch 済みなら、
    // 上で enqueue した item はその Session の drain が拾う
    if (this.sessions.has(sessionKey)) return;

    const debounceSec = channel?.session?.affinity?.debounceSec;
    if (debounceSec !== undefined && event.mentionsBot !== true) {
      this.scheduleDebouncedDispatch(
        sessionKey,
        channelId,
        policy,
        event,
        channel,
        debounceSec,
      );
      return;
    }

    // mentionsBot による即 dispatch バイパス: 同じ Session の保留タイマーがあれば
    // キャンセルする (item は inbox にあるので初回 prompt の drain がまとめて拾う)
    this.clearPendingDispatch(sessionKey);
    await this.startOrResumeSession(
      sessionKey,
      channelId,
      policy,
      event,
      channel,
    );
  }

  /** debounceSec のスライディングタイマーを (再)セットする。既存タイマーがあれば
   * firstPendingAtMs を維持したまま張り直し、無ければ新規に開始する
   * (message-dispatch.md §4: 後続メッセージが来るたび「最後のメッセージ +
   * debounceSec」に延長し、hard cap を超えては延ばさない) */
  private scheduleDebouncedDispatch(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    channel: ResolvedChannel | null,
    debounceSec: number,
  ): void {
    const existing = this.pendingDispatches.get(sessionKey);
    const nowMs = Date.now();
    const firstPendingAtMs = existing?.firstPendingAtMs ?? nowMs;
    if (existing !== undefined) clearTimeout(existing.timer);

    const delayMs = computeDispatchDelayMs({
      nowMs,
      firstPendingAtMs,
      debounceSec,
    });
    const timer = setTimeout(() => {
      this.pendingDispatches.delete(sessionKey);
      void this.fireDebouncedDispatch(
        sessionKey,
        channelId,
        policy,
        event,
        channel,
      ).catch((err) => {
        this.logger.warn({ sessionKey, err }, "debounced dispatch failed");
      });
    }, delayMs);
    timer.unref();
    this.pendingDispatches.set(sessionKey, {
      timer,
      firstPendingAtMs,
      debounceSec,
      triggerEvent: event,
      channel,
      channelId,
    });
    this.logger.debug(
      { sessionKey, delayMs, firstPendingAtMs },
      "dispatch debounced",
    );
  }

  /** debounce タイマー発火時の dispatch 試行。発火までの間に別経路 (mentionsBot
   * バイパス等) で既に Session が起動していたら何もしない — item は既存の drain が拾う */
  private async fireDebouncedDispatch(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    channel: ResolvedChannel | null,
  ): Promise<void> {
    if (this.sessions.has(sessionKey)) return;
    // debounce 待機中に /disable された場合、タイマー発火時点で再チェックする
    // (session-model.md §5.2)
    if (await this.gate.isChannelDisabled(channelId)) {
      this.logger.info(
        { channelId, sessionKey },
        "debounced dispatch skipped (channel disabled)",
      );
      return;
    }
    await this.startOrResumeSession(
      sessionKey,
      channelId,
      policy,
      event,
      channel,
    );
  }

  /** 保留中の debounce タイマーがあればキャンセルして Map から消す (mentionsBot の
   * 即 dispatch バイパス、または debounce 前提が崩れた場合の後始末) */
  private clearPendingDispatch(sessionKey: string): void {
    const pending = this.pendingDispatches.get(sessionKey);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingDispatches.delete(sessionKey);
  }

  /** affinity 合流先の解決 (message-dispatch.md §3.2)。scope=channel のとき、Gate を
   * 通過したチャンネル直下投稿を Channel の直近 Session へ差し替える。合流しない
   * 場合は naturalKey をそのまま返す。判定は時間窓ルールのみ (classifier に委ねない) */
  private async resolveAffinityTarget(
    naturalKey: string,
    channelId: string,
    event: InboundMessage,
    channel: ResolvedChannel | null,
  ): Promise<string> {
    const affinity = channel?.session?.affinity;
    if (affinity?.scope !== "channel") return naturalKey;
    // スレッド内の発言はそのスレッドの Session に属する (message-dispatch.md §3.1
    // Thread → Session の対応)。合流対象はチャンネル直下投稿のみ
    if (event.conversation.threadTs !== undefined) return naturalKey;

    const latest = await this.ctx.controlState.threads.latest(channelId);
    if (latest === null || latest.sessionKey === naturalKey) {
      return naturalKey;
    }

    // 生きている Session (debounce 待機 / starting / running / lingering) へは
    // 窓に関わらず合流する
    if (
      this.sessions.has(latest.sessionKey) ||
      this.pendingDispatches.has(latest.sessionKey)
    ) {
      return latest.sessionKey;
    }

    // 終了済み Session は windowSec 以内なら resume 合流。endedAt が無い
    // (クラッシュで書き損ね等) 場合は lastActiveAt で保守的に判定する
    const windowSec = affinity.windowSec ?? 0;
    const refMs = (latest.endedAt ?? latest.lastActiveAt).getTime();
    if (Date.now() - refMs <= windowSec * 1000) return latest.sessionKey;
    return naturalKey;
  }

  /** Thread → Session 対応の解決 (message-dispatch.md §3.1)。対応が引けないときは
   * 導出した sessionKey をそのまま使う — 対応の読み出し失敗でイベント処理を止めない */
  private async resolveBoundSession(naturalKey: string): Promise<string> {
    try {
      return (
        (await this.ctx.controlState.threads.resolve(naturalKey)) ?? naturalKey
      );
    } catch (err) {
      this.logger.warn({ naturalKey, err }, "thread binding resolve failed");
      return naturalKey;
    }
  }

  /** 合流結果の記録 (message-dispatch.md §3.1)。記録できなくても配達は成立する
   * (このイベント自体は合流先へ届く) ので、失敗はログのみで進行を止めない */
  private async bindThread(
    threadKey: string,
    sessionKey: string,
  ): Promise<void> {
    try {
      await this.ctx.controlState.threads.bind(threadKey, sessionKey);
    } catch (err) {
      this.logger.warn({ threadKey, sessionKey, err }, "thread binding failed");
    }
  }

  /** 直近 Session の活動更新 (message-dispatch.md §3.2)。合流候補の検索用
   * (advisory) なので、書き込み失敗でイベント処理を止めない */
  private async touchLatestSession(
    channelId: string,
    sessionKey: string,
  ): Promise<void> {
    try {
      await this.ctx.controlState.threads.touchLatest(channelId, sessionKey);
    } catch (err) {
      this.logger.warn(
        { channelId, sessionKey, err },
        "latest session touch failed",
      );
    }
  }

  /** Session 終了時の endedAt 記録 (message-dispatch.md §3.2。windowSec の起点に
   * なる)。直近が既に別 Session を指していれば store 側が no-op にする — 古い
   * Session の終了で「最後に活動した Session」を巻き戻さない */
  private async markLatestSessionEnded(
    channelId: string,
    sessionKey: string,
  ): Promise<void> {
    try {
      await this.ctx.controlState.threads.markLatestEnded(
        channelId,
        sessionKey,
      );
    } catch (err) {
      this.logger.warn(
        { channelId, sessionKey, err },
        "latest session end mark failed",
      );
    }
  }

  /** 実行ロックを取って Session を起動 (start) または再開 (resume) する
   * (即時 dispatch と debounce タイマー発火の両方から共有。message-dispatch.md §6, §7)。
   * lease が取れない・二重起動になりそうなケースはログのみで戻る — item は enqueue
   * 済みなので保持者側の drain (steer / agent_end / linger) が拾う */
  private async startOrResumeSession(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    channel: ResolvedChannel | null,
  ): Promise<void> {
    // 実行ロック。取れなければ別プロセスが保持中 — enqueue 済みなので
    // 保持者側の drain (steer / agent_end / linger) が拾う
    const lease = await this.ctx.controlState.leases.acquire(
      sessionKey,
      this.owner,
      this.ctx.leaseTtlMs,
    );
    if (lease === null) {
      this.logger.info(
        { sessionKey, itemId: inboxItemId(event) },
        "lease held by another process; enqueued only",
      );
      return;
    }
    if (this.sessions.has(sessionKey)) {
      // acquire の await 中にローカルの別イベントが起動した (そちらが lease を
      // 取れているはずなので通常到達しないが、二重起動だけは防ぐ)
      await this.ctx.controlState.leases.release(lease);
      return;
    }

    // Session 根の threadTs は event ではなく sessionKey から導出する (thread モードの
    // key は `${channelId}:${threadTs}`)。affinity 合流の resume では event のスレッド
    // 位置と Session が一致しないが、workdir/transcript は常に Session 基準 (state.md §6)
    const threadTs =
      policy.sessionMode === "channel"
        ? (event.conversation.threadTs ?? event.id)
        : sessionKey.slice(channelId.length + 1);
    const workdir = join(
      this.ctx.runtime.workdirRoot,
      channelId,
      policy.sessionMode === "channel" ? "channel" : threadTs,
    );
    const session = new Session({
      sessionKey,
      channelId,
      threadTs,
      triggerMessageId: event.id,
      workdir,
      policy,
      lease,
      observer: this,
      sharedStagingDir:
        this.ctx.sharedStore !== undefined
          ? this.sharedStagingDir(channelId)
          : undefined,
      ctx: this.ctx,
    });
    this.sessions.set(sessionKey, session);

    try {
      // 起動シーケンス前半 (runtime.md §1, §2: restore → spawn 準備)。
      // PiProcess 生成以降 (spawn → prompt) は Session.start が担う
      warnPolicyMismatches(this.logger, sessionKey, channelId, policy, channel);

      // workdir/shared の mkdir + restore、transcript 世代交代、UID 分離、
      // agentHome 作成、realpath 正規化 (runtime.md §2, §5.1)
      const previousSession =
        await this.ctx.controlState.sessions.get(sessionKey);
      const {
        workdirReal,
        agentHomeReal,
        sharedDirReal,
        sessionPath,
        resumed,
        rotateConsumed,
        transcriptRotated,
      } = await prepareWorkdir({
        sessionKey,
        channelId,
        workdir,
        policy,
        channel,
        previousSession,
        workdirStore: this.ctx.workdirStore,
        sharedStore: this.ctx.sharedStore,
        sharedStagingDir: (id) => this.sharedStagingDir(id),
        agentUid: this.ctx.runtime.agentUid,
        agentGid: this.ctx.runtime.agentGid,
        agentHome: this.ctx.runtime.agentHome,
        logger: this.runtimeLogger,
      });

      // extension/skill パス解決 + Node Permission Model オプション組み立て
      // (runtime.md §4, §5.2)
      const { extensionPaths, skillPaths, memoryEnabled, permission } =
        await buildSpawnOptions({
          agentHomeReal,
          workdirReal,
          sharedDirReal,
          channel,
          builtinExtensionPaths: this.extensionPaths,
          memorySkillPath: this.memorySkillPath,
          piPermission: this.ctx.runtime.piPermission,
        });

      const model = channel?.agent.model;
      // pi 子プロセスへ渡す env は足し算モデル (config.md §1.3, §2.3): コード既定
      // (server.ts の gcpEnv / PI_EXPORT_ENTRYPOINT。ctx.extraEnv) の上に、解決済み
      // Channel の Agent Config の env を Channel ごとに重ねる。後勝ちなのは
      // 「利用者が意図して GOOGLE_CLOUD_PROJECT 等を差し替える」を許すため。
      // 最後に HOME を agentHome へ上書きする (Runner 自身の HOME は継承しない。
      // buildPiEnv は extraEnv が PATH/HOME を上書きできる実装になっている)
      const extraEnv = {
        ...this.ctx.runtime.extraEnv,
        ...channel?.agent.env,
        HOME: agentHomeReal,
      };
      // memory の索引 (MEMORY.md) は skill 発火 (agent の自発的な read) に頼らず
      // system prompt に常時注入する (docs/design/runtime.md §6)。1 行 1 メモリの
      // 短い索引という規約 (SKILL.md の Save 手順) が前提で、肥大化はしない想定。
      // 本文ファイルは引き続き skill 経由でオンデマンドに read させる
      const memoryIndex = await loadMemoryIndex(memoryEnabled, sharedDirReal);

      await session.start({
        triggerEvent: event,
        channel,
        sessionPath,
        extensionPaths,
        workdirReal,
        sharedDirReal,
        skillPaths,
        permission,
        memoryIndex,
        resumed,
        // Transcript が世代交代したか、まだ Session の記録が無いなら Transcript は
        // 新しく始まっている。SessionRecord の startedAt をこの起動時刻に置き直す
        // 条件になる (session-model.md §6, state.md §3.2)
        freshTranscript: transcriptRotated || previousSession === null,
        model,
        extraEnv,
      });

      // /new マーカーの消費 (session-model.md §5.1: 「マーカーは次の Session 起動時、
      // Workdir の復元後に消費される」)。Control State を書くのは Dispatcher の責務
      // なので、Runtime 準備 (prepareWorkdir) が返した判定をここで確定させる。
      // start() 後に置くのは、start が SessionRecord を put し直すため — 先に
      // クリアすると start の put で書き戻される
      if (rotateConsumed) await this.clearRotateMarker(sessionKey);
    } catch (err) {
      // enqueue 済み item は ack されていないので、同じ Session の次のイベント
      // (または再送) で再び dispatch され拾い直される (message-dispatch.md §7.4)。
      // timer/process の後始末と progress クリアは session.abort に閉じ、
      // lease release / markEnded / warn ログはここで現行と同じ順序で続ける
      await session.abort();
      await this.ctx.controlState.leases.release(lease);
      await this.markLatestSessionEnded(channelId, sessionKey);
      this.logger.warn({ sessionKey, err }, "session dispatch failed");
    }
  }

  /** /new マーカー (rotateRequestedAt) のクリア。1 回の起動でちょうど 1 回、
   * Workdir の復元後に消費する (session-model.md §5.1)。マーカーの書き込みと同じく
   * Control State の更新なので Dispatcher が行う。クリアに失敗しても次の起動で
   * もう一度 rotate されるだけなので、進行は止めない */
  private async clearRotateMarker(sessionKey: string): Promise<void> {
    try {
      const current = await this.ctx.controlState.sessions.get(sessionKey);
      if (current?.rotateRequestedAt === undefined) return;
      // exactOptionalPropertyTypes: true のため rotateRequestedAt を持つ
      // プロパティ自体を作らない
      const { rotateRequestedAt: _rotateRequestedAt, ...cleared } = current;
      await this.ctx.controlState.sessions.put(sessionKey, cleared);
    } catch (err) {
      this.logger.warn({ sessionKey, err }, "rotate marker clear failed");
    }
  }

  /** チャンネル共有ディレクトリの staging パス (docs/design/state.md §6)。
   * workdir の隣に置く — agent からは session.mode に関わらず cwd 相対 ../shared/
   * (`<channelId>/<threadTs>/` と `<channelId>/channel/` のどちらとも隣接する) */
  private sharedStagingDir(channelId: string): string {
    return join(this.ctx.runtime.workdirRoot, channelId, "shared");
  }
}
