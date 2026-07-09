// MessageChunker — 長文を Slack 投稿単位に分割する (chat-model.md §3.4)
//
// 段落 (\n\n) → 行 (\n) → 文字数ハード分割、の順にフォールバックしながら
// limit 以下のチャンクへ貪欲パッキングする。コードフェンス ``` をまたぐ場合は
// その場で閉じ、次チャンク先頭で同じ info string (言語指定) で開き直す。

export const SLACK_MESSAGE_LIMIT = 3800;

const FENCE_LINE = /^\s*```(.*)$/;

/** text を limit 以下のチャンクに分割する。空文字/空白のみは [] を返す
 * (呼び出し側が files-only 投稿を判断する)。 */
export function chunkMessage(
  text: string,
  limit = SLACK_MESSAGE_LIMIT,
): string[] {
  if (text.trim().length === 0) return [];
  if (text.length <= limit) return [text];

  const rawChunks = packParagraphs(text, limit);
  return applyFenceContinuation(rawChunks);
}

/** 段落単位の貪欲パッキング。単一段落が limit 超なら行分割へフォールバックする。 */
function packParagraphs(text: string, limit: number): string[] {
  return packUnits(text.split("\n\n"), "\n\n", limit, (paragraph) =>
    packLines(paragraph, limit),
  );
}

/** 行単位の貪欲パッキング。単一行が limit 超なら文字数ハード分割へフォールバックする。 */
function packLines(text: string, limit: number): string[] {
  return packUnits(text.split("\n"), "\n", limit, (line) =>
    hardSplit(line, limit),
  );
}

/** 文字数でのハード分割。改行を挟めない単一行が limit を超えるときの最終フォールバック。 */
function hardSplit(text: string, limit: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}

/** units を separator で貪欲パッキングする。単一 unit が limit を超える場合は
 * oversizedFallback で細分化し、結果をそのままチャンク列に差し込む。 */
function packUnits(
  units: string[],
  separator: string,
  limit: number,
  oversizedFallback: (unit: string) => string[],
): string[] {
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = "";
  };

  for (const unit of units) {
    if (unit.length > limit) {
      flush();
      chunks.push(...oversizedFallback(unit));
      continue;
    }
    const candidate = current.length === 0 ? unit : current + separator + unit;
    if (candidate.length > limit) {
      flush();
      current = unit;
    } else {
      current = candidate;
    }
  }
  flush();

  return chunks;
}

/** チャンクごとに開いたまま閉じていないコードフェンスを検出し、閉じ/開き直しを差し込む。 */
function applyFenceContinuation(chunks: string[]): string[] {
  const result: string[] = [];
  let pendingLang: string | undefined;

  for (const chunk of chunks) {
    const body =
      pendingLang !== undefined ? `\`\`\`${pendingLang}\n${chunk}` : chunk;
    const { openLang } = scanFences(body);

    result.push(openLang !== undefined ? `${body}\n\`\`\`` : body);
    pendingLang = openLang;
  }

  return result;
}

/** チャンク内のフェンス行を走査し、末尾で開いたままなら info string (言語) を返す。 */
function scanFences(chunk: string): { openLang: string | undefined } {
  let openLang: string | undefined;

  for (const line of chunk.split("\n")) {
    const match = line.match(FENCE_LINE);
    if (match === null) continue;
    openLang = openLang === undefined ? match[1] : undefined;
  }

  return { openLang };
}
