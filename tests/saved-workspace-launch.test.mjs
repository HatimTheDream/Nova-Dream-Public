import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import policy from '../apps/desktop/launch-policy.cjs';
function fixture(run) {
  const root=mkdtempSync(join(tmpdir(),'Nova saved launch '));
  mkdirSync(join(root,'.launcher/workspaces'),{recursive:true});
  mkdirSync(join(root,'.tmp-qa/retained'),{recursive:true});
  writeFileSync(join(root,'.tmp-qa/retained/workspace.sqlite'),'retained data');
  const save=value=>writeFileSync(join(root,'.launcher/workspaces/main.json'),JSON.stringify(value));
  const value={version:1,port:4398,dataDirectory:'.tmp-qa/retained'};save(value);
  try {run({root,save,value});} finally {rmSync(root,{recursive:true,force:true});}
}
test('saved launch selects the retained workspace for cold start and keeps a separate renderer profile',()=>fixture(({root})=>{
  const options=policy.launchOptions(['--workspace=main'],root);
  assert.equal(options.dataDirectory,join(root,'.tmp-qa/retained'));
  assert.equal(options.address,'http://127.0.0.1:4398');assert.equal(options.qa,false);
  assert.match(policy.profileDirectory(options,root,'/profiles'),/NovaDream-Edition3-Workspace-main-[a-f0-9]{12}$/);
  assert.notEqual(policy.profileDirectory(options,root,'/profiles'),policy.profileDirectory(options,root+'-other','/profiles'));
  assert.equal(existsSync(join(root,'.data')),false);
  assert.equal(policy.launchOptions([]).port,4383);
}));
test('missing retained storage refuses launch without creating an empty replacement',()=>fixture(({root})=>{
  rmSync(join(root,'.tmp-qa/retained/workspace.sqlite'));
  assert.throws(()=>policy.launchOptions(['--workspace=main'],root));
  assert.equal(existsSync(join(root,'.tmp-qa/retained/workspace.sqlite')),false);
  assert.equal(existsSync(join(root,'.data')),false);
}));
test('saved selection rejects ambiguous flags, traversal, unexpected keys and remote or invalid ports',()=>fixture(({root,save,value})=>{
  for(const args of [['--workspace=../main'],['--workspace=/tmp/main'],['--workspace=main','--qa'],['--workspace=main','--port=4398']])assert.throws(()=>policy.launchOptions(args,root));
  for(const delta of [{port:80},{port:65536},{port:4398.5},{port:'4398'},{version:2},{host:'example.com'},{dataDirectory:'../outside'},{dataDirectory:'/tmp/outside'},{dataDirectory:'.tmp-qa/../retained'},{dataDirectory:'.tmp-qa\\retained'}]){save({...value,...delta});assert.throws(()=>policy.launchOptions(['--workspace=main'],root));}
}));
test('symlinked saved selections and data paths cannot redirect launch',()=>fixture(({root,save,value})=>{
  symlinkSync(join(root,'.tmp-qa/retained'),join(root,'.tmp-qa/alias'),process.platform==='win32'?'junction':'dir');save({...value,dataDirectory:'.tmp-qa/alias'});
  assert.throws(()=>policy.launchOptions(['--workspace=main'],root),/symlink/);
  save(value);
  if(process.platform==='win32'){
    // Redirect a component of the same valid selection path without requiring
    // elevated file-symlink privileges. POSIX keeps the terminal file case.
    const selections=join(root,'.launcher/workspaces'),outside=join(root,'outside-selections');
    rmSync(selections,{recursive:true});mkdirSync(outside);writeFileSync(join(outside,'main.json'),JSON.stringify(value));symlinkSync(outside,selections,'junction');
  }else{
    const config=join(root,'.launcher/workspaces/main.json');rmSync(config);writeFileSync(join(root,'selection.json'),JSON.stringify(value));symlinkSync(join(root,'selection.json'),config);
  }
  assert.throws(()=>policy.launchOptions(['--workspace=main'],root),/symlink/);
}));
