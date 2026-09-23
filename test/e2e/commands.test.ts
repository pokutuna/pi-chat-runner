// チャットのテキストコマンド (docs/design/session-model.md §5)。
//
// /new が文脈を切ること、/disable → /enable で Channel の起動が止まり再開することを
// 実 Agent で見る。通知文は src/egress/notices.ts の定数をそのまま照合する。

import { expect, it } from "vitest";

import {
  ACK_NOTICE_TEXT,
  DISABLE_NOTICE_TEXT,
  ENABLE_NOTICE_TEXT,
} from "../../src/egress/notices.js";
import {
  after,
  describeLive,
  LIVE_TEST_TIMEOUT_MS,
  mentionOnlyChannels,
  startLiveRunner,
  waitForValue,
} from "./helpers/live.js";

const NEW_CHANNEL_ID = "C_E2E_CMD_NEW";
const TOGGLE_CHANNEL_ID = "C_E2E_CMD_TOGGLE";

describeLive("live: チャットコマンド", () => {
  it(
    "/new の後は同じスレッドでも前の文脈を引き継がない",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: NEW_CHANNEL_ID,
        config: mentionOnlyChannels(NEW_CHANNEL_ID),
        // /new が受理されるのは Session が畳まれた後なので、本番既定の
        // linger 30s ではなく短い値で回す。
        lingerMs: 3_000,
      });

      const root = await runner.chat.post(
        "合言葉は「みかん」。覚えたら OK とだけ返して",
        { mentionsBot: true },
      );
      await runner.waitForBotReply(root.ts, (m) => /OK/i.test(m.text));

      const ask1 = await runner.chat.post(
        "この会話でわたしが伝えた合言葉は? 単語だけ答えて",
        {
          threadTs: root.ts,
          mentionsBot: true,
        },
      );
      const remembered = await runner.waitForBotReply(
        root.ts,
        (m) => after(ask1.ts)(m) && /みかん/.test(m.text),
      );
      expect(remembered.text).toMatch(/みかん/);

      // /new は実行中 Session には効かない (session-model.md §5.1 の割り切り)。
      // Session の実体が畳まれるまでは REJECT_NOTICE_TEXT が返るので、受理
      // (ACK_NOTICE_TEXT) されるまで送り直す — 通知文が案内するのと同じ操作。
      //
      // endedAt の記録 (onEnded) と Session レジストリからの除去 (onDisposed) は
      // 別のコールバックで、Control State だけを見ても「もう /new が通る」とは
      // 言い切れない。
      const ackedAfter = await waitForValue(
        async () => {
          const cmd = await runner.chat.post("/new", {
            threadTs: root.ts,
            mentionsBot: true,
          });
          try {
            await runner.waitForBotReply(
              root.ts,
              (m) => after(cmd.ts)(m) && m.text.includes(ACK_NOTICE_TEXT),
              15_000,
            );
            return cmd;
          } catch {
            return undefined;
          }
        },
        "/new to be accepted",
        90_000,
      );
      expect(Number(ackedAfter.ts)).toBeGreaterThan(Number(ask1.ts));

      // 文脈が切れていれば答えようがない。調べに行かず即答させるため、
      // 「この会話で聞いていなければ」と参照先を会話に限定する。
      const ask2 = await runner.chat.post(
        "この会話でわたしが伝えた合言葉は? 単語だけ答えて。この会話で聞いていなければ、調べずに「不明」とだけ答えて",
        { threadTs: root.ts, mentionsBot: true },
      );
      const forgotten = await runner.waitForBotReply(
        root.ts,
        (m) => after(ask2.ts)(m) && /不明/.test(m.text),
      );
      expect(forgotten.text).toMatch(/不明/);
      expect(forgotten.text).not.toMatch(/みかん/);
    },
    LIVE_TEST_TIMEOUT_MS,
  );

  it(
    "/disable で起動が止まり、/enable で再開する",
    async () => {
      const runner = await startLiveRunner({
        defaultChannelId: TOGGLE_CHANNEL_ID,
        config: mentionOnlyChannels(TOGGLE_CHANNEL_ID),
      });

      const disable = await runner.chat.post("/disable", {
        mentionsBot: true,
      });
      const disabled = await runner.waitForBotReply(
        disable.ts,
        (m) => m.text.includes(DISABLE_NOTICE_TEXT),
        30_000,
      );
      expect(disabled.text).toContain(DISABLE_NOTICE_TEXT);

      await runner.chat.post("「PONG」とだけ返して", {
        mentionsBot: true,
      });
      await runner.expectNoBotReply(15_000);

      const enable = await runner.chat.post("/enable", {
        mentionsBot: true,
      });
      const enabled = await runner.waitForBotReply(
        enable.ts,
        (m) => m.text.includes(ENABLE_NOTICE_TEXT),
        30_000,
      );
      expect(enabled.text).toContain(ENABLE_NOTICE_TEXT);

      const ping = await runner.chat.post("「PONG」とだけ返して", {
        mentionsBot: true,
      });
      const pong = await runner.waitForBotReply(ping.ts, (m) =>
        /PONG/i.test(m.text),
      );
      expect(pong.text).toMatch(/PONG/i);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
