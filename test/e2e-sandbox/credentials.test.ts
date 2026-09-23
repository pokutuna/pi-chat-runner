// credentials.envVars (srt) で Channel 単位に env を隠す (config.md §3.2)。
import { expect, it } from "vitest";

import { SandboxRulesSchema } from "../../src/config/sandbox-config.js";
import {
  describeSandbox,
  mentionChannels,
  SANDBOX_TEST_TIMEOUT_MS,
  startSandboxRunner,
} from "./helpers/sandbox-runner.js";

const HIDDEN = "C_CRED_HIDDEN";
const VISIBLE = "C_CRED_VISIBLE";

describeSandbox("sandbox e2e: credentials", () => {
  it(
    "credentials.envVars deny の Channel では env が空、無い Channel では見える",
    async () => {
      const runner = await startSandboxRunner({
        agent: {
          env: { GH_TOKEN: "ghp_probe_secret" },
          sandbox: SandboxRulesSchema.parse({}),
        },
        channels: mentionChannels(
          {
            channel: HIDDEN,
            trigger: { when: [{ kind: "mention" }] },
            agent: {
              sandbox: {
                credentials: { envVars: [{ name: "GH_TOKEN", mode: "deny" }] },
              },
            },
          },
          VISIBLE,
        ),
      });

      const hidden = await runner.probe(HIDDEN, [
        'echo -n "${GH_TOKEN-unset}"',
      ]);
      expect(hidden.results[0]?.out).not.toContain("ghp_probe_secret");

      // 対照: deny の無い Channel では値がそのまま見える
      const visible = await runner.probe(VISIBLE, ['echo -n "$GH_TOKEN"']);
      expect(visible.results[0]?.out).toBe("ghp_probe_secret");
    },
    SANDBOX_TEST_TIMEOUT_MS,
  );
});
