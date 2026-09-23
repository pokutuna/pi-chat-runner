// テスト専用の ConfigSource — YAML の agent / channels ブロックを TS オブジェクトで
// 直に渡す。
//
// 本番のローダー実装は FileConfigSource 1 つだけ (docs/design/config.md §3) なので、
// これは src/ には置かない。e2e の各シナリオが「そのシナリオだけの channels」を
// ファイルを増やさずに持てるようにするためのもの。
//
// マージ規則は resolveChannelConfig (src/config/config-source.ts) をそのまま呼んで
// 共有する — 2 段 (Channel 部分) / 3 段 (Agent 部分) の意味が FileConfigSource と
// ずれないようにするため。systemPrompt / context のファイル参照インライン化と
// skills / extensions の絶対パス化は FileConfigSource 側の責務で、ここでは行わない
// (e2e の設定は値を直接書くので相対パス参照を使わない)。

import type { AgentConfig } from "../../../src/config/agent-config.js";
import type { ChannelEntry } from "../../../src/config/channel-config.js";
import { ChannelsFileSchema } from "../../../src/config/channel-config.js";
import type {
  ConfigSource,
  ResolvedChannel,
} from "../../../src/config/config-source.js";
import { resolveChannelConfig } from "../../../src/config/config-source.js";

export interface StaticConfig {
  /** YAML のトップレベル `agent` ブロック相当 (全 Channel 共通の既定)。 */
  agent?: AgentConfig;
  /** YAML の `channels` ブロック相当。"default" エントリは必須。 */
  channels: ChannelEntry[];
}

export class StaticConfigSource implements ConfigSource {
  private readonly file;
  private readonly defaultAgent: AgentConfig;

  constructor(config: StaticConfig) {
    // YAML 経由と同じ strict 検証を通す — テスト側の設定ミスを起動時に落とす。
    this.file = ChannelsFileSchema.parse({ channels: config.channels });
    this.defaultAgent = config.agent ?? {};
  }

  channel(id: string): Promise<ResolvedChannel | null> {
    const resolved = resolveChannelConfig(this.file, id, this.defaultAgent);
    return Promise.resolve(resolved?.channel ?? null);
  }
}
