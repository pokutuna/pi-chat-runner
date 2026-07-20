import type { ChannelDoc } from "../config/channel-doc.js";
import type { InboundMessage } from "../ingress/chat-event.js";
import type { InboxItem } from "../store/state/interfaces.js";

/** session.mode / reply.mode の実効値 (doc 未設定時の既定込み。session-model.md §3) */
export interface SessionPolicy {
  sessionMode: "thread" | "channel";
  replyMode: "thread" | "flat";
}

/** ChannelDoc.session / ChannelDoc.reply からポリシーを導出する。DM は既定
 * session: channel, reply: flat (session-model.md §3 「DM は予約名 dm の既定」) */
export function resolveSessionPolicy(
  doc: ChannelDoc | null,
  isDm: boolean,
): SessionPolicy {
  return {
    sessionMode: doc?.session?.mode ?? (isDm ? "channel" : "thread"),
    replyMode: doc?.reply?.mode ?? (isDm ? "flat" : "thread"),
  };
}

/** セッション (文脈) キーの導出。sessionMode "thread" は現行 threadKeyOf と同じ
 * (channelId:threadTs ?? メッセージ ts)、"channel" は channelId のみ
 * (session-model.md §3) */
export function sessionKeyOf(
  event: InboundMessage,
  policy: SessionPolicy,
): string {
  if (policy.sessionMode === "channel") {
    return event.conversation.channelId;
  }
  return `${event.conversation.channelId}:${event.conversation.threadTs ?? event.id}`;
}

/** 返信宛先キーの導出。メッセージごとに発行し、sessionKey とは独立に
 * トリガーメッセージの位置を指す (session-model.md §3) */
export function replyThreadKeyOf(event: InboundMessage): string {
  return `${event.conversation.channelId}:${event.conversation.threadTs ?? event.id}`;
}

/** イベント 1 件のプロンプト描画 (session-runtime.md §4 の renderEvent)。
 * threadKey 指定時は from/time/thread_key をラベル付きで列挙し、エージェントが
 * reply 時にどの宛先へ返すべきか、いつのメッセージかを判別できるようにする
 * (session-model.md §3)。time は ISO 8601 (タイムゾーン付き) で曖昧さをなくす。 */
// 表示名だけにすると pi が mention (`<@U123>`) を組み立てられなくなるため、
// UserID は常に併記する
export function renderEvent(event: InboundMessage, threadKey?: string): string {
  const sender =
    event.sender.displayName !== undefined
      ? `${event.sender.displayName} (${event.sender.id})`
      : event.sender.id;
  const time = event.timestamp.toISOString();
  const lines = [`from: ${sender}`, `time: ${time}`];
  if (threadKey !== undefined) lines.push(`thread_key: ${threadKey}`);
  return `${lines.join("\n")}\n---\n${event.text}`;
}

export function renderItems(items: InboxItem[]): string {
  return items
    .map((item) => renderEvent(item.event, replyThreadKeyOf(item.event)))
    .join("\n\n");
}

/** 前回活動時刻から idleResetMinutes を超えたかどうかの判定 (session-model.md §3:
 * 時間はキーに入れず、リセットポリシーとして updated_at に対して評価する)。
 * 純関数として export しテストする */
export function isIdleExpired(
  lastUpdatedAt: Date,
  idleResetMinutes: number,
  now: number,
): boolean {
  return now - lastUpdatedAt.getTime() > idleResetMinutes * 60_000;
}

/** debounce の kick までの残り ms を求める (連投バーストの間、静まるまで kick を
 * 遅らせるための純関数)。「最後のメッセージ + debounceSec」まで延ばすが、
 * 「最初の滞留メッセージ + debounceSec*3」(hard cap) を超えない — 早い方を採用し、
 * 負なら 0 (即 kick) を返す */
export function computeKickDelayMs(args: {
  nowMs: number;
  firstPendingAtMs: number;
  debounceSec: number;
}): number {
  const { nowMs, firstPendingAtMs, debounceSec } = args;
  const slideUntil = nowMs + debounceSec * 1000;
  const hardCapUntil = firstPendingAtMs + debounceSec * 3 * 1000;
  const until = Math.min(slideUntil, hardCapUntil);
  return Math.max(0, until - nowMs);
}
