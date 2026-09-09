import {
  DEFAULT_REMOTE_HOST,
  parseRemoteDeviceId,
  remoteHttpBase,
} from "./remote-protocol.js";
import { randomUUID } from "node:crypto";

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
  return async (method, path, body) => {
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
        signal: AbortSignal.timeout(35000),
      },
    );
    const result = await response.json();
    if (!response.ok || result.ok === false)
      throw new BrowserRelayError(result);
    return result;
  };
}
export function createBrowser({
  request = createTransport(),
  sessionId = randomUUID(),
} = {}) {
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
      const result = await request("POST", "/api/actions", {
        tabId,
        sessionId,
        taskId: `job_${randomUUID()}`,
        actions,
        observe: "snapshot",
        ...options,
      });
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
      target,
    });
    return {
      id: tabId,
      act: run,
      ref: (ref) => locator({ ref }),
      locator: (selector, options = {}) => locator({ selector, ...options }),
      getByRole: (role, options = {}) => locator({ role, ...options }),
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
      goto: (url) => run([{ type: "navigate", url }]),
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
        const result = await request("POST", "/api/eval", {
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
        return result.result?.value;
      },
    };
  }
  return {
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
