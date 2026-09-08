import { createTaskQueue, TaskError, checkCancelled, pause } from "./tasks.js";

const valueOf = (v) => v?.value;
const compact = (s, n = 180) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
const integer = (n, fallback, min, max) => {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || n < min || n > max)
    throw new TaskError("invalid_request", `Expected integer ${min}–${max}`);
  return n;
};
const fail = (code, message, status) => {
  throw new TaskError(code, message, status);
};
const ACTIONS = new Set([
  "click",
  "double_click",
  "hover",
  "move",
  "drag",
  "type",
  "fill",
  "key",
  "scroll",
  "wait",
  "select",
  "check",
  "navigate",
]);
const NODE_FUNCTION = `function(operation, args) {
  if (!this.isConnected) return {error:'stale_ref'};
  const view = this.ownerDocument.defaultView;
  const element = this.nodeType===1 ? this : this.parentElement;
  if (operation === 'prepare') {
    element.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
    const r = element.getBoundingClientRect(), s = view.getComputedStyle(element);
    const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    const hit = this.getRootNode().elementFromPoint?.(r.x+r.width/2,r.y+r.height/2);
    return {visible, disabled:!!element.disabled || element.getAttribute('aria-disabled')==='true',
      obscured:!!hit && hit!==element && !element.contains(hit), x:r.x+r.width/2, y:r.y+r.height/2, width:r.width, height:r.height, clientLeft:element.clientLeft, clientTop:element.clientTop,
      background:view.document.visibilityState==='hidden'};
  }
  if (operation === 'inspect') {
    const r=element.getBoundingClientRect(), s=view.getComputedStyle(element);
    return {visible:r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden',
      value:this.type==='password'?'[redacted]':this.value, text:(this.innerText||'').slice(0,400)};
  }
  if (operation === 'click') { if(typeof element.click!=='function')return false;element.click(); return true; }
  if (operation === 'scroll') {element.scrollBy({left:args.deltaX||0,top:args.deltaY||0,behavior:'instant'});return {scrollLeft:element.scrollLeft,scrollTop:element.scrollTop};}
  if (operation === 'focus') {
    const editable=this.isContentEditable || this.tagName==='TEXTAREA' || (this.tagName==='INPUT' && ['text','search','email','tel','url','password','number'].includes(this.type));
    if(!editable || this.readOnly) return {error:'not_editable'};
    this.focus();
    const active=this.getRootNode().activeElement;
    if(active!==this && !this.contains(active)) return {error:'focus_failed'};
    if (args.clear) {
      if (typeof this.select==='function') this.select();
      else if (this.isContentEditable) { const r=view.document.createRange(); r.selectNodeContents(this); const s=view.getSelection();s.removeAllRanges();s.addRange(r); }
      else return {error:'not_editable'};
    }
    return true;
  }
  if (operation === 'select') {
    if (this.tagName!=='SELECT') return {error:'not_select'};
    const values=Array.isArray(args.value)?args.value:[args.value];
    if (values.some(v=>!Array.from(this.options).some(o=>o.value===v))) return {error:'option_not_found'};
    for (const option of this.options) option.selected=values.includes(option.value);
    this.dispatchEvent(new view.Event('input',{bubbles:true}));this.dispatchEvent(new view.Event('change',{bubbles:true}));
    return {selected:Array.from(this.selectedOptions).map(o=>o.value)};
  }
  if (operation === 'check') {
    if (!['checkbox','radio'].includes(this.type)) return {error:'not_checkable'};
    if (this.checked!==args.checked) this.click();
    if(this.checked!==args.checked)return {error:'checked_state_mismatch'};
    return {checked:this.checked};
  }
}`;

/** Browser-side executor. Local HTTP and remote hub both reach this instance. */
export function createAutomation({
  send,
  resolveTab,
  createTab,
  closeTab,
  listTabs,
  focusTab,
}) {
  const states = new Map(),
    children = new Map(),
    queue = createTaskQueue();
  function state(tabId) {
    if (!states.has(tabId))
      states.set(tabId, {
        refs: new Map(),
        nodes: new Map(),
        next: 0,
        prefix: crypto.randomUUID().slice(0, 8),
        baselines: new Map(),
        shots: new Map(),
        sessions: new Map(),
      });
    return states.get(tabId);
  }
  function invalidate(tabId) {
    states.delete(tabId);
  }
  async function cdp(tabId, method, params = {}, sessionId) {
    return send(tabId, method, params, sessionId);
  }
  async function evaluate(tabId, expression, sessionId) {
    const r = await cdp(
      tabId,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails)
      fail(
        "evaluation_failed",
        r.exceptionDetails.text || "Page evaluation failed",
        422,
      );
    return r.result?.value;
  }
  const metadataExpression = `({url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY,dpr:devicePixelRatio},readyState:document.readyState,background:document.visibilityState==='hidden'})`;
  async function frameSession(tabId, frameId) {
    const st = state(tabId);
    const child = children.get(tabId)?.get(frameId);
    if (child) return child.sessionId;
    if (st.sessions.has(frameId)) return st.sessions.get(frameId);
    const attached = await cdp(tabId, "Target.attachToTarget", {
      targetId: frameId,
      flatten: true,
    });
    st.sessions.set(frameId, attached.sessionId);
    return attached.sessionId;
  }
  async function tree(tabId) {
    const st = state(tabId);
    {
      await cdp(tabId, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    }
    const [meta, frames] = await Promise.all([
      evaluate(tabId, metadataExpression),
      cdp(tabId, "Page.getFrameTree"),
    ]);
    const nodes = [],
      warnings = [],
      frameInfo = [];
    const redundantRefs = new Set();
    const visit = async (entry, parent, forcedSession) => {
      const frameId = entry.frame.id;
      let result,
        sessionId = forcedSession;
      try {
        result = await cdp(
          tabId,
          "Accessibility.getFullAXTree",
          { frameId },
          sessionId,
        );
      } catch (error) {
        try {
          sessionId = await frameSession(tabId, frameId);
          result = await cdp(
            tabId,
            "Accessibility.getFullAXTree",
            {},
            sessionId,
          );
        } catch (inner) {
          warnings.push({
            frameId,
            code: "frame_unavailable",
            message: inner.message,
          });
        }
      }
      frameInfo.push({
        id: frameId,
        parentId: parent,
        url: entry.frame.url,
        sessionId,
      });
      const axNodes = new Map(
        (result?.nodes || []).map((node) => [node.nodeId, node]),
      );
      for (const node of result?.nodes || []) {
        if (node.ignored) continue;
        const role = valueOf(node.role),
          name = String(valueOf(node.name) || "")
            .replace(/\s+/g, " ")
            .trim()
            .replace(role === "RootWebArea" ? /^[🔵⚪]+\s*/u : /$^/, "");
        if (
          [
            "none",
            "generic",
            "InlineTextBox",
            "LabelText",
            "paragraph",
            "form",
            "list",
            "listitem",
            "Legend",
            "MenuListPopup",
          ].includes(role) &&
          !name
        )
          continue;
        if (role === "InlineTextBox") continue;
        const backendId = node.backendDOMNodeId;
        const key = `${frameId}:${backendId}`;
        let ref;
        if (backendId) {
          ref = st.nodes.get(key);
          if (!ref) {
            ref = `e${st.prefix}_${++st.next}`;
            st.nodes.set(key, ref);
          }
          st.refs.set(ref, { backendId, frameId, sessionId });
        }
        if (role === "StaticText" && ref) {
          let ancestor = axNodes.get(node.parentId),
            depth = 0;
          while (ancestor && depth++ < 100) {
            if (
              ["button", "link", "heading", "option"].includes(
                valueOf(ancestor.role),
              ) &&
              compact(valueOf(ancestor.name)) === compact(name)
            ) {
              redundantRefs.add(ref);
              break;
            }
            ancestor = axNodes.get(ancestor.parentId);
          }
        }
        const properties = Object.fromEntries(
          (node.properties || [])
            .filter((p) =>
              [
                "disabled",
                "checked",
                "selected",
                "expanded",
                "required",
                "focused",
                "level",
              ].includes(p.name),
            )
            .map((p) => [p.name, valueOf(p.value)]),
        );
        // AX may expose password values depending on browser/platform; never emit them.
        const val =
          role === "textbox" || role === "searchbox"
            ? undefined
            : compact(valueOf(node.value));
        nodes.push({
          ref,
          role,
          name,
          ...(val ? { value: val } : {}),
          ...properties,
          frameId,
        });
      }
      for (const child of entry.childFrames || [])
        await visit(child, frameId, sessionId);
    };
    await visit(frames.frameTree);
    for (const child of children.get(tabId)?.values() || []) {
      if (
        child.targetInfo.type !== "iframe" ||
        frameInfo.some((f) => f.id === child.targetInfo.targetId)
      )
        continue;
      try {
        const childTree = await cdp(
          tabId,
          "Page.getFrameTree",
          {},
          child.sessionId,
        );
        await visit(
          childTree.frameTree,
          childTree.frameTree.frame.parentId || frames.frameTree.frame.id,
          child.sessionId,
        );
      } catch (error) {
        warnings.push({
          frameId: child.targetInfo.targetId,
          code: "frame_unavailable",
          message: error.message,
        });
      }
    }
    const active = new Set(nodes.map((n) => n.ref).filter(Boolean));
    for (const [ref, node] of st.refs)
      if (!active.has(ref)) {
        st.refs.delete(ref);
        st.nodes.delete(`${node.frameId}:${node.backendId}`);
      }
    st.frames = frameInfo;
    return {
      ...meta,
      nodes,
      redundantRefs,
      frames: frameInfo.map(({ sessionId, ...f }) => f),
      warnings,
    };
  }
  async function observe(tabId, options = {}) {
    // Input acknowledgement precedes paint/compositor scrolling. Wait for a
    // rendered frame, bounded for background tabs whose rAF can be suspended.
    await evaluate(
      tabId,
      `new Promise(resolve=>{const timer=setTimeout(resolve,100);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));})`,
    );
    if (options.mode === "screenshot") return screenshot(tabId, options);
    const st = state(tabId),
      data = await tree(tabId);
    const maxLength = integer(options.maxLength, 20000, 100, 100000);
    const session = String(options.sessionId || "default").slice(0, 128);
    const records = new Map(
      data.nodes
        .filter((n) => !data.redundantRefs.has(n.ref))
        .map((node, i) => [
          node.ref || `text_${i}`,
          `[${node.ref || "-"}] ${node.role}${node.name ? ` ${JSON.stringify(compact(node.name) + (node.name.length > 180 ? "…" : ""))}` : ""}${Object.entries(
            node,
          )
            .filter(
              ([k, v]) =>
                !["ref", "role", "name", "frameId"].includes(k) &&
                v !== undefined,
            )
            .map(([k, v]) => ` ${k}=${JSON.stringify(v)}`)
            .join(
              "",
            )}${node.frameId !== data.frames[0]?.id ? ` frame=${node.frameId}` : ""}`,
        ]),
    );
    const previous = st.baselines.get(session);
    let lines = [...records.values()],
      diff = false;
    if (options.diff === true && previous?.url === data.url) {
      diff = true;
      lines = [];
      for (const [key, line] of previous.records)
        if (!records.has(key)) lines.push(`- ${line}`);
      for (const [key, line] of records)
        if (previous.records.get(key) !== line)
          lines.push(`${previous.records.has(key) ? "~" : "+"} ${line}`);
      if (!lines.length) lines.push("(no changes)");
    }
    const full = lines.join("\n"),
      truncated = full.length > maxLength;
    // A truncated observation must not advance its baseline past unseen content.
    if (!truncated) {
      if (st.baselines.size >= 50 && !st.baselines.has(session))
        st.baselines.delete(st.baselines.keys().next().value);
      st.baselines.set(session, { url: data.url, records });
    }
    return {
      ok: true,
      url: data.url,
      title: data.title,
      viewport: data.viewport,
      snapshot: full.slice(0, maxLength),
      diff,
      truncated,
      frames: data.frames,
      warnings: data.warnings,
      ...(options.includeNodes ? { nodes: data.nodes } : {}),
    };
  }
  async function nodeCall(tabId, node, operation, args = {}) {
    let objectId;
    try {
      objectId = (
        await cdp(
          tabId,
          "DOM.resolveNode",
          { backendNodeId: node.backendId },
          node.sessionId,
        )
      ).object.objectId;
      const result = await cdp(
        tabId,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: NODE_FUNCTION,
          arguments: [{ value: operation }, { value: args }],
          returnByValue: true,
        },
        node.sessionId,
      );
      if (result.exceptionDetails)
        fail(
          "element_action_failed",
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            "Element action failed",
          422,
        );
      const value = result.result?.value;
      if (value?.error) fail(value.error, value.error, 409);
      return value;
    } catch (error) {
      if (error.code) throw error;
      fail(
        "stale_ref",
        "Element no longer exists; observe the page again",
        409,
      );
    } finally {
      if (objectId)
        await cdp(
          tabId,
          "Runtime.releaseObject",
          { objectId },
          node.sessionId,
        ).catch(() => {});
    }
  }
  async function resolveNode(tabId, target) {
    if (typeof target === "string")
      target =
        target.startsWith("e") && /^e[\w]+_\d+$/.test(target)
          ? { ref: target }
          : { selector: target };
    if (!target || typeof target !== "object")
      fail("invalid_target", "Use a ref, selector, or role/name target");
    const st = state(tabId);
    if (target.ref) {
      const node = st.refs.get(target.ref);
      if (!node)
        fail(
          "stale_ref",
          "Unknown or expired reference; observe the page again",
          409,
        );
      return node;
    }
    if (target.role || target.name) {
      const data = await tree(tabId);
      const matches = data.nodes.filter(
        (n) =>
          n.ref &&
          (!target.frameId || n.frameId === target.frameId) &&
          (!target.role || n.role === target.role) &&
          (target.name === undefined ||
            (target.exact === false
              ? n.name.includes(target.name)
              : n.name === target.name)),
      );
      if (!matches.length)
        fail("element_not_found", "No matching accessible element", 404);
      if (matches.length !== 1)
        fail(
          "ambiguous_target",
          `Target matches ${matches.length} elements; use a ref or frameId`,
          409,
        );
      return st.refs.get(matches[0].ref);
    }
    if (typeof target.selector !== "string")
      fail("invalid_target", "selector is required");
    let contextId, sessionId;
    if (target.frameId) {
      try {
        contextId = (
          await cdp(tabId, "Page.createIsolatedWorld", {
            frameId: target.frameId,
            worldName: "browser-relay-locator",
          })
        ).executionContextId;
      } catch {
        sessionId = await frameSession(tabId, target.frameId);
        contextId = (
          await cdp(
            tabId,
            "Page.createIsolatedWorld",
            { frameId: target.frameId, worldName: "browser-relay-locator" },
            sessionId,
          )
        ).executionContextId;
      }
    }
    const expression = `(() => { const found=[]; const walk=root=>{found.push(...root.querySelectorAll(${JSON.stringify(target.selector)}));for(const el of root.querySelectorAll('*'))if(el.shadowRoot)walk(el.shadowRoot);};walk(document);if(found.length!==1)throw new Error('Expected one element; found '+found.length);return found[0];})()`;
    const r = await cdp(
      tabId,
      "Runtime.evaluate",
      { expression, contextId },
      sessionId,
    );
    if (r.exceptionDetails)
      fail(
        "invalid_target",
        r.exceptionDetails.exception?.description || r.exceptionDetails.text,
        409,
      );
    try {
      const { node } = await cdp(
        tabId,
        "DOM.describeNode",
        { objectId: r.result.objectId },
        sessionId,
      );
      return {
        backendId: node.backendNodeId,
        frameId: target.frameId,
        sessionId,
      };
    } finally {
      if (r.result?.objectId)
        await cdp(
          tabId,
          "Runtime.releaseObject",
          { objectId: r.result.objectId },
          sessionId,
        ).catch(() => {});
    }
  }
  async function frameOffset(tabId, frameId) {
    const st = state(tabId);
    if (!st.frames) await tree(tabId);
    let x = 0,
      y = 0,
      frame = st.frames.find((f) => f.id === frameId);
    while (frame?.parentId) {
      const parent = st.frames.find((f) => f.id === frame.parentId);
      const owner = await cdp(
        tabId,
        "DOM.getFrameOwner",
        { frameId: frame.id },
        parent?.sessionId,
      );
      const rect = await nodeCall(
        tabId,
        { backendId: owner.backendNodeId, sessionId: parent?.sessionId },
        "prepare",
      );
      x += rect.x - rect.width / 2 + (rect.clientLeft || 0);
      y += rect.y - rect.height / 2 + (rect.clientTop || 0);
      frame = parent;
    }
    return { x, y };
  }
  async function screenshot(tabId, options = {}) {
    const meta = await evaluate(tabId, metadataExpression);
    let clip = options.clip;
    if (options.fullPage) {
      const metrics = await cdp(tabId, "Page.getLayoutMetrics");
      const size = metrics.cssContentSize || metrics.contentSize;
      clip = {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1,
      };
    }
    if (clip) {
      for (const k of ["x", "y", "width", "height"])
        if (
          !Number.isFinite(clip[k]) ||
          clip[k] < (k === "x" || k === "y" ? 0 : 1)
        )
          fail("invalid_clip", "Invalid screenshot clip");
      if (clip.width * clip.height > 40_000_000)
        fail(
          "screenshot_too_large",
          "Use a viewport screenshot or a smaller clip",
        );
      clip = { ...clip, scale: 1 };
    }
    const { data } = await cdp(tabId, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: !!clip,
      ...(clip ? { clip } : {}),
    });
    const bytes = atob(data.slice(0, 44)),
      uint = (i) =>
        bytes.charCodeAt(i) * 2 ** 24 +
        (bytes.charCodeAt(i + 1) << 16) +
        (bytes.charCodeAt(i + 2) << 8) +
        bytes.charCodeAt(i + 3);
    const width = uint(16),
      height = uint(20),
      screenshotId = `shot_${crypto.randomUUID()}`;
    const mapping = {
      scaleX: (clip?.width || meta.viewport.width) / width,
      scaleY: (clip?.height || meta.viewport.height) / height,
      offsetX: clip ? clip.x - meta.viewport.scrollX : 0,
      offsetY: clip ? clip.y - meta.viewport.scrollY : 0,
    };
    const shot = {
      ok: true,
      data,
      format: "png",
      width,
      height,
      screenshotId,
      viewport: meta.viewport,
      url: meta.url,
      fullPage: !!options.fullPage,
      imageToViewport: mapping,
    };
    const shots = state(tabId).shots;
    if (shots.size >= 5) shots.delete(shots.keys().next().value);
    shots.set(screenshotId, { ...shot, data: undefined });
    return shot;
  }
  async function point(tabId, action) {
    let { x, y } = action;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      fail("invalid_coordinates", "Finite x and y are required");
    if (action.screenshotId) {
      const shot = state(tabId).shots.get(action.screenshotId);
      if (!shot)
        fail("stale_screenshot", "Screenshot expired; capture a new one", 409);
      const meta = await evaluate(tabId, metadataExpression);
      if (
        meta.url !== shot.url ||
        JSON.stringify(meta.viewport) !== JSON.stringify(shot.viewport)
      )
        fail(
          "stale_screenshot",
          "Viewport changed; capture a new screenshot",
          409,
        );
      if (x < 0 || y < 0 || x >= shot.width || y >= shot.height)
        fail("invalid_coordinates", "Point is outside screenshot");
      x = x * shot.imageToViewport.scaleX + shot.imageToViewport.offsetX;
      y = y * shot.imageToViewport.scaleY + shot.imageToViewport.offsetY;
    }
    const meta = await evaluate(tabId, metadataExpression);
    if (x < 0 || y < 0 || x >= meta.viewport.width || y >= meta.viewport.height)
      fail(
        "invalid_coordinates",
        "Point is outside current viewport; scroll first",
      );
    if (meta.background) {
      if (action.allowFocus && focusTab) await focusTab(tabId);
      else
        fail(
          "needs_foreground",
          "Visual input requires a visible tab; allowFocus explicitly or use a semantic target",
          409,
        );
    }
    return { x, y };
  }
  async function key(tabId, combo) {
    const aliases = {
      Return: "Enter",
      Esc: "Escape",
      Up: "ArrowUp",
      Down: "ArrowDown",
      Left: "ArrowLeft",
      Right: "ArrowRight",
      space: " ",
    };
    const parts = combo.split("+"),
      last = parts.pop(),
      k = aliases[last] || last;
    let modifiers = 0;
    for (const part of parts) {
      const m = {
        Control: 2,
        Ctrl: 2,
        Alt: 1,
        Shift: 8,
        Meta: 4,
        Command: 4,
        super: 4,
      }[part];
      if (!m) fail("invalid_key", `Unknown modifier ${part}`);
      modifiers |= m;
    }
    const virtual = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
      " ": 32,
    };
    if (k.length !== 1 && !virtual[k])
      fail("invalid_key", `Unsupported key ${k}`);
    const vk = virtual[k] || k.toUpperCase().charCodeAt(0),
      base = {
        key: k,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      };
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      ...(!modifiers && (k.length === 1 || k === "Enter")
        ? { text: k === "Enter" ? "\r" : k }
        : {}),
    });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  async function perform(tabId, action, signal) {
    checkCancelled(signal);
    const type = action.type;
    if (type === "navigate") {
      const result = await cdp(tabId, "Page.navigate", { url: action.url });
      if (result.errorText) fail("navigation_failed", result.errorText, 422);
      invalidate(tabId);
      return { navigated: true };
    }
    if (type === "key") {
      await key(tabId, action.key);
      return { pressed: true };
    }
    if (type === "wait") {
      const deadline = Date.now() + integer(action.timeoutMs, 5000, 1, 20000),
        stateName = action.state || "visible";
      do {
        checkCancelled(signal);
        try {
          const node = await resolveNode(tabId, action.target),
            details = await nodeCall(tabId, node, "inspect");
          if (
            stateName === "attached" ||
            (stateName === "visible" && details.visible) ||
            (stateName === "hidden" && !details.visible)
          )
            return { matched: true };
        } catch (error) {
          if (
            ["hidden", "detached"].includes(stateName) &&
            ["element_not_found", "stale_ref"].includes(error.code)
          )
            return { matched: true };
          // CSS missing nodes are distinct from invalid/ambiguous selectors.
          if (
            error.code === "invalid_target" &&
            /found 0\b/.test(error.message)
          ) {
            if (["hidden", "detached"].includes(stateName))
              return { matched: true };
          } else if (!["element_not_found", "stale_ref"].includes(error.code))
            throw error;
        }
        if (Date.now() >= deadline) break;
        await pause(Math.min(100, deadline - Date.now()), signal);
      } while (true);
      fail("wait_timeout", "Target did not reach the requested state", 408);
    }
    let node, rect;
    if (action.target) {
      node = await resolveNode(tabId, action.target);
      rect = await nodeCall(tabId, node, "prepare");
      if (!rect.visible)
        fail("element_not_visible", "Target is not visible", 409);
      if (rect.disabled) fail("element_disabled", "Target is disabled", 409);
    }
    if (["fill", "type"].includes(type)) {
      if (node)
        await nodeCall(tabId, node, "focus", {
          clear: type === "fill" || action.clear === true,
        });
      else if (type === "fill")
        fail("invalid_target", "fill requires an editable target");
      if (action.text === "") {
        if (node && (type === "fill" || action.clear))
          await key(tabId, "Backspace");
      } else await cdp(tabId, "Input.insertText", { text: action.text });
      if (action.submit) await key(tabId, "Enter");
      return { typed: true };
    }
    if (type === "select" || type === "check") {
      if (!node) fail("invalid_target", `${type} requires a target`);
      return nodeCall(tabId, node, type, action);
    }
    if (type === "scroll") {
      if (node && rect.background)
        return {
          scrolled: true,
          strategy: "dom",
          ...(await nodeCall(tabId, node, "scroll", action)),
        };
      const at = node ? { x: rect.x, y: rect.y } : await point(tabId, action);
      const offset = node
        ? await frameOffset(tabId, node.frameId)
        : { x: 0, y: 0 };
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: at.x + offset.x,
        y: at.y + offset.y,
        deltaX: action.deltaX || 0,
        deltaY: action.deltaY || 0,
      });
      return { scrolled: true };
    }
    if (node && rect.obscured)
      fail(
        "element_obscured",
        "Target is covered by another element; observe before retrying",
        409,
      );
    if (
      node &&
      rect.background &&
      type === "click" &&
      (!action.button || action.button === "left")
    ) {
      if (await nodeCall(tabId, node, "click"))
        return { clicked: true, strategy: "dom" };
    }
    const offset = node
      ? await frameOffset(tabId, node.frameId)
      : { x: 0, y: 0 };
    const at = await point(
      tabId,
      node
        ? {
            ...action,
            x: rect.x + offset.x,
            y: rect.y + offset.y,
            screenshotId: undefined,
          }
        : action,
    );
    if (type === "move" || type === "hover") {
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...at,
      });
      return { moved: true };
    }
    const button = action.button || "left",
      clickCount = type === "double_click" ? 2 : 1;
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    if (type === "drag") {
      const path = action.path || [action.to],
        end = await point(tabId, {
          ...path.at(-1),
          screenshotId: action.screenshotId,
          allowFocus: action.allowFocus,
        });
      let current = at,
        pressed = false;
      try {
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...at,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        pressed = true;
        for (const dest of path) {
          const goal = await point(tabId, {
            ...dest,
            screenshotId: action.screenshotId,
            allowFocus: action.allowFocus,
          });
          const from = current;
          for (let i = 1; i <= 8; i++) {
            checkCancelled(signal);
            current = {
              x: from.x + ((goal.x - from.x) * i) / 8,
              y: from.y + ((goal.y - from.y) * i) / 8,
            };
            await cdp(tabId, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...current,
              button: "left",
              buttons: 1,
            });
          }
        }
      } finally {
        if (pressed)
          await cdp(tabId, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...current,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
      }
      return { dragged: true, end };
    }
    for (let i = 1; i <= clickCount; i++) {
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...at,
        button,
        clickCount: i,
      });
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...at,
        button,
        clickCount: i,
      });
    }
    return { clicked: true, strategy: "mouse" };
  }
  function validate(actions) {
    if (!Array.isArray(actions) || !actions.length || actions.length > 100)
      fail("invalid_request", "actions must contain 1–100 operations");
    for (const action of actions) {
      if (!action || !ACTIONS.has(action.type))
        fail("invalid_action", `Unsupported action: ${action?.type}`);
      if (
        ["type", "fill"].includes(action.type) &&
        typeof action.text !== "string"
      )
        fail("invalid_action", "text is required");
      if (action.type === "key" && typeof action.key !== "string")
        fail("invalid_action", "key is required");
      if (action.type === "navigate") {
        let u;
        try {
          u = new URL(action.url);
        } catch {
          fail("invalid_url", "Invalid URL");
        }
        if (
          !["http:", "https:"].includes(u.protocol) &&
          action.url !== "about:blank"
        )
          fail(
            "invalid_url",
            "Only HTTP(S) and about:blank navigation is supported",
          );
      }
      if (
        action.type === "wait" &&
        !["attached", "visible", "hidden", "detached"].includes(
          action.state || "visible",
        )
      )
        fail("invalid_action", "Invalid wait state");
      if (action.type === "check" && typeof action.checked !== "boolean")
        fail("invalid_action", "checked must be boolean");
      if (
        action.type === "select" &&
        typeof action.value !== "string" &&
        !(
          Array.isArray(action.value) &&
          action.value.every((v) => typeof v === "string")
        )
      )
        fail("invalid_action", "value must be a string or string array");
      if (action.button && !["left", "middle", "right"].includes(action.button))
        fail("invalid_action", "Invalid mouse button");
      if (
        action.type === "drag" &&
        !(
          action.to ||
          (Array.isArray(action.path) &&
            action.path.length &&
            action.path.length <= 100)
        )
      )
        fail("invalid_action", "drag requires to or a bounded path");
      for (const k of ["deltaX", "deltaY"])
        if (
          action[k] !== undefined &&
          (!Number.isFinite(action[k]) || Math.abs(action[k]) > 10000)
        )
          fail("invalid_action", "Scroll delta must be within ±10000");
    }
  }
  async function request(method, path, body = {}) {
    const u = new URL(path, "http://relay.local"),
      p = u.pathname,
      options = method === "GET" ? Object.fromEntries(u.searchParams) : body;
    if (method === "GET" && p === "/api/capabilities")
      return {
        ok: true,
        protocolVersion: 2,
        features: [
          "observe",
          "ax",
          "refs",
          "frames",
          "shadow-dom",
          "diff",
          "actions",
          "tasks",
          "coordinates",
          "drag",
          "hover",
          "screenshot-mapping",
          "tabs",
        ],
        maxActions: 100,
      };
    const taskMatch = p.match(/^\/api\/tasks\/([^/]+)(\/cancel)?$/);
    if (taskMatch)
      return {
        ok: true,
        task:
          method === "POST" && taskMatch[2]
            ? queue.cancel(taskMatch[1])
            : queue.get(taskMatch[1]),
      };
    if (p === "/api/tabs/create" && method === "POST")
      return { ok: true, ...(await createTab(body.url || "about:blank")) };
    if (p === "/api/tabs/close" && method === "POST") {
      const tabId = await resolveTab(body.tabId);
      queue.cancelTab(tabId);
      invalidate(tabId);
      await closeTab(tabId);
      return { ok: true };
    }
    if (p === "/api/observe") {
      const tabId = await resolveTab(options.tabId);
      const job = queue.start(tabId, () =>
        observe(tabId, {
          ...options,
          diff: options.diff === true || options.diff === "true",
          includeNodes:
            options.includeNodes === true || options.includeNodes === "true",
          maxLength:
            options.maxLength === undefined
              ? undefined
              : Number(options.maxLength),
        }),
      );
      const result = await job.done;
      if (result.error)
        throw new TaskError(
          result.error.code,
          result.error.message,
          result.error.status,
        );
      return result.observation;
    }
    if (p === "/api/actions" && method === "POST") {
      validate(body.actions);
      if (
        !["none", "snapshot", "screenshot"].includes(body.observe || "snapshot")
      )
        fail(
          "invalid_request",
          "observe must be none, snapshot, or screenshot",
        );
      if (!body.tabId)
        fail("invalid_request", "Explicit tabId is required for actions");
      const tabId = await resolveTab(body.tabId),
        timeoutMs = integer(body.timeoutMs, 20000, 1, 120000);
      if (timeoutMs > 20000 && body.async !== true)
        fail(
          "async_required",
          "Tasks longer than 20 seconds must use async:true",
        );
      const { id, done } = queue.start(
        tabId,
        async (job, signal) => {
          for (const action of body.actions) {
            checkCancelled(signal);
            const start = Date.now(),
              result = await perform(tabId, action, signal);
            job.results.push({
              type: action.type,
              elapsedMs: Date.now() - start,
              ...result,
            });
          }
          checkCancelled(signal);
          return body.observe === "none"
            ? undefined
            : await observe(tabId, {
                mode: body.observe,
                sessionId: body.sessionId,
                diff: body.diff !== false,
              });
        },
        timeoutMs,
        body.taskId,
      );
      if (body.async === true) return { ok: true, task: queue.get(id) };
      const task = await done;
      return {
        ok: task.status === "completed",
        task,
        ...(task.error
          ? {
              code: task.error.code,
              message: task.error.message,
              error: task.error.message,
              status: task.error.status,
            }
          : {}),
      };
    }
    fail(
      "endpoint_not_found",
      `Unknown automation endpoint: ${method} ${p}`,
      404,
    );
  }
  return {
    request,
    observe,
    screenshot,
    invalidate,
    activeTasks: queue.active,
    cancelAll: queue.cancelAll,
    attachChild: (tabId, entry) => {
      if (!children.has(tabId)) children.set(tabId, new Map());
      children.get(tabId).set(entry.targetInfo.targetId, entry);
    },
    detachChild: (tabId, sessionId) => {
      for (const [id, c] of children.get(tabId) || [])
        if (c.sessionId === sessionId) children.get(tabId).delete(id);
    },
    close: (tabId) => {
      invalidate(tabId);
      children.delete(tabId);
      queue.cancelTab(tabId);
    },
  };
}
