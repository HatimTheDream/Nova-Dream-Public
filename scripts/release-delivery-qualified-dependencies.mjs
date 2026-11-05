/** Read-only native dependency artifact admission. The pack receipt alone never
 * grants qualification: its exact description must be bound by the actual
 * retained startup projection for this candidate and original workspace. */
import {z} from 'zod';
import {isDeepStrictEqual as same} from 'node:util';
import {readEvidenceFile,sha256} from './release-plan.mjs';
import {frontendRegular} from './frontend-contract.mjs';
const hash=z.string().regex(/^[a-f0-9]{64}$/),ref=z.object({path:z.string().min(1).max(4096),sha256:hash}).strict();
const hostRef=z.object({path:z.string().regex(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/),sha256:hash,bytes:z.number().int().positive().max(1024**2)}).strict();
const identity=z.object({platform:z.literal('linux'),arch:z.literal('x64'),nodeVersion:z.literal('22.23.2'),nodeAbi:z.literal(127)}).strict();
export const applicationTransitionSchema=z.object({format:z.literal(1),kind:z.literal('schema-55-to-60-same-runtime'),
  fromSchemaVersion:z.literal(55),toSchemaVersion:z.literal(60),apiVersion:z.literal(1),
  fromAgentVersion:z.literal('2026.9.8'),toAgentVersion:z.literal('2026.9.8')}).strict();
export const applicationDependencyDescriptionSchema=z.object({format:z.literal(1),archiveBytes:z.number().int().positive().max(512*1024**2),archiveSha256:hash,
 expandedBytes:z.number().int().positive().max(2*1024**3),fileCount:z.number().int().positive().max(200000),packageLockSha256:hash,dependencyGraphSha256:hash,
 platform:z.literal('linux'),arch:z.literal('x64'),nodeVersion:z.literal('22.23.2'),nodeAbi:z.literal(127)}).strict();
export const qualifiedDependenciesSchema=z.object({archive:ref,metadata:ref,execution:ref}).strict();
export const DEPENDENCY_PACK_PROBE_SHA='b50cac29bf43ae484921a3ae0fe4332fab83a8d4f01457b41527ee9a86e8d8e9';
const receiptSchema=z.object({format:z.literal(1),kind:z.literal('qualified-application-dependency-pack'),producerSha256:hash,
 node:identity.extend({path:z.string().startsWith('/'),sha256:hash}).strict(),
 source:z.object({packageSha256:hash,packageLockSha256:hash,dependencyGraphSha256:hash,inventoryBeforeSha256:hash,inventoryAfterSha256:hash}).strict(),
 archive:z.object({sha256:hash,bytes:z.number().int().positive().max(512*1024**2)}).strict(),metadataSha256:hash,description:applicationDependencyDescriptionSchema,
 execution:z.object({probeSha256:z.literal(DEPENDENCY_PACK_PROBE_SHA),identity,exitCode:z.literal(0)}).strict(),planRef:hostRef,intentRef:hostRef,closureRef:hostRef}).strict();
const need=(v,r)=>{if(!v)throw Error(r);};
export function verifyQualifiedApplicationDependencies(input,binding,{producerSha256,packageSha256,packageLockSha256}){
 applicationTransitionSchema.parse(binding.applicationTransition);
 const refs=qualifiedDependenciesSchema.parse(input),raw=frontendRegular(refs.archive.path,512*1024**2);
 need(sha256(raw)===refs.archive.sha256,'qualified-dependency-archive-hash-changed');
 const metadataRaw=readEvidenceFile(refs.metadata,{maximum:65536}),description=applicationDependencyDescriptionSchema.parse(JSON.parse(metadataRaw));
 const receipt=receiptSchema.parse(JSON.parse(readEvidenceFile(refs.execution,{maximum:1024**2})));
 need(binding.applicationTransition?.kind==='schema-55-to-60-same-runtime'&&same(binding.applicationDependencies,description)
  &&binding.dependencyGraphSha256===description.dependencyGraphSha256,'qualified-dependencies-startup-binding-changed');
 need(description.archiveSha256===refs.archive.sha256&&description.archiveBytes===raw.length
  &&same(receipt.description,description)&&receipt.archive.sha256===refs.archive.sha256&&receipt.archive.bytes===raw.length
  &&receipt.metadataSha256===refs.metadata.sha256,'qualified-dependency-artifact-changed');
 need(receipt.producerSha256===producerSha256&&receipt.source.packageSha256===packageSha256
  &&receipt.source.packageLockSha256===packageLockSha256&&description.packageLockSha256===packageLockSha256
  &&receipt.source.dependencyGraphSha256===description.dependencyGraphSha256
  &&receipt.source.inventoryBeforeSha256===receipt.source.inventoryAfterSha256,'qualified-dependency-source-changed');
 need(receipt.node.sha256===binding.runtime.nodeSha256&&receipt.node.path===binding.runtime.node
  &&same(receipt.execution.identity,Object.fromEntries(['platform','arch','nodeVersion','nodeAbi'].map(k=>[k,description[k]]))),
  'qualified-dependency-native-execution-changed');
 return{...refs,description,qualification:refs.execution,newNativeDependenciesQualified:true,unchangedNativeDependencies:false};
}
