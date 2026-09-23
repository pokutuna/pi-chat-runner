// Gate の種別ごとの起動判定 (docs/design/config.md §4)。
//
// keyword / reaction / DM 無効 / bot 送信者の 4 つを実 Agent で確認する。
// それぞれ Channel を分け、1 つの Runner に全 Channel のエントリを持たせる
// (Channel ごとに Session も Control State のキーも分かれる)。

import { expect, it } from "vitest";

import {
  describeLive,
  LIVE_MODEL,
  LIVE_TEST_TIMEOUT_MS,
  startLiveRunner,
} from "./helpers/live.js";
import type { StaticConfig } from "./helpers/static-config-source.js";

const KEYWORD_CHANNEL_ID = "C_E2E_GATE_KEYWORD";
const REACTION_CHANNEL_ID = "C_E2E_GATE_REACTION";
const DM_CHANNEL_ID = "D_E2E_GATE_DM";
const BOT_CHANNEL_ID = "C_E2E_GATE_BOT";

const CONFIG: StaticConfig = {
  agent: { model: LIVE_MODEL },
  channels: [
    { channel: "default", trigger: { when: [{ kind: "mention" }] } },
    // dm エントリを when: [] で置くと DM は明示的に無効 (config.md §3.1)。
    { channel: "dm", trigger: { when: [] } },
    {
      channel: KEYWORD_CHANNEL_ID,
      trigger: {
        when: [
          { kind: "keyword", pattern: "([Hh]elp|エラー)" },
          { kind: "mention" },
        ],
      },
    },
    {
      channel: REACTION_CHANNEL_ID,
      trigger: {
        when: [
          { kind: "reaction", emoji: ["eyes", "robot_face"] },
          { kind: "mention" },
        ],
      },
    },
    // allowBots 未設定 = bot 投稿では起動しない (config.md §4.3)。
    { channel: BOT_CHANNEL_ID, trigger: { when: [{ kind: "mention" }] } },
  ],
};

describeLive("live: Gate", () => {
  it(
    "keyword gate: mention 無しでも pattern に一致すれば起動する",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: KEYWORD_CHANNEL_ID,
        config: CONFIG,
      });

      const posted = await runner.chat.post("help ENOENT の意味を一言で");

      const reply = await runner.waitForBotReply(posted.ts);
      expect(reply.text.length).toBeGreaterThan(0);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "reaction gate: 素の投稿では起動せず、:eyes: を付けると起動する",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: REACTION_CHANNEL_ID,
        config: CONFIG,
      });

      const posted = await runner.chat.post("ENOENT の意味を一言で説明して");
      await runner.expectNoBotReply(10_000);

      // 人間が :eyes: を付けると、Runner が fetchMessage で本文を取り直して
      // そのメッセージを起点に Session を起こす (config.md §4.1)。
      await runner.chat.react(posted.ts, "eyes");

      const reply = await runner.waitForBotReply(posted.ts);
      expect(reply.text.length).toBeGreaterThan(0);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "dm エントリが when: [] なら DM は mention 付きでも起動しない",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: DM_CHANNEL_ID,
        config: CONFIG,
      });

      await runner.chat.post("「PONG」とだけ返して", {
        mentionsBot: true,
        isDm: true,
      });

      await runner.expectNoBotReply(10_000);
      expect(runner.chat.log().filter((m) => m.sender.isSelf)).toEqual([]);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "allowBots 未設定なら bot 送信者の mention では起動しない",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: BOT_CHANNEL_ID,
        config: CONFIG,
      });

      await runner.chat.post("「PONG」とだけ返して", {
        mentionsBot: true,
        sender: { id: "UBOT001", isBot: true },
      });

      await runner.expectNoBotReply(10_000);
      expect(runner.chat.log().filter((m) => m.sender.isSelf)).toEqual([]);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
