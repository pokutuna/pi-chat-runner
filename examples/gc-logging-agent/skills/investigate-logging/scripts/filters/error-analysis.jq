[.[] | {
  timestamp,
  severity,
  message: (.textPayload // .jsonPayload.message // .jsonPayload),
  stack: .jsonPayload.stack_trace,
  trace,
  spanId
}]
