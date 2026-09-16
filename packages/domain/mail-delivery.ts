import { z } from 'zod';
import { accountIdSchema } from './accounts.js';
import type { Provider } from './accounts.js';

const header = z.string().max(1000).refine(value => !/[\r\n\0]/.test(value), 'Mail headers must stay on one line.');
const address = header.pipe(z.email());
const addresses = z.array(address).max(100);
export const mailAttachmentSchema = z.object({ name: header.min(1), mimeType: z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).max(200), base64: z.string().max(13981016), bytes: z.number().int().min(0).max(10 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), cid:header.min(1).refine(value=>!/[<>\s]/.test(value)).optional(), disposition:z.enum(['inline','attachment']).optional() }).strict();
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;
export const mailDeliveryMessageSchema = z.object({
  from: address, to: addresses, cc: addresses.default([]), bcc: addresses.default([]),
  subject: header, bodyText: z.string().max(500000), bodyHtml: z.string().max(1000000).optional(),
  reply: z.object({ threadId: z.string().min(1).max(2000), messageId: z.string().min(1).max(2000), quote: z.boolean().default(false) }).strict().optional(),
  attachments: z.array(mailAttachmentSchema).max(20).default([]),
}).strict().superRefine((message, ctx) => {
  if (message.to.length + message.cc.length + message.bcc.length > 100) ctx.addIssue({code:'custom', message:'Choose at most 100 recipients.'});
  if (message.attachments.reduce((sum, file) => sum + file.bytes, 0) > 25 * 1024 * 1024) ctx.addIssue({code:'custom',message:'Attachments must total 25 MB or less.'});
});
export type MailDeliveryMessage = z.infer<typeof mailDeliveryMessageSchema>;
const identity = z.object({ epoch: z.uuid(), requestId: z.uuid() });
export const mailDeliveryPreviousSchema = z.object({ operationId:z.uuid(), expectedRevision:z.number().int().positive(), digest:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const mailFileReferenceSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('upload'),id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({kind:z.literal('saved'),operationId:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/),index:z.number().int().min(0).max(19),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export type MailFileReference = z.infer<typeof mailFileReferenceSchema>;
export const mailFileUploadSchema = identity.extend({file:mailAttachmentSchema.omit({cid:true,disposition:true})}).strict();
export const mailFileReadSchema = z.object({epoch:z.uuid(),id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),bytes:z.boolean().default(false)}).strict();
export type MailFile = {id:string;epoch:string;file:Omit<MailAttachment,'base64'> & {base64?:string};previewMimeType?:'image/png'|'image/jpeg'|'image/webp'};
export const mailDeliveryPrepareSchema = identity.extend({ accountId: accountIdSchema, generation: z.uuid(), writerId: z.uuid(), mode: z.enum(['draft','send']), message: mailDeliveryMessageSchema, files:z.array(mailFileReferenceSchema).max(20).optional(), previous:mailDeliveryPreviousSchema.optional(), preserveDraft:z.object({body:z.boolean(),attachments:z.literal(true)}).strict().optional() }).strict().refine(input=>!input.preserveDraft||!!input.previous,'Open the existing provider draft before preserving its content.');
export const mailDeliveryOpenSchema = identity.extend({accountId:accountIdSchema,generation:z.uuid(),writerId:z.uuid(),source:z.object({messageId:z.string().min(1).max(2000),threadId:z.string().min(1).max(2000)}).strict()}).strict();
export const mailDeliveryConfirmSchema = identity.extend({ operationId: z.uuid(), expectedRevision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['confirm','cancel']) }).strict();
export const mailDeliveryReadSchema = z.object({ epoch: z.uuid(), operationId: z.uuid() }).strict();
export const mailDeliveryFileSchema = mailDeliveryReadSchema.extend({ digest:z.string().regex(/^[a-f0-9]{64}$/), index:z.number().int().min(0).max(19), sha256:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type MailDeliveryFile = z.infer<typeof mailDeliveryFileSchema> & {file:MailDeliveryMessage['attachments'][number];previewMimeType?:'image/png'|'image/jpeg'|'image/webp'};
export type MailDeliveryStage = 'create' | 'create-reply' | 'update-reply' | 'send' | 'update-files' | 'update-draft' | 'send-draft';
export type MailDraftSnapshot = {
  id:string; messageId:string; fingerprint:string; changeKey?:string; etag?:string;
  contentFingerprint?:string;
  subject:string; from:string; to:string[]; cc:string[]; bcc:string[]; bodyText:string;
  attachments:{providerId?:string;name:string;mimeType:string;bytes:number;sha256?:string;cid?:string;disposition?:'inline'|'attachment'}[];
};
export type MailDeliveryState = 'preparing' | 'prepared' | 'running' | 'saved' | 'accepted' | 'uncertain' | 'interrupted' | 'failed' | 'cancelled';
export type MailDeliveryReview = {
  id: string; epoch: string; accountId: string; generation: string; writerId: string; provider: Provider; accountEmail: string;
  mode: 'draft' | 'send'; state: MailDeliveryState; revision: number; digest?: string; createdAt: string; expiresAt: string; updatedAt: string;
  message: Omit<MailDeliveryMessage,'attachments'> & { attachments: Omit<MailDeliveryMessage['attachments'][number],'base64'>[] };
  source?: { messageId: string; threadId: string; subject: string; from: string; fingerprint: string };
  phase?: MailDeliveryStage; providerDraftId?: string; providerMessageId?: string; providerChangeKey?: string;
  previousOperationId?:string; draft?:MailDraftSnapshot & {changed:boolean};
  canEditDraft?:boolean;
  openedDraft?:{messageId:string;threadId:string};
  superseded?:boolean;
  detail?: string;
};
