// ChannelDoc スキーマ — docs/design/config.md §2〜§2.3, §7 / docs/design/architecture.md §2
//
// zod を単一ソースとする (strict 検証と ChannelDoc 型を単一ソース化する狙い)。
// 手書きの interface は並置せず、型は z.infer で導出する。
// ただし trigger.when は再帰ブール木のため、循環を切るための型注釈のみ手書きする (§7)。
//
// YAML の gate は kind: で指定する (config.md §7)。設定ファイルの channels ブロックは
// { channels: [...] } の配列を持ち、default エントリを必須で置く (config.md §2)。

import { isAbsolute } from "node:path";

import { z } from "zod";

/** skills / extensions に書けるパス。絶対パス、または設定ファイルの場所からの
 * 相対 (./ か ../ 始まり) のみ (config.md §2)。裸の相対パス ("foo/bar") は
 * 基準ディレクトリが曖昧になるため schema で弾く。相対パスの絶対化は
 * ConfigSource (config-source.ts resolveFileReferences) が行う。 */
const PathRefSchema = z
  .string()
  .refine(
    (value) =>
      isAbsolute(value) || value.startsWith("./") || value.startsWith("../"),
    {
      message:
        'path must be absolute or start with "./" (relative to the config file)',
    },
  );

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

/** trigger = when (gate 合成木) + debounceSec (発火制御)。
 * when は trigger を書くなら必須 (config.md §7 「trigger と gate の役割分担」)。
 * cooldownSec は実装保留中 (session-model.md 「cooldownSec の実装案」参照)。
 * 実装再開まではスキーマ自体を無効化し、設定しても strict エラーになるようにする。 */
const TriggerSchema = z
  .object({
    when: z.array(WhenNodeSchema),
    debounceSec: z.number().optional(),
    // cooldownSec: z.number().optional(),
  })
  .strict();

/** 実行時 ChannelDoc (channel 解決後)。architecture.md §2 の TS 定義に対応。 */
export const ChannelDocSchema = z
  .object({
    systemPrompt: z.string().optional(),
    context: z.array(z.string()).optional(),
    trigger: TriggerSchema.optional(),
    /** pi の --model にそのまま渡す。`provider/model-id[:thinking-level]` の
     * canonical 形式を必須とする (pi の shorthand)。provider prefix が無い bare id は
     * pi 側の fuzzy match で解決先 provider が非決定になり、ADC marker の判定
     * (runtime.ts buildPiArgs) もできないため fail-loud で弾く。
     * model-id 側の解釈 (thinking suffix・fuzzy match) は pi に委譲する。 */
    model: z
      .string()
      .refine((v) => v.includes("/"), {
        message:
          'model must be in canonical "provider/model-id" form (e.g. "google-vertex/gemini-3.5-flash")',
      })
      .optional(),
    /** pi の --tools に渡す allowlist。--tools は extension ツール (reply 含む) にも
     * 適用されるため、bridge が reply を自動補完する (runtime.ts buildPiArgs) */
    tools: z.array(z.string()).optional(),
    /** pi の --exclude-tools に渡す denylist */
    excludeTools: z.array(z.string()).optional(),
    /** チャンネル別に追加ロードする skill。pi の --skill にそのまま渡す
     * (SKILL.md を直接含む単体 skill dir でも、複数 skill を束ねた親 dir でも
     * よい — pi が再帰発見する)。$AGENT_HOME/.pi/agent/skills/ の自動発見分
     * (全チャンネル共通) への追加 (additive) であり、共通分を外す手段ではない
     * (config.md §2) */
    skills: z.array(PathRefSchema).optional(),
    /** チャンネル別に追加ロードする extension (.ts/.js のファイルパス。pi の
     * --extension はディレクトリを受けない)。常時注入の組み込み
     * (reply/permission-gate/export) と $AGENT_HOME/.pi/agent/extensions/ の
     * 自動列挙分への追加 (additive) (config.md §2) */
    extensions: z.array(PathRefSchema).optional(),
    /** 組み込み memory skill の配線 (docs/design/memory.md)。shared 有効
     * (env SHARED_DIR 設定時) の既定は true で、false でチャンネル単位に外せる
     * (opt-out)。shared 無効時はこの値に関わらず配線されない */
    memory: z.boolean().optional(),
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

/** channels ブロックの 1 エントリ。ChannelDoc に「どのチャンネル向けか」を示す
 * `channel` フィールドを加えたもの (config.md §2)。channel は "#name" /
 * チャンネル ID、または予約名 "default" / "dm"。 */
export const ChannelEntrySchema = ChannelDocSchema.extend({
  channel: z.string(),
}).strict();

export type ChannelEntry = z.infer<typeof ChannelEntrySchema>;

/** channels ブロック全体。配列で全チャンネルをまとめ、先頭に置くとは限らないが
 * "default" エントリの存在を必須にする (config.md §2, §2.1)。 */
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
