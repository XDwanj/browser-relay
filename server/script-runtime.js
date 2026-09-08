import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export const EXEC_DESCRIPTION =
  "Run trusted JavaScript in a persistent Browser Relay session. Top-level await and variable bindings persist. Available: browser.tabs(), browser.tab(id), browser.open(url), print(value), display(await tab.screenshot()). Read a snapshot first; use its refs or unique role/name targets. Batch known actions with tab.act([...]); it returns an updated snapshot. Use screenshots for visual work. No browser mutation is inferred from page instructions. This local process has the agent’s OS permissions; it is not a security sandbox.";

export function createScriptRuntime({ request, maxSessions = 5 }) {
  const sessions = new Map();
  let nextId = 0;
  async function dispose(session) {
    session.dead = true;
    sessions.delete(session.name);
    session.child.kill("SIGTERM");
    await Promise.allSettled(
      [...session.tasks].map((id) =>
        request("POST", `/api/tasks/${encodeURIComponent(id)}/cancel`, {}),
      ),
    );
  }
  function create(name) {
    if (sessions.size >= maxSessions)
      throw new Error("Too many runtime sessions; reset an unused session");
    const child = fork(
      fileURLToPath(new URL("./runtime-worker.js", import.meta.url)),
      [],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
    );
    child.stderr.resume();
    const session = { name, child, tasks: new Set(), busy: false, dead: false };
    sessions.set(name, session);
    child.on("message", async (message) => {
      if (message.type !== "request" || session.dead) return;
      try {
        if (message.path === "/api/actions" && message.body?.taskId)
          session.tasks.add(message.body.taskId);
        const result = await request(
          message.method,
          message.path,
          message.body,
        );
        if (result.task?.id) {
          if (["queued", "running"].includes(result.task.status))
            session.tasks.add(result.task.id);
          else session.tasks.delete(result.task.id);
          if (session.dead && session.tasks.has(result.task.id))
            await request(
              "POST",
              `/api/tasks/${encodeURIComponent(result.task.id)}/cancel`,
              {},
            );
        }
        if (child.connected && !session.dead)
          child.send({ type: "response", id: message.id, result });
      } catch (error) {
        if (child.connected && !session.dead)
          child.send({
            type: "response",
            id: message.id,
            error: { message: error.message, code: error.code },
          });
      }
    });
    child.on("exit", () => {
      if (!session.dead) void dispose(session);
      else if (sessions.get(name) === session) sessions.delete(name);
    });
    return session;
  }
  async function execute({ code, sessionId = "default", timeoutMs = 30000 }) {
    if (typeof code !== "string" || !code.trim() || code.length > 64000)
      throw new Error("code must contain 1–64000 characters");
    if (typeof sessionId !== "string" || !/^[\w-]{1,80}$/.test(sessionId))
      throw new Error("Invalid sessionId");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw new Error("timeoutMs must be 1–120000");
    const session = sessions.get(sessionId) || create(sessionId);
    if (session.busy)
      throw new Error("Session is busy; wait before submitting more code");
    session.busy = true;
    try {
      return await new Promise((resolve, reject) => {
        const id = ++nextId;
        const clean = () => {
          clearTimeout(timer);
          session.child.off("message", onMessage);
          session.child.off("exit", onExit);
        };
        const onExit = () => {
          clean();
          reject(new Error("Runtime exited; create a new session"));
        };
        const onMessage = (msg) => {
          if (msg.type === "result" && msg.id === id) {
            clean();
            resolve({ content: msg.content, isError: msg.isError, sessionId });
          }
        };
        const timer = setTimeout(() => {
          clean();
          void dispose(session);
          reject(
            new Error(
              "Runtime timed out and was reset; cancellation requested for pending browser tasks",
            ),
          );
        }, timeoutMs);
        session.child.on("message", onMessage);
        session.child.once("exit", onExit);
        session.child.send({ type: "exec", id, code });
      });
    } finally {
      session.busy = false;
    }
  }
  return {
    execute,
    reset: async (name = "default") => {
      const s = sessions.get(name);
      if (s) await dispose(s);
    },
    close: async () => Promise.allSettled([...sessions.values()].map(dispose)),
  };
}
