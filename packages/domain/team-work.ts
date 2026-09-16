import { z } from 'zod';
import type { AgentAccess } from './agent-capabilities.js';
const envelope={requestId:z.uuid(),epoch:z.uuid()};
export const teamRoles=['research','build','review'] as const;
export const teamCreateSchema=z.object({...envelope,projectId:z.string().min(1).max(100),title:z.string().trim().min(1).max(120),brief:z.string().trim().min(1).max(15000),maxMinutes:z.number().int().min(1).max(30).default(10),steps:z.array(z.object({agentId:z.string().min(1).max(100),role:z.enum(teamRoles)}).strict()).min(2).max(6).refine(v=>new Set(v.map(s=>s.agentId)).size>=2,'Choose at least two different team members.')}).strict();
export const teamControlSchema=z.object({...envelope,id:z.uuid(),revision:z.number().int().positive(),action:z.enum(['pause','resume','stop','skip'])}).strict();
export type TeamStep={agentId:string;agentName:string;agentRevision:number;role:typeof teamRoles[number];state:'waiting'|'running'|'complete'|'failed'|'cancelled'|'unknown'|'skipped';conversationId?:string;operationId?:string;result?:string;startedAt?:number;message?:string};
export type TeamWork={id:string;revision:number;projectId:string;projectName:string;title:string;brief:string;folder:string;maxMinutes:number;state:'running'|'paused'|'stopping'|'complete'|'cancelled'|'attention';message:string;steps:TeamStep[];next:number;createdAt:number;updatedAt:number};
export type TeamConversationAccess={epoch:string;teamId:string;agentId:string;agentRevision:number;access:AgentAccess;role:TeamStep['role']};
