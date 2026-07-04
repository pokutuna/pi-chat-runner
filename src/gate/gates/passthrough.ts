// PassthroughGate — docs/design/session-model.md §5
//
// mention なしで全部拾う実験・DM 専用チャンネル用に常に trigger=true。
// ただし bot 発言 (sender.isBot) は無限ループ防止のため内側でも除外する
// (Layer 0 ハードフィルタは原則呼び出し側の責務だが、passthrough だけは自衛する)。

import type { Gate, GateContext, TriggerDecision } from "../gate.js";

export class PassthroughGate implements Gate {
	readonly name = "passthrough";

	decide(ctx: GateContext): TriggerDecision {
		if (ctx.event.kind === "message" && ctx.event.sender.isBot) {
			return { trigger: false, reason: `${this.name}: sender is bot` };
		}
		return { trigger: true, reason: `${this.name}: always trigger` };
	}
}
