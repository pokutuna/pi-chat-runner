// MentionGate — docs/design/session-model.md §5 の Layer 1 (決定的トリガ)
//
// InboundMessage で mentionsBot === true なら無条件で trigger する。
// message 以外の kind (reaction/message_edited/system) は対象外として trigger=false。

import type { Gate, GateContext, TriggerDecision } from "../gate.js";

export class MentionGate implements Gate {
  readonly name = "mention";

  decide(ctx: GateContext): TriggerDecision {
    if (ctx.event.kind !== "message") {
      return { trigger: false, reason: `${this.name}: not a message event` };
    }
    if (ctx.event.mentionsBot) {
      return { trigger: true, reason: `${this.name}: mentionsBot=true` };
    }
    return { trigger: false, reason: `${this.name}: mentionsBot=false` };
  }
}
