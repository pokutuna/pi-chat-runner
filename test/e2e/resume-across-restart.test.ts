// プロセス再起動をまたぐ Session の再開 (docs/design/state.md §5, §7)。
//
// Control State を sqlite (1 ファイル)、Workdir の退避先を実ディレクトリにすると、
// Runner を組み直しても同じスレッドの文脈が transcript ごと戻る。
//
// startRunner に stop ハンドルは無いので、Runner 1 はテスト中ずっと生き続ける。
// Runner 2 用の LocalChat は別インスタンスなので Runner 1 の ingress へは何も
// 流れないが、Inbox と lease は sqlite で共有されている。Runner 1 の Session が
// まだ生きている (running / linger 中) 間に Runner 2 が enqueue すると、lease を
// 持っている Runner 1 側がその item を drain して Runner 1 の chat へ返信して
// しまう。そのため Runner 2 を立てる前に、Runner 1 の Session が畳まれて lease が
// 解放されるまで待つ。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createLocalChat } from "../../src/chat/local/local-chat.js";
import { SqliteControlState } from "../../src/state/control/backends/sqlite.js";
import {
  describeLive,
  LIVE_TEST_TIMEOUT_MS,
  mentionOnlyChannels,
  startLiveRunner,
  waitForValue,
} from "./helpers/live.js";

const CHANNEL_ID = "C_E2E_RESUME";

describeLive("live: 再起動をまたぐ再開", () => {
  it(
    "sqlite + Workdir 退避を共有した新しい Runner が同じスレッドの文脈を引き継ぐ",
    async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "pi-chat-runner-e2e-st-"));
      const sqlitePath = join(stateDir, "state.db");
      const workdirDir = join(stateDir, "workdirs");
      // workdirRoot も両 Runner で共有する — 本番の再起動は同じルート
      // (既定 /tmp/pi-chat-runner/sessions) を使い続ける。
      const workdirRoot = join(stateDir, "sessions");
      const config = mentionOnlyChannels(CHANNEL_ID);

      const control1 = new SqliteControlState(sqlitePath);
      const chat1 = createLocalChat({ defaultChannelId: CHANNEL_ID });
      const runner1 = await startLiveRunner({
        chat: chat1,
        config,
        controlState: control1,
        workdirDir,
        workdirRoot,
        // Runner 1 の Session が畳まれる (lease 解放) まで待つので、本番既定の
        // linger 30s ではなく短い値で回す。
        lingerMs: 3_000,
      });

      const root = await runner1.chat.post(
        "合言葉は「ぶどう」。覚えたら OK とだけ返して",
        { mentionsBot: true },
      );
      await runner1.waitForBotReply(root.ts, (m) => /OK/i.test(m.text));

      // Runner 1 の Session が畳まれる (linger 経過 → lease 解放 → endedAt 記録)
      // まで待つ。ここを待たないと、次に Runner 2 が enqueue した item を lease
      // 保持者の Runner 1 が drain して Runner 1 の chat へ返してしまう。
      const sessionKey = `${CHANNEL_ID}:${root.ts}`;
      await waitForValue(
        async () =>
          (await control1.sessions.get(sessionKey))?.endedAt !== undefined
            ? true
            : undefined,
        `session ${sessionKey} to end on runner 1`,
        60_000,
      );

      // 「プロセス再起動」に相当する組み直し。Control State と Workdir の棚だけを
      // 共有し、LocalChat・Runner は新しく作る。
      //
      // ts は Inbox の dedupe キーなので、chat1 の最後の seq より後ろから採番する
      // (startSeq)。"1" に戻すと既出 ID として黙って捨てられる。
      const startSeq = chat1.log().length + 1;
      const chat2 = createLocalChat({
        defaultChannelId: CHANNEL_ID,
        startSeq,
      });
      const runner2 = await startLiveRunner({
        chat: chat2,
        config,
        controlState: new SqliteControlState(sqlitePath),
        workdirDir,
        workdirRoot,
      });

      const ask = await runner2.chat.post("合言葉は? 単語だけ答えて", {
        threadTs: root.ts,
        mentionsBot: true,
      });
      expect(Number(ask.ts)).toBeGreaterThan(Number(root.ts));

      const reply = await runner2.waitForBotReply(root.ts, (m) =>
        /ぶどう/.test(m.text),
      );
      expect(reply.text).toMatch(/ぶどう/);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
