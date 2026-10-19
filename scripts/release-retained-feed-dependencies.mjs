/** Local operator prerequisite only. Existing accepted profiles are unchanged.
 * Archive references come from the same retained completed sign phase whose
 * bundle was accepted; caller validation still owns installed identity checks. */
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as same} from 'node:util';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {frontendRegular} from './frontend-contract.mjs';
import {verifyCandidate} from './candidate.mjs';
import {ReleaseJournal,validateJournalDirectory} from './release-coordinate.mjs';

const need=(value,code)=>{if(!value)throw Error(code);};
const MAX=128*1024**2;
const WORKER_SHA='261f4308d27a734525b99542593534a92b5b9bdabffd8b2b33bc74ae045d13f1';
const PARSER_SHA='e7f2617ed8d05b7d83da62e857822b737ff3a1c47b6704af5d3e1783e043b290';
const worker=fileURLToPath(new URL('./release-retained-feed-dependencies.py',import.meta.url));
const parser=fileURLToPath(new URL('../deploy/update-runner/app_dependencies.py',import.meta.url));
const ref=(path,sha256)=>({path:resolve(path),sha256});
const json=r=>JSON.parse(readEvidenceFile(r,{maximum:MAX}));
const canonical=value=>JSON.stringify(value,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);

/** Full sign output intentionally has no directory. The completed pair subphase
 * and its retained bundle member are the authoritative pair location/bytes. */
export function retainedAcceptedPairReference(journal,id,sign,expectedSha){
  const phase=journal.deliveryPhase(id,'package/pair');
  need(phase?.state==='completed'&&phase.validation?.state!=='failed'&&phase.current?.receipt,'accepted-feed-pair-not-completed');
  const output=phase.current.output;
  need(same(json(phase.current.receipt),output)&&output.kind==='maintained-qualified-update-pair'
    &&output.operationId===id&&output.candidateId===sign.candidateId&&output.priorCandidateId===sign.priorCandidateId
    &&same(output.sourceCommits,sign.sourceCommits)&&same(output.dependencies,sign.dependencies),'accepted-feed-pair-phase-changed');
  const pair=ref(join(output.directory,'reviewed-pair.json'),expectedSha);
  const bytes=readEvidenceFile(pair,{maximum:2*1024**2}),bundle=json(sign.bundle);
  const entries=bundle.files?.filter(x=>x.name==='reviewed-pair.json');
  need(bundle.format===1&&entries?.length===1&&entries[0].sha256===expectedSha,'accepted-feed-bundle-pair-missing');
  const raw=Buffer.from(entries[0].data,'base64');
  need(raw.toString('base64')===entries[0].data&&sha256(raw)===expectedSha&&raw.equals(bytes),'accepted-feed-bundle-pair-changed');
  return pair;
}

/** Only references, never directory searches or guessed sibling archive names.
 * Existing exports already retain the accepted bundle's journal location and
 * previousDelivery identity. Opening that original journal is read-only. */
export function retainedAcceptedFeedDependencies(profile,{openJournal=path=>new ReleaseJournal(path,{readOnly:true})}={}){
  if(profile.accepted.feedDependencies)return profile.accepted.feedDependencies;
  need(profile.previousDelivery,'accepted-feed-dependency-provenance-unavailable');
  const target=json(profile.target);
  need(same(profile.previousDelivery.sourceCandidates?.private,target.bases?.private?.manifest),
    'accepted-feed-legacy-frontend-provenance-unavailable');
  const journal=openJournal(dirname(profile.accepted.bundle.path));
  try{
    const id=profile.previousDelivery.operationId,record=journal.loadDelivery(id);
    need(record&&sha256(canonical(record.descriptor)+'\n')===profile.previousDelivery.descriptorSha256,'accepted-feed-original-descriptor-changed');
    const phase=journal.deliveryPhase(id,'sign');
    need(phase?.state==='completed'&&phase.validation?.state!=='failed'&&phase.current?.receipt,'accepted-feed-sign-not-completed');
    const sign=phase.current.output;
    need(same(json(phase.current.receipt),sign)&&same(sign.bundle,profile.accepted.bundle),'accepted-feed-sign-bundle-changed');
    const pair=retainedAcceptedPairReference(journal,id,sign,profile.accepted.pair.sha256);
    need(same(pair,profile.accepted.pair),'accepted-feed-sign-pair-changed');
    need(sign.dependencies?.archive&&sign.dependencies?.metadata,'accepted-feed-dependency-references-unavailable');
    return {archive:sign.dependencies.archive,metadata:sign.dependencies.metadata};
  }finally{journal.close?.();}
}

export async function materializeRetainedFeedDependencies({base,pair,dependencies,python,command}){
  need(typeof command==='function','feed-dependency-command-required');
  const before=verifyCandidate(base.directory);
  need(before.id===base.candidateId&&base.manifest.path===join(base.directory,'dist','candidate.json'),'feed-dependency-candidate-changed');
  readEvidenceFile(base.manifest);readEvidenceFile(python,{maximum:MAX});
  readEvidenceFile(ref(worker,WORKER_SHA),{maximum:2*1024**2});
  readEvidenceFile(ref(parser,PARSER_SHA),{maximum:2*1024**2});
  const reviewed=json(pair),metadata=json(dependencies.metadata);
  need(reviewed.candidateId===base.candidateId&&same(reviewed.applicationDependencies,metadata)
    &&metadata.archiveSha256===dependencies.archive.sha256,'feed-dependency-accepted-pair-changed');
  const archive=readEvidenceFile(dependencies.archive,{maximum:MAX});
  need(archive.length===metadata.archiveBytes,'feed-dependency-archive-size-changed');
  const workDirectory=validateJournalDirectory(join(dirname(base.directory),'retained-feed-'+base.candidateId),{create:true});
  const request={format:1,base,pair,archive:dependencies.archive,metadata:dependencies.metadata,
    helper:ref(parser,PARSER_SHA),workDirectory};
  const requestBytes=Buffer.from(canonical(request)+'\n');
  need(requestBytes.length<=8192,'feed-dependency-request-too-large');
  const args=['-I','-B',worker,'--request-base64',requestBytes.toString('base64'),'--request-sha',sha256(requestBytes)];
  const plan=JSON.parse(await command(python.path,[...args,'--plan'],{timeoutMs:120000,maximum:65536}));
  need(plan.passed===true&&plan.readOnly===true,'feed-dependency-plan-failed');
  // Create the normal Node resolution directory using the maintained ACL path.
  validateJournalDirectory(join(base.directory,'node_modules'),{create:true});
  const result=JSON.parse(await command(python.path,args,{timeoutMs:120000,maximum:65536}));
  need(result.materialized===true&&result.candidateUnchanged===true&&result.candidateId===base.candidateId
    &&result.archiveSha256===dependencies.archive.sha256&&result.destination===join(base.directory,'node_modules','zod'),
    'feed-dependency-materialization-result-changed');
  need(verifyCandidate(base.directory).id===before.id,'feed-dependency-candidate-mutated');
  return result;
}
