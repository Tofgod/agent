import type { Store } from "./store";
import { assertCurrent } from "./engine";
import { AppError } from "./security";
import type { Project, Run } from "./types";
import { compositionOutput } from "./media-specs";

export async function compositionPlan(store: Store, project: Project, run: Run) {
  await assertCurrent(store, run);
  const files = await store.artifacts(project.id);
  const { composition, operation } = run.payload;
  if (!composition || operation?.name !== "compose_video")
    throw new AppError("缺少明确的视频片段清单，请从项目素材重新发起合成", 409, "MISSING_COMPOSITION");
  const previous = files.find((file) => file.path === operation.path);
  if (previous?.locked) throw new AppError("成片已锁定，请先解锁", 409, "ARTIFACT_LOCKED");
  const shots = composition.shots.map((shot) => {
    const video = files.find((file) => file.id === shot.videoId && ["video", "final"].includes(file.kind) && file.status === "ready" && file.url);
    const audio = shot.audioId ? files.find((file) => file.id === shot.audioId && file.kind === "audio" && file.status === "ready" && file.url) : null;
    if (!video || shot.audioId && !audio) throw new AppError("缺少可用的视频或音频片段，请重新选择", 409, "MISSING_VIDEO");
    return {
      id: shot.id,
      duration: shot.duration,
      dialogue: shot.dialogue,
      video: "/api/worker/media/" + video.id + "?version=" + video.version,
      audio: audio ? "/api/worker/media/" + audio.id + "?version=" + audio.version : null,
    };
  });
  return {
    project: { ...project, ratio: composition.ratio }, output: compositionOutput(composition), shots, leaseToken: run.leaseToken,
    previousVersion: previous?.version ?? 0, previousArtifactId: previous?.id,
  };
}
