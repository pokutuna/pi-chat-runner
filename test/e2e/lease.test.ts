// lease による Session の排他 (docs/design/message-dispatch.md §6)。
//
// lease は Control State に置かれるので、同じ sqlite ファイルを共有する 2 つの
// Runner は 1 つの Session を取り合う。保持していない側は Session を起こさず
// enqueue だけで戻り ("lease held by another process; enqueued only")、その入力は
// 保持者側の drain (steer / agent_end / linger) が拾う。返信は保持者の Egress、
// つまり Runner 1 の chat に出る。
//
// startRunner に stop ハンドルは無いので、両 Runner はこのファイルの終了まで
// 生き続ける。Runner 2 の LocalChat は別インスタンスで、Runner 1 の ingress へは
// 何も流れない — 共有されているのは sqlite (Inbox / lease / Session) と
// workdirRoot だけ。

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
} from "./helpers/live.js";

const CHANNEL_ID = "C_E2E_LEASE";

describeLive("live: lease による排他", () => {
  it(
    "lease を持たない Runner は enqueue だけで戻り、返信は保持者側に出る",
    async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "pi-chat-runner-e2e-ls-"));
      const sqlitePath = join(stateDir, "state.db");
      const workdirDir = join(stateDir, "workdirs");
      const workdirRoot = join(stateDir, "sessions");
      const config = mentionOnlyChannels(CHANNEL_ID);

      const chat1 = createLocalChat({ defaultChannelId: CHANNEL_ID });
      const runner1 = await startLiveRunner({
        chat: chat1,
        config,
        controlState: new SqliteControlState(sqlitePath),
        workdirDir,
        workdirRoot,
      });

      // Turn を長めに保つ。steer-and-continue と同じく bash sleep で実時間を使う。
      const task = await runner1.chat.post(
        "1 から 5 まで、5 秒ごとに 1 行ずつ数えて。bash の sleep を使って本当に 5 秒待ちながら数えて。数え終わったら「DONE」と返して",
        { mentionsBot: true },
      );
      // :eyes: = Turn 開始 = Runner 1 が lease を保持している。
      await runner1.waitForReaction(task.ts, "eyes", 60_000);

      // Runner 2。ts は Inbox の dedupe キーなので chat1 の続きから採番する。
      const chat2 = createLocalChat({
        defaultChannelId: CHANNEL_ID,
        startSeq: chat1.log().length + 100,
      });
      const runner2 = await startLiveRunner({
        chat: chat2,
        config,
        controlState: new SqliteControlState(sqlitePath),
        workdirDir,
        workdirRoot,
      });

      const sessionKey = `${CHANNEL_ID}:${task.ts}`;
      await runner2.chat.post("合言葉は「なし」。最後に必ず「なし」と書いて", {
        threadTs: task.ts,
        mentionsBot: true,
      });

      // Runner 2 は lease を取れず enqueue だけで戻る。
      const blocked = await runner2.waitForLog(
        "lease held by another process; enqueued only",
        (r) => r.sessionKey === sessionKey,
        60_000,
      );
      expect(blocked.sessionKey).toBe(sessionKey);

      // Runner 2 は Session を起こしていない。
      expect(runner2.logs().filter((r) => r.msg === "session started")).toEqual(
        [],
      );

      // 入力は保持者 (Runner 1) の drain が拾い、返信も Runner 1 の chat に出る。
      // chat1 と chat2 は seq (= ts) の採番空間が別なので、ここで after() は使えない
      // (chat2 の ts と chat1 の ts は比較しても意味がない)。本文で絞る。
      const reply = await runner1.waitForBotReply(task.ts, (m) =>
        /なし/.test(m.text),
      );
      expect(reply.text).toMatch(/なし/);

      // Runner 2 の chat には bot の投稿が一切現れない。
      expect(chat2.log().filter((m) => m.sender.isSelf)).toEqual([]);
    },
    LIVE_TEST_TIMEOUT_MS,
  );
});
