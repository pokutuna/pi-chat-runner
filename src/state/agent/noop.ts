// 境界退避を行わない WorkdirStore (docs/design/state.md §8)。
//
// Workdir の棚が未設定のときの既定。restore は常に false、flush は何もしない —
// Session はプロセスが生きている間だけ文脈を保つ。Shared には対応する「何もしない
// 実装」を置かない (無効時は Runtime が Shared の配線を丸ごと省くため)。

import type { WorkdirStore } from "./interfaces.js";

export class NoopWorkdirStore implements WorkdirStore {
  async restore(_sessionKey: string, _workdir: string): Promise<boolean> {
    return false;
  }
  async flush(_sessionKey: string, _workdir: string): Promise<void> {}
}
