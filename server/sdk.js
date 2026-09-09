import {
  DEFAULT_REMOTE_HOST,
  parseRemoteDeviceId,
  remoteHttpBase,
} from "./remote-protocol.js";
import { randomUUID } from "node:crypto";
import { isAutomationPath, isTaskRequest } from "../extension/protocol.js";

export class BrowserRelayError extends Error {
  constructor(payload) {
    super(payload.message || payload.error || "Browser action failed");
    this.code = payload.code;
    this.payload = payload;
  }
}
export function createTransport({
  url = process.env.BROWSER_RELAY_URL || "http://127.0.0.1:18795",
  remoteDeviceId = process.env.BROWSER_RELAY_REMOTE_DEVICE_ID,
  remoteHost = process.env.BROWSER_RELAY_REMOTE_HOST || DEFAULT_REMOTE_HOST,
} = {}) {
  const remote = remoteDeviceId ? parseRemoteDeviceId(remoteDeviceId) : null;
  const request = async (method, path, body, { signal, timeoutMs = 35000 } = {}) => {
    const query = new URL(path, "http://relay.local");
    const taskRequest = isTaskRequest(method, query.pathname);
    let taskId, sessionId;
    if (taskRequest) {
      taskId = (method === "GET" ? query.searchParams.get("taskId") : body?.taskId) || `job_${randomUUID()}`;
      sessionId = (method === "GET" ? query.searchParams.get("sessionId") : body?.sessionId) || undefined;
      if (method === "GET") {
        query.searchParams.set("taskId", taskId);
        path = query.pathname + query.search;
      } else body = { ...body, taskId };
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Browser Relay request timed out")),
      timeoutMs,
    );
    try {
      const response = await fetch(
        remote
          ? `${remoteHttpBase(remoteHost)}/v1/rpc`
          : `${url.replace(/\/$/, "")}${path}`,
        {
          method: remote ? "POST" : method,
          headers: {
            "Content-Type": "application/json",
            ...(remote ? { Authorization: `Bearer ${remote.secret}` } : {}),
          },
          ...(remote
            ? {
                body: JSON.stringify({
                  routeId: remote.routeId,
                  id: randomUUID(),
                  method,
                  path,
                  body: body ?? null,
                  headers: {},
                }),
              }
            : body === undefined
              ? {}
              : { body: JSON.stringify(body) }),
          signal: controller.signal,
        },
      );
      const result = await response.json();
      if (!response.ok || result.ok === false)
        throw new BrowserRelayError(result);
      return result;
    } catch (error) {
      if (error instanceof BrowserRelayError &&
          !["cdp_timeout", "rpc_timeout", "request_timeout", "remote_request_timeout", "extension_not_connected"].includes(error.code)) throw error;
      const code = signal?.aborted ? "request_cancelled" : controller.signal.aborted ? "request_timeout" : error.code || "transport_error";
      clearTimeout(timer);
      // An aborted fetch does not stop Chrome (especially behind a remote hub).
      // Cancel through a fresh request and retain the task identity/progress.
      let task, cancellationError;
      if (taskId) {
        try {
          ({ task } = await request("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
            { sessionId }, { timeoutMs: 2500 }));
        } catch (cancelError) {
          cancellationError = cancelError.code || "transport_error";
        }
      }
      throw new BrowserRelayError({
        ok: false,
        code,
        message: error.message,
        retryable: !taskId && !signal?.aborted && method === "GET",
        ...(taskId ? { taskId, sessionId, task, cancellationRequested: !!task, cancellationError } : {}),
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  return request;
}
export function createBrowser({
  request: transportRequest = createTransport(),
  sessionId = randomUUID(),
} = {}) {
  let timer,
    disposed = false,
    sessionError;
  const request = async (method, path, body, options) => {
    const history = method === "GET" && path.startsWith("/api/tasks/");
    if (disposed && !history)
      throw new BrowserRelayError({
        code: "session_stopped",
        message: "Browser session disposed; create a new browser session",
      });
    if (sessionError && !history) throw sessionError;
    const modern = isAutomationPath(path.split("?")[0]);
    if (modern && !path.startsWith("/api/capabilities")) {
      if (method === "GET")
        path += `${path.includes("?") ? "&" : "?"}sessionId=${encodeURIComponent(sessionId)}`;
      else body = { ...body, sessionId };
      if (!timer && !history) {
        timer = setInterval(
          () =>
            transportRequest(
              "POST",
              "/api/sessions",
              { sessionId, action: "heartbeat" },
              { timeoutMs: 5000 },
            ).catch((error) => {
              sessionError = error;
              clearInterval(timer);
            }),
          40000,
        );
        timer.unref?.();
      }
    }
    return transportRequest(method, path, body, options);
  };
  async function waitTask(id, { timeoutMs = 125000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const { task } = await request(
        "GET",
        `/api/tasks/${encodeURIComponent(id)}`,
      );
      if (task.status === "completed") return task;
      if (task.status === "failed" || task.status === "cancelled")
        throw new BrowserRelayError({ ...task.error, task });
      if (Date.now() >= deadline) {
        await request(
          "POST",
          `/api/tasks/${encodeURIComponent(id)}/cancel`,
          {},
        );
        throw new BrowserRelayError({
          code: "task_timeout",
          message: "Task wait timed out",
        });
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  function tab(tabId) {
    if (typeof tabId !== "string" || !/^t_[\w-]{10}$/.test(tabId))
      throw new Error("Use a tab id from browser.tabs() or browser.open()");
    const run = async (actions, options = {}) => {
      const { signal, requestTimeoutMs, ...actionOptions } = options;
      const result = await request("POST", "/api/actions", {
        tabId,
        sessionId,
        taskId: `job_${randomUUID()}`,
        actions,
        observe: "snapshot",
        ...actionOptions,
      }, { signal, timeoutMs: requestTimeoutMs });
      return result.task;
    };
    const locator = (target) => ({
      click: (options = {}) => run([{ type: "click", target, ...options }]),
      doubleClick: (options = {}) =>
        run([{ type: "double_click", target, ...options }]),
      fill: (text, options = {}) =>
        run([{ type: "fill", target, text, ...options }]),
      type: (text, options = {}) =>
        run([{ type: "type", target, text, ...options }]),
      hover: (options = {}) => run([{ type: "hover", target, ...options }]),
      select: (value, options = {}) =>
        run([{ type: "select", target, value, ...options }]),
      check: (checked = true, options = {}) =>
        run([{ type: "check", target, checked, ...options }]),
      waitFor: (options = {}) => run([{ type: "wait", target, ...options }]),
      getByRole: (role, options = {}) =>
        locator({ role, ...options, scope: target }),
      read: (options = {}) =>
        request("POST", "/api/read", { tabId, target, ...options }),
      target,
    });
    return {
      id: tabId,
      act: run,
      ref: (ref) => locator({ ref }),
      locator: (selector, options = {}) => locator({ selector, ...options }),
      getByRole: (role, options = {}) => locator({ role, ...options }),
      read: (options = {}) =>
        request("POST", "/api/read", { tabId, ...options }),
      observe: (options = {}) =>
        request("POST", "/api/observe", { tabId, ...options }),
      focus: () => run([{ type: "focus" }]),
      claim: (options = {}) =>
        request("POST", "/api/tabs/claim", { tabId, ...options }),
      release: () => request("POST", "/api/tabs/release", { tabId }),
      handoff: (toSessionId) =>
        request("POST", "/api/tabs/handoff", { tabId, toSessionId }),
      snapshot: (options = {}) =>
        request("POST", "/api/observe", {
          tabId,
          sessionId,
          diff: true,
          ...options,
        }),
      screenshot: (options = {}) =>
        request("POST", "/api/observe", {
          tabId,
          mode: "screenshot",
          ...options,
        }),
      goto: (url, options = {}) =>
        run([
          { type: "navigate", url, ...options },
          ...(options.waitFor
            ? [
                {
                  type: "wait",
                  target: options.waitFor,
                  timeoutMs: options.timeoutMs || 10000,
                },
              ]
            : []),
        ]),
      close: () => request("POST", "/api/tabs/close", { tabId }),
      click: (target, options = {}) =>
        run([{ type: "click", target, ...options }]),
      clickAt: (x, y, options = {}) =>
        run([{ type: "click", x, y, ...options }]),
      key: (key) => run([{ type: "key", key }]),
      scroll: (deltaY, options = {}) =>
        run([{ type: "scroll", x: 400, y: 300, deltaY, ...options }]),
      hover: (target) => run([{ type: "hover", target }]),
      drag: (from, to, options = {}) =>
        run([{ type: "drag", ...from, to, ...options }]),
      eval: async (expression) => {
        const result = await request("POST", "/api/evaluate", {
          tabId,
          expression,
        });
        if (result.exceptionDetails)
          throw new BrowserRelayError({
            code: "evaluation_failed",
            message:
              result.exceptionDetails.exception?.description ||
              result.exceptionDetails.text,
          });
        return result.value;
      },
    };
  }
  return {
    sessionId,
    heartbeat: () => request("POST", "/api/sessions", { action: "heartbeat" }),
    claims: () => request("GET", "/api/sessions"),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      await transportRequest(
        "POST",
        "/api/sessions",
        { sessionId, action: "stop" },
        { timeoutMs: 5000 },
      );
    },
    tabs: async () => (await request("GET", "/api/tabs")).tabs,
    tab,
    open: async (url) =>
      tab((await request("POST", "/api/tabs/create", { url })).tabId),
    capabilities: () => request("GET", "/api/capabilities"),
    tasks: {
      get: async (id) =>
        (await request("GET", `/api/tasks/${encodeURIComponent(id)}`)).task,
      wait: waitTask,
      cancel: (id) =>
        request("POST", `/api/tasks/${encodeURIComponent(id)}/cancel`, {}),
    },
  };
}
