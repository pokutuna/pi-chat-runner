// live LLM e2e の共通ヘルパー (docs/design/local-dev.md §1)。
//
// LocalChat + 本物の pi 子プロセス + 実 LLM (Vertex AI) で Runner をライブラリとして
// 起動する。Slack も TUI も通さない。`E2E_LIVE_LLM` が設定されているときだけ走る —
// 実課金・実ネットワークなので、既定の `pnpm test` では describeLive が全て skip する。
//
// 認証情報等は `.env.local` (gitignored) から process.loadEnvFile で読む。既に
// プロセス env にある値は上書きされない (loadEnvFile の仕様) ので、CI や
// 一時的な env 指定が勝つ。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import pino from "pino";
import { describe } from "vitest";

import { createLocalChat } from "../../../src/chat/local/local-chat.js";
import { createLocalPlatform } from "../../../src/chat/local/platform.js";
import type {
  LocalChat,
  LoggedMessage,
} from "../../../src/chat/local/types.js";
import {
  resolveSystemConfig,
  SystemConfigSchema,
} from "../../../src/config/system-config.js";
import { startRunner } from "../../../src/runner.js";
import { createRuntimeConfig } from "../../../src/runtime/resolve.js";
import { createWorkdirStore } from "../../../src/state/agent/copy.js";
import { NoopWorkdirStore } from "../../../src/state/agent/noop.js";
import { InMemoryControlState } from "../../../src/state/control/backends/memory.js";
import type { ControlState } from "../../../src/state/control/interfaces.js";
import type { StaticConfig } from "./static-config-source.js";
import { StaticConfigSource } from "./static-config-source.js";

/** 実 LLM を叩くテストを走らせるかどうか。`pnpm run test:e2e` が立てる。 */
export const isLive =
  process.env.E2E_LIVE_LLM !== undefined && process.env.E2E_LIVE_LLM !== "";

if (isLive) {
  // .env.local に GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION /
  // GOOGLE_APPLICATION_CREDENTIALS / PI_AGENT_HOME を置く想定 (local-dev.md §1)。
  // 無くても既に env に入っていれば動くので、読めないことは失敗にしない。
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // ignore: env が既に揃っていれば起動できる
  }
}

/** 実 LLM テストの describe。gate off のときは skip として現れる (fail にしない)。 */
// 型を明示するのは、tsdown の d.ts 生成が vitest 内部の型名を参照できず TS4023 で落ちるため。
type LiveDescribe = ReturnType<typeof describe.skipIf>;
// oxlint-disable-next-line vitest/valid-describe-callback, vitest/valid-title -- describe を呼ばず skipIf の戻り値を再 export するだけ
export const describeLive: LiveDescribe = describe.skipIf(!isLive);

/** 1 ケースの上限。実 LLM + 実 pi は数十秒かかることがあり、
 * vitest.config.ts の既定 15s では足りない。 */
export const LIVE_TEST_TIMEOUT_MS = 180_000;

/** 返信待ちの既定上限。LIVE_TEST_TIMEOUT_MS より短くして、タイムアウト時に
 * 「何を待っていたか」のメッセージが出るようにする。 */
const DEFAULT_REPLY_TIMEOUT_MS = 150_000;

/** ポーリング間隔。実 LLM 相手なので細かく回す意味がない。 */
const POLL_INTERVAL_MS = 250;

/** e2e で共通に使うモデル。pi の canonical shorthand 形式 (provider prefix 必須)。 */
export const LIVE_MODEL = "google-vertex/gemini-3.5-flash";

export interface StartLiveRunnerOptions {
  /** 既存の LocalChat を使う (再起動をまたぐケース)。省略時は新規作成。 */
  chat?: LocalChat;
  /** chat 省略時の defaultChannelId。 */
  defaultChannelId?: string;
  /** chat 省略時の seq 開始値 (Inbox dedupe 回避。types.ts LocalChatOptions)。 */
  startSeq?: number;
  /** channels / agent ブロック相当 (TS オブジェクト)。 */
  config: StaticConfig;
  /** 省略時は InMemoryControlState。再起動をまたぐケースは sqlite を渡す。 */
  controlState?: ControlState;
  /** Workdir の退避先。省略時は退避なし (NoopWorkdirStore)。 */
  workdirDir?: string;
  /** pi を動かす workdir のルート。省略時は毎回新しい mkdtemp。
   *
   * 再起動をまたぐ再開では本番と同じく固定値を渡す必要がある: 復元される
   * session.jsonl には記録時の cwd が入っており、resume した pi はその実在を
   * 確かめる。Permission Model の allow パスは新しい workdirRoot 基準なので、
   * ルートが変わると旧 cwd の stat が ERR_ACCESS_DENIED で弾かれ pi が即死する。 */
  workdirRoot?: string;
  /** agent_end 後に追いメッセージを待つ時間 (ms)。省略時は Dispatcher の既定 3s。
   * linger 中の継続 / linger 満了後の再起動を切り分けるため、テストでは本番既定
   * より長くも短くもする (message-dispatch.md §7.3)。 */
  lingerMs?: number;
}

/** Runner の pino ログ 1 行。pino の JSON をそのままパースしたもの。 */
export interface LogRecord {
  level: number;
  time: number;
  msg: string;
  [key: string]: unknown;
}

export interface LiveRunner {
  chat: LocalChat;
  /** threadTs のスレッドに bot 返信が現れるまで待ち、その最初の 1 件を返す。 */
  waitForBotReply(
    threadTs: string,
    predicate?: (m: LoggedMessage) => boolean,
    timeoutMs?: number,
  ): Promise<LoggedMessage>;
  /** bot が ts に emoji を付けるまで待つ (Turn 状態のリアクション)。 */
  waitForReaction(ts: string, emoji: string, timeoutMs?: number): Promise<void>;
  /** ms の間 bot 返信が 1 件も増えないことを確かめる (Gate で止まる確認)。 */
  expectNoBotReply(ms: number): Promise<void>;
  /** この Runner が出した pino ログの全件 (debug 以上)。Dispatcher / Session の
   * 判断は返信本文に出ないものが多いので、ログで観測する。 */
  logs(): readonly LogRecord[];
  /** msg 一致 (+ 任意の述語) のログが現れるまで待ち、その 1 件を返す。 */
  waitForLog(
    msg: string,
    predicate?: (r: LogRecord) => boolean,
    timeoutMs?: number,
  ): Promise<LogRecord>;
  /** Runner に渡した Control State。Session レコードや Thread の束ねを直接覗く。 */
  controlState: ControlState;
}

/** Runner をライブラリとして起動する。startRunner に stop ハンドルは無いので、
 * 起動した Runner はテストファイルの終了まで生き続ける。 */
export async function startLiveRunner(
  opts: StartLiveRunnerOptions,
): Promise<LiveRunner> {
  const chat =
    opts.chat ??
    createLocalChat({
      ...(opts.defaultChannelId !== undefined
        ? { defaultChannelId: opts.defaultChannelId }
        : {}),
      ...(opts.startSeq !== undefined ? { startSeq: opts.startSeq } : {}),
    });

  // system ブロックのうち e2e で意味があるのは runtime.home (= PI_AGENT_HOME) だけ。
  // 残り (Permission Model の ON、GCP env の allowlist、pi の実パス解決) は
  // createRuntimeConfig / resolveSystemConfig のコード既定をそのまま使い、
  // 本番と同じ経路で RuntimeConfig を組み立てる。
  const system = resolveSystemConfig(
    SystemConfigSchema.parse({
      // home 未設定なら resolveSystemConfig のコード既定 "/home/agent" に落ちる。
      runtime:
        process.env.PI_AGENT_HOME !== undefined
          ? { home: process.env.PI_AGENT_HOME }
          : {},
    }),
    process.env,
  );
  const workdirRoot =
    opts.workdirRoot ??
    (await mkdtemp(join(tmpdir(), "pi-chat-runner-e2e-wd-")));

  // Dispatcher / Session のログを配列に溜める。LOG_LEVEL が指定されていれば
  // 併せて stdout にも流す (デバッグ時の従来どおりの見え方を残す)。
  const records: LogRecord[] = [];
  const printLevel = process.env.LOG_LEVEL;
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          records.push(JSON.parse(line) as LogRecord);
        } catch {
          // JSON 以外 (pino 以外の書き込み) は無視する
        }
      }
      if (printLevel !== undefined) process.stdout.write(text);
      callback();
    },
  });
  // 収集は常に debug まで ("dispatch debounced" / "inbox duplicate skip" が debug)。
  const logger = pino({ level: "debug" }, destination);

  const controlState = opts.controlState ?? new InMemoryControlState();

  await startRunner({
    chat: createLocalPlatform(chat),
    controlState,
    agentState: {
      workdir:
        opts.workdirDir !== undefined
          ? createWorkdirStore(opts.workdirDir, logger)
          : new NoopWorkdirStore(),
    },
    configSource: new StaticConfigSource(opts.config),
    runtime: createRuntimeConfig(system, {
      workdirRoot,
      baseEnv: process.env,
    }),
    ...(opts.lingerMs !== undefined ? { lingerMs: opts.lingerMs } : {}),
    logger,
  });

  function botMessagesIn(threadTs: string): LoggedMessage[] {
    return chat.log().filter((m) => m.sender.isSelf && m.threadTs === threadTs);
  }

  return {
    chat,
    controlState,
    logs: () => records,
    async waitForLog(msg, predicate, timeoutMs) {
      return await waitForValue(
        () => records.find((r) => r.msg === msg && (predicate?.(r) ?? true)),
        `log record ${JSON.stringify(msg)}` +
          (predicate !== undefined ? " matching the predicate" : "") +
          `; messages so far: ${JSON.stringify(records.map((r) => r.msg))}`,
        timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
      );
    },
    async waitForBotReply(threadTs, predicate, timeoutMs) {
      return await waitForValue(
        () => botMessagesIn(threadTs).find((m) => predicate?.(m) ?? true),
        `bot reply in thread ${threadTs}` +
          (predicate !== undefined ? " matching the predicate" : "") +
          `; log so far: ${JSON.stringify(chat.log().map((m) => [m.ts, m.threadTs, m.sender.isSelf, m.text.slice(0, 120)]))}`,
        timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
      );
    },
    async waitForReaction(ts, emoji, timeoutMs) {
      await waitForValue(
        () => chat.reactionsLog().find((r) => r.ts === ts && r.emoji === emoji),
        `bot reaction :${emoji}: on ${ts}; reactions so far: ${JSON.stringify(chat.reactionsLog())}`,
        timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
      );
    },
    async expectNoBotReply(ms) {
      const before = chat.log().filter((m) => m.sender.isSelf).length;
      await sleep(ms);
      const after = chat.log().filter((m) => m.sender.isSelf);
      if (after.length !== before) {
        throw new Error(
          `expected no bot reply within ${ms}ms, but got: ${JSON.stringify(after.slice(before).map((m) => m.text.slice(0, 200)))}`,
        );
      }
    },
  };
}

/** 条件が満たされるまでポーリングし、満たした値を返す。probe は同期・非同期どちらでもよい
 * (Control State を覗く待ち合わせが非同期なため)。 */
export async function waitForValue<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`timed out (${timeoutMs}ms) waiting for: ${label}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 「ts より後の投稿だけを見る」述語。LocalChat の ts はログ連番の文字列なので
 * 数値比較する (types.ts LoggedMessage)。質問より前の返信を拾わないために使う。 */
export function after(ts: string): (m: LoggedMessage) => boolean {
  return (m) => Number(m.ts) > Number(ts);
}

/** mention 起動だけの channels ブロック (多くのシナリオの土台)。 */
export function mentionOnlyChannels(channelId: string): StaticConfig {
  return {
    agent: { model: LIVE_MODEL },
    channels: [
      { channel: "default", trigger: { when: [{ kind: "mention" }] } },
      { channel: channelId, trigger: { when: [{ kind: "mention" }] } },
    ],
  };
}
