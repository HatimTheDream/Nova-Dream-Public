import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { githubActionSchema, githubName, type GitHubIdentity, type GitHubRepository, type GitHubState } from '../../packages/domain/work-repositories.js';
import { hostCommand, hostEnvironment, type HostCommand } from './host-command.js';
import { Fault, Store } from './store.js';

type Credential = { token: string; identity: GitHubIdentity; generation: string; epoch:string };
type Attempt = NonNullable<GitHubState['attempt']> & { device: string };
const credentialKey = 'work:github:credential', attemptKey = 'work:github:attempt';

/** The supported gh device flow uses a temporary private profile. Its result is
 * encrypted by Store; no ambient CLI credential, browser session or token is imported. */
export class GitHubConnection {
  private available?: boolean;
  private live?: { id: string; controller: AbortController; job: Promise<void> };
  private closed = false;
  get updateMaintenanceBusy() { return !!this.live; }
  private cleanup: Promise<void>;
  constructor(private store: Store, private run: HostCommand = hostCommand, private exchange: typeof fetch = fetch, private now = Date.now) {
    const root=join(store.directory,'github-signin');
    this.cleanup=(async()=>{await mkdir(root,{recursive:true,mode:0o700});for(const entry of await readdir(root,{withFileTypes:true}))if(/^attempt-[A-Za-z0-9]+$/.test(entry.name))await rm(join(root,entry.name),{recursive:true,force:true});})();
    void this.cleanup.catch(()=>{});
    const a = store.internalRead<Attempt>(attemptKey);
    if (a && ['starting','waiting'].includes(a.state)) store.internalWrite(attemptKey, { ...a, state:'failed', code:undefined, url:undefined, message:'Sign-in was interrupted. Start a new connection.' });
  }
  credential() { const credential=this.store.internalRead<Credential>(credentialKey); return !this.store.recoveryEffectsPaused && credential?.epoch===this.store.epoch ? credential : undefined; }
  private check(generation?: string) { if (this.closed || generation && this.credential()?.generation !== generation) throw new Fault(409,'github_changed','The GitHub connection changed. Review the original operation.'); }
  async state(device: string): Promise<GitHubState> {
    if (this.available === undefined) this.available = await this.run('gh',['--version']).then(() => true, () => false);
    const c = this.credential(), a = this.store.internalRead<Attempt>(attemptKey);
    return { available:this.available, account:c?.identity ?? null, message:c ? `Connected as ${c.identity.login}` : this.available ? 'Connect GitHub to choose repositories on this host.' : 'Install GitHub CLI on the workspace host to connect. Local folders remain available.', attempt:a ? { id:a.id,state:a.state,expiresAt:a.expiresAt,message:a.message,...(a.device===device && a.state==='waiting' ? {code:a.code,url:a.url}: {}) } : null };
  }
  async action(device:string, raw:unknown) {
    const cmd=githubActionSchema.parse(raw); this.check();
    if(cmd.action==='connect')this.store.assertUpdateAdmission();
    if (cmd.action==='connect' && !(await this.state(device)).available) throw new Fault(409,'github_cli_missing','Install GitHub CLI on this host first.');
    const admitted=this.store.admit(device,cmd,{type:'github.action',...cmd},()=>{
      if(cmd.action==='connect'){
        this.store.assertUpdateAdmission();
        if(this.live)throw new Fault(409,'github_connecting','Finish or cancel the current connection.');
        const a:Attempt={id:randomUUID(),device,state:'starting',expiresAt:this.now()+900000,message:'Preparing GitHub device sign-in…'};this.store.internalWrite(attemptKey,a);return a.id;
      }
      const a=this.store.internalRead<Attempt>(attemptKey);
      if(a)this.store.internalWrite(attemptKey,{...a,state:'cancelled',code:undefined,url:undefined,message:'Connection cancelled.'});
      if(cmd.action==='disconnect')this.store.internalDelete(credentialKey);
      return '';
    });
    if (admitted.fresh && cmd.action==='connect') {
      const controller=new AbortController(),id=admitted.value;
      const live={id,controller,job:Promise.resolve()};this.live=live;
      live.job=this.connect(id,controller.signal).finally(()=>{if(this.live===live)this.live=undefined;});
    } else if(cmd.action!=='connect')this.live?.controller.abort();
    return this.state(device);
  }
  private async connect(id:string, signal:AbortSignal){
    let directory:string|undefined;
    const update=(patch:Partial<Attempt>)=>{const a=this.store.internalRead<Attempt>(attemptKey);if(!this.closed && !signal.aborted && a?.id===id)this.store.internalWrite(attemptKey,{...a,...patch});};
    try {
      await this.cleanup;
      const root=join(this.store.directory,'github-signin');await mkdir(root,{recursive:true,mode:0o700});directory=await mkdtemp(join(root,'attempt-'));
      const env=hostEnvironment({HOME:directory,USERPROFILE:directory,GH_CONFIG_DIR:directory,GH_BROWSER:'echo',GH_PROMPT_DISABLED:'1',NO_COLOR:'1'});
      let observed='';
      this.store.assertUpdateAdmission();
      await this.run('gh',['auth','login','--hostname','github.com','--git-protocol','https','--web','--insecure-storage'],{env,input:'\n',signal,timeoutMs:900000,maxBytes:65536,output:chunk=>{
        observed=(observed+chunk).slice(-8192);const code=observed.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
        if(code)update({state:'waiting',code,url:'https://github.com/login/device',message:'Enter this code on GitHub and review the requested access.'});
      }});
      const token=(await this.run('gh',['auth','token','--hostname','github.com'],{env,signal,maxBytes:4096})).toString().trim();
      if(!token || /\s/.test(token))throw Error('Invalid GitHub credential.');
      const profile=await this.api('/user',{token,signal});
      if(!Number.isSafeInteger(profile.id)||typeof profile.login!=='string'||!/^[A-Za-z0-9-]+$/.test(profile.login))throw Error('Invalid GitHub identity.');
      if(signal.aborted||this.closed||this.store.internalRead<Attempt>(attemptKey)?.id!==id)return;
      const identity:GitHubIdentity={id:profile.id,login:profile.login,name:profile.name?.slice(0,100)||profile.login,email:`${profile.id}+${profile.login}@users.noreply.github.com`};
      this.store.internalWrite(credentialKey,{token,identity,generation:randomUUID(),epoch:this.store.epoch} satisfies Credential);
      update({state:'connected',code:undefined,url:undefined,message:`Connected as ${identity.login}.`});
    } catch {update({state:'failed',code:undefined,url:undefined,message:'GitHub sign-in did not finish. Start a new connection when ready.'});}
    finally {if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>{});}
  }
  async api(path:string, options:{method?:'GET'|'POST';body?:unknown;token?:string;signal?:AbortSignal}={}):Promise<any>{
    return options.method === 'POST' ? this.store.trackUpdateEffect('github-writes', () => this.requestApi(path, options)) : this.requestApi(path, options);
  }
  private async requestApi(path:string, options:{method?:'GET'|'POST';body?:unknown;token?:string;signal?:AbortSignal}):Promise<any>{
    const c=this.credential(),token=options.token??c?.token;if(!token)throw new Fault(409,'github_disconnected','Connect GitHub in this workspace first.');
    this.check();
    const response=await this.exchange('https://api.github.com'+path,{method:options.method??'GET',headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2026-03-10','User-Agent':'Nova-Dream',...(options.body?{'Content-Type':'application/json'}:{})},body:options.body?JSON.stringify(options.body):undefined,redirect:'error',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
    if(!options.token)this.check(c?.generation);
    if(!response.ok){await response.body?.cancel();throw new Fault(response.status===401?409:502,response.status===404?'github_not_found':'github_request',response.status===401?'GitHub access expired. Reconnect your account.':response.status===403?'GitHub denied this request or its rate limit was reached. Review access and try again later.':response.status===404?'This repository or branch is unavailable to the connected account.':'GitHub did not confirm this operation. Review its status before retrying.');}
    const reader=response.body?.getReader();if(!reader)throw new Fault(502,'github_empty','GitHub returned an empty response.');
    const chunks:Uint8Array[]=[];let bytes=0;
    try{while(true){const result=await reader.read();if(result.done)break;bytes+=result.value.length;if(bytes>4*1024*1024){await reader.cancel();throw new Fault(502,'github_large','GitHub returned more data than expected.');}chunks.push(result.value);}}finally{reader.releaseLock();}
    if(!options.token)this.check(c?.generation);return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private repository(raw:any):GitHubRepository{return {id:raw.id,fullName:githubName.parse(raw.full_name),description:String(raw.description??'').slice(0,300),private:raw.private===true,defaultBranch:String(raw.default_branch??'main'),canPush:raw.permissions?.push===true,archived:raw.archived===true};}
  async repositories(page=1):Promise<{items:GitHubRepository[];nextPage:number|null}>{const raw=await this.api(`/user/repos?sort=updated&per_page=50&page=${page}`);if(!Array.isArray(raw))throw Error('Invalid repository response.');return {items:raw.map(r=>this.repository(r)),nextPage:raw.length===50?page+1:null};}
  async repositoryByName(name:string){return this.repository(await this.api('/repos/'+githubName.parse(name)));}
  async branches(name:string,page=1){const raw=await this.api(`/repos/${githubName.parse(name)}/branches?per_page=100&page=${page}`);return {items:raw.map((r:any)=>({name:String(r.name),protected:r.protected===true})),nextPage:raw.length===100?page+1:null};}
  async close(){this.closed=true;this.live?.controller.abort();await this.live?.job;await this.cleanup.catch(()=>{});}
}
