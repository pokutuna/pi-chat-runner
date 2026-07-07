// 公開面 — 別の Slack app 実装から `import "pi-chat-runner"` してライブラリ利用するための
// エントリポイント (docs/design/config.md §6)。副作用なしの re-export のみ。
//
// server.ts (CLI/bin) はこのファイルを経由せず直接内部モジュールを import する。

export { type BridgeOptions, startBridge } from "./bridge.js";
export {
	type AgentConfig,
	AgentConfigSchema,
	type CollectedPassthroughEnv,
	collectPassthroughEnv,
	loadAgentConfig,
	type ResolvedAgentConfig,
	resolveAgentConfig,
} from "./config/agent-config.js";
// 自前 ConfigSource を書く利用者向け: 戻り値の型・検証スキーマ・予約名
export {
	type ChannelDoc,
	type ChannelDocFile,
	ChannelDocFileSchema,
	ChannelDocSchema,
	type GateConfig,
	type Trigger,
} from "./config/channel-doc.js";
export {
	type ConfigSource,
	DEFAULT_CHANNEL,
	DM_CHANNEL,
	FileConfigSource,
} from "./config/config-source.js";
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
export type { Ack, EventSource } from "./ingress/event-source.js";
// 自前 EventSource を書く利用者向け: raw Slack event → ChatEvent の正規化 codec
// (mention 展開 / isDm 判定 / dedupeKey) を再実装せず使い回せるようにする
export {
	type SlackEventEnvelope,
	SlackIngressAdapter,
	type SlackMessageLikeEvent,
	type SlackRawEvent,
	type SlackReactionAddedEvent,
} from "./ingress/slack/adapter.js";
export {
	HttpEventSource,
	type HttpEventSourceOptions,
} from "./ingress/slack/http-event-source.js";
export { SocketEventSource } from "./ingress/slack/socket-event-source.js";
// 自前 EventSource を書く利用者向け: UserID → 表示名解決 (renderEvent / mention 展開の enrich)
export { SlackUserResolver } from "./ingress/slack/user-resolver.js";
export { enrichEvent, type UserResolver } from "./ingress/user-resolver.js";
export type { Logger } from "./logger.js";
export { type ReactionClient, Reactions } from "./reply/reactions.js";
export {
	type ChatPoster,
	type ReplyDestination,
	type ReplyFormatter,
	ReplyRouter,
	type ReplyRouterOptions,
} from "./reply/router.js";
export {
	type PiPermissionConfig,
	SessionRunner,
	type SessionRunnerOptions,
} from "./session/runner.js";
export { InMemoryStateStore } from "./store/state/backends/memory.js";
export type {
	InboxItem,
	InboxStore,
	Lease,
	LeaseStore,
	SessionDoc,
	SessionStore,
	StateStore,
} from "./store/state/interfaces.js";
export { CopyWorkdirStorage, type WorkdirStorage } from "./store/workdir.js";
