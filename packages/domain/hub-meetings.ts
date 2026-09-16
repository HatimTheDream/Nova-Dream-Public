import { z } from 'zod';
const id=z.string().min(1).max(100), envelope={requestId:z.uuid(),epoch:z.uuid()};
export const meetingCommandSchema=z.discriminatedUnion('type',[
  z.object({...envelope,type:z.literal('gather'),roomId:id,title:z.string().trim().min(1).max(160),agenda:z.string().trim().min(1).max(4000),agentIds:z.array(id).min(2).max(12).refine(v=>new Set(v).size===v.length)}).strict(),
  z.object({...envelope,type:z.enum(['start','pause','end']),meetingId:z.uuid(),expectedRevision:z.number().int().positive()}).strict(),
]);
export type HubMeeting = {
  id:string;revision:number;roomId:string;title:string;agenda:string;createdAt:number;updatedAt:number;
  state:'gathered'|'running'|'paused'|'complete'|'ended';message:string;next:number;
  attendees:{id:string;name:string;revision:number}[];
  turns:{agentId:string;agentName:string;kind:'contribution'|'summary';planId:string;attemptId?:string;state?:string;result?:{fileId:string;text:string};message?:string}[];
};
export type HubMeetingState={current:HubMeeting|null;history:HubMeeting[]};
