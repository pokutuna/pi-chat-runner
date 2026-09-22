import { replyThreadKeyOf, type SessionPolicy } from "../dispatch/policy.js";
import type { InboundMessage } from "../ingress/chat-event.js";
import type { EgressRouter } from "./router.js";

/** reply 宛先の登録 (メッセージごと。session-model.md §3)。境界規則:
 * スレッド内のトリガーは reply.mode に関わらずそのスレッドへ返す。
 * reply.mode が効くのはチャンネル直下トリガーの返信先だけ。
 * router.register という副作用を持つため policy.ts (純関数モジュール) ではなく
 * Egress 側に置く。Dispatcher (Session 起動前・コマンド通知の宛先登録) と Session
 * (prompt/steer 時の宛先登録) の両方から使う */
export function registerReplyDestination(
  router: EgressRouter,
  event: InboundMessage,
  policy: SessionPolicy,
): string {
  const channelId = event.conversation.channelId;
  const key = replyThreadKeyOf(event);
  if (event.conversation.threadTs !== undefined) {
    router.register(key, {
      channelId,
      threadTs: event.conversation.threadTs,
    });
  } else if (policy.replyMode === "thread") {
    // 新スレッドを起こす (トリガーメッセージ自身を thread root にする)
    router.register(key, { channelId, threadTs: event.id });
  } else {
    // フラット (チャンネル直下)
    router.register(key, { channelId });
  }
  return key;
}
