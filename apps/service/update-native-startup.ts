import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';

const record=z.record(z.string(),z.any());
const schemaVersions={'2026.9.2':{agent:19,shared:15},'2026.9.6':{agent:23,shared:18}} as const;
const plugins=new Set(['openai','codex','browser','document-extract','edition3-worker','edition3-workspace','edition3-sources','edition3-accounts']);
const message='Automatic Assistant startup needs review before this host can update. Existing settings and work are kept.';
const regular=(path:string)=>{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Unexpected file.');return stat;};
const directory=(path:string)=>{const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unexpected directory.');};
function json(path:string){if(regular(path).size>2*1024*1024)throw Error('Large configuration.');return record.parse(JSON.parse(readFileSync(path,'utf8')));}
function readDatabase(path:string, inspect:(db:DatabaseSync)=>void){
  regular(path);for(const suffix of ['-wal','-shm'])if(existsSync(path+suffix))regular(path+suffix);
  const db=new DatabaseSync(path,{readOnly:true});
  try{db.exec('PRAGMA query_only=ON; BEGIN');inspect(db);db.exec('ROLLBACK');}finally{db.close();}
}
function rows(db:DatabaseSync,table:string,columns:string){
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))return [];
  const result=db.prepare(`SELECT ${columns} FROM ${table} LIMIT 10001`).all();if(result.length>10000)throw Error('Large native inventory.');return result;
}
const safeSession=(status:unknown,entry:Record<string,any>)=>
  (status===null||status===undefined||['done','failed','killed','timeout'].includes(String(status)))&&
  (entry.status===undefined||entry.status===status)&&
  (!entry.goal||['paused','blocked','usage_limited','budget_limited','complete'].includes(entry.goal.status));
// Native restart marking and dispatch select running sessions. A terminal
// failure may retain abortedLastRun or recovery receipts; those are history,
// not permission to resume a task (main-session-restart-recovery 9.2 and 9.6
// both discover startup recovery targets with statuses: ['running']).

/** Read-only qualification for the pinned managed runtime, before process launch
 * and while its global suspension lease is held. The reviewed OpenClaw builds run restart
 * recovery automatically even with cron disabled. Its canonical per-agent
 * session_nodes and shared task_runs/subagent_runs are therefore checked too.
 * Unknown/custom stores or plugin entry points require host review; no saved
 * policy, goal, task or recovery marker is rewritten to obtain readiness. */
export function qualifyNativeUpdateStartup(root:string, serviceDirectory:string, stagedConfig?:unknown, version:keyof typeof schemaVersions='2026.9.2'):{code:string;message:string}[]{
  try{
    // The runtime supplies its verified package version. Reading a newer schema
    // is not permission to migrate it or to guess which executable owns it.
    const schemas=schemaVersions[version];if(!schemas)throw Error('Unreviewed native version.');
    directory(root);const config=stagedConfig===undefined?json(join(root,'openclaw.json')):record.parse(stagedConfig);
    regular(join(root,'edition3-runtime.identity'));if(readFileSync(join(root,'edition3-runtime.identity'),'utf8')!=='edition3-owned-gateway\n')throw Error('Runtime owner.');
    if(config.$include||config.session?.store||config.agents?.list||config.agents?.defaults?.heartbeat?.every!=='0m'||config.cron?.enabled!==false||config.hooks&&Object.keys(config.hooks).length||config.channels&&Object.keys(config.channels).length||config.bindings?.length||config.gateway?.bind!=='loopback'||config.gateway?.controlUi?.enabled!==false)throw Error('Autonomous ingress.');
    if(config.update?.checkOnStart!==false||config.update?.auto?.enabled!==false||config.models?.catalogRefresh?.enabled!==false)throw Error('Automatic runtime changes.');
    for(const agent of Object.values(record.parse(config.agents?.entries??{}))){if(agent.heartbeat&&agent.heartbeat.every!=='0m'||agent.hooks||agent.channel)throw Error('Agent automation.');}
    if(!Array.isArray(config.plugins?.allow)||config.plugins.allow.some((id:unknown)=>typeof id!=='string'||!plugins.has(id)))throw Error('Unverified plugin.');
    const knownLoads=new Set(['worker-plugin','module-plugin','source-plugin','account-plugin'].map(name=>resolve(serviceDirectory,name)));
    for(const path of config.plugins?.load?.paths??[])if(typeof path!=='string'||!knownLoads.has(resolve(path)))throw Error('Unverified plugin path.');
    for(const [id,entry]of Object.entries(record.parse(config.plugins?.entries??{})))if(entry.enabled!==false&&!plugins.has(id))throw Error('Unverified plugin entry.');
    const state=join(root,'state');directory(state);
    if(existsSync(join(state,'sessions','sessions.json')))throw Error('Legacy session store.');
    const agents=join(state,'agents');const agentPaths=new Set<string>();
    if(existsSync(agents)){
      directory(agents);const names=readdirSync(agents,{withFileTypes:true});if(names.length>100)throw Error('Large agent inventory.');
      for(const name of names){if(!name.isDirectory()||name.isSymbolicLink()||!/^[a-z0-9_-]+$/.test(name.name))throw Error('Agent directory.');
        const agent=join(agents,name.name),folder=join(agent,'agent');directory(agent);
        // Legacy migration is not part of an in-app update transaction.
        const sessions=join(agent,'sessions');if(existsSync(sessions))directory(sessions);
        const legacy=join(sessions,'sessions.json');if(existsSync(legacy)&&!existsSync(join(folder,'openclaw-agent.sqlite'))&&Object.keys(json(legacy)).length)throw Error('Legacy session store.');
        if(!existsSync(folder))continue;directory(folder);
        for(const file of ['openclaw-agent.sqlite','incognito-openclaw-agent.sqlite']){
          const path=join(folder,file);if(!existsSync(path))continue;agentPaths.add(resolve(path));
          readDatabase(path,db=>{if(db.prepare('PRAGMA user_version').get()?.user_version!==schemas.agent||!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='session_nodes'").get())throw Error('Unknown session schema.');
            for(const row of rows(db,'session_nodes','status,entry_json')){const entry=record.parse(JSON.parse(String(row.entry_json)));if(!safeSession(row.status,entry))throw Error('Unfinished session.');}
            for(const row of rows(db,'session_pending_inputs','state'))if(row.state!=='cancelled')throw Error('Pending native input.');
            if(rows(db,'context_engine_turn_outbox','advancement_key').length)throw Error('Pending context delivery.');
            for(const row of rows(db,'standing_intents','status'))if(!['done','cancelled','expired'].includes(String(row.status)))throw Error('Pending standing intent.');
            // 9.6's input completions, cold archives, search index and canonical
            // validation projection are retained results/metadata, not a queue
            // for dispatch. Do not delete or terminalize them to qualify.
          });
        }
      }
    }
    const sharedFolder=join(state,'state');if(existsSync(sharedFolder))directory(sharedFolder);
    const shared=join(sharedFolder,'openclaw.sqlite');if(existsSync(shared))readDatabase(shared,db=>{
      // Completed queue rows are durable deduplication receipts, not pending
      // delivery. Keep them byte-for-byte; only unfinished/unknown rows block.
      for(const row of rows(db,'delivery_queue_entries','status'))if(row.status!=='completed')throw Error('Pending native delivery.');
      for(const row of rows(db,'agent_databases','path')){const path=String(row.path),absolute=resolve(state,path),local=relative(state,absolute);if(isAbsolute(path)||local.startsWith('..')||!agentPaths.has(absolute))throw Error('Unverified registered agent.');}
      if(db.prepare('PRAGMA user_version').get()?.user_version!==schemas.shared)throw Error('Unknown shared schema.');
      for(const row of rows(db,'task_runs','status,delivery_status'))if(!['succeeded','failed','timed_out','cancelled','lost'].includes(String(row.status))||!['delivered','failed','dismissed','parent_missing','not_applicable'].includes(String(row.delivery_status)))throw Error('Unfinished native task.');
      for(const row of rows(db,'subagent_runs','payload_json')){const item=record.parse(JSON.parse(String(row.payload_json)));if(item.execution?.status!=='terminal'||!Number.isFinite(item.execution?.endedAt)||item.execution?.restartRecovery||!['not_required','delivered','discarded'].includes(item.delivery?.status))throw Error('Unfinished native subagent.');}
      // Flow schedulers can dispatch another child even between running tasks.
      for(const row of rows(db,'flow_runs','status'))if(!['succeeded','failed','cancelled','timed_out','lost'].includes(String(row.status)))throw Error('Unfinished native flow.');
      // Worker reconciliation is a startup sidecar. Retained terminal rows are
      // safe, but active/unknown placements and deferred results are not idle.
      for(const [table,column,terminal] of [
        ['worker_environments','state',['destroyed']],
        ['worker_session_placements','state',['local','reclaimed']],
        ['node_worker_launches','state',['completed','failed','cancelled']],
        ['node_worker_turns','state',['completed','failed','cancelled']],
        ['worker_session_tool_operations','status',['succeeded','failed']],
        ['worker_inference_turns','state',['terminal']],
        ['worker_transcript_commits','state',['terminal']],
      ] as [string,string,string[]][])for(const row of rows(db,table,column))if(!terminal.includes(String(row[column])))throw Error('Unfinished native worker.');
      if(version==='2026.9.6'){
        for(const row of rows(db,'node_worker_prepared_workspaces','state'))if(row.state!=='retired')throw Error('Unfinished prepared worker.');
        for(const row of rows(db,'node_worker_launch_cleanup','lineage_settled'))if(row.lineage_settled!==1)throw Error('Unfinished worker cleanup.');
        for(const row of rows(db,'worktree_templates','status'))if(row.status!=='ready')throw Error('Unfinished worktree preparation.');
        for(const row of rows(db,'github_repository_publication_requests','status,effect_state'))if(!['published','failed'].includes(String(row.status))||row.effect_state!==null&&row.effect_state!=='observed')throw Error('Unfinished repository publication.');
        for(const row of rows(db,'local_workspace_projections','pending_ref,pending_target,paused_runtimes_json,journal_json,journal_pack'))if(Object.values(row).some(value=>value!==null))throw Error('Unfinished local workspace projection.');
      }
      for(const table of ['worker_session_placement_moves','worker_workspace_reconciliations','worker_workspace_pending_results','gateway_restart_intent','gateway_restart_handoff','mcp_oauth_pending_authorizations'])if(rows(db,table,'1').length)throw Error('Pending native recovery.');
      // Only `current` dispatches a restart continuation. The revision floor
      // and last-install receipt remain after consumption (native store API).
      for(const row of rows(db,'gateway_restart_sentinel','sentinel_key'))if(!['revision-floor','latest-update-install'].includes(String(row.sentinel_key)))throw Error('Pending native recovery.');
      for(const row of rows(db,'agent_deletion_journal','cleanup_completed'))if(row.cleanup_completed!==1)throw Error('Pending native recovery.');
    });
    return [];
  }catch{return [{code:'native_startup_policy',message}];}
}
