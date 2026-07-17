// SenderGate — docs/design/session-model.md §5 の送信者種別によるプリフィルタ
//
// message / reaction どちらの event にも sender があるため kind は限定しない
// (message_edited/system には sender が無いため対象外として trigger=false)。
// ctx.event.sender.isBot が is === "bot" と一致すれば trigger する。
//
// 注: 自分自身 (isSelf) の投稿は bridge が常に除外するため、is: "bot" は実質
// 「自分以外の bot」を意味する (trigger.allowBots が opt-in で bot 投稿を gate
// 評価に届けたときに初めて意味を持つ。session-model.md §5)。

import type { Gate, GateContext, TriggerDecision } from "../gate.js";

export class SenderGate implements Gate {
  readonly name = "sender";

  constructor(private readonly is: "bot" | "human") {}

  decide(ctx: GateContext): TriggerDecision {
    if (ctx.event.kind !== "message" && ctx.event.kind !== "reaction") {
      return {
        trigger: false,
        reason: `${this.name}: event has no sender`,
      };
    }
    const wantBot = this.is === "bot";
    const isBot = ctx.event.sender.isBot;
    const senderDesc = isBot ? "sender is a bot" : "sender is human";
    if (isBot === wantBot) {
      return {
        trigger: true,
        reason: `${this.name}: ${senderDesc}`,
      };
    }
    return {
      trigger: false,
      reason: `${this.name}: ${senderDesc} (want ${this.is})`,
    };
  }
}
