// 実効設定の書き出し (effective config) — docs/design/config.md §6「実効設定の書き出し」
//
// dump は解決関数をランタイムと共有する (resolveChannelConfig をそのまま呼ぶ)。
// dump 専用の別実装を持たないことで、dump と本番で結果がずれないことを保証する。
// I/O (channels.yaml の読み込み・stdout への出力) は server.ts が担い、この
// モジュールは ChannelsFile を受け取って文字列を返す純関数だけを持つ (テスト容易性)。

import { resolveSessionPolicy } from "../session/runner.js";
import type { ChannelDoc, ChannelsFile, WhenNode } from "./channel-doc.js";
import {
  DEFAULT_CHANNEL,
  DM_CHANNEL,
  type FieldSource,
  type Provenance,
  resolveChannelConfig,
} from "./config-source.js";

/** provenance の出所ラベルを人向け表記に変換する (config.md §6 の出力例:
 * `← channels.yaml #alerts` / `← default`)。 */
function sourceLabel(source: FieldSource): string {
  switch (source) {
    case "default":
      return "default";
    case "dm":
      return "dm";
    case "channel":
      return "channel";
  }
}

/** trigger.when の合成木を 1 行に整形する (config.md §6 の出力例:
 * `OR[ keyword, AND[classifier(gemini-3.1-flash-lite), classifier(code default)] ]`)。
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
    return `sender(is=${node.is})`;
  }
  return node.kind;
}

/** systemPrompt / context の値を短く要約する。resolveChannelConfig の doc は
 * ファイル参照インライン化前 (config-source.ts の FileConfigSource は dump の
 * 手前で inline 化を行わないため)、値は元の参照文字列 (`./prompts/...`) か、
 * 参照でなければ直書きテキストのどちらかが入っている。 */
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

/** フィールドの出所ラベルを解決する。doc にキー自体が無ければ (isSet === false)
 * provenance を見ずに "code default"、あれば provenance (無ければ "default") を使う。
 * pretty (buildFields) / json (formatJson) 共通の provenance 解決規則 (config.md §6)。 */
function fieldSource(
  provenance: FieldSource | undefined,
  isSet: boolean,
): string {
  return isSet ? sourceLabel(provenance ?? "default") : "code default";
}

interface EffectiveField {
  label: string;
  value: string;
  source: string;
}

/** 表示用の実効フィールド一覧を組み立てる。provenance に無いフィールドは
 * コード既定 (session/reply は resolveSessionPolicy、model は pi 既定) を注記する。 */
function buildFields(
  doc: ChannelDoc,
  provenance: Provenance,
  isDm: boolean,
): EffectiveField[] {
  const fields: EffectiveField[] = [];

  fields.push(
    doc.model !== undefined
      ? {
          label: "model",
          value: doc.model,
          source: fieldSource(provenance.model, true),
        }
      : { label: "model", value: "(pi default)", source: "code default" },
  );

  if (doc.systemPrompt !== undefined) {
    fields.push({
      label: "systemPrompt",
      value: summarizeTextRef(doc.systemPrompt),
      source: fieldSource(provenance.systemPrompt, true),
    });
  }

  if (doc.context !== undefined && doc.context.length > 0) {
    fields.push({
      label: "context",
      value: `[${doc.context.map(summarizeTextRef).join(", ")}]`,
      source: fieldSource(provenance.context, true),
    });
  }

  if (doc.trigger !== undefined) {
    fields.push({
      label: "trigger.when",
      value: formatWhen(doc.trigger.when),
      source: fieldSource(provenance.trigger, true),
    });
    if (doc.trigger.debounceSec !== undefined) {
      fields.push({
        label: "trigger.debounceSec",
        value: String(doc.trigger.debounceSec),
        source: fieldSource(provenance.trigger, true),
      });
    }
    if (doc.trigger.allowBots !== undefined) {
      fields.push({
        label: "trigger.allowBots",
        value: String(doc.trigger.allowBots),
        source: fieldSource(provenance.trigger, true),
      });
    }
  } else {
    fields.push({
      label: "trigger.when",
      value: isDm ? "passthrough" : "mention",
      source: "code default",
    });
  }

  if (doc.tools !== undefined) {
    fields.push({
      label: "tools",
      value: `[${doc.tools.join(", ")}]`,
      source: fieldSource(provenance.tools, true),
    });
  }
  if (doc.excludeTools !== undefined) {
    fields.push({
      label: "excludeTools",
      value: `[${doc.excludeTools.join(", ")}]`,
      source: fieldSource(provenance.excludeTools, true),
    });
  }
  if (doc.skills !== undefined) {
    fields.push({
      label: "skills",
      value: `[${doc.skills.join(", ")}]`,
      source: fieldSource(provenance.skills, true),
    });
  }
  if (doc.extensions !== undefined) {
    fields.push({
      label: "extensions",
      value: `[${doc.extensions.join(", ")}]`,
      source: fieldSource(provenance.extensions, true),
    });
  }

  const policy = resolveSessionPolicy(doc, isDm);
  fields.push({
    label: "session.mode",
    value: policy.sessionMode,
    source: fieldSource(provenance.session, doc.session?.mode !== undefined),
  });
  if (doc.session?.idleResetMinutes !== undefined) {
    fields.push({
      label: "session.idleResetMinutes",
      value: String(doc.session.idleResetMinutes),
      source: fieldSource(provenance.session, true),
    });
  }
  if (doc.session?.maxTranscriptKb !== undefined) {
    fields.push({
      label: "session.maxTranscriptKb",
      value: String(doc.session.maxTranscriptKb),
      source: fieldSource(provenance.session, true),
    });
  }
  fields.push({
    label: "reply.mode",
    value: policy.replyMode,
    source: fieldSource(provenance.reply, doc.reply?.mode !== undefined),
  });

  return fields;
}

/** pretty 出力の左カラム幅 (config.md §6 の出力例に倣い、揃えて読みやすくする)。 */
function padLabel(label: string, width: number): string {
  return `${label}:`.padEnd(width + 1);
}

function formatPretty(
  channelId: string,
  isDm: boolean,
  doc: ChannelDoc,
  provenance: Provenance,
): string {
  const fields = buildFields(doc, provenance, isDm);
  const width = Math.max(...fields.map((f) => f.label.length));
  const lines = [`channel: ${channelId}${isDm ? " (dm)" : ""}`];
  for (const field of fields) {
    lines.push(
      `${padLabel(field.label, width)} ${field.value}  ← ${field.source}`,
    );
  }
  return lines.join("\n");
}

interface JsonField {
  value: unknown;
  source: string;
}

function formatJson(
  channelId: string,
  isDm: boolean,
  doc: ChannelDoc,
  provenance: Provenance,
): string {
  const policy = resolveSessionPolicy(doc, isDm);
  const fields: Record<string, JsonField> = {
    model: {
      value: doc.model ?? null,
      source: fieldSource(provenance.model, doc.model !== undefined),
    },
    systemPrompt: {
      value: doc.systemPrompt ?? null,
      source: fieldSource(
        provenance.systemPrompt,
        doc.systemPrompt !== undefined,
      ),
    },
    context: {
      value: doc.context ?? null,
      source: fieldSource(provenance.context, doc.context !== undefined),
    },
    tools: {
      value: doc.tools ?? null,
      source: fieldSource(provenance.tools, doc.tools !== undefined),
    },
    excludeTools: {
      value: doc.excludeTools ?? null,
      source: fieldSource(
        provenance.excludeTools,
        doc.excludeTools !== undefined,
      ),
    },
    "session.mode": {
      value: policy.sessionMode,
      source: fieldSource(provenance.session, doc.session?.mode !== undefined),
    },
    "session.idleResetMinutes": {
      value: doc.session?.idleResetMinutes ?? null,
      source: fieldSource(
        provenance.session,
        doc.session?.idleResetMinutes !== undefined,
      ),
    },
    "session.maxTranscriptKb": {
      value: doc.session?.maxTranscriptKb ?? null,
      source: fieldSource(
        provenance.session,
        doc.session?.maxTranscriptKb !== undefined,
      ),
    },
    "reply.mode": {
      value: policy.replyMode,
      source: fieldSource(provenance.reply, doc.reply?.mode !== undefined),
    },
    "trigger.debounceSec": {
      value: doc.trigger?.debounceSec ?? null,
      source: fieldSource(
        provenance.trigger,
        doc.trigger?.debounceSec !== undefined,
      ),
    },
    "trigger.allowBots": {
      value: doc.trigger?.allowBots ?? null,
      source: fieldSource(
        provenance.trigger,
        doc.trigger?.allowBots !== undefined,
      ),
    },
  };

  const payload = {
    channel: channelId,
    isDm,
    fields,
    when: doc.trigger?.when ?? null,
  };
  return JSON.stringify(payload, null, 2);
}

/** channelId の実効設定 (default/dm + channel をマージした ChannelDoc) を
 * provenance 付きで整形する (config.md §6)。resolveChannelConfig が null を返す
 * ケース (DM で dm エントリが無い等) は passthrough 相当の注記を出す。 */
export function formatEffectiveConfig(
  file: ChannelsFile,
  channelId: string,
  opts: { json: boolean },
): string {
  const isDm = channelId === DM_CHANNEL;
  const resolved = resolveChannelConfig(file, channelId);

  if (resolved === null) {
    if (opts.json) {
      return JSON.stringify(
        {
          channel: channelId,
          isDm,
          passthrough: true,
          note: "no entry; falls back to code default (mention trigger, or passthrough for dm)",
        },
        null,
        2,
      );
    }
    return [
      `channel: ${channelId}${isDm ? " (dm)" : ""}`,
      `  (no "${isDm ? DM_CHANNEL : DEFAULT_CHANNEL}" entry; passthrough — falls back to code default)`,
    ].join("\n");
  }

  const { doc, provenance } = resolved;
  return opts.json
    ? formatJson(channelId, isDm, doc, provenance)
    : formatPretty(channelId, isDm, doc, provenance);
}
