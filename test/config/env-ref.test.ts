import { describe, expect, it } from "vitest";
import { resolveEnvRefs } from "../../src/config/env-ref.js";

describe("resolveEnvRefs", () => {
	it("resolves an env reference to an existing value", () => {
		expect(resolveEnvRefs("${env.FOO}", { FOO: "bar" })).toBe("bar");
	});

	it("throws when the referenced env var is unset, with the field path in the message", () => {
		expect(() =>
			resolveEnvRefs(
				{ connector: { slack: { appToken: "${env.SLACK_APP_TOKEN}" } } },
				{},
			),
		).toThrow(/connector\.slack\.appToken/);
	});

	it("throws with the variable name when the referenced env var is unset", () => {
		expect(() => resolveEnvRefs("${env.MISSING}", {})).toThrow(/MISSING/);
	});

	it("uses the default value when the referenced env var is unset", () => {
		expect(resolveEnvRefs("${env.FOO:-fallback}", {})).toBe("fallback");
	});

	it("uses the default value when the referenced env var is an empty string", () => {
		expect(resolveEnvRefs("${env.FOO:-fallback}", { FOO: "" })).toBe(
			"fallback",
		);
	});

	it("uses the actual value when the referenced env var (with a default) is set", () => {
		expect(resolveEnvRefs("${env.FOO:-fallback}", { FOO: "bar" })).toBe("bar");
	});

	it("treats an empty string as set (does not throw, no default given)", () => {
		expect(resolveEnvRefs("${env.FOO}", { FOO: "" })).toBe("");
	});

	it("resolves references nested deep in objects and arrays, reporting the path", () => {
		const result = resolveEnvRefs(
			{
				connector: {
					slack: {
						tokens: ["${env.TOKEN_A}", "${env.TOKEN_B}"],
					},
				},
			},
			{ TOKEN_A: "a-value", TOKEN_B: "b-value" },
		);
		expect(result).toEqual({
			connector: {
				slack: {
					tokens: ["a-value", "b-value"],
				},
			},
		});
	});

	it("includes an array index in the field path on failure", () => {
		expect(() =>
			resolveEnvRefs({ list: ["ok", "${env.MISSING_ITEM}"] }, {}),
		).toThrow(/list\[1\]/);
	});

	it("resolves multiple references mixed within a single string", () => {
		expect(
			resolveEnvRefs("prefix-${env.A}-${env.B}-suffix", {
				A: "aaa",
				B: "bbb",
			}),
		).toBe("prefix-aaa-bbb-suffix");
	});

	it("passes through non-string values (number/boolean/null) unchanged", () => {
		const result = resolveEnvRefs(
			{ port: 8080, enabled: true, note: null },
			{},
		);
		expect(result).toEqual({ port: 8080, enabled: true, note: null });
	});

	it("passes through a literal that is not an env reference", () => {
		const literal = "$" + "{foo}";
		expect(resolveEnvRefs(literal, {})).toBe(literal);
	});

	it("passes through a literal that lacks braces around env.X", () => {
		expect(resolveEnvRefs("$env.X", {})).toBe("$env.X");
	});

	it("passes through references with names not matching env var conventions", () => {
		expect(resolveEnvRefs("${env.1FOO}", {})).toBe("${env.1FOO}");
		expect(resolveEnvRefs("${env.FOO-BAR}", {})).toBe("${env.FOO-BAR}");
	});

	it("resolves references at the top-level path (empty path segment)", () => {
		expect(() => resolveEnvRefs({ x: "${env.MISSING}" }, {})).toThrow(/"x"/);
	});
});
