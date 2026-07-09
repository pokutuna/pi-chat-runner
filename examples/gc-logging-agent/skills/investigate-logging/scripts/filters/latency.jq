[.[] | select(.httpRequest.latency != null) | {
  timestamp,
  url: .httpRequest.requestUrl,
  latency_ms: (.httpRequest.latency | rtrimstr("s") | tonumber * 1000),
  status: .httpRequest.status
}] | sort_by(-.latency_ms)
