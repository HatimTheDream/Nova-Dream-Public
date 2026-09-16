import { z } from 'zod';
import { accountIdSchema } from './accounts.js';
import type { MailAssistantApprovalReceipt, MailAssistantPlan } from './dreamclaw/mail-actions.js';

export const mailTriageActionSchema=z.enum(['mark-read','mark-unread','flag','unflag','archive','delete','organize','remove-organization']);
export type MailTriageAction=z.infer<typeof mailTriageActionSchema>;
export const mailTriageTargetSchema=z.object({provider:z.enum(['gmail','microsoft']),accountId:accountIdSchema,generation:z.uuid(),threadId:z.string().min(1).max(2000)}).strict();
export type MailTriageTarget=z.infer<typeof mailTriageTargetSchema>;
const identity=z.object({epoch:z.uuid(),requestId:z.uuid()});
export const mailDisplayedSchema=identity.extend({target:mailTriageTargetSchema,messageIds:z.array(z.string().min(1).max(2000)).min(1).max(2000)}).strict();
export const mailTriagePrepareSchema=identity.extend({writerId:z.uuid(),action:mailTriageActionSchema,organization:z.string().trim().min(1).max(120).optional(),targets:z.array(mailTriageTargetSchema).min(1).max(500)}).strict().refine(input=>!['organize','remove-organization'].includes(input.action)||!!input.organization,'Choose a label or category first.');
export const mailTriageReadSchema=z.object({epoch:z.uuid(),planId:z.uuid()}).strict();
export const mailTriageConfirmSchema=identity.extend({planId:z.uuid(),expectedRevision:z.number().int().positive(),digest:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['apply','cancel','undo','acknowledge'])}).strict();
export type TriageMessageState={id:string;threadId:string;subject:string;from:string;date:string;draft:boolean;labels:string[];isRead:boolean;flagStatus:string;categories:string[];parentFolderId?:string;changeKey?:string;etag?:string};
export type TriageThreadState={target:MailTriageTarget;messages:TriageMessageState[];fingerprint:string};
export type TriageChange={labels?:Record<string,boolean>;isRead?:boolean;flagStatus?:string;category?:{name:string;present:boolean};parentFolderId?:string};
export type TriageStep={method:'POST'|'PATCH';path:string;body?:unknown;expected:TriageChange};
export type MailTriageOutcome={messageId:string;accountId:string;threadId:string;subject:string;state:'pending'|'applying'|'applied'|'unchanged'|'failed'|'uncertain'|'observed';detail?:string;undo?:'available'|'applying'|'undone'|'failed'|'uncertain'|'unsupported'|'observed'};
export type MailTriagePlan=MailAssistantPlan&{epoch:string;writerId:string;revision:number;accountLabels?:Record<string,string>;resultMessage?:string;errors?:string[];receipt?:MailAssistantApprovalReceipt;outcomes:MailTriageOutcome[];canCheck?:boolean;canUndo?:boolean};
