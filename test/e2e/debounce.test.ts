// debounce による連投のまとめ (docs/design/message-dispatch.md §4)。
//
// `session.affinity.debounceSec` があると、Gate を通ったメッセージは即 enqueue
// されるが dispatch だけが遅れる。近接した連投は 1 つの Session・1 つの Turn に
// 束ねられ、初回 prompt の drain がまとめて配達する。
//
// mention 付きのメッセージはこの遅延をバイパスして即 dispatch する。
//
// 遅延そのものは返信本文に出ないので、"dispatch debounced" ログと :eyes:
// (= Turn 開始) が付いた時刻で観測する。

import { expect, it } from "vitest";

import {
  describeLive,
  LIVE_MODEL,
  LIVE_TEST_TIMEOUT_MS,
  startLiveRunner,
} from "./helpers/live.js";
import type { StaticConfig } from "./helpers/static-config-source.js";

const BURST_CHANNEL_ID = "C_E2E_DEBOUNCE_BURST";
const MENTION_CHANNEL_ID = "C_E2E_DEBOUNCE_MENTION";

const DEBOUNCE_SEC = 5;

/** keyword gate + debounce。mention 無しでも起動できるようにして、
 * 「mention はバイパスする」との対比を同じ設定の上で取る。 */
const CONFIG: StaticConfig = {
  agent: { model: LIVE_MODEL },
  channels: [
    { channel: "default", trigger: { when: [{ kind: "mention" }] } },
    ...[BURST_CHANNEL_ID, MENTION_CHANNEL_ID].map((channel) => ({
      channel,
      trigger: {
        when: [
          { kind: "keyword" as const, pattern: "メモ" },
          {
            kind: "mention" as const,
          },
        ],
      },
      session: {
        mode: "thread" as const,
        affinity: { scope: "channel" as const, debounceSec: DEBOUNCE_SEC },
      },
    })),
  ],
};

describeLive("live: debounce", () => {
  it(
    "連投は 1 つの Session にまとめられ、両方の入力が同じ Turn に届く",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: BURST_CHANNEL_ID,
        config: CONFIG,
      });

      const first = await runner.chat.post(
        "メモ: 合言葉その 1 は「もも」。まだ返事しないで",
      );
      const firstPostedAtMs = Date.now();
      const second = await runner.chat.post(
        "メモ: 合言葉その 2 は「42」。ここまでで受け取った合言葉を全部、単語だけ列挙して",
      );

      // dispatch は遅らされる (mention 無しなのでバイパスしない)。
      const debounced = await runner.waitForLog(
        "dispatch debounced",
        undefined,
        30_000,
      );
      expect(debounced.sessionKey).toBe(`${BURST_CHANNEL_ID}:${first.ts}`);

      // 2 通目は 1 通目のスレッドへ合流する (affinity scope: channel かつ
      // 直近 Session が debounce 待機中 = 生きている扱い)。返信は 2 通目の
      // スレッドに返るので、そちらで両方の合言葉を確認する。
      const reply = await runner.waitForBotReply(
        second.ts,
        (m) => /もも/.test(m.text) && /42/.test(m.text),
      );
      expect(reply.text).toMatch(/もも/);
      expect(reply.text).toMatch(/42/);

      // Session は 1 本だけ。2 通が別々に Agent を起こしていない。
      const started = runner.logs().filter((r) => r.msg === "session started");
      expect(started.map((r) => r.sessionKey)).toEqual([
        `${BURST_CHANNEL_ID}:${first.ts}`,
      ]);

      // Turn 開始 (:eyes:) は debounceSec より早くは来ない。ポーリング間隔と
      // タイマーの丸めを吸収するため 1s の余裕を引く。
      const eyesAtMs = runner
        .logs()
        .find(
          (r) =>
            r.msg === "session started" &&
            r.sessionKey === `${BURST_CHANNEL_ID}:${first.ts}`,
        )?.time;
      expect(eyesAtMs).toBeDefined();
      expect(eyesAtMs! - firstPostedAtMs).toBeGreaterThanOrEqual(
        DEBOUNCE_SEC * 1000 - 1_000,
      );
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "mention 付きの投稿は debounce をバイパスして即 dispatch する",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: MENTION_CHANNEL_ID,
        config: CONFIG,
      });

      const postedAtMs = Date.now();
      const posted = await runner.chat.post("「PONG」とだけ返して", {
        mentionsBot: true,
      });

      // debounceSec より十分手前で Turn が始まっていること。実 pi の spawn が
      // 挟まるので余裕を持って debounceSec の手前までを許容する。
      await runner.waitForReaction(posted.ts, "eyes", DEBOUNCE_SEC * 1000);
      const elapsedMs = Date.now() - postedAtMs;
      expect(elapsedMs).toBeLessThan(DEBOUNCE_SEC * 1000);

      // バイパス経路なので debounce タイマーは積まれない。
      expect(
        runner.logs().filter((r) => r.msg === "dispatch debounced"),
      ).toEqual([]);

      const reply = await runner.waitForBotReply(posted.ts, (m) =>
        /PONG/i.test(m.text),
      );
      expect(reply.text).toMatch(/PONG/i);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
