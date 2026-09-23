// ネットワーク遮断 (runtime.md §5.5): FQDN allowlist と netns。
// 「全部 blocked」を強度と読まないため、各項目に対照 (positive control) を添える。
import { expect, it } from "vitest";

import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";
import {
  describeSandbox,
  mentionChannels,
  SANDBOX_TEST_TIMEOUT_MS,
  startSandboxRunner,
} from "./helpers/sandbox-runner.js";

const ALLOWED = "C_NET_ALLOWED";
const DENIED = "C_NET_DENIED";
const OPEN = "C_NET_OPEN";

const CURL_EXAMPLE =
  "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://example.com";
// proxy を迂回して IP 直打ち。netns が切れていれば到達できない
const CURL_DIRECT_IP =
  "curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 10 https://1.1.1.1";

describeSandbox("sandbox e2e: network", () => {
  it(
    "allowedDomains にあるホストだけ HTTPS が通り、無いホストは proxy に拒まれる",
    async () => {
      const runner = await startSandboxRunner({
        agent: {
          sandbox: SandboxRulesSchema.parse({
            network: { allowedDomains: [] },
          }),
        },
        channels: mentionChannels(
          {
            channel: ALLOWED,
            trigger: { when: [{ kind: "mention" }] },
            agent: {
              sandbox: { network: { allowedDomains: ["example.com"] } },
            },
          },
          DENIED,
        ),
      });

      const allowed = await runner.probe(ALLOWED, [CURL_EXAMPLE]);
      expect(allowed.results[0]).toMatchObject({ code: 0, out: "200" });

      // 対照: 同じコマンド、allowedDomains 無し → CONNECT が 403 で curl は失敗する
      const denied = await runner.probe(DENIED, [CURL_EXAMPLE]);
      expect(denied.results[0]?.code).not.toBe(0);
      expect(denied.results[0]?.out).not.toBe("200");
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );

  it(
    "proxy を迂回した IP 直打ちは netns で到達できない (sandbox: false なら通る)",
    async () => {
      const runner = await startSandboxRunner({
        agent: {
          sandbox: SandboxRulesSchema.parse({
            network: { allowedDomains: ["example.com"] },
          }),
        },
        channels: mentionChannels(ALLOWED, {
          channel: OPEN,
          trigger: { when: [{ kind: "mention" }] },
          agent: { sandbox: false },
        }),
      });

      const sandboxed = await runner.probe(ALLOWED, [CURL_DIRECT_IP]);
      expect(sandboxed.results[0]?.code).not.toBe(0);

      // 対照: sandbox: false の Channel では同じコマンドが成功する
      const open = await runner.probe(OPEN, [CURL_DIRECT_IP]);
      expect(open.results[0]?.code).toBe(0);
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );

  it(
    "許可の違う 2 つの Channel を並行に起動しても互いの allowlist が混ざらない",
    async () => {
      const runner = await startSandboxRunner({
        agent: {
          sandbox: SandboxRulesSchema.parse({
            network: { allowedDomains: [] },
          }),
        },
        channels: mentionChannels(
          {
            channel: ALLOWED,
            trigger: { when: [{ kind: "mention" }] },
            agent: {
              sandbox: { network: { allowedDomains: ["example.com"] } },
            },
          },
          DENIED,
        ),
      });

      const [a, b] = await Promise.all([
        runner.probe(ALLOWED, [CURL_EXAMPLE]),
        runner.probe(DENIED, [CURL_EXAMPLE]),
      ]);
      expect(a.results[0]).toMatchObject({ code: 0, out: "200" });
      expect(b.results[0]?.code).not.toBe(0);
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );
});
