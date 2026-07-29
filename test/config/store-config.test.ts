import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadStoreConfig,
  StoreConfigSchema,
} from "../../src/config/store-config.js";

describe("StoreConfigSchema", () => {
  it("accepts a fully populated config", () => {
    const result = StoreConfigSchema.safeParse({
      backend: "sqlite",
      sqlite: { path: "/data/state.db" },
      firestore: {
        projectId: "my-project",
        database: "my-db",
        rootDoc: "myapp/agent",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object and fills in defaults", () => {
    const data = StoreConfigSchema.parse({});
    expect(data.backend).toBe("memory");
    expect(data.sqlite.path).toBe("/tmp/pi-chat-runner/state.db");
    expect(data.firestore.projectId).toBe("");
    expect(data.firestore.database).toBe("(default)");
    expect(data.firestore.rootDoc).toBe("pi-chat-runner/default");
  });

  it("rejects unknown top-level keys", () => {
    expect(StoreConfigSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("rejects unknown keys under sqlite", () => {
    expect(
      StoreConfigSchema.safeParse({ sqlite: { unknown: true } }).success,
    ).toBe(false);
  });

  it("rejects a rootDoc that is not a document path", () => {
    for (const rootDoc of ["", "collection-only", "a/b/c", "a//b", "/a/b"]) {
      expect(
        StoreConfigSchema.safeParse({ firestore: { rootDoc } }).success,
        `rootDoc: ${JSON.stringify(rootDoc)}`,
      ).toBe(false);
    }
  });

  it("accepts a nested rootDoc document path", () => {
    expect(
      StoreConfigSchema.safeParse({
        firestore: { rootDoc: "apps/pi/envs/prod" },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown keys under firestore", () => {
    expect(
      StoreConfigSchema.safeParse({ firestore: { unknown: true } }).success,
    ).toBe(false);
  });

  it("rejects an invalid backend", () => {
    expect(StoreConfigSchema.safeParse({ backend: "redis" }).success).toBe(
      false,
    );
  });
});

describe("loadStoreConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "store-config-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns default (memory) when agent.yaml does not exist", async () => {
    expect(await loadStoreConfig(join(dir, "agent.yaml"))).toEqual({
      backend: "memory",
      sqlite: { path: "/tmp/pi-chat-runner/state.db" },
      firestore: {
        projectId: "",
        database: "(default)",
        rootDoc: "pi-chat-runner/default",
      },
    });
  });

  it("returns default (memory) when agent.yaml has no store block", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      "agent:\n  turnTimeoutMs: 600000\n",
    );
    expect(await loadStoreConfig(join(dir, "agent.yaml"))).toEqual({
      backend: "memory",
      sqlite: { path: "/tmp/pi-chat-runner/state.db" },
      firestore: {
        projectId: "",
        database: "(default)",
        rootDoc: "pi-chat-runner/default",
      },
    });
  });

  it("returns default (memory) when agent.yaml contains only comments", async () => {
    await writeFile(join(dir, "agent.yaml"), "# just a comment\n");
    expect(await loadStoreConfig(join(dir, "agent.yaml"))).toEqual({
      backend: "memory",
      sqlite: { path: "/tmp/pi-chat-runner/state.db" },
      firestore: {
        projectId: "",
        database: "(default)",
        rootDoc: "pi-chat-runner/default",
      },
    });
  });

  it("parses a valid store block with an explicit sqlite backend and path", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      [
        "store:",
        "  backend: sqlite",
        "  sqlite:",
        "    path: /data/state.db",
      ].join("\n"),
    );
    expect(await loadStoreConfig(join(dir, "agent.yaml"))).toEqual({
      backend: "sqlite",
      sqlite: { path: "/data/state.db" },
      firestore: {
        projectId: "",
        database: "(default)",
        rootDoc: "pi-chat-runner/default",
      },
    });
  });

  it("resolves ${env.X} references against the given env before validating", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      [
        "store:",
        "  backend: ${env.STORE_BACKEND:-memory}",
        "  sqlite:",
        "    path: ${env.SQLITE_PATH:-/tmp/pi-chat-runner/state.db}",
      ].join("\n"),
    );
    const result = await loadStoreConfig(join(dir, "agent.yaml"), {
      STORE_BACKEND: "sqlite",
      SQLITE_PATH: "/var/data/state.db",
    });
    expect(result).toEqual({
      backend: "sqlite",
      sqlite: { path: "/var/data/state.db" },
      firestore: {
        projectId: "",
        database: "(default)",
        rootDoc: "pi-chat-runner/default",
      },
    });
  });

  it("parses a firestore block with env refs, falling back to defaults", async () => {
    await writeFile(
      join(dir, "agent.yaml"),
      [
        "store:",
        "  backend: firestore",
        "  firestore:",
        "    database: ${env.FIRESTORE_DATABASE:-(default)}",
        "    rootDoc: ${env.FIRESTORE_ROOT_DOC:-pi-chat-runner/default}",
      ].join("\n"),
    );
    expect(
      await loadStoreConfig(join(dir, "agent.yaml"), {
        FIRESTORE_ROOT_DOC: "myapp/agent",
      }),
    ).toEqual({
      backend: "firestore",
      sqlite: { path: "/tmp/pi-chat-runner/state.db" },
      firestore: {
        projectId: "",
        database: "(default)",
        rootDoc: "myapp/agent",
      },
    });
  });

  it("throws with the file path for malformed YAML", async () => {
    await writeFile(join(dir, "agent.yaml"), "store:\n  - broken: [\n");
    await expect(loadStoreConfig(join(dir, "agent.yaml"))).rejects.toThrow(
      /agent\.yaml/,
    );
  });

  it("throws with the file path and zod issue for an invalid backend value", async () => {
    await writeFile(join(dir, "agent.yaml"), "store:\n  backend: redis\n");
    await expect(loadStoreConfig(join(dir, "agent.yaml"))).rejects.toThrow(
      /agent\.yaml/,
    );
  });
});
