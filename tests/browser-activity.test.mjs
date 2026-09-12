import test from 'node:test';
import assert from 'node:assert/strict';
import { setupBrowser, waitFor } from './helpers/real-browser.mjs';
import { updateActivityIndicator } from '../extension/activity.js';

test('short operations remain visibly active across a normal gap between calls', {
  skip: process.env.BROWSER_RELAY_E2E !== '1', timeout: 20000,
}, async t => {
  const env = await setupBrowser({ fixtureFile: 'activity.html' });
  t.after(env.close);
  const { page, tab } = env;
  const marker = 'link[data-browser-relay-activity]';
  const overlay = '[data-browser-relay-overlay]';
  await tab.read();
  await waitFor(async () => (await page.locator(marker).count()) === 1);
  await page.evaluate(() => {
    window.firstActivityOverlay = document.querySelector('[data-browser-relay-overlay]');
    window.activityFrames = new Set();
    window.activityFrameObserver = new MutationObserver(() => {
      const icon = document.querySelector('link[data-browser-relay-activity]');
      if (icon) window.activityFrames.add(icon.href);
    });
    window.activityFrameObserver.observe(document.head, { subtree: true, attributes: true, attributeFilter: ['href'] });
  });
  // A real read has already completed. Keep observing across a full favicon
  // cycle instead of stretching the operation with an artificial wait job.
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(await page.locator(marker).count(), 1, 'a completed short read must remain visibly active for a full animation cycle');
  assert((await page.evaluate(() => window.activityFrames.size)) >= 8, 'the actual website icon must animate');
  await tab.read();
  assert.equal(await page.evaluate(() => window.firstActivityOverlay === document.querySelector('[data-browser-relay-overlay]')), true, 'the next read must reuse the visible overlay instead of fading out and starting again');
  await waitFor(async () => (await page.locator(marker).count()) === 0 && (await page.locator(overlay).count()) === 0);
  await page.evaluate(() => window.activityFrameObserver.disconnect());
});

test('activity only decorates working tabs and restores live website favicons', {
  skip: process.env.BROWSER_RELAY_E2E !== '1', timeout: 45000,
}, async t => {
  const env = await setupBrowser({ fixtureFile: 'activity.html' });
  t.after(env.close);
  const { context, page, tab, browser, fixtureUrl, worker } = env;
  const marker = 'link[data-browser-relay-activity]';
  const overlay = '[data-browser-relay-overlay]';
  const layout = () => page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, button: document.querySelector('#complete').getBoundingClientRect().toJSON() }));
  const originalLayout = await layout();
  const original = await page.locator('#site-icon').getAttribute('href');
  const getChromeTab = url => worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url), url);
  const waitForAttached = async url => {
    const native = await getChromeTab(url);
    await waitFor(() => worker.evaluate(async id => (await chrome.action.getBadgeText({ tabId: id })) === 'ON', native.id));
  };
  await waitFor(async () => (await getChromeTab(fixtureUrl))?.favIconUrl);

  // A normal new tab triggers auto-attach and daemon log subscriptions, but
  // should never receive an activity marker or title prefix.
  const ordinary = await context.newPage();
  await ordinary.addInitScript(() => {
    window.observedTitles = [];
    new MutationObserver(() => window.observedTitles.push(document.title))
      .observe(document, { subtree: true, childList: true, characterData: true });
  });
  await ordinary.goto(fixtureUrl + '?ordinary');
  await waitForAttached(fixtureUrl + '?ordinary');
  assert.equal(await ordinary.title(), 'Activity fixture');
  assert.equal(await ordinary.locator(marker).count(), 0);
  assert.equal(await ordinary.locator(overlay).count(), 0);
  assert.equal(await page.title(), 'Activity fixture');
  assert.equal(await page.locator(marker).count(), 0);

  const job = await tab.act([{ type: 'wait', target: { selector: '#ready' }, state: 'visible', timeoutMs: 12000 }], { async: true });
  await waitFor(async () => (await page.locator(marker).count()) === 1);
  assert.equal(await page.locator(overlay).count(), 1);
  assert.deepEqual(await layout(), originalLayout, 'edge overlay must not alter the website layout');
  assert.deepEqual(await page.locator(overlay).evaluate(node => ({ ariaHidden: node.getAttribute('aria-hidden'), pointerEvents: getComputedStyle(node).pointerEvents, shadowRoot: node.shadowRoot, width: node.getBoundingClientRect().width, viewport: innerWidth })), { ariaHidden: 'true', pointerEvents: 'none', shadowRoot: null, width: 1280, viewport: 1280 });
  assert.equal(await page.evaluate(() => { const node = document.querySelector('#complete'); const r = node.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node; }), true);
  const first = await page.locator(marker).getAttribute('href');
  await waitFor(async () => (await page.locator(marker).getAttribute('href')) !== first);
  assert.equal(await page.title(), 'Activity fixture');
  assert.match(await page.locator('#site-icon').getAttribute('href'), /^data:image\/png/);
  assert.equal(await ordinary.locator(marker).count(), 0);
  assert.equal(await ordinary.locator(overlay).count(), 0);
  await waitFor(async () => (await getChromeTab(fixtureUrl)).favIconUrl.startsWith('data:image/png'));
  const openedDuringWork = await context.newPage();
  await openedDuringWork.goto(fixtureUrl + '?during-work');
  await waitForAttached(fixtureUrl + '?during-work');
  assert.equal(await openedDuringWork.locator(marker).count(), 0);
  assert.equal(await openedDuringWork.locator(overlay).count(), 0);
  assert.equal(await openedDuringWork.title(), 'Activity fixture');
  assert.equal(await ordinary.evaluate(() => window.observedTitles.some(title => /🔵|⚪/.test(title))), false);

  // The page may replace its icon/title while BR is working. Cleanup must
  // preserve the newest site-owned state, not replay a stale saved value.
  const nextIcon = original.replace('%23233553', '%2355316e');
  await page.evaluate(next => {
    document.title = 'Updated by website';
    document.querySelector('#site-icon').href = next;
  }, nextIcon);
  await page.bringToFront();
  await page.locator('#complete').click(); // The real page control remains clickable through the light.
  const completed = await browser.tasks.wait(job.id);
  assert.doesNotMatch(completed.observation.snapshot, /data:image|browserRelayActivity|aura-cool|aura-warm|🔵|⚪/);
  await waitFor(async () => (await page.locator(marker).count()) === 0 && (await page.locator(overlay).count()) === 0);
  assert.equal(await page.title(), 'Updated by website');
  assert.equal(await page.locator('#site-icon').getAttribute('href'), nextIcon);
  await waitFor(async () => (await getChromeTab(fixtureUrl)).favIconUrl === nextIcon);

  const pending = await tab.act([{ type: 'wait', target: { selector: '#never' }, timeoutMs: 12000 }], { async: true });
  await waitFor(async () => (await page.locator(marker).count()) === 1);
  await browser.tasks.cancel(pending.id);
  await waitFor(async () => (await page.locator(marker).count()) === 0 && (await page.locator(overlay).count()) === 0);
  await browser.heartbeat();
  assert.equal(await page.locator(marker).count(), 0);

  // A task-triggered navigation resumes the indicator on the new document;
  // reduced-motion users get a steady edge and status dot.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const navigation = await tab.act([
    { type: 'navigate', url: fixtureUrl + '?task-navigation' },
    { type: 'wait', target: { selector: '#ready' }, timeoutMs: 12000 },
  ], { async: true });
  await waitFor(async () => page.url().endsWith('?task-navigation') && (await page.locator(marker).count()) === 1);
  const steady = await page.locator(marker).getAttribute('href');
  // Observe several known animation ticks to assert the absence of motion.
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await page.locator(marker).getAttribute('href'), steady);
  await browser.tasks.cancel(navigation.id);
  await waitFor(async () => (await page.locator(marker).count()) === 0 && (await page.locator(overlay).count()) === 0);
  assert.equal(await page.title(), 'Activity fixture');
  assert.equal(await page.locator('#site-icon').getAttribute('href'), original);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(updateActivityIndicator, { token: 'old-owner', frames: [first] });
  await page.evaluate(updateActivityIndicator, { token: 'old-owner', stop: true });
  await page.evaluate(updateActivityIndicator, { token: 'new-owner', frames: [first] });
  await page.evaluate(updateActivityIndicator, { token: 'old-owner', stop: true });
  assert.equal(await page.locator(overlay).count(), 1);
  await page.evaluate(updateActivityIndicator, { token: 'new-owner', stop: true });
  await waitFor(async () => (await page.locator(overlay).count()) === 0);

  // If the service worker disappears, the page-side lease cleans up by itself.
  await page.evaluate(updateActivityIndicator, { token: 'expired-owner', frames: [first], leaseMs: 200 });
  await waitFor(async () => (await page.locator(marker).count()) === 0 && (await page.locator(overlay).count()) === 0);
  assert.equal(await page.locator('#site-icon').getAttribute('href'), original);
});
