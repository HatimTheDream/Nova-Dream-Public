import {z} from 'zod';
import {homeReferenceSchema,type HomeSourceCapture} from './home-library.js';
import {homeIdeaIds} from './home-library-view.js';
import {workModeSchema} from './work-mode.js';
import type {AssistantOperation,AssistantOutput,Conversation} from './assistant.js';
export {ideaBindingSchema,type IdeaBinding} from './idea-binding.js';

const uuid=z.string().uuid(),revision=z.number().int().positive();
export const ideaHandoffSchema=/* @__PURE__ */(()=>z.object({
 title:z.string().min(1).max(150),text:z.string().min(1).max(100000),space:z.enum(['chat','work']),workMode:workModeSchema.optional(),
 projectId:z.string().min(1).max(200).nullable(),sourceCaptureId:uuid,sourceRefs:z.array(homeReferenceSchema).max(20),
 ideaId:z.enum(homeIdeaIds),selectedTaskIds:z.array(z.string().min(1).max(200)).max(18).optional(),
 outputs:z.array(z.string().min(1).max(100)).min(1).max(20),
 authoredDirections:z.string().max(4000).optional(),
}).strict())();
export const ideaCommandSchema=/* @__PURE__ */(()=>z.discriminatedUnion('type',[
 z.object({requestId:uuid,epoch:uuid,type:z.literal('create'),id:uuid,entryId:uuid,handoff:ideaHandoffSchema}).strict(),
 z.object({requestId:uuid,epoch:uuid,type:z.literal('question'),id:uuid,entryId:uuid,expectedRevision:revision,text:z.string().min(1).max(50000)}).strict(),
 z.object({requestId:uuid,epoch:uuid,type:z.literal('review'),id:uuid,expectedRevision:revision,reviewed:z.boolean()}).strict(),
]))();
export type IdeaCommand=z.infer<typeof ideaCommandSchema>;
export const ideaPursuitSchema=/* @__PURE__ */(()=>z.object({id:uuid,epoch:uuid,starterId:z.enum(homeIdeaIds),title:z.string().min(1).max(150),
 revision,createdAt:z.string(),updatedAt:z.string(),initialEntryId:uuid,reviewed:z.boolean()}).strict())();
export type IdeaPursuit=z.infer<typeof ideaPursuitSchema>;
export const ideaEntrySchema=/* @__PURE__ */(()=>z.object({id:uuid,pursuitId:uuid,epoch:uuid,createdAt:z.string(),question:z.string().max(50000).optional(),handoff:ideaHandoffSchema}).strict())();
export type IdeaEntry=z.infer<typeof ideaEntrySchema>;
export const ideaReceiptSchema=/* @__PURE__ */(()=>z.discriminatedUnion('state',[
 z.object({command:ideaCommandSchema,state:z.literal('unknown')}).strict(),
 z.object({command:ideaCommandSchema,state:z.literal('saved'),pursuit:ideaPursuitSchema,entryId:uuid.optional()}).strict(),
 z.object({command:ideaCommandSchema,state:z.literal('rejected'),code:z.string(),message:z.string()}).strict(),
]))();
export type IdeaReceipt=z.infer<typeof ideaReceiptSchema>;
export type IdeaRun={pursuitId:string;entryId:string;operationId:string;conversationId:string;createdAt:string};
export type IdeaPage<T>={epoch:string;rows:T[];next:string|null};
export type IdeaRunDetail={epoch:string;link:IdeaRun;operation:AssistantOperation|null;outputs:AssistantOutput[];conversation:Conversation|null;capture:HomeSourceCapture|null};
