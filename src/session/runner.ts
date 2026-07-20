// SessionRunner — event を受けて session を主語に処理するオーケストレーション (Step 4)
//
// docs/design/architecture.md §1 (event は「きっかけ係」、session が「処理の担い手」)、
// §6 (起動と steering のフロー)、docs/design/session-runtime.md §1 (kick シーケンス)、
// §3 (tmpfs + 境界 flush)、docs/design/persistence.md §1 (Store 群)、§3 (flush → ack の順序)。
//
// Step 4 のスコープ: lease による多重起動の排他、drain/ack 分離 (drain は非破壊。
// プロンプト済み item の記憶と重複除外は runner のインメモリ責務)、agent_end 後の
// linger による追いメッセージ拾い直し、WorkdirStorage による境界退避 (未指定なら
// Step 3 相当のローカル置きっぱなし)。turn timeout (Step 6) もここで実装する
// (session-runtime.md §6「ターンにタイムアウトを設け、超過したら pi を kill」)。

import { lstat, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ClassifierClient } from "../classifier/client.js";
import type { ChannelDoc } from "../config/channel-doc.js";
import { type ConfigSource, DM_CHANNEL } from "../config/config-source.js";
import type { Reactions } from "../egress/reactions.js";
import type { EgressRouter } from "../egress/router.js";
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
import { inboxItemId } from "../store/state/inbox-item.js";
import type {
  InboxItem,
  Lease,
  StateStore,
} from "../store/state/interfaces.js";
import type { SharedStorage, WorkdirStorage } from "../store/workdir.js";
import { type ChatCommand, parseCommand } from "./commands.js";
import {
  extractReply,
  extractTurnErrors,
  extractUsageTotals,
  piEventLogFields,
  type UsageTotals,
} from "./pi-events.js";
import {
  computeKickDelayMs,
  renderEvent,
  renderItems,
  replyThreadKeyOf,
  resolveSessionPolicy,
  type SessionPolicy,
  sessionKeyOf,
} from "./policy.js";
import { progressEmoji, toolArgsPreview } from "./progress.js";
import {
  ACK_NOTICE_TEXT,
  buildSystemPrompt,
  DISABLE_NOTICE_TEXT,
  ENABLE_NOTICE_TEXT,
  type MentionFormat,
  prependContext,
  REJECT_NOTICE_TEXT,
} from "./prompt.js";
import { isAgentEnd, isToolExecutionEnd, isToolExecutionStart } from "./rpc.js";
import { PiProcess } from "./runtime.js";
import {
  buildSpawnOptions,
  loadMemoryIndex,
  prepareWorkdir,
  resolveBuiltinExtensionPaths,
  resolveBuiltinMemorySkillPath,
  warnPolicyMismatches,
} from "./spawn.js";

/** reaction の対象メッセージ本文を取得する port (session-model.md §5「人間による
 * リアクション起動」)。bridge が Slack conversations.replies/history で実装する。
 * 見つからない/取得失敗時は null。 */
export type FetchMessage = (
  channelId: string,
  ts: string,
) => Promise<FetchedMessage | null>;

export interface FetchedMessage {
  text: string;
  /** 対象メッセージが属するスレッドの thread_ts。トップレベル発言なら undefined。 */
  threadTs?: string;
  /** 発言者 (表示名解決は任意)。 */
  userId?: string;
}

/** Node Permission Model 有効化の静的パラメタ (session-runtime.md §6)。
 * workdir / home はセッションごとに決まるため kick 時に buildPiPermissionOptions
 * へ都度渡す — ここに載るのはイメージ内で固定のパスだけ */
export interface PiPermissionConfig {
  /** pi 本体のエントリポイント JS の絶対パス (import.meta.resolve で自動検出する。
   * server.ts 参照) */
  entrypoint: string;
  /** pi 本体・依存が入る npm パッケージの node_modules ルート (import.meta.resolve で
   * 自動検出する。server.ts 参照) */
  nodeModulesDir: string;
  /** 追加で write を許可したいパス (例 "/tmp/*")。既定なし */
  extraWrite?: string[];
  /** 追加で read を許可したいパス (例 GOOGLE_APPLICATION_CREDENTIALS のファイル
   * パス)。HOME を agentHome に固定するとローカルのユーザー ADC は HOME 経由で
   * 見えなくなるため、明示指定されたファイルだけ個別に許可する用途。既定なし。
   * extension (reply / permission-gate) の読み込みに必要な read 許可は kick 時に
   * extensionPaths の dirname から自動導出してここへ足すため、呼び出し側が
   * 明示する必要はない (appDir 包括許可の廃止に伴う対応) */
  extraRead?: string[];
  /** native addon (.node) を含む extension を使う場合の `--allow-addons` 付与。
   * agent.runtime.allowAddons 由来 (config.md §6)。既定 false */
  allowAddons?: boolean;
}

export interface SessionRunnerOptions {
  configSource: ConfigSource;
  /** 永続化 Store 群 (inbox / sessions / leases)。persistence.md §1 */
  store: StateStore;
  router: EgressRouter;
  reactions: Reactions;
  /** workdir の境界退避。 */
  workdirStorage: WorkdirStorage;
  /** チャンネル単位の共有ディレクトリの境界退避 (docs/design/shared.md)。
   * 未指定なら shared 機能ごと無効 — staging の作成・skill 配線・system prompt
   * への言及をすべて行わない (createSharedStorage が設定から解決する) */
  sharedStorage?: SharedStorage;
  /** workdir のルート。既定 /tmp/pi-chat-runner/sessions */
  workdirRoot?: string;
  /** 明示的に差し替える pi バイナリ。テストや埋め込み用途向け */
  piBinary?: string;
  /** 解決済みの pi 本体 entrypoint JS。permission の有無に関わらず使用する */
  piEntrypoint?: string;
  /** allowlist (PATH/HOME) に追加で pi 子プロセスへ渡す env (session-runtime.md §2) */
  extraEnv?: Record<string, string>;
  /** pi 子プロセスの実行 uid/gid (session-runtime.md §6: UID 分離)。両方指定時のみ有効。
   * 有効な場合のみ workdir の chown/chmod を行う (無効時は現状動作を維持) */
  agentUid?: number;
  agentGid?: number;
  /** pi 子プロセスへ常に HOME として渡すディレクトリ (既定 "/home/agent")。
   * UID 分離の有無に関わらず常にこれを HOME にする — コンテナ側で設定・skill を
   * 固定パスに配置できるようにするため、また Node Permission Model の allow パス
   * (`${home}/*`) と実際の HOME をズレなく一致させるため (session-runtime.md §6) */
  agentHome?: string;
  /** Node Permission Model 経由での起動を有効にする設定 (opt-in。未指定なら
   * 現状動作 = pi をそのまま spawn する。pi-tools-and-sandbox.md 「リーズナブルな
   * sandbox レイヤ案」、Cloud Run 実イメージでのみ有効化する想定) */
  piPermission?: PiPermissionConfig;
  /** lease の TTL。既定 60_000ms。renew は ttl/3 間隔 */
  leaseTtlMs?: number;
  /** 長時間ターンの進捗通知の間隔 (progress-notice.md)。初回発火までの猶予も同じ値を使う。
   * 既定 5_000ms。0 を渡すと機能自体を無効化する (負値は指定しない想定) */
  progressNoticeIntervalMs?: number;
  /** agent_end 後に追いメッセージを待つ時間。既定 3_000ms */
  lingerMs?: number;
  /** 1 ターン (prompt/steer 送信から agent_end まで) の上限。既定 600_000ms (10 分)。
   * 超過したら pi を kill してセッションを異常終了として畳む
   * (session-runtime.md §6: 「ターンにタイムアウトを設け、超過したら pi を kill」) */
  turnTimeoutMs?: number;
  /** lease の owner 識別子。既定 `hostname:pid` */
  owner?: string;
  /** ユーザーへの言及をレンダリングする関数 (返信本文に埋め込む記法)。プラットフォーム
   * ごとに記法が異なるため必須 (bridge が利用先プラットフォームの記法を渡す。
   * bridge 以外の利用者は自分で実装を渡す) */
  mentionFormat: MentionFormat;
  logger?: Logger;
  /** classifier gate 用の LLM client。省略時は classifier gate を使う channel で
   * createGate が throw する (session-model.md §5 Layer 2)。 */
  classifierClient?: ClassifierClient;
}

interface SessionRecord {
  /** starting = spawn 準備中 (多重起動防止のため Map 登録済み)、
   * running = PiProcess がターンを実行中、lingering = agent_end 後の終了判定中
   * (アイドルな pi。promptPending が prompt を送ると running に戻る)、
   * stopping = 終了処理中 (exit を異常扱いしない) */
  state: "starting" | "running" | "lingering" | "stopping";
  process?: PiProcess;
  /** トリガーメッセージの ts (👀 / ✅ の対象) */
  triggerTs: string;
  channelId: string;
  threadTs: string;
  workdir: string;
  /** kick 時に導出した session.mode / reply.mode。promptPending / kick から
   * 参照して宛先登録・フォールバック登録に使う (session-model.md §3) */
  policy: SessionPolicy;
  /** kick 開始時刻 (finished ログの durationMs 算出用) */
  startedAt: number;
  /** このプロセスが保持する実行ロック。renew に失敗したら排他を失っている */
  lease: Lease;
  /** このセッションで prompt/steer 済みの item id。drain は非破壊 (未 ack 全件を
   * 返す) なので、重複除外はこのインメモリ記憶で行う (persistence.md §1) */
  promptedIds: Set<string>;
  /** prompt/steer を送るたびに増える世代。agent_end 処理中に増えていたら
   * 新しいターンが走り出しているので、終了判定をそのターンの agent_end に譲る */
  turnEpoch: number;
  renewTimer: NodeJS.Timeout | undefined;
  /** 現ターンの timeout タイマー。prompt/steer 送信 (turnEpoch 増加箇所) ごとに
   * リセットし、agent_end 冒頭でクリアする。セッション終了パスでも必ずクリアする
   * (session-runtime.md §6 の turn timeout) */
  turnTimeoutTimer: NodeJS.Timeout | undefined;
  /** 進捗通知タイマー (progress-notice.md)。prompt/steer 送信ごとにリセットし、
   * agent_end 冒頭でクリアする (turnTimeoutTimer と同じ寿命管理) */
  progressNoticeTimer: NodeJS.Timeout | undefined;
  /** 直近に開始した、または直近に完了したツール呼び出し。tool_execution_start/end の
   * 購読だけで更新する (LLM 呼び出し・session.jsonl を経由しない、progress-notice.md)。
   * emoji は tool_execution_start 時点で確定させる (bash は候補からランダムに選ぶため、
   * タイマー発火のたびに選び直すと同じ呼び出し中に表示が変わってしまう)。reply は
   * 進捗表示の対象外なのでここには反映されない (progress-notice.md) */
  currentTool: { name: string; emoji: string; argsPreview: string } | undefined;
  /** このセッションでの tool_execution_start 累計回数 (progress-notice.md の
   * 進捗表示用。ターンをまたいで積算する)。reply は対象外なので含めない */
  toolCallCount: number;
  /** 直前に進捗通知として送信したテキスト (progress-notice.md)。同じ内容なら
   * tick をスキップし、Slack API を呼ばない (状況が進んでいないのに更新し続けない) */
  lastProgressNoticeText: string | undefined;
  /** 直近の agent_end から集計した usage の累計 (agent_end.messages は毎回全履歴
   * を返すため、ターンごとの増分ではなくセッション累計になる) */
  usageTotals?: UsageTotals;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** /new コマンドのマーカー書き込み用 lease TTL (session-model.md §6)。実行中との
 * 交錯を避けるためだけの短時間ロックなので、通常の kick 用 leaseTtlMs より短くてよい */
const NEW_COMMAND_LEASE_TTL_MS = 10_000;

export class SessionRunner {
  private readonly sessions = new Map<string, SessionRecord>();
  /** debounceSec 待機中のレーン (sessionKey → 保留状態)。design 「セッション非稼働
   * レーンで gate 通過 → inbox enqueue した後、即 kick する代わりにレーンごとの
   * タイマーで kick を遅らせる」 */
  private readonly pendingKicks = new Map<string, PendingKick>();
  /** affinity 合流したイベントのスレッド → 合流先レーンの別名 (session-model.md §3
   * 「セッション合流」)。合流先セッションが返信したスレッド内の追い発言を、自
   * スレッド followUp と同じ規則 (稼働中は gate なしで steer、終了後は resume) で
   * 合流先レーンへ届けるための in-memory マップ。プロセス再起動で消える (その後の
   * スレッド返信は通常の新規判定に落ちる) — 永続化は §6 の chat_ref 逆引き実装時 */
  private readonly threadAlias = new Map<string, string>();
  private readonly configSource: ConfigSource;
  private readonly store: StateStore;
  private readonly router: EgressRouter;
  private readonly reactions: Reactions;
  private readonly workdirStorage: WorkdirStorage;
  private readonly sharedStorage: SharedStorage | undefined;
  /** 組み込み memory skill の絶対パス。shared 有効時のみ解決する (無効時 undefined) */
  private readonly memorySkillPath: string | undefined;
  private readonly extensionPaths: string[];
  private readonly workdirRoot: string;
  private readonly piBinary: string | undefined;
  private readonly piEntrypoint: string | undefined;
  private readonly extraEnv: Record<string, string> | undefined;
  private readonly agentUid: number | undefined;
  private readonly agentGid: number | undefined;
  private readonly agentHome: string;
  private readonly piPermission: PiPermissionConfig | undefined;
  private readonly leaseTtlMs: number;
  private readonly progressNoticeIntervalMs: number;
  private readonly lingerMs: number;
  private readonly turnTimeoutMs: number;
  private readonly owner: string;
  private readonly mentionFormat: MentionFormat;
  private readonly logger: Logger;
  private readonly classifierClient: ClassifierClient | undefined;

  constructor(options: SessionRunnerOptions) {
    this.configSource = options.configSource;
    this.store = options.store;
    this.router = options.router;
    this.reactions = options.reactions;
    this.workdirStorage = options.workdirStorage;
    this.sharedStorage = options.sharedStorage;
    // memory skill は書き先が ../shared/ なので shared 前提。有効時は boot で解決して
    // 配置壊れを fail-loud にする (チャンネル別の opt-out は kick 時に doc.memory で判定)
    this.memorySkillPath =
      options.sharedStorage !== undefined
        ? resolveBuiltinMemorySkillPath()
        : undefined;
    // 組み込み extension (reply/permission-gate/export) は常時注入で外せない
    // (permission-gate は事故防止層なので無効化オプションを持たない)。利用者の
    // 追加 extension は $AGENT_HOME/.pi/agent/extensions/ 規約で拾う (kick() 参照)
    this.extensionPaths = resolveBuiltinExtensionPaths();
    this.workdirRoot = options.workdirRoot ?? "/tmp/pi-chat-runner/sessions";
    this.piBinary = options.piBinary;
    this.piEntrypoint = options.piEntrypoint;
    this.extraEnv = options.extraEnv;
    this.agentUid = options.agentUid;
    this.agentGid = options.agentGid;
    this.agentHome = options.agentHome ?? "/home/agent";
    this.piPermission = options.piPermission;
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.progressNoticeIntervalMs = options.progressNoticeIntervalMs ?? 5_000;
    this.lingerMs = options.lingerMs ?? 3_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 600_000;
    this.owner = options.owner ?? `${hostname()}:${process.pid}`;
    this.mentionFormat = options.mentionFormat;
    this.logger = options.logger ?? rootLogger.child({ component: "session" });
    this.classifierClient = options.classifierClient;
  }

  /** 実行中 (起動中含む) のセッション数。テスト・観測用 */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  async handle(event: InboundMessage): Promise<void> {
    const channelId = event.conversation.channelId;
    const isDm = event.conversation.isDm === true;
    // DM は channelId 個別の doc ではなく予約名 "dm" の doc を全 DM 共通で参照する
    // (config.md §1, §2)。セッション自体は実 channelId (D...) で管理する
    const doc = await this.loadChannelDoc(isDm ? DM_CHANNEL : channelId);
    const policy = resolveSessionPolicy(doc, isDm);
    // affinity で合流したスレッド内の追い発言は合流先レーンの発言として扱う
    // (session-model.md §3「セッション合流」の別名解決)
    const naturalKey = sessionKeyOf(event, policy);
    const sessionKey = this.threadAlias.get(naturalKey) ?? naturalKey;
    const item: InboxItem = {
      id: inboxItemId(event),
      event,
      enqueuedAt: new Date(),
    };

    // bot 投稿 (自己エコーは bridge で除外済み) は allowBots opt-in の
    // channel でのみ gate 評価・steer に乗せる (session-model.md §5)
    if (event.sender.isBot && doc?.trigger?.allowBots !== true) {
      this.logger.debug(
        { channelId, sessionKey },
        "bot message ignored (allowBots not enabled)",
      );
      return;
    }

    // コマンド (session-model.md §6, §5)。gate を通過したメッセージにのみ意味を
    // 持たせる (mention gate のチャンネルでは `@bot /new` 等) ため、gate 評価より
    // 前に判定するのはここまで — 実行中レーンへの /new 拒否、および実行中でも
    // 効く /enable /disable だけは gate をバイパスする。
    // bot にセッションを切らせない (session-model.md §5) ため bot 送信者ではコマンド化しない
    const cmd = event.sender.isBot ? null : parseCommand(event.text);
    if (cmd !== null && this.sessions.has(sessionKey)) {
      if (cmd.kind === "new") {
        // 実行中レーンとの交錯を避けるため、steer には流さず拒否通知を返す (v1 の割り切り)
        const threadKey = this.registerReplyDestination(event, policy);
        await this.deliverCommandNotice(
          sessionKey,
          threadKey,
          REJECT_NOTICE_TEXT,
        );
        this.logger.info({ sessionKey }, "session rotation rejected: running");
        return;
      }
      // enable/disable は状態書き込みのみでセッションと競合しないため、
      // 実行中でも即座に処理する (session-model.md §5)
      await this.handleToggleCommand(sessionKey, channelId, policy, event, cmd);
      return;
    }

    // disabled 中は steer も gate 評価 (classifier の LLM 呼び出し含む) も行わず drop する。
    // /enable /disable だけは復帰経路としてここを素通りさせ、gate (mention) を経て処理する
    // (session-model.md §5)。/new も disabled 中は無効
    const isToggleCommand = cmd !== null && cmd.kind !== "new";
    if (!isToggleCommand && (await this.isChannelDisabled(channelId))) {
      this.logger.info(
        { channelId, sessionKey },
        "message ignored (channel disabled)",
      );
      return;
    }

    // 実行中 (起動中含む) セッションがあるレーン: gate は通さず enqueue して
    // steer で配達 (architecture.md §6 フロー 6。後続発言は追加指示として扱う)
    if (await this.trySteerExisting(sessionKey, item)) return;

    // 実行中でない: gate 評価 → trigger なら enqueue して kick (即 or debounce)
    const when = this.resolveWhen(doc, isDm);
    const decision = await evaluateWhen(when, { event });
    if (!decision.trigger) {
      this.logger.debug(
        { channelId, sessionKey, reason: decision.reason },
        "gate not triggered",
      );
      return;
    }
    this.logger.info(
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

  /** reaction によるリアクション起動 (session-model.md §5「人間によるリアクション
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
    // (session-model.md §5)
    if (await this.isChannelDisabled(channelId)) {
      this.logger.info(
        { channelId },
        "reaction trigger skipped (channel disabled)",
      );
      return;
    }

    const when = this.resolveWhen(doc, isDm);
    const decision = await evaluateWhen(when, { event });
    if (!decision.trigger) {
      this.logger.debug(
        { channelId, reason: decision.reason },
        "reaction gate not triggered",
      );
      return;
    }

    const fetched = await fetch(channelId, event.targetMessageId);
    if (fetched === null) {
      this.logger.warn(
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

    this.logger.info(
      { channelId, reason: decision.reason },
      "reaction gate triggered",
    );

    const policy = resolveSessionPolicy(doc, isDm);
    // message 経路と同じ別名解決 (合流済みスレッド内のメッセージへの reaction 起動)
    const naturalKey = sessionKeyOf(synthetic, policy);
    const sessionKey = this.threadAlias.get(naturalKey) ?? naturalKey;
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

  /** 実行中 (起動中含む) セッションがあるレーンへの enqueue + steer 配達 (architecture.md
   * §6 フロー 6。後続発言は追加指示として扱う)。enqueue は「セッションあり」のときだけ
   * 行う — gate 非通過の全メッセージを永続 store に溜め込まない (dedupe は enqueue 時に
   * 効く)。戻り値 true はこのレーンで処理済み (呼び出し元は return してよい) を示す */
  private async trySteerExisting(
    sessionKey: string,
    item: InboxItem,
  ): Promise<boolean> {
    const existing = this.sessions.get(sessionKey);
    if (existing === undefined) return false;

    const fresh = await this.store.inbox.enqueue(sessionKey, item);
    if (!fresh) {
      this.logger.debug(
        { sessionKey, itemId: item.id },
        "inbox duplicate skip",
      );
      return true;
    }
    // steer 配達もレーンの活動 (session-model.md §3 の直近セッションポインタ)
    await this.touchSessionPointer(
      item.event.conversation.channelId,
      sessionKey,
    );
    // starting 中は初回 prompt の drain が拾う。running なら steer で即配達する。
    // lingering (agent_end 後の終了判定中) は enqueue のみ — onAgentEnd の
    // promptPending が prompt で新ターンとして拾う。アイドルな pi への steer は
    // ターンを開始しないため (キューに積まれるだけで宙吊りになる)
    if (existing.state === "running" && existing.process?.running) {
      const items = await this.store.inbox.drain(sessionKey);
      const pending = items.filter((i) => !existing.promptedIds.has(i.id));
      if (pending.length > 0) {
        // steer 前に宛先登録 (session-model.md §3 の境界規則)
        for (const p of pending) {
          this.registerReplyDestination(p.event, existing.policy);
        }
        for (const p of pending) existing.promptedIds.add(p.id);
        existing.turnEpoch += 1;
        this.resetTurnTimeout(sessionKey, existing);
        this.resetProgressNotice(sessionKey, existing);
        existing.process.steer(renderItems(pending));
        this.logger.info(
          { sessionKey, items: pending.length },
          "session steered",
        );
      }
    }
    return true;
  }

  /** /new コマンドの処理 (session-model.md §6)。gate を通過済み、かつこのレーンに
   * 実行中セッションが無いことが呼び出し元 (handle) で確定した後にのみ呼ばれる。
   * 短時間の lease を取得してマーカー (rotateRequestedAt) を書くだけで、即座の
   * rotate はしない (WorkdirStorage の棚に旧 session.jsonl が残っており、次の
   * restore で復元されて巻き戻るため。次の kick が restore 後に消費する) */
  private async handleNewCommand(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    cmd: Extract<ChatCommand, { kind: "new" }>,
  ): Promise<void> {
    const lease = await this.store.leases.acquire(
      sessionKey,
      this.owner,
      NEW_COMMAND_LEASE_TTL_MS,
    );
    if (lease === null) {
      const threadKey = this.registerReplyDestination(event, policy);
      await this.deliverCommandNotice(
        sessionKey,
        threadKey,
        REJECT_NOTICE_TEXT,
      );
      this.logger.info(
        { sessionKey },
        "session rotation rejected: lease unavailable",
      );
      return;
    }
    try {
      const existing = await this.store.sessions.get(sessionKey);
      if (existing !== null) {
        // updatedAt は据え置き — マーカー書き込みは「活動」ではないので
        // idle 判定を狂わせない (session-model.md §3)
        await this.store.sessions.put(sessionKey, {
          ...existing,
          rotateRequestedAt: new Date(),
        });
      } else {
        const threadTs = event.conversation.threadTs ?? event.id;
        await this.store.sessions.put(sessionKey, {
          channelId,
          threadTs,
          triggerTs: event.id,
          status: "finished",
          updatedAt: new Date(),
          rotateRequestedAt: new Date(),
        });
      }
    } finally {
      await this.store.leases.release(lease);
    }
    this.logger.info({ sessionKey }, "session rotation requested");

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
        // /new は明示的な新規開始なので affinity 合流させない (session-model.md §3)
        { skipAffinity: true },
      );
      return;
    }

    const threadKey = this.registerReplyDestination(event, policy);
    await this.deliverCommandNotice(sessionKey, threadKey, ACK_NOTICE_TEXT);
  }

  /** チャンネルが /disable で無効化されているか (session-model.md §5)。
   * doc 不在 = enabled (既定)。DM 予約名でなく実 channelId で管理する
   * (メッセージ側は実 channelId で判定するため、ChannelDoc の DM 束ねとは別軸) */
  private async isChannelDisabled(channelId: string): Promise<boolean> {
    return (await this.store.channels.get(channelId))?.enabled === false;
  }

  /** /enable /disable コマンドの処理 (session-model.md §5)。gate をバイパスして
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
    await this.store.channels.put(channelId, {
      enabled,
      updatedAt: new Date(),
      updatedBy: event.sender.id,
    });
    this.logger.info(
      { channelId, updatedBy: event.sender.id },
      enabled ? "channel enabled via command" : "channel disabled via command",
    );

    const threadKey = this.registerReplyDestination(event, policy);
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
    await this.router.deliver({ thread_key: threadKey, text }).catch((err) => {
      this.logger.warn({ sessionKey, err }, "command notice delivery failed");
    });
  }

  /** gate 通過が確定した後の affinity 合流解決 → enqueue → 多重起動チェック →
   * debounce or 即 kick (handle / handleReaction の共通経路)。item はここで永続
   * store へ積む (dedupe = at-least-once の再送吸収)。この後 debounce タイマーで
   * kick を遅らせても、item は既に永続化済みなのでプロセス死で消えない (拾い直しは
   * 既存の inbox 経路に乗る)。skipAffinity は /new の明示新規 (合流の逃げ道、
   * session-model.md §3) 用 */
  private async kickTriggered(
    sessionKey: string,
    channelId: string,
    policy: SessionPolicy,
    event: InboundMessage,
    doc: ChannelDoc | null,
    item: InboxItem,
    options?: { skipAffinity?: boolean },
  ): Promise<void> {
    // affinity 合流 (session-model.md §3「セッション合流」): チャンネル直下投稿を
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
        // このイベントのスレッドを合流先レーンの別名として記録し、以降の
        // スレッド内の追い発言も合流先へ届くようにする
        this.threadAlias.set(sessionKey, target);
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

    const fresh = await this.store.inbox.enqueue(sessionKey, item);
    if (!fresh) {
      this.logger.debug(
        { sessionKey, itemId: item.id },
        "inbox duplicate skip",
      );
      return;
    }
    // レーンの発生 (debounce 待機開始 / kick) を直近セッションポインタに記録
    await this.touchSessionPointer(channelId, sessionKey);

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
        this.logger.warn({ sessionKey, err }, "debounced kick failed");
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
    this.logger.debug(
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
    // (session-model.md §5)
    if (await this.isChannelDisabled(channelId)) {
      this.logger.info(
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

  /** affinity 合流先の解決 (session-model.md §3「セッション合流」)。scope=channel の
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
    // スレッド内の発言はそのスレッドのセッションに属する (session-model.md §6
    // 再開判定 1)。合流対象はチャンネル直下投稿のみ
    if (event.conversation.threadTs !== undefined) return naturalKey;

    const state = await this.store.channels.get(channelId);
    const pointer = state?.affinity;
    if (pointer === undefined || pointer.sessionKey === naturalKey) {
      return naturalKey;
    }

    // 生きているレーン (debounce 待機 / starting / running / lingering) へは
    // 窓に関わらず合流する
    if (
      this.sessions.has(pointer.sessionKey) ||
      this.pendingKicks.has(pointer.sessionKey)
    ) {
      return pointer.sessionKey;
    }

    // 終了済みレーンは windowSec 以内なら resume 合流。endedAt が無い
    // (クラッシュで書き損ね等) 場合は lastActiveAt で保守的に判定する
    const windowSec = affinity.windowSec ?? 0;
    const refMs = (pointer.endedAt ?? pointer.lastActiveAt).getTime();
    if (Date.now() - refMs <= windowSec * 1000) return pointer.sessionKey;
    return naturalKey;
  }

  /** 直近セッションポインタの活動更新 (session-model.md §3)。ポインタは合流候補の
   * 検索用 (advisory) なので、書き込み失敗でイベント処理を止めない */
  private async touchSessionPointer(
    channelId: string,
    sessionKey: string,
  ): Promise<void> {
    try {
      await this.store.channels.putSessionPointer(channelId, {
        sessionKey,
        lastActiveAt: new Date(),
      });
    } catch (err) {
      this.logger.warn(
        { channelId, sessionKey, err },
        "session pointer touch failed",
      );
    }
  }

  /** セッション終了時のポインタ endedAt 記録 (session-model.md §3。windowSec の
   * 起点になる)。ポインタが既に別レーンを指していたら書かない — 古いレーンの終了で
   * 「最後に活動したセッション」を巻き戻さない */
  private async markSessionPointerEnded(
    channelId: string,
    sessionKey: string,
  ): Promise<void> {
    try {
      const state = await this.store.channels.get(channelId);
      const pointer = state?.affinity;
      if (pointer === undefined || pointer.sessionKey !== sessionKey) return;
      const now = new Date();
      await this.store.channels.putSessionPointer(channelId, {
        sessionKey,
        lastActiveAt: now,
        endedAt: now,
      });
    } catch (err) {
      this.logger.warn(
        { channelId, sessionKey, err },
        "session pointer end mark failed",
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
    const lease = await this.store.leases.acquire(
      sessionKey,
      this.owner,
      this.leaseTtlMs,
    );
    if (lease === null) {
      this.logger.info(
        { sessionKey, itemId: inboxItemId(event) },
        "lease held by another process; enqueued only",
      );
      return;
    }
    if (this.sessions.has(sessionKey)) {
      // acquire の await 中にローカルの別イベントが kick した (そちらが lease を
      // 取れているはずなので通常到達しないが、二重 kick だけは防ぐ)
      await this.store.leases.release(lease);
      return;
    }

    // レーン根の threadTs は event ではなく sessionKey から導出する (thread モードの
    // key は `${channelId}:${threadTs}`)。affinity 合流の resume では event のスレッド
    // 位置とレーンが一致しないが、workdir/transcript は常にレーン基準 (session-model.md §3)
    const threadTs =
      policy.sessionMode === "channel"
        ? (event.conversation.threadTs ?? event.id)
        : sessionKey.slice(channelId.length + 1);
    const record: SessionRecord = {
      state: "starting",
      triggerTs: event.id,
      channelId,
      threadTs,
      workdir: join(
        this.workdirRoot,
        channelId,
        policy.sessionMode === "channel" ? "channel" : threadTs,
      ),
      policy,
      startedAt: Date.now(),
      lease,
      promptedIds: new Set(),
      turnEpoch: 0,
      renewTimer: undefined,
      turnTimeoutTimer: undefined,
      progressNoticeTimer: undefined,
      currentTool: undefined,
      toolCallCount: 0,
      lastProgressNoticeText: undefined,
    };
    this.sessions.set(sessionKey, record);

    try {
      await this.kick(sessionKey, record, event, doc);
    } catch (err) {
      // enqueue 済み item は ack されていないので、同レーンの次のイベント
      // (または再送) で再 kick され拾い直される (persistence.md §4)
      this.sessions.delete(sessionKey);
      this.stopRenewTimer(record);
      this.clearTurnTimeout(record);
      this.clearProgressNotice(record);
      await this.router.clearProgress(sessionKey);
      try {
        await record.process?.stop();
      } catch {
        // spawn 途中の失敗など。stop は best-effort でよい
      }
      await this.store.leases.release(lease);
      await this.markSessionPointerEnded(channelId, sessionKey);
      this.logger.warn({ sessionKey, err }, "session kick failed");
    }
  }

  /** reply 宛先の登録 (メッセージごと。session-model.md §3)。境界規則:
   * スレッド内のトリガーは reply.mode に関わらずそのスレッドへ返す。
   * reply.mode が効くのはチャンネル直下トリガーの返信先だけ */
  private registerReplyDestination(
    event: InboundMessage,
    policy: SessionPolicy,
  ): string {
    const channelId = event.conversation.channelId;
    const key = replyThreadKeyOf(event);
    if (event.conversation.threadTs !== undefined) {
      this.router.register(key, {
        channelId,
        threadTs: event.conversation.threadTs,
      });
    } else if (policy.replyMode === "thread") {
      // 新スレッドを起こす (トリガーメッセージ自身を thread root にする)
      this.router.register(key, { channelId, threadTs: event.id });
    } else {
      // フラット (チャンネル直下)
      this.router.register(key, { channelId });
    }
    return key;
  }

  /** reply の files (agent が渡した workdir 相対パス) を workdirReal 基準の絶対パスへ
   * 解決し、workdir 外へ出るパス (`../` エスケープ、絶対パス指定) は除外して warn する
   * (trust boundary: agent は semi-trusted)。加えて symlink 越しの workdir 外ファイル
   * 参照 (例: `/proc/1/environ` への symlink を workdir 内に作る) を防ぐため、lstat で
   * symlink/非通常ファイルを拒否し、realpath 済みの実体が workdir 配下にあることも
   * 確認する。files 未指定、または全件除外後に空なら undefined を返し、text だけの
   * 従来 payload として deliver させる */
  private async resolveReplyFiles(
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
        this.logger.warn(
          { sessionKey, path: file },
          "reply file path escapes workdir; dropped",
        );
        continue;
      }
      let fileStat: Awaited<ReturnType<typeof lstat>>;
      try {
        fileStat = await lstat(abs);
      } catch {
        this.logger.warn(
          { sessionKey, path: file },
          "reply file does not exist; dropped",
        );
        continue;
      }
      if (!fileStat.isFile()) {
        this.logger.warn(
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
        this.logger.warn(
          { sessionKey, path: file },
          "reply file resolves outside workdir; dropped",
        );
        continue;
      }
      resolved.push(abs);
    }
    return resolved.length > 0 ? resolved : undefined;
  }

  /** チャンネル共有ディレクトリの staging パス (docs/design/shared.md §1)。
   * workdir の隣に置く — agent からは session.mode に関わらず cwd 相対 ../shared/
   * (`<channelId>/<threadTs>/` と `<channelId>/channel/` のどちらとも隣接する) */
  private sharedStagingDir(channelId: string): string {
    return join(this.workdirRoot, channelId, "shared");
  }

  /** kick シーケンス (session-runtime.md §1: restore → spawn → prompt) */
  private async kick(
    sessionKey: string,
    record: SessionRecord,
    triggerEvent: InboundMessage,
    doc: ChannelDoc | null,
  ): Promise<void> {
    const { channelId, threadTs, workdir, policy } = record;

    warnPolicyMismatches(this.logger, sessionKey, channelId, policy, doc);

    // workdir/shared の mkdir + restore、transcript 世代交代、UID 分離、
    // agentHome 作成、realpath 正規化 (session-runtime.md §1, §6)
    const { workdirReal, agentHomeReal, sharedDirReal, sessionPath, resumed } =
      await prepareWorkdir({
        sessionKey,
        channelId,
        workdir,
        policy,
        doc,
        sessions: this.store.sessions,
        workdirStorage: this.workdirStorage,
        sharedStorage: this.sharedStorage,
        sharedStagingDir: (id) => this.sharedStagingDir(id),
        agentUid: this.agentUid,
        agentGid: this.agentGid,
        agentHome: this.agentHome,
        logger: this.logger,
      });

    // extension/skill パス解決 + Node Permission Model オプション組み立て
    // (session-runtime.md §5, §6)
    const { extensionPaths, skillPaths, memoryEnabled, permission } =
      await buildSpawnOptions({
        agentHomeReal,
        workdirReal,
        sharedDirReal,
        doc,
        builtinExtensionPaths: this.extensionPaths,
        memorySkillPath: this.memorySkillPath,
        piPermission: this.piPermission,
      });

    const model = doc?.model;
    // 常に HOME を agentHome に上書きする (Runner 自身の HOME は継承しない)。
    // extraEnv で HOME を上書きする (buildPiEnv は extraEnv が PATH/HOME を
    // 上書きできる実装になっている)
    const extraEnv = { ...this.extraEnv, HOME: agentHomeReal };
    // memory の索引 (MEMORY.md) は skill 発火 (agent の自発的な read) に頼らず
    // system prompt に常時注入する (docs/design/memory.md §2)。1 行 1 メモリの
    // 短い索引という規約 (SKILL.md の Save 手順) が前提で、肥大化はしない想定。
    // 本文ファイルは引き続き skill 経由でオンデマンドに read させる
    const memoryIndex = await loadMemoryIndex(memoryEnabled, sharedDirReal);
    const proc = new PiProcess({
      sessionPath,
      extensionPaths,
      cwd: workdirReal,
      appendSystemPrompt: buildSystemPrompt(
        sessionKey,
        doc,
        this.mentionFormat,
        sharedDirReal !== undefined,
        memoryIndex,
      ),
      ...(this.piBinary !== undefined ? { piBinary: this.piBinary } : {}),
      ...(this.piEntrypoint !== undefined
        ? { piEntrypoint: this.piEntrypoint }
        : {}),
      ...(model !== undefined ? { model } : {}),
      ...(doc?.tools !== undefined ? { tools: doc.tools } : {}),
      ...(doc?.excludeTools !== undefined
        ? { excludeTools: doc.excludeTools }
        : {}),
      ...(skillPaths.length > 0 ? { skillPaths } : {}),
      ...(extraEnv !== undefined ? { extraEnv } : {}),
      ...(this.agentUid !== undefined ? { uid: this.agentUid } : {}),
      ...(this.agentGid !== undefined ? { gid: this.agentGid } : {}),
      ...(permission !== undefined ? { permission } : {}),
      // pi は正常時にも stderr へ出すことがあるため warn ではなく debug
      logger: (line) => this.logger.debug({ sessionKey, line }, "pi stderr"),
    });

    proc.on("event", (piEvent) => {
      // ペイロード全体はログに残さない (大きい・機微を含みうる)。イベント種別ごとの
      // 概要フィールドだけ出す。ストリーミング差分は null が返るのでログしない
      const logFields = piEventLogFields(piEvent);
      if (logFields !== null) {
        this.logger.debug(
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
          record.toolCallCount += 1;
          record.currentTool = {
            name: piEvent.toolName,
            emoji: progressEmoji(piEvent.toolName),
            argsPreview: toolArgsPreview(piEvent.toolName, piEvent.args, 60),
          };
        }
      }
      if (isToolExecutionEnd(piEvent)) {
        const payload = extractReply(piEvent);
        if (payload !== null) {
          // files は必ず resolveReplyFiles の結果で上書きする。payload.files には
          // agent が渡した生の相対パスが残っているため、全件除外時 (files === undefined)
          // にそれをそのまま poster へ流すと境界チェックを素通りしてしまう
          this.resolveReplyFiles(sessionKey, workdirReal, payload.files)
            .then((files) =>
              this.router.deliver(
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
              this.clearProgressNotice(record);
            })
            .catch((err) => {
              this.logger.warn(
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
          this.logger.error(
            { sessionKey, errorMessage },
            "assistant turn ended with error",
          );
        }
        // agent_end.messages は毎回全履歴を返すため、この totals はターンの増分では
        // なくセッション累計 (pi-events.ts extractUsageTotals)
        const totals = extractUsageTotals(piEvent);
        record.usageTotals = totals;
        this.logger.info({ sessionKey, ...totals }, "turn usage");
        // 進捗タイマーは agent_end を受けた時点で即止める。onAgentEnd の
        // teardown まで待つと、その間の await の隙間でタイマー tick がもう一件
        // 発火し、deliver 済みの reply の後に古いツール名で新規投稿してしまう
        this.clearProgressNotice(record);
        void this.onAgentEnd(sessionKey, proc).catch((err) => {
          this.logger.warn({ sessionKey, err }, "agent_end handling failed");
        });
      }
    });
    proc.on("response", (response) => {
      // success: true は prompt/steer の受理応答に過ぎない (agent_end が本当の
      // 終端)。debug ログのみで十分
      if (response.success) {
        this.logger.debug(
          { sessionKey, command: response.command },
          "pi command accepted",
        );
        return;
      }
      // success: false は pi 側が「動けない」と判断したケース (認証エラー等)。
      // pi は生きたまま次コマンドを待つが、agent_end が来ないので何もしなければ
      // runner は永久に無音ハングする → ここで異常終了として扱いプロセスを止める
      this.logger.error(
        { sessionKey, command: response.command, error: response.error },
        "pi command failed",
      );
      void this.failSession(sessionKey, proc, response.error).catch((err) => {
        this.logger.warn({ sessionKey, err }, "failSession handling failed");
      });
    });
    proc.on("invalid", (raw, error) => {
      this.logger.debug(
        { sessionKey, raw: raw.slice(0, 500), error },
        "pi stdout line invalid",
      );
    });
    proc.on("exit", (code, signal) => {
      // 正常終了パス (onAgentEnd) では state を stopping にしてから stop している。
      // running のまま exit したら異常終了。lease を解いて次のイベントで拾い直せるようにする
      // (flush はしない)
      const current = this.sessions.get(sessionKey);
      if (
        current !== undefined &&
        current.process === proc &&
        current.state !== "stopping"
      ) {
        this.sessions.delete(sessionKey);
        this.stopRenewTimer(current);
        this.clearTurnTimeout(current);
        this.clearProgressNotice(current);
        void this.router.clearProgress(sessionKey).catch((err) => {
          this.logger.warn({ sessionKey, err }, "clear progress failed");
        });
        // このターンで prompt 済みだった item は ack して捨てる。retry しない
        // (session-model.md §6)。捨てないと未 ack のまま inbox に残り、次の新規
        // イベントの drain が巻き込んで再 prompt するため、workdir/transcript を
        // 使い回す構造上「同じ入力で pi が再クラッシュし続ける」ループになりうる。
        // 異常終了はユーザーに ❌ で伝わるので、必要なら本人が言い直せばよい
        const toAck = [...current.promptedIds];
        if (toAck.length > 0) {
          void this.store.inbox.ack(sessionKey, toAck).catch((err) => {
            this.logger.warn({ sessionKey, err }, "inbox ack failed");
          });
        }
        void this.store.leases.release(current.lease).catch((err) => {
          this.logger.warn({ sessionKey, err }, "lease release failed");
        });
        void this.markSessionPointerEnded(current.channelId, sessionKey);
        this.logger.warn(
          { sessionKey, code, signal },
          "pi exited unexpectedly",
        );
        // pi のクラッシュはユーザーから見えない (返信なしで無音になる) ので、
        // トリガーメッセージに ❌ を付けて失敗を伝える
        void this.safeReact(
          () => this.reactions.addX(current.channelId, current.triggerTs),
          sessionKey,
          "x",
        );
      }
    });

    proc.start();
    record.state = "running";
    record.process = proc;
    this.startRenewTimer(sessionKey, record);

    // sessionKey でのフォールバック登録 (abnormalShutdown が thread_key: sessionKey で
    // 通知を送るために必要)。sessionMode "channel" かつ replyMode "flat" ならチャンネル
    // 直下、それ以外はトリガーのスレッドへ (session-model.md §3)
    if (policy.sessionMode === "channel" && policy.replyMode === "flat") {
      this.router.register(sessionKey, { channelId });
    } else {
      this.router.register(sessionKey, { channelId, threadTs });
    }
    await this.safeReact(
      () => this.reactions.addEyes(channelId, record.triggerTs),
      sessionKey,
      "eyes",
    );

    // enqueue 済みの入力 (spawn 準備中に積まれた分を含む) を束ねて初回 prompt にする。
    // トリガーイベント自身も enqueue 済みなので通常 drain 経由で届く。
    // ChannelDoc.context は初回のみ先頭に注入する (config.md §4)
    const items = (await this.store.inbox.drain(sessionKey)).filter(
      (i) => !record.promptedIds.has(i.id),
    );
    let body: string;
    if (items.length > 0) {
      for (const i of items) {
        this.registerReplyDestination(i.event, policy);
        record.promptedIds.add(i.id);
      }
      body = renderItems(items);
    } else {
      // drain が空 (Store 実装の遅延など)。トリガーイベントに直接フォールバック
      // するが、ack 対象には含める (二重 prompt を防ぐ)
      const triggerKey = this.registerReplyDestination(triggerEvent, policy);
      record.promptedIds.add(inboxItemId(triggerEvent));
      body = renderEvent(triggerEvent, triggerKey);
    }
    record.turnEpoch += 1;
    this.resetTurnTimeout(sessionKey, record);
    this.resetProgressNotice(sessionKey, record);
    proc.prompt(prependContext(body, doc));

    await this.store.sessions.put(sessionKey, {
      channelId,
      threadTs,
      triggerTs: record.triggerTs,
      status: "active",
      updatedAt: new Date(),
    });
    this.logger.info(
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

  /**
   * agent_end: flush → ack (この順序が正。逆にするとクラッシュで入力が消える) →
   * 残り入力があれば次の prompt、無ければ linger して再確認、それでも無ければ ✅ で終了
   * (persistence.md §3, session-model.md §4 の linger)
   */
  private async onAgentEnd(sessionKey: string, proc: PiProcess): Promise<void> {
    const record = this.sessions.get(sessionKey);
    if (record === undefined || record.process !== proc) return;
    const epoch = record.turnEpoch;
    // ターンが正常に終わったので timeout タイマーをクリア (リークさせない)。
    // 以降 promptPending で継続する場合は都度リセットされる
    this.clearTurnTimeout(record);
    // アイドルな pi への steer はターンを開始しない (キューに積まれるだけ) ため、
    // ここから終了処理完了までは trySteerExisting に steer させず enqueue のみに
    // させる。promptPending が新ターンとして拾い、そこで running に戻す
    record.state = "lingering";

    // 1. ターン境界の flush → 2. flush 成功後に ack (persistence.md §3)。
    // ack 対象は flush 前のスナップショット — flush の await 中に steer が
    // promptedIds へ追加した item を「そのターンの flush 前」に ack しない
    const toAck = [...record.promptedIds];
    await this.workdirStorage.flush(sessionKey, record.workdir);
    // shared も同じ境界で棚へ書き戻す (docs/design/shared.md §2)。異常終了パス
    // (exit / abnormalShutdown / renew 失敗) で書き戻さないのは workdir と同じ理由
    if (this.sharedStorage !== undefined) {
      await this.sharedStorage.flush(
        record.channelId,
        this.sharedStagingDir(record.channelId),
      );
    }
    if (toAck.length > 0) {
      await this.store.inbox.ack(sessionKey, toAck);
      for (const id of toAck) record.promptedIds.delete(id);
    }

    // 3. 新規入力があれば同一プロセスで継続 (flush/ack は次の agent_end で行う)
    if (await this.promptPending(sessionKey, record, proc)) return;
    // flush/ack の await 中に steer 済みなら、そのターンの agent_end に終了判定を譲る
    if (record.turnEpoch !== epoch) return;

    // 4. linger: agent_end 直後に届いた追いメッセージを拾ってから終える。
    // この間レコードは Map に残す (新イベントは steer パスに入りうる)
    await sleep(this.lingerMs);
    if (this.sessions.get(sessionKey) !== record || record.process !== proc)
      return;
    if (await this.promptPending(sessionKey, record, proc)) return;
    if (record.turnEpoch !== epoch) return;

    // 5. 終了処理。reply が 1 度も呼ばれなくても沈黙のまま ✅ を付けて終える
    record.state = "stopping";
    await this.safeReact(
      () => this.reactions.addCheck(record.channelId, record.triggerTs),
      sessionKey,
      "check",
    );
    await this.store.sessions.put(sessionKey, {
      channelId: record.channelId,
      threadTs: record.threadTs,
      triggerTs: record.triggerTs,
      status: "finished",
      updatedAt: new Date(),
    });
    await proc.stop();
    this.stopRenewTimer(record);
    this.clearTurnTimeout(record);
    this.clearProgressNotice(record);
    await this.router.clearProgress(sessionKey);
    await this.store.leases.release(record.lease);
    this.sessions.delete(sessionKey);
    // windowSec の起点 (session-model.md §3。以降このレーンは窓内なら resume 合流できる)
    await this.markSessionPointerEnded(record.channelId, sessionKey);
    this.logger.info(
      {
        sessionKey,
        durationMs: Date.now() - record.startedAt,
        ...(record.usageTotals !== undefined
          ? {
              totalTokens: record.usageTotals.totalTokens,
              costTotal: record.usageTotals.costTotal,
              cacheRead: record.usageTotals.cacheRead,
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
  private async failSession(
    sessionKey: string,
    proc: PiProcess,
    error: string | undefined,
  ): Promise<void> {
    await this.abnormalShutdown(sessionKey, proc, {
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
  private async timeoutSession(
    sessionKey: string,
    proc: PiProcess,
  ): Promise<void> {
    this.logger.error(
      { sessionKey, turnTimeoutMs: this.turnTimeoutMs },
      "turn timed out",
    );
    await this.abnormalShutdown(sessionKey, proc, {
      noticeText: `:warning: ターンがタイムアウトしました (${this.turnTimeoutMs}ms)。セッションを終了します`,
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
  private async abnormalShutdown(
    sessionKey: string,
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
    const record = this.sessions.get(sessionKey);
    if (record === undefined || record.process !== proc) return;

    record.state = "stopping";
    this.stopRenewTimer(record);
    this.clearTurnTimeout(record);
    this.clearProgressNotice(record);

    // register 済み (kick で必ず register している) なので deliver できる。
    // 通知の配達が失敗してもセッションの畳み込みは続ける
    await this.router
      .deliver({ thread_key: sessionKey, text: options.noticeText }, sessionKey)
      .catch((err) => {
        this.logger.warn({ sessionKey, err }, "failure notice delivery failed");
      });
    await this.router.clearProgress(sessionKey);
    await this.safeReact(
      () => this.reactions.addX(record.channelId, record.triggerTs),
      sessionKey,
      "x",
    );

    if (options.dropPromptedItems) {
      const toAck = [...record.promptedIds];
      if (toAck.length > 0) {
        await this.store.inbox.ack(sessionKey, toAck).catch((err) => {
          this.logger.warn({ sessionKey, err }, "inbox ack failed");
        });
      }
    }
    await this.store.leases.release(record.lease).catch((err) => {
      this.logger.warn({ sessionKey, err }, "lease release failed");
    });
    await options.stop();
    this.logger.warn(
      { sessionKey, durationMs: Date.now() - record.startedAt },
      options.logMessage,
    );
    // activeSessionCount (テストの waitFor 等) がこのログの後で 0 になるよう、
    // Map からの削除はクリーンアップ完了後に行う
    this.sessions.delete(sessionKey);
    await this.markSessionPointerEnded(record.channelId, sessionKey);
  }

  /** 未 prompt の item があれば prompt して true (drain は非破壊なので
   * promptedIds で除外する)。無ければ false */
  private async promptPending(
    sessionKey: string,
    record: SessionRecord,
    proc: PiProcess,
  ): Promise<boolean> {
    const items = (await this.store.inbox.drain(sessionKey)).filter(
      (i) => !record.promptedIds.has(i.id),
    );
    if (items.length === 0) return false;
    for (const i of items) {
      this.registerReplyDestination(i.event, record.policy);
      record.promptedIds.add(i.id);
    }
    record.turnEpoch += 1;
    // lingering (agent_end 後の終了判定中) からの復帰。ここで拾う item は
    // trySteerExisting が steer せず enqueue のみで残していたものを含む
    record.state = "running";
    this.resetTurnTimeout(sessionKey, record);
    this.resetProgressNotice(sessionKey, record);
    proc.prompt(renderItems(items));
    this.logger.info({ sessionKey, items: items.length }, "session continued");
    return true;
  }

  /** lease の renew を ttl/3 間隔で回す。false は排他喪失 = 別の保持者が動いて
   * いる可能性があるため、flush せずプロセスを止める (書き戻さない) */
  private startRenewTimer(sessionKey: string, record: SessionRecord): void {
    const intervalMs = Math.max(1, Math.floor(this.leaseTtlMs / 3));
    const timer = setInterval(() => {
      void (async () => {
        if (this.sessions.get(sessionKey) !== record) return;
        const ok = await this.store.leases.renew(record.lease, this.leaseTtlMs);
        if (ok) return;
        if (this.sessions.get(sessionKey) !== record) return;
        this.logger.error(
          { sessionKey, owner: this.owner },
          "lease renew failed; stopping session without flush",
        );
        record.state = "stopping";
        this.sessions.delete(sessionKey);
        this.stopRenewTimer(record);
        this.clearTurnTimeout(record);
        this.clearProgressNotice(record);
        await this.router.clearProgress(sessionKey);
        await record.process?.stop();
        await this.markSessionPointerEnded(record.channelId, sessionKey);
      })().catch((err) => {
        this.logger.error({ sessionKey, err }, "lease renew handling failed");
      });
    }, intervalMs);
    timer.unref();
    record.renewTimer = timer;
  }

  private stopRenewTimer(record: SessionRecord): void {
    if (record.renewTimer !== undefined) {
      clearInterval(record.renewTimer);
      record.renewTimer = undefined;
    }
  }

  /** turn timeout タイマーをリセットする (prompt/steer 送信ごとに呼ぶ。既存タイマーが
   * あれば止めて張り直す)。発火したら timeoutSession でセッションを異常終了させる */
  private resetTurnTimeout(sessionKey: string, record: SessionRecord): void {
    this.clearTurnTimeout(record);
    const timer = setTimeout(() => {
      const proc = record.process;
      if (proc === undefined) return;
      void this.timeoutSession(sessionKey, proc).catch((err) => {
        this.logger.warn({ sessionKey, err }, "timeoutSession handling failed");
      });
    }, this.turnTimeoutMs);
    timer.unref();
    record.turnTimeoutTimer = timer;
  }

  private clearTurnTimeout(record: SessionRecord): void {
    if (record.turnTimeoutTimer !== undefined) {
      clearTimeout(record.turnTimeoutTimer);
      record.turnTimeoutTimer = undefined;
    }
  }

  /** 進捗通知タイマーをリセットする (prompt/steer 送信ごとに呼ぶ。既存タイマーが
   * あれば止めて張り直す)。turnTimeoutTimer と同じ寿命管理パターン
   * (progress-notice.md)。間隔ごとに currentTool のスナップショットを投稿/更新する */
  private resetProgressNotice(sessionKey: string, record: SessionRecord): void {
    this.clearProgressNotice(record);
    // 新しいターンの内容と比較できるよう、前ターン分の記憶は引き継がない
    record.lastProgressNoticeText = undefined;
    // 前ターンの reply 配達で閉じた進捗レーン (router.ts progressClosed) を
    // 新ターン開始時に再び開く。fire-and-forget — 失敗しても次の notifyProgress
    // が warn を出すだけで、新ターンの進捗表示自体はタイマーが担う
    void this.router.reopenProgress(sessionKey).catch((err) => {
      this.logger.warn({ sessionKey, err }, "failed to reopen progress lane");
    });
    if (this.progressNoticeIntervalMs === 0) return;
    const timer = setInterval(() => {
      const tool = record.currentTool;
      const count = record.toolCallCount;
      const text =
        tool === undefined
          ? `:thinking_face: ... (step ${count})`
          : tool.argsPreview === ""
            ? `${tool.emoji} \`${tool.name}\` ... (step ${count})`
            : `${tool.emoji} \`${tool.name}\` \`${tool.argsPreview}\` ... (step ${count})`;
      // 前回送信時から状況が進んでいなければ何もしない (Slack API を呼ばない)
      if (text === record.lastProgressNoticeText) return;
      record.lastProgressNoticeText = text;
      this.router.notifyProgress(sessionKey, text).catch((err) => {
        this.logger.warn({ sessionKey, err }, "progress notice failed");
      });
    }, this.progressNoticeIntervalMs);
    timer.unref();
    record.progressNoticeTimer = timer;
  }

  private clearProgressNotice(record: SessionRecord): void {
    if (record.progressNoticeTimer !== undefined) {
      clearInterval(record.progressNoticeTimer);
      record.progressNoticeTimer = undefined;
    }
  }

  private async loadChannelDoc(channelId: string): Promise<ChannelDoc | null> {
    try {
      return await this.configSource.channel(channelId);
    } catch (err) {
      // YAML の壊れで受信ループを止めない。既定動作 (mention 起動 / DM は disabled) に落とす
      this.logger.warn({ channelId, err }, "failed to load channel doc");
      return null;
    }
  }

  private resolveWhen(doc: ChannelDoc | null, isDm: boolean): EvaluableNode[] {
    const deps: GateDeps = {
      ...(this.classifierClient !== undefined
        ? { classifierClient: this.classifierClient }
        : {}),
      logger: this.logger,
    };
    if (doc?.trigger === undefined) {
      // doc なし / trigger 未設定は既定 = mention のみ、DM は disabled (起動しない)
      // (session-model.md §5, config.md §1)
      return buildWhen(defaultWhen(isDm), deps);
    }
    return buildWhen(doc.trigger.when, deps);
  }

  /** リアクションは装飾なので、失敗してもセッションを止めない */
  private async safeReact(
    fn: () => Promise<void>,
    sessionKey: string,
    label: string,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn({ sessionKey, label, err }, "failed to add reaction");
    }
  }
}
