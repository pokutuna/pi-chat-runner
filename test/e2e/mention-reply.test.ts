// mention 起動と Turn 状態のリアクション (docs/design/session-model.md §7.2)。
//
// mention だけを trigger にした Channel で、mention 付き投稿がスレッド返信になり、
// トリガーメッセージに :eyes: → :white_check_mark: が付くこと。mention 無しの投稿は
// 起動しないこと。

import { expect, it } from "vitest";

import {
  describeLive,
  LIVE_TEST_TIMEOUT_MS,
  mentionOnlyChannels,
  startLiveRunner,
} from "./helpers/live.js";

const CHANNEL_ID = "C_E2E_MENTION";

describeLive("live: mention 起動", () => {
  it(
    "mention 付き投稿にスレッドで返信し、トリガーへ eyes → white_check_mark を付ける",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: CHANNEL_ID,
        config: mentionOnlyChannels(CHANNEL_ID),
      });

      const posted = await runner.chat.post("「PONG」とだけ返して", {
        mentionsBot: true,
      });

      // チャンネル直下 mention の返信先はトリガーメッセージを root にした
      // 新スレッド (session-model.md §3)。
      const reply = await runner.waitForBotReply(posted.ts, (m) =>
        /PONG/i.test(m.text),
      );
      expect(reply.text).toMatch(/PONG/i);
      expect(reply.channelId).toBe(CHANNEL_ID);

      await runner.waitForReaction(posted.ts, "white_check_mark");

      const emojis = runner.chat
        .reactionsLog()
        .filter((r) => r.ts === posted.ts)
        .map((r) => r.emoji);
      expect(emojis).toEqual(["eyes", "white_check_mark"]);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "mention 無しの投稿では起動しない",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: CHANNEL_ID,
        config: mentionOnlyChannels(CHANNEL_ID),
      });

      await runner.chat.post("「PONG」とだけ返して");

      await runner.expectNoBotReply(15_000);
      expect(runner.chat.reactionsLog()).toEqual([]);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
