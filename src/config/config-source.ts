// ConfigSource(File) — docs/design/config.md §2〜§2.3, §6
//
// 「Firestore が実行時の正」は元々の設計方針だが、当面はローカル・本番とも同じ YAML を
// ファイルから直接読む FileConfigSource で運用する。FirestoreConfigSource と、それに YAML を
// 書き込む apply CLI は見送り中。本番設定を Firestore を実行時の正とする方式へ
// 移す判断をしたら FirestoreConfigSource を追加する。
//
// チャンネル設定は設定ファイル (単一 YAML, root-config.ts) の channels ブロックに
// 全チャンネルを配列で並べる (config.md §2)。実行時は常に default (または DM は dm) +
// そのチャンネル固有エントリをマージした 1 つの ChannelDoc で動く (§2.2 マージ)。
// マージはフィールド単位の丸ごと置換のみで、深いマージはしない。
//
// channels ブロックは env 参照 (${env.X}) の解決を通らない — connector 等の secrets を
// 含む他ブロックにも触れないため、dump (config.md §6) が secrets を解決せずに済む
// 性質がこの経路で成立する。
//
// FileConfigSource は毎回読み直す (キャッシュしない)。ローカル用途なのでコストは無視できる。
// これにより「YAML 編集 → 再起動なしで挙動が変わる」が file watch なしで成立する。

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  type ChannelDoc,
  ChannelDocSchema,
  type ChannelEntry,
  type ChannelsFile,
  ChannelsFileSchema,
} from "./channel-doc.js";
import { readRootConfig } from "./root-config.js";

/** channels ブロックを id で解決し、実行時 ChannelDoc を返す抽象 (config.md §6)。 */
export interface ConfigSource {
  channel(id: string): Promise<ChannelDoc | null>;
}

/** channel フィールドの予約値。どの ID にも一致しなかったときの土台 (default) を指す。
 * Slack のチャンネル ID がこの文字列になることはないため衝突しない。
 * セッション・メッセージ管理は常に実チャンネル ID で行われ、この予約名は
 * ChannelDoc (振る舞い定義) の解決にのみ作用する。 */
export const DEFAULT_CHANNEL = "default";

/** DM 用 ChannelDoc の予約名 (config.md §2)。全 DM 共通の振る舞い定義の土台。
 * 小文字なので実チャンネル ID (D...) と衝突しない。 */
export const DM_CHANNEL = "dm";

/** ChannelDoc の各 top-level フィールドがどのエントリ由来かを示す (config.md §6 実効設定)。
 * "default" / "dm" は土台エントリ由来、"channel" はチャンネル固有エントリ由来。 */
export type FieldSource = "default" | "channel" | "dm";

/** ChannelDoc の top-level キーごとの出所。省略時 (キー無し) はどちらのエントリにも
 * 値が無い (=フィールド自体が undefined) ことを意味する。 */
export type Provenance = Partial<Record<keyof ChannelDoc, FieldSource>>;

/** ChannelDoc の top-level キー一覧。マージ・provenance 計算で共有する (config.md §2.2)。 */
const CHANNEL_DOC_KEYS = [
  "systemPrompt",
  "context",
  "trigger",
  "model",
  "tools",
  "excludeTools",
  "session",
  "reply",
] as const satisfies readonly (keyof ChannelDoc)[];

/** ChannelEntry から channel フィールドを落とし、ChannelDoc 部分だけを取り出す。 */
function toChannelDoc(entry: ChannelEntry): ChannelDoc {
  const { channel: _channel, ...doc } = entry;
  return doc;
}

/** merge(base, own) の規則は 1 つだけ (config.md §2.2):
 * own に書いた top-level フィールド = その値。書かないフィールド = base の値。
 * 深いマージ (部分マージ) は一切しない。 */
export function mergeChannelDoc(base: ChannelDoc, own: ChannelDoc): ChannelDoc {
  return mergeWithProvenance(base, "default", own).doc;
}

/** マージ結果と、各フィールドがどちらのエントリ由来かを同時に返す (config.md §6 実効設定)。
 * baseSource は base エントリの出所 ("default" | "dm")。own 由来のフィールドは常に "channel"。 */
export function mergeWithProvenance(
  base: ChannelDoc,
  baseSource: "default" | "dm",
  own: ChannelDoc,
): { doc: ChannelDoc; provenance: Provenance } {
  const doc: ChannelDoc = {};
  const provenance: Provenance = {};

  for (const key of CHANNEL_DOC_KEYS) {
    if (key in own) {
      // biome-ignore lint/suspicious/noExplicitAny: 単一キーの代入は ChannelDoc の型上安全
      (doc as any)[key] = own[key];
      provenance[key] = "channel";
    } else if (key in base) {
      // biome-ignore lint/suspicious/noExplicitAny: 単一キーの代入は ChannelDoc の型上安全
      (doc as any)[key] = base[key];
      provenance[key] = baseSource;
    }
  }

  return { doc, provenance };
}

/** id からエントリを解決し、default (または DM は dm) + 固有エントリをマージした
 * ChannelDoc を返す (config.md §2.1, §6 実効設定)。ファイル参照のインライン化前の値。
 *
 * - id === DM_CHANNEL: 土台は dm エントリ。無ければ null (passthrough に落ちる、config.md §2.1)。
 * - それ以外: 土台は default エントリ。ChannelsFileSchema が存在を必須にしているため
 *   通常は必ず在るが、防御的に無ければ fail-loud で throw する。
 * - 固有エントリが無ければ土台単独 (全フィールドが土台由来の provenance) を返す。
 */
export function resolveChannelConfig(
  file: ChannelsFile,
  id: string,
): { doc: ChannelDoc; provenance: Provenance } | null {
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

  const base = toChannelDoc(baseEntry);
  // DM は dm エントリ自体が土台であり、その上に重ねる固有エントリは無い
  // (own === base になると全フィールドが "channel" 由来に化けて provenance が壊れる)。
  // 通常チャンネルのみ id 一致エントリを own として default に重ねる。
  const own =
    id !== DM_CHANNEL && ownEntry !== undefined ? toChannelDoc(ownEntry) : {};
  return mergeWithProvenance(base, baseSource, own);
}

/** ローカル/お試し用の ConfigSource。設定ファイル (単一 YAML) のパスを受け取り、
 * apply を経ずに直接 channels ブロックを読む (config.md §6)。systemPrompt / context の
 * ファイル参照 (./...) はこの YAML があるディレクトリからの相対で解決する。 */
export class FileConfigSource implements ConfigSource {
  constructor(private readonly configPath: string) {}

  async channel(id: string): Promise<ChannelDoc | null> {
    const file = await loadChannelsFile(this.configPath);

    const resolved = resolveChannelConfig(file, id);
    if (resolved === null) {
      return null;
    }
    return await resolveFileReferences(
      resolved.doc,
      this.configPath,
      dirname(this.configPath),
    );
  }
}

/** 設定ファイルから channels ブロックを取り出し、strict 検証する。ファイル不在
 * (ENOENT)・channels ブロック不在は設定ミスとして fail-loud で throw する。YAML 破損・
 * schema 違反もファイルパス + zod issue 付きで throw する。server の通常経路
 * (FileConfigSource) と dump (config.md §6) が同じローダを共有する — dump 専用の
 * 読み込みを持たない。channels ブロックには env 参照 (${env.X}) の解決を適用しない
 * (ファイル冒頭コメント参照)。 */
export async function loadChannelsFile(
  filePath: string,
): Promise<ChannelsFile> {
  const parsed = await readRootConfig(filePath);
  if (parsed === undefined) {
    throw new Error(`failed to read config file: ${filePath} (not found)`);
  }
  if (parsed.channels === undefined) {
    throw new Error(`config file has no "channels" section: ${filePath}`);
  }

  const result = ChannelsFileSchema.safeParse({ channels: parsed.channels });
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`invalid channels schema in ${filePath}:\n${issues}`);
  }
  return result.data;
}

/** systemPrompt / context の値が "./" か "../" で始まる場合、設定ファイルがある
 * ディレクトリからの相対パスでファイルを読んでインライン化する (config.md §6)。
 * マージ後の doc に対して一括で適用する — どのエントリ由来でも相対パスの起点は
 * 設定ファイルの場所で共通なため。 */
async function resolveFileReferences(
  doc: ChannelDoc,
  yamlFilePath: string,
  baseDir: string,
): Promise<ChannelDoc> {
  const systemPrompt =
    doc.systemPrompt !== undefined
      ? await inlineIfFileRef(doc.systemPrompt, baseDir, yamlFilePath)
      : undefined;

  const context =
    doc.context !== undefined
      ? await Promise.all(
          doc.context.map((value) =>
            inlineIfFileRef(value, baseDir, yamlFilePath),
          ),
        )
      : undefined;

  const resolved: ChannelDoc = {
    ...doc,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(context !== undefined ? { context } : {}),
  };

  // インライン化後の doc が実行時スキーマの形を守っていることの保証として再度 strict 検証する。
  const validated = ChannelDocSchema.safeParse(resolved);
  if (!validated.success) {
    throw new Error(
      `resolved channel doc failed validation (${yamlFilePath}): ${validated.error.message}`,
    );
  }
  return validated.data;
}

function isFileRef(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
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
