// Activity belongs to a user operation, not to a debugger connection. In
// particular, automatic console/network subscriptions must stay visually idle.
export function isUserCdpCommand(method) {
  return /^(Input\.|Accessibility\.(get|query)|DOMSnapshot\.captureSnapshot$|DOM\.(getDocument|getOuterHTML|querySelector|performSearch|getSearchResults|getBoxModel|getContentQuads|scrollIntoViewIfNeeded|focus|set)|Runtime\.(evaluate|callFunctionOn)$|Page\.(navigate|reload|captureScreenshot|printToPDF|handleJavaScriptDialog)$|Network\.getResponseBody$)/.test(method);
}

// A read or click often finishes in well under a second. Keep its indication
// long enough to show a full favicon cycle and visible movement in the glow;
// subsequent operations renew this window without restarting the animation.
export function createActivityTracker({ show, hide, settleMs = 4000 }) {
  const entries = new Map();
  function clear(tabId) {
    const entry = entries.get(tabId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entries.delete(tabId);
    hide(tabId);
  }
  return {
    begin(tabId) {
      let entry = entries.get(tabId);
      if (!entry) {
        entry = { count: 0, timer: null };
        entries.set(tabId, entry);
        show(tabId);
      }
      entry.count++;
      clearTimeout(entry.timer);
      let ended = false;
      return (immediate = false) => {
        if (ended || entries.get(tabId) !== entry) return;
        ended = true;
        if (--entry.count) return;
        if (immediate) clear(tabId);
        else entry.timer = setTimeout(() => clear(tabId), settleMs);
      };
    },
    clear,
    active: (tabId) => entries.has(tabId),
    running: (tabId) => (entries.get(tabId)?.count || 0) > 0,
  };
}

// Runs only in our isolated world, in the top document. Chrome may retain its
// chosen favicon when a new candidate is appended, so decorate existing icon
// links too. Restore their attributes, including site updates during the task.
// The page title is never edited. The edge light lives in a closed shadow root
// and cannot intercept pointer input or enter the accessibility tree.
export function updateActivityIndicator({ token, frames, leaseMs = 4000, stop = false }) {
  const key = '__browserRelayActivityIndicator';
  let state = globalThis[key];
  if (stop) {
    if (state?.token === token) state.dispose();
    return;
  }
  if (state && (state.token !== token || state.disposed)) {
    state.dispose(true);
    state = null;
  }
  if (state) {
    state.expiresAt = Date.now() + leaseMs;
    return true;
  }
  if (!frames?.length || !document.head) return;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  link.sizes = '32x32';
  link.dataset.browserRelayActivity = 'true';
  const originals = new Map();
  const attributes = ['href', 'type', 'sizes'];
  function rememberSiteChanges(node, record) {
    for (const name of attributes) {
      const value = node.getAttribute(name);
      if (value !== record.written[name]) record.original[name] = value;
    }
  }
  function restore(node, record) {
    rememberSiteChanges(node, record);
    for (const [name, value] of Object.entries(record.original)) {
      if (value === null) node.removeAttribute(name);
      else node.setAttribute(name, value);
    }
  }
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const overlay = document.createElement('div');
  overlay.dataset.browserRelayOverlay = 'true';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = true;
  // Inline important rules keep broad website styles away from the host.
  overlay.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:auto!important;height:auto!important;margin:0!important;padding:0!important;border:0!important;display:block!important;z-index:2147483647!important;pointer-events:none!important;overflow:hidden!important;contain:strict!important;visibility:visible!important;opacity:1!important;transform:none!important;';
  const shadow = overlay.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    * { box-sizing: border-box; pointer-events: none !important; }
    .surface { position: absolute; inset: 0; opacity: 0;
      transition: opacity 360ms cubic-bezier(.2,.7,.2,1); }
    .surface.visible { opacity: 1; }
    .aura { position: absolute; inset: 0; }
    .layer { position: absolute; inset: 0; }
    .band { position: absolute; inset: 0; border-radius: 0;
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude; }
    .spectrum { position: absolute; inset: 0;
      background: conic-gradient(from 215deg at 50% 50%,
        #ffae8018, #f06db518 42deg, #9568f918 82deg, #557dff18 120deg,
        #55dded18 160deg, #8c9eff18 195deg, #c279f818 230deg,
        #f485bd18 270deg, #ffd09b18 310deg, #ffae8018); }
    .spectrum::before, .spectrum::after { content: ''; position: absolute;
      inset: -28%; transform-origin: center;
      mask: radial-gradient(ellipse, #fff 48%, #fff9 70%, #fff0 100%);  }
    .spectrum::before {
      background:
        radial-gradient(ellipse at 23% 24%, #69e5ff 0%, #677dffcc 12%, #8178ed00 36%),
        radial-gradient(ellipse at 81% 80%, #a478ff 0%, #6c99ffb3 12%, #6c99ff00 38%);
      animation: aura-cool 3.8s cubic-bezier(.4,0,.6,1) -.9s infinite alternate; }
    .spectrum::after {
      background:
        radial-gradient(ellipse at 76% 22%, #f69fce 0%, #d779ffb3 12%, #d779ff00 36%),
        radial-gradient(ellipse at 24% 82%, #ffbf87 0%, #fc849dbf 14%, #fc849d00 40%);
      animation: aura-warm 5.1s cubic-bezier(.4,0,.6,1) -2.6s infinite alternate; }
    .diffuse { filter: blur(20px); opacity: .28; }
    .diffuse .band { inset: -14px; padding: 26px; }
    .bloom { filter: blur(9px); opacity: .52; }
    .bloom .band { inset: -7px; padding: 14px; }
    @keyframes aura-cool {
      0% { transform: translate(-8%, 5%) rotate(-28deg) scale(1.05); opacity: .64; }
      28% { transform: translate(12%, -9%) rotate(48deg) scale(1.1); opacity: .96; }
      64% { transform: translate(-4%, 12%) rotate(5deg) scale(.96); opacity: .72; }
      100% { transform: translate(8%, -4%) rotate(88deg) scale(1.06); opacity: .88; }
    }
    @keyframes aura-warm {
      0% { transform: translate(6%, -7%) rotate(62deg) scale(1.04); opacity: .84; }
      39% { transform: translate(-12%, 8%) rotate(-36deg) scale(1.1); opacity: .68; }
      72% { transform: translate(9%, 5%) rotate(29deg) scale(.96); opacity: .94; }
      100% { transform: translate(-5%, -11%) rotate(-78deg) scale(1.08); opacity: .74; }
    }
    @media (prefers-reduced-motion: reduce) {
      .surface { transition: none; }
      .spectrum::before, .spectrum::after { animation: none; }
    }
    @media print { .surface { display: none; } }
  </style><div class="surface"><div class="aura">
    <div class="layer diffuse"><div class="band"><div class="spectrum"></div></div></div>
    <div class="layer bloom"><div class="band"><div class="spectrum"></div></div></div>
  </div></div>`;
  const surface = shadow.querySelector('.surface');
  document.documentElement.append(overlay);
  const entrance = requestAnimationFrame(() => {
    // Establish the initial opacity before enabling the transition.
    surface.getBoundingClientRect();
    surface.classList.add('visible');
  });
  state = {
    token,
    expiresAt: Date.now() + leaseMs,
    frame: 0,
    timer: null,
    disposed: false,
    fadeTimer: null,
    dispose(immediate = false) {
      if (!state.disposed) {
        state.disposed = true;
        cancelAnimationFrame(entrance);
        clearInterval(state.timer);
        link.remove();
        for (const [node, record] of originals) restore(node, record);
        window.removeEventListener('pagehide', state.dispose);
        surface.classList.remove('visible');
      }
      const remove = () => {
        clearTimeout(state.fadeTimer);
        overlay.remove();
        if (globalThis[key] === state) delete globalThis[key];
      };
      if (immediate || reducedMotion.matches) remove();
      else if (!state.fadeTimer) state.fadeTimer = setTimeout(remove, 360);
    },
  };
  const tick = () => {
    if (state.disposed) return;
    if (Date.now() >= state.expiresAt) return state.dispose();
    const frame = reducedMotion.matches ? 0 : state.frame++ % frames.length;
    if (link.href !== frames[frame]) link.href = frames[frame];
    const currentIcons = new Set(document.querySelectorAll('link[rel~="icon"]'));
    currentIcons.delete(link);
    for (const [node, record] of originals) {
      if (!currentIcons.has(node)) {
        restore(node, record);
        originals.delete(node);
      }
    }
    for (const node of currentIcons) {
      let record = originals.get(node);
      if (!record) {
        const original = Object.fromEntries(attributes.map(name => [name, node.getAttribute(name)]));
        record = { original, written: { ...original } };
        originals.set(node, record);
      }
      rememberSiteChanges(node, record);
      record.written = { href: frames[frame], type: 'image/png', sizes: '32x32' };
      for (const [name, value] of Object.entries(record.written))
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }
    if (link.parentNode !== document.head) document.head.append(link);
    if (!overlay.isConnected) document.documentElement.append(overlay);
  };
  globalThis[key] = state;
  tick();
  state.timer = setInterval(tick, 160);
  window.addEventListener('pagehide', state.dispose, { once: true });
  return true;
}

export async function activityIconFrames(bitmap) {
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext('2d');
  const frames = [];
  for (let i = 0; i < 12; i++) {
    const breath = (1 - Math.cos(i / 12 * Math.PI * 2)) / 2;
    ctx.clearRect(0, 0, 32, 32);
    // Keep the site's icon legible at Chrome's normal 16px size. A 6px status
    // dot has a dark rim and a light outer keyline for light and dark tab bars.
    if (bitmap) ctx.drawImage(bitmap, 1, 1, 28, 28);
    else {
      ctx.fillStyle = '#4f6580';
      ctx.beginPath();
      ctx.arc(14, 14, 11, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.save();
    ctx.shadowColor = `rgba(45, 241, 193, ${0.35 + breath * 0.4})`;
    ctx.shadowBlur = 1 + breath * 2;
    ctx.fillStyle = '#effffb';
    ctx.beginPath();
    ctx.arc(24, 24, 7.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#103d36';
    ctx.beginPath();
    ctx.arc(24, 24, 6.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgb(${24 + Math.round(breath * 50)}, ${202 + Math.round(breath * 42)}, ${157 + Math.round(breath * 38)})`;
    ctx.beginPath();
    ctx.arc(24, 24, 5.5, 0, Math.PI * 2);
    ctx.fill();
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    frames.push(`data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`);
  }
  return frames;
}

export function createTabActivityRenderer(chromeApi) {
  const entries = new Map();
  const evaluate = (tabId, contextId, payload) => chromeApi.debugger.sendCommand(
    { tabId }, 'Runtime.evaluate', {
      contextId,
      expression: `(${updateActivityIndicator.toString()})(${JSON.stringify(payload)})`,
      returnByValue: true,
    },
  );
  async function refresh(tabId, entry) {
    if (entry.busy || entries.get(tabId) !== entry) return;
    entry.busy = true;
    try {
      if (!entry.contextId) {
        const [{ frameTree }, tab] = await Promise.all([
          chromeApi.debugger.sendCommand({ tabId }, 'Page.getFrameTree'),
          chromeApi.tabs.get(tabId),
        ]);
        const { executionContextId } = await chromeApi.debugger.sendCommand(
          { tabId }, 'Page.createIsolatedWorld', {
            frameId: frameTree.frame.id, worldName: 'browser-relay-activity',
          },
        );
        let bitmap;
        try {
          // Chrome's local favicon cache: no third-party favicon service and
          // no new requests to the user's websites to draw the indicator.
          const url = new URL(chromeApi.runtime.getURL('/_favicon/'));
          url.searchParams.set('pageUrl', tab.url);
          url.searchParams.set('size', '32');
          const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
          bitmap = await createImageBitmap(await response.blob());
        } catch { /* An iconless page still gets a small, consistent indicator. */ }
        let frames;
        try { frames = await activityIconFrames(bitmap); }
        finally { bitmap?.close(); }
        if (entries.get(tabId) !== entry) return;
        entry.contextId = executionContextId;
        await evaluate(tabId, entry.contextId, { token: entry.token, frames });
      } else {
        const result = await evaluate(tabId, entry.contextId, { token: entry.token });
        if (result.result?.value !== true) entry.contextId = null;
      }
    } catch {
      entry.contextId = null;
      // Cosmetic failure must never fail or replay a browser action. A later
      // refresh can recover after navigation or a debugger wake-up.
    } finally {
      entry.busy = false;
      if (entries.get(tabId) === entry)
        entry.timer = setTimeout(() => void refresh(tabId, entry), 1000);
      else if (entry.contextId)
        void evaluate(tabId, entry.contextId, { token: entry.token, stop: true }).catch(() => {});
    }
  }
  function stop(tabId) {
    const entry = entries.get(tabId);
    if (!entry) return;
    entries.delete(tabId);
    clearTimeout(entry.timer);
    if (entry.contextId)
      void evaluate(tabId, entry.contextId, { token: entry.token, stop: true }).catch(() => {});
  }
  return {
    start(tabId) {
      if (entries.has(tabId)) return;
      const entry = { contextId: null, timer: null, busy: false, token: crypto.randomUUID() };
      entries.set(tabId, entry);
      void refresh(tabId, entry);
    },
    stop,
    navigated(tabId, running) {
      stop(tabId);
      if (running) this.start(tabId);
    },
  };
}
