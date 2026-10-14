import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('full publication composition reconciles the original lost commit and never repeats prior effects',()=>{
 const loader=process.execArgv.filter((v,i,a)=>v==='--experimental-loader'||a[i-1]==='--experimental-loader');
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const r=spawnSync(process.execPath,[...loader,'--experimental-test-module-mocks','--test',fileURLToPath(new URL('../support/full-publication-continuation-worker.mjs',import.meta.url))],{encoding:'utf8',timeout:30000,maxBuffer:1024**2,env});
 assert.equal(r.status,0,(r.stdout??'')+(r.stderr??''));assert.match(r.stdout,/# pass 1/);
});
