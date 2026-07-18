// LocalChat + fake-pi + startBridge の e2e smoke テスト (docs/design/local-dev.md §2)。
//
// bridge.test.ts は StubIngress + fakeWebClient (Slack 経路) を検証する。こちらは
// LocalChat core (src/ingress/local/local-chat.ts) を eventSource/poster/reactions/
// userResolver/fetchMessage の全注入元として使い、web (WebClient) なしで
// startBridge が起動できること (bridge.ts の 2 点の変更) を確認する。
//
// pi は test/session/runner.test.ts と同じ fake-pi (test/fixtures/fake-pi.mjs) を使う。
// store は InMemoryStateStore、workdir は一時ディレクトリ (runner.test.ts の流儀)。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { startBridge } from "../src/bridge.js";
import { FileConfigSource } from "../src/config/config-source.js";
import { createLocalChat } from "../src/ingress/local/local-chat.js";
import { InMemoryStateStore } from "../src/store/state/backends/memory.js";

const FAKE_PI = fileURLToPath(
  new URL("./fixtures/fake-pi.mjs", import.meta.url),
);
// mention トリガーの channel エントリを持つ既存 fixture (bridge.test.ts と共用)。
const CONFIG_PATH = fileURLToPath(
  new URL("./fixtures/config/channels.yaml", import.meta.url),
);
// reaction トリガー (kind: reaction, emoji: [eyes]) 専用の fixture。既存 fixture
// (config/channels.yaml) には reaction エントリがないため local 専用に新設した。
const REACTION_CONFIG_PATH = fileURLToPath(
  new URL("./fixtures/config-reaction/channels.yaml", import.meta.url),
);

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe("startBridge with LocalChat (no Slack)", () => {
  it("chat.post(mention) is answered by the bot and appears in chat.log()", async () => {
    const channelId = "C0000000001";
    const chat = createLocalChat({ defaultChannelId: channelId });
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-bridge-local-home-"),
    );
    const logger = pino({ level: "silent" });

    await startBridge({
      eventSource: chat.ingress,
      store: new InMemoryStateStore(),
      configSource: new FileConfigSource(CONFIG_PATH),
      piEntrypoint: FAKE_PI,
      agentHome,
      logger,
      poster: chat.poster,
      reactions: chat.reactions,
      userResolver: chat.userResolver,
      fetchMessage: chat.fetchMessage,
    });

    await chat.post("@bot local mode smoke test", { mentionsBot: true });

    await waitFor(
      () =>
        chat
          .log()
          .some(
            (m) => m.sender.isSelf && m.text.includes("local mode smoke test"),
          ),
      "bot reply appears in chat.log()",
    );

    const botReply = chat.log().find((m) => m.sender.isSelf);
    expect(botReply?.channelId).toBe(channelId);
    expect(botReply?.text).toContain("local mode smoke test");

    // check reaction (session-model.md §5) もログに記録される
    await waitFor(
      () => chat.reactionsLog().some((r) => r.emoji === "white_check_mark"),
      "check reaction recorded",
    );
  });

  it("chat.react(eyes) on a logged message triggers a session via fetchMessage (reaction gate)", async () => {
    const channelId = "C0000000001";
    const chat = createLocalChat({ defaultChannelId: channelId });
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-bridge-local-reaction-home-"),
    );
    const logger = pino({ level: "silent" });

    await startBridge({
      eventSource: chat.ingress,
      store: new InMemoryStateStore(),
      configSource: new FileConfigSource(REACTION_CONFIG_PATH),
      piEntrypoint: FAKE_PI,
      agentHome,
      logger,
      poster: chat.poster,
      reactions: chat.reactions,
      userResolver: chat.userResolver,
      fetchMessage: chat.fetchMessage,
    });

    // reaction gate (mentionsBot: false でよい — トリガーは reaction 側)。gate 自体は
    // trigger.when: reaction のみなので、この投稿単体は起動しない。
    const posted = await chat.post("please investigate this alert");

    // 人間が :eyes: を付与 — bridge が fetchMessage 経由で対象メッセージ本文を取得し
    // セッションを起動する (session-model.md §5「人間によるリアクション起動」)。
    await chat.react(posted.ts, "eyes");

    await waitFor(
      () =>
        chat
          .log()
          .some(
            (m) =>
              m.sender.isSelf &&
              m.text.includes("please investigate this alert"),
          ),
      "bot reply to reaction-triggered session appears in chat.log()",
    );

    const botReply = chat.log().find((m) => m.sender.isSelf);
    expect(botReply?.channelId).toBe(channelId);
    expect(botReply?.text).toContain("please investigate this alert");
  });

  it("throws when web is omitted and an injection (fetchMessage) is missing", async () => {
    const chat = createLocalChat({ defaultChannelId: "C0000000001" });
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-bridge-local-invalid-home-"),
    );
    const logger = pino({ level: "silent" });

    await expect(
      startBridge({
        eventSource: chat.ingress,
        store: new InMemoryStateStore(),
        configSource: new FileConfigSource(CONFIG_PATH),
        piEntrypoint: FAKE_PI,
        agentHome,
        logger,
        poster: chat.poster,
        reactions: chat.reactions,
        userResolver: chat.userResolver,
        // fetchMessage は意図的に注入しない
      }),
    ).rejects.toThrow(/fetchMessage/);
  });
});
