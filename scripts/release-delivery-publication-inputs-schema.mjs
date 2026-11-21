import {z} from 'zod';

export const assetGrantKind='nova-returned-publication-inputs-grant';
export const assetEvent='returned-publication-inputs-granted';
export const assetBranch='operator/returned-publication-inputs';
export const phases=['private-source','public-source','private-ci','public-ci','artifacts','route','package','sign','capacity','recovery'];
export const children=['dependency-stage','dependency-plan','dependency-intent','dependency-execute','dependency-retrieval','pair','bundle'].map(n=>'package/'+n);

export function publicationInputSchemas({reference,digest,source,baseRequest,baseGrant,publicationBrowser}){
 const sources=z.object({private:source.extend({branch:z.literal(assetBranch)}),public:source.extend({branch:z.literal(assetBranch)})}).strict();
 const owner=z.object({request:reference,launcher:reference,intent:reference,exit:reference,childResult:reference,stdout:reference,session:reference}).strict();
 const common={predecessorGrantSha256:digest,localInputs:reference,assetPlan:reference,browser:publicationBrowser,preparedBrowser:reference};
 const request=baseRequest.omit({durationMs:true}).extend({kind:z.literal('nova-returned-publication-inputs-request'),owner,operatorSources:sources,...common});
 const phase=z.object({phase:z.string(),key:z.uuid(),inputSha256:digest,observationSha256:digest}).strict();
 const {hostFacts,...baseline}=baseGrant.shape;
 const grant=z.object({...baseline,kind:z.literal(assetGrantKind),...common,prerequisites:z.array(phase).length(phases.length),
   packageSubsteps:z.array(phase).length(children.length),publication:phase.extend({observationId:z.number().int().positive(),storedObservationSha256:digest}),
   assetRequest:reference,reservation:reference,storageAdmission:z.object({eventId:z.number().int().positive(),sha256:digest,session:reference,dispatch:reference}).strict(),
   operator:baseGrant.shape.operator.extend({sources})}).strict().refine(p=>p.expiresAtMs===p.originalCreatedAtMs+p.originalBudgetMs&&p.issuedAtMs<p.expiresAtMs,
   'original-publication-deadline-required');
 return {request,grant};
}
