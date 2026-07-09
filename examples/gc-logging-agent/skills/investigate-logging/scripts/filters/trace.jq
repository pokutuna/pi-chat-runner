[.[] | {
  timestamp,
  severity,
  trace,
  spanId,
  message: (.textPayload // .jsonPayload.message // .jsonPayload),
  latency: .httpRequest.latency
}] | sort_by(.timestamp)
