// repl.tsx の純粋ヘルパ (ink 非依存) の単体テスト。
// - formatLogLine: pino NDJSON を 1 論理行 (span 配列) へ整形する。pi (子
//   プロセスの coding agent) 由来のログ (`pi event`/`pi stderr`) は [pi] タグ
//   で強調し、eventType/stderr の line を head に昇格する。
// - wrapSpans: span 列を表示幅ごとの複数 Row (Span[][]) へ折り返す
//   (グラフェム単位、境界をまたいでも色/bold を維持する。string-width による
//   実測で East Asian Wide/絵文字を正しい幅で数える。log/chat 両ペインの
//   折り返し表示用)。

import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import {
  formatLogLine,
  type Line,
  normalizeToLogicalLines,
  type Span,
  titleBarText,
  wrapSpans,
} from "../../../src/ingress/local/repl.js";

/** span を連結した文字列で内容検証するためのヘルパ。 */
const flat = (entry: Line): string => entry.map((s) => s.text).join("");

describe("formatLogLine", () => {
  it("パース失敗 (非 JSON) は raw をそのまま 1 span で返す", () => {
    expect(formatLogLine("not json")).toEqual([{ text: "not json" }]);
  });

  it("必ず 1 行 (改行を含まない) に整形する", () => {
    const entry = formatLogLine(
      JSON.stringify({
        level: 30,
        component: "session",
        msg: "hello",
        reason: "a, b, c",
      }),
    );
    expect(flat(entry)).not.toContain("\n");
  });

  it("pi event (eventType あり) は [pi] タグで head に eventType を昇格し、fields に出さない", () => {
    const entry = formatLogLine(
      JSON.stringify({
        level: 20,
        component: "session",
        msg: "pi event",
        eventType: "tool_execution_start",
        toolName: "web_search",
      }),
    );
    const text = flat(entry);
    expect(text).toContain("DEBUG");
    expect(text).toContain("[pi]");
    expect(text).not.toContain("[session]");
    expect(text).toContain("tool_execution_start");
    expect(text).toContain("toolName=web_search");
    // eventType 自体は fields に出ない (head に昇格済み)
    expect(text).not.toContain("eventType=");
    // 定数の "pi event" は head から消える
    expect(text).not.toContain("pi event");

    const tagSpan = entry.find((s) => s.text.includes("[pi]"));
    expect(tagSpan?.color).toBe("magenta");
  });

  it("pi stderr (line フィールドなし) は [pi] タグ + head 'stderr'", () => {
    const entry = formatLogLine(
      JSON.stringify({
        level: 50,
        component: "session",
        msg: "pi stderr",
        chunk: "boom",
      }),
    );
    const text = flat(entry);
    expect(text).toContain("[pi]");
    expect(text).toContain("stderr");
    const tagSpan = entry.find((s) => s.text.includes("[pi]"));
    expect(tagSpan?.color).toBe("magenta");
  });

  it("pi stderr (line フィールドあり) は line の内容を head に昇格し、fields に出さない", () => {
    const entry = formatLogLine(
      JSON.stringify({
        level: 50,
        component: "session",
        msg: "pi stderr",
        line: "boom: something went wrong",
      }),
    );
    const text = flat(entry);
    expect(text).toContain("[pi]");
    expect(text).toContain("stderr boom: something went wrong");
    // line 自体は fields に出ない (head に昇格済み)
    expect(text).not.toContain("line=");
  });

  it("通常の msg は component を [tag] にして head に msg をそのまま使う (blue)", () => {
    const entry = formatLogLine(
      JSON.stringify({
        level: 30,
        component: "egress",
        msg: "reply delivered",
      }),
    );
    const text = flat(entry);
    expect(text).toContain("[egress]");
    expect(text).toContain("reply delivered");
    const tagSpan = entry.find((s) => s.text.includes("[egress]"));
    expect(tagSpan?.color).toBe("blue");
  });

  it("component が無ければ tag は '-'", () => {
    const entry = formatLogLine(JSON.stringify({ level: 30, msg: "m" }));
    expect(flat(entry)).toContain("[-]");
  });

  it("長いフィールド値は切り詰め (200 文字上限)、改行は 1 スペースに畳む", () => {
    const long = "x".repeat(300);
    const entry = formatLogLine(
      JSON.stringify({ level: 30, component: "c", msg: "m", big: long }),
    );
    const text = flat(entry);
    expect(text).not.toContain("\n");
    // 元の 300 文字がそのまま乗ることはない (200 文字上限の切り詰めで … が付く)
    expect(text).toContain("…");
    expect(text).not.toContain(long);
  });

  it("time/pid/hostname は落とす", () => {
    const entry = formatLogLine(
      JSON.stringify({
        level: 30,
        component: "c",
        msg: "m",
        time: 123,
        pid: 9,
        hostname: "h",
      }),
    );
    const text = flat(entry);
    expect(text).not.toContain("time=");
    expect(text).not.toContain("pid=");
    expect(text).not.toContain("hostname=");
  });

  it("level に応じた色を付ける (50 red / 40 yellow / 30 green / 20 gray)", () => {
    const levelColor = (level: number): string | undefined =>
      formatLogLine(JSON.stringify({ level, component: "c", msg: "m" }))[0]
        ?.color;
    expect(levelColor(50)).toBe("red");
    expect(levelColor(40)).toBe("yellow");
    expect(levelColor(30)).toBe("green");
    expect(levelColor(20)).toBe("gray");
  });

  it("level>=30 の head は bold、DEBUG (20) は bold なし", () => {
    const headSpan = (level: number) => {
      const entry = formatLogLine(
        JSON.stringify({ level, component: "c", msg: "head-text" }),
      );
      return entry.find((s) => s.text.includes("head-text"));
    };
    expect(headSpan(30)?.bold).toBe(true);
    expect(headSpan(20)?.bold).toBeUndefined();
  });
});

describe("wrapSpans", () => {
  /** Row を連結した文字列で内容検証するためのヘルパ。 */
  const flatRow = (row: Span[]): string => row.map((s) => s.text).join("");

  it("幅内は 1 Row にまとまる", () => {
    const spans = [{ text: "abc", color: "red" }];
    expect(wrapSpans(spans, 10)).toEqual([spans]);
  });

  it("ASCII を width で複数 Row に折り返す", () => {
    const spans = [{ text: "abcdef" }];
    const rows = wrapSpans(spans, 3);
    expect(rows.map(flatRow)).toEqual(["abc", "def"]);
  });

  it("span 境界をまたぐ折り返しでも色/bold を維持する (span を分割して次 Row へ続ける)", () => {
    const spans = [
      { text: "abc", color: "red" },
      { text: "def", bold: true },
    ];
    const rows = wrapSpans(spans, 4);
    expect(rows.map(flatRow)).toEqual(["abcd", "ef"]);
    // 1 Row 目: "abc"(red) + "d"(bold) の 2 span、色/bold それぞれ維持
    expect(rows[0]).toEqual([
      { text: "abc", color: "red" },
      { text: "d", bold: true },
    ]);
    // 2 Row 目: "ef"(bold) が引き継がれる
    expect(rows[1]).toEqual([{ text: "ef", bold: true }]);
  });

  it("span 境界ちょうどで width に達した場合もそこで折る (Row が width を超えない)", () => {
    // 1 つ目の span が width ぴったりで終わり、2 つ目の span の先頭で折り返す
    const spans = [{ text: "abc", color: "red" }, { text: "x" }];
    const rows = wrapSpans(spans, 3);
    expect(rows).toEqual([[{ text: "abc", color: "red" }], [{ text: "x" }]]);
  });

  it("全角は 2 幅として折り返す", () => {
    const spans = [{ text: "あいうえ" }];
    const rows = wrapSpans(spans, 4);
    expect(rows.map(flatRow)).toEqual(["あい", "うえ"]);
  });

  it("width <= 0 は折り返さず [spans] を返す", () => {
    const spans = [{ text: "abc" }];
    expect(wrapSpans(spans, 0)).toEqual([spans]);
  });

  it("空 spans は [[]] を返す (高さ 1 を保つ)", () => {
    expect(wrapSpans([], 10)).toEqual([[]]);
  });

  it("width に収まらない単独グラフェム (幅 2 の絵文字で width 1) でも無限ループしない", () => {
    const spans = [{ text: "\u{1F389}" }]; // 幅 2 の絵文字
    const rows = wrapSpans(spans, 1);
    expect(rows.map(flatRow)).toEqual(["\u{1F389}"]);
  });

  it("結合絵文字 (ZWJ シーケンス) は string-width の実測幅で 1 グラフェムとして扱う", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // string-width では幅 2 の 1 グラフェム
    expect(wrapSpans([{ text: family }], 2).map(flatRow)).toEqual([family]);
    // 幅 1 だと単独グラフェムでも収まらないが、無限ループにはならず単独行になる
    expect(wrapSpans([{ text: family }], 1).map(flatRow)).toEqual([family]);
  });

  it("絵文字を width で折る (幅 2 の絵文字 2 個は width 4 で 1 行)", () => {
    const spans = [{ text: "\u{1F389}\u{1F389}\u{1F389}\u{1F389}" }];
    expect(wrapSpans(spans, 4).map(flatRow)).toEqual([
      "\u{1F389}\u{1F389}",
      "\u{1F389}\u{1F389}",
    ]);
  });

  it("width をまたぐ全角は次行へ送る (1 文字が境界を割らない)", () => {
    // width 3: 全角 "あ"(2) の次に "い"(2) は 4 で超えるので折る
    const spans = [{ text: "あい" }];
    expect(wrapSpans(spans, 3).map(flatRow)).toEqual(["あ", "い"]);
  });
});

describe("normalizeToLogicalLines", () => {
  // appendChat (repl.tsx) がテキストを Line へ変換する前段の正規化。改行/
  // 制御文字が Line に混入すると、wrapSpans が返す Row 数と実際の描画行数が
  // ズレて残像化するため、ここで必ず 1 行 = 改行なし文字列へ正規化する。

  it("改行 (\\n, \\r\\n, \\r) で論理行に分割する", () => {
    expect(normalizeToLogicalLines("a\nb")).toEqual(["a", "b"]);
    expect(normalizeToLogicalLines("a\r\nb")).toEqual(["a", "b"]);
    expect(normalizeToLogicalLines("a\rb")).toEqual(["a", "b"]);
  });

  it("tab は 4 スペースへ展開する", () => {
    expect(normalizeToLogicalLines("a\tb")).toEqual(["a    b"]);
  });

  it("ANSI エスケープ・制御文字は除去する", () => {
    expect(normalizeToLogicalLines("\x1b[31mred\x1b[0m")).toEqual(["red"]);
    expect(normalizeToLogicalLines("a\x07b")).toEqual(["ab"]);
  });

  it("空文字はそのまま空文字の 1 要素を返す", () => {
    expect(normalizeToLogicalLines("")).toEqual([""]);
  });
});

describe("titleBarText", () => {
  it("width 桁ちょうどになるよう末尾をスペースで埋める", () => {
    expect(stringWidth(titleBarText(" chat", 20))).toBe(20);
  });

  it("先頭は title のまま (末尾に空白を足すだけ)", () => {
    expect(titleBarText(" chat", 20).startsWith(" chat")).toBe(true);
  });

  it("全角 (CJK) を含む title も表示幅で width ちょうどに揃える", () => {
    expect(stringWidth(titleBarText(" ログ", 20))).toBe(20);
  });

  it("width が title の表示幅より狭い場合はそのまま返す (負の repeat にならない)", () => {
    const title = " a very long title";
    expect(titleBarText(title, 5)).toBe(title);
  });
});
