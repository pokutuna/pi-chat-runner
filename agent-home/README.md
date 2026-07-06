# agent-home

base image の `/home/agent` (pi の HOME、uid/gid 1001) に焼き込むディレクトリ。
Dockerfile が `COPY --chown=1001:1001 agent-home/ /home/agent/` でそのまま
コピーする。JSON にはコメントが書けないため、各設定の理由をここにまとめる。

## `.pi/agent/settings.json`

pi の設定は `~/.pi/agent/settings.json` (global) と `.pi/settings.json`
(project) の 2 層 (docs/research/pi-config.md)。ここに置くのは runner の設計が
依存する挙動のピン留めだけの最小構成。

| キー | 値 | 理由 |
|---|---|---|
| `steeringMode` | `"one-at-a-time"` | pi の既定と同じ。inbox 配達 ([session-runtime.md](../docs/design/session-runtime.md) §4) が steer/follow_up の 2 段キューの挙動に依存しているため、既定変更に備えて明示的にピン留めする |
| `followUpMode` | `"one-at-a-time"` | 同上 |
| `compaction.enabled` | `true` | pi の既定と同じ。auto-compaction に任せる設計 (docs/research/pi-config.md 含意 1) をそのまま反映する |
| `enableInstallTelemetry` | `false` | spawn 時に常時付与する `--offline` (src/session/runtime.ts) と二重の保険。`--offline` が外れても telemetry だけは黙らせる |

## 利用側イメージでの上書き

利用側は `FROM` 1 段でこのファイルを自由に上書きできる:

```dockerfile
FROM ghcr.io/<org>/<base-image>:latest
COPY --chown=1001:1001 my-settings.json /home/agent/.pi/agent/settings.json
```

`docs/design/session-runtime.md` §5 の skill/extension と同じ「固定パスに
置けば効く」規約。COPY はファイル単位の置き換えなので、このファイルの既定と
merge はされない — 残したいキーは自分の settings.json にも書き写すこと。
