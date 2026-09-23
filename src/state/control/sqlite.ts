// npm export エントリ `pi-chat-runner/state/control/sqlite`。
// 実体は src/state/control/backends/sqlite.ts (docs/design/state.md §4.1)。
// 公開パスを保つための re-export のみで、副作用は持たない。

export { SqliteControlState } from "./backends/sqlite.js";
