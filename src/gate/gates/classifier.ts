// ClassifierGate — session-model.md §5 Layer 2 (LLM classifier)
//
// criteria (自然言語) と対象メッセージを ClassifierClient に渡し、起動可否を判定する。
// message 以外の kind は対象外として trigger=false (keyword/mention と同じ流儀)。
// LLM 呼び出しが失敗したら fail-closed で trigger=false に倒す — fail-open だと LLM
// 障害時にセッションが暴発するため。

import type { ClassifierClient } from "../../classifier/client.js";
import type { Logger } from "../../logger.js";
import type { Gate, GateContext, TriggerDecision } from "../gate.js";

export class ClassifierGate implements Gate {
  readonly name = "classifier";

  constructor(
    private readonly criteria: string,
    private readonly client: ClassifierClient,
    private readonly opts: { model?: string; logger?: Logger } = {},
  ) {}

  async decide(ctx: GateContext): Promise<TriggerDecision> {
    if (ctx.event.kind !== "message") {
      return { trigger: false, reason: `${this.name}: not a message event` };
    }
    try {
      const { result, reason } = await this.client.classify({
        criteria: this.criteria,
        text: ctx.event.text,
        ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
      });
      this.opts.logger?.info(
        { gate: this.name, trigger: result, reason, model: this.opts.model },
        "classifier decision",
      );
      return { trigger: result, reason: `${this.name}: ${reason}` };
    } catch (err) {
      this.opts.logger?.warn(
        { gate: this.name, err },
        "classifier call failed; failing closed",
      );
      return {
        trigger: false,
        reason: `${this.name}: classification failed (fail-closed)`,
      };
    }
  }
}
