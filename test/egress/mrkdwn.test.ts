import { describe, expect, it } from "vitest";
import { toMrkdwn } from "../../src/egress/mrkdwn.js";

describe("toMrkdwn", () => {
	it("converts ** bold to * bold", () => {
		expect(toMrkdwn("**a**")).toBe("*a*");
	});

	it("converts __ bold to * bold", () => {
		expect(toMrkdwn("__a__")).toBe("*a*");
	});

	it("converts single * italic to _ italic", () => {
		expect(toMrkdwn("*a*")).toBe("_a_");
	});

	it("keeps _ italic as _ italic", () => {
		expect(toMrkdwn("_a_")).toBe("_a_");
	});

	it("converts ~~ strikethrough to ~ strikethrough", () => {
		expect(toMrkdwn("~~a~~")).toBe("~a~");
	});

	it("converts a heading to bold", () => {
		expect(toMrkdwn("# Title")).toBe("*Title*");
	});

	it("converts headings of every level to bold", () => {
		expect(toMrkdwn("###### Title")).toBe("*Title*");
	});

	it("converts a link", () => {
		expect(toMrkdwn("[Google](https://example.com)")).toBe(
			"<https://example.com|Google>",
		);
	});

	it("converts an image to a link", () => {
		expect(toMrkdwn("![alt](https://example.com/a.png)")).toBe(
			"<https://example.com/a.png|alt>",
		);
	});

	it("normalizes a * list bullet to -", () => {
		expect(toMrkdwn("* item")).toBe("- item");
	});

	it("normalizes a - list bullet to -", () => {
		expect(toMrkdwn("- item")).toBe("- item");
	});

	it("leaves an ordered list untouched", () => {
		expect(toMrkdwn("1. item")).toBe("1. item");
	});

	it("leaves an inline code span unconverted", () => {
		expect(toMrkdwn("`**not bold**`")).toBe("`**not bold**`");
	});

	it("leaves a fenced code block unconverted", () => {
		const input = "```js\nconst a = 1; // **not bold**\n```";
		expect(toMrkdwn(input)).toBe(input);
	});

	it("escapes &, <, > outside of code", () => {
		expect(toMrkdwn("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
	});

	it("does not escape characters inside a code span", () => {
		expect(toMrkdwn("`a < b`")).toBe("`a < b`");
	});

	it("preserves a user mention entity instead of escaping it", () => {
		expect(toMrkdwn("こんにちは <@U0BFC2XUMDX> さん")).toBe(
			"こんにちは <@U0BFC2XUMDX> さん",
		);
	});

	it("preserves channel and special mention entities", () => {
		expect(toMrkdwn("<#C012AB3CD|general> と <!here> と <!subteam^S123>")).toBe(
			"<#C012AB3CD|general> と <!here> と <!subteam^S123>",
		);
	});

	it("still escapes a bare < that is not a Slack entity", () => {
		expect(toMrkdwn("a < b and <notanentity>")).toBe(
			"a &lt; b and &lt;notanentity&gt;",
		);
	});

	it("treats a mention-like token inside code as literal, not an entity", () => {
		expect(toMrkdwn("`<@U0BFC2XUMDX>`")).toBe("`<@U0BFC2XUMDX>`");
	});

	it("converts bold outside a code block while preserving the code block", () => {
		const input = "**bold** and `**code**`";
		expect(toMrkdwn(input)).toBe("*bold* and `**code**`");
	});

	it("does not break a generated link when escaping", () => {
		expect(toMrkdwn("[a<b](https://example.com?x=1&y=2)")).toBe(
			"<https://example.com?x=1&amp;y=2|a&lt;b>",
		);
	});
});
