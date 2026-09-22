// ConfigSource(File) — docs/design/config.md §3
//
// Channel Config と Agent Config は、リポジトリに置いた YAML を実行時にそのまま
// 直読みする。書く場所と読む場所が同じ 1 ファイルで、中間ストアも焼き込みステップも
// 挟まない。実装は 1 つだけで、本番もローカルも同じローダーを使う。
//
// 設定ファイル (単一 YAML, root-config.ts) の `agent` ブロック (全 Channel 共通の
// default Agent Config) と `channels` ブロックを読む。実行時は常に
// 「Channel 部分 = channels[default] → channels[id] の 2 段」
// 「Agent 部分   = agent → channels[default].agent → channels[id].agent の 3 段」を
// マージした 1 つの ResolvedChannel で動く (config.md §3.2)。マージはフィールド単位の
// 丸ごと置換のみで、深いマージはしない。
//
// env 参照 (${env.X}) の解決は agent.env / channels[].agent.env の値だけに適用する
// (config.md §2.1)。system ブロックには触れないため、dump (config.md §5) が secrets を
// 解決せずに済む性質がこの経路で成立する。
//
// FileConfigSource は mtime ベースでキャッシュする (stat して変化が無ければ前回の
// parse 結果を再利用)。ファイル未変更時の再 parse を避けつつ、「YAML 編集 →
// 再起動なしで挙動が変わる」は mtime の変化で検知して成立させる (file watch 不要)。

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { type AgentConfig, AgentConfigSchema } from "./agent-config.js";
import {
  type ChannelConfig,
  ChannelConfigSchema,
  type ChannelEntry,
  type ChannelsFile,
  ChannelsFileSchema,
} from "./channel-config.js";
import { readRootConfig, resolveAgentEnvRefs } from "./root-config.js";

/** マージ後の実効 Channel 設定 (config.md §3)。Channel 部分は未設定なら
 * undefined のまま (読む側のコード既定に落ちる) だが、Agent 部分は 3 段の
 * マージ結果として常に存在する (空オブジェクトのこともある)。 */
export interface ResolvedChannel {
  trigger?: ChannelConfig["trigger"];
  session?: ChannelConfig["session"];
  reply?: ChannelConfig["reply"];
  agent: AgentConfig;
}

/** channels ブロックを id で解決し、実効 Channel 設定を返す抽象 (config.md §3)。 */
export interface ConfigSource {
  channel(id: string): Promise<ResolvedChannel | null>;
}

/** channel フィールドの予約値。どの ID にも一致しなかったときの土台 (default) を指す。
 * Slack のチャンネル ID がこの文字列になることはないため衝突しない。
 * セッション・メッセージ管理は常に実チャンネル ID で行われ、この予約名は
 * Channel Config (振る舞い定義) の解決にのみ作用する。 */
export const DEFAULT_CHANNEL = "default";

/** DM 用 Channel Config の予約名 (config.md §3.1)。全 DM 共通の振る舞い定義の土台。
 * 小文字なので実チャンネル ID (D...) と衝突しない。 */
export const DM_CHANNEL = "dm";

/** 各フィールドがどの段の由来かを示す (config.md §3.3)。
 * Channel 部分: "default" / "dm" は土台エントリ由来、"channel" は Channel 固有エントリ由来。
 * Agent 部分: "default agent" はトップレベル agent ブロック由来、"channel agent" は
 * channels[*].agent 由来。 */
export type FieldSource =
  | "default"
  | "channel"
  | "dm"
  | "default agent"
  | "channel agent";

/** Channel 部分 (trigger / session / reply) の top-level キーごとの出所。 */
export type Provenance = Partial<Record<keyof ChannelPart, FieldSource>>;

/** Agent 部分の top-level キーごとの出所。 */
export type AgentProvenance = Partial<Record<keyof AgentConfig, FieldSource>>;

/** ChannelConfig から agent を除いた「Channel 部分」(config.md §3.2 のマージ表)。 */
export type ChannelPart = Omit<ChannelConfig, "agent">;

/** マージ・provenance 計算で走査する Channel 部分のキー一覧。
 * `Record<keyof ChannelPart, true>` で網羅を型に強制する — フィールドを足したのに
 * マージから漏れる、という事故 (旧 CHANNEL_DOC_KEYS の memory 抜け) を防ぐ。 */
const CHANNEL_PART_KEYS = Object.keys({
  trigger: true,
  session: true,
  reply: true,
} satisfies Record<keyof ChannelPart, true>) as (keyof ChannelPart)[];

/** マージ・provenance 計算で走査する Agent Config のキー一覧。CHANNEL_PART_KEYS と
 * 同じく `Record<keyof AgentConfig, true>` で網羅を型に強制する。 */
const AGENT_CONFIG_KEYS = Object.keys({
  systemPrompt: true,
  context: true,
  model: true,
  tools: true,
  excludeTools: true,
  skills: true,
  extensions: true,
  memory: true,
  env: true,
} satisfies Record<keyof AgentConfig, true>) as (keyof AgentConfig)[];

/** ChannelEntry から channel / agent を落とし、Channel 部分だけを取り出す。 */
function toChannelPart(entry: ChannelEntry): ChannelPart {
  const { channel: _channel, agent: _agent, ...part } = entry;
  return part;
}

/** merge(base, own) の規則は 1 つだけ (config.md §3.2):
 * own に書いた top-level フィールド = その値。書かないフィールド = base の値。
 * 深いマージ (部分マージ) は一切しない。key 一覧を渡して Channel 部分 / Agent 部分の
 * どちらにも使う汎用実装。 */
function mergeLayer<T extends object>(
  keys: readonly (keyof T)[],
  base: T,
  baseProvenance: Partial<Record<keyof T, FieldSource>>,
  own: T,
  ownSource: FieldSource,
): { value: T; provenance: Partial<Record<keyof T, FieldSource>> } {
  const value = {} as T;
  const provenance: Partial<Record<keyof T, FieldSource>> = {};

  for (const key of keys) {
    if (key in own) {
      value[key] = own[key];
      provenance[key] = ownSource;
    } else if (key in base) {
      value[key] = base[key];
      const inherited = baseProvenance[key];
      if (inherited !== undefined) provenance[key] = inherited;
    }
  }

  return { value, provenance };
}

/** Channel 部分の 2 段マージ (config.md §3.2)。baseSource は土台エントリの出所
 * ("default" | "dm")。own 由来のフィールドは常に "channel"。 */
export function mergeChannelPart(
  base: ChannelPart,
  baseSource: "default" | "dm",
  own: ChannelPart,
): { part: ChannelPart; provenance: Provenance } {
  const baseProvenance: Provenance = {};
  for (const key of CHANNEL_PART_KEYS) {
    if (key in base) baseProvenance[key] = baseSource;
  }
  const merged = mergeLayer(
    CHANNEL_PART_KEYS,
    base,
    baseProvenance,
    own,
    "channel",
  );
  return { part: merged.value, provenance: merged.provenance };
}

/** Agent 部分の 3 段マージ (config.md §3.2):
 * `agent` (default ブロック) → `channels[base].agent` → `channels[id].agent`。
 * トップレベル agent ブロック由来は "default agent"、channels[*].agent 由来は
 * "channel agent" (どの channels エントリでも同じラベル)。 */
export function mergeAgentConfig(
  defaultAgent: AgentConfig,
  baseAgent: AgentConfig,
  ownAgent: AgentConfig,
): { agent: AgentConfig; provenance: AgentProvenance } {
  const defaultProvenance: AgentProvenance = {};
  for (const key of AGENT_CONFIG_KEYS) {
    if (key in defaultAgent) defaultProvenance[key] = "default agent";
  }
  const stage1 = mergeLayer(
    AGENT_CONFIG_KEYS,
    defaultAgent,
    defaultProvenance,
    baseAgent,
    "channel agent",
  );
  const stage2 = mergeLayer(
    AGENT_CONFIG_KEYS,
    stage1.value,
    stage1.provenance,
    ownAgent,
    "channel agent",
  );
  return { agent: stage2.value, provenance: stage2.provenance };
}

/** id からエントリを解決し、Channel 部分と Agent 部分をそれぞれマージした
 * ResolvedChannel を返す (config.md §3.1, §3.2, §3.3)。ファイル参照のインライン化前の値。
 *
 * - id === DM_CHANNEL: Channel 部分の土台は dm エントリのみ (default を継承しない)。
 *   dm エントリが無ければ null (コード既定 = disabled に落ちる、config.md §3.1)。
 *   Agent 部分はトップレベル agent ブロック → dm エントリの agent の 2 段
 *   (DM も全 Channel 共通の Agent Config を土台にする)。
 * - それ以外: Channel 部分の土台は default エントリ。ChannelsFileSchema が存在を
 *   必須にしているため通常は必ず在るが、防御的に無ければ fail-loud で throw する。
 *   Agent 部分は agent → default エントリの agent → id エントリの agent の 3 段。
 * - 固有エントリが無ければ土台単独 (全フィールドが土台由来の provenance) を返す。
 */
export function resolveChannelConfig(
  file: ChannelsFile,
  id: string,
  defaultAgent: AgentConfig = {},
): {
  channel: ResolvedChannel;
  provenance: Provenance;
  agentProvenance: AgentProvenance;
} | null {
  const defaultEntry = file.channels.find((c) => c.channel === DEFAULT_CHANNEL);
  const dmEntry = file.channels.find((c) => c.channel === DM_CHANNEL);
  const ownEntry = file.channels.find((c) => c.channel === id);

  const baseSource: "default" | "dm" = id === DM_CHANNEL ? "dm" : "default";
  const baseEntry = baseSource === "dm" ? dmEntry : defaultEntry;

  if (baseEntry === undefined) {
    if (baseSource === "dm") {
      return null;
    }
    throw new Error(
      `channels is missing the required "${DEFAULT_CHANNEL}" entry`,
    );
  }

  // DM は dm エントリ自体が土台であり、その上に重ねる固有エントリは無い
  // (own === base になると全フィールドが "channel" 由来に化けて provenance が壊れる)。
  // 通常チャンネルのみ id 一致エントリを own として default に重ねる。
  const own =
    id !== DM_CHANNEL && ownEntry !== undefined ? ownEntry : undefined;

  const { part, provenance } = mergeChannelPart(
    toChannelPart(baseEntry),
    baseSource,
    own !== undefined ? toChannelPart(own) : {},
  );
  const { agent, provenance: agentProvenance } = mergeAgentConfig(
    defaultAgent,
    baseEntry.agent ?? {},
    own?.agent ?? {},
  );

  return { channel: { ...part, agent }, provenance, agentProvenance };
}

/** 設定ファイル (単一 YAML) のパスを受け取り、agent / channels ブロックを直読みする
 * ConfigSource (config.md §3)。systemPrompt / context のファイル参照 (./...) は
 * この YAML があるディレクトリからの相対で解決する。
 *
 * mtime が前回と変わっていなければ parse 済みの結果を再利用する (キャッシュ)。
 * mtime が変わっていれば読み直す — 「YAML 編集 → 再起動なしで挙動が変わる」は
 * この再読み込みで成立し続ける。 */
export class FileConfigSource implements ConfigSource {
  private cache:
    | { mtimeMs: number; file: ChannelsFile; defaultAgent: AgentConfig }
    | undefined;

  constructor(private readonly configPath: string) {}

  async channel(id: string): Promise<ResolvedChannel | null> {
    const { file, defaultAgent } = await this.loadCached();

    const resolved = resolveChannelConfig(file, id, defaultAgent);
    if (resolved === null) {
      return null;
    }
    return await resolveFileReferences(
      resolved.channel,
      this.configPath,
      dirname(this.configPath),
    );
  }

  private async loadCached(): Promise<{
    file: ChannelsFile;
    defaultAgent: AgentConfig;
  }> {
    // stat 失敗 (ENOENT 等) はここで特別扱いせず loadChannelConfigFile に委譲する —
    // readRootConfig の ENOENT 処理・エラーメッセージ (fail-loud) をそのまま使うため。
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.configPath)).mtimeMs;
    } catch {
      return await loadChannelConfigFile(this.configPath);
    }
    if (this.cache !== undefined && this.cache.mtimeMs === mtimeMs) {
      return this.cache;
    }
    const loaded = await loadChannelConfigFile(this.configPath);
    this.cache = { mtimeMs, ...loaded };
    return loaded;
  }
}

/** 設定ファイルから agent ブロック (default Agent Config) と channels ブロックを
 * 取り出し、strict 検証する。ファイル不在 (ENOENT)・channels ブロック不在は設定ミス
 * として fail-loud で throw する。YAML 破損・schema 違反もファイルパス + zod issue
 * 付きで throw する。server の通常経路 (FileConfigSource) と dump (config.md §5) が
 * 同じローダを共有する — dump 専用の読み込みを持たない。
 *
 * env 参照 (${env.X}) を解決するのは agent.env / channels[].agent.env の値だけ
 * (config.md §2.1)。opts.resolveEnv: false を渡すと、その agent.env すら解決せず
 * 書かれたままの参照文字列を残す — dump (config.md §5) 専用の経路で、
 * 「dump は secret を解決した値を出さない」を構造的に保証する。
 * このとき未設定の ${env.X} でも throw しない (dump は env 未設定の環境でも
 * 実効設定を読めるべきなので)。 */
export async function loadChannelConfigFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { resolveEnv?: boolean } = {},
): Promise<{ file: ChannelsFile; defaultAgent: AgentConfig }> {
  const resolveEnv = opts.resolveEnv ?? true;
  const parsed = await readRootConfig(filePath);
  if (parsed === undefined) {
    throw new Error(`failed to read config file: ${filePath} (not found)`);
  }
  if (parsed.channels === undefined) {
    throw new Error(`config file has no "channels" section: ${filePath}`);
  }

  const defaultAgent = parseDefaultAgent(
    parsed.agent,
    filePath,
    env,
    resolveEnv,
  );

  // channels[].agent.env だけ env 参照を解決してから strict 検証する。
  const channelsRaw =
    resolveEnv && Array.isArray(parsed.channels)
      ? parsed.channels.map((entry, index) => {
          if (entry === null || typeof entry !== "object") return entry;
          const e = entry as Record<string, unknown>;
          if (e.agent === undefined) return e;
          return {
            ...e,
            agent: resolveAgentEnvRefs(
              e.agent,
              env,
              `channels[${index}].agent`,
            ),
          };
        })
      : parsed.channels;

  const result = ChannelsFileSchema.safeParse({ channels: channelsRaw });
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`invalid channels schema in ${filePath}:\n${issues}`);
  }
  return { file: result.data, defaultAgent };
}

/** トップレベル `agent` ブロック (全 Channel 共通の default Agent Config) を検証する。
 * 省略されていれば {} (何も上書きしない土台)。 */
function parseDefaultAgent(
  agentRaw: unknown,
  filePath: string,
  env: NodeJS.ProcessEnv,
  resolveEnv: boolean,
): AgentConfig {
  if (agentRaw === undefined) return {};
  const resolved = resolveEnv
    ? resolveAgentEnvRefs(agentRaw, env, "agent")
    : agentRaw;
  const result = AgentConfigSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - agent.${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`invalid agent config schema in ${filePath}:\n${issues}`);
  }
  return result.data;
}

/** systemPrompt / context の値が "./" か "../" で始まる場合、設定ファイルがある
 * ディレクトリからの相対パスでファイルを読んでインライン化する (config.md §3.5)。
 * skills / extensions の相対パスは内容を読まず、同じ基準で絶対パス化だけする —
 * pi の cwd は workdir なので相対のまま渡すと基準がズレる (runner.ts kick)。
 * マージ後の Agent 部分に対して一括で適用する — どの段の由来でも相対パスの起点は
 * 設定ファイルの場所で共通なため。 */
async function resolveFileReferences(
  channel: ResolvedChannel,
  yamlFilePath: string,
  baseDir: string,
): Promise<ResolvedChannel> {
  const agent = channel.agent;

  const systemPrompt =
    agent.systemPrompt !== undefined
      ? await inlineIfFileRef(agent.systemPrompt, baseDir, yamlFilePath)
      : undefined;

  const context =
    agent.context !== undefined
      ? await Promise.all(
          agent.context.map((value) =>
            inlineIfFileRef(value, baseDir, yamlFilePath),
          ),
        )
      : undefined;

  const skills = agent.skills?.map((path) => absolutizePathRef(path, baseDir));
  const extensions = agent.extensions?.map((path) =>
    absolutizePathRef(path, baseDir),
  );

  const resolvedAgent: AgentConfig = {
    ...agent,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
  };

  // インライン化後の値が実行時スキーマの形を守っていることの保証として再度 strict 検証する。
  const { agent: _agent, ...channelPart } = channel;
  const validatedChannel = ChannelConfigSchema.safeParse({
    ...channelPart,
    agent: resolvedAgent,
  });
  if (!validatedChannel.success) {
    throw new Error(
      `resolved channel config failed validation (${yamlFilePath}): ${validatedChannel.error.message}`,
    );
  }
  return { ...validatedChannel.data, agent: validatedChannel.data.agent ?? {} };
}

function isFileRef(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

/** skills / extensions のパス参照を絶対パス化する。相対 (./ ../) は設定ファイルの
 * ディレクトリ基準。裸の相対パスは PathRefSchema (agent-config.ts) が弾いている。
 * CONFIG_PATH 自体が相対パスのとき baseDir も相対になるため、join ではなく
 * resolve で cwd 基準まで絶対化する (join だと相対のままになり再検証で落ちる)。 */
function absolutizePathRef(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

async function inlineIfFileRef(
  value: string,
  baseDir: string,
  yamlFilePath: string,
): Promise<string> {
  if (!isFileRef(value)) {
    return value;
  }
  const resolvedPath = isAbsolute(value) ? value : join(baseDir, value);
  try {
    return await readFile(resolvedPath, "utf-8");
  } catch (err) {
    throw new Error(
      `failed to inline file reference "${value}" from ${yamlFilePath} (resolved to ${resolvedPath})`,
      { cause: err },
    );
  }
}
