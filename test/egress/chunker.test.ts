import { describe, expect, it } from "vitest";

import { chunkMessage } from "../../src/egress/chunker.js";

describe("chunkMessage", () => {
	it("returns [] for empty text", () => {
		expect(chunkMessage("")).toEqual([]);
	});

	it("returns [] for whitespace-only text", () => {
		expect(chunkMessage("   \n  \n")).toEqual([]);
	});

	it("returns the text unchanged when within the limit", () => {
		expect(chunkMessage("hello", 100)).toEqual(["hello"]);
	});

	it("splits on paragraph boundaries when two paragraphs exceed the limit", () => {
		const a = "a".repeat(30);
		const b = "b".repeat(30);
		const chunks = chunkMessage(`${a}\n\n${b}`, 50);

		expect(chunks).toEqual([a, b]);
	});

	it("falls back to line splitting when a single paragraph exceeds the limit", () => {
		const line1 = "x".repeat(30);
		const line2 = "y".repeat(30);
		const chunks = chunkMessage(`${line1}\n${line2}`, 50);

		expect(chunks).toEqual([line1, line2]);
	});

	it("falls back to hard character splitting when a single line exceeds the limit", () => {
		const text = "z".repeat(120);
		const chunks = chunkMessage(text, 50);

		expect(chunks.every((c) => c.length <= 50)).toBe(true);
		expect(chunks.join("")).toBe(text);
	});

	it("keeps fenced code blocks joined together when they fit", () => {
		const text = "```js\nconsole.log(1)\n```";
		expect(chunkMessage(text, 100)).toEqual([text]);
	});

	it("closes and reopens a code fence with the same info string across chunks", () => {
		const codeLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
		const text = ["```js", ...codeLines, "```"].join("\n");

		const chunks = chunkMessage(text, 50);
		expect(chunks.length).toBeGreaterThan(1);

		// 各チャンク境界: 前チャンクは ``` で閉じ、次チャンクは ```js で開く
		for (let i = 0; i < chunks.length - 1; i++) {
			const [current, next] = chunks.slice(i, i + 2);
			expect(current?.endsWith("```")).toBe(true);
			expect(next?.startsWith("```js")).toBe(true);
		}

		// 結合してフェンス行を除けば元のコード行が復元できる
		const restoredLines = chunks
			.join("\n")
			.split("\n")
			.filter((line) => !line.startsWith("```"));
		expect(restoredLines).toEqual(codeLines);
	});

	it("reopens a fence with no info string when the original had none", () => {
		const codeLines = Array.from({ length: 20 }, (_, i) => `plain${i}`);
		const text = ["```", ...codeLines, "```"].join("\n");

		const chunks = chunkMessage(text, 50);
		expect(chunks.length).toBeGreaterThan(1);

		for (let i = 0; i < chunks.length - 1; i++) {
			const [current, next] = chunks.slice(i, i + 2);
			expect(current?.endsWith("```")).toBe(true);
			expect(next?.startsWith("```\n")).toBe(true);
		}

		const restoredLines = chunks
			.join("\n")
			.split("\n")
			.filter((line) => !line.startsWith("```"));
		expect(restoredLines).toEqual(codeLines);
	});
});
