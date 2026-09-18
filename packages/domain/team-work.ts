import { z } from 'zod';
import type { AgentAccess } from './agent-capabilities.js';
const envelope={requestId:z.uuid(),epoch:z.uuid()};
export const teamRoles=['research','build','review'] as const;
export const teamCreateSchema=z.object({...envelope,projectId:z.string().min(1).max(100),title:z.string().trim().min(1).max(120),brief:z.string().trim().min(1).max(15000),maxMinutes:z.number().int().min(1).max(30).default(10),steps:z.array(z.object({agentId:z.string().min(1).max(100),role:z.enum(teamRoles)}).strict()).min(2).max(6).refine(v=>new Set(v.map(s=>s.agentId)).size>=2,'Choose at least two different team members.')}).strict();
export const teamControlSchema=z.object({...envelope,id:z.uuid(),revision:z.number().int().positive(),action:z.enum(['pause','resume','stop','skip','retry'])}).strict();
export const handoffReadSchema=z.object({id:z.uuid(),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(24000).default(12000)}).strict();
/** A complete execution result, including partial output from a failed run. */
export type TeamHandoff={id:string;sha256:string;characters:number;bytes:number;state:'completed'|'failed'|'cancelled';createdAt:number};
export type TeamHandoffPage=TeamHandoff&{text:string;offset:number;nextOffset:number|null};
export type TeamAttempt={attempt:number;state:'waiting'|'running'|'complete'|'failed'|'cancelled'|'unknown'|'skipped';conversationId?:string;operationId?:string;result?:string;handoff?:TeamHandoff;startedAt?:number;finishedAt?:number;message?:string};
export type TeamStep=Omit<TeamAttempt,'attempt'>&{agentId:string;agentName:string;agentRevision:number;role:typeof teamRoles[number];attempt?:number;attempts?:TeamAttempt[]};
export type TeamWork={id:string;revision:number;projectId:string;projectName:string;title:string;brief:string;folder:string;maxMinutes:number;state:'running'|'paused'|'stopping'|'complete'|'cancelled'|'attention';message:string;steps:TeamStep[];next:number;createdAt:number;updatedAt:number};
export type TeamConversationAccess={epoch:string;teamId:string;agentId:string;agentRevision:number;access:AgentAccess;role:TeamStep['role'];handoffIds?:string[]};
