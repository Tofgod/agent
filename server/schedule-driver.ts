import type { Schedules } from "../lib/studio/schedules";
import type { SQLiteDatabase } from "./storage";

export function startScheduleDriver(database: SQLiteDatabase, schedules: Schedules, onError: (error: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const refresh = (retryAfter = 0) => {
    if (stopped || running) return;
    clearTimeout(timer);
    try {
      const next = schedules.nextWakeAt();
      if (next === null) return;
      arm(Math.max(next, retryAfter));
    } catch (error) {
      onError(error);
      arm(Date.now() + 1000);
    }
  };
  function arm(at: number) {
    timer = setTimeout(() => {
      const started = Date.now();
      let retryAfter = 0;
      running = schedules.runDue(started).then(() => {
        // A due occurrence that could not advance must not spin the event loop.
        const next = schedules.nextWakeAt();
        if (next !== null && next <= started) retryAfter = Date.now() + 1000;
      }).catch((error) => { onError(error); retryAfter = Date.now() + 1000; })
        .finally(() => { running = undefined; refresh(retryAfter); });
    }, Math.min(2_147_483_647, Math.max(0, at - Date.now())));
    timer.unref();
  }
  const unsubscribe = database.watchSchedules(refresh);
  refresh();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    await running;
  };
}
