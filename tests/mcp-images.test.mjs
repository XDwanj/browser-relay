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

test('MCP combined observation preserves text and image metadata; cancellation cancels the submitted task',async t=>{
 let started;const start=new Promise(r=>started=r);const cancellations=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};res.setHeader('Content-Type','application/json');
  if(req.url==='/api/observe')res.end(JSON.stringify({ok:true,snapshot:'Complete content',screenshot:{data:'aW1hZ2U=',format:'png',screenshotId:'shot-test'}}));
  else if(req.url==='/api/actions'){started(body);req.on('close',()=>{});}
  else {if(req.url.includes('/cancel'))cancellations.push({url:req.url,body});res.end(JSON.stringify({ok:true}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});
 const child=spawn(process.execPath,['server/mcp-server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,BROWSER_RELAY_URL:`http://127.0.0.1:${server.address().port}`,BROWSER_RELAY_REMOTE_DEVICE_ID:''},stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();const send=m=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
 send({id:1,method:'tools/call',params:{name:'browser_observe',arguments:{tabId:'t_AAAAAAAAAA',mode:'both'}}});
 const both=JSON.parse((await lines.next()).value).result;assert.equal(both.content[0].type,'image');assert.match(both.content[1].text,/Complete content/);assert.match(both.content[1].text,/shot-test/);assert.doesNotMatch(both.content[1].text,/aW1hZ2U=/);
 send({id:2,method:'tools/call',params:{name:'browser_actions',arguments:{tabId:'t_AAAAAAAAAA',actions:[{type:'key',key:'Enter'}]}}});
 const task=await start;send({method:'notifications/cancelled',params:{requestId:2}});
 const cancelled=JSON.parse((await lines.next()).value);assert.equal(cancelled.result.isError,true);
 const error=JSON.parse(cancelled.result.content[0].text);assert.equal(error.code,'request_cancelled');assert.equal(error.retryable,false);assert.equal(error.taskId,task.taskId);assert.equal(error.sessionId,task.sessionId);
 const deadline=Date.now()+2000;while(cancellations.length===0 && Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.equal(cancellations[0].url,`/api/tasks/${task.taskId}/cancel`);assert.equal(cancellations[0].body.sessionId,task.sessionId);
});
