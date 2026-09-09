import test from "node:test";
import assert from "node:assert/strict";
import { createTaskQueue, pause } from "../extension/tasks.js";
import { createScriptRuntime } from "../server/script-runtime.js";

test("task queue serializes each tab, allows independent tabs and cancels queued work", async () => {
  const q = createTaskQueue(),
    events = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const a = q.start("tab-a", async () => {
    events.push("a-start");
    await gate;
    events.push("a-end");
  });
  const b = q.start("tab-a", async () => events.push("b"));
  const c = q.start("tab-b", async () => events.push("c"));
  await c.done;
  assert.deepEqual(events, ["a-start", "c"]);
  q.cancel(b.id);
  release();
  assert.equal((await a.done).status, "completed");
  assert.equal((await b.done).status, "cancelled");
  assert.deepEqual(events, ["a-start", "c", "a-end"]);
});
test("failed tasks preserve earlier results and time limits release the tab queue", async () => {
  const q = createTaskQueue();
  const a = q.start("tab", async (job) => {
    job.results.push({ clicked: true });
    throw new Error("later failed");
  });
  const r = await a.done;
  assert.equal(r.status, "failed");
  assert.deepEqual(r.results, [{ clicked: true }]);
  const timeout = q.start("tab", async (_, signal) => pause(10000, signal), 10);
  assert.equal((await timeout.done).error.code, "task_timeout");
  assert.equal(
    (await q.start("tab", async () => ({ done: true })).done).status,
    "completed",
  );
});
test("runtime persists top-level await/bindings, bounds execution and resets state", async () => {
  const runtime = createScriptRuntime({
    request: async () => ({ ok: true, tabs: [] }),
  });
  try {
    assert.equal(
      (
        await runtime.execute({
          code: "var value = await Promise.resolve(7); value",
        })
      ).content[0].text,
      "7",
    );
    assert.equal(
      (await runtime.execute({ code: "value += 1; value" })).content[0].text,
      "8",
    );
    await assert.rejects(
      () => runtime.execute({ code: "while (true) {}", timeoutMs: 100 }),
      /timed out/,
    );
    assert.equal(
      (await runtime.execute({ code: "typeof value" })).content[0].text,
      "undefined",
    );
    assert.equal(
      (await runtime.execute({ code: "await browser.tabs()" })).isError,
      false,
    );
  } finally {
    await runtime.close();
  }
});
test("runtime timeout requests cancellation of a submitted browser task", async () => {
  let cancellation = false;
  const runtime = createScriptRuntime({
    request: async (method, path, body) => {
      if (path === "/api/actions") return new Promise(() => {});
      if (path.endsWith("/cancel")) {
        cancellation = true;
        return { ok: true };
      }
      return { ok: true };
    },
  });
  try {
    await assert.rejects(
      () =>
        runtime.execute({
          code: 'await browser.tab("t_AAAAAAAAAA").act([{type:"key",key:"Enter"}])',
          timeoutMs: 200,
        }),
      /timed out/,
    );
    assert.equal(cancellation, true);
  } finally {
    await runtime.close();
  }
});

test('runtime returns rejected top-level browser errors immediately and retains bindings',async()=>{
 const runtime=createScriptRuntime({request:async()=>{throw Object.assign(new Error('Another session owns this tab'),{code:'tab_claimed'})}});
 try{
  const failed=await runtime.execute({code:'var saved=17; await browser.tab("t_AAAAAAAAAA").read()',timeoutMs:1500});
  assert.equal(failed.isError,true);assert.match(failed.content[0].text,/tab_claimed/);
  assert.equal((await runtime.execute({code:'saved'})).content[0].text,'17');
 }finally{await runtime.close()}
});
test('cancellation recorded before dispatch prevents late-arriving work',async()=>{
 const q=createTaskQueue();const id='job_12345678-1234-1234-1234-123456789012';q.cancel(id,'task_cancelled','owner');
 let ran=false;assert.throws(()=>q.start('tab',async()=>{ran=true},1000,id,'owner'),{code:'task_cancelled'});assert.equal(ran,false);
});

test('runtime renders complete long observation strings, arrays and nested values', async () => {
  const snapshot = '正文'.repeat(8000) + 'READING_END_MARKER';
  const runtime = createScriptRuntime({ request: async () => ({ok:true,snapshot,truncated:false,nextCursor:null, records:Array.from({length:60},(_,i)=>i), nested:{a:{b:{c:{d:{e:{f:'DEEP_END'}}}}}}}) });
  try {
    const result=await runtime.execute({code:'await browser.tab("t_AAAAAAAAAA").read()'});
    const text=result.content.map(c=>c.text||'').join('');
    assert.equal(result.isError,false);
    assert.ok(text.includes(snapshot));
    assert.match(text,/58, 59/);
    assert.match(text,/DEEP_END/);
    assert.doesNotMatch(text,/more characters|more items|\[Object\]/);
  } finally { await runtime.close(); }
});

test('runtime output pagination recovers clipped observation text and metadata without another browser read',async()=>{
 let reads=0;
 const snapshot='😀'.repeat(15000)+'READING_END_MARKER';
 const runtime=createScriptRuntime({request:async(_m,p)=>{if(p==='/api/read')reads++;return {ok:true,snapshot,nextCursor:'obs_browser:123',truncated:true};}});
 try{
  let out=await runtime.execute({code:'print("L".repeat(85000)); await browser.tab("t_AAAAAAAAAA").read()'});
  assert.equal(out.runtimeOutput.truncated,true);
  const parts=[];
  while(out.runtimeOutput?.nextCursor){
   assert.equal(out.isError,false);
   const control=JSON.parse(out.content.at(-1).text);assert.equal(control.runtimeOutput.nextCursor,out.runtimeOutput.nextCursor);
   parts.push(...out.content.slice(0,-1).map(c=>c.text||''));
   out=await runtime.execute({code:`readOutput(${JSON.stringify(out.runtimeOutput.nextCursor)})`});
  }
  parts.push(...out.content.map(c=>c.text||''));
  const combined=parts.join('');assert.ok(combined.includes(snapshot));assert.match(combined,/obs_browser:123/);assert.equal(reads,1);
  assert.doesNotMatch(combined,/\uFFFD/);
 }finally{await runtime.close();}
});

test('runtime output cache eviction and oversized output are explicit',async()=>{
 const runtime=createScriptRuntime({request:async()=>({ok:true})});
 try{
  const first=await runtime.execute({code:'"x".repeat(100001)'});
  for(let i=0;i<3;i++)await runtime.execute({code:'"x".repeat(100001)'});
  const stale=await runtime.execute({code:`readOutput(${JSON.stringify(first.runtimeOutput.nextCursor)})`});
  assert.equal(stale.isError,true);assert.match(stale.content[0].text,/stale_output/);
  const tooBig=await runtime.execute({code:'"x".repeat(4200000)'});
  assert.equal(tooBig.isError,true);assert.equal(tooBig.runtimeOutput.code,'output_cache_limit');
 }finally{await runtime.close();}
});
