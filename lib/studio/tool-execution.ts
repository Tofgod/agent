import { ZodError } from "zod";
import { watchExecution } from "./run-execution";
import { AppError, safeError } from "./security";
import type { Store } from "./store";
import type { PreparedToolCall, ToolOutcome, ToolRegistry } from "./tool-registry";
import type { Run } from "./types";
import { toolAborted, toolOutcomeUnknown } from "./tool-history";

function toolFailure(error: unknown) {
  if (error instanceof ZodError) {
    const fields = [...new Set(error.issues.map(({ path }) => path.join(".")).filter(Boolean))].slice(0, 8);
    return { result: { error: fields.length ? "请检查工具参数 " + fields.join("、") : "请检查工具参数格式", code: "INVALID_ARGS" } };
  }
  return { result: { error: safeError(error), code: error instanceof AppError ? error.code : "TOOL_ERROR" } };
}

export async function executeToolGroup(store: Store, run: Run, registry: ToolRegistry, calls: PreparedToolCall[],
  ensureCurrent: () => Promise<void>, parallel: boolean, step: { requestId?: string; index: number }) {
  const execution = watchExecution(store, run);
  const project = async (call: PreparedToolCall, outcome: ToolOutcome) => {
    try { return await registry.projectToolResult(call, outcome, execution.signal); }
    catch (error) { execution.check(); return toolFailure(error); }
  };
  const admit = async (prepared: PreparedToolCall, index: number) => {
    const { call } = prepared;
    await ensureCurrent();
    execution.check();
    const settled = await store.settledToolOutput(run.id, call.id);
    if (settled) return async (): Promise<ToolOutcome> => settled;
    const cached = await store.toolReceipt(run.id, call.id);
    await store.beginStep(run, call, step.requestId, step.index + index);
    if (cached || store.toolStepDispatched(run.id, call.id))
      return async (): Promise<ToolOutcome> => cached && cached.result.status !== "pending"
        ? parallel ? cached : project(prepared, cached) : { result: toolOutcomeUnknown };
    return async (): Promise<ToolOutcome> => {
      execution.check();
      let dispatched = false;
      try {
        const outcome = await registry.execute(prepared, execution.signal, async () => {
          await store.dispatchStep(run, call.id);
          dispatched = true;
        });
        if (!parallel && "result" in outcome && (outcome.concludesTurn || outcome.additionalContexts?.length))
          await store.commitReadReceipt(run, call.id, outcome.result, outcome);
        if (parallel || !("result" in outcome)) return outcome;
        return project(prepared, outcome);
      } catch (error) {
        if (dispatched && execution.signal.aborted && (error === execution.signal.reason || error instanceof Error && error.name === "AbortError"))
          await store.commitReadReceipt(run, call.id, toolAborted).catch(() => {});
        if (execution.signal.aborted && error instanceof Error && !(error instanceof AppError) &&
          (error === execution.signal.reason || error.name === "AbortError")) throw execution.signal.reason;
        if (error instanceof AppError && ["RUN_STOPPED", "AGENT_STEER"].includes(error.code)) throw error;
        const failure = toolFailure(error);
        if (parallel || !dispatched && !["UNKNOWN_TOOL", "TOOL_DENIED", "TOOL_CANCELLED"].includes(failure.result.code)) return failure;
        return project(prepared, failure);
      }
    };
  };
  try {
    if (!parallel || !registry.isParallel(calls[0])) return [await (await admit(calls[0], 0))()];
    type Slot = { index: number; outcome: ToolOutcome } | { index: number; error: unknown };
    const outcomes: ToolOutcome[] = [];
    const inFlight = new Map<number, Promise<Slot>>(), buffered = new Map<number, Slot>();
    let next = 0, committed = 0, failure: { error: unknown } | undefined;
    const fillPool = async () => {
      while (!failure && !execution.signal.aborted && next < calls.length && inFlight.size < store.maxParallelTools) {
        const prepared = calls[next], index = next;
        if (index && !registry.isParallel(prepared)) break;
        try {
          const dispatch = await admit(prepared, index);
          inFlight.set(index, dispatch().then((outcome) => ({ index, outcome }), (error: unknown) => {
            failure ??= { error };
            return { index, error };
          }));
          next++;
        } catch (error) { failure ??= { error }; }
      }
    };
    await fillPool();
    // Leave a completed prefix durable even while a later read is still running.
    while (inFlight.size) {
      const slot = await Promise.race(inFlight.values());
      inFlight.delete(slot.index);
      buffered.set(slot.index, slot);
      while (buffered.has(committed)) {
        const index = committed++, current = buffered.get(index)!;
        buffered.delete(index);
        if ("error" in current) continue;
        try {
          if (!("result" in current.outcome)) throw new Error("并发工具不能进入等待");
          const result = await store.commitReadReceipt(run, calls[index].call.id, current.outcome.result, current.outcome);
          outcomes[index] = await project(calls[index],
            { ...current.outcome, result: result.status === "pending" ? current.outcome.result : result });
        } catch (error) { failure ??= { error }; }
      }
      await fillPool();
    }
    if (failure) throw failure.error;
    execution.signal.throwIfAborted();
    return outcomes;
  } finally { execution.close(); }
}
