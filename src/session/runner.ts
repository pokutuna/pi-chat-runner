// SessionRunner — event を受けて session を主語に処理するオーケストレーション (Step 4)
//
// docs/design/architecture.md §6 (event は「きっかけ係」、session が「処理の担い手」)、
// docs/design/message-dispatch.md §7 (起動と Turn 境界)、§5 (steering)、
// docs/design/runtime.md §1 (kick シーケンス)、docs/design/state.md §6 (tmpfs + 境界 flush)、
// §3 (Store 群)、§7 (flush → ack の順序)。
//
// Step 4 のスコープ: lease による多重起動の排他、drain/ack 分離 (drain は非破壊。
// プロンプト済み item の記憶と重複除外は runner のインメモリ責務)、agent_end 後の
// linger による追いメッセージ拾い直し、WorkdirStore による境界退避 (未指定なら
// Step 3 相当のローカル置きっぱなし)。turn timeout (Step 6) もここで実装する
// (runtime.md §5.1「ターンにタイムアウトを設け、超過したら pi を kill」)。

import { hostname } from "node:os";
import { join } from "node:path";

import type { ClassifierClient } from "../classifier/client.js";
import type { ChannelDoc } from "../config/channel-doc.js";
import { type ConfigSource, DM_CHANNEL } from "../config/config-source.js";
import type { EgressRouter } from "../egress/router.js";
import type { TurnReactor } from "../egress/turn-reactor.js";
import {
  buildWhen,
  defaultWhen,
  type EvaluableNode,
  evaluateWhen,
  type GateDeps,
} from "../gate/gate.js";
import type { InboundMessage, ReactionEvent } from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import { rootLogger } from "../logger.js";
import type { SharedStore, WorkdirStore } from "../state/agent/interfaces.js";
import { inboxItemId } from "../state/control/inbox-item.js";
import type { ControlState, InboxItem } from "../state/control/interfaces.js";
import {
  ActiveSession,
  type SessionContext,
  type SessionHost,
} from "./active-session.js";
import { type ChatCommand, parseCommand } from "./commands.js";
import {
  computeKickDelayMs,
  resolveSessionPolicy,
  type SessionPolicy,
  sessionKeyOf,
} from "./policy.js";
import {
  ACK_NOTICE_TEXT,
  DISABLE_NOTICE_TEXT,
  ENABLE_NOTICE_TEXT,
  type MentionFormat,
  REJECT_NOTICE_TEXT,
} from "./prompt.js";
import { registerReplyDestination } from "./reply-destination.js";
import {
  buildSpawnOptions,
  loadMemoryIndex,
  type PiPermissionConfig,
  prepareWorkdir,
  resolveBuiltinExtensionPaths,
  resolveBuiltinMemorySkillPath,
  warnPolicyMismatches,
} from "./spawn.js";

/** reaction の対象メッセージ本文を取得する port (message-dispatch.md §1「人間による
 * リアクション起動」)。bridge が Slack conversations.replies/history で実装する。
 * 見つからない/取得失敗時は null。 */
export type FetchMessage = (
  channelId: string,
  messageId: string,
) => Promise<FetchedMessage | null>;

export interface FetchedMessage {
  text: string;
  /** 対象メッセージが属するスレッドの thread_ts。トップレベル発言なら undefined。 */
  threadTs?: string;
  /** 発言者 (表示名解決は任意)。 */
  userId?: string;
}

export interface SessionRunnerOptions {
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
  /** workdir のルート。既定 /tmp/pi-chat-runner/sessions */
  workdirRoot?: string;
  /** 明示的に差し替える pi バイナリ。テストや埋め込み用途向け */
  piBinary?: string;
  /** 解決済みの pi 本体 entrypoint JS。permission の有無に関わらず使用する */
  piEntrypoint?: string;
  /** allowlist (PATH/HOME) に追加で pi 子プロセスへ渡す env (runtime.md §5.3) */
  extraEnv?: Record<string, string>;
  /** pi 子プロセスの実行 uid/gid (runtime.md §5.1: UID 分離)。両方指定時のみ有効。
   * 有効な場合のみ workdir の chown/chmod を行う (無効時は現状動作を維持) */
  agentUid?: number;
  agentGid?: number;
  /** pi 子プロセスへ常に HOME として渡すディレクトリ (既定 "/home/agent")。
   * UID 分離の有無に関わらず常にこれを HOME にする — コンテナ側で設定・skill を
   * 固定パスに配置できるようにするため、また Node Permission Model の allow パス
   * (`${home}/*`) と実際の HOME をズレなく一致させるため (runtime.md §5.2) */
  agentHome?: string;
  /** Node Permission Model 経由での起動を有効にする設定 (opt-in。未指定なら
   * 現状動作 = pi をそのまま spawn する。pi-tools-and-sandbox.md 「リーズナブルな
   * sandbox レイヤ案」、Cloud Run 実イメージでのみ有効化する想定) */
  piPermission?: PiPermissionConfig;
  /** lease の TTL。既定 60_000ms。renew は ttl/3 間隔 */
  leaseTtlMs?: number;
  /** 長時間ターンの進捗通知の間隔 (ingress-egress.md §8)。初回発火までの猶予も同じ値を使う。
   * 既定 5_000ms。0 を渡すと機能自体を無効化する (負値は指定しない想定) */
  progressNoticeIntervalMs?: number;
  /** agent_end 後に追いメッセージを待つ時間。既定 3_000ms */
  lingerMs?: number;
  /** 1 ターン (prompt/steer 送信から agent_end まで) の上限。既定 600_000ms (10 分)。
   * 超過したら pi を kill してセッションを異常終了として畳む
   * (runtime.md §5.1: 「ターンにタイムアウトを設け、超過したら pi を kill」) */
  turnTimeoutMs?: number;
  /** lease の owner 識別子。既定 `hostname:pid` */
  owner?: string;
  /** ユーザーへの言及をレンダリングする関数 (返信本文に埋め込む記法)。プラットフォーム
   * ごとに記法が異なるため必須 (bridge が利用先プラットフォームの記法を渡す。
   * bridge 以外の利用者は自分で実装を渡す) */
  mentionFormat: MentionFormat;
  logger?: Logger;
  /** classifier gate 用の LLM client。省略時は classifier gate を使う channel で
   * createGate が throw する (config.md §4.1 Layer 2)。 */
  classifierClient?: ClassifierClient;
}

/** debounce 待機中のレーンの状態 (trigger.debounceSec。design 「連投バーストの途中で
 * 不完全な入力のままセッションを起動しないよう、静まるまで kick を遅らせる」)。
 * item は kick 前から inbox に enqueue 済みなので、この状態自体はプロセス死からの
 * 復旧対象ではない (拾い直しは既存の inbox 経路に乗る) */
interface PendingKick {
  timer: NodeJS.Timeout;
  /** hard cap 算出の基準 (最初に滞留させたメッセージの到着時刻) */
  firstPendingAtMs: number;
  debounceSec: number;
  /** タイマー発火時に kick する対象。直近のイベントで都度更新する */
  triggerEvent: InboundMessage;
  doc: ChannelDoc | null;
  channelId: string;
}

/** /new コマンドのマーカー書き込み用 lease TTL (session-model.md §5.1)。実行中との
 * 交錯を避けるためだけの短時間ロックなので、通常の kick 用 leaseTtlMs より短くてよい */
const NEW_COMMAND_LEASE_TTL_MS = 10_000;

export class SessionRunner implements SessionHost {
  private readonly sessions = new Map<string, ActiveSession>();
  /** debounceSec 待機中のレーン (sessionKey → 保留状態)。design 「セッション非稼働
   * レーンで gate 通過 → inbox enqueue した後、即 kick する代わりにレーンごとの
   * タイマーで kick を遅らせる」 */
  private readonly pendingKicks = new Map<string, PendingKick>();
  private readonly configSource: ConfigSource;
  /** 組み込み memory skill の絶対パス。shared 有効時のみ解決する (無効時 undefined) */
  private readonly memorySkillPath: string | undefined;
  private readonly extensionPaths: string[];
  private readonly workdirRoot: string;
  private readonly owner: string;
  private readonly classifierClient: ClassifierClient | undefined;
  /** セッション横断の依存・設定一式 (active-session.js の SessionContext)。
   * options から一度だけ組み立て、ActiveSession の構築のたびに ctx ごと渡す —
   * options.* を毎回 ActiveSessionOptions へ再梱包しない */
  private readonly ctx: SessionContext;

  constructor(options: SessionRunnerOptions) {
    this.configSource = options.configSource;
    // memory skill は書き先が ../shared/ なので shared 前提。有効時は boot で解決して
    // 配置壊れを fail-loud にする (チャンネル別の opt-out は kick 時に doc.memory で判定)
    this.memorySkillPath =
      options.sharedStore !== undefined
        ? resolveBuiltinMemorySkillPath()
        : undefined;
    // 組み込み extension (reply/permission-gate/export) は常時注入で外せない
    // (permission-gate は事故防止層なので無効化オプションを持たない)。利用者の
    // 追加 extension は $AGENT_HOME/.pi/agent/extensions/ 規約で拾う (kick() 参照)
    this.extensionPaths = resolveBuiltinExtensionPaths();
    this.workdirRoot = options.workdirRoot ?? "/tmp/pi-chat-runner/sessions";
    this.owner = options.owner ?? `${hostname()}:${process.pid}`;
    this.classifierClient = options.classifierClient;
    this.ctx = {
      controlState: options.controlState,
      router: options.router,
      reactor: options.reactor,
      workdirStore: options.workdirStore,
      sharedStore: options.sharedStore,
      logger: options.logger ?? rootLogger.child({ component: "session" }),
      lingerMs: options.lingerMs ?? 3_000,
      turnTimeoutMs: options.turnTimeoutMs ?? 600_000,
      leaseTtlMs: options.leaseTtlMs ?? 60_000,
      progressNoticeIntervalMs: options.progressNoticeIntervalMs ?? 5_000,
      mentionFormat: options.mentionFormat,
      piBinary: options.piBinary,
      piEntrypoint: options.piEntrypoint,
      extraEnv: options.extraEnv,
      agentUid: options.agentUid,
      agentGid: options.agentGid,
      agentHome: options.agentHome ?? "/home/agent",
      piPermission: options.piPermission,
    };
  }

  /** 実行中 (起動中含む) のセッション数。テスト・観測用 */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /** SessionHost: ActiveSession の全終了経路からレジストリ (Map) より自分を外す。
   * sessionKey で登録されている ActiveSession が呼び出し元自身のときだけ消す
   * (別レーンを巻き込まない) */
  remove(session: ActiveSession): void {
    const current = this.sessions.get(session.sessionKey);
    if (current === session) this.sessions.delete(session.sessionKey);
  }

  /** SessionHost: windowSec 起点の記録 (threads.markLatestEnded の呼び出し) */
  markEnded(channelId: string, sessionKey: string): Promise<void> {
    return this.markLatestSessionEnded(channelId, sessionKey);
  }

  async handle(event: InboundMessage): Promise<void> {
    const channelId = event.conversation.channelId;
    const isDm = event.conversation.isDm === true;
    // DM は channelId 個別の doc ではなく予約名 "dm" の doc を全 DM 共通で参照する
    // (config.md §3.1, §1.2)。セッション自体は実 channelId (D...) で管理する
    const doc = await this.loadChannelDoc(isDm ? DM_CHANNEL : channelId);
    const policy = resolveSessionPolicy(doc, isDm);
    // affinity で合流したスレッド内の追い発言は合流先レーンの発言として扱う
    // (message-dispatch.md §3.1 Thread → Session の対応)
    const naturalKey = sessionKeyOf(event, policy);
    const sessionKey = await this.resolveBoundSession(naturalKey);
    const item: InboxItem = {
      id: inboxItemId(event),
      event,
      enqueuedAt: new Date(),
    };

    // bot 投稿 (自己エコーは bridge で除外済み) は allowBots opt-in の
    // channel でのみ gate 評価・steer に乗せる (config.md §4.3)
    if (event.sender.isBot && doc?.trigger?.allowBots !== true) {
      this.ctx.logger.debug(
        { channelId, sessionKey },
        "bot message ignored (allowBots not enabled)",
      );
      return;
    }

    // コマンド (session-model.md §5)。gate を通過したメッセージにのみ意味を
    // 持たせる (mention gate のチャンネルでは `@bot /new` 等) ため、gate 評価より
    // 前に判定するのはここまで — 実行中レーンへの /new 拒否、および実行中でも
    // 効く /enable /disable だけは gate をバイパスする。
    // bot にセッションを切らせない (session-model.md §5) ため bot 送信者ではコマンド化しない
    const cmd = event.sender.isBot ? null : parseCommand(event.text);
    if (cmd !== null && this.sessions.has(sessionKey)) {
      if (cmd.kind === "new") {
        // 実行中レーンとの交錯を避けるため、steer には流さず拒否通知を返す (v1 の割り切り)
        const threadKey = registerReplyDestination(
          this.ctx.router,
          event,
          policy,
        );
        await this.deliverCommandNotice(
          sessionKey,
          threadKey,
          REJECT_NOTICE_TEXT,
        );
        this.ctx.logger.info(
          { sessionKey },
          "session rotation rejected: running",
        );
        return;
      }
      // enable/disable は状態書き込みのみでセッションと競合しないため、
      // 実行中でも即座に処理する (session-model.md §5.2)
      await this.handleToggleCommand(sessionKey, channelId, policy, event, cmd);
      return;
    }

    // disabled 中は steer も gate 評価 (classifier の LLM 呼び出し含む) も行わず drop する。
    // /enable /disable だけは復帰経路としてここを素通りさせ、gate (mention) を経て処理する
    // (session-model.md §5.2)。/new も disabled 中は無効
    const isToggleCommand = cmd !== null && cmd.kind !== "new";
    if (!isToggleCommand && (await this.isChannelDisabled(channelId))) {
      this.ctx.logger.info(
        { channelId, sessionKey },
        "message ignored (channel disabled)",
      );
      return;
    }

    // 実行中 (起動中含む) セッションがあるレーン: gate は通さず enqueue して
    // steer で配達 (message-dispatch.md §2, §5。後続発言は追加指示として扱う)
    if (await this.trySteerExisting(sessionKey, item)) return;

    // 実行中でない: gate 評価 → trigger なら enqueue して kick (即 or debounce)
    const when = this.resolveWhen(doc, isDm);
    const decision = await evaluateWhen(when, { event });
    if (!decision.trigger) {
      this.ctx.logger.debug(
        { channelId, sessionKey, reason: decision.reason },
        "gate not triggered",
      );
      return;
    }
    this.ctx.logger.info(
      { channelId, sessionKey, reason: decision.reason },
      "gate triggered",
    );

    if (cmd !== null) {
      if (cmd.kind === "new") {
        await this.handleNewCommand(sessionKey, channelId, policy, event, cmd);
      } else {
        await this.handleToggleCommand(
          sessionKey,
          channelId,
          policy,
          event,
          cmd,
        );
      }
      return;
    }

    await this.kickTriggered(sessionKey, channelId, policy, event, doc, item);
  }

  /** reaction によるリアクション起動 (message-dispatch.md §1「人間によるリアクション
   * 起動」)。reaction event を trigger.when の Gate 木で評価し、trigger したときに
   * のみ対象メッセージ本文を fetch で取得して synthetic InboundMessage に変換し、
   * 既存の message キック経路 (trySteerExisting / kickTriggered) に合流させる。
   * handle (message 専用) 自体は変更しない — 別 event kind のフローとして独立させる */
  async handleReaction(
    event: ReactionEvent,
    fetch: FetchMessage,
  ): Promise<void> {
    const channelId = event.conversation.channelId;
    const isDm = event.conversation.isDm === true;
    const doc = await this.loadChannelDoc(isDm ? DM_CHANNEL : channelId);

    // disabled 中は gate 評価 (classifier の LLM 呼び出し含む) 自体を行わず止める
    // (session-model.md §5.2)
    if (await this.isChannelDisabled(channelId)) {
      this.ctx.logger.info(
        { channelId },
        "reaction trigger skipped (channel disabled)",
      );
      return;
    }

    const when = this.resolveWhen(doc, isDm);
    const decision = await evaluateWhen(when, { event });
    if (!decision.trigger) {
      this.ctx.logger.debug(
        { channelId, reason: decision.reason },
        "reaction gate not triggered",
      );
      return;
    }

    const fetched = await fetch(channelId, event.targetMessageId);
    if (fetched === null) {
      this.ctx.logger.warn(
        { channelId, targetMessageId: event.targetMessageId },
        "reaction target message not found",
      );
      return;
    }

    const synthetic: InboundMessage = {
      kind: "message",
      id: event.targetMessageId,
      conversation: {
        channelId: event.conversation.channelId,
        ...(fetched.threadTs !== undefined
          ? { threadTs: fetched.threadTs }
          : {}),
        ...(event.conversation.isDm ? { isDm: true } : {}),
      },
      sender: event.sender,
      text: fetched.text,
      mentionsBot: false,
      attachments: [],
      timestamp: event.timestamp,
      raw: event.raw,
      metadata: {},
    };

    this.ctx.logger.info(
      { channelId, reason: decision.reason },
      "reaction gate triggered",
    );

    const policy = resolveSessionPolicy(doc, isDm);
    // message 経路と同じ Thread → Session 解決 (合流済みスレッド内のメッセージへの reaction 起動)
    const naturalKey = sessionKeyOf(synthetic, policy);
    const sessionKey = await this.resolveBoundSession(naturalKey);
    const item: InboxItem = {
      id: inboxItemId(synthetic),
      event: synthetic,
      enqueuedAt: new Date(),
    };

    if (await this.trySteerExisting(sessionKey, item)) return;
    await this.kickTriggered(
      sessionKey,
      channelId,
      policy,
      synthetic,
      doc,
      item,
    );
  }

  /** 実行中 (起動中含む) セッションがあるレーンへの enqueue + steer 配達
   * (message-dispatch.md §2, §5。後続発言は追加指示として扱う)。enqueue は「セッションあり」の
   * ときだけ行う — gate 非通過の全メッセージを永続 store に溜め込まない (dedupe は enqueue 時に
   * 効く)。戻り値 true はこのレーンで処理済み (呼び出し元は return してよい) を示す */
  private async trySteerExisting(
    sessionKey: string,
    item: InboxItem,
  ): Promise<boolean> {
    const existing = this.sessions.get(sessionKey);
    if (existing === undefined) return false;

    const fresh = await this.ctx.controlState.inbox.enqueue(sessionKey, item);
    if (!fresh) {
      this.ctx.logger.debug(
        { sessionKey, itemId: item.id },
        "inbox duplicate skip",
      );
      return true;
    }
    // steer 配達もレーンの活動 (message-dispatch.md §3.2 の直近セッションポインタ)
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

  /** /new コマンドの処理 (session-model.md §5.1)。gate を通過済み、かつこのレーンに
   * 実行中セッションが無いことが呼び出し元 (handle) で確定した後にのみ呼ばれる。
   * 短時間の lease を取得してマーカー (rotateRequestedAt) を書くだけで、即座の
   * rotate はしない (WorkdirStore の棚に旧 session.jsonl が残っており、次の
   * restore で復元されて巻き戻るため。次の kick が restore 後に消費する) */
  private async handleNewCommand(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    cmd: Extract<ChatCommand, { kind: "new" }>,
  ): Promise<void> {
    const lease = await this.ctx.controlState.leases.acquire(
      sessionKey,
      this.owner,
      NEW_COMMAND_LEASE_TTL_MS,
    );
    if (lease === null) {
      const threadKey = registerReplyDestination(
        this.ctx.router,
        event,
        policy,
      );
      await this.deliverCommandNotice(
        sessionKey,
        threadKey,
        REJECT_NOTICE_TEXT,
      );
      this.ctx.logger.info(
        { sessionKey },
        "session rotation rejected: lease unavailable",
      );
      return;
    }
    try {
      const existing = await this.ctx.controlState.sessions.get(sessionKey);
      if (existing !== null) {
        // lastActiveAt は据え置き — マーカー書き込みは「活動」ではないので
        // idle 判定を狂わせない (session-model.md §6)
        await this.ctx.controlState.sessions.put(sessionKey, {
          ...existing,
          rotateRequestedAt: new Date(),
        });
      } else {
        const threadTs = event.conversation.threadTs ?? event.id;
        const now = new Date();
        await this.ctx.controlState.sessions.put(sessionKey, {
          channelId,
          threadTs,
          triggerMessageId: event.id,
          startedAt: now,
          lastActiveAt: now,
          endedAt: now,
          rotateRequestedAt: now,
        });
      }
    } finally {
      await this.ctx.controlState.leases.release(lease);
    }
    this.ctx.logger.info({ sessionKey }, "session rotation requested");

    if (cmd.rest !== undefined) {
      const restEvent: InboundMessage = { ...event, text: cmd.rest };
      const restItem: InboxItem = {
        id: inboxItemId(restEvent),
        event: restEvent,
        enqueuedAt: new Date(),
      };
      await this.kickTriggered(
        sessionKey,
        channelId,
        policy,
        restEvent,
        await this.loadChannelDoc(
          event.conversation.isDm === true ? DM_CHANNEL : channelId,
        ),
        restItem,
        // /new は明示的な新規開始なので affinity 合流させない (session-model.md §5.1)
        { skipAffinity: true },
      );
      return;
    }

    const threadKey = registerReplyDestination(this.ctx.router, event, policy);
    await this.deliverCommandNotice(sessionKey, threadKey, ACK_NOTICE_TEXT);
  }

  /** チャンネルが /disable で無効化されているか (session-model.md §5.2)。
   * doc 不在 = enabled (既定)。DM 予約名でなく実 channelId で管理する
   * (メッセージ側は実 channelId で判定するため、ChannelDoc の DM 束ねとは別軸) */
  private async isChannelDisabled(channelId: string): Promise<boolean> {
    return (
      (await this.ctx.controlState.channels.get(channelId))?.enabled === false
    );
  }

  /** /enable /disable コマンドの処理 (session-model.md §5.2)。gate をバイパスして
   * 実行中セッションの有無に関わらず呼ばれる — 状態書き込みのみでセッションの
   * プロセスとは競合しないため、実行中でも即座に反映する。冪等: 既に同じ状態
   * でも同じ ack を返す (分岐しない) */
  private async handleToggleCommand(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    cmd: Extract<ChatCommand, { kind: "enable" | "disable" }>,
  ): Promise<void> {
    const enabled = cmd.kind === "enable";
    await this.ctx.controlState.channels.put(channelId, {
      enabled,
      updatedAt: new Date(),
      updatedBy: event.sender.id,
    });
    this.ctx.logger.info(
      { channelId, updatedBy: event.sender.id },
      enabled ? "channel enabled via command" : "channel disabled via command",
    );

    const threadKey = registerReplyDestination(this.ctx.router, event, policy);
    await this.deliverCommandNotice(
      sessionKey,
      threadKey,
      enabled ? ENABLE_NOTICE_TEXT : DISABLE_NOTICE_TEXT,
    );
  }

  /** コマンド (/new の拒否・ack、/enable /disable の ack) 通知の配達。thread_key は
   * registerReplyDestination が返したメッセージごとの宛先キー。abnormalShutdown と
   * 違い progress キー (sessionKey) は渡さない — 実行中セッションへの通知がそのセッションの
   * 進捗メッセージを上書き消費してしまうため (セッションは継続中で、進捗
   * タイマーも生きている)。配達失敗はログのみで進行を止めない */
  private async deliverCommandNotice(
    sessionKey: string,
    threadKey: string,
    text: string,
  ): Promise<void> {
    await this.ctx.router
      .deliver({ thread_key: threadKey, text })
      .catch((err) => {
        this.ctx.logger.warn(
          { sessionKey, err },
          "command notice delivery failed",
        );
      });
  }

  /** gate 通過が確定した後の affinity 合流解決 → enqueue → 多重起動チェック →
   * debounce or 即 kick (handle / handleReaction の共通経路)。item はここで永続
   * store へ積む (dedupe = at-least-once の再送吸収)。この後 debounce タイマーで
   * kick を遅らせても、item は既に永続化済みなのでプロセス死で消えない (拾い直しは
   * 既存の inbox 経路に乗る)。skipAffinity は /new の明示新規 (合流の逃げ道、
   * session-model.md §5.1) 用 */
  private async kickTriggered(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    doc: ChannelDoc | null,
    item: InboxItem,
    options?: { skipAffinity?: boolean },
  ): Promise<void> {
    // affinity 合流 (message-dispatch.md §3.2「セッション合流」): チャンネル直下投稿を
    // 直近レーンへ差し替える。以降は既存の配達経路 (steer / debounce / kick=resume)
    // がそのまま働く
    if (options?.skipAffinity !== true) {
      const target = await this.resolveAffinityTarget(
        sessionKey,
        channelId,
        event,
        doc,
      );
      if (target !== sessionKey) {
        // このイベントのスレッドを合流先 Session に束ね、以降のスレッド内の追い
        // 発言も合流先へ届くようにする (message-dispatch.md §3.1)。Control State に
        // 記録するので Runner の実行インスタンスが入れ替わっても対応は保たれる
        await this.bindThread(sessionKey, target);
        this.ctx.logger.info(
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
      this.ctx.logger.debug(
        { sessionKey, itemId: item.id },
        "inbox duplicate skip",
      );
      return;
    }
    // レーンの発生 (debounce 待機開始 / kick) を直近セッションポインタに記録
    await this.touchLatestSession(channelId, sessionKey);

    // 多重起動防止: gate 評価の await 中に別イベントが kick 済みなら、
    // 上で enqueue した item はそのセッションの drain が拾う
    if (this.sessions.has(sessionKey)) return;

    const debounceSec = doc?.session?.affinity?.debounceSec;
    if (debounceSec !== undefined && event.mentionsBot !== true) {
      this.scheduleDebouncedKick(
        sessionKey,
        channelId,
        policy,
        event,
        doc,
        debounceSec,
      );
      return;
    }

    // mentionsBot による即 kick バイパス: 同レーンの保留タイマーがあれば
    // キャンセルする (item は inbox にあるので初回 prompt の drain がまとめて拾う)
    this.clearPendingKick(sessionKey);
    await this.acquireLeaseAndKick(sessionKey, channelId, policy, event, doc);
  }

  /** debounceSec のスライディングタイマーを (再)セットする。既存タイマーがあれば
   * firstPendingAtMs を維持したまま張り直し、無ければ新規に開始する
   * (design: 「後続メッセージが来るたび『最後のメッセージ + debounceSec』に延長。
   * ただし hard cap を超えては延ばさない」) */
  private scheduleDebouncedKick(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    doc: ChannelDoc | null,
    debounceSec: number,
  ): void {
    const existing = this.pendingKicks.get(sessionKey);
    const nowMs = Date.now();
    const firstPendingAtMs = existing?.firstPendingAtMs ?? nowMs;
    if (existing !== undefined) clearTimeout(existing.timer);

    const delayMs = computeKickDelayMs({
      nowMs,
      firstPendingAtMs,
      debounceSec,
    });
    const timer = setTimeout(() => {
      this.pendingKicks.delete(sessionKey);
      void this.fireDebouncedKick(
        sessionKey,
        channelId,
        policy,
        event,
        doc,
      ).catch((err) => {
        this.ctx.logger.warn({ sessionKey, err }, "debounced kick failed");
      });
    }, delayMs);
    timer.unref();
    this.pendingKicks.set(sessionKey, {
      timer,
      firstPendingAtMs,
      debounceSec,
      triggerEvent: event,
      doc,
      channelId,
    });
    this.ctx.logger.debug(
      { sessionKey, delayMs, firstPendingAtMs },
      "kick debounced",
    );
  }

  /** debounce タイマー発火時の kick 試行。発火までの間に別経路 (mentionsBot バイパス
   * 等) で既にセッションが起動していたら何もしない — item は既存の drain が拾う */
  private async fireDebouncedKick(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    doc: ChannelDoc | null,
  ): Promise<void> {
    if (this.sessions.has(sessionKey)) return;
    // debounce 待機中に /disable された場合、タイマー発火時点で再チェックする
    // (session-model.md §5.2)
    if (await this.isChannelDisabled(channelId)) {
      this.ctx.logger.info(
        { channelId, sessionKey },
        "debounced kick skipped (channel disabled)",
      );
      return;
    }
    await this.acquireLeaseAndKick(sessionKey, channelId, policy, event, doc);
  }

  /** 保留中の debounce タイマーがあればキャンセルして Map から消す (mentionsBot の
   * 即 kick バイパス、または debounce 前提が崩れた場合の後始末) */
  private clearPendingKick(sessionKey: string): void {
    const pending = this.pendingKicks.get(sessionKey);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingKicks.delete(sessionKey);
  }

  /** affinity 合流先の解決 (message-dispatch.md §3.2「セッション合流」)。scope=channel の
   * とき、gate 通過したチャンネル直下投稿をチャンネルの直近セッションレーンへ差し替える。
   * 合流しない場合は naturalKey をそのまま返す。判定は時間窓ルールのみ (classifier に
   * 委ねない) */
  private async resolveAffinityTarget(
    naturalKey: string,
    channelId: string,
    event: InboundMessage,
    doc: ChannelDoc | null,
  ): Promise<string> {
    const affinity = doc?.session?.affinity;
    if (affinity?.scope !== "channel") return naturalKey;
    // スレッド内の発言はそのスレッドのセッションに属する (message-dispatch.md §3.1
    // Thread → Session の対応)。合流対象はチャンネル直下投稿のみ
    if (event.conversation.threadTs !== undefined) return naturalKey;

    const latest = await this.ctx.controlState.threads.latest(channelId);
    if (latest === null || latest.sessionKey === naturalKey) {
      return naturalKey;
    }

    // 生きているレーン (debounce 待機 / starting / running / lingering) へは
    // 窓に関わらず合流する
    if (
      this.sessions.has(latest.sessionKey) ||
      this.pendingKicks.has(latest.sessionKey)
    ) {
      return latest.sessionKey;
    }

    // 終了済みレーンは windowSec 以内なら resume 合流。endedAt が無い
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
      this.ctx.logger.warn(
        { naturalKey, err },
        "thread binding resolve failed",
      );
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
      this.ctx.logger.warn(
        { threadKey, sessionKey, err },
        "thread binding failed",
      );
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
      this.ctx.logger.warn(
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
      this.ctx.logger.warn(
        { channelId, sessionKey, err },
        "latest session end mark failed",
      );
    }
  }

  /** 実行ロックを取って kick する (即時 kick と debounce タイマー発火の両方から共有)。
   * lease が取れない・二重 kick になりそうなケースはログのみで戻る — item は
   * enqueue 済みなので保持者側の drain (steer / agent_end / linger) が拾う */
  private async acquireLeaseAndKick(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    doc: ChannelDoc | null,
  ): Promise<void> {
    // 実行ロック。取れなければ別プロセスが保持中 — enqueue 済みなので
    // 保持者側の drain (steer / agent_end / linger) が拾う
    const lease = await this.ctx.controlState.leases.acquire(
      sessionKey,
      this.owner,
      this.ctx.leaseTtlMs,
    );
    if (lease === null) {
      this.ctx.logger.info(
        { sessionKey, itemId: inboxItemId(event) },
        "lease held by another process; enqueued only",
      );
      return;
    }
    if (this.sessions.has(sessionKey)) {
      // acquire の await 中にローカルの別イベントが kick した (そちらが lease を
      // 取れているはずなので通常到達しないが、二重 kick だけは防ぐ)
      await this.ctx.controlState.leases.release(lease);
      return;
    }

    // レーン根の threadTs は event ではなく sessionKey から導出する (thread モードの
    // key は `${channelId}:${threadTs}`)。affinity 合流の resume では event のスレッド
    // 位置とレーンが一致しないが、workdir/transcript は常にレーン基準 (state.md §6)
    const threadTs =
      policy.sessionMode === "channel"
        ? (event.conversation.threadTs ?? event.id)
        : sessionKey.slice(channelId.length + 1);
    const workdir = join(
      this.workdirRoot,
      channelId,
      policy.sessionMode === "channel" ? "channel" : threadTs,
    );
    const session = new ActiveSession({
      sessionKey,
      channelId,
      threadTs,
      triggerMessageId: event.id,
      workdir,
      policy,
      lease,
      host: this,
      sharedStagingDir:
        this.ctx.sharedStore !== undefined
          ? this.sharedStagingDir(channelId)
          : undefined,
      ctx: this.ctx,
    });
    this.sessions.set(sessionKey, session);

    try {
      // kick シーケンス前半 (runtime.md §1, §2: restore → spawn 準備)。
      // PiProcess 生成以降 (spawn → prompt) は ActiveSession.start が担う
      warnPolicyMismatches(this.ctx.logger, sessionKey, channelId, policy, doc);

      // workdir/shared の mkdir + restore、transcript 世代交代、UID 分離、
      // agentHome 作成、realpath 正規化 (runtime.md §2, §5.1)
      const {
        workdirReal,
        agentHomeReal,
        sharedDirReal,
        sessionPath,
        resumed,
        rotateConsumed,
      } = await prepareWorkdir({
        sessionKey,
        channelId,
        workdir,
        policy,
        doc,
        sessions: this.ctx.controlState.sessions,
        workdirStore: this.ctx.workdirStore,
        sharedStore: this.ctx.sharedStore,
        sharedStagingDir: (id) => this.sharedStagingDir(id),
        agentUid: this.ctx.agentUid,
        agentGid: this.ctx.agentGid,
        agentHome: this.ctx.agentHome,
        logger: this.ctx.logger,
      });

      // extension/skill パス解決 + Node Permission Model オプション組み立て
      // (runtime.md §4, §5.2)
      const { extensionPaths, skillPaths, memoryEnabled, permission } =
        await buildSpawnOptions({
          agentHomeReal,
          workdirReal,
          sharedDirReal,
          doc,
          builtinExtensionPaths: this.extensionPaths,
          memorySkillPath: this.memorySkillPath,
          piPermission: this.ctx.piPermission,
        });

      const model = doc?.model;
      // 常に HOME を agentHome に上書きする (Runner 自身の HOME は継承しない)。
      // extraEnv で HOME を上書きする (buildPiEnv は extraEnv が PATH/HOME を
      // 上書きできる実装になっている)
      const extraEnv = { ...this.ctx.extraEnv, HOME: agentHomeReal };
      // memory の索引 (MEMORY.md) は skill 発火 (agent の自発的な read) に頼らず
      // system prompt に常時注入する (docs/design/runtime.md §6)。1 行 1 メモリの
      // 短い索引という規約 (SKILL.md の Save 手順) が前提で、肥大化はしない想定。
      // 本文ファイルは引き続き skill 経由でオンデマンドに read させる
      const memoryIndex = await loadMemoryIndex(memoryEnabled, sharedDirReal);

      await session.start({
        triggerEvent: event,
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
      });

      // /new マーカーの消費 (session-model.md §5.1: 「マーカーは次の Session 起動時、
      // Workdir の復元後に消費される」)。Control State を書くのは Dispatcher の責務
      // なので、Runtime 準備 (prepareWorkdir) が返した判定をここで確定させる。
      // start() 後に置くのは、start が SessionRecord を put し直すため — 先に
      // クリアすると start の put で書き戻される
      if (rotateConsumed) await this.clearRotateMarker(sessionKey);
    } catch (err) {
      // enqueue 済み item は ack されていないので、同レーンの次のイベント
      // (または再送) で再 kick され拾い直される (message-dispatch.md §7.4)。
      // timer/process の後始末と progress クリアは session.abort に閉じ、
      // lease release / markEnded / warn ログはここで現行と同じ順序で続ける
      await session.abort();
      await this.ctx.controlState.leases.release(lease);
      await this.markLatestSessionEnded(channelId, sessionKey);
      this.ctx.logger.warn({ sessionKey, err }, "session kick failed");
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
      this.ctx.logger.warn({ sessionKey, err }, "rotate marker clear failed");
    }
  }

  /** チャンネル共有ディレクトリの staging パス (docs/design/state.md §6)。
   * workdir の隣に置く — agent からは session.mode に関わらず cwd 相対 ../shared/
   * (`<channelId>/<threadTs>/` と `<channelId>/channel/` のどちらとも隣接する) */
  private sharedStagingDir(channelId: string): string {
    return join(this.workdirRoot, channelId, "shared");
  }

  private async loadChannelDoc(channelId: string): Promise<ChannelDoc | null> {
    try {
      return await this.configSource.channel(channelId);
    } catch (err) {
      // YAML の壊れで受信ループを止めない。既定動作 (mention 起動 / DM は disabled) に落とす
      this.ctx.logger.warn({ channelId, err }, "failed to load channel doc");
      return null;
    }
  }

  private resolveWhen(doc: ChannelDoc | null, isDm: boolean): EvaluableNode[] {
    const deps: GateDeps = {
      ...(this.classifierClient !== undefined
        ? { classifierClient: this.classifierClient }
        : {}),
      logger: this.ctx.logger,
    };
    if (doc?.trigger === undefined) {
      // doc なし / trigger 未設定は既定 = mention のみ、DM は disabled (起動しない)
      // (config.md §4.1, §3.1)
      return buildWhen(defaultWhen(isDm), deps);
    }
    return buildWhen(doc.trigger.when, deps);
  }
}
