import { randomUUID } from "node:crypto";

// Chrome owns the real debugger attachments. CDP clients get independent virtual
// sessions; disconnecting Playwright must never close Chrome or detach a user tab.
export function createCdpBridge({ targets, send, ensure }) {
  const peers = new Set();
  const targetInfo = (target) => ({
    ...target.targetInfo,
    attached: true,
    browserContextId:
      target.targetInfo.browserContextId || "browser-relay-default",
  });
  function emit(peer, method, params, sessionId) {
    if (peer.ws.readyState === 1)
      peer.ws.send(
        JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }),
      );
  }
  function attach(peer, target, parent) {
    let entry = [...peer.sessions.values()].find(
      (s) => s.real === target.sessionId,
    );
    if (entry) return entry.id;
    const id = `relay_${randomUUID()}`;
    entry = { id, real: target.sessionId, targetId: target.targetId };
    peer.sessions.set(id, entry);
    emit(
      peer,
      "Target.attachedToTarget",
      {
        sessionId: id,
        targetInfo: targetInfo(target),
        waitingForDebugger: false,
      },
      parent,
    );
    return id;
  }
  async function command(peer, msg) {
    const { method, params = {}, sessionId } = msg;
    await ensure();
    const session = sessionId ? peer.sessions.get(sessionId) : undefined;
    if (sessionId && !session) throw new Error("Unknown CDP session");
    if (session && method !== "Target.detachFromTarget")
      // Shared Chrome must not leave future iframe targets paused after the
      // client disconnects. Playwright accepts already-running targets.
      return send(method, method === 'Target.setAutoAttach' ? {...params,waitForDebuggerOnStart:false} : params, session.real);
    if (method === "Browser.getVersion") {
      return send("Browser.getVersion", {});
    }
    if (method === "Browser.close") return {};
    if (method === "Browser.setDownloadBehavior") return {}; // Downloads use the user's Chrome manager.
    if (method === "Target.getBrowserContexts")
      return { browserContextIds: [] };
    if (method === "Target.getTargets")
      return { targetInfos: [...targets().values()].map(targetInfo) };
    if (method === "Target.setDiscoverTargets") {
      peer.discover = !!params.discover;
      if (peer.discover)
        for (const target of targets().values())
          emit(peer, "Target.targetCreated", {
            targetInfo: targetInfo(target),
          });
      return {};
    }
    if (method === "Target.setAutoAttach") {
      peer.autoAttach = !!params.autoAttach;
      if (peer.autoAttach)
        for (const target of targets().values()) attach(peer, target);
      return {};
    }
    if (method === "Target.attachToTarget") {
      const target = [...targets().values()].find(
        (t) => t.targetId === params.targetId,
      );
      if (!target) throw new Error("Target not found");
      return { sessionId: attach(peer, target) };
    }
    if (method === "Target.detachFromTarget") {
      peer.sessions.delete(params.sessionId);
      return {};
    }
    if (method === "Target.getTargetInfo") {
      if (!params.targetId)
        return {
          targetInfo: {
            targetId: "browser-relay-browser",
            type: "browser",
            title: "Browser Relay",
            url: "",
            attached: true,
            browserContextId: "browser-relay-default",
          },
        };
      const target = [...targets().values()].find(
        (t) => t.targetId === params.targetId,
      );
      if (!target) throw new Error("Target not found");
      return { targetInfo: targetInfo(target) };
    }
    if (method === "Browser.getWindowForTarget")
      return {
        windowId: 1,
        bounds: {
          left: 0,
          top: 0,
          width: 1280,
          height: 720,
          windowState: "normal",
        },
      };
    if (method === "Browser.setWindowBounds")
      throw new Error("Window resizing is not supported on shared Chrome");
    if (
      method === "Target.createBrowserContext" ||
      method === "Target.disposeBrowserContext"
    )
      throw new Error(
        "Browser contexts are owned by the user; reuse the default context",
      );
    return send(method, params);
  }
  function connect(ws) {
    const peer = {
      ws,
      sessions: new Map(),
      autoAttach: false,
      discover: false,
    };
    peers.add(peer);
    ws.on("close", () => peers.delete(peer));
    ws.on("error", () => {});
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!Number.isInteger(msg.id) || typeof msg.method !== "string") return;
      try {
        const result = await command(peer, msg);
        if (ws.readyState === 1)
          ws.send(
            JSON.stringify({
              id: msg.id,
              result,
              ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            }),
          );
      } catch (error) {
        if (ws.readyState === 1)
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: error.message },
              ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            }),
          );
      }
    });
  }
  function event(method, params = {}, realSession) {
    for (const peer of peers) {
      const owner = [...peer.sessions.values()].find(
        (s) => s.real === realSession,
      );
      if (method === "Target.attachedToTarget") {
        const target = {
          sessionId: params.sessionId,
          targetId: params.targetInfo.targetId,
          targetInfo: params.targetInfo,
        };
        if (owner) attach(peer, target, owner.id);
        else if (params.targetInfo.type === "page") {
          if (peer.discover)
            emit(peer, "Target.targetCreated", {
              targetInfo: targetInfo(target),
            });
          if (peer.autoAttach) attach(peer, target);
        }
      } else if (method === "Target.detachedFromTarget") {
        const child = [...peer.sessions.values()].find(
          (s) => s.real === params.sessionId,
        );
        if (child) {
          emit(peer, method, { ...params, sessionId: child.id }, owner?.id);
          peer.sessions.delete(child.id);
        }
      } else if (owner) emit(peer, method, params, owner.id);
      else if (method.startsWith("Target.") && peer.discover)
        emit(peer, method, params);
    }
  }
  function disconnect() {
    for (const peer of peers) peer.ws.close(1012, "Extension disconnected");
    peers.clear();
  }
  return { connect, event, disconnect };
}
