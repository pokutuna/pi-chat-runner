/**
 * pi の RPC イベントから pi-chat-runner が読み取るドメイン情報の抽出
 * (reply 引数、usage 集計、エラー抽出、debug ログ整形)。
 * プロトコルそのものの型・パースは rpc.ts。
 */

import type { EgressPayload } from "../egress/router.js";
import type { AgentEndEvent, PiEvent, ToolExecutionEndEvent } from "./rpc.js";

/** tool_execution_end イベントから reply の引数を取り出す。reply 以外や形不正は null。
 * files はこの時点では agent が渡した生の workdir 相対パス — 解決・境界チェックは
 * runner が行う (extensions/reply.ts の details 形と対応) */
export function extractReply(
  event: ToolExecutionEndEvent,
): EgressPayload | null {
  if (event.toolName !== "reply" || event.isError) return null;
  const details = event.result?.details;
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (typeof d.thread_key !== "string" || typeof d.text !== "string")
    return null;
  const files =
    Array.isArray(d.files) && d.files.every((f) => typeof f === "string")
      ? (d.files as string[])
      : undefined;
  return {
    thread_key: d.thread_key,
    text: d.text,
    ...(files !== undefined ? { files } : {}),
  };
}

/**
 * agent_end の messages から assistant ターンのエラーを取り出す。
 * LLM 呼び出しが失敗しても (例: ADC 不備、ネットワーク遮断) pi はターンを
 * stopReason: "error" の assistant メッセージとして「正常に」完走させ agent_end を
 * 返すため、ここで拾ってログに出さないと「✅ は付くが返信が無い」という
 * 症状だけが残り、原因が transcript を直接読むまで分からない。
 */
export function extractTurnErrors(event: AgentEndEvent): string[] {
  const errors: string[] = [];
  for (const message of event.messages) {
    if (typeof message !== "object" || message === null) continue;
    const m = message as Record<string, unknown>;
    if (m.role !== "assistant" || m.stopReason !== "error") continue;
    errors.push(
      typeof m.errorMessage === "string" ? m.errorMessage : "unknown error",
    );
  }
  return errors;
}

export type TurnStatus = "ok" | "error";

/**
 * agent_end の最終 assistant メッセージの stopReason からターンの成否を判定する。
 * stopReason は必ず付く 5 値 (stop / length / toolUse / error / aborted) で、
 * messages は時系列 (末尾が最新)。「本当に完走した」= stop のみを ok とし、
 * それ以外は error 扱いにする (whitelist)。LLM 呼び出し失敗も pi は
 * stopReason: "error" の assistant メッセージとして正常に完走させ agent_end を
 * 返すため、ここを whitelist にしないと失敗が ok に紛れる (extractTurnErrors と
 * 同じ症状)。assistant メッセージが無いターン (沈黙の正常終了) は ok。
 */
export function turnStatusFromAgentEnd(event: AgentEndEvent): TurnStatus {
  for (let i = event.messages.length - 1; i >= 0; i--) {
    const message = event.messages[i];
    if (typeof message !== "object" || message === null) continue;
    const m = message as Record<string, unknown>;
    if (m.role !== "assistant") continue;
    return m.stopReason === "stop" ? "ok" : "error";
  }
  return "ok";
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * agent_end.messages (毎回「全履歴」を返す) から usage を合算する。
 * そのため戻り値はターン単位の増分ではなく「セッション累計」になる点に注意。
 */
export function extractUsageTotals(event: AgentEndEvent): UsageTotals {
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costTotal: 0,
  };
  for (const message of event.messages) {
    if (typeof message !== "object" || message === null) continue;
    const m = message as Record<string, unknown>;
    if (m.role !== "assistant") continue;
    if (typeof m.usage !== "object" || m.usage === null) continue;
    const usage = m.usage as Record<string, unknown>;
    totals.input += numberOrZero(usage.input);
    totals.output += numberOrZero(usage.output);
    totals.cacheRead += numberOrZero(usage.cacheRead);
    totals.cacheWrite += numberOrZero(usage.cacheWrite);
    totals.totalTokens += numberOrZero(usage.totalTokens);
    const cost = usage.cost;
    if (typeof cost === "object" && cost !== null) {
      totals.costTotal += numberOrZero((cost as Record<string, unknown>).total);
    }
  }
  return totals;
}

export function preview(value: unknown, maxChars = 200): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

/**
 * pi イベントの debug ログ用概要フィールド。ペイロード全体は大きく機微も含みうる
 * ため出さず、デバッグに効く要点だけ抜き出す。null を返したイベント
 * (message_update / tool_execution_update のストリーミング差分) はログしない —
 * 1 ターンで数百行出て他のログを埋めてしまうため。
 */
export function piEventLogFields(
  event: PiEvent,
): Record<string, unknown> | null {
  const e = event as Record<string, unknown>;
  switch (event.type) {
    case "message_update":
    case "tool_execution_update":
      return null;
    case "tool_execution_start":
      return {
        toolName: e.toolName,
        toolCallId: e.toolCallId,
        args: preview(e.args),
      };
    case "tool_execution_end": {
      const end = event as ToolExecutionEndEvent;
      const resultChars = (end.result?.content ?? []).reduce(
        (sum, c) =>
          sum + (c.type === "text" ? (c as { text: string }).text.length : 0),
        0,
      );
      return {
        toolName: end.toolName,
        toolCallId: end.toolCallId,
        isError: end.isError,
        resultChars,
      };
    }
    case "message_end": {
      const message = e.message;
      if (typeof message !== "object" || message === null) return {};
      const m = message as Record<string, unknown>;
      return {
        role: m.role,
        ...(m.stopReason !== undefined ? { stopReason: m.stopReason } : {}),
        ...(typeof m.errorMessage === "string"
          ? { errorMessage: preview(m.errorMessage) }
          : {}),
      };
    }
    case "queue_update":
      return {
        steering: Array.isArray(e.steering) ? e.steering.length : 0,
        followUp: Array.isArray(e.followUp) ? e.followUp.length : 0,
      };
    case "compaction_start":
      return { reason: e.reason };
    case "extension_error":
      return { error: preview(e.error) };
    default:
      return {};
  }
}
