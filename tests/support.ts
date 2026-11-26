import { Store } from "../lib/studio/store";
import { SQLiteDatabase } from "../server/storage";
export function fixture() {
  const database = new SQLiteDatabase(":memory:"); database.initialize("drizzle");
  return new Store(database);
}
