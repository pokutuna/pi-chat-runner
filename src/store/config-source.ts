// ConfigSource(File) — docs/design/config.md §6
//
// 「Firestore が実行時の正」は変えず、ローカル/お試しでは同じ YAML をファイルから直接読む
// (FirestoreConfigSource は Step 4 で実装する。ここでは作らない)。
//
// FileConfigSource は毎回読み直す (キャッシュしない)。ローカル用途なのでコストは無視できる。
// これにより「YAML 編集 → 再起動なしで挙動が変わる」(build-plan.md Step 3) が
// file watch なしで成立する。

import { readdir, readFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	type ChannelDoc,
	ChannelDocFileSchema,
	ChannelDocSchema,
} from "./channel-doc.js";

/** channels/*.yaml を id で検索し、実行時 ChannelDoc を返す抽象 (config.md §6)。 */
export interface ConfigSource {
	channel(id: string): Promise<ChannelDoc | null>;
}

const CHANNELS_DIR = "channels";
const YAML_EXTENSIONS = [".yaml", ".yml"];

/** channel フィールドの予約値。どの ID にも一致しなかったときのフォールバック定義。
 * Slack のチャンネル ID がこの文字列になることはないため衝突しない。
 * セッション・メッセージ管理は常に実チャンネル ID で行われ、フォールバックは
 * ChannelDoc (振る舞い定義) の解決にのみ作用する。 */
export const DEFAULT_CHANNEL = "default";

/** DM 用 ChannelDoc の予約名 (config.md §2)。全 DM 共通の振る舞い定義。
 * 小文字なので実チャンネル ID (D...) と衝突しない。 */
export const DM_CHANNEL = "dm";

/** ローカル/お試し用の ConfigSource。config ディレクトリ (channels/*.yaml と
 * prompts/ を含む親) を受け取り、apply を経ずに直接 YAML を読む (config.md §6)。 */
export class FileConfigSource implements ConfigSource {
	constructor(private readonly configDir: string) {}

	async channel(id: string): Promise<ChannelDoc | null> {
		const channelsDir = join(this.configDir, CHANNELS_DIR);
		const entries = await listYamlFiles(channelsDir);

		// ID 完全一致が最優先。無ければ channel: "default" の doc にフォールバックする
		let fallback: {
			doc: Awaited<ReturnType<typeof loadChannelDocFile>>;
			filePath: string;
		} | null = null;
		for (const filePath of entries) {
			const doc = await loadChannelDocFile(filePath);
			if (doc.channel === id) {
				return await resolveFileReferences(doc, filePath, this.configDir);
			}
			if (doc.channel === DEFAULT_CHANNEL && fallback === null) {
				fallback = { doc, filePath };
			}
		}
		// DM (予約名 "dm") は default にフォールバックしない。default doc は通常チャンネル向けの
		// フォールバックで、これを DM に適用すると DM の既定 (passthrough) が default の
		// trigger (通常 mention) に上書きされてしまう (config.md §2)
		if (fallback !== null && id !== DM_CHANNEL) {
			return await resolveFileReferences(
				fallback.doc,
				fallback.filePath,
				this.configDir,
			);
		}
		return null;
	}
}

async function listYamlFiles(dir: string): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw err;
	}
	return names
		.filter((name) => YAML_EXTENSIONS.includes(extname(name)))
		.map((name) => join(dir, name))
		.sort();
}

/** 1 ファイルを読み、YAML パース + strict 検証する。失敗はファイル名 + zod issue 付きで throw (fail-loud)。 */
async function loadChannelDocFile(
	filePath: string,
): Promise<ReturnType<(typeof ChannelDocFileSchema)["parse"]>> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		throw new Error(`failed to read channel doc file: ${filePath}`, {
			cause: err,
		});
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		throw new Error(`invalid YAML in channel doc file: ${filePath}`, {
			cause: err,
		});
	}

	const result = ChannelDocFileSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		throw new Error(`invalid channel doc schema in ${filePath}:\n${issues}`);
	}
	return result.data;
}

/** systemPrompt / context の値が "./" か "../" で始まる場合、config ディレクトリ (channels/*.yaml
 * と prompts/ を含む親) からの相対パスでファイルを読んでインライン化する (config.md §6 の
 * apply 時インライン化と同じ規則。§6 の例は agent-config/ 直下からの相対で書かれている)。 */
async function resolveFileReferences(
	doc: ReturnType<(typeof ChannelDocFileSchema)["parse"]>,
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
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
		...(context !== undefined ? { context } : {}),
		...(doc.trigger !== undefined ? { trigger: doc.trigger } : {}),
		...(doc.model !== undefined ? { model: doc.model } : {}),
	};

	// channel を含む YAML 形式から実行時 ChannelDoc への変換。ここで再度 strict 検証しておく
	// (resolved が実行時スキーマの形を守っていることの保証)。
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
