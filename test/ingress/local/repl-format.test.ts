// repl.tsx の純粋ヘルパ (ink 非依存) の単体テスト。
// - formatLogLine: pino NDJSON を必ず 1 行へ整形し、`pi event` のような定数
//   msg は eventType を head に昇格する。
// - wrapToRows: string-width によるグラフェム単位の折り返し (East Asian
//   Wide/絵文字を正しい幅で数える) + 改行/制御文字の正規化。残像化防止のため
//   「論理行 → 端末幅で折った Row 配列」への変換が正しいこと。

import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import {
  formatLogLine,
  titleBarText,
  wrapToRows,
} from "../../../src/ingress/local/repl.js";

describe("formatLogLine", () => {
  it("パース失敗 (非 JSON) は raw をそのまま返す", () => {
    expect(formatLogLine("not json")).toEqual({ text: "not json" });
  });

  it("必ず 1 行 (改行を含まない) に整形する", () => {
    const { text } = formatLogLine(
      JSON.stringify({
        level: 30,
        component: "session",
        msg: "hello",
        reason: "a, b, c",
      }),
    );
    expect(text).not.toContain("\n");
  });

  it("eventType があれば head に昇格し、定数 msg (pi event) は落とす", () => {
    const { text } = formatLogLine(
      JSON.stringify({
        level: 20,
        component: "session",
        msg: "pi event",
        eventType: "tool_execution_start",
        toolName: "web_search",
      }),
    );
    expect(text).toContain("DEBUG");
    expect(text).toContain("[session]");
    expect(text).toContain("tool_execution_start");
    expect(text).toContain("toolName=web_search");
    // 定数の "pi event" は head から消える (eventType が主見出し)
    expect(text).not.toContain("pi event");
  });

  it("eventType が無ければ msg をそのまま head に使う", () => {
    const { text } = formatLogLine(
      JSON.stringify({
        level: 30,
        component: "egress",
        msg: "reply delivered",
      }),
    );
    expect(text).toContain("reply delivered");
  });

  it("長いフィールド値は切り詰め、改行は 1 スペースに畳む", () => {
    const long = "x".repeat(200);
    const { text } = formatLogLine(
      JSON.stringify({ level: 30, component: "c", msg: "m", big: long }),
    );
    expect(text).not.toContain("\n");
    // 元の 200 文字がそのまま乗ることはない (切り詰めで … が付く)
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(120);
  });

  it("time/pid/hostname は落とす", () => {
    const { text } = formatLogLine(
      JSON.stringify({
        level: 30,
        component: "c",
        msg: "m",
        time: 123,
        pid: 9,
        hostname: "h",
      }),
    );
    expect(text).not.toContain("time=");
    expect(text).not.toContain("pid=");
    expect(text).not.toContain("hostname=");
  });

  it("level に応じた色を付ける (>=50 red, >=40 yellow, <=20 gray)", () => {
    const mk = (level: number) =>
      formatLogLine(JSON.stringify({ level, component: "c", msg: "m" })).color;
    expect(mk(50)).toBe("red");
    expect(mk(40)).toBe("yellow");
    expect(mk(20)).toBe("gray");
    expect(mk(30)).toBeUndefined();
  });
});

describe("wrapToRows", () => {
  it("width 以内の行はそのまま 1 要素", () => {
    expect(wrapToRows("hello", 10)).toEqual(["hello"]);
  });

  it("ASCII を width で折る", () => {
    expect(wrapToRows("abcdef", 3)).toEqual(["abc", "def"]);
  });

  it("全角は 2 幅として折る (width 4 = 全角 2 文字で 1 行)", () => {
    expect(wrapToRows("あいうえ", 4)).toEqual(["あい", "うえ"]);
  });

  it("width をまたぐ全角は次行へ送る (1 文字が境界を割らない)", () => {
    // width 3: 全角 "あ"(2) の次に "い"(2) は 4 で超えるので折る
    expect(wrapToRows("あい", 3)).toEqual(["あ", "い"]);
  });

  it("width <= 0 は折らずそのまま返す", () => {
    expect(wrapToRows("abc", 0)).toEqual(["abc"]);
  });

  it("空文字は空の 1 行を返す (高さ 1 を保つ)", () => {
    expect(wrapToRows("", 10)).toEqual([""]);
  });

  it("結合絵文字 (ZWJ シーケンス) は string-width の実測幅で 1 グラフェムとして扱う", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"; // string-width では幅 2 の 1 グラフェム
    expect(wrapToRows(family, 2)).toEqual([family]);
    // 幅 1 だと単独グラフェムでも収まらないが、無限ループにはならず単独行になる
    expect(wrapToRows(family, 1)).toEqual([family]);
  });

  it("絵文字を width で折る (幅 2 の絵文字 2 個は width 4 で 1 行)", () => {
    expect(wrapToRows("\u{1F389}\u{1F389}\u{1F389}\u{1F389}", 4)).toEqual([
      "\u{1F389}\u{1F389}",
      "\u{1F389}\u{1F389}",
    ]);
  });

  it("改行 (\\n, \\r\\n, \\r) を論理行として分割してから折り返す", () => {
    expect(wrapToRows("a\nb", 10)).toEqual(["a", "b"]);
    expect(wrapToRows("a\r\nb", 10)).toEqual(["a", "b"]);
    expect(wrapToRows("a\rb", 10)).toEqual(["a", "b"]);
  });

  it("tab は 4 スペースへ展開する", () => {
    expect(wrapToRows("a\tb", 10)).toEqual(["a    b"]);
  });

  it("ANSI エスケープ・制御文字は除去する", () => {
    expect(wrapToRows("\x1b[31mred\x1b[0m", 10)).toEqual(["red"]);
    expect(wrapToRows("a\x07b", 10)).toEqual(["ab"]);
  });

  it("width <= 0 でも改行では論理行に分割する", () => {
    expect(wrapToRows("a\nb", 0)).toEqual(["a", "b"]);
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
