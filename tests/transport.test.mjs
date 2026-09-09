import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createTransport} from '../server/sdk.js';

for (const remote of [false,true]) {
  for (const mode of ['abort','timeout','hub-timeout']) {
    test(`${remote?'remote':'local'} transport ${mode} cancels the exact task and retains progress`,async t=>{
      let started, sent, cancelled;
      const start=new Promise(r=>started=r);
      const server=createServer(async(req,res)=>{
        let raw='';for await(const chunk of req)raw+=chunk;
        const parsed=raw?JSON.parse(raw):{};
        const path=remote?parsed.path:req.url, body=remote?parsed.body:parsed;
        res.setHeader('Content-Type','application/json');
        if(path==='/api/actions') {
          sent=body;started();
          if(mode==='hub-timeout') {res.writeHead(504);res.end(JSON.stringify({ok:false,code:'remote_request_timeout',retryable:true,message:'RPC timeout'}));}
        } else if(path.endsWith('/cancel')) {
          cancelled={path,body};
          res.end(JSON.stringify({ok:true,task:{id:body.taskId||sent.taskId,status:'cancelled',completedActions:1,results:[{clicked:true}]}}));
        } else res.end(JSON.stringify({ok:true}));
      });
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      t.after(()=>{server.closeAllConnections();server.close();});
      const url=`http://127.0.0.1:${server.address().port}`;
      const request=createTransport({url,remoteHost:url,remoteDeviceId:remote?'br-abcdefghijklmnopqrstuvwx':''});
      const controller=new AbortController();
      const result=request('POST','/api/actions',{sessionId:'owner',actions:[{type:'key',key:'Enter'}]},{signal:controller.signal,timeoutMs:mode==='timeout'?100:2000}).catch(e=>e);
      await start;if(mode==='abort')controller.abort();
      const error=await result;
      assert.equal(error.code,mode==='abort'?'request_cancelled':mode==='timeout'?'request_timeout':'remote_request_timeout');
      assert.equal(error.payload.retryable,false);
      assert.match(error.payload.taskId,/^job_/);
      assert.equal(error.payload.task.completedActions,1);
      assert.equal(cancelled.path,`/api/tasks/${sent.taskId}/cancel`);
      assert.equal(cancelled.body.sessionId,'owner');
    });
  }
}
