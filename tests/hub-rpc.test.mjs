import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {sendRpc} from '../hub/src/rpc.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

for(const mode of ['abort','timeout']) test(`hub RPC ${mode} cancels queued work without relying on an SDK`,async()=>{
 const pending=new Map(),sent=[],controller=new AbortController();
 const result=sendRpc({send:raw=>sent.push(JSON.parse(raw))},pending,{method:'POST',path:'/api/actions',body:{sessionId:'owner',actions:[{type:'key',key:'Enter'}]}},{signal:controller.signal,timeoutMs:20}).catch(e=>e);
 if(mode==='abort')controller.abort();
 const error=await result;
 assert.equal(error.code,mode==='abort'?'request_cancelled':'remote_request_timeout');assert.equal(error.retryable,false);
 assert.equal(error.taskId,sent[0].body.taskId);assert.equal(error.sessionId,'owner');assert.equal(error.cancellationRequested,true);
 assert.equal(sent[1].path,`/api/tasks/${error.taskId}/cancel`);assert.equal(sent[1].body.sessionId,'owner');assert.equal(pending.size,0);
});

test('a completed async RPC is not cancelled when its original request signal closes',async()=>{
 const pending=new Map(),sent=[],c=new AbortController();
 const result=sendRpc({send:raw=>sent.push(JSON.parse(raw))},pending,{id:'one',method:'POST',path:'/api/actions',body:{async:true,sessionId:'owner'}},{signal:c.signal});
 pending.get('one').resolve({status:200,body:{task:{status:'queued'}}});
 await result;c.abort();assert.equal(sent.length,1);assert.equal(pending.size,0);
});

test('pre-aborted RPC sends no browser commands',async()=>{
 let sends=0;const c=new AbortController();c.abort();
 await assert.rejects(()=>sendRpc({send:()=>sends++},new Map(),{method:'POST',path:'/api/actions',body:{}},{signal:c.signal}),e=>e.code==='request_cancelled');
 assert.equal(sends,0);
});
