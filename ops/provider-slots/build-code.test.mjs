import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildProviderCode } from './build-code.mjs';

test('offline builder materializes only the explicit worker, Node, CLI and installed dependency closure',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'chisa-code-builder-'));
  try{
    const packages=path.join(base,'packages');const cli=path.join(base,'cli');await mkdir(packages);await mkdir(cli);await writeFile(path.join(cli,'main.cjs'),'fixture cli');await mkdir(path.join(cli,'node_modules','cli-dependency'),{recursive:true});await writeFile(path.join(cli,'node_modules','cli-dependency','index.js'),'fixture cli dependency');const worker=path.join(base,'worker.js');const node=path.join(base,'node');await writeFile(worker,'fixture worker');await writeFile(node,'fixture node');
    const packageSpec=[['cross-spawn',{}],['@openai/codex-sdk',{'fixture-dependency':'1.0.0'}],['fixture-dependency',{}]];
    for(const [name,dependencies]of packageSpec){const directory=path.join(packages,'node_modules',name);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'package.json'),JSON.stringify({name,version:'1.0.0',main:'index.js',dependencies}));await writeFile(path.join(directory,'index.js'),'fixture dependency');}
    const destination=path.join(base,'code');const result=await buildProviderCode({version:1,destination,workerPath:worker,nodeExecutable:node,packageFrom:packages,cliSource:cli,cliRelative:'main.cjs'});assert.equal(result.cliRelative,'cli/main.cjs');assert.deepEqual(result.packages,['cross-spawn','@openai/codex-sdk','fixture-dependency']);assert.equal(await readFile(path.join(destination,'app','provider-process.worker.js'),'utf8'),'fixture worker');assert.equal(await readFile(path.join(destination,'cli','main.cjs'),'utf8'),'fixture cli');assert.equal(await readFile(path.join(destination,'cli','node_modules','cli-dependency','index.js'),'utf8'),'fixture cli dependency');assert.equal(await readFile(path.join(destination,'app','node_modules','fixture-dependency','index.js'),'utf8'),'fixture dependency');
  }finally{assert.equal(path.dirname(base),os.tmpdir());await rm(base,{recursive:true,force:true});}
});
