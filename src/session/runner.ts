// SessionRunner — event を受けて session を主語に処理するオーケストレーション (Step 4)
//
// docs/design/architecture.md §1 (event は「きっかけ係」、session が「処理の担い手」)、
// §6 (起動と steering のフロー)、docs/design/session-runtime.md §1 (kick シーケンス)、
// §3 (tmpfs + 境界 flush)、docs/design/persistence.md §1 (Store 群)、§3 (flush → ack の順序)。
//
// Step 4 のスコープ: lease による多重起動の排他、drain/ack 分離 (drain は非破壊。
// プロンプト済み item の記憶と重複除外は runner のインメモリ責務)、agent_end 後の
// linger による追いメッセージ拾い直し、WorkdirStorage による境界退避 (未指定なら
// Step 3 相当のローカル置きっぱなし)。turn timeout は Step 6。

import { chmod, chown, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  createGate,
  defaultGates,
  evaluateTrigger,
  type Gate,
  type GateCombinator,
  type GateSpec,
} from "../gate/gate.js";
import type { InboundMessage } from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import { rootLogger } from "../logger.js";
import type { Reactions } from "../reply/reactions.js";
import type { ReplyRouter } from "../reply/router.js";
import type {
  ChannelDoc,
  Gate as ChannelGateSpec,
} from "../store/channel-doc.js";
import type { ConfigSource } from "../store/config-source.js";
import { inboxItemId } from "../store/inbox-item.js";
import type { InboxItem, Lease, StateStore } from "../store/interfaces.js";
import type { WorkdirStorage } from "../store/workdir-storage.js";
import { extractReply, isAgentEnd, isToolExecutionEnd } from "./rpc.js";
import { buildPiPermissionOptions, PiProcess } from "./runtime.js";

/** app 共通プロンプト。ChannelDoc.systemPrompt はこれへの追記分 (architecture.md §2) */
const APP_SYSTEM_PROMPT = [
  "You are an assistant running inside a Slack thread.",
  "Your response reaches the user ONLY through the reply(thread_key, text) tool;",
  "plain assistant text is never delivered.",
  "If no response is needed, simply do not call reply.",
].join(" ");

/** Node Permission Model 有効化の静的パラメタ (session-runtime.md §6)。
 * workdir / home はセッションごとに決まるため kick 時に buildPiPermissionOptions
 * へ都度渡す — ここに載るのはイメージ内で固定のパスだけ */
export interface PiPermissionConfig {
  /** pi 本体のエントリポイント JS の絶対パス (npm -g 実体。docker で
   * `readlink -f $(which pi)` して確定させる) */
  entrypoint: string;
  /** pi 本体・依存が入る npm global の node_modules ルート (`npm root -g`) */
  nodeModulesDir: string;
  /** `/app` 相当 (extension・skill 焼き込み先) */
  appDir: string;
  /** 追加で write を許可したいパス (例 "/tmp/*")。既定なし */
  extraWrite?: string[];
}

export interface SessionRunnerOptions {
  configSource: ConfigSource;
  /** 永続化 Store 群 (inbox / sessions / leases)。persistence.md §1 */
  store: StateStore;
  router: ReplyRouter;
  reactions: Reactions;
  /** workdir の境界退避。未指定なら restore/flush をスキップ (Step 3 相当) */
  workdirStorage?: WorkdirStorage;
  /** pi の `--extension` に渡す extension の絶対パス群 (reply + permission-gate 等)。
   * すべて常時注入する (permission-gate は事故防止層なので無効化オプションは持たない) */
  extensionPaths: string[];
  /** workdir のルート。既定 /tmp/pi-chat-runner/sessions */
  workdirRoot?: string;
  /** pi バイナリ。省略時は PiProcess の既定 (env PI_BIN → "pi") */
  piBinary?: string;
  /** ChannelDoc.model が無いときのモデル (env PI_MODEL 相当) */
  model?: string;
  /** `--provider` (env PI_PROVIDER 相当) */
  provider?: string;
  /** allowlist (PATH/HOME) に追加で pi 子プロセスへ渡す env (session-runtime.md §2) */
  extraEnv?: Record<string, string>;
  /** pi 子プロセスの実行 uid/gid (session-runtime.md §6: UID 分離)。両方指定時のみ有効。
   * 有効な場合のみ workdir の chown/chmod を行う (無効時は現状動作を維持) */
  agentUid?: number;
  agentGid?: number;
  /** uid 分離時に pi へ渡す HOME (既定 "/home/agent")。agent uid で書き込める
   * ホームが無いと pi が ~/.pi 等を作れないため、Runner の HOME (/root) とは
   * 別に明示指定する (session-runtime.md §6) */
  agentHome?: string;
  /** Node Permission Model 経由での起動を有効にする設定 (opt-in。未指定なら
   * 現状動作 = pi をそのまま spawn する。pi-tools-and-sandbox.md 「リーズナブルな
   * sandbox レイヤ案」、Cloud Run 実イメージでのみ有効化する想定) */
  piPermission?: PiPermissionConfig;
  /** lease の TTL。既定 60_000ms。renew は ttl/3 間隔 */
  leaseTtlMs?: number;
  /** agent_end 後に追いメッセージを待つ時間。既定 3_000ms */
  lingerMs?: number;
  /** lease の owner 識別子。既定 `hostname:pid` */
  owner?: string;
  logger?: Logger;
}

interface SessionRecord {
  /** starting = spawn 準備中 (多重起動防止のため Map 登録済み)、
   * running = PiProcess 稼働中、stopping = 終了処理中 (exit を異常扱いしない) */
  state: "starting" | "running" | "stopping";
  process?: PiProcess;
  /** トリガーメッセージの ts (👀 / ✅ の対象) */
  triggerTs: string;
  channelId: string;
  threadTs: string;
  workdir: string;
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
}

/** thread_key の導出。スレッド外の発言はそのメッセージ自身が thread root になる */
export function threadKeyOf(event: InboundMessage): string {
  return `${event.conversation.channelId}:${event.conversation.threadTs ?? event.id}`;
}

/** イベント 1 件のプロンプト描画 (session-runtime.md §4 の renderEvent) */
export function renderEvent(event: InboundMessage): string {
  return `<${event.sender.id}> のメッセージ:\n${event.text}`;
}

function renderItems(items: InboxItem[]): string {
  return items.map((item) => renderEvent(item.event)).join("\n\n");
}

/**
 * ChannelDoc.trigger.gates (kind に classifier/cooldown も含む広い型) を
 * Step 3 で実装済みの GateSpec へ narrowing する。未対応 kind は warn してスキップ
 * (YAML に classifier を書いても動き続ける。fail-loud にはしない)。
 */
export function toGateSpecs(
  gates: ChannelGateSpec[],
  warn: (message: string) => void = (message) => console.warn(message),
): GateSpec[] {
  const specs: GateSpec[] = [];
  for (const gate of gates) {
    switch (gate.kind) {
      case "mention":
        specs.push({ kind: "mention" });
        break;
      case "keyword":
        // schema 上 pattern 必須だが、型の narrowing のため明示的に確認する
        if (gate.pattern === undefined) {
          warn("keyword gate without pattern; skipped");
          break;
        }
        specs.push({ kind: "keyword", pattern: gate.pattern });
        break;
      case "passthrough":
        specs.push({ kind: "passthrough" });
        break;
      default:
        warn(`unsupported gate kind "${gate.kind}"; skipped`);
    }
  }
  return specs;
}

/** workdir の transcript.jsonl が既に存在するか (pi が既存 transcript を読んで
 * 文脈継続するかどうかの判定。restore 後に評価すれば保存棚からの復元も拾える)。 */
async function transcriptExists(sessionPath: string): Promise<boolean> {
  try {
    await stat(sessionPath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** dir 配下 (dir 自身含む) を再帰的に chown する。UID 分離時、restore で
 * root 所有のままコピーされたファイルを agent 所有に揃えるための最小実装
 * (エントリ数が少ない workdir 前提。fs.cp に uid/gid オプションは無いため
 * コピー後にここで chown する)。
 * シンボリックリンクは辿らずスキップする: pi が workdir 内に /data 等への
 * リンクを仕込み、次の restore 後に root の Runner がリンク先を chown して
 * 所有権を奪われる経路を防ぐ (リンク自体の所有者は挙動に影響しない) */
async function chownRecursive(
  dir: string,
  uid: number,
  gid: number,
): Promise<void> {
  await chown(dir, uid, gid);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const info = await lstat(path).catch(() => null);
    if (info === null || info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await chownRecursive(path, uid, gid);
    } else {
      await chown(path, uid, gid);
    }
  }
}

export class SessionRunner {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly configSource: ConfigSource;
  private readonly store: StateStore;
  private readonly router: ReplyRouter;
  private readonly reactions: Reactions;
  private readonly workdirStorage: WorkdirStorage | undefined;
  private readonly extensionPaths: string[];
  private readonly workdirRoot: string;
  private readonly piBinary: string | undefined;
  private readonly model: string | undefined;
  private readonly provider: string | undefined;
  private readonly extraEnv: Record<string, string> | undefined;
  private readonly agentUid: number | undefined;
  private readonly agentGid: number | undefined;
  private readonly agentHome: string;
  private readonly piPermission: PiPermissionConfig | undefined;
  private readonly leaseTtlMs: number;
  private readonly lingerMs: number;
  private readonly owner: string;
  private readonly logger: Logger;

  constructor(options: SessionRunnerOptions) {
    this.configSource = options.configSource;
    this.store = options.store;
    this.router = options.router;
    this.reactions = options.reactions;
    this.workdirStorage = options.workdirStorage;
    this.extensionPaths = options.extensionPaths;
    this.workdirRoot = options.workdirRoot ?? "/tmp/pi-chat-runner/sessions";
    this.piBinary = options.piBinary;
    this.model = options.model;
    this.provider = options.provider;
    this.extraEnv = options.extraEnv;
    this.agentUid = options.agentUid;
    this.agentGid = options.agentGid;
    this.agentHome = options.agentHome ?? "/home/agent";
    this.piPermission = options.piPermission;
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000;
    this.lingerMs = options.lingerMs ?? 3_000;
    this.owner = options.owner ?? `${hostname()}:${process.pid}`;
    this.logger = options.logger ?? rootLogger.child({ component: "session" });
  }

  /** 実行中 (起動中含む) のセッション数。テスト・観測用 */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  async handle(event: InboundMessage): Promise<void> {
    const threadKey = threadKeyOf(event);
    const item: InboxItem = {
      id: inboxItemId(event),
      event,
      enqueuedAt: new Date(),
    };

    // 実行中 (起動中含む) セッションがあるスレッド: gate は通さず enqueue して
    // steer で配達 (architecture.md §6 フロー 6。後続発言は追加指示として扱う)。
    // enqueue は「セッションあり or gate 通過」のときだけ行う — gate 非通過の
    // 全メッセージを永続 store に溜め込まない (dedupe は enqueue 時に効く)
    const existing = this.sessions.get(threadKey);
    if (existing !== undefined) {
      const fresh = await this.store.inbox.enqueue(threadKey, item);
      if (!fresh) {
        this.logger.debug(
          { threadKey, itemId: item.id },
          "inbox duplicate skip",
        );
        return;
      }
      // starting 中は初回 prompt の drain が拾う。running なら steer で即配達する
      if (existing.state === "running" && existing.process?.running) {
        const items = await this.store.inbox.drain(threadKey);
        const pending = items.filter((i) => !existing.promptedIds.has(i.id));
        if (pending.length > 0) {
          for (const p of pending) existing.promptedIds.add(p.id);
          existing.turnEpoch += 1;
          existing.process.steer(renderItems(pending));
          this.logger.info(
            { threadKey, items: pending.length },
            "session steered",
          );
        }
      }
      return;
    }

    // 実行中でない: ChannelDoc → gate 評価 → trigger なら lease を取って kick
    const channelId = event.conversation.channelId;
    const doc = await this.loadChannelDoc(channelId);
    const { gates, combinator } = this.resolveGates(doc);
    const decision = await evaluateTrigger(gates, combinator, {
      event,
      recent: [],
    });
    if (!decision.trigger) {
      this.logger.debug(
        { channelId, threadKey, reason: decision.reason },
        "gate not triggered",
      );
      return;
    }
    this.logger.info(
      { channelId, threadKey, reason: decision.reason },
      "gate triggered",
    );

    // gate 通過が確定してから耐久キューへ積む (dedupe = at-least-once の再送吸収)
    const fresh = await this.store.inbox.enqueue(threadKey, item);
    if (!fresh) {
      this.logger.debug({ threadKey, itemId: item.id }, "inbox duplicate skip");
      return;
    }

    // 多重起動防止: gate 評価の await 中に別イベントが kick 済みなら、
    // 上で enqueue した item はそのセッションの drain が拾う
    if (this.sessions.has(threadKey)) return;

    // 実行ロック。取れなければ別プロセスが保持中 — enqueue 済みなので
    // 保持者側の drain (steer / agent_end / linger) が拾う
    const lease = await this.store.leases.acquire(
      threadKey,
      this.owner,
      this.leaseTtlMs,
    );
    if (lease === null) {
      this.logger.info(
        { threadKey, itemId: item.id },
        "lease held by another process; enqueued only",
      );
      return;
    }
    if (this.sessions.has(threadKey)) {
      // acquire の await 中にローカルの別イベントが kick した (そちらが lease を
      // 取れているはずなので通常到達しないが、二重 kick だけは防ぐ)
      await this.store.leases.release(lease);
      return;
    }

    const threadTs = event.conversation.threadTs ?? event.id;
    const record: SessionRecord = {
      state: "starting",
      triggerTs: event.id,
      channelId,
      threadTs,
      workdir: join(this.workdirRoot, channelId, threadTs),
      startedAt: Date.now(),
      lease,
      promptedIds: new Set(),
      turnEpoch: 0,
      renewTimer: undefined,
    };
    this.sessions.set(threadKey, record);

    try {
      await this.kick(threadKey, record, event, doc);
    } catch (err) {
      // enqueue 済み item は ack されていないので、同スレッドの次のイベント
      // (または再送) で再 kick され拾い直される (persistence.md §4)
      this.sessions.delete(threadKey);
      this.stopRenewTimer(record);
      try {
        await record.process?.stop();
      } catch {
        // spawn 途中の失敗など。stop は best-effort でよい
      }
      await this.store.leases.release(lease);
      this.logger.warn({ threadKey, err }, "session kick failed");
    }
  }

  /** kick シーケンス (session-runtime.md §1: restore → spawn → prompt) */
  private async kick(
    threadKey: string,
    record: SessionRecord,
    triggerEvent: InboundMessage,
    doc: ChannelDoc | null,
  ): Promise<void> {
    const { channelId, threadTs, workdir } = record;

    // 同 thread_key は常に同じ workdir/transcript.jsonl を使う。再 trigger 時は
    // 同じパスで再 spawn され、pi が JSONL を読んで文脈を継続する (再開の専用フローなし)
    await mkdir(workdir, { recursive: true });
    if (this.workdirStorage !== undefined) {
      await this.workdirStorage.restore(threadKey, workdir);
    }
    // UID 分離 (session-runtime.md §6) が有効なら、workdir を agent 所有 0700 に
    // する。mkdir は Runner (root) 実行なので root 所有で作られ、restore で
    // コピーされたファイルも root 所有になる — agent uid で書き込めるよう
    // restore 後に再帰的に chown する (root だけが chown できるので、この処理は
    // uid オプションが設定されているときだけ行う)
    if (this.agentUid !== undefined && this.agentGid !== undefined) {
      await chownRecursive(workdir, this.agentUid, this.agentGid);
      await chmod(workdir, 0o700);
    }
    const sessionPath = join(workdir, "transcript.jsonl");
    const resumed = await transcriptExists(sessionPath);

    const model = doc?.model ?? this.model;
    // uid 分離時は HOME を Runner の /root のまま継承すると agent uid が書けず
    // pi が ~/.pi 等を作れない。extraEnv で HOME を上書きする (buildPiEnv は
    // extraEnv が PATH/HOME を上書きできる実装になっている)
    const extraEnv =
      this.agentUid !== undefined && this.agentGid !== undefined
        ? { ...this.extraEnv, HOME: this.agentHome }
        : this.extraEnv;
    // Node Permission Model (session-runtime.md §6, pi-tools-and-sandbox.md
    // 「リーズナブルな sandbox レイヤ案」) が opt-in で有効なら、pi 本体の
    // JS 実装ツール (read/write/edit/grep) の fs アクセスをこのセッションの
    // workdir/home に閉じ込める。home は uid 分離時の agentHome と揃える
    // (extraEnv の HOME 上書きと同じ理由)
    const home =
      this.agentUid !== undefined && this.agentGid !== undefined
        ? this.agentHome
        : (this.extraEnv?.HOME ?? this.agentHome);
    const permission =
      this.piPermission !== undefined
        ? buildPiPermissionOptions({
            entrypoint: this.piPermission.entrypoint,
            nodeModulesDir: this.piPermission.nodeModulesDir,
            appDir: this.piPermission.appDir,
            workdir,
            home,
            ...(this.piPermission.extraWrite !== undefined
              ? { extraWrite: this.piPermission.extraWrite }
              : {}),
          })
        : undefined;
    const proc = new PiProcess({
      sessionPath,
      extensionPaths: this.extensionPaths,
      cwd: workdir,
      appendSystemPrompt: buildSystemPrompt(threadKey, doc),
      ...(this.piBinary !== undefined ? { piBinary: this.piBinary } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      ...(extraEnv !== undefined ? { extraEnv } : {}),
      ...(this.agentUid !== undefined ? { uid: this.agentUid } : {}),
      ...(this.agentGid !== undefined ? { gid: this.agentGid } : {}),
      ...(permission !== undefined ? { permission } : {}),
      // pi は正常時にも stderr へ出すことがあるため warn ではなく debug
      logger: (line) => this.logger.debug({ threadKey, line }, "pi stderr"),
    });

    proc.on("event", (piEvent) => {
      // ペイロード全体はログに残さない (大きい・機微を含みうる)。type だけで
      // 「pi が動いているか」をデバッグ時に見える状態にする
      this.logger.debug({ threadKey, eventType: piEvent.type }, "pi event");
      if (isToolExecutionEnd(piEvent)) {
        const payload = extractReply(piEvent);
        if (payload !== null) {
          this.router.deliver(payload).catch((err) => {
            this.logger.warn(
              { threadKey, threadKeyPayload: payload.thread_key, err },
              "reply delivery failed",
            );
          });
        }
        return;
      }
      if (isAgentEnd(piEvent)) {
        void this.onAgentEnd(threadKey, proc).catch((err) => {
          this.logger.warn({ threadKey, err }, "agent_end handling failed");
        });
      }
    });
    proc.on("response", (response) => {
      // success: true は prompt/steer の受理応答に過ぎない (agent_end が本当の
      // 終端)。debug ログのみで十分
      if (response.success) {
        this.logger.debug(
          { threadKey, command: response.command },
          "pi command accepted",
        );
        return;
      }
      // success: false は pi 側が「動けない」と判断したケース (認証エラー等)。
      // pi は生きたまま次コマンドを待つが、agent_end が来ないので何もしなければ
      // runner は永久に無音ハングする → ここで異常終了として扱いプロセスを止める
      this.logger.error(
        { threadKey, command: response.command, error: response.error },
        "pi command failed",
      );
      void this.failSession(threadKey, proc, response.error).catch((err) => {
        this.logger.warn({ threadKey, err }, "failSession handling failed");
      });
    });
    proc.on("invalid", (raw, error) => {
      this.logger.debug(
        { threadKey, raw: raw.slice(0, 500), error },
        "pi stdout line invalid",
      );
    });
    proc.on("exit", (code, signal) => {
      // 正常終了パス (onAgentEnd) では state を stopping にしてから stop している。
      // running のまま exit したら異常終了: 未 ack の item は inbox に残っているので、
      // lease を解いて次のイベントで拾い直せるようにする (flush はしない)
      const current = this.sessions.get(threadKey);
      if (
        current !== undefined &&
        current.process === proc &&
        current.state !== "stopping"
      ) {
        this.sessions.delete(threadKey);
        this.stopRenewTimer(current);
        void this.store.leases.release(current.lease).catch((err) => {
          this.logger.warn({ threadKey, err }, "lease release failed");
        });
        this.logger.warn({ threadKey, code, signal }, "pi exited unexpectedly");
      }
    });

    proc.start();
    record.state = "running";
    record.process = proc;
    this.startRenewTimer(threadKey, record);

    this.router.register(threadKey, { channelId, threadTs });
    await this.safeReact(
      () => this.reactions.addEyes(channelId, record.triggerTs),
      threadKey,
      "eyes",
    );

    // enqueue 済みの入力 (spawn 準備中に積まれた分を含む) を束ねて初回 prompt にする。
    // トリガーイベント自身も enqueue 済みなので通常 drain 経由で届く。
    // ChannelDoc.context は初回のみ先頭に注入する (config.md §4)
    const items = (await this.store.inbox.drain(threadKey)).filter(
      (i) => !record.promptedIds.has(i.id),
    );
    let body: string;
    if (items.length > 0) {
      for (const i of items) record.promptedIds.add(i.id);
      body = renderItems(items);
    } else {
      // drain が空 (Store 実装の遅延など)。トリガーイベントに直接フォールバック
      // するが、ack 対象には含める (二重 prompt を防ぐ)
      record.promptedIds.add(inboxItemId(triggerEvent));
      body = renderEvent(triggerEvent);
    }
    record.turnEpoch += 1;
    proc.prompt(prependContext(body, doc));

    await this.store.sessions.put(threadKey, {
      channelId,
      threadTs,
      triggerTs: record.triggerTs,
      status: "active",
      updatedAt: new Date(),
    });
    this.logger.info(
      {
        threadKey,
        workdir,
        resumed,
        model,
        provider: this.provider,
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
  private async onAgentEnd(threadKey: string, proc: PiProcess): Promise<void> {
    const record = this.sessions.get(threadKey);
    if (record === undefined || record.process !== proc) return;
    const epoch = record.turnEpoch;

    // 1. ターン境界の flush → 2. flush 成功後に ack (persistence.md §3)。
    // ack 対象は flush 前のスナップショット — flush の await 中に steer が
    // promptedIds へ追加した item を「そのターンの flush 前」に ack しない
    const toAck = [...record.promptedIds];
    if (this.workdirStorage !== undefined) {
      await this.workdirStorage.flush(threadKey, record.workdir);
    }
    if (toAck.length > 0) {
      await this.store.inbox.ack(threadKey, toAck);
      for (const id of toAck) record.promptedIds.delete(id);
    }

    // 3. 新規入力があれば同一プロセスで継続 (flush/ack は次の agent_end で行う)
    if (await this.promptPending(threadKey, record, proc)) return;
    // flush/ack の await 中に steer 済みなら、そのターンの agent_end に終了判定を譲る
    if (record.turnEpoch !== epoch) return;

    // 4. linger: agent_end 直後に届いた追いメッセージを拾ってから終える。
    // この間レコードは Map に残す (新イベントは steer パスに入りうる)
    await sleep(this.lingerMs);
    if (this.sessions.get(threadKey) !== record || record.process !== proc)
      return;
    if (await this.promptPending(threadKey, record, proc)) return;
    if (record.turnEpoch !== epoch) return;

    // 5. 終了処理。reply が 1 度も呼ばれなくても沈黙のまま ✅ を付けて終える
    record.state = "stopping";
    await this.safeReact(
      () => this.reactions.addCheck(record.channelId, record.triggerTs),
      threadKey,
      "check",
    );
    await this.store.sessions.put(threadKey, {
      channelId: record.channelId,
      threadTs: record.threadTs,
      triggerTs: record.triggerTs,
      status: "finished",
      updatedAt: new Date(),
    });
    await proc.stop();
    this.stopRenewTimer(record);
    await this.store.leases.release(record.lease);
    this.sessions.delete(threadKey);
    this.logger.info(
      { threadKey, durationMs: Date.now() - record.startedAt },
      "session finished",
    );
  }

  /**
   * pi が response.success=false を返したときの異常終了処理 (例: Cloud Run で
   * ADC が見つからず認証エラーになるケース)。agent_end が来ない見込みなので
   * ここで能動的にセッションを畳む。exit ハンドラの「running のまま exit したら
   * 異常終了」と同じクリーンアップ (lease 解放 / renew 停止 / Map から削除) を行うが、
   * flush はしない (このターンの入力は inbox に残したまま次回に再実行させる)。
   * state を先に "stopping" にしておくことで、proc.stop() が引き起こす exit イベントが
   * 二重にクリーンアップを走らせない (exit ハンドラは state !== "stopping" のときだけ動く)
   */
  private async failSession(
    threadKey: string,
    proc: PiProcess,
    error: string | undefined,
  ): Promise<void> {
    const record = this.sessions.get(threadKey);
    if (record === undefined || record.process !== proc) return;

    record.state = "stopping";
    this.stopRenewTimer(record);

    // register 済み (kick で必ず register している) なので deliver できる。
    // Slack への通知が失敗してもセッションの畳み込みは続ける
    await this.router
      .deliver({
        thread_key: threadKey,
        text: `:warning: セッションが異常終了しました: ${error ?? "unknown error"}`,
      })
      .catch((err) => {
        this.logger.warn({ threadKey, err }, "failure notice delivery failed");
      });

    await this.store.leases.release(record.lease).catch((err) => {
      this.logger.warn({ threadKey, err }, "lease release failed");
    });
    await proc.stop();
    this.logger.warn(
      { threadKey, durationMs: Date.now() - record.startedAt },
      "session failed",
    );
    // activeSessionCount (テストの waitFor 等) がこのログの後で 0 になるよう、
    // Map からの削除はクリーンアップ完了後に行う
    this.sessions.delete(threadKey);
  }

  /** 未 prompt の item があれば prompt して true (drain は非破壊なので
   * promptedIds で除外する)。無ければ false */
  private async promptPending(
    threadKey: string,
    record: SessionRecord,
    proc: PiProcess,
  ): Promise<boolean> {
    const items = (await this.store.inbox.drain(threadKey)).filter(
      (i) => !record.promptedIds.has(i.id),
    );
    if (items.length === 0) return false;
    for (const i of items) record.promptedIds.add(i.id);
    record.turnEpoch += 1;
    proc.prompt(renderItems(items));
    this.logger.info({ threadKey, items: items.length }, "session continued");
    return true;
  }

  /** lease の renew を ttl/3 間隔で回す。false は排他喪失 = 別の保持者が動いて
   * いる可能性があるため、flush せずプロセスを止める (書き戻さない) */
  private startRenewTimer(threadKey: string, record: SessionRecord): void {
    const intervalMs = Math.max(1, Math.floor(this.leaseTtlMs / 3));
    const timer = setInterval(() => {
      void (async () => {
        if (this.sessions.get(threadKey) !== record) return;
        const ok = await this.store.leases.renew(record.lease, this.leaseTtlMs);
        if (ok) return;
        if (this.sessions.get(threadKey) !== record) return;
        this.logger.error(
          { threadKey, owner: this.owner },
          "lease renew failed; stopping session without flush",
        );
        record.state = "stopping";
        this.sessions.delete(threadKey);
        this.stopRenewTimer(record);
        await record.process?.stop();
      })().catch((err) => {
        this.logger.error({ threadKey, err }, "lease renew handling failed");
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

  private async loadChannelDoc(channelId: string): Promise<ChannelDoc | null> {
    try {
      return await this.configSource.channel(channelId);
    } catch (err) {
      // YAML の壊れで受信ループを止めない。既定動作 (mention 起動) に落とす
      this.logger.warn({ channelId, err }, "failed to load channel doc");
      return null;
    }
  }

  private resolveGates(doc: ChannelDoc | null): {
    gates: Gate[];
    combinator: GateCombinator;
  } {
    if (doc?.trigger === undefined) {
      // doc なし / trigger 未設定は既定 = mention のみ (session-model.md §5)
      return { gates: defaultGates(), combinator: "any" };
    }
    const specs = toGateSpecs(doc.trigger.gates, (message) =>
      this.logger.warn(message),
    );
    return {
      gates: specs.map((spec) => createGate(spec)),
      combinator: doc.trigger.combinator,
    };
  }

  /** リアクションは装飾なので、失敗してもセッションを止めない */
  private async safeReact(
    fn: () => Promise<void>,
    threadKey: string,
    label: string,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn({ threadKey, label, err }, "failed to add reaction");
    }
  }
}

/** app 共通 + ChannelDoc.systemPrompt + thread_key の指示 (session-runtime.md §2) */
function buildSystemPrompt(threadKey: string, doc: ChannelDoc | null): string {
  const parts = [APP_SYSTEM_PROMPT];
  if (doc?.systemPrompt !== undefined) parts.push(doc.systemPrompt.trim());
  parts.push(
    `When calling the reply tool, use exactly this thread_key: ${threadKey}`,
  );
  return parts.join("\n\n");
}

function prependContext(body: string, doc: ChannelDoc | null): string {
  const context = doc?.context;
  if (context === undefined || context.length === 0) return body;
  return `参考情報:\n${context.map((c) => c.trim()).join("\n\n")}\n\n${body}`;
}
