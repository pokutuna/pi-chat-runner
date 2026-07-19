// REPL アダプタ (docs/design/local-dev.md §2, §3) — ink (React ベース TUI) 実装。
//
// 画面を上下 2 ペインに分ける (ログ / チャット+入力欄)。文法パース・状態遷移・
// chat.post/react の呼び出しは repl-logic.ts に切り出し済みで、このファイルは
// それを呼んで描画するだけの薄い層にする (repl-logic.ts は変更しない)。
//
// 入力行の確定 (Enter) の経路は TTY/非TTY で排他的に切り替える。raw mode が
// 効く実 TTY では node:readline と ink の useInput が同じ stdin を同時に
// 消費すると入力の取り合い (順序崩れ) が起きるため、TTY では useInput だけが
// stdin を握り、Enter も useInput 側で処理する。非TTY (テストの PassThrough
// 等、raw mode が効かない入力) では useInput は inert なので、従来通り
// node:readline (line-based) が行確定を担う。どちらの経路でも「1行ずつ
// 順序通り処理され、EOF/quit で in-flight の処理を待ってから終了する」という
// 保証は、共通の直列化キュー (submitLine/requestFinish) を通すことで維持する。

import * as readline from "node:readline";

import { Box, render, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";

import {
  formatMessageLine,
  formatReactionLine,
  formatUpdateLine,
  HELP_TEXT,
  handleLine,
  initialReplState,
  promptText,
  type ReplState,
} from "./repl-logic.js";
import type { LocalChat } from "./types.js";

export interface StartReplOptions {
  initialChannelId: string;
  /** stdin の差し替え (テスト用)。既定 process.stdin。 */
  input?: NodeJS.ReadableStream;
  /** stdout の差し替え。既定 process.stdout。 */
  output?: NodeJS.WritableStream;
  /** ログ捕捉用。pino の destination として渡された PassThrough 等から NDJSON
   * 行を読み取り、ログペインに表示する。省略時はログペインを表示しない。 */
  logStream?: NodeJS.ReadableStream;
}

// ── チャットペインの行 ───────────────────────────────────────────────────

interface ChatLine {
  text: string;
  color?: "cyan" | "red";
}

const CHAT_WINDOW = 50;

// ── ログペインの行 ───────────────────────────────────────────────────────
//
// ログペインは level/tag/head/fields を色分けするため、単一の text/color
// ではなく span (LogSpan) の配列 (LogEntry) として持つ。1 エントリは画面幅で
// 複数 Row に折り返して表示する (wrapSpans。chat ペインの wrapToRows と同じ
// 「描画前に端末幅の Row 配列へ平坦化する」方式)。これにより長いログが
// 画面右端で切れず、末尾まで読める。

export interface LogSpan {
  text: string;
  color?: string;
  bold?: boolean;
}

export type LogEntry = LogSpan[];

const LOG_WINDOW = 200;

// 上下分割 (log / chat) のペイン高さは端末の行数から入力欄 1 行と枠線
// (上下 2 行) を引いた値。terminalRows が取れない (非TTY) 場合の
// フォールバック高さ。
const FALLBACK_PANE_HEIGHT = 10;

const LOG_LEVEL_NAMES: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

/** level → 色。50 以上 red / 40 以上 yellow / 30 以上 green / それ以外
 * (20 以下・不明) は gray。 */
function colorForLevel(level: unknown): string {
  if (typeof level !== "number") return "gray";
  if (level >= 50) return "red";
  if (level >= 40) return "yellow";
  if (level >= 30) return "green";
  return "gray";
}

/** フィールド値は改行を 1 行に潰したうえで長さも上限で切り詰める。折り返し
 * 表示 (wrapSpans) になったため画面幅で文字が切れることはないが、上限が
 * 無いと 1 フィールドの巨大な値だけでログペインが埋まってしまうため、その
 * 予防として上限を設ける。 */
const LOG_FIELD_MAX = 200;

function renderFieldValue(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  // 改行・連続空白を 1 スペースに畳んで 1 行化し、長すぎる値は末尾を省略する。
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > LOG_FIELD_MAX
    ? `${oneLine.slice(0, LOG_FIELD_MAX - 1)}…`
    : oneLine;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** パース失敗・非オブジェクト時の fallback 整形。ANSI エスケープ/制御文字を
 * 除去し、連続空白を 1 スペースに畳んで 1 行にする。 */
function formatRawLine(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_RE, "")
    .replace(CONTROL_CHARS_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** pi (子プロセスとして起動する coding agent) 由来のログかどうかを判定し、
 * tag ("pi" 固定) と head を決める。それ以外 (runner 自身のログ) は
 * component を tag、msg を head として扱う。 */
function classifyLogTagAndHead(
  msg: unknown,
  component: unknown,
  rest: Record<string, unknown>,
): { tag: string; tagColor: string; head: string } {
  if (msg === "pi event" && typeof rest.eventType === "string") {
    const head = rest.eventType;
    delete rest.eventType;
    return { tag: "pi", tagColor: "magenta", head };
  }
  if (msg === "pi stderr") {
    if (typeof rest.line === "string") {
      const head = `stderr ${rest.line}`;
      delete rest.line;
      return { tag: "pi", tagColor: "magenta", head };
    }
    return { tag: "pi", tagColor: "magenta", head: "stderr" };
  }
  const tag = component !== undefined ? String(component) : "-";
  const head = msg !== undefined ? String(msg) : "";
  return { tag, tagColor: "blue", head };
}

/** head 中の改行を畳んで 1 行にする (切り詰めは行わない)。 */
function normalizeHead(head: string): string {
  return head.replace(/\s+/g, " ").trim();
}

/** pino の NDJSON 1 行を span 列に整形する (1 論理行。画面幅での折り返しは
 * 呼び出し側の wrapSpans が担う)。level/tag ([pi] または [component])/
 * head/fields をそれぞれ色分けした span にする。パース失敗・非オブジェクト
 * 時は formatRawLine で 1 span に畳んで返す。 */
export function formatLogLine(raw: string): LogEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [{ text: formatRawLine(raw) }];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [{ text: formatRawLine(raw) }];
  }
  const { level, component, msg, ...rest } = parsed as Record<string, unknown>;
  // time/pid/hostname は表示上ノイズなので落とす (pino の既定フィールド)
  delete rest.time;
  delete rest.pid;
  delete rest.hostname;

  const levelName = (
    typeof level === "number" ? (LOG_LEVEL_NAMES[level] ?? String(level)) : "?"
  ).padEnd(5);
  const levelColor = colorForLevel(level);

  const { tag, tagColor, head } = classifyLogTagAndHead(msg, component, rest);
  const normalizedHead = normalizeHead(head);

  const fields = Object.entries(rest)
    .map(([k, v]) => `${k}=${renderFieldValue(v)}`)
    .join(" ");

  const spans: LogSpan[] = [{ text: levelName, color: levelColor }];
  spans.push({ text: ` [${tag}]`, color: tagColor });
  if (normalizedHead !== "") {
    spans.push({
      text: ` ${normalizedHead}`,
      ...(typeof level === "number" && level >= 30 ? { bold: true } : {}),
    });
  }
  if (fields !== "") {
    spans.push({ text: ` ${fields}`, color: "gray" });
  }
  return spans;
}

/** span 列を表示幅 width ごとの複数 Row (各 Row は LogSpan[]) へ折り返す
 * (グラフェム単位、string-width 実測。clampSpans の旧実装と同じ流儀)。span の
 * 境界をまたいでも色/bold 属性は維持する (span を分割して次 Row へ続ける)。
 * width に収まらない単独グラフェム (幅 2 の絵文字で width 1 等) でも
 * 無限ループにはならず、そのグラフェム単独で 1 Row になる。width <= 0 の
 * ときは折り返さず `[spans]` を返す。空 spans (`[]`) は高さ 1 を保つため
 * `[[]]` を返す。 */
export function wrapSpans(spans: LogSpan[], width: number): LogSpan[][] {
  if (width <= 0) return [spans];
  if (spans.length === 0) return [[]];

  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const rows: LogSpan[][] = [];
  let currentRow: LogSpan[] = [];
  let currentText = "";
  let currentWidth = 0;
  let currentAttrs: { color?: string; bold?: boolean } = {};

  const flushSpan = (): void => {
    if (currentText !== "") {
      currentRow.push({ text: currentText, ...currentAttrs });
      currentText = "";
    }
  };
  const flushRow = (): void => {
    flushSpan();
    rows.push(currentRow);
    currentRow = [];
    currentWidth = 0;
  };

  for (const span of spans) {
    flushSpan();
    currentAttrs = {
      ...(span.color !== undefined ? { color: span.color } : {}),
      ...(span.bold !== undefined ? { bold: span.bold } : {}),
    };
    for (const { segment: grapheme } of segmenter.segment(span.text)) {
      const w = stringWidth(grapheme);
      // Row が空でない限り、幅超過でここで折る。currentText だけでなく
      // currentRow も見る — span 境界で flushSpan 済みだと currentText は
      // 空だが Row には既に幅がある (ここを見ないと span 境界ちょうどで
      // 折れず、Row が width を超えて残像の原因になる)。
      if (
        currentWidth + w > width &&
        (currentText !== "" || currentRow.length > 0)
      ) {
        flushRow();
      }
      currentText += grapheme;
      currentWidth += w;
    }
  }
  flushRow();
  return rows;
}

// ── 入力欄 (自作。ink には組み込みのテキスト入力コンポーネントがない) ─────
//
// 確定 (Enter) は readline が処理するので、ここでは「今 何を入力中か」の
// プレビュー文字列 (value) を表示するだけ。文字の追加/Backspace は
// useInput 経由 (raw mode が効く TTY のときだけ) で更新する。

interface InputLineProps {
  prompt: string;
  value: string;
  cursor: number;
  /** 入力欄の可視幅 (prompt を除いた残り列数)。入力が収まらない場合は
   * cursor が常に見えるようグラフェム単位でスライドさせる。undefined
   * (幅不明。非TTY 等) のときは切り詰めない。 */
  width?: number;
}

/** graphemes のうち、cursor (グラフェムの反転セルを含む) が必ず収まる窓を
 * 表示幅 width 以内で切り出す。cursor 位置までの表示幅が width を超えたら、
 * 窓の始点を右にずらして cursor が窓の右端付近に来るようにする (末尾から
 * 詰める素朴な方式で十分 — 入力行は横方向のスクロールのみで、複雑な追従は
 * 不要)。戻り値は [windowStart, windowEnd) のグラフェム index 範囲。 */
function computeVisibleWindow(
  graphemes: string[],
  cursor: number,
  width: number,
): { start: number; end: number } {
  // cursor のセル自体 (文字 or 反転スペース) を含めて、cursor から左に
  // 向かって width 分だけ積算し、収まる最小の start を求める。
  const cursorCellWidth = stringWidth(graphemes[cursor] ?? " ") || 1;
  let start = cursor;
  let used = cursorCellWidth;
  while (start > 0) {
    const w = stringWidth(graphemes[start - 1] ?? "");
    if (used + w > width) break;
    start -= 1;
    used += w;
  }
  // start から右へ、収まるだけ end を伸ばす (cursor より後ろの文字も
  // 空きがあれば見せる)。
  let end = cursor + 1;
  while (end < graphemes.length) {
    const w = stringWidth(graphemes[end] ?? "");
    if (used + w > width) break;
    end += 1;
    used += w;
  }
  return { start, end };
}

/** value をグラフェム単位で分割し、cursor 位置に反転表示のセルを挟んで
 * 描画する (サロゲートペアの絵文字・結合絵文字なども 1 文字として扱う)。
 * cursor が末尾 (length) のときはカーソル下に文字がないので反転スペースを
 * 出す。入力行はペイン崩れ (2 行目への持ち越し) を防ぐため必ず 1 端末行に
 * 収める — 表示幅が width を超える場合は cursor を含む窓だけを描画する
 * (cursor は常に可視)。 */
function InputLine({ prompt, value, cursor, width }: InputLineProps) {
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      value,
    ),
  ].map((s) => s.segment);

  const { start, end } =
    width !== undefined
      ? computeVisibleWindow(graphemes, cursor, width)
      : { start: 0, end: graphemes.length };

  const visible = graphemes.slice(start, end);
  const cursorInWindow = cursor - start;
  const before = visible.slice(0, cursorInWindow).join("");
  const after = visible.slice(cursorInWindow + 1).join("");
  return (
    <Box height={1} overflow="hidden" flexShrink={0}>
      <Text bold wrap="truncate-end">
        {prompt}
      </Text>
      <Text wrap="truncate-end">{before}</Text>
      <Text inverse wrap="truncate-end">
        {visible[cursorInWindow] ?? " "}
      </Text>
      <Text wrap="truncate-end">{after}</Text>
    </Box>
  );
}

// ── 折り返し (自前) ─────────────────────────────────────────────────────────
//
// ink の自動 wrap に任せると「論理行 1 = 端末行 1」の前提が崩れ、slice した
// 論理行数がペインの height (行数) を超えて overflow="hidden" のクリップと
// ink のフレーム差分が食い違い、前フレームの文字が残像化する (log/chat 両
// ペインで観測)。そこで論理行を描画前に端末幅で「行」へ畳み、slice/描画は
// その行単位で行う。1 行 = 端末 1 行が保証され、残像が出ない。
//
// 加えて、論理行に埋め込まれた改行 (`\n` 等) を畳まずに 1 Row 内へ残すと、
// その Row 文字列自体が端末上で複数の物理行として描画されてしまい、ここでも
// 「Row 数 (JS 側のカウント) < 実際の物理行数」というズレが起きて残像化する。
// そのため wrapToRows は幅で折るだけでなく、改行/制御文字の正規化も担う。
// (CONTROL_CHARS_RE / ANSI_ESCAPE_RE はログ整形の formatRawLine と共有)

/** テキストを「1 端末行に対応する論理行」の配列へ正規化する。改行
 * (`\r\n`/`\r`/`\n`) で分割し、tab はスペースへ展開、ANSI エスケープや
 * その他の制御文字は除去する (これらを残すと 1 論理行が複数物理行になり、
 * Row 数と実際の描画行数がズレて残像化する)。 */
function normalizeToLogicalLines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) =>
      line
        .replaceAll("\t", "    ")
        .replace(ANSI_ESCAPE_RE, "")
        .replace(CONTROL_CHARS_RE, ""),
    );
}

/** 1 つの論理行 (改行・制御文字を含みうる生テキスト) を、表示幅 width に
 * 収まる「行」の配列へ畳む。まず改行等で複数の論理行へ正規化し、各々を
 * `Intl.Segmenter` でグラフェム単位に分割、string-width で実測しながら
 * width を超えないよう積算する (1 グラフェムが width を超える場合でも
 * 無限ループにはならず、そのグラフェム単独で 1 行になる)。width <= 0 の
 * ときは折り返さず正規化済みの論理行をそのまま返す。 */
export function wrapToRows(text: string, width: number): string[] {
  const logicalLines = normalizeToLogicalLines(text);
  if (width <= 0) return logicalLines;

  const rows: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  for (const line of logicalLines) {
    if (line === "") {
      rows.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const { segment: grapheme } of segmenter.segment(line)) {
      const w = stringWidth(grapheme);
      if (currentWidth + w > width && current !== "") {
        rows.push(current);
        current = "";
        currentWidth = 0;
      }
      current += grapheme;
      currentWidth += w;
    }
    rows.push(current);
  }
  return rows;
}

/** 描画単位の 1 行 (端末 1 行に対応)。論理行 1 つが折り返しで複数の Row に
 * 展開される。スロット単位描画 (下記) では React key は slot index を使うため
 * Row 自体はもう key を持たない。 */
interface Row {
  text: string;
  color?: string;
}

/** 論理行の配列を、表示幅 width で折り返した Row の配列へ平坦化する。色は
 * 元の論理行から引き継ぐ。空文字の論理行も高さ 1 の空行として 1 Row 残す。 */
function toRows(
  lines: readonly { text: string; color?: string }[],
  width: number,
): Row[] {
  const rows: Row[] = [];
  for (const line of lines) {
    const wrapped = wrapToRows(line.text, width);
    for (const rowText of wrapped) {
      rows.push({
        text: rowText,
        ...(line.color !== undefined ? { color: line.color } : {}),
      });
    }
  }
  return rows;
}

// ── スクロール ─────────────────────────────────────────────────────────────
//
// 各ペインは「全 Row (折り返し済み) のうち可視高さ (viewport) 分だけ slice
// して描画する」。offsetFromBottom = 0 が末尾 (最新) で、上にスクロールする
// ほど増える。末尾追従 (offset 0) のときだけ新着に追従し、スクロールバック中
// (offset > 0) は新着が来ても表示位置を据え置く。

/** offsetFromBottom を [0, maxOffset] にクランプする。maxOffset は
 * 「全行数 - 可視高さ」(全行が収まるなら 0)。 */
function clampOffset(
  total: number,
  viewport: number,
  offsetFromBottom: number,
): number {
  const maxOffset = Math.max(0, total - viewport);
  return Math.max(0, Math.min(maxOffset, offsetFromBottom));
}

/** 全行から、末尾から offsetFromBottom 行ぶん遡った位置を末尾とする
 * viewport 行を切り出す。 */
function visibleSlice<T>(
  all: T[],
  viewport: number,
  offsetFromBottom: number,
): T[] {
  const end = all.length - offsetFromBottom;
  const start = Math.max(0, end - viewport);
  return all.slice(start, end);
}

// ── ペインタイトル (上辺の罫線に埋め込む) ───────────────────────────────────
//
/** ペインのタイトルバー文字列。title の後ろを width 桁ちょうどになるよう半角
 * スペースで右詰めし、背景色が横幅いっぱいに広がる 1 行にする。width が title
 * の表示幅より狭い場合はそのまま返す (Text 側の truncate-end に任せる)。 */
export function titleBarText(title: string, width: number): string {
  const pad = width - stringWidth(title);
  return pad > 0 ? title + " ".repeat(pad) : title;
}

// ── 固定スロットグリッド ─────────────────────────────────────────────────
//
// ペインは常に viewportHeight 個の「スロット」を描画する (行数が足りなけ
// れば空行 Row で埋める)。スロットは React key = index で固定し、内容だけを
// 差し替える。これにより Yoga のツリー構造 (ノード数・高さ) がフレーム間で
// 一切変わらなくなり、ink の `overflow="hidden"` クリップと実際の端末物理
// 行数が常に一致する — 論理行数の増減で描画ノード数が変動していた旧実装
// (justifyContent="flex-end" + slice した可変長配列を描画) が残像の主因
// だったため、これをやめる。

/** グリッドの 1 スロットの内容。log/chat どちらも「1 スロット = span 列」に
 * 統一する (chat の Row {text, color} は 1-span 行 `[{ text, color }]` に
 * 変換して渡す)。 */
type GridRow = LogSpan[];

const BLANK_GRID_ROW: GridRow = [];

/** viewportHeight 個の空行を作る (グリッドの余白埋め用)。 */
function blankRows(count: number): GridRow[] {
  return Array.from({ length: Math.max(0, count) }, () => BLANK_GRID_ROW);
}

/** visible (slice 済みの実データ行) を、常に viewportHeight 個のスロットに
 * なるよう空行で埋めたグリッドにする。followTail (末尾追従中) は新着が下に
 * 来るよう上を空行で埋め、スクロールバック中は下を空行で埋める。 */
function toGrid(
  visible: GridRow[],
  viewportHeight: number,
  followTail: boolean,
): GridRow[] {
  const pad = blankRows(viewportHeight - visible.length);
  return followTail ? [...pad, ...visible] : [...visible, ...pad];
}

// ── Pane (log/chat 共通の枠 + タイトルバー + 固定スロットグリッド) ─────────

interface PaneProps {
  title: string;
  focused: boolean;
  height: number;
  innerWidth: number;
  grid: GridRow[];
}

/** log/chat ペインで重複していた「枠 + タイトルバー + 固定スロットグリッド」
 * の描画をまとめたコンポーネント。スロットは React key = index 固定・
 * height 1・flexShrink 0・幅 innerWidth を維持する (残像対策。toGrid 直上の
 * コメント参照)。フォーカス中のペインは枠線/タイトルバーの色 (cyan 反転) に
 * 加え、色を区別しづらい環境でも分かるようタイトル末尾に ` *` を付ける。 */
function Pane({ title, focused, height, innerWidth, grid }: PaneProps) {
  const titleText = focused ? `${title} *` : title;
  return (
    <Box
      flexDirection="column"
      height={height}
      overflow="hidden"
      justifyContent="flex-start"
      borderStyle="single"
      borderColor={focused ? "cyan" : "gray"}
    >
      <Box height={1} width={innerWidth} flexShrink={0}>
        <Text
          backgroundColor={focused ? "cyan" : "gray"}
          color="black"
          wrap="truncate-end"
        >
          {titleBarText(titleText, innerWidth)}
        </Text>
      </Box>
      {grid.map((spans, slot) => (
        <Box key={slot} height={1} width={innerWidth} flexShrink={0}>
          {spans.length === 0 ? (
            <Text> </Text>
          ) : (
            spans.map((span, i) => (
              <Text
                key={i}
                {...(span.color !== undefined ? { color: span.color } : {})}
                {...(span.bold !== undefined ? { bold: span.bold } : {})}
                wrap="truncate-end"
              >
                {span.text}
              </Text>
            ))
          )}
        </Box>
      ))}
    </Box>
  );
}

// ── 本体 ─────────────────────────────────────────────────────────────────

export interface AppProps {
  chat: LocalChat;
  options: StartReplOptions;
  onDone: () => void;
}

type FocusTarget = "input" | "log" | "chat";

/** ink コンポーネント本体。startRepl から呼ばれる薄い render 呼び出し以外は
 * ここに集約する。ink-testing-library の render()/lastFrame() でスモーク
 * テストするために export する (startRepl 自体は本物の ink.render を使い、
 * ink-testing-library の render はテスト専用の stdout/stdin を注入するため
 * startRepl 経由では差し替えられない)。 */
export function App({ chat, options, onDone }: AppProps) {
  const { exit } = useApp();
  const { isRawModeSupported: inkStdinIsRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  // 入力経路 (readline vs useInput) の排他制御は、ink 自身の内部 stdin
  // (isRawModeSupported) ではなく、App に実際に渡された options.input の
  // TTY 判定で行う。理由: ink-testing-library の render() は常に自前の
  // フェイク stdin (isTTY 固定 true) を注入し、App コンポーネントの
  // props.options.input とは別物になる (このファイル冒頭の App コメント
  // 参照)。isRawModeSupported をそのまま使うと、テストで options.input に
  // 書き込んだ行が (フェイク stdin は isTTY=true 扱いのため) readline
  // 側で処理されなくなり、実際にキー入力を送る手段もない (useInput は
  // ink 内部 stdin にしか反応せず、テストはそこへは書き込めない) ため行き
  // 詰まる。本番では options.input は指定しなければ process.stdin に落ち、
  // ink の内部 stdin も同じ process.stdin になるため isRawModeSupported と
  // 一致し、この判定でも従来通り「実 TTY では 1 つの経路だけが stdin を
  // 握る」という目的を満たす。
  const configuredInput = (options.input ?? process.stdin) as {
    isTTY?: boolean;
  };
  const isRawModeSupported =
    configuredInput.isTTY === true && inkStdinIsRawModeSupported;

  const stateRef = useRef<ReplState>(
    initialReplState(options.initialChannelId),
  );

  const [prompt, setPrompt] = useState(() => promptText(stateRef.current));
  const [chatLines, setChatLines] = useState<ChatLine[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [terminalRows, setTerminalRows] = useState(stdout.rows);
  const [terminalCols, setTerminalCols] = useState(stdout.columns);

  // スクロール state。offset は末尾 (最新) からの遡り行数で 0 = 末尾追従。
  const [logOffset, setLogOffset] = useState(0);
  const [chatOffset, setChatOffset] = useState(0);
  // フォーカス対象。"input" (既定・起動直後) では文字入力/Enter/カーソル移動
  // などの編集系キーが効き、"log"/"chat" ではペインのスクロールのみ有効に
  // なる (文字入力は無視される)。Tab/Shift-Tab で focusRing (下記) を巡回し、
  // Escape でいつでも "input" に戻れる。
  const [focusedTarget, setFocusedTarget] = useState<FocusTarget>("input");

  // stdout.rows は resize イベントでしか更新されない (ink が自動で
  // 再レンダーしてくれるわけではない) ので、変化を state に反映する。
  // これがないとチャットペインの高さがリサイズ後の実際の行数と食い違い、
  // 端末の表示可能行数を超えて ink が前フレームを正しく消せなくなる
  // (枠が積み重なって残像化する不具合の原因)。
  useEffect(() => {
    const onResize = (): void => {
      setTerminalRows(stdout.rows);
      setTerminalCols(stdout.columns);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // マウスホイールでのペインスクロール用に SGR マウストラッキングを有効化
  // する (mode 1000 = ボタンイベント通知 + 1006 = SGR 形式)。イベントは
  // stdin にエスケープシーケンスとして届き、useInput 側の先頭で処理する。
  // 有効中は端末ネイティブのドラッグ選択が奪われる (多くの端末では
  // Shift+ドラッグで選択可能)。raw mode が効く実 TTY のときだけ有効化し、
  // 端末をマウスモードのまま残さないようアンマウント時に必ず解除する。
  useEffect(() => {
    if (isRawModeSupported !== true) return;
    if (!("isTTY" in stdout) || stdout.isTTY !== true) return;
    stdout.write("\x1b[?1000;1006h");
    return () => {
      stdout.write("\x1b[?1000;1006l");
    };
  }, [isRawModeSupported, stdout]);

  const appendChat = (text: string, color?: ChatLine["color"]): void => {
    const line: ChatLine = {
      text,
      ...(color !== undefined ? { color } : {}),
    };
    setChatLines((prev) => {
      const next = [...prev, line];
      return next.length > CHAT_WINDOW
        ? next.slice(next.length - CHAT_WINDOW)
        : next;
    });
    // offset は Row (折り返し済み端末行) 単位だが、この append 呼び出し側は
    // 論理行しか扱わず、追加した 1 論理行が折り返し後に何 Row になるかを
    // 知らない (innerWidth はレンダー側の値)。そのため「スクロールバック中は
    // 1 論理行 = +1 Row」という誤った仮定で offset を進めるとズレて描画が
    // 乱れる (旧実装のバグ) — 折り返しで複数行になる CJK/長文だと特に顕著。
    // 追従中 (offset 0) はそのまま 0 を維持し、スクロールバック中 (offset > 0)
    // は何もせずそのまま据え置く。据え置いた offset は render 側で毎回
    // clampOffset により Row 数の変化に合わせてクランプされるため、範囲外には
    // ならない (行が増えるほど「見ている絶対位置」は下にずれていく形になるが、
    // 完全な位置追従は行わないベストエフォートとして許容する)。
  };

  const appendLog = (entry: LogEntry): void => {
    setLogEntries((prev) => {
      const next = [...prev, entry];
      return next.length > LOG_WINDOW
        ? next.slice(next.length - LOG_WINDOW)
        : next;
    });
    // appendChat と同じ理由で、スクロールバック中の offset を +1 する
    // ヒューリスティックはやめて据え置く (render 側の clampOffset に任せる)。
  };

  // HELP_TEXT を起動時に一度表示 + chat.events 購読 (message/update/reaction)
  useEffect(() => {
    appendChat(HELP_TEXT);

    const onMessage = (msg: Parameters<typeof formatMessageLine>[1]) => {
      const line = formatMessageLine(chat, msg);
      appendChat(line.text, line.isSelf ? "cyan" : undefined);
    };
    const onUpdate = (msg: Parameters<typeof formatUpdateLine>[0]) => {
      const line = formatUpdateLine(msg);
      appendChat(line.text, "cyan");
    };
    const onReaction = (record: Parameters<typeof formatReactionLine>[1]) => {
      const line = formatReactionLine(chat, record);
      appendChat(line.text, "cyan");
    };

    chat.events.on("message", onMessage);
    chat.events.on("update", onUpdate);
    chat.events.on("reaction", onReaction);
    return () => {
      chat.events.off("message", onMessage);
      chat.events.off("update", onUpdate);
      chat.events.off("reaction", onReaction);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);

  // logStream 購読 (NDJSON 行 → ログペイン)
  useEffect(() => {
    const logStream = options.logStream;
    if (logStream === undefined) return;
    const rl = readline.createInterface({ input: logStream });
    rl.on("line", (raw) => {
      if (raw.trim() === "") return;
      appendLog(formatLogLine(raw));
    });
    return () => {
      rl.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.logStream]);

  // 直列化キュー + 行確定の共通処理。TTY/非TTY どちらの経路 (下記) からも
  // submitLine を呼ぶことで、複数行が一気に届いても handleLine の呼び出し
  // 順序を守り、EOF/quit では in-flight の処理を待ってから終了する。
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const finishedRef = useRef(false);

  const finish = (): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onDone();
  };

  const requestFinish = (): void => {
    void queueRef.current.then(() => finish());
  };

  const submitLine = (line: string): void => {
    setInputValue("");
    setCursor(0);
    queueRef.current = queueRef.current
      .then(async () => {
        const result = await handleLine(chat, stateRef.current, line);
        switch (result.kind) {
          case "noop":
            return;
          case "error":
            appendChat(result.message, "red");
            return;
          case "help":
            appendChat(HELP_TEXT);
            return;
          case "quit":
            requestFinish();
            return;
          case "state-changed":
            setPrompt(promptText(stateRef.current));
            return;
        }
      })
      .catch((err: unknown) => {
        appendChat(String(err), "red");
      });
  };

  // 非TTY (raw mode 非対応) のときだけ readline (行単位) で input を読み、
  // 確定した行を submitLine に流す。TTY では useInput が入力を握るため、
  // ここでは何もしない (readline を作ると同じ stdin を取り合ってしまう)。
  useEffect(() => {
    if (isRawModeSupported === true) return; // TTY 側 (useInput) が担当する
    const input = options.input ?? process.stdin;
    const rl = readline.createInterface({ input, terminal: false });

    rl.on("line", (line) => {
      submitLine(line);
    });

    rl.on("close", () => {
      // readline close 後もキューに実行中/未実行の handleLine が残っている
      // ことがある (!quit や EOF が in-flight の chat.post と競合するケース)。
      // それを握りつぶさず待ってから終了する。
      requestFinish();
    });

    return () => {
      rl.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showLogPane = options.logStream !== undefined;

  // 上下分割 (log / chat)。利用可能高さ = 端末行数 - 入力欄 1 行。ログ表示時は
  // それをログ/チャットで折半し、非表示時はチャットが全部使う。各ペインの
  // 可視コンテンツ行数 (viewport) は外形から枠線 (上下 2 行) を引いた値。
  // terminalRows が取れない (非TTY) 場合はフォールバック高さを使う。
  const availHeight =
    terminalRows !== undefined ? Math.max(6, terminalRows - 1) : undefined;
  const logOuterHeight =
    availHeight !== undefined
      ? showLogPane
        ? Math.max(3, Math.floor(availHeight / 2))
        : 0
      : FALLBACK_PANE_HEIGHT;
  const chatOuterHeight =
    availHeight !== undefined
      ? showLogPane
        ? Math.max(3, availHeight - logOuterHeight)
        : availHeight
      : FALLBACK_PANE_HEIGHT;
  const logViewport = Math.max(1, logOuterHeight - 3);
  const chatViewport = Math.max(1, chatOuterHeight - 3);

  // ペインの内側幅 = 端末幅 - 枠線 (左右 2 列) - 安全マージン 1 列。最右端の
  // セルまで書き込むと端末が wrap-pending 状態になり、次の書き込みや resize
  // のタイミングで意図しない折り返しが起きることがあるため、1 列分の余白を
  // 残して折り返す。ここで論理行を折り返し済みの Row へ平坦化し、以降の
  // slice/描画・スクロール offset はすべて Row 単位 (= 端末 1 行) で扱う。
  // これで「slice した行数 > ペイン高さ」が起きず残像化しない。terminalCols
  // が取れない (非TTY) 場合は広め (弱い折り返し) にする。
  const innerWidth =
    terminalCols !== undefined ? Math.max(1, terminalCols - 2 - 1) : 80;
  // ログの各エントリ (span 列) を端末幅で複数 Row へ折り返し平坦化する
  // (chat の toRows と同じ方式)。これで offset/viewport の単位が chat と
  // 同じ Row (端末 1 行) になり、長いログも折り返して最後まで読める。
  const logRows = logEntries.flatMap((e) => wrapSpans(e, innerWidth));
  const chatRows = toRows(chatLines, innerWidth);

  // スクロール位置は最新 Row 数に応じてクランプ (行が減った/端末が縮んだ場合に
  // offset が範囲外にならないようにする)。描画に使う値であり state は更新
  // しない (追従判定は下の useInput 側で行う)。
  const logOffsetClamped = clampOffset(logRows.length, logViewport, logOffset);
  const chatOffsetClamped = clampOffset(
    chatRows.length,
    chatViewport,
    chatOffset,
  );

  // フォーカス可能な対象の巡回順。input は常に存在し、log はログペイン表示時
  // のみ含まれる。Tab/Shift-Tab はこの並びを前後に巡回する。
  const focusRing: FocusTarget[] = showLogPane
    ? ["input", "log", "chat"]
    : ["input", "chat"];

  // 入力欄の編集 (文字挿入/カーソル移動/kill 系) + 行確定 (Enter) + フォーカス
  // 切替 (Tab/Shift-Tab/Escape) + ペインのスクロール操作。raw mode が効く
  // TTY のときだけ動く (ink の useInput は raw mode 前提。非TTY では
  // isRawModeSupported が false になり呼んでも何もしない — その場合は上の
  // readline 経路が行確定を別途担う)。TTY ではここが入力の唯一の消費者になる
  // (readline は作らない) ので、Enter による行確定もここで submitLine を
  // 呼んで行う。
  //
  // フォーカス対象 (focusedTarget) によって効くキーが変わる: "input" では
  // 文字入力/Enter/カーソル移動/kill 系が効き、上下矢印や PageUp/Down は
  // 何もしない (ペインスクロール用のキーのため)。"log"/"chat" ではその逆で
  // ペインのスクロールのみ効き、文字入力は無視される。Ctrl-C/Tab/Escape は
  // フォーカスに関わらず常に有効。
  useInput(
    (input, key) => {
      // ── SGR マウスイベント ──
      // ink の parse-keypress はマウスシーケンスを解釈せず sequence をその
      // まま input に流してくる (先頭の ESC 1 個は use-input 側で剥がされる
      // ため "[<btn;x;yM" の形で届く。複数イベントが 1 チャンクに合流した
      // 場合は 2 個目以降が ESC 付きで後続する)。ホイール (btn 64=上/65=下)
      // は y 座標 (端末 1-origin 行) が指すペインを 1 行スクロールし、それ
      // 以外のマウスイベント (クリック等) は入力欄へ文字として混入しない
      // よう握りつぶす。マウストラッキングの有効化は下の useEffect 参照。
      if (/^\[<\d+;\d+;\d+[Mm]/.test(input)) {
        for (const m of input.matchAll(/\[<(\d+);\d+;(\d+)M/g)) {
          const btn = m[1];
          if (btn !== "64" && btn !== "65") continue;
          const y = Number(m[2]);
          // レイアウトは端末全面 (log ペイン: 1..logOuterHeight 行、以降は
          // chat ペイン + 入力欄) なので y でペインを選ぶ。
          const isLogPane = showLogPane && y <= logOuterHeight;
          const setOffset = isLogPane ? setLogOffset : setChatOffset;
          const total = isLogPane ? logRows.length : chatRows.length;
          const viewport = isLogPane ? logViewport : chatViewport;
          const delta = btn === "64" ? 1 : -1;
          setOffset((o) => clampOffset(total, viewport, o + delta));
        }
        return;
      }

      if (key.ctrl && input === "c") {
        exit();
        onDone();
        return;
      }

      // ── フォーカス切替 (Tab / Shift-Tab / Escape) ── 常に有効
      if (key.tab) {
        // @bot 補完: input フォーカス中に "@bot" の前方一致 ("@", "@b", "@bo",
        // "@bot") を入力しているときだけ Tab で "@bot " に補完する。それ以外
        // は従来通りフォーカス巡回。
        if (
          focusedTarget === "input" &&
          !key.shift &&
          inputValue !== "" &&
          inputValue.startsWith("@") &&
          "@bot".startsWith(inputValue)
        ) {
          setInputValue("@bot ");
          setCursor(5);
          return;
        }

        const idx = focusRing.indexOf(focusedTarget);
        const current = idx === -1 ? 0 : idx;
        const next = key.shift
          ? focusRing[(current - 1 + focusRing.length) % focusRing.length]
          : focusRing[(current + 1) % focusRing.length];
        setFocusedTarget(next ?? "input");
        return;
      }
      if (key.escape) {
        setFocusedTarget("input");
        return;
      }

      if (focusedTarget === "input") {
        // ── 入力欄の編集 + 行確定 ──
        if (key.return) {
          submitLine(inputValue);
          return;
        }

        // ── 入力欄のカーソル移動 (左右) ──
        if (key.leftArrow) {
          setCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (key.rightArrow) {
          setCursor((c) => Math.min([...inputValue].length, c + 1));
          return;
        }

        // ── 入力欄のエコー (コードポイント単位で編集) ──
        // このコールバックは ink から同期的に 1 イベントずつ呼ばれ、その間に
        // 再レンダーは起きない (state の再取得は起きない) ため、現在の
        // inputValue/cursor をそのまま読み出して次の値を計算してよい。
        if (key.backspace || key.delete) {
          if (cursor === 0) return;
          const cps = [...inputValue];
          cps.splice(cursor - 1, 1);
          setInputValue(cps.join(""));
          setCursor(cursor - 1);
          return;
        }

        // ── readline 相当の行編集キーバインド (Ctrl-A/E/B/F/K/U/W/D) ──
        if (key.ctrl && input === "a") {
          setCursor(0);
          return;
        }
        if (key.ctrl && input === "e") {
          setCursor([...inputValue].length);
          return;
        }
        if (key.ctrl && input === "b") {
          setCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (key.ctrl && input === "f") {
          setCursor((c) => Math.min([...inputValue].length, c + 1));
          return;
        }
        if (key.ctrl && input === "k") {
          const cps = [...inputValue];
          setInputValue(cps.slice(0, cursor).join(""));
          return;
        }
        if (key.ctrl && input === "u") {
          const cps = [...inputValue];
          setInputValue(cps.slice(cursor).join(""));
          setCursor(0);
          return;
        }
        if (key.ctrl && input === "w") {
          const cps = [...inputValue];
          let i = cursor;
          while (i > 0 && cps[i - 1] === " ") i--;
          while (i > 0 && cps[i - 1] !== " ") i--;
          const next = [...cps.slice(0, i), ...cps.slice(cursor)];
          setInputValue(next.join(""));
          setCursor(i);
          return;
        }
        if (key.ctrl && input === "d") {
          if (inputValue === "") {
            requestFinish();
            return;
          }
          const cps = [...inputValue];
          if (cursor < cps.length) {
            cps.splice(cursor, 1);
            setInputValue(cps.join(""));
          }
          return;
        }

        if (key.ctrl || key.meta) return;
        const inserted = [...input];
        if (inserted.length === 0) return;
        const cps = [...inputValue];
        cps.splice(cursor, 0, ...inserted);
        setInputValue(cps.join(""));
        setCursor(cursor + inserted.length);
        return;
      }

      // ── ペインのスクロール操作 (focusedTarget === "log" | "chat") ──
      // 上下矢印/PageUp/PageDown/Ctrl-P/Ctrl-N のみ有効。文字入力は無視する。
      const isLog = focusedTarget === "log";
      const setOffset = isLog ? setLogOffset : setChatOffset;
      // offset は Row (折り返し済みの端末 1 行) 単位。
      const total = isLog ? logRows.length : chatRows.length;
      const viewport = isLog ? logViewport : chatViewport;
      const clamp = (o: number): number => clampOffset(total, viewport, o);
      if (key.upArrow || (key.ctrl && input === "p")) {
        setOffset((o) => clamp(o + 1));
        return;
      }
      if (key.downArrow || (key.ctrl && input === "n")) {
        setOffset((o) => clamp(o - 1));
        return;
      }
      if (key.pageUp) {
        setOffset((o) => clamp(o + viewport));
        return;
      }
      if (key.pageDown) {
        setOffset((o) => clamp(o - viewport));
        return;
      }
      // その他のキー (文字入力等) はここでは何もしない。
    },
    { isActive: isRawModeSupported === true },
  );

  const chatFocused = focusedTarget === "chat";
  const logFocused = focusedTarget === "log";

  // 各ペインを固定 viewportHeight スロットのグリッドへ組み立てる。followTail
  // (offset 0) のときは新着が下に来るよう上を空行で埋め、スクロールバック中は
  // 下を空行で埋める (詳細は toGrid のコメント参照)。log/chat とも Row 側で
  // 既に折り返し済み (幅内) のため、ここでの追加の切り詰めは不要。
  const logGrid = toGrid(
    visibleSlice(logRows, logViewport, logOffsetClamped),
    logViewport,
    logOffsetClamped === 0,
  );
  const chatGrid = toGrid(
    visibleSlice(chatRows, chatViewport, chatOffsetClamped).map(
      (row): GridRow =>
        // 空の論理行は空スロット扱いにして、グリッドの余白埋めと同じ描画
        // (単一スペース) に揃える。
        row.text === ""
          ? BLANK_GRID_ROW
          : [
              {
                text: row.text,
                ...(row.color !== undefined ? { color: row.color } : {}),
              },
            ],
    ),
    chatViewport,
    chatOffsetClamped === 0,
  );

  // 入力欄は枠線を持たないペイン外の 1 行なので、可視幅は端末幅そのもの
  // (安全マージン 1 列を引く) から prompt の表示幅を引いたもの。terminalCols
  // 不明 (非TTY) のときは width を渡さず切り詰めない。
  const inputWidth =
    terminalCols !== undefined
      ? Math.max(1, terminalCols - 1 - stringWidth(prompt))
      : undefined;

  return (
    <Box flexDirection="column">
      {showLogPane ? (
        <Pane
          title=" logging"
          focused={logFocused}
          height={logOuterHeight}
          innerWidth={innerWidth}
          grid={logGrid}
        />
      ) : null}
      <Pane
        title=" chat"
        focused={showLogPane && chatFocused}
        height={chatOuterHeight}
        innerWidth={innerWidth}
        grid={chatGrid}
      />
      <InputLine
        prompt={prompt}
        value={inputValue}
        cursor={cursor}
        {...(inputWidth !== undefined ? { width: inputWidth } : {})}
      />
    </Box>
  );
}

export async function startRepl(
  chat: LocalChat,
  options: StartReplOptions,
): Promise<void> {
  const output = options.output ?? process.stdout;

  let unmount: (() => void) | undefined;
  await new Promise<void>((resolve) => {
    const handle = render(
      <App chat={chat} options={options} onDone={() => resolve()} />,
      {
        stdout: output as NodeJS.WriteStream,
        exitOnCtrlC: false,
        // patchConsole は console.* を ink 経由に差し替える。テスト実行環境
        // (vitest) や PassThrough 出力の組み合わせで console.Console の
        // 差し替えが失敗することがあり、この REPL は console.log 自体を
        // 使わないため無効化する。
        patchConsole: false,
      },
    );
    unmount = handle.unmount;
  });
  unmount?.();
}
