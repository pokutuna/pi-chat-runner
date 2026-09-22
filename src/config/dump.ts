// 実効設定の書き出し (effective config) — docs/design/config.md §5
//
// dump は解決関数をランタイムと共有する (resolveChannelConfig をそのまま呼ぶ)。
// dump 専用の別実装を持たないことで、dump と本番で結果がずれないことを保証する。
// I/O (設定ファイルの読み込み・stdout への出力) は server.ts が担い、この
// モジュールは ChannelsFile + default Agent Config を受け取って文字列を返す
// 純関数だけを持つ (テスト容易性)。
//
// 対象は agent / channels ブロックだけで system には触れない。agent.env の値も
// 解決せず、書かれたままの参照文字列 (${env.X}) を表示する (config.md §2.1, §5)。

import { resolveSessionPolicy } from "../session/policy.js";
import type { AgentConfig } from "./agent-config.js";
import type { ChannelsFile, WhenNode } from "./channel-config.js";
import {
  type AgentProvenance,
  DEFAULT_CHANNEL,
  DM_CHANNEL,
  type FieldSource,
  type Provenance,
  type ResolvedChannel,
  resolveChannelConfig,
} from "./config-source.js";

/** provenance の出所ラベルを人向け表記に変換する (config.md §3.3 の 5 ラベル)。
 * FieldSource の値はそのまま表示語になるため恒等写像だが、表示語を変えたく
 * なったときの差し込み口としてこの関数を通す。 */
function sourceLabel(source: FieldSource): string {
  return source;
}

/** trigger.when の合成木を 1 行に整形する (config.md §5 の出力例:
 * `OR[ keyword, AND[ sender(is=bot), classifier(gemini-3.1-flash-lite) ] ]`)。
 * 配列 = OR、{and}/{or} = 明示合成、葉は kind (classifier のみ model を添える)。 */
export function formatWhen(nodes: WhenNode[]): string {
  return `OR[ ${nodes.map(formatWhenNode).join(", ")} ]`;
}

function formatWhenNode(node: WhenNode): string {
  if ("and" in node) {
    return `AND[ ${node.and.map(formatWhenNode).join(", ")} ]`;
  }
  if ("or" in node) {
    return `OR[ ${node.or.map(formatWhenNode).join(", ")} ]`;
  }
  if (node.kind === "classifier") {
    const model = node.model ?? "code default";
    return `classifier(${model})`;
  }
  if (node.kind === "sender") {
    // is / id / name は併用でき、どれか 1 つ以上あればよい (config.md §4.2)。
    // 書かれた条件だけを並べる — 未指定を "is=undefined" と出さない。
    const parts: string[] = [];
    if (node.is !== undefined) parts.push(`is=${node.is}`);
    if (node.id !== undefined) parts.push(`id=[${node.id.join(", ")}]`);
    if (node.name !== undefined) parts.push(`name=[${node.name.join(", ")}]`);
    return `sender(${parts.join(", ")})`;
  }
  return node.kind;
}

/** systemPrompt / context の値を短く要約する。resolveChannelConfig の結果は
 * ファイル参照インライン化前 (FileConfigSource は dump の手前で inline 化を
 * 行わないため)、値は元の参照文字列 (`./prompts/...`) か、参照でなければ
 * 直書きテキストのどちらかが入っている。 */
function summarizeTextRef(value: string): string {
  const isFileRef = value.startsWith("./") || value.startsWith("../");
  if (isFileRef) {
    return `(from ${value})`;
  }
  const bytes = Buffer.byteLength(value, "utf-8");
  return `(inline, ${formatBytes(bytes)})`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/** フィールドの出所ラベルを解決する。値が設定されていなければ (isSet === false)
 * provenance を見ずに "code default"、あれば provenance をそのまま使う
 * (pretty / json 共通の provenance 解決規則、config.md §5)。 */
function fieldSource(
  provenance: FieldSource | undefined,
  isSet: boolean,
  fallback: FieldSource,
): string {
  return isSet ? sourceLabel(provenance ?? fallback) : "code default";
}

interface EffectiveField {
  label: string;
  value: string;
  source: string;
}

/** [channel] セクションの表示用フィールド一覧 (trigger / session / reply)。
 * provenance に無いフィールドはコード既定 (resolveSessionPolicy 等) を注記する。 */
function buildChannelFields(
  channel: ResolvedChannel,
  provenance: Provenance,
  isDm: boolean,
): EffectiveField[] {
  const fields: EffectiveField[] = [];
  const src = (isSet: boolean, key: keyof Provenance): string =>
    fieldSource(provenance[key], isSet, "default");

  if (channel.trigger !== undefined) {
    fields.push({
      label: "trigger.when",
      value: formatWhen(channel.trigger.when),
      source: src(true, "trigger"),
    });
    if (channel.trigger.allowBots !== undefined) {
      fields.push({
        label: "trigger.allowBots",
        value: String(channel.trigger.allowBots),
        source: src(true, "trigger"),
      });
    }
  } else {
    fields.push({
      label: "trigger.when",
      value: isDm ? "disabled" : "mention",
      source: "code default",
    });
  }
  fields.push({
    label: "trigger.whileRunning",
    value: channel.trigger?.whileRunning ?? "passthrough",
    source: src(channel.trigger?.whileRunning !== undefined, "trigger"),
  });

  const policy = resolveSessionPolicy(channel, isDm);
  fields.push({
    label: "session.mode",
    value: policy.sessionMode,
    source: src(channel.session?.mode !== undefined, "session"),
  });
  if (channel.session?.affinity?.scope !== undefined) {
    fields.push({
      label: "session.affinity.scope",
      value: channel.session.affinity.scope,
      source: src(true, "session"),
    });
  }
  if (channel.session?.affinity?.windowSec !== undefined) {
    fields.push({
      label: "session.affinity.windowSec",
      value: String(channel.session.affinity.windowSec),
      source: src(true, "session"),
    });
  }
  if (channel.session?.affinity?.debounceSec !== undefined) {
    fields.push({
      label: "session.affinity.debounceSec",
      value: String(channel.session.affinity.debounceSec),
      source: src(true, "session"),
    });
  }
  if (channel.session?.idleResetMinutes !== undefined) {
    fields.push({
      label: "session.idleResetMinutes",
      value: String(channel.session.idleResetMinutes),
      source: src(true, "session"),
    });
  }
  if (channel.session?.maxTranscriptKb !== undefined) {
    fields.push({
      label: "session.maxTranscriptKb",
      value: String(channel.session.maxTranscriptKb),
      source: src(true, "session"),
    });
  }
  fields.push({
    label: "reply.mode",
    value: policy.replyMode,
    source: src(channel.reply?.mode !== undefined, "reply"),
  });

  return fields;
}

/** [agent] セクションの表示用フィールド一覧 (config.md §1.3 の全フィールド)。 */
function buildAgentFields(
  agent: AgentConfig,
  provenance: AgentProvenance,
): EffectiveField[] {
  const fields: EffectiveField[] = [];
  const src = (isSet: boolean, key: keyof AgentConfig): string =>
    fieldSource(provenance[key], isSet, "default agent");

  fields.push(
    agent.model !== undefined
      ? { label: "model", value: agent.model, source: src(true, "model") }
      : { label: "model", value: "(pi default)", source: "code default" },
  );
  if (agent.systemPrompt !== undefined) {
    fields.push({
      label: "systemPrompt",
      value: summarizeTextRef(agent.systemPrompt),
      source: src(true, "systemPrompt"),
    });
  }
  if (agent.context !== undefined && agent.context.length > 0) {
    fields.push({
      label: "context",
      value: `[${agent.context.map(summarizeTextRef).join(", ")}]`,
      source: src(true, "context"),
    });
  }
  if (agent.tools !== undefined) {
    fields.push({
      label: "tools",
      value: `[${agent.tools.join(", ")}]`,
      source: src(true, "tools"),
    });
  }
  if (agent.excludeTools !== undefined) {
    fields.push({
      label: "excludeTools",
      value: `[${agent.excludeTools.join(", ")}]`,
      source: src(true, "excludeTools"),
    });
  }
  if (agent.skills !== undefined) {
    fields.push({
      label: "skills",
      value: `[${agent.skills.join(", ")}]`,
      source: src(true, "skills"),
    });
  }
  if (agent.extensions !== undefined) {
    fields.push({
      label: "extensions",
      value: `[${agent.extensions.join(", ")}]`,
      source: src(true, "extensions"),
    });
  }
  fields.push({
    label: "memory",
    value: agent.memory !== undefined ? String(agent.memory) : "true",
    source: src(agent.memory !== undefined, "memory"),
  });
  if (agent.env !== undefined) {
    // agent.env の値は ${env.X} 参照を解決しないまま表示する (config.md §2.1)。
    fields.push({
      label: "env",
      value: `{${Object.entries(agent.env)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}}`,
      source: src(true, "env"),
    });
  }

  return fields;
}

/** pretty 出力の左カラム幅 (config.md §5 の出力例に倣い、揃えて読みやすくする)。 */
function padLabel(label: string, width: number): string {
  return `${label}:`.padEnd(width + 1);
}

function formatSection(
  title: string,
  fields: EffectiveField[],
  width: number,
): string[] {
  const lines = [title];
  for (const field of fields) {
    lines.push(
      `${padLabel(field.label, width)} ${field.value}  ← ${field.source}`,
    );
  }
  return lines;
}

function formatPretty(
  channelId: string,
  isDm: boolean,
  channel: ResolvedChannel,
  provenance: Provenance,
  agentProvenance: AgentProvenance,
): string {
  const channelFields = buildChannelFields(channel, provenance, isDm);
  const agentFields = buildAgentFields(channel.agent, agentProvenance);
  const width = Math.max(
    ...[...channelFields, ...agentFields].map((f) => f.label.length),
  );
  return [
    `channel: ${channelId}${isDm ? " (dm)" : ""}`,
    "",
    ...formatSection("[channel]", channelFields, width),
    "",
    ...formatSection("[agent]", agentFields, width),
  ].join("\n");
}

interface JsonField {
  value: unknown;
  source: string;
}

function formatJson(
  channelId: string,
  isDm: boolean,
  channel: ResolvedChannel,
  provenance: Provenance,
  agentProvenance: AgentProvenance,
): string {
  const policy = resolveSessionPolicy(channel, isDm);
  const src = (isSet: boolean, key: keyof Provenance): string =>
    fieldSource(provenance[key], isSet, "default");
  const asrc = (isSet: boolean, key: keyof AgentConfig): string =>
    fieldSource(agentProvenance[key], isSet, "default agent");

  const agent = channel.agent;
  const channelFields: Record<string, JsonField> = {
    "trigger.allowBots": {
      value: channel.trigger?.allowBots ?? null,
      source: src(channel.trigger?.allowBots !== undefined, "trigger"),
    },
    "trigger.whileRunning": {
      value: channel.trigger?.whileRunning ?? null,
      source: src(channel.trigger?.whileRunning !== undefined, "trigger"),
    },
    "session.mode": {
      value: policy.sessionMode,
      source: src(channel.session?.mode !== undefined, "session"),
    },
    "session.affinity.scope": {
      value: channel.session?.affinity?.scope ?? null,
      source: src(channel.session?.affinity?.scope !== undefined, "session"),
    },
    "session.affinity.windowSec": {
      value: channel.session?.affinity?.windowSec ?? null,
      source: src(
        channel.session?.affinity?.windowSec !== undefined,
        "session",
      ),
    },
    "session.affinity.debounceSec": {
      value: channel.session?.affinity?.debounceSec ?? null,
      source: src(
        channel.session?.affinity?.debounceSec !== undefined,
        "session",
      ),
    },
    "session.idleResetMinutes": {
      value: channel.session?.idleResetMinutes ?? null,
      source: src(channel.session?.idleResetMinutes !== undefined, "session"),
    },
    "session.maxTranscriptKb": {
      value: channel.session?.maxTranscriptKb ?? null,
      source: src(channel.session?.maxTranscriptKb !== undefined, "session"),
    },
    "reply.mode": {
      value: policy.replyMode,
      source: src(channel.reply?.mode !== undefined, "reply"),
    },
  };

  const agentFields: Record<string, JsonField> = {
    model: {
      value: agent.model ?? null,
      source: asrc(agent.model !== undefined, "model"),
    },
    systemPrompt: {
      value: agent.systemPrompt ?? null,
      source: asrc(agent.systemPrompt !== undefined, "systemPrompt"),
    },
    context: {
      value: agent.context ?? null,
      source: asrc(agent.context !== undefined, "context"),
    },
    tools: {
      value: agent.tools ?? null,
      source: asrc(agent.tools !== undefined, "tools"),
    },
    excludeTools: {
      value: agent.excludeTools ?? null,
      source: asrc(agent.excludeTools !== undefined, "excludeTools"),
    },
    skills: {
      value: agent.skills ?? null,
      source: asrc(agent.skills !== undefined, "skills"),
    },
    extensions: {
      value: agent.extensions ?? null,
      source: asrc(agent.extensions !== undefined, "extensions"),
    },
    memory: {
      value: agent.memory ?? null,
      source: asrc(agent.memory !== undefined, "memory"),
    },
    // 値は ${env.X} 未解決のまま (config.md §2.1)。
    env: {
      value: agent.env ?? null,
      source: asrc(agent.env !== undefined, "env"),
    },
  };

  const payload = {
    channel: channelId,
    isDm,
    channelFields,
    agentFields,
    when: channel.trigger?.when ?? null,
  };
  return JSON.stringify(payload, null, 2);
}

/** channelId の実効設定 (Channel 部分 2 段 + Agent 部分 3 段のマージ結果) を
 * provenance 付きで整形する (config.md §5)。resolveChannelConfig が null を返す
 * ケース (DM で dm エントリが無い等) はコード既定 (DM は disabled) の注記を出す。 */
export function formatEffectiveConfig(
  file: ChannelsFile,
  channelId: string,
  opts: { json: boolean; defaultAgent?: AgentConfig },
): string {
  const isDm = channelId === DM_CHANNEL;
  const resolved = resolveChannelConfig(file, channelId, opts.defaultAgent);

  if (resolved === null) {
    if (opts.json) {
      return JSON.stringify(
        {
          channel: channelId,
          isDm,
          codeDefault: true,
          note: "no entry; falls back to code default (mention trigger, or disabled for dm)",
        },
        null,
        2,
      );
    }
    return [
      `channel: ${channelId}${isDm ? " (dm)" : ""}`,
      `  (no "${isDm ? DM_CHANNEL : DEFAULT_CHANNEL}" entry; falls back to code default: ${isDm ? "disabled" : "mention trigger"})`,
    ].join("\n");
  }

  const { channel, provenance, agentProvenance } = resolved;
  return opts.json
    ? formatJson(channelId, isDm, channel, provenance, agentProvenance)
    : formatPretty(channelId, isDm, channel, provenance, agentProvenance);
}
