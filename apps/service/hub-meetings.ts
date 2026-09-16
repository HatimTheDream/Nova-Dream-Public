import { randomUUID } from 'node:crypto';
import { meetingCommandSchema, type HubMeeting, type HubMeetingState } from '../../packages/domain/hub-meetings.js';
import { assignmentHoldsSlot } from '../../packages/domain/assignments.js';
import { hubLayoutKey, type HubLayout } from '../../packages/domain/hub-layout.js';
import { AssignmentService } from './assignments.js';
import { Fault, Store } from './store.js';

type SavedMeeting=HubMeeting&{device:string;epoch:string;requests:{plan:string;start:string;archive:string;stop?:string}[]};
const prefix='hub:meeting:';
const publicMeeting=({device,epoch,requests,...meeting}:SavedMeeting):HubMeeting=>meeting;
/** Durable discussion orchestration over the existing single assignment worker. */
export class HubMeetings {
  private timer?:ReturnType<typeof setInterval>;
  private pending?:Promise<void>;
  private closing=false;
  private settleStop(m:SavedMeeting){
    const turn=m.turns[m.next];if(!turn)return;
    const attempt=this.assignments.state(turn.planId).attempts[0];
    if(attempt&&assignmentHoldsSlot(attempt)){
      if(!m.requests[m.next].stop){m.requests[m.next].stop=randomUUID();this.save(m);}
      this.assignments.stop(m.device,{requestId:m.requests[m.next].stop!,epoch:m.epoch,attemptId:attempt.id});
    }
  }
  constructor(private store:Store,private assignments:AssignmentService,private now=Date.now) {}
  private list(){return this.store.internalList<SavedMeeting>(prefix).sort((a,b)=>b.createdAt-a.createdAt);}
  private read(id:string){const m=this.store.internalRead<SavedMeeting>(prefix+id);if(!m)throw new Fault(404,'meeting_missing','This discussion is unavailable.');return m;}
  private save(m:SavedMeeting){return this.store.internalWrite(prefix+m.id,{...m,revision:m.revision+1,updatedAt:this.now()});}
  state():HubMeetingState {const all=this.list().filter(m=>m.epoch===this.store.epoch);return {current:all.find(m=>m.state!=='ended')?publicMeeting(all.find(m=>m.state!=='ended')!):null,history:all.filter(m=>m.state==='ended').slice(0,12).map(publicMeeting)};}
  command(device:string,raw:unknown){
    const input=meetingCommandSchema.parse(raw);
    const result=this.store.admit(device,input,{operation:'hub.meeting',...input},()=>{
      if(input.type==='gather'){
        if(this.list().some(m=>m.epoch===this.store.epoch&&m.state!=='ended'))throw new Fault(409,'meeting_active','Close the current gathering before starting another.');
        const layout=this.store.internalRead<HubLayout>(hubLayoutKey),room=layout?.rooms.find(r=>r.id===input.roomId);
        if(room?.template!=='boardroom')throw new Fault(400,'meeting_room','Choose a boardroom with a long table.');
        const attendees=input.agentIds.map(id=>{const agent=this.store.readEntity('agent',id);if(!agent||agent.value.archived)throw new Fault(409,'meeting_agent','Choose current team members.');return {id,name:agent.value.name,revision:agent.revision};});
        const active=this.assignments.state().attempts.find(assignmentHoldsSlot);
        if(active&&input.agentIds.includes(active.agentId))throw new Fault(409,'meeting_agent_busy','An invited agent has unfinished work. Finish or reconcile it first.');
        const id=randomUUID(),order=[...attendees.map(a=>({...a,kind:'contribution' as const})),{...attendees[0],kind:'summary' as const}];
        const m:SavedMeeting={id,revision:1,roomId:input.roomId,title:input.title,agenda:input.agenda,createdAt:this.now(),updatedAt:this.now(),state:'gathered',message:'The team is on its way to the table. Start the discussion when ready.',next:0,attendees,turns:order.map((a,i)=>({agentId:a.id,agentName:a.name,kind:a.kind,planId:`assignment:meeting:${id}:${i}`})),device,epoch:input.epoch,requests:order.map(()=>({plan:randomUUID(),start:randomUUID(),archive:randomUUID(),stop:randomUUID()}))};
        this.store.internalWrite(prefix+id,m);return publicMeeting(m);
      }
      const m=this.read(input.meetingId);
      if(m.revision!==input.expectedRevision)throw new Fault(409,'meeting_changed','The discussion changed. Review its latest state.');
      if(m.state==='ended')throw new Fault(409,'meeting_ended','This gathering has ended. Its results are saved.');
      if(input.type==='start'){
        if(!['gathered','paused'].includes(m.state)||m.next>=m.turns.length)throw new Fault(409,'meeting_state','No further speaker is waiting.');
        if(!this.assignments.state().canStart)throw new Fault(409,'meeting_worker',this.assignments.state().reason);
        return publicMeeting(this.save({...m,state:'running',message:'Discussion started. Each speaker receives the earlier contributions.'}));
      }
      return publicMeeting(this.save({...m,state:input.type==='end'?'ended':'paused',message:input.type==='end'?'Meeting ended. Contributions remain saved.':'Discussion paused. The current speaker is being stopped.'}));
    });
    // Stop intent is durable before contacting the worker, including receipt replays.
    if(input.type==='pause'||input.type==='end')this.settleStop(this.read(input.meetingId));
    if(input.type!=='gather')this.kick();
    return result.value;
  }
  async reconcile(){await this.pending;this.kick();await this.pending;}
  startPolling(){this.timer=setInterval(()=>this.kick(),1500);this.timer.unref();}
  private kick(){if(this.pending||this.closing)return;this.pending=this.advance().catch(error=>{
    const m=this.list().find(m=>m.state==='running');if(m)this.save({...m,state:'paused',message:error instanceof Error?error.message:'The discussion paused. Check its last speaker before continuing.'});
  }).finally(()=>{this.pending=undefined;});}
  private async advance(){
    let m=this.list().find(m=>m.epoch===this.store.epoch&&(m.state==='running'||['paused','ended'].includes(m.state)&&!!m.turns[m.next]&&!!this.assignments.state(m.turns[m.next].planId).attempts.length));if(!m)return;
    if(m.state==='paused'||m.state==='ended'){this.settleStop(m);m=this.read(m.id);}
    const turn=m.turns[m.next];if(!turn){this.save({...m,state:'complete',message:'Discussion complete. Review the contributions and summary.'});return;}
    const prior=this.assignments.state(turn.planId).attempts[0];
    if(prior){
      if(assignmentHoldsSlot(prior)){if(turn.attemptId!==prior.id||turn.state!==prior.state||turn.message!==prior.message){m.turns[m.next]={...turn,attemptId:prior.id,state:prior.state,message:prior.message};this.save(m);}return;}
      const text=prior.result?this.store.download(prior.result.file.id).bytes.toString('utf8'):undefined;
      m.turns[m.next]={...turn,attemptId:prior.id,state:prior.state,message:prior.message,...(prior.result&&text?{result:{fileId:prior.result.file.id,text:text.slice(0,20000)}}:{})};
      m.next++;
      const plan=this.store.readEntity('assignment',turn.planId);
      if(plan&&!plan.value.archived)this.store.mutate(m.device,{requestId:m.requests[m.next-1].archive,epoch:m.epoch,kind:'assignment',entityId:plan.id,expectedRevision:plan.revision,payload:{...plan.value,archived:true}});
      this.save({...m,state:m.state==='ended'?'ended':m.state==='paused'?'paused':prior.state==='returned'?(m.next===m.turns.length?'complete':'running'):'paused',message:m.state==='ended'?'Meeting ended. The last speaker’s confirmed outcome is saved.':m.state==='paused'?'Discussion paused. The last speaker’s outcome is saved; continue with the next speaker when ready.':prior.state==='returned'?(m.next===m.turns.length?'Discussion complete. The summary is ready.':'Preparing the next speaker.'):`${turn.agentName} did not return a complete contribution. Review it before continuing with the next speaker.`});return;
    }
    if(m.state!=='running'||!this.assignments.state().canStart)return;
    const member=m.attendees.find(a=>a.id===turn.agentId)!,live=this.store.readEntity('agent',member.id);
    if(!live||live.value.archived)throw new Fault(409,'meeting_agent','A participant is no longer active. End this gathering and choose the current team.');
    const completed=m.turns.slice(0,m.next),limit=Math.floor(9000/Math.max(1,completed.length));
    const priorText=completed.map(t=>`${t.agentName} (${t.kind}):\n${t.result?.text.slice(0,limit)??`No returned contribution: ${t.state??'unavailable'}`}`).join('\n\n');
    const brief=`Participate in the owner's team discussion: ${m.title}.\nAgenda:\n${m.agenda}\n\n${turn.kind==='summary'?'Produce the final synthesis: decisions supported by the discussion, disagreements or unknowns, and actionable next steps with suggested owners. Do not imply suggested tasks have been dispatched.':'Contribute your perspective using your saved specialty. Address the agenda, build on earlier contributions, avoid repeating them, and identify concrete decisions or gaps.'}\nThis is discussion only. Use available reads if needed, but do not propose or execute workspace edits, messages, purchases, or new assignments. Return your own contribution in no more than ${turn.kind==='summary'?450:300} words.\n\nEarlier contributions (bounded excerpts; full outputs remain saved in the meeting history):\n${priorText||'You are the first speaker.'}`;
    const payload={title:`${m.title} · ${turn.agentName}${turn.kind==='summary'?' · Summary':''}`,brief,expectedOutput:turn.kind==='summary'?'A grounded meeting summary with decisions, unresolved questions and suggested next steps.':'A distinct contribution that responds to the agenda and actual earlier discussion.',agentId:member.id,agentRevision:member.revision,projectId:null,due:'',state:'planned' as const,archived:false,sources:[],maxMinutes:3,executionMode:'discussion' as const};
    const plan=this.store.readEntity('assignment',turn.planId)??this.store.mutate(m.device,{requestId:m.requests[m.next].plan,epoch:m.epoch,kind:'assignment',entityId:turn.planId,expectedRevision:0,payload});
    const attempt=this.assignments.start(m.device,{requestId:m.requests[m.next].start,epoch:m.epoch,assignmentId:plan.id,revision:plan.revision,projectRevision:null});
    m=this.read(m.id);m.turns[m.next]={...turn,attemptId:attempt.id,state:attempt.state};this.save({...m,message:`${turn.agentName} is ${turn.kind==='summary'?'preparing the summary':'contributing'}.`});
  }
  async close(){this.closing=true;if(this.timer)clearInterval(this.timer);await this.pending;}
}
