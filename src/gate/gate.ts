// Gate IF + registry + 合成 — docs/design/session-model.md §5
//
// 起動判定を差し替え可能な部品 (Gate) にし、複数を any/all で合成する。
// channel 設定 (criteria/pattern 等) は各 Gate のコンストラクタ引数で渡すため、
// GateContext には event/recent のみを持たせる (architecture.md §2 の ChannelDoc.trigger
// が gates: Array<{kind, ...params}> を持ち、それをここで Gate インスタンスへ組み立てる)。
//
// classifier は LLM 呼び出しを要するため ClassifierClient を deps で注入する
// (createGate の第 2 引数)。mention/keyword/passthrough は deps 不要。cooldown は
// 初期スコープ外のため registry 未登録 (createGate はエラーを投げる)。

import type { ClassifierClient } from "../classifier/client.js";
import type { ChatEvent } from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import { ClassifierGate } from "./gates/classifier.js";
import { KeywordGate } from "./gates/keyword.js";
import { MentionGate } from "./gates/mention.js";
import { PassthroughGate } from "./gates/passthrough.js";

export interface GateContext {
	event: ChatEvent;
	recent: ChatEvent[];
}

export interface TriggerDecision {
	trigger: boolean;
	reason: string;
}

/** 起動判定の 1 単位。純粋関数に近い。副作用 (observed 記録等) は呼び出し側が持つ */
export interface Gate {
	readonly name: string;
	decide(ctx: GateContext): Promise<TriggerDecision> | TriggerDecision;
}

export type GateCombinator = "any" | "all";

/** ChannelDoc.trigger.gates の 1 要素 (YAML 由来)。kind ごとに要るパラメータだけ持つ。
 * classifier は criteria 必須 + model 任意 (per-gate モデル上書き)。cooldown は初期
 * スコープ外のため registry 未登録 (createGate はエラーを投げる)。 */
export type GateSpec =
	| { kind: "mention" }
	| { kind: "keyword"; pattern: string }
	| { kind: "passthrough" }
	| { kind: "classifier"; criteria: string; model?: string };

/** createGate に注入する依存。classifier gate のみが必要とする (LLM client + logger)。 */
export interface GateDeps {
	classifierClient?: ClassifierClient;
	logger?: Logger;
}

/** GateSpec (YAML 由来のデータ) から Gate インスタンスを組み立てる registry。
 * deps は classifier のためのもの。他 kind は無視するため既定 {} で source 互換。 */
export function createGate(spec: GateSpec, deps: GateDeps = {}): Gate {
	switch (spec.kind) {
		case "mention":
			return new MentionGate();
		case "keyword":
			return new KeywordGate(spec.pattern);
		case "passthrough":
			return new PassthroughGate();
		case "classifier": {
			if (deps.classifierClient === undefined) {
				throw new Error(
					'createGate: gate kind "classifier" requires a classifierClient (none injected)',
				);
			}
			return new ClassifierGate(spec.criteria, deps.classifierClient, {
				...(spec.model !== undefined ? { model: spec.model } : {}),
				...(deps.logger !== undefined ? { logger: deps.logger } : {}),
			});
		}
		default: {
			const unknown: { kind: string } = spec;
			throw new Error(`createGate: unknown gate kind "${unknown.kind}"`);
		}
	}
}

/** trigger 設定が無いチャンネルの既定 = mention のみ。DM は passthrough
 * (session-model.md §5, docs/design/config.md §1 のユースケース表)。 */
export function defaultGates(isDm: boolean): Gate[] {
	return isDm ? [new PassthroughGate()] : [new MentionGate()];
}

/** 複数 Gate を combinator (any/all) で畳む。短絡評価する。
 * reason には発火/非発火を決めた gate 名 (と各 gate の reason) を含める。
 * gates が空の場合は any=false / all=true (畳み込みの単位元) を返す。 */
export async function evaluateTrigger(
	gates: Gate[],
	combinator: GateCombinator,
	ctx: GateContext,
): Promise<TriggerDecision> {
	if (gates.length === 0) {
		const trigger = combinator === "all";
		return {
			trigger,
			reason: `no gates configured (combinator=${combinator})`,
		};
	}

	const decisions: { name: string; decision: TriggerDecision }[] = [];
	for (const gate of gates) {
		const decision = await gate.decide(ctx);
		decisions.push({ name: gate.name, decision });

		if (combinator === "any" && decision.trigger) {
			return {
				trigger: true,
				reason: `any: ${gate.name} triggered (${decision.reason})`,
			};
		}
		if (combinator === "all" && !decision.trigger) {
			return {
				trigger: false,
				reason: `all: ${gate.name} did not trigger (${decision.reason})`,
			};
		}
	}

	if (combinator === "any") {
		const names = decisions.map((d) => d.name).join(", ");
		return { trigger: false, reason: `any: no gate triggered (${names})` };
	}

	const names = decisions.map((d) => d.name).join(", ");
	return { trigger: true, reason: `all: every gate triggered (${names})` };
}
