import { z } from 'zod';
export const modulePluginId = 'edition3-workspace';
export const moduleActionInputSchema = z.object({ operation: z.string().min(1).max(100), input: z.record(z.string(), z.unknown()).default({}) }).strict();
export const moduleInvocationSchema = moduleActionInputSchema.extend({ epoch: z.uuid(), nativeKey: z.string().min(1).max(300), nativeId: z.uuid(), toolCallId: z.string().min(1).max(500), permissionMode: z.enum(['read-only','guarded','workspace','full']), write: z.boolean() }).strict();
export type ModuleInvocation = z.infer<typeof moduleInvocationSchema>;
export type ModuleAction = { id:string; epoch:string; conversationId:string; assignmentId?:string; operationId:string; deviceId:string; operation:string; inputHash:string; phase?:'prepare'|'apply'|'cancel'; input:Record<string,unknown>; title:string; revision:number; createdAt:string; updatedAt:string; state:'preparing'|'pending'|'applying'|'applied'|'cancelled'|'failed'|'partial'|'unknown'; external:boolean; before?:unknown; preview:unknown; review?:any; result?:unknown; error?:string };
export const moduleDecisionSchema = z.object({ requestId:z.uuid(), epoch:z.uuid(), actionId:z.uuid(), expectedRevision:z.number().int().positive(), decision:z.enum(['apply','cancel','check']) }).strict();
