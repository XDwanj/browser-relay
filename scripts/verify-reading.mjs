// Read-only field check in an isolated Chrome profile with this checkout's
// extension. Browser operations use Relay SDK; the harness only boots Chrome.
import {setupBrowser} from '../tests/helpers/real-browser.mjs';
import {SNAPSHOT_JS} from '../extension/snapshot.js';
import {mkdir,writeFile} from 'node:fs/promises';
const output=process.argv[2] || '/tmp/browser-relay-parity-field';
await mkdir(output,{recursive:true});
const env=await setupBrowser({headed:true,fixtureFile:'reading.html'});
try{
 const {tab,browser}=env;const capability=await browser.capabilities();
 const started=Date.now();await tab.goto('https://zh.omarchy.org/');
 let result=await tab.read({maxLength:18000});let text=result.snapshot;let pages=1;
 while(result.nextCursor){result=await tab.read({cursor:result.nextCursor,maxLength:18000});text+=result.snapshot;pages++;}
 const legacy=JSON.parse(await tab.eval(SNAPSHOT_JS));
 const checks={main:text.includes('智能体时代')&&text.includes('安装 Omarchy'),legacy:legacy.snapshot.includes('智能体时代')&&legacy.snapshot.includes('安装 Omarchy'),fullLinks:/https:\/\/omarchy\.org\/manual\//.test(text)};
 await writeFile(output+'/omarchy-read.txt',text);await writeFile(output+'/omarchy-legacy.txt',legacy.snapshot);
 await tab.focus();const shot=await tab.screenshot();await writeFile(output+'/omarchy.png',Buffer.from(shot.data,'base64'));
 const summary={url:result.url,capability,elapsedMs:Date.now()-started,pages,readBytes:Buffer.byteLength(text),legacyBytes:Buffer.byteLength(legacy.snapshot),checks};
 await writeFile(output+'/summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
 if(Object.values(checks).some(v=>!v))process.exitCode=1;
 await browser.dispose();
}finally{await env.close()}
