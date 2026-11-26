export function isMessagesRoute(baseUrl: string) {
  try { return /\/(?:anthropic(?:\/v1)?|messages)$/.test(new URL(baseUrl).pathname.replace(/\/+$/, "")); }
  catch { return false; }
}

export function messagesEndpoint(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/messages") ? base : base + (base.endsWith("/v1") ? "/messages" : "/v1/messages");
}
