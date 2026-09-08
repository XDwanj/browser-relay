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
