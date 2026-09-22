// 公開面 — 別の Slack app 実装から `import "pi-chat-runner"` してライブラリ利用するための
// エントリポイント (docs/design/config.md §3)。副作用なしの re-export のみ。
//
// server.ts (CLI/bin) はこのファイルを経由せず直接内部モジュールを import する。

export { type BridgeOptions, startBridge } from "./bridge.js";
export { type AgentConfig, AgentConfigSchema } from "./config/agent-config.js";
// 自前 ConfigSource を書く利用者向け: 戻り値の型・検証スキーマ・予約名
export {
  type ChannelConfig,
  ChannelConfigSchema,
  type ChannelEntry,
  ChannelEntrySchema,
  type ChannelsFile,
  ChannelsFileSchema,
  type GateConfig,
  type Trigger,
  type WhenNode,
} from "./config/channel-config.js";
export {
  type AgentProvenance,
  type ChannelPart,
  type ConfigSource,
  DEFAULT_CHANNEL,
  DM_CHANNEL,
  type FieldSource,
  FileConfigSource,
  loadChannelConfigFile,
  mergeAgentConfig,
  mergeChannelPart,
  type Provenance,
  type ResolvedChannel,
  resolveChannelConfig,
} from "./config/config-source.js";
export {
  loadSystemConfig,
  type ResolvedRuntimeConfig,
  type ResolvedSystemConfig,
  resolveSystemConfig,
  type SlackChatConfig,
  type SystemConfig,
  SystemConfigSchema,
} from "./config/system-config.js";
export { toMrkdwn } from "./egress/mrkdwn.js";
export {
  type ReactionClient,
  SlackTurnReactor,
} from "./egress/slack/turn-reactor.js";
export { type ReactionState, type TurnReactor } from "./egress/turn-reactor.js";
export {
  type ChatPoster,
  type EgressDestination,
  type EgressFormatter,
  EgressRouter,
  type EgressRouterOptions,
} from "./egress/router.js";
export type {
  Attachment,
  ChatEvent,
  ConversationRef,
  InboundMessage,
  MessageEdited,
  ReactionEvent,
  Sender,
  SystemEvent,
} from "./ingress/chat-event.js";
export type { Ack, Ingress } from "./ingress/ingress.js";
// 自前 Ingress を書く利用者向け: raw Slack event → ChatEvent の正規化 codec
// (mention 展開 / isDm 判定 / dedupeKey) を再実装せず使い回せるようにする
export {
  type SlackEventEnvelope,
  SlackIngressAdapter,
  type SlackMessageLikeEvent,
  type SlackRawEvent,
  type SlackReactionAddedEvent,
} from "./ingress/slack/adapter.js";
export {
  HttpIngress,
  type HttpIngressOptions,
} from "./ingress/slack/http-ingress.js";
export { SocketIngress } from "./ingress/slack/socket-ingress.js";
// 自前 Ingress を書く利用者向け: UserID → 表示名解決 (renderEvent / mention 展開の enrich)
export { SlackUserResolver } from "./ingress/slack/user-resolver.js";
export { enrichEvent, type UserResolver } from "./ingress/user-resolver.js";
export type { Logger } from "./logger.js";
export { SessionRunner, type SessionRunnerOptions } from "./session/runner.js";
export type { PiPermissionConfig } from "./session/spawn.js";
export { CopyWorkdirStore } from "./state/agent/copy.js";
export type { SharedStore, WorkdirStore } from "./state/agent/interfaces.js";
export { InMemoryControlState } from "./state/control/backends/memory.js";
export type {
  ChannelLatestSession,
  ChannelStateDoc,
  ChannelStateStore,
  ControlState,
  InboxItem,
  InboxStore,
  Lease,
  LeaseStore,
  SessionRecord,
  SessionStore,
  ThreadStore,
} from "./state/control/interfaces.js";
