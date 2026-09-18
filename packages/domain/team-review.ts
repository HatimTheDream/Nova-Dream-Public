import { z } from 'zod';
export const teamReviewRoundLimit = 3;
const finding = z.object({ id:z.string().trim().min(1).max(80),priority:z.enum(['high','medium','low']),title:z.string().trim().min(1).max(200),detail:z.string().trim().min(1).max(2000),location:z.string().trim().min(1).max(500).optional() }).strict();
const check = z.object({ name:z.string().trim().min(1).max(200),outcome:z.enum(['passed','failed','not_run']),detail:z.string().trim().min(1).max(1000) }).strict();
export const teamReviewSchema = z.object({verdict:z.enum(['needs_changes','ready_for_review']),summary:z.string().trim().min(1).max(2000),findings:z.array(finding).max(20),checks:z.array(check).min(1).max(20)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.findings.map(f=>f.id)).size!==value.findings.length)ctx.addIssue({code:'custom',path:['findings'],message:'Finding identifiers must be unique.'});
 if(value.verdict==='needs_changes'&&!value.findings.length)ctx.addIssue({code:'custom',path:['findings'],message:'Describe at least one concrete finding that needs changes.'});
 if(value.verdict==='ready_for_review'&&(value.findings.length||value.checks.some(c=>c.outcome==='failed')))ctx.addIssue({code:'custom',path:['verdict'],message:'Outstanding findings or failed checks require changes.'});
});
export type TeamReviewInput=z.infer<typeof teamReviewSchema>;
export type TeamReviewReport=TeamReviewInput&{operationId:string;stage:number;attempt:number;createdAt:number;digest:string};
export type TeamReviewScope={teamId:string;stage:number;attempt:number;agentId:string;agentRevision:number;submitRequestId:string};
