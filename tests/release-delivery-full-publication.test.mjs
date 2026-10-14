import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {sha256} from '../scripts/release-plan.mjs';
import {pairedFullPublicationReceipt,verifyFullPublishedAsset,fullPublicationHelpers,fullPublicationLedgerDirectory} from '../scripts/release-delivery-full-publication.mjs';
import {validateJournalDirectory} from '../scripts/release-coordinate.mjs';
const input={sourceCommits:{private:'a'.repeat(40),public:'b'.repeat(40)},signed:{sequence:33,signedFeed:{sha256:'c'.repeat(64)}}};
const rows=['private','public'].map((side,i)=>({repository:'Nova-Dream'+(i?'-Public':''),sourceCommit:input.sourceCommits[side],feedParentCommit:input.sourceCommits[side],feedCommit:(i?'e':'d').repeat(40),pushed:true,changedOnly:(i?'':'edition3/')+'updates/stable.json',feedSha256:input.signed.signedFeed.sha256,sequence:33,unrelatedIndexPreserved:true}));
const readback={publicFeedReadVerified:true,publicFeedSha256:input.signed.signedFeed.sha256,sequence:33};
test('paired full publication preserves separate source parents and exact readback',()=>{
 const r=pairedFullPublicationReceipt(input,rows,readback);assert.equal(r.repositories[0].feedParentCommit,'a'.repeat(40));assert.equal(r.repositories[1].feedParentCommit,'b'.repeat(40));assert.equal(r.applicationInstalled,false);
 for(const change of [r=>r[1].pushed=false,r=>r[0].unrelatedIndexPreserved=false,r=>r[1].sourceCommit=r[0].sourceCommit,r=>r[0].changedOnly='private-evidence.json']){
  const bad=structuredClone(rows);change(bad);assert.throws(()=>pairedFullPublicationReceipt(input,bad,readback));
 }
 assert.throws(()=>pairedFullPublicationReceipt(input,rows,{...readback,publicFeedSha256:'0'.repeat(64)}));
});
test('authenticated readback must remain within the original child and retain all bytes',t=>{
 const root=mkdtempSync(join(tmpdir(),'nova-full-publication-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const key='df258b64-cb4b-46c7-8662-9d2dc5be52f2',bytes=Buffer.from('all bytes'),spec={role:'bundle',name:'nova-2.4.0-operator-bundle.json',bytes:bytes.length,sha256:sha256(bytes)};
 const path=join(root,'full-publication-'+key+'-bundle','first','0-readback',spec.name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);
 const c={descriptor:{operation:{id:'op'}},intent:{key,inputSha256:'f'.repeat(64)},journal:{directory:root}};
 const value={operationId:'op',key,inputSha256:c.intent.inputSha256,role:'bundle',asset:{...spec,id:2,authenticatedDownloadVerified:true,localPath:path}};
 verifyFullPublishedAsset(value,spec,c);
 assert.throws(()=>verifyFullPublishedAsset({...value,key:'different'},spec,c));
 assert.throws(()=>verifyFullPublishedAsset({...value,asset:{...value.asset,localPath:join(root,spec.name)}},spec,c));
 writeFileSync(path,Buffer.from('changed!!'));assert.throws(()=>verifyFullPublishedAsset(value,spec,c));
});
test('publication closure includes authentication and both fixed child programs',()=>{
 const p=fullPublicationHelpers();assert.equal(Object.keys(p).length,6);assert.ok(p['release-full-feed-publication.py']);assert.ok(p['release-delivery-ci.py']);for(const h of Object.values(p))assert.match(h,/^[a-f0-9]{64}$/);
});

test('publication requires a pre-existing protected external canonical ledger',t=>{
 const root=mkdtempSync(join(tmpdir(),'nova-full-ledger-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'ledger');validateJournalDirectory(path,{create:true});
 assert.equal(fullPublicationLedgerDirectory(path),path);
 assert.throws(()=>fullPublicationLedgerDirectory(join(root,'missing')),/missing/);
 assert.throws(()=>fullPublicationLedgerDirectory(path+ '/.'),/canonical/);
 const repo=join(root,'repository');mkdirSync(repo);mkdirSync(join(repo,'.git'));mkdirSync(join(repo,'ledger'));
 assert.throws(()=>fullPublicationLedgerDirectory(join(repo,'ledger')),/repository/);
 const synced=join(root,'OneDrive');mkdirSync(synced);mkdirSync(join(synced,'ledger'));
 assert.throws(()=>fullPublicationLedgerDirectory(join(synced,'ledger')),/synced/);
});
