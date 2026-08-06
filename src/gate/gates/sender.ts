// SenderGate — docs/design/session-model.md §5 の送信者によるプリフィルタ
//
// message / reaction どちらの event にも sender があるため kind は限定しない
// (message_edited/system には sender が無いため対象外として trigger=false)。
// 判定軸は 3 つで、複数指定した場合は AND:
//   - is: sender.isBot が is === "bot" と一致すれば trigger する。
//   - id: sender.id (プラットフォームのユーザ ID) が一覧に完全一致すれば trigger する。
//     改名の影響を受けない安定した指定。
//   - name: sender.displayName が一覧に完全一致すれば trigger する。displayName は
//     EventSource/bridge 層が gate 評価前に正規化して埋める契約 (chat-event.ts)。
//     未解決 (undefined) は fail-closed で trigger しない。
// negate を持たない方針 (config.md §7) のため id/name とも allowlist 専用。
//
// 注: 自分自身 (isSelf) の投稿は bridge が常に除外するため、is: "bot" は実質
// 「自分以外の bot」を意味する (trigger.allowBots が opt-in で bot 投稿を gate
// 評価に届けたときに初めて意味を持つ。session-model.md §5)。

import type { Gate, GateContext, TriggerDecision } from "../gate.js";

export interface SenderGateOptions {
  is?: "bot" | "human";
  id?: string[];
  name?: string[];
}

export class SenderGate implements Gate {
  readonly name = "sender";

  constructor(private readonly opts: SenderGateOptions) {
    if (
      opts.is === undefined &&
      (opts.id === undefined || opts.id.length === 0) &&
      (opts.name === undefined || opts.name.length === 0)
    ) {
      throw new Error(
        'SenderGate requires at least one of "is", "id" or "name"',
      );
    }
  }

  decide(ctx: GateContext): TriggerDecision {
    if (ctx.event.kind !== "message" && ctx.event.kind !== "reaction") {
      return {
        trigger: false,
        reason: `${this.name}: event has no sender`,
      };
    }
    const sender = ctx.event.sender;
    const reasons: string[] = [];

    if (this.opts.is !== undefined) {
      const wantBot = this.opts.is === "bot";
      const senderDesc = sender.isBot ? "sender is a bot" : "sender is human";
      if (sender.isBot !== wantBot) {
        return {
          trigger: false,
          reason: `${this.name}: ${senderDesc} (want ${this.opts.is})`,
        };
      }
      reasons.push(senderDesc);
    }

    if (this.opts.id !== undefined) {
      if (!this.opts.id.includes(sender.id)) {
        return {
          trigger: false,
          reason: `${this.name}: id "${sender.id}" not in [${this.opts.id.join(", ")}]`,
        };
      }
      reasons.push(`id "${sender.id}" matched`);
    }

    if (this.opts.name !== undefined) {
      if (sender.displayName === undefined) {
        return {
          trigger: false,
          reason: `${this.name}: sender ${sender.id} has no displayName (unresolved)`,
        };
      }
      if (!this.opts.name.includes(sender.displayName)) {
        return {
          trigger: false,
          reason: `${this.name}: displayName "${sender.displayName}" not in [${this.opts.name.join(", ")}]`,
        };
      }
      reasons.push(`displayName "${sender.displayName}" matched`);
    }

    return {
      trigger: true,
      reason: `${this.name}: ${reasons.join(", ")}`,
    };
  }
}
