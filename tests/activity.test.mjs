import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityTracker, isUserCdpCommand } from '../extension/activity.js';
import { createAutomation } from '../extension/automation.js';

test('automatic debugger subscriptions and discovery are not user work', () => {
  for (const method of ['Runtime.enable', 'Runtime.disable', 'Log.enable', 'Network.enable', 'Page.enable', 'Accessibility.enable', 'Target.setAutoAttach', 'Target.getTargetInfo', 'Page.getFrameTree', 'Browser.getVersion'])
    assert.equal(isUserCdpCommand(method), false, method);
  for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Input.dispatchMouseEvent', 'Page.navigate', 'Page.captureScreenshot', 'DOMSnapshot.captureSnapshot', 'Accessibility.getFullAXTree'])
    assert.equal(isUserCdpCommand(method), true, method);
});

test('overlapping operations and stale completions cannot hide another task', async () => {
  const events = [];
  const activity = createActivityTracker({ show: id => events.push(['show', id]), hide: id => events.push(['hide', id]), settleMs: 10 });
  const endFirst = activity.begin(1), endSecond = activity.begin(1);
  endFirst(true);
  assert.equal(activity.running(1), true);
  assert.deepEqual(events, [['show', 1]]);
  activity.clear(1);
  const endNew = activity.begin(1);
  endSecond(true);
  assert.equal(activity.running(1), true);
  endNew();
  endNew();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(activity.active(1), false);
  assert.deepEqual(events, [['show', 1], ['hide', 1], ['show', 1], ['hide', 1]]);
});

test('task activity spans execution and ends on cancellation, not on polling or heartbeats', async () => {
  const events = [];
  const executor = createAutomation({
    resolveTab: async () => 1,
    onActivity: tabId => {
      events.push(['start', tabId]);
      let ended = false;
      return immediate => { if (!ended) events.push(['end', tabId, immediate]); ended = true; };
    },
    send: async (_tab, method, params) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('Promise'))
        return new Promise(() => {});
      return { result: { value: {} } };
    },
  });
  const payload = { sessionId: 'activity', tabId: 't_AAAAAAAAAA' };
  await executor.request('POST', '/api/tabs/claim', payload);
  await executor.request('POST', '/api/sessions', { sessionId: 'activity', action: 'heartbeat' });
  assert.deepEqual(events, []);
  const pending = executor.request('POST', '/api/read', payload).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events, [['start', 1]]);
  await executor.request('POST', '/api/sessions', { sessionId: 'activity', action: 'stop' });
  await pending;
  assert.deepEqual(events, [['start', 1], ['end', 1, true]]);
});
