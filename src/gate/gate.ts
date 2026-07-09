// Gate IF + registry + trigger.when ブール木の評価 — docs/design/session-model.md §5,
// docs/design/config.md §7 (「trigger と gate の役割分担」「trigger.when — Gate の合成木」)
//
// 起動判定を差し替え可能な部品 (Gate) にし、config.md §7 のブール木 (配列 = OR,
// {and:[]}/{or:[]} で明示合成、ネスト可、negate なし) で合成する。channel 設定
// (criteria/pattern 等) は各 Gate のコンストラクタ引数で渡すため、GateContext には
// event/recent のみを持たせる (ChannelDoc.trigger.when の葉が GateConfig で、それを
// ここで Gate インスタンスへ組み立てる)。
//
// classifier は LLM 呼び出しを要するため ClassifierClient を deps で注入する
// (createGate の第 2 引数)。mention/keyword/passthrough は deps 不要。cooldown は
// 初期スコープ外のため registry 未登録 (createGate はエラーを投げる)。

import type { ClassifierClient } from "../classifier/client.js";
import type { GateConfig, WhenNode } from "../config/channel-doc.js";
import type { ChatEvent } from "../ingress/chat-event.js";
import type { Logger } from "../logger.js";
import { ClassifierGate } from "./gates/classifier.js";
import { KeywordGate } from "./gates/keyword.js";
import { MentionGate } from "./gates/mention.js";
import { PassthroughGate } from "./gates/passthrough.js";
import { ReactionGate } from "./gates/reaction.js";

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

/** ChannelDoc.trigger.when の葉 (YAML 由来)。kind ごとに要るパラメータだけ持つ。
 * classifier は criteria 必須 + model 任意 (per-gate モデル上書き)。 */
export type GateSpec =
  | { kind: "mention" }
  | { kind: "keyword"; pattern: string }
  | { kind: "passthrough" }
  | { kind: "classifier"; criteria: string; model?: string }
  | { kind: "reaction"; emoji: string[] };

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
    case "reaction":
      return new ReactionGate(spec.emoji);
    default: {
      const unknown: { kind: string } = spec;
      throw new Error(`createGate: unknown gate kind "${unknown.kind}"`);
    }
  }
}

/** trigger 設定が無いチャンネルの既定 = mention のみ。DM は passthrough
 * (session-model.md §5, docs/design/config.md §1 のユースケース表)。 */
export function defaultWhen(isDm: boolean): WhenNode[] {
  return isDm ? [{ kind: "passthrough" }] : [{ kind: "mention" }];
}

/** GateConfig (WhenNode の葉) → GateSpec への narrowing。criteria/pattern は
 * schema (channel-doc.ts) で kind ごとに必須が担保済みなので、ここでの欠落は
 * schema 通過後のバグとして fail-loud にする — 黙って無視すると起動判定が
 * 静かに変わってしまうため。 */
function gateConfigToSpec(gate: GateConfig): GateSpec {
  switch (gate.kind) {
    case "mention":
      return { kind: "mention" };
    case "passthrough":
      return { kind: "passthrough" };
    case "keyword":
      if (gate.pattern === undefined) {
        throw new Error('gate kind "keyword" requires "pattern"');
      }
      return { kind: "keyword", pattern: gate.pattern };
    case "classifier":
      if (gate.criteria === undefined) {
        throw new Error('gate kind "classifier" requires "criteria"');
      }
      return {
        kind: "classifier",
        criteria: gate.criteria,
        ...(gate.model !== undefined ? { model: gate.model } : {}),
      };
    case "reaction":
      if (gate.emoji === undefined || gate.emoji.length === 0) {
        throw new Error('gate kind "reaction" requires a non-empty "emoji"');
      }
      return { kind: "reaction", emoji: gate.emoji };
    default: {
      const unknown: { kind: string } = gate;
      throw new Error(`unsupported gate kind "${unknown.kind}"`);
    }
  }
}

/** trigger.when の木 (config 由来、未評価) を Gate 木 (評価可能) に組み立てたもの。
 * 葉は createGate 済みの Gate インスタンスを持つ (config.md §7)。 */
export type EvaluableNode =
  | { gate: Gate }
  | { and: EvaluableNode[] }
  | { or: EvaluableNode[] };

/** WhenNode[] (config 由来) を EvaluableNode[] (評価可能な Gate 木) に変換する。
 * 葉の GateConfig → GateSpec 変換 (gateConfigToSpec) と createGate をここでまとめて行う。 */
export function buildWhen(
  nodes: WhenNode[],
  deps: GateDeps = {},
): EvaluableNode[] {
  return nodes.map((node) => buildWhenNode(node, deps));
}

function buildWhenNode(node: WhenNode, deps: GateDeps): EvaluableNode {
  if ("and" in node) {
    return { and: node.and.map((child) => buildWhenNode(child, deps)) };
  }
  if ("or" in node) {
    return { or: node.or.map((child) => buildWhenNode(child, deps)) };
  }
  return { gate: createGate(gateConfigToSpec(node), deps) };
}

/** EvaluableNode[] (トップレベル = OR、config.md §7) を評価する。短絡評価する。
 * reason には発火/非発火を決めた葉の gate 名と reason を、木構造は OR[...]/AND[...]
 * の簡易表記で含める。 */
export async function evaluateWhen(
  nodes: EvaluableNode[],
  ctx: GateContext,
): Promise<TriggerDecision> {
  return evaluateNode({ or: nodes }, ctx);
}

async function evaluateNode(
  node: EvaluableNode,
  ctx: GateContext,
): Promise<TriggerDecision> {
  if ("gate" in node) {
    return node.gate.decide(ctx);
  }
  if ("and" in node) {
    // 空の AND は単位元として true (空の OR は false)
    if (node.and.length === 0) {
      return { trigger: true, reason: "AND[] (empty, vacuously true)" };
    }
    const reasons: string[] = [];
    for (const child of node.and) {
      const decision = await evaluateNode(child, ctx);
      reasons.push(describe(child, decision));
      if (!decision.trigger) {
        return {
          trigger: false,
          reason: `AND[${reasons.join(", ")}] short-circuited`,
        };
      }
    }
    return { trigger: true, reason: `AND[${reasons.join(", ")}]` };
  }
  // "or" in node
  if (node.or.length === 0) {
    return { trigger: false, reason: "OR[] (empty, vacuously false)" };
  }
  const reasons: string[] = [];
  for (const child of node.or) {
    const decision = await evaluateNode(child, ctx);
    reasons.push(describe(child, decision));
    if (decision.trigger) {
      return {
        trigger: true,
        reason: `OR[${reasons.join(", ")}] short-circuited`,
      };
    }
  }
  return { trigger: false, reason: `OR[${reasons.join(", ")}]` };
}

/** reason 文字列に埋め込む 1 ノード分の説明。葉は gate 名 + decide の reason、
 * 内部ノードは AND[...]/OR[...] の簡易表記 (evaluateNode が生成した reason をそのまま使う)。 */
function describe(node: EvaluableNode, decision: TriggerDecision): string {
  if ("gate" in node) {
    return `${node.gate.name}=${decision.trigger} (${decision.reason})`;
  }
  return decision.reason;
}
