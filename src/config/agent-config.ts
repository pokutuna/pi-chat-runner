// Agent Config スキーマ — docs/design/config.md §1.3
//
// Agent の振る舞いと Runtime への引き渡し (プロンプト、モデル、Tool、Skill、
// Extension、memory、env) だけを持つ。System Config (system-config.ts) とは
// 読むタイミングが違い (Agent Config はメッセージごと)、Channel Config
// (channel-config.ts) の `agent` フィールドとしても同じスキーマが使われる。
//
// YAML 上は 2 箇所に現れる:
//   - トップレベル `agent` ブロック (全 Channel 共通の default)
//   - `channels[].agent` (Channel 固有の上書き)
// どちらも同じ AgentConfigSchema で検証し、config-source.ts が 3 段でマージする
// (config.md §3.2)。
//
// env 参照 (${env.X}) は `env` フィールドの値だけが解決される (config.md §2.1)。
// それ以外のフィールドは解決しないため、dump (config.md §5) が secret を
// 解決済みで出すことが構造上ありえない。

import { isAbsolute } from "node:path";

import { z } from "zod";

import { type SandboxRules, SandboxRulesSchema } from "./sandbox-config.js";

/** skills / extensions / sandbox に書けるパス。絶対パス、または設定ファイルの場所からの
 * 相対 (./ か ../ 始まり) のみ (config.md §3.5)。裸の相対パス ("foo/bar") は
 * 基準ディレクトリが曖昧になるため schema で弾く。相対パスの絶対化は
 * ConfigSource (config-source.ts resolveFileReferences) が行う。 */
export const PathRefSchema = z
  .string()
  .refine(
    (value) =>
      isAbsolute(value) || value.startsWith("./") || value.startsWith("../"),
    {
      message:
        'path must be absolute or start with "./" (relative to the config file)',
    },
  );

/** Agent Config (config.md §1.3)。全フィールド optional で、マージの各段が
 * 「書いたフィールドだけ上書き」する (config.md §3.2)。 */
export const AgentConfigSchema = z
  .object({
    /** 役割・口調・運用ルール。共通プロンプトへ追記する。"./" / "../" 始まりは
     * 設定ファイル基準のファイル参照としてインライン化される (config.md §3.5)。 */
    systemPrompt: z.string().optional(),
    /** 短い参照テキストの配列。初回 Turn の入力先頭に足す。systemPrompt と同じく
     * "./" / "../" 始まりはファイル参照。 */
    context: z.array(z.string()).optional(),
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
     * 適用されるため、runtime が reply を自動補完する (runtime.ts buildPiArgs) */
    tools: z.array(z.string()).optional(),
    /** pi の --exclude-tools に渡す denylist。reply を書いても無視する */
    excludeTools: z.array(z.string()).optional(),
    /** 追加ロードする skill。pi の --skill にそのまま渡す (SKILL.md を直接含む
     * 単体 skill dir でも、複数 skill を束ねた親 dir でもよい — pi が再帰発見する)。
     * $AGENT_HOME/.pi/agent/skills/ の自動発見分への追加 (additive) であり、
     * 共通分を外す手段ではない (config.md §1.3) */
    skills: z.array(PathRefSchema).optional(),
    /** 追加ロードする extension (.ts/.js のファイルパス。pi の --extension は
     * ディレクトリを受けない)。常時注入の組み込み (reply/permission-gate/export) と
     * $AGENT_HOME/.pi/agent/extensions/ の自動列挙分への追加 (additive) */
    extensions: z.array(PathRefSchema).optional(),
    /** 組み込み memory skill の配線 (docs/design/runtime.md §4.4)。shared 有効
     * (system.state.agent.sharedDir 設定時) の既定は true で、false で Channel 単位に
     * 外せる (opt-out)。shared 無効時はこの値に関わらず配線されない */
    memory: z.boolean().optional(),
    /** pi 子プロセスへ渡す env の名前=値マップ (足し算モデル)。値に ${env.X} /
     * ${env.X:-default} 参照を書ける唯一の Agent Config フィールド (config.md §2.1)。
     * 解決は root-config.ts のロード時に行う。 */
    env: z.record(z.string(), z.string()).optional(),
    /** pi を srt (sandbox-runtime) で包むルール (docs/design/runtime.md §5.5)。
     * `false` | srt ネイティブ形式のファイルパス (JSON / YAML) | srt の設定そのものを
     * インラインで書いたもの。省略 = 無効 (opt-in)。provider の到達先 (allowedDomains)
     * も利用者が書く — Runner は network に何も足さない。ファイルはロード時に読んで
     * 検証・インライン化する (config-source.ts)。Channel 側 (channels[].agent.sandbox)
     * は形が違い、ここの設定が持つ配列に要素を足すだけ (channel-config.ts、
     * config.md §3.2) */
    sandbox: z
      .union([z.literal(false), PathRefSchema, SandboxRulesSchema])
      .optional(),
  })
  .strict();

/** ファイル上の形 (sandbox がパス文字列のこともある)。 */
export type AgentConfigInput = z.infer<typeof AgentConfigSchema>;

/** ロード後の Agent Config。sandbox のファイル参照は読まれてインライン化済みで、
 * `false` か正規化済みの srt 設定しか現れない。 */
export type AgentConfig = Omit<AgentConfigInput, "sandbox"> & {
  sandbox?: false | SandboxRules | undefined;
};
