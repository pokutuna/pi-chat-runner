import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  loadSandboxRuleFile,
  mergeSandboxAdditions,
  SandboxAdditionsSchema,
  type SandboxRules,
  SandboxRulesSchema,
} from "../../src/config/sandbox-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_DIR = join(__dirname, "..", "fixtures", "config-sandbox", "rules");

function rules(overrides: Partial<SandboxRules> = {}): SandboxRules {
  return SandboxRulesSchema.parse({
    network: { allowedDomains: ["api.example.com:443"] },
    ...overrides,
  });
}

describe("SandboxRulesSchema", () => {
  it("fills omitted network/filesystem arrays with [] and keeps other srt keys", () => {
    const parsed = SandboxRulesSchema.parse({
      network: { allowedDomains: ["github.com"], strictAllowlist: true },
    });
    expect(parsed.network.allowedDomains).toEqual(["github.com"]);
    expect(parsed.network.deniedDomains).toEqual([]);
    expect(parsed.network.strictAllowlist).toBe(true);
    expect(parsed.filesystem).toEqual({
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
    });
  });

  it("accepts an empty object (deny-all network, no fs rules)", () => {
    const parsed = SandboxRulesSchema.parse({});
    expect(parsed.network.allowedDomains).toEqual([]);
  });

  it("rejects filesystem.disabled: true", () => {
    const result = SandboxRulesSchema.safeParse({
      filesystem: { disabled: true },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["filesystem", "disabled"]);
  });

  it.each(["enableWeakerNestedSandbox", "enableWeakerNetworkIsolation"])(
    "rejects %s: true",
    (flag) => {
      const result = SandboxRulesSchema.safeParse({ [flag]: true });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual([flag]);
    },
  );

  it("reports srt schema violations with their path", () => {
    const result = SandboxRulesSchema.safeParse({
      network: { allowedDomains: ["not a domain!"] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([
      "network",
      "allowedDomains",
      0,
    ]);
  });

  it("rejects a non-object network", () => {
    const result = SandboxRulesSchema.safeParse({ network: ["github.com"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["network"]);
  });
});

describe("SandboxAdditionsSchema", () => {
  it("accepts the eight additive arrays", () => {
    const result = SandboxAdditionsSchema.safeParse({
      network: { allowedDomains: ["a"], deniedDomains: ["b"] },
      filesystem: {
        allowRead: ["/r"],
        allowWrite: ["/w"],
        denyRead: ["/dr"],
        denyWrite: ["/dw"],
      },
      credentials: {
        envVars: [{ name: "GH_TOKEN", mode: "deny" }],
        files: [{ path: "~/.netrc", mode: "deny" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects scalar keys and non-additive arrays (strict)", () => {
    for (const input of [
      { network: { strictAllowlist: true } },
      { filesystem: { disabled: true } },
      { credentials: { awsPairs: [] } },
      { enableWeakerNestedSandbox: true },
    ]) {
      expect(SandboxAdditionsSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("mergeSandboxAdditions", () => {
  it("appends in base order, dedupes, and leaves other keys untouched", () => {
    const base = rules({
      network: {
        allowedDomains: ["a.example.com", "b.example.com"],
        deniedDomains: [],
        strictAllowlist: true,
      },
    });
    const merged = mergeSandboxAdditions(base, {
      network: {
        allowedDomains: ["b.example.com", "c.example.com"],
        deniedDomains: ["x.example.com"],
      },
      filesystem: { allowRead: ["/data"], denyWrite: ["/data"] },
    });
    expect(merged.network.allowedDomains).toEqual([
      "a.example.com",
      "b.example.com",
      "c.example.com",
    ]);
    expect(merged.network.deniedDomains).toEqual(["x.example.com"]);
    expect(merged.network.strictAllowlist).toBe(true);
    expect(merged.filesystem.allowRead).toEqual(["/data"]);
    expect(merged.filesystem.denyWrite).toEqual(["/data"]);
    expect(merged.filesystem.allowWrite).toEqual([]);
  });

  it("returns an equal config for empty additions", () => {
    const base = rules();
    expect(mergeSandboxAdditions(base, {})).toEqual(base);
  });

  it("unions credentials by name/path and collapses identical duplicates", () => {
    const base = rules({
      credentials: { envVars: [{ name: "GH_TOKEN", mode: "deny" }] },
    });
    const merged = mergeSandboxAdditions(base, {
      credentials: {
        envVars: [
          { name: "GH_TOKEN", mode: "deny" },
          { name: "NPM_TOKEN", mode: "deny" },
        ],
        files: [{ path: "~/.netrc", mode: "deny" }],
      },
    });
    expect(merged.credentials?.envVars?.map((e) => e.name)).toEqual([
      "GH_TOKEN",
      "NPM_TOKEN",
    ]);
    expect(merged.credentials?.files?.map((f) => f.path)).toEqual(["~/.netrc"]);
  });

  it("throws when the same credential name is added with different content", () => {
    const base = rules({
      credentials: { envVars: [{ name: "GH_TOKEN", mode: "deny" }] },
    });
    expect(() =>
      mergeSandboxAdditions(base, {
        credentials: {
          envVars: [{ name: "GH_TOKEN", mode: "deny", extract: "x" }],
        },
      }),
    ).toThrow(/credentials\.envVars.*GH_TOKEN.*different content/);
  });

  it("re-validates the merged result with the srt schema", () => {
    expect(() =>
      mergeSandboxAdditions(rules(), {
        credentials: { envVars: [{ name: "GH_TOKEN", mode: "bogus" }] },
      }),
    ).toThrow(/merged sandbox rules are invalid/);
  });
});

describe("loadSandboxRuleFile", () => {
  it("reads a JSON file and normalizes it", async () => {
    const loaded = await loadSandboxRuleFile(join(RULES_DIR, "base.json"));
    expect(loaded.network.allowedDomains).toEqual([
      "oauth2.googleapis.com:443",
      "aiplatform.googleapis.com:443",
    ]);
    expect(loaded.network.strictAllowlist).toBe(true);
    expect(loaded.filesystem.denyRead).toEqual(["~/.ssh"]);
    expect(loaded.filesystem.allowWrite).toEqual([]);
  });

  it("reads a YAML file", async () => {
    const loaded = await loadSandboxRuleFile(join(RULES_DIR, "base.yaml"));
    expect(loaded.network.allowedDomains).toEqual([
      "aiplatform.googleapis.com:443",
    ]);
  });

  it("throws with the path when the file is missing", async () => {
    const path = join(RULES_DIR, "missing.json");
    await expect(loadSandboxRuleFile(path)).rejects.toThrow(path);
  });

  it("throws with the path and issue for invalid rules", async () => {
    const path = join(RULES_DIR, "..", "..", "config-sandbox-invalid.json");
    await expect(loadSandboxRuleFile(path)).rejects.toThrow(
      /filesystem\.disabled/,
    );
  });
});
