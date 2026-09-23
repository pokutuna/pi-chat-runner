// Turn 終了後の linger (docs/design/message-dispatch.md §7.3)。
//
// linger は agent_end の後も Agent プロセスと lease を短時間維持する。その間に
// 届いたメッセージは同じプロセスの次の Turn として拾われ ("session continued")、
// Agent の再起動も Workdir の復元も起きない。
//
// linger が満了してから届いたメッセージは Session を起こし直す
// ("session started" が再び出る。transcript が残っているので文脈は続く)。
//
// startRunner に stop ハンドルは無いので、起動した Runner はテストファイルの
// 終了まで生き続ける。ケースごとに Channel を分ける。

import { expect, it } from "vitest";

import {
  after,
  describeLive,
  LIVE_TEST_TIMEOUT_MS,
  mentionOnlyChannels,
  sleep,
  startLiveRunner,
  waitForValue,
} from "./helpers/live.js";

const CONTINUE_CHANNEL_ID = "C_E2E_LINGER_CONTINUE";
const RESTART_CHANNEL_ID = "C_E2E_LINGER_RESTART";

describeLive("live: linger", () => {
  it(
    "linger 中の追い投稿は同じプロセスの次の Turn として継続する",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: CONTINUE_CHANNEL_ID,
        config: mentionOnlyChannels(CONTINUE_CHANNEL_ID),
        // ✅ を観測してから投稿するまでに満了しない長さを明示する。
        lingerMs: 15_000,
      });

      const root = await runner.chat.post(
        "合言葉は「すいか」。覚えたら OK とだけ返して",
        { mentionsBot: true },
      );
      await runner.waitForBotReply(root.ts, (m) => /OK/i.test(m.text));
      // ✅ = この Turn の終了。ここから linger 中。
      await runner.waitForReaction(root.ts, "white_check_mark");

      const follow = await runner.chat.post("合言葉は? 単語だけ答えて", {
        threadTs: root.ts,
        mentionsBot: true,
      });

      const sessionKey = `${CONTINUE_CHANNEL_ID}:${root.ts}`;
      const continued = await runner.waitForLog(
        "session continued",
        (r) => r.sessionKey === sessionKey,
        60_000,
      );
      expect(continued.sessionKey).toBe(sessionKey);

      const reply = await runner.waitForBotReply(
        root.ts,
        (m) => after(follow.ts)(m) && /すいか/.test(m.text),
      );
      expect(reply.text).toMatch(/すいか/);

      // 同じプロセスで続いたので Session の起動は 1 回きり。
      const started = runner
        .logs()
        .filter(
          (r) => r.msg === "session started" && r.sessionKey === sessionKey,
        );
      expect(started).toHaveLength(1);
      expect(started[0]?.resumed).toBe(false);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "linger 満了後の追い投稿は Session を起こし直す (文脈は transcript で続く)",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: RESTART_CHANNEL_ID,
        config: mentionOnlyChannels(RESTART_CHANNEL_ID),
        lingerMs: 1_000,
      });

      const root = await runner.chat.post(
        "合言葉は「くり」。覚えたら OK とだけ返して",
        { mentionsBot: true },
      );
      await runner.waitForBotReply(root.ts, (m) => /OK/i.test(m.text));

      // linger 満了 = Session が畳まれて endedAt が記録される。時間で待たず
      // 記録で待つ (満了後の片付けはプロセス停止と lease 解放を伴うため)。
      const sessionKey = `${RESTART_CHANNEL_ID}:${root.ts}`;
      await waitForValue(
        async () =>
          (await runner.controlState.sessions.get(sessionKey))?.endedAt !==
          undefined
            ? true
            : undefined,
        `session ${sessionKey} to end`,
        60_000,
      );
      await sleep(1_000);

      const follow = await runner.chat.post("合言葉は? 単語だけ答えて", {
        threadTs: root.ts,
        mentionsBot: true,
      });

      const reply = await runner.waitForBotReply(
        root.ts,
        (m) => after(follow.ts)(m) && /くり/.test(m.text),
      );
      expect(reply.text).toMatch(/くり/);

      // 2 回目の起動。同じ sessionKey は同じ Workdir / transcript を使うので
      // resumed: true (session.jsonl が既にある) になる。
      const started = runner
        .logs()
        .filter(
          (r) => r.msg === "session started" && r.sessionKey === sessionKey,
        );
      expect(started).toHaveLength(2);
      expect(started[0]?.resumed).toBe(false);
      expect(started[1]?.resumed).toBe(true);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
