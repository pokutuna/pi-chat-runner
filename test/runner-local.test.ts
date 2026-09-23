// LocalChat + fake-pi + startRunner の e2e smoke テスト (docs/design/local-dev.md §2)。
//
// runner.test.ts は StubIngress + fakeWebClient (Slack 経路) を検証する。こちらは
// LocalChat core (src/chat/local/local-chat.ts) を createLocalPlatform で
// ChatPlatform に束ねたものを渡し、Slack を一切通さずに startRunner が起動できる
// ことを確認する。
//
// pi は test/session/session.test.ts と同じ fake-pi (test/fixtures/fake-pi.mjs) を使う。
// Control State は InMemoryControlState、workdir は退避なし (NoopWorkdirStore)。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { createLocalChat } from "../src/chat/local/local-chat.js";
import { createLocalPlatform } from "../src/chat/local/platform.js";
import type { ChatPlatform } from "../src/chat/platform.js";
import { FileConfigSource } from "../src/config/config-source.js";
import { startRunner } from "../src/runner.js";
import { NoopWorkdirStore } from "../src/state/agent/noop.js";
import { InMemoryControlState } from "../src/state/control/backends/memory.js";

/** RuntimeConfig.workdirRoot は必須。これらのテストは workdir の中身を検証しない
 * ため、これまでの既定値をそのまま使う。 */
const DEFAULT_WORKDIR_ROOT = "/tmp/pi-chat-runner/sessions";

const FAKE_PI = fileURLToPath(
  new URL("./fixtures/fake-pi.mjs", import.meta.url),
);
// mention トリガーの channel エントリを持つ既存 fixture (runner.test.ts と共用)。
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

describe("startRunner with the local ChatPlatform (no Slack)", () => {
  it("chat.post(mention) is answered by the bot and appears in chat.log()", async () => {
    const channelId = "C0000000001";
    const chat = createLocalChat({ defaultChannelId: channelId });
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-runner-local-home-"),
    );
    const logger = pino({ level: "silent" });

    await startRunner({
      chat: createLocalPlatform(chat),
      controlState: new InMemoryControlState(),
      agentState: { workdir: new NoopWorkdirStore() },
      configSource: new FileConfigSource(CONFIG_PATH),
      runtime: {
        piEntrypoint: FAKE_PI,
        agentHome,
        workdirRoot: DEFAULT_WORKDIR_ROOT,
      },
      logger,
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

    // check reaction (session-model.md §7.2) もログに記録される
    await waitFor(
      () => chat.reactionsLog().some((r) => r.emoji === "white_check_mark"),
      "check reaction recorded",
    );
  });

  it("chat.react(eyes) on a logged message triggers a session via fetchMessage (reaction gate)", async () => {
    const channelId = "C0000000001";
    const chat = createLocalChat({ defaultChannelId: channelId });
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-runner-local-reaction-home-"),
    );
    const logger = pino({ level: "silent" });

    await startRunner({
      chat: createLocalPlatform(chat),
      controlState: new InMemoryControlState(),
      agentState: { workdir: new NoopWorkdirStore() },
      configSource: new FileConfigSource(REACTION_CONFIG_PATH),
      runtime: {
        piEntrypoint: FAKE_PI,
        agentHome,
        workdirRoot: DEFAULT_WORKDIR_ROOT,
      },
      logger,
    });

    // reaction gate (mentionsBot: false でよい — トリガーは reaction 側)。gate 自体は
    // trigger.when: reaction のみなので、この投稿単体は起動しない。
    const posted = await chat.post("please investigate this alert");

    // 人間が :eyes: を付与 — Runner が fetchMessage 経由で対象メッセージ本文を取得し
    // セッションを起動する (config.md §4.1 の `kind: reaction`)。
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

  it("throws when the ChatPlatform is missing a seam (fetchMessage)", async () => {
    const chat = createLocalChat({ defaultChannelId: "C0000000001" });
    const agentHome = await mkdtemp(
      join(tmpdir(), "pi-chat-runner-runner-local-invalid-home-"),
    );
    const logger = pino({ level: "silent" });

    // fetchMessage を意図的に落とした ChatPlatform。型では必須なので、JS から
    // 呼ぶライブラリ利用や独自実装で欠けたときの fail-loud を検証するために
    // 明示的に外す
    const { fetchMessage: _omitted, ...incomplete } = createLocalPlatform(chat);

    await expect(
      startRunner({
        chat: incomplete as ChatPlatform,
        controlState: new InMemoryControlState(),
        agentState: { workdir: new NoopWorkdirStore() },
        configSource: new FileConfigSource(CONFIG_PATH),
        runtime: {
          piEntrypoint: FAKE_PI,
          agentHome,
          workdirRoot: DEFAULT_WORKDIR_ROOT,
        },
        logger,
      }),
    ).rejects.toThrow(/fetchMessage/);
  });
});
