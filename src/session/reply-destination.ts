import type { EgressRouter } from "../egress/router.js";
import type { InboundMessage } from "../ingress/chat-event.js";
import { replyThreadKeyOf, type SessionPolicy } from "./policy.js";

/** reply 宛先の登録 (メッセージごと。session-model.md §3)。境界規則:
 * スレッド内のトリガーは reply.mode に関わらずそのスレッドへ返す。
 * reply.mode が効くのはチャンネル直下トリガーの返信先だけ。
 * router.register という副作用を持つため policy.ts (純関数モジュール) ではなく
 * ここに置く。runner (kick 前の宛先登録) と ActiveSession (prompt/steer 時の
 * 宛先登録) の両方から使う */
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
