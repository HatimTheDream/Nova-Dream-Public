/** Retained runtime source ingestion is separate from target-state qualification.
 * No caller receipt/flag can currently admit an actual runtime transition. */
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import {frontendRegular} from './frontend-contract.mjs';
import {readEvidenceFile,sha256} from './release-plan.mjs';

const hash=z.string().regex(/^[a-f0-9]{64}$/),ref=z.object({path:z.string().min(1).max(4096),sha256:hash}).strict();
const source=z.object({sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),runId:z.number().int().positive(),runAttempt:z.number().int().positive(),artifactId:z.number().int().positive(),zip:ref}).strict();
const helperNames=['release-runtime-qualification.py','release-delivery-ci.py','release-ci-primitives.py'];
export const runtimeSourceRequestSchema=z.object({format:z.literal(1),kind:z.literal('retained-runtime-source-evidence'),
 build:source,synthetic:source,tools:z.object({git:ref,python:ref,gitExecPath:z.string().min(1).max(4096)}).strict(),
 helperHashes:z.object(Object.fromEntries(helperNames.map(name=>[name,hash]))).strict(),
 independentVerifier:z.object({receipt:ref,helpers:z.object({'recovery.py':ref,'codex_log_retention.py':ref}).strict()}).strict().nullable(),
}).strict();
export const SETTLED_RUNTIME_GAP='actual-settled-runtime-qualification-producer-required';
const need=(value,code)=>{if(!value)throw Error(code);};

/** Pure capability result. It deliberately accepts no purported passing proof. */
export function runtimeAdmissionCapability(input){
 const fields=z.object({fromVersion:z.string(),toVersion:z.string(),schemaVersion:z.number().int(),apiVersion:z.number().int()}).strict().parse(input);
 const {fromVersion:from,toVersion:to,schemaVersion,apiVersion}=fields;
 const gap=code=>({supported:false,runtimeRequired:from!==to,gaps:[{code}]});
 if(schemaVersion!==55||apiVersion!==1)return gap('unsupported-application-schema-or-api');
 if(from==='2026.9.8'&&to===from)return{supported:true,runtimeRequired:false,gaps:[]};
 if(from==='2026.9.6'&&to==='2026.9.8')return gap(SETTLED_RUNTIME_GAP);
 if(from==='2026.9.2'&&to==='2026.9.6')return gap('authenticated-runtime-producer-unavailable');
 return gap('unsupported-runtime-transition');
}

/** Pin this returned map with the rest of the operation's implementation graph. */
export function runtimeSourceImplementationIdentity(){
 return Object.fromEntries(helperNames.map(name=>[name,sha256(frontendRegular(fileURLToPath(new URL(name,import.meta.url)),2*1024**2))]));
}

/** All effects are read-only GitHub GETs and local bounded file reads. The caller
 * owns any immutable collection receipt. This helper writes no intent or result,
 * does not download/extract/build, and cannot reserve an installation. */
export async function verifyRetainedRuntimeSources({request:reference,run}){
 const raw=readEvidenceFile(ref.parse(reference),{maximum:65536}),request=runtimeSourceRequestSchema.parse(JSON.parse(raw));
 need(same(request.helperHashes,runtimeSourceImplementationIdentity()),'runtime-source-implementation-changed');
 readEvidenceFile(request.tools.python,{maximum:128*1024**2});
 const script=fileURLToPath(new URL('./release-runtime-qualification.py',import.meta.url));
 const value=await run(request.tools.python.path,['-B',script,'--request',reference.path,'--request-sha256',reference.sha256],
  {timeoutMs:240000,maximum:2*1024**2,acceptJsonFailure:true});
 const result=typeof value==='string'?JSON.parse(value):(value?.json??value);
 need(result&&['gap','failed'].includes(result.state)&&result.productionAdmission===false&&result.readOnly===true&&result.hostEffects===false,'runtime-source-consumer-result-invalid');
 need(readEvidenceFile(reference,{maximum:65536}).equals(raw)&&same(request.helperHashes,runtimeSourceImplementationIdentity()),'runtime-source-input-changed-during-consumption');
 if(result.sourceEvidenceVerified===true){
  need(result.format===1&&result.kind==='authenticated-retained-runtime-sources'&&result.state==='gap'&&result.reason===SETTLED_RUNTIME_GAP
   &&result.actualSettledQualification===false&&result.independentVerificationRerun===false&&result.independentVerifierCurrencyEstablished===false&&result.sdkExecuted===false&&result.workspaceDataOpened===false
   &&result.applicationNodeVersion==='22.23.2'&&result.runtime?.fromVersion==='2026.9.6'&&result.runtime?.toVersion==='2026.9.8'
   &&result.runtime.nodeVersion==='24.21.0'&&result.gaps.includes(SETTLED_RUNTIME_GAP)
   &&same(result.retainedIndependentVerifier,request.independentVerifier),'runtime-source-consumer-scope-changed');
  for(const role of ['build','synthetic']){
   const expected=request[role],actual=result.authenticated?.[role];
   need(actual&&['sourceCommit','runId','runAttempt','artifactId'].every(k=>actual[k]===expected[k])&&same(actual.zip,expected.zip)
    &&actual.apiDigest==='sha256:'+expected.zip.sha256,'runtime-source-consumer-identity-changed');
  }
 }
 return result;
}
