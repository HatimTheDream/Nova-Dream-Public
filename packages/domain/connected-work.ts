import { z } from 'zod';
import type { AssignmentAttempt } from './assignments.js';
import type { WorkSourceInspection } from './work-sources.js';

const uuid = z.string().uuid();
const positive = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const connectedCommand = z.object({ epoch: uuid, requestId: uuid, attemptId: uuid, sha256: digest }).strict();
export const connectedReviewCommand = connectedCommand.extend({ reviewerId: z.string().min(1).max(100), reviewerRevision: positive });
export const connectedReviseCommand = connectedCommand.extend({ correction: z.string().min(1).max(20000).refine(text => !!text.trim()) });
export const connectedAcceptCommand = connectedCommand.extend({ reviewAttemptId:uuid, reviewSha256:digest, acknowledgedFindingIds: z.array(z.string().min(1).max(80)).max(20) });
export type ConnectedAction = { kind:'review'; subjectId:string; sha256:string; reviewerId:string; reviewerRevision:number }
  | { kind:'revise'; subjectId:string; sha256:string; correction:string };
export type ConnectedAttempt = { role:'result'|'review'; rootAttemptId:string; number:number; baseAttemptId?:string; subjectAttemptId?:string; subjectSha256?:string; baseReviewAttemptId?:string; baseReviewSha256?:string };
export const connectedReviewReportSchema = z.object({
  summary: z.string().trim().min(1).max(3000),
  findings: z.array(z.object({ id:z.string().trim().min(1).max(80), severity:z.enum(['blocking','advisory']), detail:z.string().trim().min(1).max(2000) }).strict()).max(20),
}).strict().refine(report => new Set(report.findings.map(item => item.id)).size === report.findings.length, 'Finding identifiers must be unique.');
export type ConnectedReviewReport = z.infer<typeof connectedReviewReportSchema>;
export type ConnectedAcceptance = { at:number; deviceId:string; sha256:string; reviewAttemptId:string; reviewSha256:string; acknowledgedFindingIds:string[]; contentId:string };
export type ConnectedStatus = 'awaiting-result'|'needs-review'|'reviewing'|'review-unknown'|'review-blocked'|'reviewed'|'accepted'|'saved';
export type ConnectedResultDetail = {
  attempt:AssignmentAttempt; document:string|null; inputs:WorkSourceInspection[]; available:boolean;
  lineage: { attemptId:string; number:number; baseAttemptId?:string; state:AssignmentAttempt['state'] }[];
  correction:string|null;
  review: { state:'needed'|'running'|'unknown'|'failed'|'invalid'|'complete'; available:boolean; attempt:AssignmentAttempt|null; report:ConnectedReviewReport|null };
  acceptance:ConnectedAcceptance|null; savedContentId:string|null;
};
