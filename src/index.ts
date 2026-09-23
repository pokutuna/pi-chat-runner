// 公開面 — 別の Slack app 実装から `import "pi-chat-runner"` してライブラリ利用するための
// エントリポイント (docs/design/config.md §3)。副作用なしの re-export のみ。
//
// server.ts (CLI/bin) はこのファイルを経由せず直接内部モジュールを import する。

export { createLocalChat } from "./chat/local/local-chat.js";
export { createLocalPlatform } from "./chat/local/platform.js";
export type { LocalChat, LocalChatOptions } from "./chat/local/types.js";
export type { ChatPlatform } from "./chat/platform.js";
export {
  createSlackPlatform,
  createSlackWebClient,
  type SlackPlatformOptions,
} from "./chat/slack.js";
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
  type LoadSystemConfigOptions,
  type ResolvedRuntimeConfig,
  type ResolvedSystemConfig,
  resolveSystemConfig,
  type SlackChatConfig,
  type SystemConfig,
  SystemConfigSchema,
} from "./config/system-config.js";
export { Dispatcher, type DispatcherOptions } from "./dispatch/dispatcher.js";
export {
  EmojiTurnReactor,
  type ReactionClient,
  type StateEmojiMap,
} from "./egress/emoji-turn-reactor.js";
export { toMrkdwn } from "./egress/mrkdwn.js";
export { type ReactionState, type TurnReactor } from "./egress/turn-reactor.js";
export {
  type ChatPoster,
  type EgressDestination,
  type EgressFormatter,
  EgressRouter,
  type EgressRouterOptions,
} from "./egress/router.js";
export {
  type FetchedMessage,
  type FetchMessage,
  GateEvaluator,
  type GateEvaluatorOptions,
  type GateOutcome,
  type GateRequest,
} from "./gate/evaluate.js";
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
// 自前 ChatPlatform を書く利用者向け: ack → kind フィルタ → isSelf 除外 → enrich の
// 共通ステージ (ingress-egress.md §3)
export {
  type IngressPipelineOptions,
  type IngressSink,
  startIngressPipeline,
} from "./ingress/pipeline.js";
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
export { type RunnerOptions, startRunner } from "./runner.js";
export type { PiPermissionConfig, RuntimeConfig } from "./runtime/config.js";
export { createRuntimeConfig } from "./runtime/resolve.js";
export {
  Session,
  type SessionContext,
  type SessionObserver,
  type SessionOptions,
} from "./session/session.js";
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
