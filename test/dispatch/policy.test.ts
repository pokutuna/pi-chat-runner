// src/dispatch/policy.ts の純関数のユニットテスト (session-model.md §3,
// message-dispatch.md §4)。Dispatcher の統合テストとは分けて、入力 → 出力だけを見る。
import { describe, expect, it } from "vitest";

import {
  computeDispatchDelayMs,
  isIdleExpired,
  renderEvent,
  replyThreadKeyOf,
  resolveSessionPolicy,
  type SessionPolicy,
  sessionKeyOf,
} from "../../src/dispatch/policy.js";
import { message, THREAD_POLICY } from "../helpers/session-harness.js";

describe("resolveSessionPolicy", () => {
  it("既定はチャンネル: session=thread, reply=thread", () => {
    expect(resolveSessionPolicy(null, false)).toEqual({
      sessionMode: "thread",
      replyMode: "thread",
    });
  });

  it("既定は DM: session=channel, reply=flat", () => {
    expect(resolveSessionPolicy(null, true)).toEqual({
      sessionMode: "channel",
      replyMode: "flat",
    });
  });

  it("doc の指定が isDm の既定より優先される (DM でも doc 指定が勝つ)", () => {
    expect(
      resolveSessionPolicy(
        { session: { mode: "thread" }, reply: { mode: "thread" }, agent: {} },
        true,
      ),
    ).toEqual({ sessionMode: "thread", replyMode: "thread" });
  });

  it("doc の一部指定のみ上書きし、残りは isDm の既定に従う", () => {
    expect(
      resolveSessionPolicy({ session: { mode: "channel" }, agent: {} }, false),
    ).toEqual({
      sessionMode: "channel",
      replyMode: "thread",
    });
  });
});

describe("sessionKeyOf", () => {
  it("thread モード: threadTs があれば channelId:threadTs", () => {
    expect(
      sessionKeyOf(
        message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
        THREAD_POLICY,
      ),
    ).toBe("C01:1699.5");
  });

  it("thread モード: threadTs が無ければメッセージ ts で代替する", () => {
    expect(sessionKeyOf(message(), THREAD_POLICY)).toBe(
      "C01:1700000000.000100",
    );
  });

  it("channel モード: threadTs の有無に関わらず channelId のみ", () => {
    const policy: SessionPolicy = { sessionMode: "channel", replyMode: "flat" };
    expect(sessionKeyOf(message(), policy)).toBe("C01");
    expect(
      sessionKeyOf(
        message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
        policy,
      ),
    ).toBe("C01");
  });
});

describe("replyThreadKeyOf", () => {
  it("常に channelId:threadTs ?? メッセージ ts を返す (sessionMode に関わらない)", () => {
    expect(replyThreadKeyOf(message())).toBe("C01:1700000000.000100");
    expect(
      replyThreadKeyOf(
        message({ conversation: { channelId: "C01", threadTs: "1699.5" } }),
      ),
    ).toBe("C01:1699.5");
  });
});

describe("renderEvent", () => {
  it("shows displayName with the user id when resolved", () => {
    const event = message({
      sender: {
        id: "U123",
        isBot: false,
        isSelf: false,
        displayName: "pokutuna",
      },
      text: "hello",
    });
    expect(renderEvent(event)).toBe(
      "from: pokutuna (U123)\ntime: 2026-07-05T00:00:00.000Z\n---\nhello",
    );
  });

  it("falls back to the bare user id when unresolved", () => {
    const event = message({
      sender: { id: "U123", isBot: false, isSelf: false },
      text: "hello",
    });
    expect(renderEvent(event)).toBe(
      "from: U123\ntime: 2026-07-05T00:00:00.000Z\n---\nhello",
    );
  });

  it("thread_key 指定時は from/time に続けて thread_key を列挙する", () => {
    const event = message({
      sender: { id: "U123", isBot: false, isSelf: false },
      text: "hello",
    });
    expect(renderEvent(event, "C01:1700000000.000100")).toBe(
      "from: U123\ntime: 2026-07-05T00:00:00.000Z\nthread_key: C01:1700000000.000100\n---\nhello",
    );
  });
});

describe("isIdleExpired", () => {
  it("ちょうど idleResetMinutes 分では超過していない (false)", () => {
    const lastUpdatedAt = new Date("2026-07-05T00:00:00Z");
    const now = lastUpdatedAt.getTime() + 5 * 60_000;
    expect(isIdleExpired(lastUpdatedAt, 5, now)).toBe(false);
  });

  it("idleResetMinutes 分を 1ms でも超えたら超過している (true)", () => {
    const lastUpdatedAt = new Date("2026-07-05T00:00:00Z");
    const now = lastUpdatedAt.getTime() + 5 * 60_000 + 1;
    expect(isIdleExpired(lastUpdatedAt, 5, now)).toBe(true);
  });

  it("idleResetMinutes 未満なら超過していない (false)", () => {
    const lastUpdatedAt = new Date("2026-07-05T00:00:00Z");
    const now = lastUpdatedAt.getTime() + 4 * 60_000;
    expect(isIdleExpired(lastUpdatedAt, 5, now)).toBe(false);
  });
});

describe("computeDispatchDelayMs", () => {
  it("通常ケース: 残り debounceSec 分をそのまま返す (hard cap に届かない)", () => {
    const nowMs = 1_000_000;
    expect(
      computeDispatchDelayMs({
        nowMs,
        firstPendingAtMs: nowMs,
        debounceSec: 2,
      }),
    ).toBe(2000);
  });

  it("後続メッセージでスライドしても、firstPendingAt からの経過が hard cap 未満なら debounceSec 分を返す", () => {
    const firstPendingAtMs = 1_000_000;
    const nowMs = firstPendingAtMs + 3000; // 3s 経過(次の debounceSec=2s も cap=6s 未満)
    expect(
      computeDispatchDelayMs({ nowMs, firstPendingAtMs, debounceSec: 2 }),
    ).toBe(2000);
  });

  it("hard cap (firstPendingAt + debounceSec*3) を超えて延ばさない", () => {
    const firstPendingAtMs = 1_000_000;
    // cap = firstPendingAtMs + 6000。now が cap の 1000ms 手前なら残りは 1000ms
    // (debounceSec 分の 2000ms を要求しても cap で切られる)
    const nowMs = firstPendingAtMs + 5000;
    expect(
      computeDispatchDelayMs({ nowMs, firstPendingAtMs, debounceSec: 2 }),
    ).toBe(1000);
  });

  it("残りが 0 未満になるケースは 0 を返す (即 dispatch)", () => {
    const firstPendingAtMs = 1_000_000;
    const nowMs = firstPendingAtMs + 10_000; // hard cap (6000ms) を過ぎている
    expect(
      computeDispatchDelayMs({ nowMs, firstPendingAtMs, debounceSec: 2 }),
    ).toBe(0);
  });

  it("firstPendingAtMs と同時刻 (最初のメッセージ) では debounceSec がそのまま残り ms になる", () => {
    const nowMs = 5000;
    expect(
      computeDispatchDelayMs({
        nowMs,
        firstPendingAtMs: nowMs,
        debounceSec: 0.5,
      }),
    ).toBe(500);
  });
});
