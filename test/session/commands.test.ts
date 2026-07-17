import { describe, expect, it } from "vitest";

import { parseCommand } from "../../src/session/commands.js";

describe("parseCommand", () => {
  it("素の /new は { kind: 'new' } (rest なし)", () => {
    expect(parseCommand("/new")).toEqual({ kind: "new" });
  });

  it("前後の空白は無視される", () => {
    expect(parseCommand("  /new  ")).toEqual({ kind: "new" });
  });

  it("/new に続く空白 + 残りテキストは rest として trim して返す", () => {
    expect(parseCommand("/new  foo bar")).toEqual({
      kind: "new",
      rest: "foo bar",
    });
  });

  it("改行区切りも空白扱いになる", () => {
    expect(parseCommand("/new\n次はこれ")).toEqual({
      kind: "new",
      rest: "次はこれ",
    });
  });

  it("/news のような前方一致のみは null", () => {
    expect(parseCommand("/news")).toBeNull();
  });

  it("先頭以外に /new があるものは null", () => {
    expect(parseCommand("foo /new")).toBeNull();
  });

  it("大文字 /NEW は null (小文字のみ有効)", () => {
    expect(parseCommand("/NEW")).toBeNull();
  });

  it("無関係なテキストは null", () => {
    expect(parseCommand("hello world")).toBeNull();
  });

  it("空文字は null", () => {
    expect(parseCommand("")).toBeNull();
  });
});
