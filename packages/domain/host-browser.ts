import { z } from 'zod';
import type { Attachment } from './contracts.js';
import { validBrowserUrl } from './work-input.js';
const target=z.string().min(1).max(200),ref=z.string().min(1).max(100);
const url=z.url().max(4000).refine(validBrowserUrl);
export const browserInputSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('open'),url}).strict(),
  z.object({action:z.literal('navigate'),targetId:target,url,observationId:z.uuid()}).strict(),
  z.object({action:z.literal('close'),targetId:target}).strict(),
  z.object({action:z.literal('click'),targetId:target,ref,observationId:z.uuid()}).strict(),
  z.object({action:z.literal('type'),targetId:target,ref,text:z.string().max(20000),observationId:z.uuid()}).strict(),
  z.object({action:z.literal('press'),targetId:target,key:z.string().min(1).max(80),observationId:z.uuid()}).strict(),
  z.object({action:z.literal('select'),targetId:target,ref,values:z.array(z.string().max(1000)).min(1).max(20),observationId:z.uuid()}).strict(),
  z.object({action:z.literal('scroll'),targetId:target,ref,observationId:z.uuid()}).strict(),
]);
export type BrowserInput=z.infer<typeof browserInputSchema>;
export type BrowserObservation={id:string;targetId:string;url:string;text:string;at:number;image?:{mimeType:'image/jpeg';data:string;width:number;height:number};file?:Attachment};
export type HostBrowserState={enabled:boolean;available:boolean;running:boolean;message:string;tabs:{id:string;title:string;url:string}[]};
export type BrowserActionResult={id:string;state:'running'|'completed'|'unknown'|'failed';message:string;targetId?:string;at:number};
