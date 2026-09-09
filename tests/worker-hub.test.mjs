import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
import { deriveRouteId } from '../server/remote-protocol.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;

const { BrowserRelayDevice } = await import('../hub/src/worker.js');

test('Cloudflare device claim rejects a different secret after first-frame auth', async () => {
  const device = new BrowserRelayDevice({}, {});
  const secret = 'G1PMrqZmTckQP63P';
  const routeId = deriveRouteId(secret);
  assert.deepEqual(await device.authorize(secret, { claim: true, routeId }), { ok: true, claimed: true });
  assert.deepEqual(await device.authorize(secret, { routeId }), { ok: true, claimed: false });
  const denied = await device.authorize('L2QNsrAnUdlRQ74Q', { routeId });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied).includes('L2QNsrAnUdlRQ74Q'), false);
});

test('Cloudflare first-writer claim requires the secret-derived route and resists concurrent claims', async () => {
  const device = new BrowserRelayDevice({}, {});
  const validSecret = 'G1PMrqZmTckQP63P';
  const routeId = deriveRouteId(validSecret);
  const attackerSecret = 'L2QNsrAnUdlRQ74Q';

  const [attacker, owner] = await Promise.all([
    device.authorize(attackerSecret, { claim: true, routeId }),
    device.authorize(validSecret, { claim: true, routeId }),
  ]);
  assert.equal(attacker.ok, false);
  assert.equal(attacker.status, 401);
  assert.equal(owner.ok, true);
  assert.deepEqual(await device.authorize(validSecret, { routeId }), { ok: true, claimed: false });
});

test('Cloudflare hub ignores hello and rpc responses from sockets that are not the authenticated device', () => {
  const device = new BrowserRelayDevice({}, {});
  const authenticated = {};
  const candidate = {};
  device.deviceSocket = authenticated;
  device.handleDeviceMessage(candidate, JSON.stringify({ type: 'device.hello', version: 'attacker' }));
  assert.equal(device.hello, null);

  device.handleDeviceMessage(authenticated, JSON.stringify({ type: 'device.hello', version: '1.3.0' }));
  assert.equal(device.hello.version, '1.3.0');
});

test('Cloudflare connect path authenticates before replacement and keeps query-token compatibility only in the hub', () => {
  const source = readFileSync(new URL('../hub/src/worker.js', import.meta.url), 'utf8');
  const connectBody = source.slice(source.indexOf('async handleDeviceConnect'), source.indexOf('handleDeviceMessage(socket'));

  assert.match(connectBody, /DEVICE_AUTH_TIMEOUT_MS/);
  assert.match(connectBody, /msg\.type === "device\.auth"/);
  assert.match(connectBody, /device\.authenticated/);
  assert.match(connectBody, /url\.searchParams\.get\("token"\)/);
  assert.match(connectBody, /authenticate\(legacySecret\)/);
  assert.ok(connectBody.indexOf('await this.authorize') < connectBody.indexOf('this.deviceSocket = server'));
});

test('Worker forwarding preserves abort signals and cancels the dispatched task',async()=>{
 const {default:worker}=await import('../hub/src/worker.js');
 const device=new BrowserRelayDevice({},{});
 const secret='G1PMrqZmTckQP63P',routeId=deriveRouteId(secret);
 await device.authorize(secret,{claim:true,routeId});
 const sent=[];let started;
 const start=new Promise(r=>started=r);
 device.deviceSocket={readyState:1,send:raw=>{sent.push(JSON.parse(raw));started();}};
 const env={DEVICES:{idFromName:id=>id,get:()=>({fetch:r=>device.fetch(r)})}};
 const controller=new AbortController();
 const result=worker.fetch(new Request('https://hub.test/v1/rpc',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:JSON.stringify({routeId,method:'POST',path:'/api/actions',body:{sessionId:'owner',actions:[{type:'key',key:'Enter'}]}}),signal:controller.signal}),env);
 await start;controller.abort();
 const response=await result;const error=await response.json();
 assert.equal(error.code,'request_cancelled');assert.equal(error.retryable,false);assert.equal(error.taskId,sent[0].body.taskId);assert.equal(sent[1].path,`/api/tasks/${error.taskId}/cancel`);assert.equal(device.pending.size,0);
});
