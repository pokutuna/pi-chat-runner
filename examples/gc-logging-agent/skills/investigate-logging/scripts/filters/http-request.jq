[.[] | select(.httpRequest != null) | {
  timestamp,
  method: .httpRequest.requestMethod,
  url: .httpRequest.requestUrl,
  status: .httpRequest.status,
  latency: .httpRequest.latency,
  userAgent: .httpRequest.userAgent
}]
