import { invalidTaskParents } from '../../packages/domain/task-family.js';
import { verifiedImportedProgress } from './workspace-import-progress.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical, defaultLayout, draftSchema, projectSchema, taskSchema, type Kind, type Entity, type Task } from '../../packages/domain/contracts.js';
import { recordSchemas } from '../../packages/domain/workspace-records.js';
import { dayInZone, timezone } from '../../packages/domain/tasks.js';
import { backupFormat, type BackupSnapshot } from '../../packages/domain/workspace-backup.js';
import { importGroupLabel, importMaxBytes, importSourceSchema, type ImportItem, type ImportReview, type ImportSource } from '../../packages/domain/workspace-import.js';
import { Fault, Store } from './store.js';
import { extendNovaImport } from './workspace-import-nova.js';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const object = z.record(z.string(), z.unknown()), sid = z.string().min(1).max(1000), text = z.string(), stamp = z.string().datetime();
const dcTask = z.object({ id: sid, title: text.min(1), description: text, parentTaskId: sid.nullable().optional(), status: z.enum(['inbox','queue','inProgress','blocked','waiting','done']), priority: z.enum(['high','medium','low']), createdAt: stamp, updatedAt: stamp.optional(), plannedDate: text.optional(), plannedTime: text.optional(), dueAt: stamp.optional(), blockedByIds: z.array(sid).max(20).refine(ids=>new Set(ids).size===ids.length).optional(), checklist: z.array(z.object({ id: sid, text, done: z.boolean() }).passthrough()).optional() }).passthrough();
const novaTask = z.object({ id: sid, title: text.min(1), notes: text, parentTaskId: sid.nullable().optional(), status: z.enum(['inbox','todo','in_progress','blocked','completed','skipped']), priority: z.enum(['low','normal','high','urgent']), createdAt: stamp, updatedAt: stamp, revision: z.number().int().positive(), dueAt: stamp.nullable(), projectId: sid.nullable(), recurrence: z.unknown(), waiting: z.object({ label: text }).passthrough().nullable().optional() }).passthrough();
const uuid = (value: string) => { const h = digest(value); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
export type ImportPlan = { source: ImportSource; review: ImportReview; snapshot: BackupSnapshot };

/** Fixed-source adapters: DC e0769bd9 and Nova 04138bc1. Original payloads are
 * preserved in encrypted service records; no predecessor authority is adopted. */
export function planWorkspaceImport(input: unknown, version: string): ImportPlan {
  if (Buffer.byteLength(JSON.stringify(input)) > importMaxBytes) throw new Fault(413, 'import_size', 'Choose an export smaller than 32 MB.');
  const source = importSourceSchema.parse(input), zone = timezone.parse(source.timezone);
  const dc = source.format === 'dream-claw-storage-1', createdAt = dc ? source.createdAt : source.snapshot.createdAt;
  const namespace = `import:${dc ? 'dc' : 'nova'}:${source.storeId}`, sourceHash = digest(source), reviewId = uuid(sourceHash);
  const deadline = (instant: string | null | undefined, notes: string[]) => {
    if (!instant) return { due: '' };
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
    const clock = (kind: string) => parts.find(p=>p.type===kind)!.value;
    notes.push('Deadline uses the source timezone with minute precision; its original timestamp is preserved.');
    return { due: dayInZone(zone, Date.parse(instant)), dueTime: `${clock('hour')}:${clock('minute')}` };
  };
  const items: ImportItem[] = [], entities: BackupSnapshot['entities'] = [], mapping = new Map<string,string>(), sourceSeen = new Set<string>(), rowCounts = new Map<string,number>();
  const target = (group: string, id: string, kind = ({tasks:'task',projects:'project',chat_projects:'project',people:'contact',content:'content',documents:'content'} as Record<string,string>)[group]) => `${kind}:${namespace}:${digest([group,id]).slice(0,32)}`, key = (group: string, id: string) => `${group}\0${id}`;
  const add = (group: string, raw: unknown, kind?: Exclude<Kind,'layout'|'routine'>, convert?: (r: Record<string,any>, notes: string[]) => unknown) => {
    if (items.length >= 20000) throw new Fault(413, 'import_records', 'This export exceeds the 20,000-record review limit. Split it into supported exports.');
    const r = object.safeParse(raw), record = r.success ? r.data as Record<string,any> : {}, ordinal = rowCounts.get(group) ?? 0;
    rowCounts.set(group,ordinal+1);
    const id = typeof record.id === 'string' && record.id.length ? record.id : `row:${ordinal}`;
    if (sourceSeen.has(key(group,id))) throw new Fault(400, 'import_duplicate', 'The export has duplicate record identities. Obtain a fresh consistent export.');
    sourceSeen.add(key(group,id));
    const item: ImportItem = { source: group, sourceId: id, title: String(record.title ?? record.name ?? record.displayName ?? record.data?.title ?? ({ xp_events: 'XP history', profiles: 'Earlier character and profile' } as Record<string,string>)[group] ?? group).slice(0,240), outcome:'preserved', notes:[] }; items.push(item);
    if (!kind || !convert) { item.notes.push('Kept in the source archive; this record has no editable adapter.'); return; }
    try {
      if (!r.success) throw new Error('The source record is not an object.');
      const value = convert(record,item.notes), schema = kind === 'task' ? taskSchema : kind === 'draft' ? draftSchema : kind === 'project' ? projectSchema : recordSchemas[kind];
      const parsed = schema.parse(value), id = target(group,item.sourceId,kind);
      entities.push({ id,kind,revision:1,deviceId:namespace,updatedAt:typeof record.updatedAt === 'string' && stamp.safeParse(record.updatedAt).success ? record.updatedAt : createdAt,value:parsed });
      mapping.set(key(group,item.sourceId),id); Object.assign(item,{outcome:'editable',targetId:id,targetKind:kind}); item.notes.push('Original fields and history remain in the source archive.');
    } catch (error) { item.notes.push(error instanceof z.ZodError ? 'Some fields do not fit this version. The complete original is preserved.' : error instanceof Error ? error.message : 'The complete original is preserved.'); }
  };
  let priorProgress: ImportReview['priorProgress'];
  const legacyProfiles: Array<{id:string;name:string;xp:number;index:number}> = [], legacyXp: Array<{profileId:string;amount:number}> = [];
  const pendingProjects: Array<{ entityId: string; group: string; original: string }> = [], pendingDependencies: Array<{ entityId: string; group: string; originals: string[] }> = [];
  const referenceProject = (group: string, original: unknown) => typeof original === 'string' && original ? target(group,original) : null;
  const rows = (group: string, values: unknown, kind?: Exclude<Kind,'layout'|'routine'>, convert?: Parameters<typeof add>[3]) => {
    if (!Array.isArray(values)) { add(group, { id:'unrecognized',value:values }); return; }
    for (const raw of values) add(group,raw,kind,convert);
  };
  if (dc) {
    for (const [storageKey,serialized] of Object.entries(source.storage)) {
      let parsed: any; try { parsed = JSON.parse(serialized); } catch { add(storageKey,{id:storageKey}); continue; }
      if (storageKey === 'dream-claw-workshop-tasks' && parsed?.version === 3 && parsed.state && Array.isArray(parsed.state.tasks)) {
        rows('tasks',parsed.state.tasks,'task',(raw,notes)=> {
          const t = dcTask.parse(raw);
          if(t.parentId)throw new Error("This unrecognized parent field remains preserved with the original record.");
          if (t.recurrence || t.recurrenceSeriesId) notes.push('Recurring configuration is preserved. No schedule is started by this import.');
          if (Array.isArray(t.attachments) && t.attachments.length) notes.push(`${t.attachments.length} attachment references are preserved. Their file bytes must be transferred separately before use.`);
          if (t.automation || t.assignedAgent) notes.push('Earlier agent work stays preserved and is not restarted.');
          if (t.blockedByIds?.length) pendingDependencies.push({entityId:target('tasks',t.id),group:'tasks',originals:t.blockedByIds});
          return {title:t.title,notes:t.description,...(t.parentTaskId?{parentTaskId:target('tasks',t.parentTaskId)}:{}),status:({inbox:'open',queue:'open',inProgress:'active',blocked:'blocked',waiting:'waiting',done:'done'} as const)[t.status],planned:t.plannedDate??'',...deadline(t.dueAt,notes),...(t.plannedTime?{plannedTime:t.plannedTime}:{}),timezone:zone,priority:t.priority==='medium'?'normal':t.priority,bucket:t.status==='inbox'?'capture':'anytime',dependencies:[],...(t.checklist?{checklist:t.checklist.map(c=>({id:uuid(key(t.id,c.id)),text:c.text,done:c.done}))}:{})};
        });
        for (const [k,v] of Object.entries(parsed.state)) if(k!=='tasks') add(`workshop:${k}`,{id:k,value:v});
      } else if (storageKey === 'dream-claw-mission-control-v1' && parsed?.state && (parsed.version===0 || parsed.version===undefined)) {
        const state=object.parse(parsed.state);
        rows('projects',state.projects,'project',r=>{ const p=z.object({id:sid,name:text,description:text,status:z.enum(['active','paused','complete'])}).passthrough().parse(r); if(p.status!=='active') throw new Error('Paused or completed Project is preserved until its lifecycle can be represented faithfully.'); return {name:p.name,purpose:p.description}; });
        rows('people',state.people,'contact',r=>{const p=z.object({id:sid,name:text,role:text,handle:text,timezone,category:z.enum(['internal','content','external','client']),notes:text,tags:z.array(text)}).passthrough().parse(r);return {name:p.name,position:p.role,organization:'',email:'',phone:'',handle:p.handle,timezone:p.timezone,category:p.category,tags:p.tags,notes:p.notes,projectId:null,archived:false};});
        rows('content',state.contentItems,'content',(r,notes)=>{ const c=z.object({id:sid,title:text,platform:text,stage:z.enum(['ideas','scripting','thumbnail','filming','editing','published']),script:text,projectId:sid.optional()}).passthrough().parse(r); if(c.stage==='published') throw new Error('Published work is preserved with its original publication state; it needs a verified publication date before editable import.'); if(c.projectId)pendingProjects.push({entityId:target('content',c.id),group:'projects',original:c.projectId}); if(c.stage!=='ideas') notes.push(`Original production stage “${c.stage}” becomes Drafting; the original stage is kept.`); return {title:c.title,brief:'',body:c.script,format:'markdown',platform:c.platform,stage:c.stage==='ideas'?'ideas':'drafting',plannedDate:'',publication:null,projectId:referenceProject('projects',c.projectId),archived:false};});
        rows('documents',state.documents,'content',r=>{const d=z.object({id:sid,title:text,body:text,category:text,projectId:sid.optional()}).passthrough().parse(r);if(d.projectId)pendingProjects.push({entityId:target('documents',d.id),group:'projects',original:d.projectId});return {title:d.title,brief:'',body:d.body,format:'markdown',platform:'Document',stage:'drafting',plannedDate:'',publication:null,projectId:referenceProject('projects',d.projectId),archived:false,collection:d.category};});
        for(const [k,v] of Object.entries(state)) if(!['projects','people','contentItems','documents'].includes(k)) rows(`mission:${k}`,Array.isArray(v)?v:[{id:k,value:v}]);
      } else add(storageKey,{id:storageKey,value:parsed});
    }
  } else {
    for (const [table,data] of Object.entries(source.snapshot.tables)) {
      if(new Set(data.columns).size!==data.columns.length || data.rows.some(row=>row.length!==data.columns.length)) throw new Fault(400,'import_columns','The source snapshot has inconsistent table columns.');
      const records=data.rows.map(row=>Object.fromEntries(data.columns.map((column,i)=>[column,row[i]])));
      for(const [index,record] of records.entries()) {
        const raw=record.encrypted_payload ?? record.payload ?? record;
        let decoded=raw; if(typeof raw==='string') {try {decoded=JSON.parse(raw);}catch{/* Preserved as original. */}}
        if (['tasks','chat_projects','core_records'].includes(table) && typeof record.id === 'string' && object.safeParse(decoded).success && (decoded as Record<string,unknown>).id !== record.id) throw new Fault(400,'import_identity','The source table and payload identities disagree. Obtain a consistent backup.');
        if (table==='profiles') { const p=z.object({id:sid,kind:z.literal('human'),displayName:text,xp:z.number().int().nonnegative()}).safeParse(decoded);if(p.success)legacyProfiles.push({id:p.data.id,name:p.data.displayName,xp:p.data.xp,index}); }
        if (table==='xp_events') { const x=z.object({profileId:sid,amount:z.number().int()}).safeParse(decoded);if(x.success)legacyXp.push(x.data); }
        const preserve = () => add(table,{id:`row:${index}`,title:(decoded && typeof decoded==='object')?String((decoded as any).title??(decoded as any).name??(decoded as any).displayName??`${importGroupLabel(table)} · ${index+1}`):`${importGroupLabel(table)} · ${index+1}`,value:decoded});
        if(table==='tasks') add(table,decoded,'task',(r,notes)=>{const t=novaTask.parse(r);if(t.projectId)pendingProjects.push({entityId:target(table,t.id),group:'chat_projects',original:t.projectId}); if(t.recurrence && typeof t.recurrence==='object' && ((t.recurrence as any).cadence!=='none'||(t.recurrence as any).everyday))notes.push('Recurring configuration and occurrences remain preserved; no schedule is started.'); if(t.priority==='urgent')notes.push('Urgent priority becomes High; original urgency is kept.'); return {title:t.title,notes:t.notes,...(t.parentTaskId?{parentTaskId:target('tasks',t.parentTaskId)}:{}),status:t.waiting&&t.status==='blocked'?'waiting':({inbox:'open',todo:'open',in_progress:'active',blocked:'blocked',completed:'done',skipped:'skipped'} as const)[t.status],planned:'',...deadline(t.dueAt,notes),timezone:zone,priority:t.priority==='urgent'?'high':t.priority,projectId:referenceProject('chat_projects',t.projectId),...(t.waiting?{waitReason:t.waiting.label}:{}),bucket:t.status==='inbox'?'capture':'anytime'};});
        else if(table==='chat_projects') add(table,decoded,'project',(r,notes)=>{const p=z.object({id:sid,name:text,description:text,instructions:text,archived:z.boolean()}).passthrough().parse(r);if(p.archived)throw new Error('Archived Project is preserved until its lifecycle can be represented faithfully.');notes.push('Native sessions and approved folders stay preserved. Supported saved sources are verified separately; filesystem access is not granted by import.');return {name:p.name,purpose:p.description,instructions:p.instructions};});
        else if(table==='core_records') {
          const r=object.safeParse(decoded), data=r.success?object.safeParse(r.data.data):undefined, kind=data?.success?data.data.kind:undefined;
          if(kind==='contact') add(table,decoded,'contact',r=>{const c=z.object({id:sid,deletedAt:stamp.nullable(),data:z.object({kind:z.literal('contact'),title:text,body:text,email:z.union([z.literal(''),z.email()]),phone:text,organization:text})}).passthrough().parse(r);return {name:c.data.title,position:'',organization:c.data.organization,email:c.data.email,phone:c.data.phone,handle:'',timezone:zone,category:'external',tags:[],notes:c.data.body,projectId:null,archived:c.deletedAt!==null};});
          else if(kind==='draft') add(table,decoded,'content',r=>{const c=z.object({id:sid,deletedAt:stamp.nullable(),data:z.object({kind:z.literal('draft'),title:text,body:text,format:z.enum(['text','markdown'])})}).passthrough().parse(r);return {title:c.data.title,brief:'',body:c.data.body,format:c.data.format,platform:'Document',stage:'drafting',plannedDate:'',publication:null,projectId:null,archived:c.deletedAt!==null};});
          else preserve();
        } else preserve();
      }
    }
  }
  const preserveTarget = (id:string,note:string) => { const at=entities.findIndex(e=>e.id===id); if(at<0)return;entities.splice(at,1);const item=items.find(i=>i.targetId===id)!;mapping.delete(key(item.source,item.sourceId));item.outcome='preserved';delete item.targetId;delete item.targetKind;item.notes.push(note); };
  for(const p of pendingProjects) if(!mapping.has(key(p.group,p.original)))preserveTarget(p.entityId,'The linked Project is missing or preserved. This record is kept with its original link.');
  // Remove missing/cyclic dependencies and their dependents in linear graph order.
  const tasks = new Map(entities.filter(e=>e.kind==='task').map(e=>[e.id,e]));
  const dependencies = new Map(pendingDependencies.map(p=>[p.entityId,p.originals.map(id=>mapping.get(key(p.group,id))??'missing')]));
  const dependents = new Map<string,string[]>(), remaining = new Map<string,number>();
  for(const id of tasks.keys()){const deps=dependencies.get(id)??[];remaining.set(id,deps.length);for(const dep of deps)dependents.set(dep,[...(dependents.get(dep)??[]),id]);}
  const queue=[...tasks.keys()].filter(id=>remaining.get(id)===0), valid=new Set<string>();
  for(let n=0;n<queue.length;n++){const id=queue[n];valid.add(id);for(const child of dependents.get(id)??[]){const left=remaining.get(child)!-1;remaining.set(child,left);if(left===0)queue.push(child);}}
  for(const [id,e] of tasks){if(!valid.has(id))preserveTarget(id,'A dependency is missing, preserved or cyclic. The original dependency chain is kept.');else if(dependencies.has(id))(e.value as any).dependencies=dependencies.get(id);}
  const extended=dc?{files:[],references:[],services:[]}:extendNovaImport({source,namespace,entities,items});
  // Recurring conversion may replace a source task with a series. Reconcile
  // parent and prerequisite links against the final editable task identities.
  const finalTasks = entities.filter(entity=>entity.kind==='task') as Entity<Task>[];
  const taskIds = new Set(finalTasks.map(task=>task.id)), invalid = invalidTaskParents(finalTasks);
  const linkedBy = new Map<string,string[]>();
  for(const task of finalTasks)for(const link of [task.value.parentTaskId,...(task.value.dependencies??[])].filter((id):id is string=>!!id)){
    if(!taskIds.has(link))invalid.add(task.id);
    const list=linkedBy.get(link)??[];list.push(task.id);linkedBy.set(link,list);
  }
  const rejectedTasks=[...invalid];
  for(let n=0;n<rejectedTasks.length;n++)for(const id of linkedBy.get(rejectedTasks[n])??[])if(!invalid.has(id)){invalid.add(id);rejectedTasks.push(id);}
  for(const id of invalid)preserveTarget(id,'The parent relationship or prerequisite is missing, cyclic or preserved. The original linked task remains in the archive.');
  for(const task of finalTasks)if(task.value.parentTaskId&&!invalid.has(task.id))items.find(item=>item.targetId===task.id)?.notes.push('Parent and child remain separate editable tasks, each with its own plan and completion history.');
  const carried = verifiedImportedProgress(source);
  const earlierCompletions = new Set(entities.filter(e=>e.kind==='task'&&(e.value as any).status==='done').map(e=>e.id));
  if(carried && source.format==='nova-dream-backup-15') {
    const credits=new Map<string,bigint>();
    for(const event of carried.events)if(event.sourceType==='task')credits.set(event.sourceId,(credits.get(event.sourceId)??0n)+BigInt(event.amount));
    const editable = new Map(items.filter(i=>i.targetKind==='task'&&i.targetId).map(i=>[key(i.source,i.sourceId),i.targetId!]));
    for(const [original,credit] of credits)if(credit>0n){const id=editable.get(key('tasks',original));if(id)earlierCompletions.add(id);}
    for(const tableName of ['ordinary_task_occurrences','task_occurrences']) {
      const table=source.snapshot.tables[tableName],column=table?.columns.indexOf('id')??-1;if(!table||column<0)continue;
      table.rows.forEach((row,index)=>{if((credits.get(String(row[column]))??0n)<=0n)return;const id=editable.get(key(tableName,`row:${index}`));if(id)earlierCompletions.add(id);});
    }
    extended.services.push({id:'profile:imported-progress',revision:1,value:carried});
    entities.push({id:'profile:owner',kind:'profile',revision:1,deviceId:namespace,updatedAt:createdAt,value:recordSchemas.profile.parse({name:carried.name,position:'',about:'',appearance:null})});
    const originalProfile=legacyProfiles.find(p=>p.id===carried.profileId), profileItem=items.find(i=>i.source==='profiles'&&i.sourceId===`row:${originalProfile?.index}`);
    if(profileItem){Object.assign(profileItem,{outcome:'editable',targetId:'profile:owner',targetKind:'profile'});profileItem.notes=['Profile name and verified earlier XP are restored. The original character recipe, achievements and full profile remain archived; the current portrait can be customized separately.'];}

  }
  for(const id of earlierCompletions)extended.services.push({id:'tasks:legacy-completion:'+id,revision:1,value:{sourceHash}});
  const layout={...structuredClone(defaultLayout),timezone:zone};
  if(dc){const raw=source.storage['dream-claw-home-widget-layout-v2'];if(raw){try{const l=z.object({schemaVersion:z.literal(2),order:z.array(z.string()),sizes:z.record(z.string(),z.enum(['compact','square','wide','large']))}).parse(JSON.parse(raw));const order=l.order.filter(id=>layout.widgets.some(w=>w.id===id));layout.widgets.sort((a,b)=>(order.indexOf(a.id)<0?99:order.indexOf(a.id))-(order.indexOf(b.id)<0?99:order.indexOf(b.id)));for(const w of layout.widgets)if(l.sizes[w.id])w.size=l.sizes[w.id];}catch{/* Source item is preserved. */}}}
  const groups=new Map<string,string[]>();for(const e of entities)if(e.kind==='task'&&!['done','skipped'].includes((e.value as any).status)){const k=(e.value as any).title.trim().toLocaleLowerCase();groups.set(k,[...(groups.get(k)??[]),e.id]);}
  entities.unshift({id:'layout',kind:'layout',revision:1,deviceId:namespace,updatedAt:createdAt,value:layout});
  if(legacyProfiles.length===1){const p=legacyProfiles[0],events=legacyXp.filter(e=>e.profileId===p.id);priorProgress={name:p.name,xp:p.xp,ledgerEvents:events.length,ledgerTotal:events.reduce((sum,e)=>sum+e.amount,0),...(carried?{carried:true as const}:{})};}
  const review:ImportReview={id:reviewId,source:dc?'Dream Claw':'Nova Dream',version:dc?source.appVersion:source.snapshot.appVersion,createdAt,sourceHash,targetHash:digest({entities,items,...extended}),timezone:zone,...(priorProgress?{priorProgress}:{}),items,counts:{editable:items.filter(i=>i.outcome==='editable').length,preserved:items.filter(i=>i.outcome==='preserved').length,linked:items.filter(i=>i.outcome==='linked').length},duplicates:[...groups.values()].filter(list=>list.length>1),notes:['Every original source field is retained in the encrypted source archive.','Import creates a separate workspace. It does not combine or replace your current work.','Accounts, native conversations, agent jobs, reminders and recurring schedules are not restarted.',carried?'Verified earlier XP carries into Profile with its original ledger. Earlier completions do not earn new XP; original character recipes and unsupported records remain archived.':'Original XP, character recipes and unsupported records remain in the source archive; no new XP is fabricated.']};
  const snapshot:BackupSnapshot={format:backupFormat,schema:52,version,id:reviewId,createdAt,epoch:uuid(namespace),cursor:0,entities,history:[],receipts:[],services:[...extended.services,{id:'migration:source:'+reviewId,revision:1,value:source},{id:'migration:review:'+reviewId,revision:1,value:review}],files:extended.files,references:extended.references,native:{status:'not-configured',notes:['Predecessor native history remains with its original host. No native session was replaced or resumed.']}};
  Store.verifyBackup(snapshot);return {source,review,snapshot};
}
