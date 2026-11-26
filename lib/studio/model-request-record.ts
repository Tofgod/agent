import { createHash } from "node:crypto";

export function recordModelRequest(request: Record<string, unknown>) {
  const { system, tools, toolSettings, toolRoles, toolBindings, messages, ...metadata } = request;
  if (!Array.isArray(messages)) return { metadata: request, headerId: null, parts: new Map<string, string>() };
  const parts = new Map<string, string>();
  const retain = (value: string) => {
    const id = createHash("sha256").update(value).digest("base64url");
    parts.set(id, value);
    return id;
  };
  const headerId = retain(JSON.stringify({ system, tools, toolSettings, toolRoles, toolBindings }));
  const messageParts = messages.map((message) => {
    const content = JSON.stringify(message);
    return message !== null && typeof message === "object" && Buffer.byteLength(content) <= 48 ? message : retain(content);
  });
  return { metadata: { ...metadata, messageParts }, headerId, parts };
}

export const hydratedModelRequest = `CASE WHEN c.request_header_id IS NULL THEN c.request ELSE
  json_set(json_patch(json_remove(c.request,'$.messageParts'),h.content),'$.messages',json((
    SELECT json_group_array(json(CASE WHEN m.type='text' THEN p.content ELSE m.value END) ORDER BY CAST(m.key AS INTEGER))
    FROM json_each(c.request,'$.messageParts') m LEFT JOIN model_request_parts p ON m.type='text' AND p.id=m.value
  ))) END AS hydrated_request`;

export function restoreModelRequest({ hydrated_request, request: _metadata, request_header_id: _headerId, ...row }: Record<string, unknown>): Record<string, unknown> {
  return { ...row, request: hydrated_request };
}
