import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setupBrowser, waitFor } from './helpers/real-browser.mjs';
import { createBrowser, createTransport } from '../server/sdk.js';
import { deriveRouteId } from '../server/remote-protocol.js';

test('real Chrome groups through local relay and remote Hub', { skip: process.env.BROWSER_RELAY_E2E !== '1', timeout: 60000 }, async t => {
  const env = await setupBrowser();
  t.after(env.close);
  const target = (await env.browser.tabs()).find(tab => tab.id === env.tab.id);
  assert.equal(typeof target.chromeTabId, 'number');
  const { group } = await env.browser.groups.create({ chromeTabIds: [target.chromeTabId], title: '资料收集', color: 'blue' });
  assert.equal((await env.browser.groups.tabs(group.id)).tabs[0].id, target.id);
  await env.browser.groups.update({ groupId: group.id, title: '', collapsed: false });
  assert.equal((await env.browser.groups.list({ title: '' })).groups[0].id, group.id);

  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const hub = spawn(process.execPath, ['server/hub-server.js'], { env: { ...process.env, BROWSER_RELAY_HUB_PORT: String(port) }, stdio: 'ignore' });
  t.after(() => hub.kill());
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok);
  const secret = randomBytes(24).toString('base64url');
  await env.worker.evaluate(config => chrome.storage.local.set(config), {
    remoteControlEnabled: true, remoteHost: `http://127.0.0.1:${port}`,
    remoteRouteId: deriveRouteId(secret), remoteSecret: secret, remoteDeviceId: `br-${secret}`,
  });
  const popup = await env.context.newPage();
  await popup.goto(env.worker.url().replace('/background.js', '/popup.html'));
  assert.equal((await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'enableRemoteControl' }))).connected, true);
  const remote = createBrowser({ request: createTransport({ remoteDeviceId: `br-${secret}`, remoteHost: `http://127.0.0.1:${port}` }) });
  assert.equal((await remote.groups.tabs(group.id)).tabs[0].id, target.id);
  await remote.groups.update({ groupId: group.id, title: '远程更新', collapsed: false });
  assert.equal((await remote.groups.list({ title: '远程更新' })).groups.length, 1);
  await remote.groups.removeTabs([target.chromeTabId]);
  assert.equal((await remote.tabs()).find(tab => tab.id === target.id).groupId, -1);
  await assert.rejects(remote.groups.tabs(group.id), { code: 'GROUP_NOT_FOUND' });
});
