import pino from "pino";
import { describe, expect, it } from "vitest";
import { type ChatPoster, ReplyRouter } from "../../src/reply/router.js";

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
	calls: { channelId: string; threadTs: string; text: string }[] = [];

	async postMessage(
		channelId: string,
		threadTs: string,
		text: string,
	): Promise<void> {
		this.calls.push({ channelId, threadTs, text });
	}
}

describe("ReplyRouter", () => {
	it("delivers to the registered destination", async () => {
		const poster = new FakePoster();
		const router = new ReplyRouter({ poster });
		router.register("C01:1700.1", { channelId: "C01", threadTs: "1700.1" });

		await router.deliver({ thread_key: "C01:1700.1", text: "hello" });

		expect(poster.calls).toEqual([
			{ channelId: "C01", threadTs: "1700.1", text: "hello" },
		]);
	});

	it("applies the formatter hook before posting", async () => {
		const poster = new FakePoster();
		const router = new ReplyRouter({
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
		const router = new ReplyRouter({ poster, logger });

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
		const router = new ReplyRouter({ poster });
		router.register("k", { channelId: "C01", threadTs: "1" });
		router.register("k", { channelId: "C01", threadTs: "2" });

		await router.deliver({ thread_key: "k", text: "x" });

		expect(poster.calls[0]?.threadTs).toBe("2");
	});
});
