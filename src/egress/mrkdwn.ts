// GFM → Slack mrkdwn 変換 (chat-model.md §3.2 renderMarkdown(md) → mrkdwn 相当)
//
// 手順: code span/fenced code block をプレースホルダに退避 → 残りをエスケープ
// → 行単位変換 (見出し/リスト) → インライン変換 (bold/italic/strike/link) → 復元。
// code の中身は一切変換・エスケープしない。

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

// pi が出力する Slack エンティティ (mention 等) はそのまま Slack に届ける必要があり、
// escapeSlackChars の `<`→`&lt;` で潰すと mention 化されずプレーン文字列で表示される。
// システムプロンプトが pi に <@USER_ID> 形式での mention を指示している (egress は
// その出力を尊重する)。対象は <@U...> (user)、<#C...> (channel、`|label` 任意)、
// <!here>/<!channel>/<!everyone>/<!subteam^...> (special)。URL リンクは
// convertInline が markdown から生成するのでここでは拾わない。
const SLACK_ENTITY_RE =
	/<(?:@[A-Z0-9]+|#[A-Z0-9]+(?:\|[^>]*)?|![a-zA-Z]+(?:\^[A-Z0-9]+)?(?:\|[^>]*)?)>/g;

// 制御文字 (\0) は通常テキストに出現しないため、これで囲んで衝突しないプレースホルダを作る。
// リテラル正規表現に制御文字を書くと lint に引っかかるため String.fromCharCode 経由で組み立てる
const NUL = String.fromCharCode(0);
const PLACEHOLDER_RE = new RegExp(`${NUL}(\\d+)${NUL}`, "g");

/** code span/block と Slack エンティティ (mention 等) を復元可能なプレースホルダに
 * 退避する。どちらも中身を変換・エスケープしてはいけない (code は原文保持、
 * エンティティは Slack 構文をそのまま届ける) ため同じ stash 機構に載せる。
 * code を先に退避するので、code 内に現れる <@U...> 風の文字列はエンティティ扱い
 * されずリテラルのまま保たれる。 */
function stashProtected(text: string): {
	stashed: string;
	restore: (s: string) => string;
} {
	const blocks: string[] = [];
	const stash = (s: string) => {
		const token = `${NUL}${blocks.length}${NUL}`;
		blocks.push(s);
		return token;
	};

	const stashed = text
		.replace(FENCE_RE, stash)
		.replace(INLINE_CODE_RE, stash)
		.replace(SLACK_ENTITY_RE, stash);

	const restore = (s: string) =>
		s.replace(PLACEHOLDER_RE, (_, i) => blocks[Number(i)] ?? "");

	return { stashed, restore };
}

function escapeSlackChars(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// bold/見出しが生成した * は italic 変換の対象から外すため、一時的に別の制御文字で囲んでおく
const BOLD_MARK = String.fromCharCode(1);

/** 見出し・リストなど行頭記法の変換。見出しは太字化するので BOLD_MARK で囲み、italic 変換を回避する */
function convertLines(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const heading = line.match(/^(#{1,6}) +(.*)$/);
			if (heading) {
				return `${BOLD_MARK}${heading[2]}${BOLD_MARK}`;
			}
			return line.replace(/^([ \t]*)[*-] /, "$1- ");
		})
		.join("\n");
}

/** bold/italic/strikethrough/link のインライン変換 */
function convertInline(text: string): string {
	let result = text
		// 画像は Slack がインライン表示できないためリンク化
		.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>")
		.replace(/\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>")
		.replace(/~~([^~]+)~~/g, "~$1~")
		// bold は BOLD_MARK で囲み、italic 変換 (単一 * → _) の対象から保護する
		.replace(/\*\*([^*]+)\*\*/g, `${BOLD_MARK}$1${BOLD_MARK}`)
		.replace(/__([^_]+)__/g, `${BOLD_MARK}$1${BOLD_MARK}`);

	// bold 変換後に残った単一 * は italic として _ に正規化
	result = result.replace(/\*([^*]+)\*/g, "_$1_");

	return result.replace(new RegExp(BOLD_MARK, "g"), "*");
}

export function toMrkdwn(text: string): string {
	const { stashed, restore } = stashProtected(text);
	const escaped = escapeSlackChars(stashed);
	const lined = convertLines(escaped);
	const inlined = convertInline(lined);
	return restore(inlined);
}
