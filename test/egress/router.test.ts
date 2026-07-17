import pino from "pino";
import { describe, expect, it } from "vitest";

import { type ChatPoster, EgressRouter } from "../../src/egress/router.js";

/** pino のログ 1 行 (JSON) を配列に集めるテスト用ロガー */
function collectingLogger(): { logger: pino.Logger; lines: () => unknown[] } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const logger = pino({ level: "info" }, stream);
  return {
    logger,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line)),
  };
}

class FakePoster implements ChatPoster {
  calls: {
    channelId: string;
    threadTs?: string;
    text: string;
    files?: string[];
  }[] = [];
  updateCalls: { channelId: string; messageId: string; text: string }[] = [];
  failUpdate = false;
  private nextMessageId = 0;

  async postMessage(
    channelId: string,
    text: string,
    threadTs?: string,
    files?: string[],
  ): Promise<{ messageId: string }> {
    this.calls.push({
      channelId,
      text,
      ...(threadTs !== undefined ? { threadTs } : {}),
      ...(files !== undefined ? { files } : {}),
    });
    this.nextMessageId += 1;
    return { messageId: `msg-${this.nextMessageId}` };
  }

  async updateMessage(
    channelId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (this.failUpdate) throw new Error("update failed");
    this.updateCalls.push({ channelId, messageId, text });
  }
}

describe("EgressRouter", () => {
  it("delivers to the registered destination", async () => {
    const poster = new FakePoster();
    const router = new EgressRouter({ poster });
    router.register("C01:1700.1", { channelId: "C01", threadTs: "1700.1" });

    await router.deliver({ thread_key: "C01:1700.1", text: "hello" });

    expect(poster.calls).toEqual([
      { channelId: "C01", threadTs: "1700.1", text: "hello" },
    ]);
  });

  it("applies the formatter hook before posting", async () => {
    const poster = new FakePoster();
    const router = new EgressRouter({
      poster,
      formatter: (text) => `*${text}*`,
    });
    router.register("k", { channelId: "C01", threadTs: "1" });

    await router.deliver({ thread_key: "k", text: "bold" });

    expect(poster.calls[0]?.text).toBe("*bold*");
  });

  it("drops unknown thread_key with a warning instead of throwing", async () => {
    const poster = new FakePoster();
    const { logger, lines } = collectingLogger();
    const router = new EgressRouter({ poster, logger });

    await router.deliver({ thread_key: "nope", text: "lost" });

    expect(poster.calls).toEqual([]);
    const warnings = lines().filter(
      (line) => (line as { level: number }).level === 40,
    );
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { threadKey: string }).threadKey).toBe("nope");
  });

  it("re-registering a thread_key overwrites the destination", async () => {
    const poster = new FakePoster();
    const router = new EgressRouter({ poster });
    router.register("k", { channelId: "C01", threadTs: "1" });
    router.register("k", { channelId: "C01", threadTs: "2" });

    await router.deliver({ thread_key: "k", text: "x" });

    expect(poster.calls[0]?.threadTs).toBe("2");
  });

  it("posts flat (no thread_ts) when the destination omits threadTs", async () => {
    const poster = new FakePoster();
    const router = new EgressRouter({ poster });
    router.register("k", { channelId: "C01" });

    await router.deliver({ thread_key: "k", text: "flat reply" });

    expect(poster.calls).toEqual([{ channelId: "C01", text: "flat reply" }]);
  });

  it("passes payload.files through to the poster", async () => {
    const poster = new FakePoster();
    const router = new EgressRouter({ poster });
    router.register("k", { channelId: "C01", threadTs: "1" });

    await router.deliver({
      thread_key: "k",
      text: "see attached",
      files: ["/tmp/pi-chat-runner/sessions/C01/1/report.csv"],
    });

    expect(poster.calls).toEqual([
      {
        channelId: "C01",
        threadTs: "1",
        text: "see attached",
        files: ["/tmp/pi-chat-runner/sessions/C01/1/report.csv"],
      },
    ]);
  });

  it("omits files from the poster call when the payload has none", async () => {
    const poster = new FakePoster();
    const router = new EgressRouter({ poster });
    router.register("k", { channelId: "C01", threadTs: "1" });

    await router.deliver({ thread_key: "k", text: "no attachment" });

    expect(poster.calls[0]).toEqual({
      channelId: "C01",
      threadTs: "1",
      text: "no attachment",
    });
  });

  it("splits long text into multiple sequential posts to the same thread", async () => {
    const poster = new FakePoster();
    const router = new EgressRouter({ poster });
    router.register("k", { channelId: "C01", threadTs: "1" });

    const paragraph = "a".repeat(3000);
    const text = `${paragraph}\n\n${paragraph}`;
    await router.deliver({ thread_key: "k", text });

    expect(poster.calls).toHaveLength(2);
    expect(poster.calls[0]).toEqual({
      channelId: "C01",
      threadTs: "1",
      text: paragraph,
    });
    expect(poster.calls[1]).toEqual({
      channelId: "C01",
      threadTs: "1",
      text: paragraph,
    });
  });

  it("attaches files only to the last post when splitting long text", async () => {
    const poster = new FakePoster();
    const router = new EgressRouter({ poster });
    router.register("k", { channelId: "C01", threadTs: "1" });

    const paragraph = "a".repeat(3000);
    const text = `${paragraph}\n\n${paragraph}`;
    await router.deliver({
      thread_key: "k",
      text,
      files: ["/tmp/pi-chat-runner/sessions/C01/1/report.csv"],
    });

    expect(poster.calls).toHaveLength(2);
    expect(poster.calls[0]).toEqual({
      channelId: "C01",
      threadTs: "1",
      text: paragraph,
    });
    expect(poster.calls[1]).toEqual({
      channelId: "C01",
      threadTs: "1",
      text: paragraph,
      files: ["/tmp/pi-chat-runner/sessions/C01/1/report.csv"],
    });
  });

  it("posts once with empty text when only files are attached", async () => {
    const poster = new FakePoster();
    const router = new EgressRouter({ poster });
    router.register("k", { channelId: "C01", threadTs: "1" });

    await router.deliver({
      thread_key: "k",
      text: "",
      files: ["/tmp/pi-chat-runner/sessions/C01/1/report.csv"],
    });

    expect(poster.calls).toEqual([
      {
        channelId: "C01",
        threadTs: "1",
        text: "",
        files: ["/tmp/pi-chat-runner/sessions/C01/1/report.csv"],
      },
    ]);
  });

  describe("notifyProgress", () => {
    it("posts a new message on the first call", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });

      await router.notifyProgress("k", "running");

      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
      ]);
      expect(poster.updateCalls).toEqual([]);
    });

    it("updates the same message on subsequent calls", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });

      await router.notifyProgress("k", "running: bash");
      await router.notifyProgress("k", "running: grep");

      expect(poster.calls).toHaveLength(1);
      expect(poster.updateCalls).toEqual([
        { channelId: "C01", messageId: "msg-1", text: "running: grep" },
      ]);
    });

    it("drops unknown thread_key with a warning instead of throwing", async () => {
      const poster = new FakePoster();
      const { logger, lines } = collectingLogger();
      const router = new EgressRouter({ poster, logger });

      await router.notifyProgress("nope", "running");

      expect(poster.calls).toEqual([]);
      const warnings = lines().filter(
        (line) => (line as { level: number }).level === 40,
      );
      expect(warnings).toHaveLength(1);
    });

    it("clearProgress makes the next call post a new message again", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });

      await router.notifyProgress("k", "running");
      router.clearProgress("k");
      await router.notifyProgress("k", "running again");

      expect(poster.calls).toHaveLength(2);
      expect(poster.updateCalls).toEqual([]);
    });
  });

  describe("deliver overwriting a pending progress message", () => {
    it("updates the progress message instead of posting a new one", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });
      await router.notifyProgress("k", "running");

      await router.deliver({ thread_key: "k", text: "final answer" });

      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
      ]);
      expect(poster.updateCalls).toEqual([
        { channelId: "C01", messageId: "msg-1", text: "final answer" },
      ]);
    });

    it("uses the session progress key when a flat reply has a message key", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("session", { channelId: "D01" });
      router.register("reply", { channelId: "D01" });
      await router.notifyProgress("session", "running");

      const result = await router.deliver(
        { thread_key: "reply", text: "final answer" },
        "session",
      );

      expect(result.progressConsumed).toBe(true);
      expect(poster.calls).toEqual([{ channelId: "D01", text: "running" }]);
      expect(poster.updateCalls).toEqual([
        { channelId: "D01", messageId: "msg-1", text: "final answer" },
      ]);
    });

    it("does not consume a progress message from a different destination", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("session", { channelId: "C01", threadTs: "1" });
      router.register("reply", { channelId: "C01", threadTs: "2" });
      await router.notifyProgress("session", "running");

      const result = await router.deliver(
        { thread_key: "reply", text: "final answer" },
        "session",
      );

      expect(result.progressConsumed).toBe(false);
      expect(poster.updateCalls).toEqual([]);
      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
        { channelId: "C01", threadTs: "2", text: "final answer" },
      ]);
    });

    it("consumes the progress messageId so a later reply posts fresh", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });
      await router.notifyProgress("k", "running");

      await router.deliver({ thread_key: "k", text: "first reply" });
      await router.deliver({ thread_key: "k", text: "second reply" });

      expect(poster.updateCalls).toHaveLength(1);
      expect(poster.calls.map((c) => c.text)).toEqual([
        "running",
        "second reply",
      ]);
    });

    it("does not overwrite the progress message when files are attached", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });
      await router.notifyProgress("k", "running");

      await router.deliver({
        thread_key: "k",
        text: "see attached",
        files: ["/tmp/pi-chat-runner/sessions/C01/1/report.csv"],
      });

      expect(poster.updateCalls).toEqual([]);
      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
        {
          channelId: "C01",
          threadTs: "1",
          text: "see attached",
          files: ["/tmp/pi-chat-runner/sessions/C01/1/report.csv"],
        },
      ]);
    });

    it("falls back to a new post when the progress update fails", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });
      await router.notifyProgress("k", "running");
      poster.failUpdate = true;

      await router.deliver({ thread_key: "k", text: "final answer" });

      expect(poster.updateCalls).toEqual([]);
      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
        { channelId: "C01", threadTs: "1", text: "final answer" },
      ]);
    });

    it("only overwrites the first chunk when text is split into multiple posts", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });
      await router.notifyProgress("k", "running");

      const paragraph = "a".repeat(3000);
      const text = `${paragraph}\n\n${paragraph}`;
      await router.deliver({ thread_key: "k", text });

      expect(poster.updateCalls).toEqual([
        { channelId: "C01", messageId: "msg-1", text: paragraph },
      ]);
      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
        { channelId: "C01", threadTs: "1", text: paragraph },
      ]);
    });

    it("does not touch progress messages from other thread_keys", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k1", { channelId: "C01", threadTs: "1" });
      router.register("k2", { channelId: "C01", threadTs: "2" });
      await router.notifyProgress("k1", "running");

      await router.deliver({ thread_key: "k2", text: "reply to k2" });

      expect(poster.updateCalls).toEqual([]);
      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
        { channelId: "C01", threadTs: "2", text: "reply to k2" },
      ]);
    });
  });

  describe("progress lane closing (delayed tick after reply)", () => {
    it("does not repost a ghost message when a stale progress tick arrives after deliver", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });

      // 進捗メッセージを 1 枚作る
      await router.notifyProgress("k", "running");
      // deliver がそれを本文で上書き消費する (progressConsumed: true)
      const result = await router.deliver({
        thread_key: "k",
        text: "final answer",
      });
      expect(result.progressConsumed).toBe(true);

      // deliver の後ろでキューに積まれていた (体裁上は) 古いタイマー tick。
      // レーンが閉じているため新規投稿してはならない
      await router.notifyProgress("k", "stale tick after reply");

      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
      ]);
      expect(poster.updateCalls).toEqual([
        { channelId: "C01", messageId: "msg-1", text: "final answer" },
      ]);
    });

    it("reopenProgress lets the next turn's notifyProgress post again", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });

      await router.notifyProgress("k", "running");
      await router.deliver({ thread_key: "k", text: "final answer" });
      // レーンが閉じている間は捨てられる
      await router.notifyProgress("k", "stale tick after reply");
      expect(poster.calls).toHaveLength(1);

      await router.reopenProgress("k");
      await router.notifyProgress("k", "next turn running");

      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
        { channelId: "C01", threadTs: "1", text: "next turn running" },
      ]);
    });

    it("clearProgress also reopens the lane", async () => {
      const poster = new FakePoster();
      const router = new EgressRouter({ poster });
      router.register("k", { channelId: "C01", threadTs: "1" });

      await router.notifyProgress("k", "running");
      await router.deliver({ thread_key: "k", text: "final answer" });
      await router.clearProgress("k");

      await router.notifyProgress("k", "new session running");

      expect(poster.calls).toEqual([
        { channelId: "C01", threadTs: "1", text: "running" },
        { channelId: "C01", threadTs: "1", text: "new session running" },
      ]);
    });
  });
});
