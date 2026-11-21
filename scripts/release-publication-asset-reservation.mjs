import {lstatSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
import {readEvidenceFile, sha256} from './release-plan.mjs';
import {projectPublicationRequest} from './release-publication-local-inputs.mjs';

const need = (value,reason) => { if(!value)throw Error(reason); };
const read = ref => JSON.parse(readEvidenceFile(ref,{maximum:2*1024*1024}));
const canonical = value => JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)) : v) + '\n';
const helper = fileURLToPath(new URL('release-publication-asset-reservation.py',import.meta.url));
const roles = ['archive','execution','qualification','metadata'];

function locations(request) {
  const output=request.outputDirectory;
  return {output,claim:output+'.first-native-claim.json',
    ledger:join(request.ledgerDirectory,request.releaseIds.private+'-'+request.spec.name+'.intent.json')};
}

function absent(path) {
  try {lstatSync(path); return false;}
  catch(error){if(error.code==='ENOENT')return true; throw error;}
}

function basis({request,reservation,binding}) {
  const original=read(request), dispatch=read(reservation);
  const {outputDirectory:output,operationId,key}=original, journal=dirname(output);
  need(original.spec?.role==='app' && basename(journal)==='journal-'+operationId
    && basename(output)==='full-publication-'+key+'-app'
    && request.path===join(journal,'delivery-evidence',key+'-full-asset-app-request.json')
    && reservation.path===join(journal,'delivery-evidence',key+'-full-asset-app-dispatch.json')
    && equal(dispatch,{format:1,operationId,key,role:'app',outputDirectory:output,automaticReplayPermitted:false}),
    'original-first-asset-reservation-changed');
  const projected=projectPublicationRequest(original,binding);
  const paths=Object.fromEntries(roles.map(role=>[role,projected.signed.dependencies[role].path]));
  const packet={request,reservation,binding,paths,projectedSha256:sha256(canonical(projected))};
  return {original,packet};
}

function planMatches(plan,original,packet) {
  const repos={};
  for(const side of ['private','public']) {
    const repo=plan?.repositories?.[side];
    need(Number.isSafeInteger(repo?.repositoryId)&&repo.repositoryId>0,'reserved-asset-repository-required');
    repos[side]={repositoryId:repo.repositoryId,releaseId:original.releaseIds[side],sourceCommit:original.sourceCommits[side],
      tag:(side==='private'?'nova-v':'v')+original.version};
  }
  need(repos.private.repositoryId!==repos.public.repositoryId && equal(plan,{format:1,kind:'nova-reserved-publication-asset-plan',
    operationId:original.operationId,key:original.key,inputSha256:original.inputSha256,requestSha256:packet.request.sha256,
    reservationSha256:packet.reservation.sha256,bindingSha256:packet.binding.sha256,projectedRequestSha256:packet.projectedSha256,
    releaseIds:original.releaseIds,repositories:repos,spec:original.spec,assetAbsent:true,readOnly:true}),
    'reserved-asset-plan-differs-from-original');
}

function requireUnused(original) {
  need(Object.values(locations(original)).every(absent),'reserved-asset-native-or-external-dispatch-exists');
}

async function run(mode, original, packet, command) {
  readEvidenceFile(original.tools.python,{maximum:128*1024**2});
  const body=Buffer.from(JSON.stringify(packet)).toString('base64');
  const response=JSON.parse(await command(original.tools.python.path,['-B',helper,mode,'--packet',body],
    {maximum:1024*1024,timeoutMs:600000,acceptJsonFailure:true,gitExecPath:original.tools.gitExecPath}));
  return response;
}

export async function planReservedPublicationAsset({request,reservation,binding,command}) {
  const {original,packet}=basis({request,reservation,binding});
  requireUnused(original);
  const result=await run('plan',original,packet,command);
  if(result?.state==='uncertain')throw Error('reserved-asset-plan-failed: '+String(result.privateDiagnostic?.message??'unavailable').slice(0,200));
  planMatches(result,original,packet);
  requireUnused(original);
  return result;
}

export function verifyReservedPublicationAsset({request,reservation,binding,noPostPlan}) {
  const {original,packet}=basis({request,reservation,binding});
  planMatches(read(noPostPlan),original,packet);
  requireUnused(original);
  return true;
}

export async function runReservedPublicationAsset({request,reservation,binding,noPostPlan,expiresAtMs,command,
  clock=Date.now,beforeNewEffect,observe}) {
  const {original,packet}=basis({request,reservation,binding});
  planMatches(read(noPostPlan),original,packet);
  const paths=locations(original), claim={request,reservation,binding,projectedSha256:packet.projectedSha256,noPostPlan,expiresAtMs};
  if(!absent(paths.claim)) {
    need(equal(JSON.parse(readEvidenceFile({path:paths.claim,sha256:sha256(canonical(claim))})),claim),'reserved-asset-claim-changed');
    if(absent(join(paths.output,'dispatch.json')))return {state:'uncertain',reason:'reserved-asset-claim-without-native-dispatch',output:null,receipt:null};
    return observe();
  }
  requireUnused(original);
  need(Number.isSafeInteger(expiresAtMs)&&clock()<expiresAtMs,'original-asset-grant-expired');
  await beforeNewEffect();
  need(clock()<expiresAtMs,'original-asset-grant-expired');
  return run('issue',original,{...packet,noPostPlan,expiresAtMs},command);
}
