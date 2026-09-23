// npm export エントリ `pi-chat-runner/state/control/firestore`。
// 実体は src/state/control/backends/firestore.ts (docs/design/state.md §4.2)。
// 公開パスを保つための re-export のみで、副作用は持たない。

export {
  FirestoreControlState,
  type FirestoreControlStateOptions,
} from "./backends/firestore.js";
