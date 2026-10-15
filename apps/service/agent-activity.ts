import { randomUUID } from 'node:crypto';
import { canonical } from '../../packages/domain/contracts.js';
import { assignmentTerminal } from '../../packages/domain/assignments.js';
import { agentActivityCommandSchema, defaultAgentActivityPreferences, type AgentActivityPreference, type AgentActivityState, type AgentActivityEvent, type AgentConversationCapture, type AgentWorkReference } from '../../packages/domain/agent-activity.js';
import type { HubLayout } from '../../packages/domain/hub-layout.js';
import { hubLayoutKey } from '../../packages/domain/hub-layout.js';
import type { TeamWork } from '../../packages/domain/team-work.js';
import type { AssistantOperation } from '../../packages/domain/assistant.js';
import type { AgentAccess } from '../../packages/domain/agent-capabilities.js';
import { Store, Fault } from './store.js';
import { AssignmentService } from './assignments.js';
import type { HubMeetings } from './hub-meetings.js';

type SavedPreference = AgentActivityPreference & { epoch: string; device: string; nextMotionAt: number; day: string };
type ConversationOccurrence = { id: string; epoch: string; device: string; capture: AgentConversationCapture; gatherRequestId: string; startRequestId: string; roomId: string; meetingId?: string; state: 'prepared' | 'started' | 'blocked'; message?: string };
type SleepIntent = { id: string; epoch: string; device: string; agentId: string; pause: { requestId: string; meetingId: string; expectedRevision: number }; state: 'pending' | 'requested' | 'review'; message?: string };
const preferenceKey = (id: string) => `agents:activity:preference:${id}`;
const logKey = 'agents:activity:events';
const occurrencePrefix = 'agents:activity:conversation:';
const publicPreference = ({ epoch, device, nextMotionAt, day, ...value }: SavedPreference): AgentActivityPreference => value;

/** Preferences authorize bounded read-only conversations; room activity never
 * changes a worker's status or stands in for a returned model contribution. */
export class AgentActivity {
  private meetings?: HubMeetings;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private store: Store, private assignments: AssignmentService, private now = Date.now, private random = Math.random) {
    assignments.setAutonomyGuard((capture, attemptId) => this.assertCapture(capture, attemptId));
    assignments.setAutomaticEligibility(id => this.canStartAutomatic(id));
  }
  attachMeetings(meetings: HubMeetings) { this.meetings = meetings; }
  preference(id: string): SavedPreference {
    const saved = this.store.internalRead<SavedPreference>(preferenceKey(id));
    if (saved?.epoch === this.store.epoch) return saved;
    return { agentId: id, revision: 0, value: defaultAgentActivityPreferences(), updatedAt: 0, epoch: this.store.epoch, device: '', nextMotionAt: 0, nextConversationAt: null, conversationsToday: 0, day: '' };
  }
  state(): AgentActivityState {
    return { preferences: this.store.listEntities('agent').filter(a => !a.value.archived).map(a => { const p=this.preference(a.id);return publicPreference({...p,busy:this.isBusy(a.id),conversationsToday:p.day===this.day()?p.conversationsToday:0}); }), events: this.store.internalRead<AgentActivityEvent[]>(logKey) ?? [], conversations: this.store.internalList<ConversationOccurrence>(occurrencePrefix).filter(o=>o.epoch===this.store.epoch).sort((a,b)=>b.capture.at-a.capture.at).slice(0,20).map(o=>({id:o.id,at:o.capture.at,agentIds:o.capture.participants.map(p=>p.agentId),state:o.state,...(o.meetingId?{meetingId:o.meetingId}:{}),...(o.message?{message:o.message}:{})})), sleepRequests:this.store.internalList<SleepIntent>('agents:activity:sleep:').filter(i=>i.epoch===this.store.epoch).slice(-20).map(i=>({id:i.id,agentId:i.agentId,meetingId:i.pause.meetingId,state:i.state,...(i.message?{message:i.message}:{})})) };
  }
  private day() { return new Intl.DateTimeFormat('en-CA',{timeZone:this.store.readEntity('layout','layout')?.value.timezone??'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(this.now())); }
  private event(agentId: string, action: AgentActivityEvent['action'], reason: string, meetingId?: string, origin: AgentActivityEvent['origin']='owner') {
    const event: AgentActivityEvent = { id: randomUUID(), agentId, action, reason, at: this.now(), origin, ...(meetingId ? { meetingId } : {}) };
    const previous = this.store.internalRead<AgentActivityEvent[]>(logKey) ?? [];
    this.store.internalWrite(logKey, [...previous, event].slice(-80));
    return event;
  }
  isBusy(id: string) {
    if (this.assignments.activity().some(a => a.agentId === id && !assignmentTerminal(a.state))) return true;
    if (this.teamBusy(id)) return true;
    const meeting = this.meetings?.state().current;
    return !!meeting && meeting.state === 'running' && meeting.attendees.some(a => a.id === id);
  }
  private teamBusy(id: string) {
    return this.store.internalList<TeamWork & { epoch: string }>('team:run:').some(t=>{
      const step=t.steps[t.next];if(t.epoch!==this.store.epoch||!step||step.agentId!==id||['complete','cancelled'].includes(t.state))return false;
      const operation=step.operationId?this.store.internalRead<AssistantOperation>('assistant:operation:'+step.operationId):undefined;
      return operation?!['completed','failed','cancelled'].includes(operation.state):['running','stopping'].includes(t.state)||['running','unknown'].includes(step.state);
    });
  }
  canStartAutomatic(id: string) { return this.preference(id).value.sleep === 'awake'; }
  assertAwake(id: string) {
    if (!this.canStartAutomatic(id)) throw new Fault(409, 'agent_asleep', 'Wake this agent before starting new work. Existing work and its result are kept.');
  }
  command(device: string, raw: unknown) {
    const input = agentActivityCommandSchema.parse(raw);
    const admitted = this.store.admit(device, input, { operation: 'agent.activity', ...input }, () => {
      const agent = this.store.readEntity('agent', input.agentId);
      if (!agent || agent.value.archived) throw new Fault(409, 'agent_unavailable', 'Choose a current agent.');
      const current = this.preference(input.agentId);
      if (current.revision !== input.expectedRevision) throw new Fault(409, 'agent_activity_changed', 'These preferences changed in another window. Review the saved version.', publicPreference(current));
      if (input.type === 'interact') {
        this.assertAwake(input.agentId);
        if (this.isBusy(input.agentId)) throw new Fault(409, 'agent_busy', 'This agent has unfinished work. Its current attempt is kept.');
        return { preference: publicPreference(current), event: this.event(input.agentId, input.action, input.action === 'coffee' ? 'You chose a coffee break.' : input.action === 'office' ? 'You chose Return To Office.' : input.action === 'visit' ? 'You chose Visit Office.' : 'You chose to say hello.') };
      }
      const saved: SavedPreference = { ...current, epoch: this.store.epoch, device, revision: current.revision + 1, updatedAt: this.now() };
      if (input.type === 'preferences') {
        saved.value = { ...input.value, sleep: current.value.sleep };
        saved.nextConversationAt = saved.value.initiative === 'proactive' && saved.value.sleep === 'awake' ? this.now() + saved.value.intervalMinutes * 60_000 : null;
        saved.nextMotionAt = this.now() + 8000;
      } else if (input.type === 'wake') {
        saved.value = { ...current.value, sleep: 'awake' };
        saved.nextMotionAt = this.now() + 8000;
        saved.nextConversationAt = saved.value.initiative === 'proactive' ? this.now() + saved.value.intervalMinutes * 60_000 : null;
        this.event(input.agentId, 'wake', 'You woke this agent.');
      } else {
        if (input.pauseMeeting) {
          const meeting = this.meetings?.state().current;
          if (!meeting || meeting.id !== input.pauseMeeting.id || meeting.revision !== input.pauseMeeting.revision || !meeting.attendees.some(a => a.id === input.agentId)) throw new Fault(409, 'meeting_changed', 'Review the current discussion before pausing it.');
        }
        saved.value = { ...current.value, sleep: this.isBusy(input.agentId) ? 'after-work' : 'asleep' };
        saved.nextConversationAt = null;
        if (saved.value.sleep === 'asleep') this.event(input.agentId, 'sleep', 'You put this agent to sleep.');
      }
      this.store.internalWrite(preferenceKey(input.agentId), saved);
      if(input.type==='sleep'&&input.pauseMeeting){const intent:SleepIntent={id:input.requestId,epoch:this.store.epoch,device,agentId:input.agentId,pause:{requestId:randomUUID(),meetingId:input.pauseMeeting.id,expectedRevision:input.pauseMeeting.revision},state:'pending'};this.store.internalWrite('agents:activity:sleep:'+intent.id,intent);}
      return { preference: publicPreference(saved), ...(input.type === 'sleep' && input.pauseMeeting ? { sleepIntentId: input.requestId } : {}) };
    }).value;
    if ('sleepIntentId' in admitted && admitted.sleepIntentId) this.reconcileSleepIntent(admitted.sleepIntentId, true);
    return admitted;
  }
  private reconcileSleepIntent(id:string,retry=false) {
    let intent=this.store.internalRead<SleepIntent>('agents:activity:sleep:'+id);if(!intent||intent.state==='requested'||intent.state==='review'&&!retry||intent.epoch!==this.store.epoch||!this.meetings)return;
    try{
      try{this.meetings.command(intent.device,{type:'pause',epoch:intent.epoch,...intent.pause});}
      catch(error){
        if(!(error instanceof Fault)||error.code!=='meeting_changed')throw error;
        const meeting=this.meetings.detail(intent.pause.meetingId);
        if(!meeting.attendees.some(a=>a.id===intent!.agentId))throw new Fault(409,'meeting_changed','The original Sleep participant is no longer in this discussion.');
        if(!['paused','ended','complete'].includes(meeting.state)){
          // A rejected revision writes no receipt. Bind the same pause identity
          // to the reconciled revision durably before the one bounded retry.
          intent={...intent,pause:{...intent.pause,expectedRevision:meeting.revision}};
          this.store.internalWrite('agents:activity:sleep:'+id,intent);
          this.meetings.command(intent.device,{type:'pause',epoch:intent.epoch,...intent.pause});
        }
      }
      this.store.internalWrite('agents:activity:sleep:'+id,{...intent,state:'requested',message:'Discussion pause requested. Any held native attempt still needs its original confirmation.'});
    }catch(error){this.store.internalWrite('agents:activity:sleep:'+id,{...intent,state:'review',message:error instanceof Error?error.message:'The original discussion pause needs review.'});throw error;}
  }
  private workReference(id: string, sharingAccess: AgentAccess[]): AgentWorkReference | undefined {
    const plans = this.store.listEntities('assignment').filter(p => p.value.agentId === id && !p.value.archived && !p.id.startsWith('assignment:meeting:'));
    const latest = this.assignments.activity().filter(a => a.agentId === id && plans.some(p => p.id === a.assignmentId)).sort((a, b) => b.createdAt - a.createdAt)[0];
    const plan = latest ? plans.find(p => p.id === latest.assignmentId) : plans[0];
    if(!plan)return undefined;
    const detail=latest?this.assignments.detail(latest.id):undefined,source=detail?.capture.plan.value??plan.value,sourceAccess=detail?.capture.agent.value.access??this.store.readEntity('agent',id)?.value.access??{};
    const shared=Object.keys(sourceAccess).every(key=>sharingAccess.every(access=>!!access[key as keyof AgentAccess]));
    const result=detail?.attempt.result;
    return { assignmentId: plan.id, assignmentRevision: plan.revision, title: latest?.title??plan.value.title,
      ...(latest ? { attemptId: latest.id, attemptUpdatedAt: latest.updatedAt, attemptState: latest.state, capturedAssignmentRevision:latest.assignmentRevision, ...(latest.result ? { resultFileId: latest.result.file.id } : {}) } : {}),
      ...(shared?{brief:source.brief.slice(0,2000),briefTruncated:source.brief.length>2000,expectedOutput:source.expectedOutput.slice(0,1000),expectedOutputTruncated:source.expectedOutput.length>1000,...(result?.preview?{resultExcerpt:result.preview.slice(0,1600),resultExcerptTruncated:result.previewTruncated||result.preview.length>1600}:{unavailable:'No returned result excerpt is available. The saved assignment brief is included.'})}:{unavailable:'Work excerpts are not shared because participant read scopes do not cover the original source access. Linked status metadata only.'}) };
  }
  capture(ids: string[]): AgentConversationCapture {
    const capture: AgentConversationCapture = { id: randomUUID(), epoch: this.store.epoch, at: this.now(), participants: ids.map(id => {
      const agent = this.store.readEntity('agent', id), preference = this.preference(id);
      if (!agent || agent.value.archived) throw new Fault(409, 'agent_unavailable', 'A conversation participant is unavailable.');
      return { agentId: id, agentRevision: agent.revision, preferenceRevision: preference.revision, preferences: preference.value, access: agent.value.access ?? {} };
    }) };
    capture.participants.forEach(p=>{p.work=this.workReference(p.agentId,capture.participants.map(p=>p.access));});
    this.assertCapture(capture);
    return capture;
  }
  assertCapture(capture: AgentConversationCapture, allowedAttemptId?: string) {
    if (capture.epoch !== this.store.epoch || capture.participants.length !== 2 || new Set(capture.participants.map(p => p.agentId)).size !== 2) throw new Fault(409, 'initiative_context', 'This conversation belongs to a different workspace or participant scope.');
    for (const participant of capture.participants) {
      const current = this.preference(participant.agentId), agent = this.store.readEntity('agent', participant.agentId);
      if (participant.preferences.initiative !== 'proactive' || participant.preferences.sleep !== 'awake' || current.value.initiative !== 'proactive' || current.value.sleep !== 'awake' || current.revision !== participant.preferenceRevision) throw new Fault(409, 'initiative_revoked', 'Conversation initiative changed. No new turn was dispatched.');
      if (!agent || agent.value.archived || agent.revision !== participant.agentRevision || canonical(agent.value.access ?? {}) !== canonical(participant.access)) throw new Fault(409, 'initiative_agent_changed', 'A participant or its capabilities changed. Review its current design.');
      if (this.assignments.activity().some(a => a.agentId === participant.agentId && a.id !== allowedAttemptId && !assignmentTerminal(a.state))) throw new Fault(409, 'initiative_agent_busy', 'A participant has unfinished or uncertain work. Its original attempt is kept.');
      if (this.teamBusy(participant.agentId)) throw new Fault(409, 'initiative_team_busy', 'A participant has an unfinished team stage.');
      if (canonical(this.workReference(participant.agentId,capture.participants.map(p=>p.access)) ?? null) !== canonical(participant.work ?? null)) throw new Fault(409, 'initiative_source_changed', 'The captured work changed. No new reply was dispatched.');
    }
  }
  private runOccurrence(occurrence: ConversationOccurrence) {
    if (!this.meetings) return;
    try {
      const owned=this.meetings.initiativeMeeting(occurrence.capture.id);
      if(owned){
        occurrence={...occurrence,meetingId:owned.id};
        if(owned.state!=='gathered'){
          this.store.internalWrite(occurrencePrefix+occurrence.id,{...occurrence,state:['running','complete','ended'].includes(owned.state)?'started':'blocked',message:owned.message});return;
        }
      }
      this.assertCapture(occurrence.capture);
      const meeting = owned??this.meetings.command(occurrence.device, { type: 'gather', requestId: occurrence.gatherRequestId, epoch: occurrence.epoch, roomId: occurrence.roomId, title: 'Work Conversation', agenda: 'Compare the captured current work. Ask one useful question, respond directly to the other participant, and finish with a practical next consideration. This conversation cannot edit or dispatch work.', agentIds: occurrence.capture.participants.map(p => p.agentId) }, occurrence.capture);
      occurrence = { ...occurrence, meetingId: meeting.id };
      this.store.internalWrite(occurrencePrefix + occurrence.id, occurrence);
      this.meetings.command(occurrence.device, { type: 'start', requestId: occurrence.startRequestId, epoch: occurrence.epoch, meetingId: meeting.id, expectedRevision: meeting.revision });
      this.store.internalWrite(occurrencePrefix + occurrence.id, { ...occurrence, state: 'started' });
      for (const participant of occurrence.capture.participants) this.event(participant.agentId, 'conversation', 'Started an opted-in work conversation using the captured assignment context.', meeting.id, 'initiative');
    } catch (error) {
      this.store.internalWrite(occurrencePrefix + occurrence.id, { ...occurrence, state: 'blocked', message: error instanceof Error ? error.message : 'The original conversation needs review.' });
    }
  }
  tick() {
    if (this.closed || this.store.updateMaintenanceHeld || this.store.recoveryEffectsPaused) return;
    const at = this.now(), day = this.day();
    for(const intent of this.store.internalList<SleepIntent>('agents:activity:sleep:').filter(i=>i.epoch===this.store.epoch&&i.state==='pending')){try{this.reconcileSleepIntent(intent.id);}catch{/* The original intent is retained for review; never start a replacement. */}}
    for (const item of this.store.internalList<ConversationOccurrence>(occurrencePrefix).filter(o => o.epoch === this.store.epoch && o.state === 'prepared')) this.runOccurrence(item);
    const agents = this.store.listEntities('agent').filter(a => !a.value.archived);
    for (const agent of agents) {
      let preference = this.preference(agent.id);
      if (preference.value.sleep === 'after-work' && !this.isBusy(agent.id)) {
        preference = { ...preference, revision: preference.revision + 1, value: { ...preference.value, sleep: 'asleep' }, updatedAt: at };
        this.store.internalWrite(preferenceKey(agent.id), preference);
        this.event(agent.id, 'sleep', 'The original work settled. The queued Sleep is now active.', undefined, 'lifecycle');
      }
      if (preference.value.initiative !== 'proactive' || preference.value.sleep !== 'awake' || this.isBusy(agent.id)) continue;
      if (at >= preference.nextMotionAt) {
        const style = preference.value.personality, previous = (this.store.internalRead<AgentActivityEvent[]>(logKey) ?? []).filter(e => e.agentId === agent.id).at(-1), action = previous?.action === 'coffee' ? 'office' : this.random() < (style === 'curious' ? .65 : style === 'focused' ? .1 : .25) ? 'coffee' : 'office';
        this.event(agent.id, action, action === 'coffee' ? 'I was available and chose a change of scenery.' : 'I prefer a quiet place between conversations.', undefined, 'initiative');
        preference = { ...preference, nextMotionAt: at + 8000 + Math.floor(this.random() * 6000) };
        this.store.internalWrite(preferenceKey(agent.id), preference);
      }
    }
    if (!this.meetings || this.meetings.state().current || !this.assignments.state().canStart || this.assignments.activity().some(a => !assignmentTerminal(a.state))) return;
    const ready = agents.map(a => this.preference(a.id)).filter(p => p.value.initiative === 'proactive' && p.value.sleep === 'awake' && !this.isBusy(p.agentId) && (p.nextConversationAt ?? Infinity) <= at && (p.day !== day || p.conversationsToday < p.value.dailyLimit)).sort((a,b)=>(a.nextConversationAt??Infinity)-(b.nextConversationAt??Infinity)||a.agentId.localeCompare(b.agentId));
    if (ready.length < 2) return;
    const participants = ready.slice(0, 2), room = this.store.internalRead<HubLayout>(hubLayoutKey)?.rooms.find(r => r.template === 'boardroom');
    if (!room) return;
    const capture = this.capture(participants.map(p => p.agentId));
    const occurrence: ConversationOccurrence = { id: capture.id, epoch: this.store.epoch, device: participants[0].device, capture, gatherRequestId: randomUUID(), startRequestId: randomUUID(), roomId: room.id, state: 'prepared' };
    // Occurrence identity and budget are committed before any model effect.
    this.store.internalAtomic(() => {
      this.store.internalWrite(occurrencePrefix + occurrence.id, occurrence);
      for (const p of participants) this.store.internalWrite(preferenceKey(p.agentId), { ...p, day, conversationsToday: (p.day === day ? p.conversationsToday : 0) + 1, nextConversationAt: at + p.value.intervalMinutes * 60_000 });
    });
    this.runOccurrence(occurrence);
  }
  start() { if (!this.timer && !this.closed) { this.timer = setInterval(() => { try { this.tick(); } catch { /* A failed guard never dispatches a replacement. */ } }, 2000); this.timer.unref(); } }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); }
}
