// ChannelDoc スキーマ — docs/design/config.md §2〜§2.3, §7 / docs/design/architecture.md §2
//
// zod を単一ソースとする (build-plan.md 技術スタック表: 「apply 時 strict 検証と
// ChannelDoc 型を単一ソース化」)。手書きの interface は並置せず、型は z.infer で導出する。
// ただし trigger.when は再帰ブール木のため、循環を切るための型注釈のみ手書きする (§7)。
//
// YAML の gate は kind: で指定する (config.md §7)。channels.yaml はトップレベルで
// { channels: [...] } の配列を持ち、先頭に default エントリを必須で置く (config.md §2)。

import { z } from "zod";

/** Gate の種別ごとに要るパラメータだけを refinement で強制する (config.md §7)。
 * keyword は pattern 必須、classifier は criteria 必須、reaction は emoji 必須
 * (非空)。mention/passthrough は無し。 */
const GateSchema = z
  .object({
    kind: z.enum([
      "mention",
      "keyword",
      "classifier",
      "passthrough",
      "reaction",
    ]),
    pattern: z.string().optional(),
    criteria: z.string().optional(),
    /** この classifier ノードの判定モデル (省略時はコード既定)。
     * ChannelDocSchema.model (pi 本体用) とは別物 (config.md §2.3)。 */
    model: z.string().optional(),
    /** reaction gate が trigger する emoji 名の一覧 (Slack の正規化名。例 "eyes")。 */
    emoji: z.array(z.string()).optional(),
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
    if (
      gate.kind === "reaction" &&
      (gate.emoji === undefined || gate.emoji.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `gate kind "reaction" requires a non-empty "emoji"`,
        path: ["emoji"],
      });
    }
  });

export type GateConfig = z.infer<typeof GateSchema>;

/** trigger.when の合成木 (config.md §7)。配列は OR、{and}/{or} で明示合成する。
 * negate は持たない。z.lazy の型推論の循環を切るため型を手書きし、
 * schema 側は z.ZodType<WhenNode> で明示注釈する。 */
export type WhenNode = GateConfig | { and: WhenNode[] } | { or: WhenNode[] };

const WhenNodeSchema: z.ZodType<WhenNode> = z.lazy(() =>
  z.union([
    GateSchema,
    z.object({ and: z.array(WhenNodeSchema) }).strict(),
    z.object({ or: z.array(WhenNodeSchema) }).strict(),
  ]),
);

/** trigger = when (gate 合成木) + debounceSec/cooldownSec (発火制御)。
 * when は trigger を書くなら必須 (config.md §7 「trigger と gate の役割分担」)。 */
const TriggerSchema = z
  .object({
    when: z.array(WhenNodeSchema),
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

export type Trigger = z.infer<typeof TriggerSchema>;

/** channels.yaml の 1 エントリ。ChannelDoc に「どのチャンネル向けか」を示す
 * `channel` フィールドを加えたもの (config.md §2)。channel は "#name" /
 * チャンネル ID、または予約名 "default" / "dm"。 */
export const ChannelEntrySchema = ChannelDocSchema.extend({
  channel: z.string(),
}).strict();

export type ChannelEntry = z.infer<typeof ChannelEntrySchema>;

/** channels.yaml 全体。配列で全チャンネルを 1 ファイルにまとめ、先頭に置くとは
 * 限らないが "default" エントリの存在を必須にする (config.md §2, §2.1)。 */
export const ChannelsFileSchema = z
  .object({ channels: z.array(ChannelEntrySchema).min(1) })
  .strict()
  .superRefine((file, ctx) => {
    if (!file.channels.some((c) => c.channel === "default")) {
      ctx.addIssue({
        code: "custom",
        message: 'channels.yaml must contain a "default" entry',
        path: ["channels"],
      });
    }
  });

export type ChannelsFile = z.infer<typeof ChannelsFileSchema>;
