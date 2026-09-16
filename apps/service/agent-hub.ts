import { hubStatus, type HubAgent, type HubState } from '../../packages/domain/agent-hub.js';
import { assignmentHoldsSlot } from '../../packages/domain/assignments.js';
import type { AgentRoutine } from '../../packages/domain/agent-routines.js';
import { Store, Fault } from './store.js';
import { AssignmentService } from './assignments.js';
import { randomUUID } from 'node:crypto';
import type { ModuleAction } from '../../packages/domain/module-actions.js';
import type { ReviewApproval } from '../../packages/domain/approvals.js';
import { assignmentNeedsApproval } from '../../packages/domain/assignment-approvals.js';
import type { TeamWork } from '../../packages/domain/team-work.js';
import type { Conversation, AssistantOperation } from '../../packages/domain/assistant.js';
import { appendHubRoom, deskAvailable, hubLayoutCommandSchema, hubLayoutKey, roomFurnitureSlots, type HubLayout } from '../../packages/domain/hub-layout.js';

export class AgentHub {
  private cursor = -1;
  private records: Omit<HubAgent, 'status' | 'reason' | 'active' | 'returned' | 'unresolved' | 'latest' | 'routines' | 'reviews' | 'appliedChanges'>[] = [];
  constructor(private store: Store, private assignments: AssignmentService, private now = Date.now, private approvals: () => readonly ReviewApproval[] = () => []) {}
  changeLayout(device: string, raw: unknown): HubLayout {
    const input = hubLayoutCommandSchema.parse(raw);
    return this.store.admit(device, input, { type: 'hub.layout', ...input }, () => {
      const previous = this.store.internalRead<HubLayout>(hubLayoutKey)!;
      if (previous.revision !== input.expectedRevision) throw new Fault(409, 'hub_changed', 'The hub changed in another window. Refresh it before placing this room or agent.');
      const layout = structuredClone(previous), action = input.action;
      if (action.type === 'add-room') {
        if (layout.rooms.length >= 2000) throw new Fault(507, 'hub_full', 'The hub has reached its room limit. Existing rooms are kept.');
        appendHubRoom(layout, action.template, action.name, `room:${randomUUID()}`);
      } else if (action.type === 'rename-room') {
        const room = layout.rooms.find(r => r.id === action.roomId);
        if (!room) throw new Fault(404, 'room_missing', 'This room is no longer available.');
        room.name = action.name;
      } else if (action.type === 'furnish-room') {
        const room = layout.rooms.find(r => r.id === action.roomId);
        if (!room) throw new Fault(404, 'room_missing', 'This room is no longer available.');
        const slot = roomFurnitureSlots(room).find(s => s.id === action.slot);
        if (!slot || !slot.choices.includes(action.furniture)) throw new Fault(400, 'furniture_slot', 'Choose a furnishing that fits this location.');
        room.furniture = { ...room.furniture, [slot.id]: action.furniture };
      } else {
        const agent = this.store.readEntity('agent', action.agentId), placement = { roomId: action.roomId, desk: action.desk };
        if (!agent || agent.value.archived) throw new Fault(409, 'agent_unavailable', 'Choose an active agent to place in the hub.');
        if (!deskAvailable(layout, placement, agent.id)) throw new Fault(409, 'desk_occupied', 'That workspace is occupied or unavailable. Choose an open desk.');
        layout.placements[agent.id] = placement;
      }
      layout.revision++;
      return this.store.internalWrite(hubLayoutKey, layout);
    }).value;
  }
  private roster() {
    if (this.cursor === this.store.entityCursor) return this.records;
    const plans = this.store.listEntities('assignment'), tasks = this.store.listEntities('task').filter(t => !t.value.trashed), content = this.store.listEntities('content');
    this.records = this.store.listEntities('agent').map(agent => {
      const owned = plans.filter(p => p.value.agentId === agent.id), ids = new Set(owned.map(p => p.id));
      return { id: agent.id, revision: agent.revision, name: agent.value.name, position: agent.value.position, appearance: agent.value.appearance, archived: agent.value.archived,
        plans: owned.filter(p => !p.value.archived && p.value.state === 'planned').map(p => ({ id: p.id, revision: p.revision, title: p.value.title, projectId: p.value.projectId })),
        tasks: tasks.filter(t => t.value.origin?.kind === 'assignment' && ids.has(t.value.origin.id)).map(t => ({ id: t.id, title: t.value.title, status: t.value.status })),
        content: content.filter(c => !c.value.archived && c.value.source?.kind === 'assignment' && c.value.source.agentId === agent.id).map(c => ({ id: c.id, title: c.value.title, stage: c.value.stage })),
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
    this.cursor = this.store.entityCursor; return this.records;
  }
  state(before?: string, showArchived = false, focusId?: string): HubState {
    const activities = this.assignments.activity(), availability = this.assignments.availability();
    const approvals = this.approvals();
    const waiting = new Set(activities.filter(a => assignmentHoldsSlot(a) && assignmentNeedsApproval(this.assignments.summary(a.id), approvals, this.now())).map(a => a.agentId));
    const changes = this.store.internalList<ModuleAction>('modules:action:').filter(a => a.epoch === this.store.epoch && a.assignmentId);
    const reviewStates = new Set(['preparing','pending','applying','partial','unknown']);
    const teams=this.store.internalList<TeamWork & {epoch:string}>('team:run:').filter(t=>t.epoch===this.store.epoch&&!['complete','cancelled'].includes(t.state));
    const teamWork=(agentId:string)=>{
      const team=teams.find(t=>t.steps[t.next]?.agentId===agentId);if(!team)return undefined;
      const step=team.steps[team.next],operation=step.operationId?this.store.internalRead<AssistantOperation>('assistant:operation:'+step.operationId):undefined;
      const conversation=step.conversationId?this.store.internalRead<Conversation>('assistant:conversation:'+step.conversationId):undefined;
      const unsettled=operation&&!['completed','failed','cancelled'].includes(operation.state);
      const needsApproval=approvals.some(a=>a.epoch===this.store.epoch&&a.conversationId===step.conversationId&&a.nativeId===conversation?.nativeId&&a.nativeKey===conversation?.nativeKey&&a.connectionGeneration===conversation?.connectionGeneration&&(a.action?.state==='unknown'||a.snapshot.status==='pending'&&a.snapshot.expiresAtMs>this.now()));
      const status:HubAgent['status']=needsApproval?'waiting-owner':unsettled&&!availability.ready?'waiting-provider':unsettled&&operation.state!=='unknown'?'working':'waiting-owner';
      return {status,reason:`${team.title} · ${step.role}. ${needsApproval?'Open the conversation to review its action.':status==='working'?'This team stage is running.':team.message}`,team:{id:team.id,title:team.title,role:step.role,conversationId:step.conversationId}};
    };
    const work = (agentId: string) => {
      const attempts = activities.filter(a => a.agentId === agentId), ids = new Set(attempts.map(a => a.id));
      const actions = changes.filter(a => ids.has(a.assignmentId!));
      const reviews = attempts.flatMap(a => { const count=actions.filter(change=>change.assignmentId===a.id&&reviewStates.has(change.state)).length;return count?[{attemptId:a.id,assignmentId:a.assignmentId,title:a.title,count}]:[]; });
      const pending = reviews.reduce((count,r)=>count+r.count,0);
      return { attempts, reviews, actions, pending };
    };
    const holds = (a: typeof activities[number]) => assignmentHoldsSlot(a);
    const active = activities.find(holds), all = this.roster().filter(a => showArchived ? a.archived : !a.archived || a.id === active?.agentId);
    const focusIndex = focusId ? all.findIndex(a => a.id === focusId) : -1;
    if (focusId && focusIndex < 0) throw new Fault(404, 'hub_agent', 'This agent is no longer in the selected roster.');
    const offset = focusId ? Math.floor(focusIndex / 12) * 12 : before ? all.findIndex(a => a.id === before) + 1 : 0;
    if (before && !offset) throw new Fault(404, 'hub_cursor', 'The roster changed. Return to the first office page.');
    const page = all.slice(offset, offset + 12), routines = this.store.internalList<AgentRoutine>('agent-routines:item:');
    return { observedAt: this.now(), runtimeReady: availability.ready, runtimeReason: availability.ready ? 'Connected to this host’s assignment worker.' : 'Connect the Assistant on this host to run assignments.', total: all.length, activeAgentId: active?.agentId ?? null, nextCursor: offset + 12 < all.length ? page.at(-1)!.id : null,
      layout: this.store.internalRead<HubLayout>(hubLayoutKey)!,
      roster: all.map(({ id, revision, name, position, appearance, archived }) => {const w=work(id);return { id, revision, name, position, appearance, archived, ...hubStatus(w.attempts.find(holds), availability.ready, w.attempts[0],w.pending,waiting.has(id)),...teamWork(id) };}),
      agents: page.map(agent => {
        const {attempts,reviews,actions,pending}=work(agent.id),current=attempts.find(holds),applied=actions.filter(a=>a.state==='applied');
        const linked = (kind:'task'|'content') => applied.filter(a=>a.operation==='records.save'&&a.input.kind===kind).flatMap(a=>{
          const result=a.result as {id?:unknown}|undefined;
          return typeof result?.id==='string'?[result.id]:[];
        });
        const tasks = new Map(agent.tasks.map(t=>[t.id,t]));
        for(const id of linked('task')) {const task=this.store.readEntity('task',id);if(task&&!task.value.trashed)tasks.set(id,{id,title:task.value.title,status:task.value.status});}
        const content = new Map(agent.content.map(c=>[c.id,c]));
        for(const id of linked('content')) {const item=this.store.readEntity('content',id);if(item&&!item.value.archived)content.set(id,{id,title:item.value.title,stage:item.value.stage});}
        return { ...agent,tasks:[...tasks.values()],content:[...content.values()],reviews,appliedChanges:applied.length,...hubStatus(current, availability.ready, attempts[0],pending,waiting.has(agent.id)),...teamWork(agent.id), active: current ?? null, latest: attempts[0] ?? null, returned: attempts.filter(a => a.state === 'returned').length, unresolved: attempts.filter(a => a.state === 'unknown' || a.state === 'stopping').length, routines: routines.filter(r => r.agentId === agent.id && !r.value.archived).map(r => ({ id: r.id, revision: r.revision, name: r.value.name, timezone: r.value.timezone, nextAt: r.nextAt, attention: r.attention })) };
      }),
    };
  }
}
