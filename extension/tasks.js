// Shared by the extension and tests. A queue owns a whole operation, not one
// mouse event, so independently submitted scripts cannot interleave keystrokes.
export class TaskError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function checkCancelled(signal) {
  if (signal?.aborted)
    throw new TaskError(
      "task_cancelled",
      "Task cancelled; completed actions were not undone",
      409,
    );
}
export function pause(ms, signal) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new TaskError("task_cancelled", "Task cancelled", 409));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export function createTaskQueue({ limit = 100 } = {}) {
  const tails = new Map(),
    jobs = new Map();
  const publicJob = (job) => ({
    id: job.id,
    tabId: job.tabId,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    results: job.results,
    observation: job.observation,
    error: job.error,
  });
  function get(id) {
    const job = jobs.get(id);
    if (!job)
      throw new TaskError(
        "task_not_found",
        "Task not found (the extension may have restarted)",
        404,
      );
    return publicJob(job);
  }
  function start(tabId, run, timeoutMs = 20000, requestedId) {
    for (const [id, job] of jobs) {
      if (jobs.size < limit) break;
      if (job.finishedAt) jobs.delete(id);
    }
    if (jobs.size >= limit)
      throw new TaskError("task_limit", "Too many pending tasks", 429);
    const id = requestedId || `job_${crypto.randomUUID()}`;
    if (!/^job_[\w-]{36}$/.test(id))
      throw new TaskError("invalid_task_id", "Invalid task id");
    if (jobs.has(id))
      throw new TaskError(
        "duplicate_task",
        "Task id already exists; inspect its result instead of replaying actions",
        409,
      );
    const job = {
      id,
      tabId,
      status: "queued",
      createdAt: Date.now(),
      results: [],
      controller: new AbortController(),
    };
    jobs.set(id, job);
    const previous = tails.get(tabId) || Promise.resolve();
    const done = previous
      .catch(() => {})
      .then(async () => {
        let timer;
        try {
          checkCancelled(job.controller.signal);
          job.status = "running";
          job.startedAt = Date.now();
          timer = setTimeout(() => {
            job.timedOut = true;
            job.controller.abort();
          }, timeoutMs);
          const observation = await run(job, job.controller.signal);
          checkCancelled(job.controller.signal);
          job.observation = observation;
          job.status = "completed";
        } catch (error) {
          job.status = job.controller.signal.aborted ? "cancelled" : "failed";
          job.error = {
            code: job.timedOut ? "task_timeout" : error.code || "action_failed",
            message: error.message,
            status: error.status || 500,
          };
        } finally {
          clearTimeout(timer);
          job.finishedAt = Date.now();
        }
        return publicJob(job);
      });
    tails.set(tabId, done);
    done.finally(() => {
      if (tails.get(tabId) === done) tails.delete(tabId);
    });
    return { id, done };
  }
  function cancel(id) {
    get(id);
    const job = jobs.get(id);
    if (!job.finishedAt) job.controller.abort();
    return { ...publicJob(job), cancellationRequested: !job.finishedAt };
  }
  function cancelTab(tabId) {
    for (const job of jobs.values())
      if (job.tabId === tabId && !job.finishedAt) job.controller.abort();
  }
  const active = () =>
    [...jobs.values()]
      .filter((j) => !j.finishedAt)
      .map((j) => ({
        id: j.id,
        tabId: j.tabId,
        status: j.status,
        completedActions: j.results.length,
      }));
  const cancelAll = () => {
    const pending = active();
    for (const job of pending) cancel(job.id);
    return pending.length;
  };
  return { start, get, cancel, cancelTab, active, cancelAll };
}
