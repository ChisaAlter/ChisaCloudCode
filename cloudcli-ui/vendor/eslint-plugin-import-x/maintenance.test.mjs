import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {spawn} from 'node:child_process';
const folder=new URL('./',import.meta.url);const root=new URL('../../',import.meta.url);const require=createRequire(new URL('package.json',root));const local=createRequire(new URL('package.json',folder));const hash=b=>createHash('sha256').update(b).digest('hex');
const installedPlugin=await import(pathToFileURL(path.join(path.dirname(require.resolve('eslint-plugin-import-x/package.json')),'lib/index.js')).href);
const provenance=JSON.parse(await readFile(new URL('importx-vendor-provenance.json',folder),'utf8'));
const makeFixture=async()=>{const folder=await mkdtemp(path.join(tmpdir(),'chisa-importx-compat-'));return{folder,async cleanup(){await rm(folder,{recursive:true,force:true});}};};

test('reviewed upstream296 files and installed vendor have only the exact3intentional changes',async()=>{
 const actual=path.dirname(require.resolve('eslint-plugin-import-x/package.json'));
 for(const original of provenance.originalFiles){const expected=provenance.changes.find(x=>x.path===original.path)?.afterSha256??original.sha256;assert.equal(hash(await readFile(new URL(original.path,folder))),expected,'reviewed source '+original.path);assert.equal(hash(await readFile(path.join(actual,original.path))),expected,'installed source '+original.path);}
 assert.equal(provenance.originalFiles.length,296);assert.equal(provenance.changes.length,3);
 const tar=JSON.parse(await readFile(new URL('importx-vendor-tarball.json',folder),'utf8'));assert.equal(hash(await readFile(new URL('../eslint-plugin-import-x-4.17.1-chisa.1.tgz',folder))),tar.sha256);assert.equal(hash(await readFile(new URL('LICENSE',folder))),'7829efc4266fad5f57f7fc489429a3b35d0c62183c0bd617ef6591f64c980c92');
});

test('ESM and CJS published entries preserve forbid rules for ordinary scoped and relative paths',async()=>{
 const{ESLint}=await import('eslint');const esm=installedPlugin.default;const cjs=require('eslint-plugin-import-x');
 for(const[label,plugin]of[['esm',esm],['cjs',cjs.default??cjs]]){const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{files:['**/*.js'],plugins:{importx:plugin},rules:{'importx/no-internal-modules':['error',{forbid:['pkg/private/**','@scope/pkg/private/**','**/forbidden/**']}]}}]});for(const input of['pkg/private/key.js','@scope/pkg/private/key.js','../forbidden/deep.js']){const result=await eslint.lintText('import value from '+JSON.stringify(input)+'; export default value;',{filePath:'fixture/consumer.js'});assert.ok(result[0].messages.some(x=>x.ruleId==='importx/no-internal-modules'),label+' '+input);}const valid=await eslint.lintText('import value from "pkg"; export default value;',{filePath:'fixture/valid.js'});assert.equal(valid[0].errorCount,0);}
});

test('allowlist preserves allowed imports and rejects resolved private modules',async()=>{
 const fixture=await makeFixture();try{await writeFile(path.join(fixture.folder,'package.json'),JSON.stringify({name:'chisa-vendor-maintenance-fixture',version:'0.0.0',private:true,type:'module'}));for(const dir of['allowed','denied']){await mkdir(path.join(fixture.folder,'node_modules/fixture-pkg',dir),{recursive:true});await writeFile(path.join(fixture.folder,'node_modules/fixture-pkg',dir,'value.js'),'export default 1;');}await writeFile(path.join(fixture.folder,'node_modules/fixture-pkg/package.json'),JSON.stringify({name:'fixture-pkg',version:'1.0.0',type:'module',main:'allowed/value.js'}));const{ESLint}=await import('eslint');const plugin=installedPlugin.default;const eslint=new ESLint({cwd:fixture.folder,overrideConfigFile:true,overrideConfig:[{files:['**/*.js'],plugins:{importx:plugin},rules:{'importx/no-internal-modules':['error',{allow:['fixture-pkg/allowed/**']}]}}]});const yes=await eslint.lintText('import value from "fixture-pkg/allowed/value.js"; export default value;',{filePath:'consumer.js'});const no=await eslint.lintText('import value from "fixture-pkg/denied/value.js"; export default value;',{filePath:'consumer.js'});assert.equal(yes[0].errorCount,0);assert.ok(no[0].messages.some(x=>x.ruleId==='importx/no-internal-modules'));}finally{await fixture.cleanup();}
});

test('42reviewed original makeRe vectors preserve normalized path semantics',async()=>{
 const baseline=JSON.parse(await readFile(new URL('matcher-baseline.json',folder),'utf8'));const{Minimatch}=local('minimatch');assert.equal(baseline.vectors.length,42);for(const v of baseline.vectors)assert.equal(new Minimatch(v.pattern).match(v.input),v.expected,v.pattern+' '+v.input);
});

test('default dot glob extglob brace and Windows path behavior remains compatible',()=>{
 const{minimatch}=local('minimatch');const vectors=[['src/modules/auth/index.ts','src/**/*.ts',{dot:true},true],['src/modules/foo/bar.ts','src/modules/*/*.ts',{},true],['src/modules/foo/bar/baz.ts','src/modules/*/*.ts',{},false],['server/.hidden/foo.ts','server/**/*.ts',{dot:true},true],['server/.hidden/foo.ts','server/**/*.ts',{},false],['C:/root/src/foo.ts','C:/root/src/**/*.ts',{windowsPathsNoEscape:true},true],['src/foo.tsx','src/**/*.{ts,tsx}',{},true],['src/foo.js','src/**/!(*.test).{js,ts}',{},true],['.env','**/*',{dot:false},false],['.env','**/*',{dot:true},true]];for(const[input,pattern,options,expected]of vectors)assert.equal(minimatch(input,pattern,options),expected,pattern+' '+input);
});

test('minimatch amplification input completes within bounded worker',async()=>{
 const worker=new Worker('const{workerData,parentPort}=require("node:worker_threads");const{Minimatch}=require(workerData.file);const m=new Minimatch(("**/../").repeat(300)+"file",{optimizationLevel:2});parentPort.postMessage({rows:m.set.length,matched:m.match("file")});',{eval:true,workerData:{file:local.resolve('minimatch')}});const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{void worker.terminate();reject(Error('5s minimatch bound exceeded'));},5000);worker.once('message',value=>{clearTimeout(timer);resolve(value);});worker.once('error',error=>{clearTimeout(timer);reject(error);});});assert.ok(result.rows<10000);
});

test('actual oxlint JS plugin bridge allows public imports and rejects private imports',async()=>{
 const fixture=await makeFixture();try{const plugin=pathToFileURL(path.join(path.dirname(require.resolve('eslint-plugin-import-x/package.json')),'lib/index.js')).href;await writeFile(path.join(fixture.folder,'.oxlintrc.json'),JSON.stringify({jsPlugins:[{name:'importx',specifier:fileURLToPath(plugin)}],rules:{'importx/no-internal-modules':['error',{forbid:['pkg/private/**']}]}}));await writeFile(path.join(fixture.folder,'valid.js'),'import value from "pkg"; export default value;');await writeFile(path.join(fixture.folder,'forbidden.js'),'import value from "pkg/private/key.js"; export default value;');const binary=fileURLToPath(new URL('node_modules/oxlint/bin/oxlint',root));const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH};for(const[name,expected]of[['valid.js',0],['forbidden.js',1]]){const output=path.join(fixture.folder,name+'.stdout');const errors=path.join(fixture.folder,name+'.stderr');const{openSync,closeSync}=await import('node:fs');const out=openSync(output,'w'),err=openSync(errors,'w');const child=spawn(process.execPath,[binary,'--config','.oxlintrc.json','--format','json',name],{cwd:fixture.folder,env,stdio:['ignore',out,err],windowsHide:true});const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('20s oxlint bound exceeded'));},20000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});closeSync(out);closeSync(err);const stdout=await readFile(output,'utf8');const stderr=await readFile(errors,'utf8');assert.equal(code,expected,stdout+stderr);if(expected===1)assert.match(stdout,/no-internal-modules/);}}finally{await fixture.cleanup();}
});
