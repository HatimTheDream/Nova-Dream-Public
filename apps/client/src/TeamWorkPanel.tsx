import { useEffect,useReducer,useRef,useState } from 'react';
import type { Snapshot } from '../../../packages/domain/contracts';
import { teamRoles,type TeamWork } from '../../../packages/domain/team-work';
import { readLocal,request,saveLocal } from './api';
import './work-tools.css';
import { workRequestRejected } from './work-request';
import { RefreshReader } from './refresh-reader';
import { suggestedTeamMembers,teamWorkStatus } from './team-work-state';
type Form={projectId:string;title:string;brief:string;maxMinutes:number;steps:{agentId:string;role:typeof teamRoles[number]}[]};
type Props={snapshot:Snapshot;projectId?:string|null;openConversation:(id:string)=>void;active?:boolean};
export function TeamWorkPanel(props:Props){
  return <TeamWorkSession key={`${props.snapshot.epoch}:${props.snapshot.deviceId}`} {...props}/>;
}
function TeamWorkSession({snapshot,projectId,openConversation,active=true}:Props){
  const key=`e3:team-work:${snapshot.epoch}:${snapshot.deviceId}`;
  const projects=snapshot.projects.filter(p=>p.value.space==='work'&&p.value.workspace?.environment==='local'&&p.value.workspace.folder),agents=(snapshot.records?.agent??[]).filter(a=>!a.value.archived);
  const [form,setForm]=useState<Form>(()=>readLocal(key)??{projectId:projectId??projects[0]?.id??'',title:'',brief:'',maxMinutes:10,steps:suggestedTeamMembers(agents)});
  const [{runs,readError,actionError},dispatch]=useReducer(teamWorkStatus,{runs:[],readError:'',actionError:''});
  const [selected,setSelected]=useState<string>(),[editing,setEditing]=useState(false),[pending,setPending]=useState<(Form&{requestId:string;epoch:string})|undefined>(()=>readLocal(key+':pending')),[busy,setBusy]=useState(false);
  const mounted=useRef(false),flight=useRef(false),reader=useRef<RefreshReader<{runs:TeamWork[]}>>(undefined);
  const setError=(message:string)=>dispatch({type:'actionError',message});
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(!active)return;
    const current=new RefreshReader({
      identity:()=>key,
      read:signal=>request<{runs:TeamWork[]}>('work/team',undefined,signal),
      accept:result=>dispatch({type:'read',runs:result.runs}),
      fail:reason=>dispatch({type:'readError',message:reason instanceof Error?reason.message:'Team workflows could not load.'}),
    });
    reader.current=current;
    void current.poll();
    const timer=setInterval(()=>void current.poll(),3000);
    return()=>{clearInterval(timer);current.cancel();if(reader.current===current)reader.current=undefined;};
  },[key,active]);
  const change=(value:Form)=>{if(!saveLocal(key,value)){setError('Free browser storage before changing this team brief.');return;}setForm(value);};
  const start=async()=>{
    if(flight.current)return;
    const cmd=pending??{...form,requestId:crypto.randomUUID(),epoch:snapshot.epoch};
    if(!saveLocal(key+':pending',cmd)){setError('Free browser storage before starting.');return;}
    setPending(cmd);setBusy(true);flight.current=true;setError('');
    const clearPending=()=>{if(readLocal<{requestId:string}>(key+':pending')?.requestId===cmd.requestId)saveLocal(key+':pending',null);};
    try{
      const result=await request<TeamWork>('work/team/start',cmd);
      clearPending();
      if(mounted.current){setSelected(result.id);setEditing(false);setPending(undefined);await reader.current?.refresh();}
    }catch(e){
      if(workRequestRejected(e)){clearPending();if(mounted.current)setPending(undefined);}
      if(mounted.current)setError(e instanceof Error?e.message:'Start was not confirmed. Reconcile the same request.');
    }finally{flight.current=false;if(mounted.current)setBusy(false);}
  };
  const current=runs.find(r=>r.id===selected)??runs[0];
  const control=async(action:'pause'|'resume'|'stop'|'skip')=>{
    if(!current||flight.current)return;
    setBusy(true);flight.current=true;setError('');
    try{await request('work/team/control',{requestId:crypto.randomUUID(),epoch:snapshot.epoch,id:current.id,revision:current.revision,action});}
    catch(e){if(mounted.current)setError(e instanceof Error?e.message:'This workflow action was not confirmed.');}
    finally{if(mounted.current)await reader.current?.refresh();flight.current=false;if(mounted.current)setBusy(false);}
  };
  return <section className="team-work-panel"><div className="section-heading"><h3>Team work</h3><button type="button" onClick={()=>setEditing(v=>!v)}>{editing?'Back to runs':'New workflow'}</button></div><p className="metadata">Different members, one shared checkout. Each stage receives the earlier handoffs. You review and publish the final changes.</p>
    {(editing||!runs.length)&&<form onSubmit={e=>{e.preventDefault();void start();}}><fieldset disabled={busy||!!pending}><label>Work Project<select required value={form.projectId} onChange={e=>change({...form,projectId:e.target.value})}><option value="">Choose a project</option>{projects.map(p=><option key={p.id} value={p.id}>{p.value.name}</option>)}</select></label>{!projects.length&&<p className="metadata">Create a Work Project from GitHub or a host folder first.</p>}<label>Title<input required maxLength={120} value={form.title} onChange={e=>change({...form,title:e.target.value})}/></label><label>What should the team do?<textarea required rows={4} maxLength={15000} value={form.brief} onChange={e=>change({...form,brief:e.target.value})} placeholder="Describe the outcome and how you will know it works."/></label><div className="team-stage-edit">{form.steps.map((step,i)=><label key={i}>{i+1}. {step.role==='research'?'Research & plan':step.role==='build'?'Implement':'Review'}<select required value={step.agentId} onChange={e=>change({...form,steps:form.steps.map((s,n)=>n===i?{...s,agentId:e.target.value}:s)})}><option value="">Choose an agent</option>{agents.map(a=><option key={a.id} value={a.id}>{a.value.name} · {a.value.position}</option>)}</select></label>)}</div><label>Time limit per stage<select value={form.maxMinutes} onChange={e=>change({...form,maxMinutes:Number(e.target.value)})}>{[5,10,20,30].map(minutes=><option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></label><p className="metadata">Implementation can edit the checkout. Research and review use read-only sessions. Uses your existing connected AI allowance.</p></fieldset><button className="primary" disabled={busy||(!pending&&(!form.title.trim()||!form.brief.trim()||!form.projectId||form.steps.some(s=>!s.agentId)||new Set(form.steps.map(s=>s.agentId).filter(Boolean)).size<2))}>{pending?'Reconcile start':'Start team work'}</button></form>}
    {!editing&&current&&<><label>Workflow<select value={current.id} onChange={e=>setSelected(e.target.value)}>{runs.map(r=><option key={r.id} value={r.id}>{r.title} · {r.state}</option>)}</select></label><p><strong>{current.projectName}</strong> · {current.state}</p><p role="status" className="metadata">{current.message}</p><div className="button-row">{current.state==='running'&&<button disabled={busy} onClick={()=>void control('pause')}>Pause after stage</button>}{['paused','attention'].includes(current.state)&&<button disabled={busy} onClick={()=>void control('resume')}>Resume</button>}{!['complete','cancelled','stopping'].includes(current.state)&&<button disabled={busy} onClick={()=>void control('stop')}>Stop team</button>}</div><ol className="team-stages">{current.steps.map((step,i)=><li key={i}><div className="section-heading"><strong>{step.agentName} · {step.role}</strong><small>{step.state}</small></div>{step.message&&<p className="metadata">{step.message}</p>}{step.conversationId&&<button type="button" onClick={()=>openConversation(step.conversationId!)}>Open conversation</button>}{step.result&&<details><summary>Saved handoff</summary><p className="preserve-lines">{step.result}</p></details>}{i===current.next&&['failed','cancelled'].includes(step.state)&&<button disabled={busy} onClick={()=>void control('skip')}>Skip this stage</button>}</li>)}</ol></>}
    {pending&&!editing&&runs.length>0&&<button disabled={busy} onClick={()=>void start()}>Reconcile pending start</button>}{actionError&&<p role="alert" className="field-error">{actionError}</p>}{readError&&<p role="alert" className="field-error">{readError}</p>}
  </section>;
}
