// KeywordGate — docs/design/session-model.md §5 の安価なプリフィルタ
//
// pattern (正規表現文字列) を message の本文にマッチさせる。message 以外の kind
// は対象外として trigger=false。不正な正規表現はコンストラクション時にエラーにする。

import type { Gate, GateContext, TriggerDecision } from "../gate.js";

export class KeywordGate implements Gate {
  readonly name = "keyword";
  private readonly regex: RegExp;

  constructor(pattern: string) {
    // 不正な正規表現は construction 時に例外として表面化させる (実行時まで遅延させない)
    this.regex = new RegExp(pattern);
  }

  decide(ctx: GateContext): TriggerDecision {
    if (ctx.event.kind !== "message") {
      return { trigger: false, reason: `${this.name}: not a message event` };
    }
    if (this.regex.test(ctx.event.text)) {
      return {
        trigger: true,
        reason: `${this.name}: text matches /${this.regex.source}/`,
      };
    }
    return {
      trigger: false,
      reason: `${this.name}: text does not match /${this.regex.source}/`,
    };
  }
}
