// 公開面 — 別の Slack app 実装から `import "pi-chat-runner"` してライブラリ利用するための
// エントリポイント (docs/design/config.md §6)。副作用なしの re-export のみ。
//
// server.ts (CLI/bin) はこのファイルを経由せず直接内部モジュールを import する。

export { type BridgeOptions, startBridge } from "./bridge.js";
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
export { SocketEventSource } from "./ingress/event-source.js";
export {
	HttpEventSource,
	type HttpEventSourceOptions,
} from "./ingress/http-event-source.js";
// 自前 EventSource を書く利用者向け: raw Slack event → ChatEvent の正規化 codec
// (mention 展開 / isDm 判定 / dedupeKey) を再実装せず使い回せるようにする
export {
	SlackIngressAdapter,
	type SlackEventEnvelope,
	type SlackMessageLikeEvent,
	type SlackRawEvent,
	type SlackReactionAddedEvent,
} from "./ingress/slack-adapter.js";
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
export {
	type AgentConfig,
	AgentConfigSchema,
	type CollectedPassthroughEnv,
	collectPassthroughEnv,
	loadAgentConfig,
	type ResolvedAgentConfig,
	resolveAgentConfig,
} from "./store/agent-config.js";
// 自前 ConfigSource を書く利用者向け: 戻り値の型・検証スキーマ・予約名
export {
	type ChannelDoc,
	type ChannelDocFile,
	ChannelDocFileSchema,
	ChannelDocSchema,
	type Gate,
	type Trigger,
} from "./store/channel-doc.js";
export {
	type ConfigSource,
	DEFAULT_CHANNEL,
	DM_CHANNEL,
	FileConfigSource,
} from "./store/config-source.js";
export { FirestoreStateStore } from "./store/firestore.js";
export type {
	InboxItem,
	InboxStore,
	Lease,
	LeaseStore,
	SessionDoc,
	SessionStore,
	StateStore,
} from "./store/interfaces.js";
export { InMemoryStateStore } from "./store/memory.js";
export { SqliteStateStore } from "./store/sqlite.js";
