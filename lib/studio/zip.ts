const table = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array) {
  return (crcUpdate(0xffffffff, data) ^ 0xffffffff) >>> 0;
}
function crcUpdate(crc: number, data: Uint8Array) {
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc;
}
function join(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function textZip(files: { name: string; content: string }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder(), local: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name.replace(/^\/+/, "").replace(/\.\.\//g, ""));
    const body = encoder.encode(file.content), crc = crc32(body);
    const header = new Uint8Array(30), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, body.length, true); h.setUint16(26, name.length, true);
    local.push(header, name, body);
    const dir = new Uint8Array(46), d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true);
    d.setUint32(16, crc, true); d.setUint32(20, body.length, true); d.setUint32(24, body.length, true);
    d.setUint16(28, name.length, true); d.setUint32(42, offset, true);
    central.push(dir, name); offset += header.length + name.length + body.length;
  }
  const directory = join(central), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, directory.length, true); e.setUint32(16, offset, true);
  return join([...local, directory, end]) as Uint8Array<ArrayBuffer>;
}

export type ZipEntry = { name: string; open: () => Promise<ReadableStream<Uint8Array> | Uint8Array> };
/** ZIP64 stores media incrementally. Only the central-directory metadata stays in memory. */
export function streamZip(files: ZipEntry[]): ReadableStream<Uint8Array> {
  async function* entries() {
    const encoder = new TextEncoder(), directory: Uint8Array[] = [];
    let offset = BigInt(0);
    const emit = (bytes: Uint8Array) => { offset += BigInt(bytes.byteLength); return bytes; };
    for (const entry of files) {
      const start = offset, name = encoder.encode(entry.name);
      const local = new Uint8Array(30 + name.length + 20), h = new DataView(local.buffer);
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 45, true); h.setUint16(6, 0x0808, true);
      h.setUint16(12, 33, true);
      h.setUint32(18, 0xffffffff, true); h.setUint32(22, 0xffffffff, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 20, true);
      local.set(name, 30);
      h.setUint16(30 + name.length, 1, true); h.setUint16(32 + name.length, 16, true);
      yield emit(local);
      const source = await entry.open();
      let size = BigInt(0), crc = 0xffffffff;
      const record = (chunk: Uint8Array) => { size += BigInt(chunk.byteLength); crc = crcUpdate(crc, chunk); return emit(chunk); };
      if (source instanceof Uint8Array) { if (source.byteLength) yield record(source); }
      else {
        const reader = source.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (chunk.value.byteLength) yield record(chunk.value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      const crcValue = (crc ^ 0xffffffff) >>> 0, descriptor = new Uint8Array(24), dd = new DataView(descriptor.buffer);
      dd.setUint32(0, 0x08074b50, true); dd.setUint32(4, crcValue, true);
      dd.setBigUint64(8, size, true); dd.setBigUint64(16, size, true);
      yield emit(descriptor);
      const central = new Uint8Array(46 + name.length + 28), d = new DataView(central.buffer);
      d.setUint32(0, 0x02014b50, true); d.setUint16(4, 45, true); d.setUint16(6, 45, true);
      d.setUint16(8, 0x0808, true); d.setUint16(14, 33, true); d.setUint32(16, crcValue, true);
      d.setUint32(20, 0xffffffff, true); d.setUint32(24, 0xffffffff, true); d.setUint32(42, 0xffffffff, true);
      d.setUint16(28, name.length, true); d.setUint16(30, 28, true); central.set(name, 46);
      const extra = 46 + name.length;
      d.setUint16(extra, 1, true); d.setUint16(extra + 2, 24, true);
      d.setBigUint64(extra + 4, size, true); d.setBigUint64(extra + 12, size, true); d.setBigUint64(extra + 20, start, true);
      directory.push(central);
    }
    const centralStart = offset;
    for (const part of directory) yield emit(part);
    const zip64End = offset, ending = new Uint8Array(98), e = new DataView(ending.buffer);
    e.setUint32(0, 0x06064b50, true); e.setBigUint64(4, BigInt(44), true);
    e.setUint16(12, 45, true); e.setUint16(14, 45, true);
    e.setBigUint64(24, BigInt(files.length), true); e.setBigUint64(32, BigInt(files.length), true);
    e.setBigUint64(40, zip64End - centralStart, true); e.setBigUint64(48, centralStart, true);
    e.setUint32(56, 0x07064b50, true); e.setBigUint64(64, zip64End, true); e.setUint32(72, 1, true);
    e.setUint32(76, 0x06054b50, true); e.setUint16(84, 0xffff, true); e.setUint16(86, 0xffff, true);
    e.setUint32(88, 0xffffffff, true); e.setUint32(92, 0xffffffff, true);
    yield ending;
  }
  const iterator = entries();
  return new ReadableStream({
    async pull(controller) { const item = await iterator.next(); if (item.done) controller.close(); else controller.enqueue(item.value); },
    async cancel() { await iterator.return(undefined); },
  });
}

/** Read archives produced by streamZip. Entries are indexed and never extracted to disk by name. */
export function openStudioZip(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), end = bytes.length - 98;
  const invalid = () => new Error("归档格式无效或文件不完整");
  if (end < 0 || view.getUint32(end, true) !== 0x06064b50 || view.getUint32(end + 56, true) !== 0x07064b50
      || view.getUint32(end + 76, true) !== 0x06054b50 || view.getBigUint64(end + 64, true) !== BigInt(end)) throw invalid();
  const bounded = (value: bigint) => {
    if (value > BigInt(bytes.length)) throw invalid();
    return Number(value);
  };
  const count = bounded(view.getBigUint64(end + 32, true));
  const directoryStart = bounded(view.getBigUint64(end + 48, true));
  let offset = directoryStart;
  const entries = new Map<string, { start: number; size: number; crc: number }>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (count > 20000 || offset > end) throw invalid();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50 || view.getUint16(offset + 10, true) !== 0) throw invalid();
    const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), extra = offset + 46 + nameLength;
    if (extraLength !== 28 || extra + extraLength > end || view.getUint16(extra, true) !== 1 || view.getUint16(extra + 2, true) !== 24
        || view.getUint16(offset + 32, true) !== 0) throw invalid();
    const name = decoder.decode(bytes.subarray(offset + 46, extra));
    const size = bounded(view.getBigUint64(extra + 12, true)), local = bounded(view.getBigUint64(extra + 20, true));
    if (entries.has(name) || local + 30 > directoryStart || view.getUint32(local, true) !== 0x04034b50) throw invalid();
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size + 24 > directoryStart || view.getUint32(start + size, true) !== 0x08074b50) throw invalid();
    entries.set(name, { start, size, crc: view.getUint32(offset + 16, true) });
    offset = extra + extraLength;
  }
  if (offset !== end) throw invalid();
  return {
    read(name: string) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      const data = bytes.subarray(entry.start, entry.start + entry.size);
      if (crc32(data) !== entry.crc) throw invalid();
      return data;
    },
  };
}
