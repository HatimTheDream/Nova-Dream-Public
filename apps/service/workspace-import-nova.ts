import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attachmentSchema, canonical, projectSchema, taskSchema, type Task } from '../../packages/domain/contracts.js';
import { dayInZone, localDate, nextDay, routineSchema, timezone, type Occurrence, type Routine } from '../../packages/domain/tasks.js';
import type { BackupSnapshot } from '../../packages/domain/workspace-backup.js';
import type { ImportItem, ImportSource } from '../../packages/domain/workspace-import.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const stableId = (value: unknown) => { const h = hash(value); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
const stamp = z.string().datetime(), sid = z.string().min(1).max(1000);
const recurrence = z.object({ cadence:z.enum(['none','daily','weekly','monthly','custom']), rule:z.string().nullable(), everyday:z.boolean() });
const template = z.object({ id:sid,title:z.string(),notes:z.string(),createdAt:stamp,updatedAt:stamp,revision:z.number().int().positive(),projectId:sid.nullable(),parentTaskId:sid.nullable().optional(),priority:z.enum(['low','normal','high','urgent']),recurrence });
const ruleSchema = z.object({version:z.literal(1),unit:z.enum(['day','week','month']),interval:z.number().int().min(1).max(100),weekdays:z.array(z.number().int().min(0).max(6)).max(7),monthDays:z.array(z.number().int().min(-1).max(31).refine(n=>n!==0)).max(32)}).strict();
const scheduleSchema = z.object({id:sid,taskId:sid,revision:z.number().int().positive(),taskRevision:z.number().int().positive(),taskSnapshot:template,anchorAt:stamp,timezone,activeFrom:localDate,rule:ruleSchema,cursor:localDate,enabled:z.boolean()});
const occurrenceSchema = z.object({id:sid,taskId:sid,localDate,status:z.enum(['pending','missed','completed','skipped']),completedAt:stamp.nullable(),taskSnapshot:template,timezone,updatedAt:stamp,revision:z.number().int().positive()}).passthrough();
const sourceSchema = z.object({version:z.literal(1),ownerId:sid,projectId:sid,sourceId:z.string().uuid(),sourceRevision:z.literal(1),fileName:z.string().min(1).max(200).refine(n=>!/[\\/\x00-\x1f\x7f]/.test(n)),mimeType:z.string().min(1).max(160),size:z.number().int().min(0).max(8*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/),content:z.string()}).strict();
const librarySchema = z.object({version:z.literal(1),ownerId:sid,projectId:sid,revision:z.number().int().positive()}).strict();
type Row = { row:Record<string,any>; value:any; index:number };
type Context = { source:Extract<ImportSource,{format:'nova-dream-backup-15'}>; namespace:string; entities:BackupSnapshot['entities']; items:ImportItem[] };

/** Reuse Nova 04138bc1 identities and hashes. This adapter never runs old jobs,
 * grants a path or fetches a source. All original rows remain in the archive. */
export function extendNovaImport({source,namespace,entities,items}:Context) {
  const files:BackupSnapshot['files']=[], references:BackupSnapshot['references']=[], services:BackupSnapshot['services']=[];
  const rows=(name:string):Row[]=>{const table=source.snapshot.tables[name];return table?table.rows.map((raw,index)=>{const row=Object.fromEntries(table.columns.map((c,i)=>[c,raw[i]]));let value:any=row.encrypted_payload??row.payload??row;if(typeof value==='string'){try{value=JSON.parse(value);}catch{value=null;}}return {row,value,index};}):[];};
  const itemFor=(name:string,r:Row)=>items.find(i=>i.source===name&&i.sourceId===`row:${r.index}`)!;
  const mapped=(name:string,id:string)=>{const item=items.find(i=>i.source===name&&i.sourceId===id);return item?.targetId?entities.find(e=>e.id===item.targetId):undefined;};
  const project=(id:string|null)=>{if(!id)return null;const p=mapped('chat_projects',id);if(!p||p.kind!=='project')throw Error('The linked Project is unavailable; the original relationship is preserved.');return p.id;};
  const linked=(item:ImportItem,id:string,kind:string,note:string)=>{Object.assign(item,{outcome:'linked',targetId:id,targetKind:kind});item.notes=[note,'The complete original and its history remain in the source archive.'];};
  const rejected=(item:ImportItem,error:unknown)=>{item.notes.push(error instanceof z.ZodError?'The source fields do not fit this version; the complete original is preserved.':error instanceof Error?error.message:'The complete original is preserved.');};
  const exact=(values:Row[],key:string,id:unknown)=>{const matches=values.filter(r=>r.row[key]===id);if(matches.length!==1)throw Error('Source membership is missing or ambiguous; the original is preserved.');return matches[0];};
  const libraries=rows('project_source_libraries'), identities=rows('project_source_identities'), sources=rows('project_sources');
  const counts=new Map<string,number>();for(const r of sources)counts.set(r.row.library_key,(counts.get(r.row.library_key)??0)+1);
  const used=new Set<string>();
  for(const r of sources){const item=itemFor('project_sources',r);try{
    const s=sourceSchema.parse(r.value), library=exact(libraries,'library_key',r.row.library_key), l=librarySchema.parse(library.value), identity=exact(identities,'source_key',r.row.source_key), p=project(s.projectId)!;
    if(s.sourceId!==s.sourceId.toLowerCase()||used.has(s.sourceId))throw Error('Duplicate or incompatible source identity; the original is preserved.');
    const metadata={sourceId:s.sourceId,sourceRevision:s.sourceRevision,fileName:s.fileName,mimeType:s.mimeType,size:s.size,sha256:s.sha256};
    const libraryKey=hash([s.ownerId,s.projectId]), owner=hash(s.ownerId), sourceKey=hash(s.sourceId);
    if(l.ownerId!==s.ownerId||l.projectId!==s.projectId||library.row.library_key!==libraryKey||library.row.owner_scope!==owner||library.row.revision!==l.revision||r.row.library_key!==libraryKey||r.row.owner_scope!==owner||r.row.source_key!==sourceKey||r.row.size_bytes!==s.size||r.row.payload_bytes!==Buffer.byteLength(JSON.stringify(r.value))||identity.row.library_key!==libraryKey||identity.row.owner_scope!==owner||identity.row.content_hash!==hash(metadata)||identity.row.tombstoned!==0)throw Error('Source membership or metadata failed verification; the original is preserved.');
    if((counts.get(libraryKey)??0)>10)throw Error('This Project exceeds the ten-source attachment limit; all its original sources are preserved together.');
    const bytes=Buffer.from(s.content,'base64');if(bytes.toString('base64')!==s.content||bytes.length!==s.size||bytesHash(bytes)!==s.sha256)throw Error('Source bytes failed their saved integrity check; the original is preserved.');
    const id=stableId([namespace,'project-source',s.sourceId]), attachment=attachmentSchema.parse({id,name:s.fileName,size:s.size,sha256:s.sha256});
    const entity=entities.find(e=>e.id===p)!, value=projectSchema.parse({...entity.value as object,attachments:[...((entity.value as any).attachments??[]),attachment]});
    entity.value=value;files.push({...attachment,deviceId:namespace,base64:s.content});references.push({entityId:p,fileId:id});used.add(s.sourceId);
    item.title=s.fileName;linked(item,p,'project','Verified file bytes are restored as a source of the original linked Project.');
  }catch(error){rejected(item,error);}}

  const schedules=rows('task_schedules'), ordinary=rows('ordinary_task_occurrences'), habits=rows('task_occurrences');
  const clock=(at:string,zone:string)=>{const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at));return parts.find(p=>p.type==='hour')!.value+':'+parts.find(p=>p.type==='minute')!.value;};
  const weekday=(date:string)=>new Date(date+'T12:00:00Z').getUTCDay();
  for(const raw of rows('tasks')){
    const t=raw.value, rec=recurrence.safeParse(t?.recurrence);if(rec.success&&!rec.data.everyday&&rec.data.cadence==='none')continue;
    const item=items.find(i=>i.source==='tasks'&&i.sourceId===t.id);if(!item)continue;
    const existing=item.targetId?entities.find(e=>e.id===item.targetId):undefined;
    // A recurring template is never converted into an unrelated one-off task.
    if(existing)entities.splice(entities.indexOf(existing),1);delete item.targetId;delete item.targetKind;item.outcome='preserved';
    try{
      const base=template.parse(t);if(!rec.success)throw Error('The recurrence configuration is unsupported and remains preserved.');if(base.parentTaskId||!existing)throw Error('The recurring template or its parent/Project relationship cannot be represented faithfully.');
      if(entities.filter(e=>e.kind==='routine').length>=100)throw Error('This export exceeds the supported recurring-series limit.');
      const habit=rec.data.everyday;let schedule: z.infer<typeof scheduleSchema>|undefined, scheduleRow:Row|undefined;
      let zone=source.timezone, startsOn=dayInZone(zone,Date.parse(base.createdAt)), next=nextDay(dayInZone(zone,Date.parse(source.snapshot.createdAt))), plannedTime='', pattern:Partial<Routine>={cadence:'daily',interval:1,weekdays:[]};
      if(!habit){
        const matches=schedules.filter(r=>r.value?.taskId===base.id);if(matches.length!==1)throw Error('A single supported saved schedule is required; recurrence stays archived.');
        scheduleRow=matches[0];schedule=scheduleSchema.parse(scheduleRow.value);const rule=schedule.rule;
        const expectedRule=base.recurrence.cadence==='custom'?ruleSchema.parse(JSON.parse(base.recurrence.rule??'')):{version:1,unit:({daily:'day',weekly:'week',monthly:'month'} as Record<string,string>)[base.recurrence.cadence],interval:1,weekdays:[],monthDays:[]};
        if((base.recurrence.cadence!=='custom'&&base.recurrence.rule)||canonical(expectedRule)!==canonical(rule))throw Error('The recurrence configuration and saved rule disagree; the original series is preserved.');
        if(scheduleRow.row.id!==schedule.id||scheduleRow.row.task_id!==base.id||scheduleRow.row.revision!==schedule.revision||schedule.taskSnapshot.id!==base.id||schedule.taskRevision!==schedule.taskSnapshot.revision||canonical(schedule.taskSnapshot)!==canonical(base))throw Error('The schedule and template revisions disagree; the original series is preserved.');
        if(new Set(rule.weekdays).size!==rule.weekdays.length||new Set(rule.monthDays).size!==rule.monthDays.length||(rule.unit!=='week'&&rule.weekdays.length)||(rule.unit!=='month'&&rule.monthDays.length))throw Error('This recurrence rule cannot be represented exactly; the complete series remains preserved.');
        if(new Date(schedule.anchorAt).getUTCSeconds()||new Date(schedule.anchorAt).getUTCMilliseconds())throw Error('This schedule requires sub-minute precision and remains preserved.');
        zone=schedule.timezone;startsOn=dayInZone(zone,Date.parse(schedule.anchorAt));plannedTime=clock(schedule.anchorAt,zone);next=[schedule.cursor,schedule.activeFrom,startsOn].sort().at(-1)!;
        pattern={cadence:({day:'daily',week:'weekly',month:'monthly'} as const)[rule.unit],interval:rule.interval,weekdays:rule.unit==='week'?(rule.weekdays.length?rule.weekdays:[weekday(startsOn)]):[]};
        if(rule.unit==='month'){const days=rule.monthDays.length?rule.monthDays:[Number(startsOn.slice(8))];pattern={...pattern,monthDays:[...days].sort((a,b)=>a-b),missingDay:'skip'};}
      }
      const routineId='routine:'+stableId([namespace,'routine',base.id]), routine=routineSchema.parse({title:base.title,notes:base.notes,kind:habit?'habit':'task',state:'paused',startsOn,timezone:zone,...pattern,projectId:project(base.projectId),plannedTime,priority:base.priority==='urgent'?'high':base.priority,estimateMinutes:0});
      const pendingEntities:BackupSnapshot['entities']=[], pendingServices:BackupSnapshot['services']=[], pendingItems:Array<{item:ImportItem;id:string}>=[], seenDays=new Set<string>();
      for(const oRaw of (habit?habits:ordinary).filter(r=>r.value?.taskId===base.id)){
        if(!habit&&oRaw.value.state==='superseded')continue;
        const o=occurrenceSchema.parse(oRaw.value);if(oRaw.row.id!==o.id||oRaw.row.task_id!==base.id||oRaw.row.local_date!==o.localDate||oRaw.row.revision!==o.revision||o.taskSnapshot.id!==base.id||o.taskSnapshot.parentTaskId||o.timezone!==zone||seenDays.has(o.localDate))throw Error('An occurrence identity, timezone or date is inconsistent; the series is preserved together.');
        if((o.status==='completed')!==!!o.completedAt)throw Error('An occurrence completion is inconsistent; the series remains preserved.');
        if(!habit&&(o.state!=='active'||o.scheduleId!==schedule!.id||!Number.isInteger(o.scheduleRevision)||(o.scheduleRevision as number)<1||(o.scheduleRevision as number)>schedule!.revision))throw Error('An occurrence does not belong to its saved schedule; the series is preserved together.');
        if(!habit&&dayInZone(zone,Date.parse(stamp.parse(o.originalScheduledAt)))!==o.localDate)throw Error('The occurrence date and original schedule disagree; the series remains preserved.');
        const plannedAt=habit?null:stamp.parse(o.plannedAt), planned=plannedAt?dayInZone(zone,Date.parse(plannedAt)):o.localDate;
        const taskId=`task:occ:${routineId.slice(8)}:${o.localDate}`, value=taskSchema.parse({title:o.taskSnapshot.title,notes:o.taskSnapshot.notes,status:o.status==='completed'?'done':o.status==='skipped'?'skipped':'open',planned,due:'',timezone:zone,...(plannedAt?{plannedTime:clock(plannedAt,zone)}:{}),projectId:project(o.taskSnapshot.projectId),priority:o.taskSnapshot.priority==='urgent'?'high':o.taskSnapshot.priority,bucket:'anytime'});
        pendingEntities.push({id:taskId,kind:'task',revision:1,deviceId:namespace,updatedAt:o.updatedAt,value});
        pendingServices.push({id:`tasks:occurrence:${taskId}`,revision:1,value:{taskId,routineId,templateRevision:1,date:o.localDate,timezone:zone,kind:routine.kind} satisfies Occurrence});
        pendingItems.push({item:itemFor(habit?'task_occurrences':'ordinary_task_occurrences',oRaw),id:taskId});seenDays.add(o.localDate);
      }
      entities.push({id:routineId,kind:'routine',revision:1,deviceId:namespace,updatedAt:base.updatedAt,value:routine},...pendingEntities);
      services.push({id:`tasks:schedule:${routineId}`,revision:1,value:{next}},...pendingServices);
      Object.assign(item,{outcome:'editable',targetId:routineId,targetKind:'routine'});item.notes=['Restored as a paused recurring series. Existing occurrences keep their identity; reminders and execution are not restarted.','The complete original and its history remain in the source archive.'];
      if(scheduleRow)linked(itemFor('task_schedules',scheduleRow),routineId,'routine','The saved rule and cursor belong to this paused series.');
      for(const p of pendingItems){Object.assign(p.item,{outcome:'editable',targetId:p.id,targetKind:'task'});p.item.title=(pendingEntities.find(e=>e.id===p.id)!.value as Task).title;p.item.notes=['Saved occurrence restored with its date, outcome and series link. Original timing, evidence and completion history remain archived; earlier completions do not earn new XP.'];}
    }catch(error){rejected(item,error);}
  }
  return {files,references,services};
}
