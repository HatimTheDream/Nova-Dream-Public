/** Small portable browser-worker primitives; no application dependencies. */
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,fstatSync,readSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {isAbsolute,dirname,resolve} from 'node:path';
export const canonicalBrowser=value=>JSON.stringify(value,(_key,x)=>x&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export const retainedWindowPolicy='one-prior-then-two-targets';
export function verifyRetainedWindowPolicy(policy,binding) {
  if(!policy)return false;
  const prior=binding.priorBundledTarget,target=binding.fullTarget,digest=/^[a-f0-9]{64}$/;
  if(policy.kind!==retainedWindowPolicy || binding.route!=='full' || binding.options.mode!=='remote'
    || binding.options.suite!=='tasks-search-focus' || prior?.version!=='2.28.39' || prior.buildVersion!=='1.0.412'
    || target?.version!=='2.28.45' || target.buildVersion!=='1.0.418'
    || !digest.test(policy.priorCandidateId) || !digest.test(policy.targetCandidateId) || policy.priorCandidateId===policy.targetCandidateId
    || policy.priorCandidateId!==prior.candidateId || policy.priorCandidateId!==binding.priorCandidateId || policy.targetCandidateId!==target.candidateId)
    throw Error('browser-retained-window-policy-target-changed');
  return true;
}
function referenceInfo(ref,maximum) {
  if(!isAbsolute(ref?.path??'')||!/^[a-f0-9]{64}$/.test(ref?.sha256??''))throw Error('browser-reference-invalid');
  for(let part=resolve(ref.path);;part=dirname(part)){if(lstatSync(part).isSymbolicLink())throw Error('browser-reference-symlink');if(dirname(part)===part)break;}
  const info=lstatSync(ref.path);if(!info.isFile()||info.size>maximum)throw Error('browser-reference-not-bounded-file');
  return info;
}
export function readEvidenceFile(ref,{maximum=2*1024**2}={}) {
  referenceInfo(ref,maximum);
  const bytes=readFileSync(ref.path);if(sha256(bytes)!==ref.sha256)throw Error('browser-reference-sha256-changed');return bytes;
}
/** Binaries can be hundreds of MiB; verify their exact bytes without retaining them. */
export function verifyBrowserTool(ref,{maximum=128*1024**2}={}) {
  const before=referenceInfo(ref,maximum),fd=openSync(ref.path,'r'),digest=createHash('sha256'),chunk=Buffer.allocUnsafe(64*1024);
  const unchanged=info=>info.isFile()&&['dev','ino','size','mtimeMs','ctimeMs'].every(key=>info[key]===before[key]);
  try{
    if(!unchanged(fstatSync(fd)))throw Error('browser-reference-changed-during-read');
    let total=0,count;
    while((count=readSync(fd,chunk,0,chunk.length,null))>0){
      total+=count;if(total>maximum||total>before.size)throw Error('browser-reference-not-bounded-file');
      digest.update(chunk.subarray(0,count));
    }
    if(total!==before.size||!unchanged(fstatSync(fd))||!unchanged(referenceInfo(ref,maximum)))throw Error('browser-reference-changed-during-read');
    if(digest.digest('hex')!==ref.sha256)throw Error('browser-reference-sha256-changed');
    return {path:ref.path,sha256:ref.sha256,bytes:total};
  }finally{closeSync(fd);}
}
export function verifyRemoteBrowserMemory(sample, operationId, milestone) {
  const limit = 2 * 1024 ** 3;
  if (sample?.operationId !== operationId || sample.milestone !== milestone ||
      sample.maxBytes !== limit || !Number.isSafeInteger(sample.peakBytes) ||
      sample.peakBytes <= 0 || sample.peakBytes > Math.floor(limit * 0.8) ||
      typeof sample.events !== 'string') throw Error('browser-memory-headroom-not-verified');
  const events = sample.events.trim().split('\n').map(line => line.split(/\s+/));
  for (const name of ['oom', 'oom_kill', 'oom_group_kill']) {
    const matching = events.filter(([key]) => key === name);
    if (name === 'oom_group_kill' && matching.length === 0) continue;
    if (matching.length !== 1 || matching[0].length !== 2 || matching[0][1] !== '0')
      throw Error('browser-memory-oom-not-clear');
  }
}
export function verifyRetainedPreparation(binding,prepared) {
  if(!verifyRetainedWindowPolicy(binding.windowPolicy,binding))return;
  const window=prepared?.priorWindow;
  if(!window || prepared.secondPage!==undefined || prepared.windowPolicy!==retainedWindowPolicy
    || prepared.twoPriorPages!=='unverified-live' || prepared.priorWindowCount!==1 || prepared.epoch!==binding.epoch || window.epoch!==binding.epoch
    || window.reducedMotion!==true || !Number.isFinite(window.timeOrigin) || window.timeOrigin<=0
    || window.document.candidateId!==binding.priorCandidateId || window.document.frontendId!==binding.priorCandidateId
    || window.document.version!==binding.priorBundledTarget.version || window.document.buildVersion!==binding.priorBundledTarget.buildVersion
    || window.document.assets!==`/__bundled/${binding.priorCandidateId}/` || canonicalBrowser(window.document)!==canonicalBrowser(prepared.document)
    || prepared.bindingSha256!==sha256(canonicalBrowser(binding)) || prepared.draft!==`Nova release verification ${binding.operationId} — retained unsent draft`)
    throw Error('browser-single-prior-preparation-changed');
  verifyRemoteBrowserMemory(prepared.memory,binding.operationId,'prior-draft-ready');
}
export function writeBrowserOnce(path,value) {
  const bytes=canonicalBrowser(value)+'\n';
  if(existsSync(path)){if(readFileSync(path,'utf8')!==bytes)throw Error('browser-original-file-changed');return;}
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}
