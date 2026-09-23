// srt sandbox を実 pi + 実 LLM で通す (docs/design/runtime.md §5.5、PLAN §3-2)。
//
// test/e2e-sandbox/ (probe-pi) は Runner の spawn 経路と srt の遮断を決定的に検証する。
// こちらは pi 本体の挙動 — pi の bash tool が sandbox 内で動くこと、pi 自身の LLM 呼び出し
// (Vertex AI: undici の EnvHttpProxyAgent / @google/genai の ADC) が srt の proxy 越しに
// 通ること — を見る。LLM に「このコマンドを実行して出力を `code=<n> out=<stdout>` の形で
// 返して」と頼むので assertion は緩く、遮断の項目には対照 (positive control) を添える。
//
// 前提: Linux + bwrap/socat/rg + ADC (GOOGLE_APPLICATION_CREDENTIALS)。CI では回さない。
// 例: docker build --target e2e … の image に .env.local と ADC ファイルを mount し
// `E2E_LIVE_LLM=1 pnpm exec vitest run test/e2e/sandbox.test.ts` を回す。

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ChannelEntry } from "../../src/config/channel-config.js";
import {
  type SandboxAdditions,
  SandboxRulesSchema,
} from "../../src/config/sandbox-config.js";
import {
  isLive,
  LIVE_MODEL,
  LIVE_TEST_TIMEOUT_MS,
  startLiveRunner,
} from "./helpers/live.js";

// srt は Linux でしか起動しない (RuntimeConfig.srtEntrypoint が Linux 以外で undefined)
const skip = !isLive || process.platform !== "linux";
// oxlint-disable-next-line vitest/valid-describe-callback, vitest/valid-title -- describe を呼ばず skipIf の戻り値を束ねるだけ
const describeLiveSandbox = describe.skipIf(skip);

/** pi 自身が Vertex AI に到達するために要る最小の allowlist。ADC のトークン取得
 * (oauth2) と生成 API (global / regional endpoint)。これ以外は全部遮断 */
const VERTEX_ONLY = SandboxRulesSchema.parse({
  network: {
    allowedDomains: [
      "oauth2.googleapis.com:443",
      "aiplatform.googleapis.com:443",
      "*.aiplatform.googleapis.com:443",
    ],
  },
});

const CURL_EXAMPLE =
  "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://example.com";
const CURL_DIRECT_IP =
  "curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 10 https://1.1.1.1";

/** LLM への依頼文。bash tool で 1 コマンドを実行し、結果を機械的に読める形で返させる */
function runAndReport(command: string): string {
  return [
    "次の bash コマンドをそのまま 1 回だけ実行してください。",
    "```",
    command,
    "```",
    "返答は説明を付けず、次の 1 行だけにしてください:",
    "`code=<終了コード> out=<標準出力をそのまま>`",
    "失敗しても書き換えたり再試行したりせず、その結果を同じ形式で返してください。",
  ].join("\n");
}

function mention(
  channel: string,
  sandbox?: SandboxAdditions | false,
): ChannelEntry {
  return {
    channel,
    trigger: { when: [{ kind: "mention" }] },
    ...(sandbox !== undefined ? { agent: { sandbox } } : {}),
  };
}

const ALLOWED = "C_LIVE_SANDBOX_ALLOWED";
const DENIED = "C_LIVE_SANDBOX_DENIED";
const OPEN = "C_LIVE_SANDBOX_OPEN";
const HIDDEN = "C_LIVE_SANDBOX_HIDDEN";
const VISIBLE = "C_LIVE_SANDBOX_VISIBLE";

describeLiveSandbox("live: srt sandbox (実 pi の bash tool 経由)", () => {
  it(
    "allowedDomains にあるホストだけ curl が通る (並行する 2 Channel で A 成功・B 失敗)",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: ALLOWED,
        config: {
          agent: {
            model: LIVE_MODEL,
            sandbox: VERTEX_ONLY,
          },
          channels: [
            mention("default"),
            mention(ALLOWED, { network: { allowedDomains: ["example.com"] } }),
            mention(DENIED),
          ],
        },
      });

      // #5: 並行起動。A は example.com が許可、B は Vertex だけ
      const [a, b] = await Promise.all([
        runner.chat.post(runAndReport(CURL_EXAMPLE), {
          channelId: ALLOWED,
          mentionsBot: true,
        }),
        runner.chat.post(runAndReport(CURL_EXAMPLE), {
          channelId: DENIED,
          mentionsBot: true,
        }),
      ]);
      const [replyA, replyB] = await Promise.all([
        runner.waitForBotReply(a.ts, (m) => /code=/.test(m.text)),
        runner.waitForBotReply(b.ts, (m) => /code=/.test(m.text)),
      ]);
      // #1: 許可側は 200
      expect(replyA.text).toMatch(/code=0/);
      expect(replyA.text).toMatch(/out=200/);
      // 対照: 未許可側は proxy に 403 で拒まれ curl が失敗する
      expect(replyB.text).not.toMatch(/code=0\b/);
      expect(replyB.text).not.toMatch(/out=200/);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "proxy を迂回した IP 直打ちは netns で到達できない (sandbox: false なら通る)",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: DENIED,
        config: {
          agent: {
            model: LIVE_MODEL,
            sandbox: VERTEX_ONLY,
          },
          channels: [mention("default"), mention(DENIED), mention(OPEN, false)],
        },
      });

      // #2: sandbox 内では netns の外に出られない
      const blocked = await runner.chat.post(runAndReport(CURL_DIRECT_IP), {
        channelId: DENIED,
        mentionsBot: true,
      });
      const blockedReply = await runner.waitForBotReply(blocked.ts, (m) =>
        /code=/.test(m.text),
      );
      expect(blockedReply.text).not.toMatch(/code=0\b/);

      // 対照: sandbox: false の Channel では同じコマンドが通る
      const open = await runner.chat.post(runAndReport(CURL_DIRECT_IP), {
        channelId: OPEN,
        mentionsBot: true,
      });
      const openReply = await runner.waitForBotReply(open.ts, (m) =>
        /code=/.test(m.text),
      );
      expect(openReply.text).toMatch(/code=0/);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "自分の workdir には書け、他 Session の workdir には書けない",
    async () => {
      const workdirRoot = await realpath(
        await mkdtemp(join(tmpdir(), "pi-chat-runner-e2e-sandbox-")),
      );
      const runner = await startLiveRunner({
        defaultChannelId: ALLOWED,
        workdirRoot,
        config: {
          agent: {
            model: LIVE_MODEL,
            sandbox: VERTEX_ONLY,
          },
          channels: [mention("default"), mention(ALLOWED), mention(DENIED)],
        },
      });

      // Session A を先に立てて workdir を確定させる (workdir は <root>/<channel>/<ts>)
      const a = await runner.chat.post(
        runAndReport("touch ./own-write-probe && echo ok"),
        { channelId: ALLOWED, mentionsBot: true },
      );
      const replyA = await runner.waitForBotReply(a.ts, (m) =>
        /code=/.test(m.text),
      );
      // 対照: 自分の workdir には書ける
      expect(replyA.text).toMatch(/code=0/);
      const workdirA = join(workdirRoot, ALLOWED, a.ts);

      // #3: 他 Session の workdir は read-only (EROFS)
      const b = await runner.chat.post(
        runAndReport(`touch ${workdirA}/cross-write-probe 2>&1`),
        { channelId: DENIED, mentionsBot: true },
      );
      const replyB = await runner.waitForBotReply(b.ts, (m) =>
        /code=/.test(m.text),
      );
      expect(replyB.text).not.toMatch(/code=0\b/);
      expect(replyB.text).toMatch(/Read-only file system|Permission denied/);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "credentials.envVars deny の Channel では env が空、無い Channel では見える",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: HIDDEN,
        config: {
          agent: {
            model: LIVE_MODEL,
            env: { GH_TOKEN: "ghp_live_probe_secret" },
            sandbox: VERTEX_ONLY,
          },
          channels: [
            mention("default"),
            mention(HIDDEN, {
              credentials: { envVars: [{ name: "GH_TOKEN", mode: "deny" }] },
            }),
            mention(VISIBLE),
          ],
        },
      });

      // #6: deny の Channel では値が見えない
      const hidden = await runner.chat.post(
        runAndReport('echo -n "${GH_TOKEN-unset}"'),
        { channelId: HIDDEN, mentionsBot: true },
      );
      const hiddenReply = await runner.waitForBotReply(hidden.ts, (m) =>
        /code=/.test(m.text),
      );
      expect(hiddenReply.text).not.toContain("ghp_live_probe_secret");

      // 対照: deny の無い Channel では値がそのまま見える
      const visible = await runner.chat.post(
        runAndReport('echo -n "$GH_TOKEN"'),
        { channelId: VISIBLE, mentionsBot: true },
      );
      const visibleReply = await runner.waitForBotReply(visible.ts, (m) =>
        /code=/.test(m.text),
      );
      expect(visibleReply.text).toContain("ghp_live_probe_secret");
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
