import { createHash } from 'node:crypto';
import { canonical, type Attachment, type Entity } from '../../packages/domain/contracts.js';
import type { AssignmentAttempt } from '../../packages/domain/assignments.js';
import type { ConnectedAttempt } from '../../packages/domain/connected-work.js';
import type { AssistantOutput } from '../../packages/domain/assistant.js';
import { agentMayUse } from '../../packages/domain/agent-capabilities.js';
import type { HomeItem, HomeReference } from '../../packages/domain/home-library.js';
import type { AgentDesign, Content } from '../../packages/domain/workspace-records.js';
import { workSourceCheckRequestSchema, workSourceSelectionsSchema, type CapturedWorkSource, type WorkSourceCheck,
  type WorkSourceInspection, type WorkSourceMaterial, type WorkSourceSelection } from '../../packages/domain/work-sources.js';
import { Fault, Store } from './store.js';

type Lead = Entity<AgentDesign>;
type Owner = { current: HomeReference; material: (ref: HomeReference) => WorkSourceMaterial | undefined };
type AttemptWithSources = AssignmentAttempt & { capture?: { agent: Lead; workSources?: CapturedWorkSource[] } };
type AccessWalk = { visiting:Set<string>; allowed:Set<string>; sources:Set<string>; remaining:number; nested:number };
const newWalk = (): AccessWalk => ({ visiting:new Set(), allowed:new Set(), sources:new Set(), remaining:4096, nested:0 });
const exact = (left: HomeReference, right: HomeReference | undefined) => !!right && canonical(left) === canonical(right);
const supported = new Set(['note','link','content','output','assignment']);
const sourceTextLimit = 90000; // Same saved Library context budget as HomeLibrary.capture.
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const material = (value: Omit<WorkSourceMaterial,'sha256'>): WorkSourceMaterial => ({ ...value, sha256:sha(canonical(value)) });
const fault = (kind: 'denied' | 'missing' | 'unavailable') => new Fault(kind === 'denied' ? 403 : 409,'work_source_'+kind,{
  denied:'This agent cannot use this source with its current access.',
  missing:'This source is unavailable. Remove or replace it before starting.',
  unavailable:'The exact selected content is unavailable. Choose an available version or remove this source.',
}[kind]);

/** Only selected source bytes cross the agent boundary. No URL fetching, extraction, or implicit attachments. */
export class WorkSourceService {
  constructor(private store: Store, private now = Date.now) {}

  checks(raw: unknown): {sources:WorkSourceCheck[]} {
    const input = workSourceCheckRequestSchema.parse(raw);
    if (input.epoch !== this.store.epoch) throw new Fault(409,'epoch_changed','Reload the current workspace before checking sources.');
    return this.store.internalReadSnapshot(() => {
      const agent = input.agentId ? this.store.readEntity('agent',input.agentId) : undefined;
      const checks = input.sources.map(selection => input.agentId && !agent ?
        this.refusal(selection.reference,'denied') : this.check(selection,agent ?? null));
      if (checks.reduce((total,row) => total + (row.selected?.text?.length ?? 0),0) > sourceTextLimit) {
        for (const row of checks) if (row.ready) {
          row.ready=false; row.message='The selected text exceeds the 90,000-character input limit. Remove a source before starting.';
        }
      }
      return {sources:checks};
    });
  }

  private refusal(reference:HomeReference, status:'denied'|'missing'|'unavailable'|'unsupported'):WorkSourceCheck {
    return {reference,current:null,ready:false,canUseSelected:false,status,
      message:status==='unsupported' ? 'Choose a saved note, link, Content item or saved result for this workflow.' : fault(status).message};
  }

  private hasRead(agent:Lead | null, kind:HomeReference['kind']) {
    if (!agent) return true; // Owner inspection on the authenticated planning route.
    const latest=this.store.readEntity('agent',agent.id);
    const module=kind==='content'?'content':'home';
    return !!latest && !latest.value.archived && !agent.value.archived &&
      agentMayUse(agent.value.access ?? {},latest.value.access ?? {},module+'.read',{},false);
  }

  private projectAvailable(projectId:string|null|undefined) {
    return !projectId || (!!this.store.readEntity('project',projectId) && !this.store.projectIsDeleted(projectId));
  }

  private derivedAllowed(attempt:AttemptWithSources|undefined, viewer:Lead|null, walk:AccessWalk) {
    if (!attempt) return false;
    if (!attempt.connected) return true;
    // Revisions can form a long linear history; traverse them without growing the JS stack.
    // Only results selected as inputs descend recursively, with per-read memoization.
    if (walk.nested>=32) return false;
    const active:string[]=[], checked:string[]=[];
    let current:AttemptWithSources|undefined=attempt;
    walk.nested++;
    try {
      while (current) {
        const key=canonical([current.id,viewer?.id,viewer?.revision]), capture=current.capture;
        const link:ConnectedAttempt|undefined=current.connected;
        if (walk.allowed.has(key)) break;
        if (!link || !capture?.agent || !capture.workSources?.length || current.epoch!==this.store.epoch ||
          !this.projectAvailable(current.projectId) || walk.visiting.has(current.id) || --walk.remaining<0) return false;
        walk.visiting.add(current.id);active.push(current.id);checked.push(key);
        for (const source of capture.workSources) {
          if (source.epoch!==this.store.epoch || !this.allowedSource(source.reference,capture.agent,walk)) return false;
          if (viewer && (viewer.id!==capture.agent.id || viewer.revision!==capture.agent.revision) &&
              !this.allowedSource(source.reference,viewer,walk)) return false;
        }
        // A base review points to its exact subject, so this same chain also checks its base author.
        const predecessor:string|undefined=link.role==='review'?link.subjectAttemptId:link.baseReviewAttemptId??link.baseAttemptId;
        if (!predecessor) {
          if (link.role!=='result' || link.baseReviewSha256 || link.number!==1 || link.rootAttemptId!==current.id) return false;
          break;
        }
        const prior:AttemptWithSources|undefined=this.store.internalRead<AttemptWithSources>('assignments:attempt:'+predecessor);
        if (!prior?.connected || prior.id!==predecessor || prior.connected.rootAttemptId!==link.rootAttemptId ||
          prior.state!=='returned' || prior.result?.disposition!=='visible') return false;
        if (link.role==='review') {
          if (prior.connected.role!=='result' || prior.result.file.sha256!==link.subjectSha256) return false;
        } else if (link.baseReviewAttemptId) {
          if (prior.connected.role!=='review' || !link.baseAttemptId || prior.connected.subjectAttemptId!==link.baseAttemptId ||
            prior.result.file.sha256!==link.baseReviewSha256) return false;
        } else if (prior.connected.role!=='result' || link.baseReviewSha256) return false;
        current=prior;
      }
      for (const key of checked) walk.allowed.add(key);
      return true;
    } finally { for(const id of active)walk.visiting.delete(id);walk.nested--; }
  }

  canUseConnectedAttempt(attemptId:string,viewer:Lead|null=null):boolean {
    const original=this.store.internalRead<AttemptWithSources>('assignments:attempt:'+attemptId);
    return !!original?.connected && original.id===attemptId && this.derivedAllowed(original,viewer,newWalk());
  }

  private allowedSource(ref:HomeReference,agent:Lead|null,walk:AccessWalk) {
    const key=canonical([ref,agent?.id,agent?.revision]);
    if (walk.sources.has(key)) return true;
    try {
      const owner=this.owner(ref,agent,walk);
      if (ref.kind==='content' && ref.revision!==owner.current.revision) {
        const prior=this.store.capturedContent(ref.id,ref.revision);
        if (!prior) return false;
        this.contentAvailable(prior.value,agent,walk);
      }
      walk.sources.add(key);return true;
    }
    catch (error) { if(error instanceof Fault && error.code.startsWith('work_source_'))return false;throw error; }
  }

  private contentAvailable(value:Content,agent:Lead|null,walk:AccessWalk) {
    if (value.archived || !this.projectAvailable(value.projectId)) throw fault('missing');
    if (!this.connectedContentAllowed(value,agent,walk)) throw fault('denied');
  }

  private connectedContentAllowed(value:Content, viewer:Lead|null, walk:AccessWalk) {
    const source=value.source;
    if (source?.kind!=='assignment' || !source.connected) return true;
    const original=this.store.internalRead<AttemptWithSources>('assignments:attempt:'+source.attemptId);
    return !!original?.connected && original.id===source.attemptId && original.connected.role==='result' &&
      original.connected.rootAttemptId===source.connected.rootAttemptId && original.connected.number===source.connected.number &&
      original.connected.baseAttemptId===source.connected.baseAttemptId && original.state==='returned' && original.terminal?.status==='ok' &&
      original.assignmentId===source.assignmentId && original.assignmentRevision===source.assignmentRevision &&
      original.agentId===source.agentId && original.agentRevision===source.agentRevision && original.runId===source.runId &&
      original.nativeSessionId===source.nativeId && original.terminal.turnId===source.turnId && original.result?.disposition==='visible' &&
      original.result.file.id===source.fileId && original.result.file.sha256===source.sha256 && this.derivedAllowed(original,viewer,walk);
  }

  /** Protect only files produced by connected assignments. Existing ordinary attachments keep their policy. */
  assertFileAccess(fileId:string) {
    const attemptId=this.store.internalRead<string>('connected:result-file:'+fileId);
    if (attemptId===undefined) return;
    if (this.store.inUntrackedAgentWork()) throw new Fault(403,'work_source_connected_required','Select this result through Library → Prepare Assignment so its source permissions stay attached.');
    const attempt=this.store.internalRead<AttemptWithSources>('assignments:attempt:'+attemptId);
    if (!attempt?.connected || attempt.id!==attemptId || attempt.state!=='returned' || attempt.terminal?.status!=='ok' ||
      !attempt.runId || !attempt.nativeSessionId || attempt.result?.disposition!=='visible' || attempt.result.file.id!==fileId ||
      !this.derivedAllowed(attempt,null,newWalk())) throw fault('denied');
  }

  canReadLibraryReference(ref:HomeReference):boolean {
    if (ref.kind==='assignment') {
      const attempt=this.store.internalRead<AttemptWithSources>('assignments:attempt:'+ref.id);
      if (!attempt) return false;
      return !attempt.connected || (attempt.id===ref.id && attempt.result?.file.sha256===ref.sha256 &&
        attempt.assignmentRevision===ref.revision && this.derivedAllowed(attempt,null,newWalk()));
    }
    if (ref.kind==='content') {
      const current=this.store.capturedContent(ref.id);
      const selected=current?.revision===ref.revision?current:this.store.capturedContent(ref.id,ref.revision);
      for (const row of new Set([current,selected])) {
        if (row && !this.connectedContentAllowed(row.value,null,newWalk())) return false;
      }
    }
    return true;
  }

  /** Ordinary Assistant drafts store quoted text without the connected workflow's permission lineage. */
  assertOrdinaryHandoff(kind:string,id:string,revision?:number) {
    const assignment=kind==='assignment'?this.store.internalRead<AttemptWithSources>('assignments:attempt:'+id):undefined;
    const content=kind==='content'?this.store.capturedContent(id,revision):undefined;
    if(assignment?.connected || (content?.value.source?.kind==='assignment' && content.value.source.connected))
      throw new Fault(409,'connected_handoff_required','Choose Prepare Assignment in Library to keep this result linked to its protected sources.');
  }

  private resultMaterial(ref:HomeReference,current:HomeReference,title:string,file:Attachment,mime:string|undefined) {
    if (!exact(ref,current)) return undefined;
    const textual=mime ? /^(text\/[^;]+|application\/(?:json|xml|[a-z0-9.+-]+\+json))(?:;|$)/i.test(mime)
      : /\.(?:txt|md|markdown|csv|json|xml|html?)$/i.test(file.name);
    const metadata=() => material({title,representation:'reference-only',omissions:['File contents were not supplied.']});
    if (!textual || file.size>400000) return metadata();
    let actual:ReturnType<Store['download']>;
    try { actual=this.store.download(file.id); }
    catch(error) {
      if ((error instanceof Fault && ['attachment_missing','attachment_corrupt'].includes(error.code)) ||
          (error as NodeJS.ErrnoException).code==='ENOENT') throw fault('unavailable');
      throw error;
    }
    if (canonical(actual.metadata)!==canonical(file)) throw fault('unavailable');
    let text:string;
    try { text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(actual.bytes); }
    catch { return metadata(); }
    if (text.length>sourceTextLimit || !text.trim() || text.includes('\0')) return metadata();
    return material({title,representation:'result-text',text,omissions:[]});
  }

  private owner(ref:HomeReference,agent:Lead|null,walk:AccessWalk):Owner {
    if (!this.hasRead(agent,ref.kind) || --walk.remaining<0) throw fault('denied');
    if (ref.kind==='note' || ref.kind==='link') {
      const item=this.store.internalRead<HomeItem>('home:library:item:'+ref.id);
      if (!item || item.kind!==ref.kind || item.archived) throw fault('missing');
      const current={kind:item.kind,id:item.id,revision:item.revision};
      return {current,material:selected=>{
        if(selected.kind!==current.kind || selected.id!==current.id || selected.sha256!==undefined) return undefined;
        const saved=selected.revision===item.revision?item:this.store.internalRead<HomeItem>(
          'home:library:version:item-save:'+item.id+':'+selected.revision);
        if(!saved || saved.kind!==selected.kind || saved.id!==selected.id || saved.revision!==selected.revision || saved.archived)return undefined;
        if(saved.kind==='link')return material({title:saved.title,representation:'reference-only',url:saved.url,
          omissions:['Linked page contents were not fetched or supplied.',...(saved.body?['Saved link notes were not supplied.']:[])]});
        if(!saved.body.trim() || saved.body.length>sourceTextLimit)return undefined;
        return material({title:saved.title,representation:'saved-text',text:saved.body,omissions:[]});
      }};
    }
    if(ref.kind==='content') {
      const item=this.store.capturedContent(ref.id);
      if (!item)throw fault('missing');
      this.contentAvailable(item.value,agent,walk);
      const current={kind:ref.kind,id:item.id,revision:item.revision};
      return {current,material:selected=>{
        if(selected.kind!==current.kind || selected.id!==current.id || selected.sha256!==undefined)return undefined;
        const old=selected.revision===item.revision?item:this.store.capturedContent(item.id,selected.revision);
        if (!old)return undefined;
        this.contentAvailable(old.value,agent,walk);
        const text=old.value.body;
        if (!text.trim() || text.length>sourceTextLimit)return undefined;
        return material({title:old.value.title,representation:'saved-text',text,
          omissions:[...(old.value.brief?['The separate Content brief was not supplied.']:[]),...(old.value.assets?.length?['Attached files were not supplied.']:[])]});
      }};
    }
    if (ref.kind==='output' || ref.kind==='assignment') {
      const output=ref.kind==='output'?this.store.internalRead<AssistantOutput>('assistant:output:'+ref.id):undefined;
      const attempt=ref.kind==='assignment'?this.store.internalRead<AttemptWithSources>('assignments:attempt:'+ref.id):undefined;
      const file=output?.file ?? attempt?.result?.file;
      if (!file || !this.projectAvailable(output?.projectId??attempt?.projectId) || (output && output.state!=='ready')
        || (attempt && (attempt.epoch!==this.store.epoch || attempt.state!=='returned' || attempt.terminal?.status!=='ok' ||
          !attempt.runId || !attempt.nativeSessionId || attempt.result?.disposition!=='visible'))) throw fault('missing');
      if (attempt && !this.derivedAllowed(attempt,agent,walk))throw fault('denied');
      try { if (canonical(this.store.blobMetadata(file.id))!==canonical(file)) throw fault('missing'); }
      catch (error) { if(error instanceof Fault && error.code==='attachment_missing')throw fault('missing');throw error; }
      const current={kind:ref.kind,id:ref.id,revision:output?.version??attempt!.assignmentRevision,sha256:file.sha256};
      return {current,material:selected=>this.resultMaterial(selected,current,output?.name??attempt!.title,file,output?.mimeType)};
    }
    throw fault('unavailable');
  }

  private check(selection:WorkSourceSelection,agent:Lead|null):WorkSourceCheck {
    const ref=selection.reference;
    if(!supported.has(ref.kind))return this.refusal(ref,'unsupported');
    try {
      const owner=this.owner(ref,agent,newWalk()),unchanged=exact(ref,owner.current);
      const selected=owner.material(ref),latest=unchanged?undefined:owner.material(owner.current);
      const confirmed=unchanged || exact(owner.current,selection.confirmedAgainst);
      const metadata=selected?.representation==='reference-only';
      const ready=!!agent && !!selected && confirmed && (!metadata || selection.allowReferenceOnly===true);
      let status:WorkSourceCheck['status']='ready',message='This exact source version can be supplied.';
      if(!unchanged && !confirmed){status='changed';message=selected?'A newer version is available. Choose which version to supply.':'This selected version is unavailable. Choose the latest version or remove it.';}
      else if(!selected){status='unavailable';message='The selected version has no eligible text or cannot be retrieved. Replace or remove it.';}
      else if(metadata){status='reference-only';message=selection.allowReferenceOnly?'Only the reference metadata will be supplied.':'Confirm that only the reference metadata may be supplied.';}
      if(!agent && status==='ready')message='Choose a lead agent to check its access before starting.';
      return {reference:ref,current:owner.current,canUseSelected:!!selected,ready,status,message,...(selected?{selected}:{}),...(latest?{latest}:{})};
    } catch(error) {
      if (error instanceof Fault && error.code.startsWith('work_source_'))return this.refusal(ref,
        error.code==='work_source_denied'?'denied':error.code==='work_source_missing'?'missing':'unavailable');
      throw error;
    }
  }

  capture(agent:Lead,selections:WorkSourceSelection[]):CapturedWorkSource[] {
    const sources=workSourceSelectionsSchema.min(1).parse(selections);
    const capturedAt=new Date(this.now()).toISOString();
    const result=sources.map(selection=>{
      const check=this.check(selection,agent);
      if(!check.ready || !check.selected || !check.current)throw new Fault(check.status==='denied'?403:409,'assignment_source_'+check.status,check.message);
      return {epoch:this.store.epoch,origin:'library' as const,reference:selection.reference,availableAtCapture:check.current,capturedAt,material:check.selected};
    });
    if(result.reduce((n,s)=>n+(s.material.text?.length??0),0)>sourceTextLimit)throw new Fault(413,'assignment_sources_large','The selected text exceeds 90,000 characters. Remove a source before starting.');
    return result;
  }

  private accessible(agent:Lead,source:CapturedWorkSource,requireUnchangedCurrent=false) {
    if(source.epoch!==this.store.epoch || !supported.has(source.reference.kind))return false;
    try {
      const walk=newWalk(), owner=this.owner(source.reference,agent,walk);
      if(source.reference.kind==='content' && source.reference.revision!==owner.current.revision) {
        const prior=this.store.capturedContent(source.reference.id,source.reference.revision);
        if(!prior)return false;
        this.contentAvailable(prior.value,agent,walk);
      }
      if(requireUnchangedCurrent && !exact(source.availableAtCapture,owner.current))return false;
      if(requireUnchangedCurrent) {
        const material=owner.material(source.reference);
        if(!material || material.sha256!==source.material.sha256)return false;
      }
      return true;
    } catch(error) { if(error instanceof Fault && error.code.startsWith('work_source_'))return false;throw error; }
  }

  permitted(agent:Lead,sources:CapturedWorkSource[]):boolean { return sources.every(source=>this.accessible(agent,source)); }
  recheck(agent:Lead,sources:CapturedWorkSource[],options:{requireUnchangedCurrent?:boolean}={}) {
    if(!sources.every(s=>this.accessible(agent,s,options.requireUnchangedCurrent)))throw new Fault(409,'assignment_sources_unavailable','A selected source changed or access was withdrawn. Review the sources before continuing.');
  }
  inspect(agent:Lead,sources:CapturedWorkSource[]):WorkSourceInspection[] {
    return sources.map(s=>this.accessible(agent,s)?{reference:s.reference,capturedAt:s.capturedAt,accessible:true,material:s.material}
      : {reference:s.reference,capturedAt:s.capturedAt,accessible:false});
  }
}
