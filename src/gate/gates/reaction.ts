// ReactionGate — 特定 emoji のリアクション付与を初回キックの決定的トリガとする
// (session-model.md §5「人間によるリアクション起動」)。
//
// reaction 以外の kind は対象外として trigger=false。mention/keyword と対称。

import type { Gate, GateContext, TriggerDecision } from "../gate.js";

export class ReactionGate implements Gate {
  readonly name = "reaction";

  constructor(private readonly emoji: string[]) {}

  decide(ctx: GateContext): TriggerDecision {
    if (ctx.event.kind !== "reaction") {
      return { trigger: false, reason: `${this.name}: not a reaction event` };
    }
    if (!ctx.event.added) {
      return { trigger: false, reason: `${this.name}: reaction removed` };
    }
    const matched = this.emoji.includes(ctx.event.emoji);
    return matched
      ? { trigger: true, reason: `${this.name}: :${ctx.event.emoji}:` }
      : { trigger: false, reason: `${this.name}: emoji not in list` };
  }
}
