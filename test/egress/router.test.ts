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
	calls: { channelId: string; threadTs?: string; text: string }[] = [];

	async postMessage(
		channelId: string,
		text: string,
		threadTs?: string,
	): Promise<void> {
		this.calls.push({
			channelId,
			text,
			...(threadTs !== undefined ? { threadTs } : {}),
		});
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
});
