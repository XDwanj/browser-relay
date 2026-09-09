import test from "node:test";
import assert from "node:assert/strict";
import { createSessions } from "../extension/sessions.js";
import { createTaskQueue, pause } from "../extension/tasks.js";
test("leases reject competing and anonymous clients, transfer ownership and keep created-tab provenance", () => {
  const s = createSessions();
  s.claim("a", "alice", { created: true });
  assert.throws(() => s.check("a", "bob"), { code: "tab_claimed" });
  assert.throws(() => s.check("a"), { code: "tab_claimed" });
  const next = s.handoff("a", "alice", "bob");
  assert.equal(next.created, true);
  assert.equal(next.sessionId, "bob");
  assert.throws(() => s.release("a", "alice"), { code: "tab_claimed" });
  s.release("a", "bob");
  assert.equal(s.list().length, 0);
});
test("heartbeats renew leases; expiry cancels pending work and cannot silently revive the session", async () => {
  let time = 0;
  const q = createTaskQueue();
  const s = createSessions({
    now: () => time,
    ttlMs: 100,
    cancelTab: q.cancelTab,
    cancelSession: q.cancelSession,
    active: q.active,
  });
  s.claim("a", "alice");
  const job = q.start(
    "a",
    (_, signal) => pause(10000, signal),
    20000,
    undefined,
    "alice",
  );
  await new Promise((r) => setTimeout(r, 1));
  time = 80;
  s.touch("alice");
  time = 120;
  s.sweep();
  assert.equal(s.list().length, 1);
  assert.throws(() => s.handoff("a", "alice", "bob"), { code: "tab_busy" });
  time = 241;
  s.sweep();
  assert.equal((await job.done).error.code, "session_expired");
  assert.equal(s.list().length, 0);
  assert.throws(() => s.claim("a", "alice"), { code: "session_expired" });
  s.claim("a", "new-alice");
});

test('remote focus keeps its transport and disconnect stops only remote leases',async()=>{
 const {createAutomation}=await import('../extension/automation.js');
 const executor=createAutomation({
  resolveTab:async id=>id==='t_AAAAAAAAAA'?1:2,
  focusTab:async()=>{},
  send:async()=>({result:{value:{url:'https://fixture.test',viewport:{width:800,height:600},readyState:'complete'}}}),
 });
 await executor.request('POST','/api/tabs/claim',{tabId:'t_BBBBBBBBBB',sessionId:'local-reader'},'local');
 await executor.request('POST','/api/tabs/focus',{tabId:'t_AAAAAAAAAA',sessionId:'remote-reader',observe:'none'},'remote');
 executor.disconnect('remote');
 assert.deepEqual(executor.sessions.list().map(c=>c.sessionId),['local-reader']);
 await assert.rejects(()=>executor.request('POST','/api/sessions',{sessionId:'remote-reader',action:'heartbeat'},'remote'),{code:'extension_disconnected'});
 assert.equal((await executor.request('POST','/api/sessions',{sessionId:'local-reader',action:'heartbeat'},'local')).ok,true);
 executor.disconnect('local');
});
