import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { WebSocket } from 'ws';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'chisa-revocation-idb-'));
const bundle = path.join(temporary, 'check.js');
const output = path.join(temporary, 'check.html');
const browser = process.env.CHISA_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const source = path.join(root, 'modules', 'auth', 'web-revocation.service.ts');
const harness = `import { createWebRevocationQueue } from ${JSON.stringify(source)};
const encode = value => btoa(JSON.stringify(value)).replace(/=+$/,'').replace(/\\+/g,'-').replace(/\\//g,'_');
const currentServer = 'https://browser-test.invalid/instances/one';
const make = i => ({ key:encodeURIComponent(currentServer)+':login-'+i+':0', format:1, serverKey:currentServer, incarnation:'login-'+i, revision:0, sessionId:'sid-'+i, userId:String(i), token:encode({alg:'HS256'})+'.'+encode({exp:4102444800,sid:'sid-'+i})+'.signature', expiresAt:4102444800 });
async function run() {
 const queue = createWebRevocationQueue(); const entries = await queue.list(currentServer);
 if (!entries.length) {
  const results = await Promise.allSettled(Array.from({length:33},(_,i)=>queue.reserve(make(i),1800000000)));
  const after = await queue.list(currentServer);
  if (results.filter(r=>r.status==='fulfilled').length!==32 || results.filter(r=>r.status==='rejected').length!==1 || after.length!==32) throw Error('Atomic capacity failed');
  return { phase:'reserved', live:after.length, rejected:1 };
 }
 if (entries.length!==32) throw Error('Close/reopen lost durable entries');
 const previous=entries[0]; await queue.removeExact({...previous,token:previous.token+'changed'});
 if ((await queue.list(currentServer)).length!==32) throw Error('Mismatched ACK removed entry');
 for (const item of entries) await queue.removeExact(item);
 if ((await queue.list(currentServer)).length!==0) throw Error('ACK cleanup failed');
 return { phase:'reopened', restored:32, removed:32 };
}
window.checkFinished=run().then(value=>{document.getElementById('result').textContent=JSON.stringify(value);return value;},error=>({error:String(error)}));`;
await build({ stdin: { contents: harness, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', platform: 'browser', outfile: bundle,
  plugins: [{ name: 'queue-isolation', setup(plugin) {
    plugin.onResolve({ filter: /^@\/shared\/(?:api|authToken)$/ }, args => ({ path: args.path, namespace: 'transport-stub' }));
    plugin.onLoad({ filter: /.*/, namespace: 'transport-stub' }, () => ({ contents: 'export const api={auth:{revokeCapturedWebSession(){throw Error("not used")}}}; export const endAuthSessionWithRevocation=()=>{throw Error("not used")};', loader: 'js' }));
  } }] });
const javascript = await readFile(bundle, 'utf8');
await writeFile(output, '<!doctype html><meta charset="utf-8"><pre id="result">pending</pre><script>' + javascript.replaceAll('</script', '<\\/script') + '</script>');
function cdp(socket) {
  let sequence = 0; const requests = new Map();
  socket.on('message', raw => { const message=JSON.parse(String(raw)); const entry=requests.get(message.id); if (!entry) return; requests.delete(message.id); if (message.error) entry.reject(Error(message.error.message)); else entry.resolve(message.result); });
  return (method, params={}) => new Promise((resolve,reject)=> { const id=++sequence; requests.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params})); });
}
async function launch(phase) {
  const stderr=path.join(temporary,phase+'.stderr.log'); const err=openSync(stderr,'w');
  const profile=path.join(temporary,'profile');
  const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore',err]});
  let socket;
  try {
    const deadline=Date.now()+10_000; let port;
    while(Date.now()<deadline) {
      const log=await readFile(stderr,'utf8'); port=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(log)?.[1]; if(port) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(port,'Isolated browser CDP was not available');
    const target=await (await fetch('http://127.0.0.1:'+port+'/json/new?'+encodeURIComponent(pathToFileURL(output).href),{method:'PUT'})).json();
    socket=new WebSocket(target.webSocketDebuggerUrl); await once(socket,'open'); const send=cdp(socket); await send('Runtime.enable');
    let result;
    while(Date.now()<deadline) {
      result=await send('Runtime.evaluate',{expression:'window.checkFinished',awaitPromise:true,returnByValue:true});
      if(result.result?.value) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(result.exceptionDetails,undefined); assert.ok(result.result?.value,'IndexedDB check did not finish');
    const value=result.result.value; assert.equal(value.error,undefined);
    await writeFile(path.join(temporary,phase+'.result.json'),JSON.stringify(value,null,2));
    await send('Browser.close'); await once(child,'exit'); return value;
  } finally { socket?.terminate(); if(child.exitCode===null) child.kill(); closeSync(err); }
}
const reserved=await launch('reserve'); assert.deepEqual(reserved,{phase:'reserved',live:32,rejected:1});
const reopened=await launch('reopen'); assert.deepEqual(reopened,{phase:'reopened',restored:32,removed:32});
assert.ok((await readdir(temporary)).includes('reopen.result.json'));
console.log(JSON.stringify({ok:true,browser,reserved,reopened,evidence:temporary}));
