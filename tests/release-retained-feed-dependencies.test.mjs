import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
// Unit boundary: exercise the unchanged proposal logic; isolate maintained
// journal/candidate/ACL APIs. Their integration remains covered separately.
const support=`import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
export const sha256=b=>createHash('sha256').update(b).digest('hex');
export function readEvidenceFile(r){const b=readFileSync(r.path);if(sha256(b)!==r.sha256)throw Error('reference-changed');return b;}
export const frontendRegular=readFileSync;export function verifyCandidate(){throw Error('unused-candidate-api');}
export class ReleaseJournal{constructor(){throw Error('inject-read-only-journal');}}
export function validateJournalDirectory(){throw Error('unused-write-api');}`;
const supportUrl='data:text/javascript;base64,'+Buffer.from(support).toString('base64');
let source=readFileSync(new URL('../scripts/release-retained-feed-dependencies.mjs',import.meta.url),'utf8');
source=source.replace(/from '\.\/[^']+'/g,'from '+JSON.stringify(supportUrl));
// URL-dependent fixed worker locations are irrelevant to the read-only resolver.
source=source.replace(/fileURLToPath\(new URL\('[^']+',import.meta.url\)\)/g,"'/unused-source-only'");
const api=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'nova-feed-provenance-'));const pairDir=join(root,'pair');mkdirSync(pairDir);
 const put=(name,value)=>{const path=join(root,name),raw=Buffer.from(JSON.stringify(value));writeFileSync(path,raw);return {path,sha256:sha(raw)};};
 const pairRaw=Buffer.from(JSON.stringify({candidateId:'a'.repeat(64),applicationDependencies:{archiveSha256:'b'.repeat(64)}}));
 const pair={path:join(pairDir,'reviewed-pair.json'),sha256:sha(pairRaw)};writeFileSync(pair.path,pairRaw);
 const bundle=put('bundle.json',{format:1,files:[{name:'reviewed-pair.json',sha256:pair.sha256,data:pairRaw.toString('base64')}]});
 const dependencies={archive:{path:join(root,'archive.tgz'),sha256:'b'.repeat(64)},metadata:{path:join(root,'metadata.json'),sha256:'c'.repeat(64)}};
 const sign={candidateId:'a'.repeat(64),priorCandidateId:'d'.repeat(64),sourceCommits:{private:'e'.repeat(40),public:'f'.repeat(40)},bundle,dependencies};
 const output={...sign,kind:'maintained-qualified-update-pair',operationId:'operation',directory:pairDir};
 const phases={'package/pair':{state:'completed',current:{output,receipt:put('pair-phase.json',output)}},sign:{state:'completed',current:{output:sign,receipt:put('sign-phase.json',sign)}}};
 const descriptor={operation:{id:'operation'}};let closed=false;
 const journal={loadDelivery:()=>({descriptor}),deliveryPhase:(_id,name)=>phases[name],close:()=>{closed=true;}};
 const manifest=put('candidate.json',{version:'synthetic'});
 const target=put('target.json',{bases:{private:{manifest}}});
 const profile={target,accepted:{pair,bundle},previousDelivery:{operationId:'operation',descriptorSha256:sha(canonical(descriptor)+'\n'),sourceCandidates:{private:manifest}}};
 return {root,pair,sign,phases,journal,profile,dependencies,closed:()=>closed};
}
test('actual sign shape without directory resolves exact completed pair and legacy dependencies',()=>{
 const f=fixture();try{assert.equal(f.sign.directory,undefined);assert.deepEqual(api.retainedAcceptedPairReference(f.journal,'operation',f.sign,f.pair.sha256),f.pair);
 assert.deepEqual(api.retainedAcceptedFeedDependencies(f.profile,{openJournal:()=>f.journal}),f.dependencies);assert.equal(f.closed(),true);}finally{rmSync(f.root,{recursive:true});}
});
test('tampered pair receipt and incorrect bundle member both refuse',()=>{
 const f=fixture();try{f.phases['package/pair'].current.output.candidateId='0'.repeat(64);
 assert.throws(()=>api.retainedAcceptedPairReference(f.journal,'operation',f.sign,f.pair.sha256),/pair-phase-changed/);
 f.phases['package/pair'].current.output.candidateId=f.sign.candidateId;writeFileSync(f.pair.path,'tampered');
 assert.throws(()=>api.retainedAcceptedPairReference(f.journal,'operation',f.sign,f.pair.sha256),/reference-changed/);}finally{rmSync(f.root,{recursive:true});}
});
test('wrong original descriptor refuses and closes read-only journal',()=>{
 const f=fixture();try{f.profile.previousDelivery.descriptorSha256='0'.repeat(64);
 assert.throws(()=>api.retainedAcceptedFeedDependencies(f.profile,{openJournal:()=>f.journal}),/descriptor-changed/);assert.equal(f.closed(),true);}finally{rmSync(f.root,{recursive:true});}
});
test('explicit accepted references survive later frontend previousDelivery without reopening another journal',()=>{
 const f=fixture();try{f.profile.accepted.feedDependencies=f.dependencies;f.profile.previousDelivery.operationId='later-frontend';
 assert.deepEqual(api.retainedAcceptedFeedDependencies(f.profile,{openJournal:()=>{throw Error('must-not-open');}}),f.dependencies);}finally{rmSync(f.root,{recursive:true});}
});
test('legacy frontend provenance gap refuses before opening an unrelated journal',()=>{
 const f=fixture();try{f.profile.previousDelivery.sourceCandidates.private={path:'different-interface',sha256:'0'.repeat(64)};
 assert.throws(()=>api.retainedAcceptedFeedDependencies(f.profile,{openJournal:()=>{throw Error('must-not-open');}}),/legacy-frontend-provenance-unavailable/);
 }finally{rmSync(f.root,{recursive:true});}
});
