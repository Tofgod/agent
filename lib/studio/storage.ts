export interface SqlResult<T = Record<string, unknown>> { success: boolean; results: T[]; meta: { changes: number; last_row_id?: number } }
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  rows<T = Record<string, unknown>>(): T[];
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult>;
}
export interface Database {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
  read<T>(projection: () => T): T;
}
export interface MediaObject {
  size: number; body: ReadableStream<Uint8Array>; contentType: string; etag: string;
  range?: { offset: number; length: number };
  writeHeaders(headers: Headers): void;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface BlobStore {
  get(key: string, options?: { range: Headers }): Promise<MediaObject | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  remove?(key: string): Promise<void>;
}
