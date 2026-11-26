import { createHmac } from "node:crypto";
import { fetchWithoutRedirect } from "./http";
import { messagesEndpoint } from "./deepseek-messages";
import type { Database } from "./storage";

export const FILES_BETA = "files-api-2025-04-14";
const fileLifetimeSeconds = 24 * 60 * 60;
const refreshMarginMs = 5 * 60 * 1000;
const inFlight = new WeakMap<Database, Map<string, Promise<string | undefined>>>();

export async function providerImageFile(database: Database, endpoint: string, apiKey: string, dataUrl: string, signal?: AbortSignal) {
  const data = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
  if (!data) return;
  signal?.throwIfAborted();
  const filesUrl = messagesEndpoint(endpoint).replace(/\/messages$/, "/files");
  const key = createHmac("sha256", apiKey).update(filesUrl).update("\0").update(dataUrl).digest("hex");
  const [cached] = database.prepare("SELECT file_id FROM provider_files WHERE key=? AND expires_at>?")
    .bind(key, Date.now() + refreshMarginMs).rows<{ file_id: string }>();
  if (cached) return { key, id: cached.file_id };
  const uploads = inFlight.get(database) ?? new Map<string, Promise<string | undefined>>();
  inFlight.set(database, uploads);
  let pending = uploads.get(key);
  if (!pending) {
    pending = (async () => {
      const content = Uint8Array.from(Buffer.from(data[2], "base64"));
      const form = new FormData();
      form.set("expires_after[anchor]", "created_at");
      form.set("expires_after[seconds]", String(fileLifetimeSeconds));
      form.set("file", new Blob([content], { type: data[1] }),
        "image." + data[1].slice("image/".length));
      const response = await fetchWithoutRedirect(filesUrl, { method: "POST", body: form, signal: AbortSignal.timeout(15_000),
        headers: { Authorization: "Bearer " + apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": FILES_BETA } });
      if (!response.ok) { await response.body?.cancel(); return; }
      const file = await response.json() as { id?: unknown; type?: string; created_at?: string; size_bytes?: number };
      if (typeof file.id !== "string" || file.type !== "file" || !file.id.length || file.id.length > 256 || file.size_bytes !== content.byteLength) return;
      const expiresAt = Date.parse(file.created_at ?? "") + fileLifetimeSeconds * 1000;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() + refreshMarginMs) return;
      await database.prepare(`INSERT INTO provider_files(key,file_id,expires_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET file_id=excluded.file_id,expires_at=excluded.expires_at`)
        .bind(key, file.id, expiresAt).run();
      return file.id;
    })().catch(() => undefined).finally(() => uploads.delete(key));
    uploads.set(key, pending);
  }
  const id = await pending;
  signal?.throwIfAborted();
  return id ? { key, id } : undefined;
}
