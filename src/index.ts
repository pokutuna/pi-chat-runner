// 公開面 — 別の Slack app 実装から `import "pi-chat-runner"` してライブラリ利用するための
// エントリポイント (docs/design/config.md §6)。副作用なしの re-export のみ。
//
// server.ts (CLI/bin) はこのファイルを経由せず直接内部モジュールを import する。

export { type BridgeOptions, startBridge } from "./bridge.js";
export type { ChatEvent } from "./ingress/chat-event.js";
export type { Ack, EventSource } from "./ingress/event-source.js";
export { SocketEventSource } from "./ingress/event-source.js";
export {
	HttpEventSource,
	type HttpEventSourceOptions,
} from "./ingress/http-event-source.js";
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
export { type ConfigSource, FileConfigSource } from "./store/config-source.js";
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
