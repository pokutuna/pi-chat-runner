// ChannelDoc スキーマ — docs/design/config.md §2, §6 / docs/design/architecture.md §2
//
// zod を単一ソースとする (build-plan.md 技術スタック表: 「apply 時 strict 検証と
// ChannelDoc 型を単一ソース化」)。手書きの interface は並置せず、型は z.infer で導出する。
//
// YAML の gate は kind: で指定する (config.md §7)。

import { z } from "zod";

/** Gate の種別ごとに要るパラメータだけを refinement で強制する (config.md §7)。
 * keyword は pattern 必須、classifier は criteria 必須。mention/passthrough/cooldown は無し。 */
const GateSchema = z
	.object({
		kind: z.enum([
			"mention",
			"keyword",
			"classifier",
			"passthrough",
			"cooldown",
		]),
		pattern: z.string().optional(),
		criteria: z.string().optional(),
	})
	.strict()
	.superRefine((gate, ctx) => {
		if (gate.kind === "keyword" && gate.pattern === undefined) {
			ctx.addIssue({
				code: "custom",
				message: `gate kind "keyword" requires "pattern"`,
				path: ["pattern"],
			});
		}
		if (gate.kind === "classifier" && gate.criteria === undefined) {
			ctx.addIssue({
				code: "custom",
				message: `gate kind "classifier" requires "criteria"`,
				path: ["criteria"],
			});
		}
	});

const TriggerSchema = z
	.object({
		gates: z.array(GateSchema),
		combinator: z.enum(["any", "all"]),
		debounceSec: z.number().optional(),
		cooldownSec: z.number().optional(),
	})
	.strict();

/** 実行時 ChannelDoc (channel 解決後)。architecture.md §2 の TS 定義に対応。 */
export const ChannelDocSchema = z
	.object({
		systemPrompt: z.string().optional(),
		context: z.array(z.string()).optional(),
		trigger: TriggerSchema.optional(),
		model: z.string().optional(),
		/** pi の --tools に渡す allowlist。--tools は extension ツール (reply 含む) にも
		 * 適用されるため、bridge が reply を自動補完する (runtime.ts buildPiArgs) */
		tools: z.array(z.string()).optional(),
		/** pi の --exclude-tools に渡す denylist */
		excludeTools: z.array(z.string()).optional(),
		/** セッション (文脈) の単位。session-model.md §3 */
		session: z
			.object({
				mode: z.enum(["thread", "channel"]).optional(),
				idleResetMinutes: z.number().positive().optional(),
				maxTranscriptKb: z.number().positive().optional(),
			})
			.strict()
			.optional(),
		/** チャンネル直下トリガーへの返信先。同 §3 */
		reply: z
			.object({
				mode: z.enum(["thread", "flat"]).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type ChannelDoc = z.infer<typeof ChannelDocSchema>;

/** YAML ファイル形式。ChannelDoc に「どのチャンネル向けか」を示す `channel` フィールドを加えたもの
 * (config.md §6)。channel は "#name" またはチャンネル ID。 */
export const ChannelDocFileSchema = ChannelDocSchema.extend({
	channel: z.string(),
});

export type ChannelDocFile = z.infer<typeof ChannelDocFileSchema>;

export type Gate = z.infer<typeof GateSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
