import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {setupBrowser,waitFor} from './helpers/real-browser.mjs';

const options={skip:!process.env.BROWSER_RELAY_E2E,timeout:120000};
test('review regressions through the actual extension',options,async t=>{
 const env=await setupBrowser({fixtureFile:'reading.html'});
 t.after(env.close);const {tab,browser,page,fixtureUrl,request,port}=env;
 await t.test('CSS subtree, original document order and independent article labels',async()=>{
  const css=await tab.read({target:{selector:'article[aria-label="Post 1"]'}});
  assert.match(css.snapshot,/END_POST_1/);assert.doesNotMatch(css.snapshot,/END_POST_2/);
  await tab.eval(`document.body.innerHTML='<main><article aria-label="Alice"><p>STEP_ONE</p><h2>STEP_TWO</h2><p>STEP_THREE</p><a href="/next">STEP_FOUR</a></article><article aria-label="Bob"><p>Same body</p></article></main>'`);
  const text=(await tab.read()).snapshot;
  assert.match(text,/article "Alice"/);assert.match(text,/article "Bob"/);
  const positions=['STEP_ONE','STEP_TWO','STEP_THREE','STEP_FOUR'].map(s=>text.indexOf(s));
  assert.ok(positions.every((p,i)=>p>=0 && (i===0 || p>positions[i-1])),text);
  await tab.eval(`document.body.innerHTML='<div id="wrapper"><p id="paragraph">PLAIN_PARAGRAPH</p><p>SECOND_PARAGRAPH</p></div><p>OUTSIDE_WRAPPER</p>'`);
  const wrapper=await tab.locator('#wrapper').read();assert.match(wrapper.snapshot,/PLAIN_PARAGRAPH/);assert.match(wrapper.snapshot,/SECOND_PARAGRAPH/);assert.doesNotMatch(wrapper.snapshot,/OUTSIDE_WRAPPER/);
  const paragraph=await tab.locator('#paragraph').read();assert.match(paragraph.snapshot,/PLAIN_PARAGRAPH/);assert.doesNotMatch(paragraph.snapshot,/SECOND_PARAGRAPH/);
 });
 await t.test('main reading includes same-origin and cross-origin frames only inside its scope',async()=>{
  const cross=fixtureUrl.replace('127.0.0.1','localhost')+'frame?cross';
  await tab.eval(`document.body.innerHTML='<main><article aria-label="Embedded"><p>BEFORE_FRAME</p><iframe title="Same" src="/frame"></iframe><iframe title="Cross" src="${cross}"></iframe><p>AFTER_FRAME</p></article></main><iframe title="Outside" srcdoc="<main>OUTSIDE_MAIN</main>"></iframe>'`);
  await tab.act([{type:'wait',target:{role:'button',name:'Frame action'},timeoutMs:3000},{type:'wait',target:{role:'button',name:'Cross frame'},timeoutMs:3000}],{observe:'none'});
  const o=await tab.read({maxLength:100000});
  assert.match(o.snapshot,/Frame action/);assert.match(o.snapshot,/Cross frame/);
  assert.doesNotMatch(o.snapshot,/OUTSIDE_MAIN/);
  assert.ok(o.snapshot.indexOf('BEFORE_FRAME')<o.snapshot.indexOf('Frame action'));
  assert.ok(o.snapshot.indexOf('Cross frame')<o.snapshot.indexOf('AFTER_FRAME'));
  assert.deepEqual(o.warnings,[]);
  const subtree=await tab.locator('article').read();assert.match(subtree.snapshot,/Cross frame/);
  const frame=o.frames.find(f=>f.url===cross);
  const inside=await tab.read({target:{selector:'button',frameId:frame.id}});assert.match(inside.snapshot,/Cross frame/);
 });
 await t.test('an embedded main does not hide the outer document when no top-level main exists',async()=>{
  await tab.eval(`document.body.innerHTML='<p>OUTER_DOCUMENT</p><iframe srcdoc="<main><button>INNER_DOCUMENT</button></main>"></iframe>'`);
  await tab.act([{type:'wait',target:{role:'button',name:'INNER_DOCUMENT'},timeoutMs:3000}],{observe:'none'});
  const o=await tab.read();assert.equal(o.scope,'page');assert.match(o.snapshot,/OUTER_DOCUMENT/);assert.match(o.snapshot,/INNER_DOCUMENT/);
 });
 for(const mode of ['raw-http-abort','sdk-abort','sdk-timeout']) await t.test(`${mode} prevents actions after the interruption`,async()=>{
  await tab.eval(`document.body.innerHTML='<button id="start">Start</button><button id="commit">Commit</button>';window.commits=0;window.started=false;document.querySelector('#start').onclick=()=>window.started=true;document.querySelector('#commit').onclick=()=>window.commits++`);
  const taskId=`job_${randomUUID()}`,controller=new AbortController();
  const actions=[{type:'click',target:{selector:'#start'}},{type:'wait',target:{selector:'#ready'},timeoutMs:3000},{type:'click',target:{selector:'#commit'}}];
  let result;
  if(mode==='raw-http-abort') result=fetch(`http://127.0.0.1:${port}/api/actions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tabId:tab.id,sessionId:browser.sessionId,taskId,actions,observe:'none'}),signal:controller.signal}).catch(e=>e);
  else result=tab.act(actions,{taskId,observe:'none',signal:controller.signal,requestTimeoutMs:mode==='sdk-timeout'?400:5000}).catch(e=>e);
  await waitFor(()=>page.evaluate(()=>started));
  if(mode!=='sdk-timeout')controller.abort();
  const error=await result;
  if(mode!=='raw-http-abort') {assert.equal(error.code,mode==='sdk-timeout'?'request_timeout':'request_cancelled');assert.equal(error.payload.retryable,false);assert.equal(error.payload.taskId,taskId);}
  const done=await waitFor(async()=>{const job=await browser.tasks.get(taskId);return job.finishedAt && job;});
  assert.equal(done.status,'cancelled');assert.equal(await page.evaluate(()=>commits),0);
 });
 await t.test('browser CDP metadata stays available while another tab is claimed',async()=>{
  const independent=await browser.open(fixtureUrl+'?independent=1');await independent.release();
  const client=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:5000});
  try {
    assert.match(client.version(),/\d+\.\d+/);
    const p=client.contexts()[0].pages().find(p=>p.url().includes('independent=1'));
    assert.ok(p);assert.equal(await p.evaluate(()=>6*7),42);
    await assert.rejects(()=>request('POST','/api/eval',{tabId:tab.id,expression:'1'}),{code:'tab_claimed'});
  } finally {await client.close();}
 });
 await browser.dispose();
});
