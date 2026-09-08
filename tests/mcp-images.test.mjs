import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

test("MCP NDJSON emits screenshots as images and round-trips split UTF-8 bytes", async (t) => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        data: "aW1hZ2U=",
        format: "png",
        width: 1,
        height: 1,
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const child = spawn(process.execPath, ["server/mcp-server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      BROWSER_RELAY_URL: `http://127.0.0.1:${server.address().port}`,
      BROWSER_RELAY_REMOTE_DEVICE_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_screenshot", arguments: {} },
    }) + "\n",
  );
  const message = JSON.parse((await lines.next()).value);
  assert.equal(message.result.content[0].type, "image");
  assert.equal(message.result.content[0].mimeType, "image/png");
  assert.doesNotMatch(message.result.content[1].text, /aW1hZ2U=/);
  const request = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "browser_exec",
        arguments: { code: '"中文与 emoji 🧪"' },
      },
    }) + "\n",
  );
  for (const byte of request) child.stdin.write(Buffer.from([byte]));
  const result = JSON.parse((await lines.next()).value);
  assert.equal(result.result.content[0].text, "中文与 emoji 🧪");
});
