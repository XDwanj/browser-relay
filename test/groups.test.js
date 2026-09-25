import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { createBrowserCommandHandler, validateGroupCommand } from '../extension/groups.js';
import { createClient } from '../server/client.js';

function fixture() {
  const groups = new Map([[7, { id: 7, title: 'Project', color: 'blue', collapsed: true, windowId: 1 }],
    [8, { id: 8, title: 'Project', color: 'red', collapsed: false, windowId: 2 }]]);
  const tabs = new Map([
    [101, { id: 101, title: 'Attached', url: 'https://example.com', windowId: 1, groupId: 7 }],
    [102, { id: 102, title: 'Unattached', url: 'chrome://settings', windowId: 1, groupId: 7 }],
    [103, { id: 103, title: 'Other window', windowId: 2, groupId: 8 }],
  ]);
  const attached = new Map([[101, { state: 'connected', targetId: 'TARGET', sessionId: 'SESSION' }]]);
  let nextId = 9;
  const calls = [];
  function get(map, id) { if (!map.has(id)) throw new Error('Not found'); return map.get(id); }
  function clean() { for (const id of groups.keys()) if (![...tabs.values()].some(tab => tab.groupId === id)) groups.delete(id); }
  const chrome = {
    tabs: {
      get: async id => get(tabs, id),
      query: async query => [...tabs.values()].filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value)),
      group: async options => {
        calls.push(options);
        const id = options.groupId ?? nextId++;
        if (!groups.has(id)) groups.set(id, { id, title: '', color: 'grey', collapsed: false, windowId: options.createProperties.windowId });
        for (const tabId of options.tabIds) get(tabs, tabId).groupId = id;
        clean();
        return id;
      },
      ungroup: async ids => { for (const id of ids) get(tabs, id).groupId = -1; clean(); },
    },
    tabGroups: {
      get: async id => get(groups, id),
      query: async query => [...groups.values()].filter(group => Object.entries(query).every(([key, value]) => group[key] === value)),
      update: async (id, changes) => Object.assign(get(groups, id), changes),
    },
  };
  return { chrome, attached, calls, handler: createBrowserCommandHandler(chrome, attached, () => 't_AAAAAAAAAA') };
}

test('discover duplicate titles and unattached members without debugger dependencies', async () => {
  const f = fixture();
  assert.equal((await f.handler('groups.list', { title: 'Project' })).groups.length, 2);
  assert.equal((await f.handler('groups.list', { windowId: 1 })).groups.length, 1);
  const { tabs } = await f.handler('groups.tabs', { groupId: 7 });
  assert.equal(tabs[0].id, 't_AAAAAAAAAA');
  assert.equal(tabs[1].id, null);
  assert.equal(tabs[1].chromeTabId, 102);
  assert.equal(tabs[1].attached, false);
  f.attached.clear();
  assert.equal((await f.handler('groups.tabs', { groupId: 7 })).tabs.length, 2);
  assert.deepEqual(await f.handler('tabs.list'), { tabs: [] });
});

test('create, update, move and ungroup preserve false and empty titles', async () => {
  const f = fixture();
  const { group } = await f.handler('groups.create', { chromeTabIds: [101], title: 'New', color: 'cyan', collapsed: true });
  const updated = await f.handler('groups.update', { groupId: group.id, title: '', collapsed: false });
  assert.equal(updated.group.title, '');
  assert.equal(updated.group.collapsed, false);
  await f.handler('groups.add-tabs', { groupId: group.id, chromeTabIds: [102] });
  await assert.rejects(f.handler('groups.tabs', { groupId: 7 }), { code: 'GROUP_NOT_FOUND' });
  await f.handler('groups.remove-tabs', { chromeTabIds: [101, 102] });
  await assert.rejects(f.handler('groups.tabs', { groupId: group.id }), { code: 'GROUP_NOT_FOUND' });
  assert.equal((await f.handler('tabs.list')).tabs[0].groupId, -1);
});

test('invalid IDs, unknown fields and cross-window operations fail before mutations', async () => {
  const f = fixture();
  for (const params of [null, [], { chromeTabIds: [] }, { chromeTabIds: [101, 101] }, { chromeTabIds: ['101'] }, { chromeTabIds: [101], color: 'black' }, { chromeTabIds: [101], collapsed: 'false' }, { chromeTabIds: [101], unexpected: true }]) {
    assert.throws(() => validateGroupCommand('create', params));
  }
  assert.throws(() => validateGroupCommand('update', { groupId: 7 }));
  await assert.rejects(f.handler('groups.create', { chromeTabIds: [101, 103] }), { code: 'CROSS_WINDOW' });
  await assert.rejects(f.handler('groups.add-tabs', { groupId: 8, chromeTabIds: [101] }), { code: 'CROSS_WINDOW' });
  await assert.rejects(f.handler('groups.create', { chromeTabIds: [101, 999] }), { code: 'TAB_NOT_FOUND' });
  assert.equal(f.calls.length, 0);
});

test('partial creation returns recoverable group ID', async () => {
  const f = fixture();
  f.chrome.tabGroups.update = async () => { throw new Error('Window closed'); };
  await assert.rejects(f.handler('groups.create', { chromeTabIds: [101], title: 'New' }),
    err => err.partial === true && err.groupId === 9 && err.status === 502);
  assert.equal(f.calls.length, 1);
});

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function runCli(url, args) {
  const child = spawn(process.execPath, ['server/cli.js', ...args], { env: { ...process.env, BROWSER_RELAY_REMOTE_DEVICE_ID: '', BROWSER_RELAY_URL: url } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

test('HTTP, WebSocket, SDK, CLI and MCP work together', { timeout: 15000 }, async t => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const relay = spawn(process.execPath, ['server/relay-server.js'], { env: { ...process.env, BROWSER_RELAY_PORT: String(port), BROWSER_RELAY_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => relay.kill());
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.once('exit', code => reject(new Error(`Relay exited ${code}`)));
    relay.stdout.on('data', chunk => { if (chunk.toString().includes('server.start')) resolve(); });
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  ws.send(JSON.stringify({ method: 'BrowserRelay.hello', params: { protocolVersion: 2, extensionVersion: '1.5.5', runtimeId: 'test', features: ['groups'] } }));
  const f = fixture();
  ws.on('message', async raw => {
    const msg = JSON.parse(raw);
    if (msg.method === 'ping') return ws.send(JSON.stringify({ method: 'pong' }));
    try {
      assert.equal(msg.method, 'forwardBrowserCommand');
      const result = await f.handler(msg.params.method, msg.params.params);
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, error: { message: err.message, status: err.status, code: err.code, partial: err.partial, groupId: err.groupId } }));
    }
  });
  const client = createClient(url);
  assert.equal((await client.tabs()).tabs[0].chromeTabId, 101);
  assert.equal((await client.groups.list()).groups.length, 2);
  assert.equal((await client.groups.tabs(7)).tabs.length, 2);
  const invalid = await fetch(`${url}/api/groups/tabs?groupId=`);
  assert.equal(invalid.status, 400);
  const badBody = await fetch(`${url}/api/groups/create`, { method: 'POST', body: '{' });
  assert.equal(badBody.status, 400);
  await assert.rejects(client.groups.tabs(999), { status: 404, code: 'GROUP_NOT_FOUND' });
  await assert.rejects(client.groups.addTabs({ groupId: 8, chromeTabIds: [101] }), { status: 409 });
  const created = await client.groups.create({ chromeTabIds: [101], title: 'New' });
  await client.groups.addTabs({ groupId: created.group.id, chromeTabIds: [102] });
  const cli = await runCli(url, ['groups', 'update', '--group-id', String(created.group.id), '--collapsed', 'false', '--title', '']);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).group.title, '');
  const badCli = await runCli(url, ['groups', 'create', '--chrome-tab-ids', '']);
  assert.equal(badCli.code, 1);
  await client.groups.removeTabs([101, 102]);
  f.chrome.tabGroups.update = async () => { throw new Error('Update failed'); };
  await assert.rejects(client.groups.create({ chromeTabIds: [101], title: 'New' }), err => err.partial && err.groupId === 10);
  const partialCli = await runCli(url, ['groups', 'create', '--chrome-tab-ids', '102', '--title', 'New']);
  assert.equal(partialCli.code, 1);
  assert.match(partialCli.stderr, /"partial":true,"groupId":11/);

  const mcp = spawn(process.execPath, ['server/mcp-server.js'], { env: { ...process.env, BROWSER_RELAY_REMOTE_DEVICE_ID: '', BROWSER_RELAY_URL: url } });
  t.after(() => mcp.kill());
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  mcp.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(buffer.subarray(0, end).toString().match(/Content-Length: (\d+)/)[1]);
      if (buffer.length < end + 4 + length) return;
      const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
      buffer = buffer.subarray(end + 4 + length);
      pending.get(msg.id)?.(msg.result);
      pending.delete(msg.id);
    }
  });
  let nextId = 0;
  function rpc(method, params) {
    const id = ++nextId;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise(resolve => {
      pending.set(id, resolve);
      mcp.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  }
  const listed = await rpc('tools/list');
  assert.equal(listed.tools.filter(tool => tool.name.startsWith('browser_groups_')).length, 6);
  const result = await rpc('tools/call', { name: 'browser_groups_list', arguments: { title: '资料收集' } });
  assert.equal(JSON.parse(result.content[0].text).ok, true);
  const failure = await rpc('tools/call', { name: 'browser_groups_create', arguments: { chromeTabIds: [101], title: 'Fail' } });
  assert.equal(failure.isError, true);
  assert.equal(JSON.parse(failure.content[0].text).partial, true);
});
