import { z } from "zod";
import type { BlobStore } from "../lib/studio/storage";
import type { Store } from "../lib/studio/store";
import type { ProjectDisk } from "./project-disk";

export async function cleanDeletedProject(store: Store, projectId: string, media: BlobStore, disk?: ProjectDisk) {
  z.string().uuid().parse(projectId);
  // Disk reconciliation can still be finishing an import into media storage.
  await disk?.removeProject(projectId);
  await media.removeProject?.(projectId);
  store.skills?.removeProject(projectId);
  await store.db.prepare("DELETE FROM project_deletions WHERE project_id=?").bind(projectId).run();
}
