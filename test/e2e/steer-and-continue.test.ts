// 実行中 Session への steering と、その後の Turn での文脈継続
// (docs/design/session-model.md §5, docs/design/message-dispatch.md §3)。
//
// 長いタスクを走らせている最中にスレッドへ追い投稿すると、Gate を通さず
// (trigger.whileRunning の既定 passthrough) 実行中の pi へ steer として届く。
// ターン終了後に同じスレッドへ mention で聞き直すと、同じ Session の文脈が続く。

import { expect, it } from "vitest";

import {
  after,
  describeLive,
  LIVE_TEST_TIMEOUT_MS,
  mentionOnlyChannels,
  startLiveRunner,
} from "./helpers/live.js";

const CHANNEL_ID = "C_E2E_STEER";

describeLive("live: 実行中 Session への steering", () => {
  it(
    "実行中に「10 で止めて」を届けると止まり、次のターンでその文脈が残っている",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: CHANNEL_ID,
        config: mentionOnlyChannels(CHANNEL_ID),
      });

      const task = await runner.chat.post(
        "1 から 20 まで、1 秒ごとに 1 行ずつ数えて。bash の sleep を使って本当に 1 秒待ちながら数えて",
        { mentionsBot: true },
      );

      // :eyes: = Turn 開始。ここから先の追い投稿は実行中 Session への steer になる。
      await runner.waitForReaction(task.ts, "eyes", 60_000);

      // mention 無しのスレッド返信 — 実行中 Session へは Gate を省いて届く
      // (config.md §4.4 の whileRunning: passthrough)。
      await runner.chat.post("10 で止めて", { threadTs: task.ts });

      // Turn の終了 (成功) を待つ。
      await runner.waitForReaction(task.ts, "white_check_mark");

      // 同じスレッドで聞き直す = 同じ sessionKey (channelId:threadTs) の続き。
      const question = await runner.chat.post(
        "さっき何番まで数えた? 数字だけ答えて",
        { threadTs: task.ts, mentionsBot: true },
      );

      // カウント中の返信にも "10" が混ざりうるので、質問より後の投稿だけを見る。
      const followUp = await runner.waitForBotReply(
        task.ts,
        (m) => after(question.ts)(m) && /10/.test(m.text),
      );
      expect(followUp.text).toMatch(/10/);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
