// Channel Config スキーマ — docs/design/config.md §1.2, §3.1, §4
//
// zod を単一ソースとする (strict 検証と ChannelConfig 型を単一ソース化する狙い)。
// 手書きの interface は並置せず、型は z.infer で導出する。
// ただし trigger.when は再帰ブール木のため、循環を切るための型注釈のみ手書きする (§4)。
//
// Channel Config は Channel 単位のメッセージ処理 (trigger / session / reply) と、
// その Channel 固有の Agent Config (agent, agent-config.ts) を持つ。Agent 部分と
// Channel 部分はマージの段数が違う (config.md §3.2) ため、config-source.ts が
// 別々にマージする。
//
// YAML の gate は kind: で指定する (config.md §4.1)。設定ファイルの channels ブロックは
// { channels: [...] } の配列を持ち、default エントリを必須で置く (config.md §3.1)。

import { z } from "zod";

import { AgentConfigSchema } from "./agent-config.js";

/** Gate の種別ごとに要るパラメータだけを refinement で強制する (config.md §4.5)。
 * keyword は pattern 必須、classifier は criteria 必須、reaction は emoji 必須
 * (非空)、sender は is / id (非空) / name (非空) の少なくとも 1 つが必須。
 * mention/passthrough は無し。 */
const GateSchema = z
  .object({
    kind: z.enum([
      "mention",
      "keyword",
      "classifier",
      "passthrough",
      "reaction",
      "sender",
    ]),
    pattern: z.string().optional(),
    criteria: z.string().optional(),
    /** この classifier ノードの判定モデル (省略時はコード既定)。
     * AgentConfig.model (pi 本体用) とは別物 (config.md §4.1)。 */
    model: z.string().optional(),
    /** reaction gate が trigger する emoji 名の一覧 (Slack の正規化名。例 "eyes")。 */
    emoji: z.array(z.string()).optional(),
    /** sender gate が trigger する送信者種別 (config.md §4.2)。 */
    is: z.enum(["bot", "human"]).optional(),
    /** sender gate が trigger する送信者 ID の allowlist。Sender.id との完全一致
     * (config.md §4.2)。is/name と併記した場合は AND。 */
    id: z.array(z.string()).optional(),
    /** sender gate が trigger する送信者名の allowlist。Ingress ステージが正規化した
     * Sender.displayName との完全一致 (config.md §4.2)。is/id と併記した場合は AND。 */
    name: z.array(z.string()).optional(),
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
    if (
      gate.kind === "sender" &&
      gate.is === undefined &&
      (gate.id === undefined || gate.id.length === 0) &&
      (gate.name === undefined || gate.name.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `gate kind "sender" requires at least one of "is", a non-empty "id" or a non-empty "name"`,
        path: ["is"],
      });
    }
  });

export type GateConfig = z.infer<typeof GateSchema>;

/** trigger.when の合成木 (config.md §4)。配列は OR、{and}/{or} で明示合成する。
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

/** trigger = when (gate 合成木) + 発火制御。
 * when は trigger を書くなら必須 (config.md §4)。
 * cooldownSec は実装保留中 (session-model.md 「cooldownSec の実装案」参照)。
 * 実装再開まではスキーマ自体を無効化し、設定しても strict エラーになるようにする。
 * debounceSec は session.affinity.debounceSec へ移設済み (message-dispatch.md §4
 * 「debounceSec の置き場所」)。ここには持たない。 */
const TriggerSchema = z
  .object({
    when: z.array(WhenNodeSchema),
    // cooldownSec: z.number().optional(),
    /** bot 投稿 (自分自身を除く) を gate 評価に届ける opt-in。既定 false = bot
     * 投稿では起動しない (config.md §4.3)。 */
    allowBots: z.boolean().optional(),
    /** 実行中 Session に届いたメッセージの扱い (config.md §4.4)。
     * "passthrough" (既定) は Gate を省略して steering へ渡す、"evaluate" は
     * 実行中でも毎回 when を評価する。 */
    whileRunning: z.enum(["passthrough", "evaluate"]).optional(),
  })
  .strict();

export type Trigger = z.infer<typeof TriggerSchema>;

/** Channel 単位のメッセージ処理設定 (config.md §1.2) + その Channel 固有の
 * Agent Config。`agent` 以外の 3 フィールド (trigger / session / reply) が
 * 「Channel 部分」で、config-source.ts のマージでは agent と別々に扱う。 */
export const ChannelConfigSchema = z
  .object({
    trigger: TriggerSchema.optional(),
    /** セッション (文脈) の単位。session-model.md §2 */
    session: z
      .object({
        mode: z.enum(["thread", "channel"]).optional(),
        /** 既存セッションへの合流 (message-dispatch.md §3.2)。 */
        affinity: z
          .object({
            /** 既定 "session" (= 合流しない)。既定値の適用は読む側 (runner) で行う
             * ので schema は optional のまま。 */
            scope: z.enum(["session", "channel"]).optional(),
            /** セッション終了後も合流可能な秒数。既定 0 (稼働中のみ合流)。 */
            windowSec: z.number().int().nonnegative().optional(),
            /** 連投バーストを 1 ターンに束ねる dispatch 遅延 (trigger から移設)。 */
            debounceSec: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        idleResetMinutes: z.number().positive().optional(),
        maxTranscriptKb: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    /** チャンネル直下トリガーへの返信先。session-model.md §3 */
    reply: z
      .object({
        mode: z.enum(["thread", "flat"]).optional(),
      })
      .strict()
      .optional(),
    /** この Channel 固有の Agent Config (config.md §1.3)。トップレベル `agent`
     * ブロックを土台に、フィールド単位で上書きする (config.md §3.2)。 */
    agent: AgentConfigSchema.optional(),
  })
  .strict();

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

/** channels ブロックの 1 エントリ。ChannelConfig に「どのチャンネル向けか」を示す
 * `channel` フィールドを加えたもの (config.md §3.1)。channel は "#name" /
 * チャンネル ID、または予約名 "default" / "dm"。 */
export const ChannelEntrySchema = ChannelConfigSchema.extend({
  channel: z.string(),
}).strict();

export type ChannelEntry = z.infer<typeof ChannelEntrySchema>;

/** channels ブロック全体。配列で全チャンネルをまとめ、先頭に置くとは限らないが
 * "default" エントリの存在を必須にする (config.md §3.1)。 */
export const ChannelsFileSchema = z
  .object({ channels: z.array(ChannelEntrySchema).min(1) })
  .strict()
  .superRefine((file, ctx) => {
    if (!file.channels.some((c) => c.channel === "default")) {
      ctx.addIssue({
        code: "custom",
        message: 'channels must contain a "default" entry',
        path: ["channels"],
      });
    }
  });

export type ChannelsFile = z.infer<typeof ChannelsFileSchema>;
