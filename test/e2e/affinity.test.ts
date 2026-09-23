// affinity によるチャンネル直下投稿の合流 (docs/design/message-dispatch.md §3.2)。
//
// `session.affinity.scope: channel` では、Thread ごとに Session を作りつつ、
// Channel に直近 Session があればそこへ合流する。合流しても返信先は変わらない —
// Thread Key はメッセージごとに発行されるので、返信は投稿したスレッドに返る。
//
// 合流したかどうかは「どのスレッドに返ったか」と Control State の
// Thread → Session 対応で見る (LLM の返答本文には出ない)。

import { expect, it } from "vitest";

import {
  after,
  describeLive,
  LIVE_MODEL,
  LIVE_TEST_TIMEOUT_MS,
  sleep,
  startLiveRunner,
  waitForValue,
} from "./helpers/live.js";
import type { StaticConfig } from "./helpers/static-config-source.js";

const ALIVE_CHANNEL_ID = "C_E2E_AFFINITY_ALIVE";
const WINDOW_CHANNEL_ID = "C_E2E_AFFINITY_WINDOW";
const NEW_CHANNEL_ID = "C_E2E_AFFINITY_NEW";

/** windowSec は終了済み Session への合流可能時間。稼働中の合流は窓に関わらず
 * 効くので、「生きているうちに合流」の確認では長め、「窓切れ」の確認では短めを使う。 */
function affinityChannels(channelId: string, windowSec: number): StaticConfig {
  return {
    agent: { model: LIVE_MODEL },
    channels: [
      { channel: "default", trigger: { when: [{ kind: "mention" }] } },
      {
        channel: channelId,
        trigger: { when: [{ kind: "mention" }] },
        session: { mode: "thread", affinity: { scope: "channel", windowSec } },
      },
    ],
  };
}

describeLive("live: affinity", () => {
  it(
    "直近 Session が生きていれば、別の直下投稿もその Session へ合流する",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: ALIVE_CHANNEL_ID,
        config: affinityChannels(ALIVE_CHANNEL_ID, 600),
      });

      const a = await runner.chat.post(
        "合言葉は「りんご」。覚えたら OK とだけ返して",
        { mentionsBot: true },
      );
      await runner.waitForBotReply(a.ts, (m) => /OK/i.test(m.text));

      // 別のチャンネル直下投稿。自然な sessionKey は `${channel}:${b.ts}` だが、
      // affinity で A の Session へ合流するので A の文脈 (合言葉) を知っている。
      const b = await runner.chat.post(
        "この会話でわたしが伝えた合言葉は? 単語だけ答えて",
        { mentionsBot: true },
      );

      // 返信先は合流しても変わらない: B は B 自身を root にしたスレッドへ返る
      // (message-dispatch.md §3.2 の境界規則「返信先は変わらない」)。
      const reply = await runner.waitForBotReply(
        b.ts,
        (m) => after(b.ts)(m) && /りんご/.test(m.text),
      );
      expect(reply.text).toMatch(/りんご/);

      // Session は A のものだけ。B の自然キーでは Session レコードが作られない。
      const naturalKeyB = `${ALIVE_CHANNEL_ID}:${b.ts}`;
      expect(await runner.controlState.sessions.get(naturalKeyB)).toBeNull();
      const sessionA = await runner.controlState.sessions.get(
        `${ALIVE_CHANNEL_ID}:${a.ts}`,
      );
      expect(sessionA).not.toBeNull();

      // B のスレッドは A の Session に束ねられ、Channel の直近 Session も A のまま。
      expect(await runner.controlState.threads.resolve(naturalKeyB)).toBe(
        `${ALIVE_CHANNEL_ID}:${a.ts}`,
      );
      const latest = await runner.controlState.threads.latest(ALIVE_CHANNEL_ID);
      expect(latest?.sessionKey).toBe(`${ALIVE_CHANNEL_ID}:${a.ts}`);

      // 合流したので "session started" は A の 1 本だけ。
      const started = runner
        .logs()
        .filter((r) => r.msg === "session started")
        .map((r) => r.sessionKey);
      expect(started).toEqual([`${ALIVE_CHANNEL_ID}:${a.ts}`]);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "windowSec を過ぎた終了済み Session へは合流せず、新しい Session を作る",
    async () => {
      const windowSec = 3;
      const runner = await startLiveRunner({
        defaultChannelId: WINDOW_CHANNEL_ID,
        config: affinityChannels(WINDOW_CHANNEL_ID, windowSec),
        // endedAt の記録 (= linger 満了) を待つので、本番既定の 20s ではなく
        // 短い値で回す。
        lingerMs: 3_000,
      });

      const a = await runner.chat.post("「OK」とだけ返して", {
        mentionsBot: true,
      });
      await runner.waitForBotReply(a.ts, (m) => /OK/i.test(m.text));

      // 終了済み判定の起点は endedAt (message-dispatch.md §3.2)。linger 経過で
      // 記録されるまで待ち、そこからさらに窓を越える。
      const keyA = `${WINDOW_CHANNEL_ID}:${a.ts}`;
      await waitForValue(
        async () =>
          (await runner.controlState.sessions.get(keyA))?.endedAt !== undefined
            ? true
            : undefined,
        `session ${keyA} to end`,
        60_000,
      );
      // 窓 + 余裕。境界ちょうどを踏まないよう倍以上あける。
      await sleep(windowSec * 1000 + 4_000);

      const c = await runner.chat.post("「PONG」とだけ返して", {
        mentionsBot: true,
      });
      const reply = await runner.waitForBotReply(c.ts, (m) =>
        /PONG/i.test(m.text),
      );
      expect(reply.threadTs).toBe(c.ts);

      // 合流しなかったので C 自身の sessionKey で Session が立つ。
      const keyC = `${WINDOW_CHANNEL_ID}:${c.ts}`;
      expect(await runner.controlState.sessions.get(keyC)).not.toBeNull();
      const started = runner
        .logs()
        .filter((r) => r.msg === "session started")
        .map((r) => r.sessionKey);
      expect(started).toEqual([keyA, keyC]);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "チャンネル直下の /new は直近 Session へ合流しない",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: NEW_CHANNEL_ID,
        config: affinityChannels(NEW_CHANNEL_ID, 600),
        // /new が受理されるのは Session が畳まれた後なので、本番既定の
        // linger 20s ではなく短い値で回す。
        lingerMs: 3_000,
      });

      const a = await runner.chat.post("「OK」とだけ返して", {
        mentionsBot: true,
      });
      await runner.waitForBotReply(a.ts, (m) => /OK/i.test(m.text));

      // /new は明示的に新規で始める逃げ道なので合流をバイパスする
      // (message-dispatch.md §3.2)。ACK は /new 自身のスレッドに返る。
      const cmd = await runner.chat.post("/new", { mentionsBot: true });
      const ack = await runner.waitForBotReply(cmd.ts, after(cmd.ts), 30_000);
      expect(ack.threadTs).toBe(cmd.ts);

      // A のスレッドには /new の ACK が混ざらない。
      const inA = runner.chat
        .log()
        .filter((m) => m.sender.isSelf && m.threadTs === a.ts);
      expect(inA.every((m) => Number(m.ts) < Number(cmd.ts))).toBe(true);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
