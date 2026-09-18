import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkoutSchema, publishSchema, type GitChange, type GitPublication, type GitReview, type WorkCheckout } from '../../packages/domain/work-repositories.js';
import type { Conversation, AssistantOperation } from '../../packages/domain/assistant.js';
import { GitHubConnection } from './github.js';
import { hostCommand, hostEnvironment, type HostCommand } from './host-command.js';
import { Fault, Store } from './store.js';

type Checkout = WorkCheckout & { baseBranch: string; device: string; epoch: string };
type Publication = GitPublication & { device: string; epoch: string; fingerprint: string; tree: string; parent: string; branch: string; baseBranch: string; repository: string; body: string; accountId: number };
const publicCheckout = ({ baseBranch,device,epoch,...c }:Checkout):WorkCheckout => c;
const publicPublication = ({ device,epoch,fingerprint,tree,parent,branch,baseBranch,repository,body,accountId,...p }:Publication):GitPublication => p;
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const sha = (value:string) => /^[a-f0-9]{40,64}$/.test(value);

/** Nova-owned checkouts only. Local-folder projects retain their existing native
 * diff flow. Publication binds the exact reviewed tree and never force-pushes. */
export class WorkRepositories {
  private jobs = new Map<string,Promise<void>>();
  private controllers = new Set<AbortController>();
  private closed = false;
  readonly root:string;
  constructor(private store:Store, private github:GitHubConnection, private run:HostCommand=hostCommand, private now=Date.now) {
    this.root=join(store.directory,'work-repositories');
    for(const c of this.checkouts())if(c.state==='preparing')this.saveCheckout({...c,state:'unknown',message:'Preparation was interrupted. The original folder is preserved.'});
    for(const p of this.publications())if(['prepared','running'].includes(p.state))this.savePublication({...p,state:'unknown',message:'Publication was interrupted. Check the original result before continuing.'});
  }
  private checkouts(){return this.store.internalList<Checkout>('work:checkout:');}
  private publications(){return this.store.internalList<Publication>('work:publication:');}
  private saveCheckout(c:Checkout){return this.store.internalWrite('work:checkout:'+c.id,c);}
  private savePublication(p:Publication){return this.store.internalWrite('work:publication:'+p.id,p);}
  private open(){if(this.closed)throw new Fault(503,'work_closing','Work is restarting. Saved checkouts remain on this host.');}
  state(){return {checkouts:this.checkouts().filter(c=>c.epoch===this.store.epoch).sort((a,b)=>b.createdAt-a.createdAt).map(publicCheckout),host:'workspace' as const};}
  private identity(accountId:number){const c=this.github.credential();if(!c || c.identity.id!==accountId)throw new Fault(409,'github_account_changed','Reconnect the GitHub account that owns this checkout.');return c;}
  private async environment(extra:NodeJS.ProcessEnv={},token?:string){
    const home=join(this.root,'.host');await mkdir(home,{recursive:true,mode:0o700});
    const hooks=join(home,'no-hooks');await mkdir(hooks,{recursive:true,mode:0o700});
    const ask=join(home,process.platform==='win32'?'askpass.cmd':'askpass');
    // Static helper: credentials stay in the short-lived command environment,
    // never in Git URLs/config, arguments, command output or persisted logs.
    const helper=process.platform==='win32'?`@"${process.execPath}" "%~dp0askpass.cjs" %*\r\n`:`#!/bin/sh\nexec '${process.execPath.replaceAll("'","'\\''")}' '${join(home,'askpass.cjs').replaceAll("'","'\\''")}' "$@"\n`;
    await writeFile(join(home,'askpass.cjs'),"process.stdout.write(/username/i.test(process.argv[2]||'')?'x-access-token\\n':(process.env.NOVA_GIT_TOKEN||'')+'\\n');\n",{mode:0o700});
    await writeFile(ask,helper,{mode:0o700});
    return hostEnvironment({HOME:home,USERPROFILE:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:ask,GIT_LFS_SKIP_SMUDGE:'1',...(token?{NOVA_GIT_TOKEN:token}:{}),...extra});
  }
  private async git(folder:string,args:string[],options:{extra?:NodeJS.ProcessEnv;token?:string;input?:string;timeoutMs?:number;signal?:AbortSignal;maxBytes?:number}={}){
    return this.run('git',['-c',`core.hooksPath=${join(this.root,'.host','no-hooks')}`,'-c','credential.helper=','-c','http.followRedirects=false','-c','core.fsmonitor=false','-c','protocol.file.allow=never','-c','protocol.ext.allow=never','-c','diff.external=','-c','commit.gpgSign=false','-c','core.pager=cat',...args],{cwd:folder,env:await this.environment(options.extra,options.token),input:options.input,timeoutMs:options.timeoutMs,signal:options.signal,maxBytes:options.maxBytes});
  }
  private background(key:string,job:(signal:AbortSignal)=>Promise<void>){
    if(this.jobs.has(key))return;const controller=new AbortController();this.controllers.add(controller);
    const pending=job(controller.signal).finally(()=>{this.jobs.delete(key);this.controllers.delete(controller);});this.jobs.set(key,pending);void pending.catch(()=>{});
  }
  async checkout(device:string,raw:unknown){
    this.open();const cmd=checkoutSchema.parse(raw),credential=this.github.credential();if(!credential)throw new Fault(409,'github_disconnected','Connect GitHub first.');
    const repository=await this.github.repositoryByName(cmd.repository);this.identity(credential.identity.id);
    const admitted=this.store.admit(device,cmd,{type:'work.checkout',...cmd},()=>{
      if(this.checkouts().some(c=>c.state==='preparing'))throw new Fault(409,'work_preparing','Wait for the current repository to finish preparing.');
      const id=randomUUID(),branch=`nova/${id.slice(0,12)}`;
      const c:Checkout={id,repository,branch,baseBranch:cmd.baseBranch,folder:join(this.root,id),state:'preparing',message:'Cloning the selected branch on this host…',createdAt:this.now(),accountId:credential.identity.id,operationId:cmd.requestId,device,epoch:cmd.epoch};this.saveCheckout(c);return id;
    });
    if(admitted.fresh)this.background(admitted.value,async signal=>{
      let c=this.checkouts().find(c=>c.id===admitted.value)!;
      try{
        await mkdir(this.root,{recursive:true,mode:0o700});
        await this.git(this.root,['clone','--no-recurse-submodules','--single-branch','--branch',c.baseBranch,'--',`https://github.com/${c.repository.fullName}.git`,c.id],{token:this.identity(c.accountId).token,signal,timeoutMs:600000,maxBytes:1024*1024});
        this.identity(c.accountId);await this.git(c.folder,['switch','-c',c.branch],{signal});
        this.saveCheckout({...c,folder:await realpath(c.folder),state:'ready',message:'Ready on the workspace host. Create a Work Project to start.'});
      }catch{this.saveCheckout({...c,state:'failed',message:'The repository could not be prepared. Check the branch and GitHub access. Any downloaded files are kept.'});}
    });
    return publicCheckout(this.checkouts().find(c=>c.id===admitted.value)!);
  }
  private async context(conversationId:string){
    this.open();const conversation=this.store.internalRead<Conversation>('assistant:conversation:'+conversationId),path=conversation?.workspace?.path??conversation?.workspace?.folder;
    const c=this.checkouts().find(c=>c.epoch===this.store.epoch && c.state==='ready' && c.folder===path);
    if(!conversation || !c || conversation.deleted)throw new Fault(409,'work_unmanaged','Publishing is available for repositories opened with Nova’s GitHub picker.');
    if(await realpath(c.folder)!==join(await realpath(this.root),c.id) || !(await stat(join(c.folder,'.git'))).isDirectory() || await realpath(join(c.folder,'.git'))!==join(await realpath(c.folder),'.git'))throw new Fault(409,'work_folder_changed','The checkout location changed. Reopen the original project.');
    const config=(await this.git(c.folder,['config','--local','--list','--null'])).toString().split('\0').filter(Boolean);
    if(config.some(line=>line!=='core.symlinks\nfalse'&&! /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\.[^\n]+\.(remote|merge))\n/.test(line)))throw new Fault(409,'work_config_changed','The repository has custom Git execution settings. Review them outside Nova before publishing.');
    const remote=(await this.git(c.folder,['remote','get-url','origin'])).toString().trim();
    if(remote!==`https://github.com/${c.repository.fullName}.git`)throw new Fault(409,'work_remote_changed','The repository destination changed. Review its remote before publishing.');
    const branch=(await this.git(c.folder,['symbolic-ref','--short','HEAD'])).toString().trim();
    if(branch!==c.branch || !branch.startsWith('nova/'))throw new Fault(409,'work_branch_changed','Return to this checkout’s Nova feature branch before publishing.');
    return {conversation,c,branch};
  }
  private busy(c:Checkout){
    const conversations=this.store.internalList<Conversation>('assistant:conversation:').filter(v=>(v.workspace?.path??v.workspace?.folder)===c.folder).map(v=>v.id);
    if(this.store.internalList<{folder:string;state:string;epoch:string}>('team:run:').some(t=>t.epoch===this.store.epoch&&t.folder===c.folder&&['running','stopping'].includes(t.state)))return true;
    return this.store.internalList<AssistantOperation>('assistant:operation:').some(o=>conversations.includes(o.conversationId)&&!['completed','failed','cancelled'].includes(o.state));
  }
  private async capture(conversationId:string){
    const {c,branch}=await this.context(conversationId);const head=(await this.git(c.folder,['rev-parse','HEAD'])).toString().trim();if(!sha(head))throw Error('Invalid checkout head.');
    const index=join(this.root,'.host','index-'+randomUUID());
    let tree:string;
    try{
      await this.git(c.folder,['read-tree','HEAD'],{extra:{GIT_INDEX_FILE:index}});
      await this.git(c.folder,['add','--all','--','.'],{extra:{GIT_INDEX_FILE:index}});
      tree=(await this.git(c.folder,['write-tree'],{extra:{GIT_INDEX_FILE:index}})).toString().trim();
    }finally{await rm(index,{force:true});await rm(index+'.lock',{force:true});}
    if(!sha(tree!))throw Error('Invalid checkout tree.');
    const fingerprint=hash(JSON.stringify({checkout:c.id,head,tree,branch,repository:c.repository.fullName}));
    return {c,branch,head,tree:tree!,fingerprint};
  }
  async review(conversationId:string):Promise<GitReview>{
    const capture=await this.capture(conversationId),{c,head,tree,branch,fingerprint}=capture;
    const names=(await this.git(c.folder,['diff','--no-renames','--name-status','-z',head,tree,'--'],{maxBytes:1024*1024})).toString().split('\0');const files:GitChange[]=[];
    if(names.length>1001)throw new Fault(409,'work_too_many_files','This change has more than 500 files. Split it before publishing.');
    let budget=2*1024*1024;
    for(let n=0;n+1<names.length;n+=2){const status=names[n],path=names[n+1];if(!path)continue;
      let patch='';if(budget>0){try{patch=(await this.git(c.folder,['diff','--no-ext-diff','--no-textconv','--no-renames',head,tree,'--',path],{maxBytes:1024*1024})).toString();}catch{patch='Patch too large to display. Review this file in your editor.';}}
      const truncated=patch.length>Math.min(budget,200000)||budget<=0;patch=patch.slice(0,Math.max(0,Math.min(budget,200000)));budget-=patch.length;
      files.push({path,status,binary:/^Binary files /m.test(patch),patch,truncated});
    }
    const pending=this.publications().some(p=>p.checkoutId===c.id&&['prepared','running','unknown'].includes(p.state));
    return {conversationId,checkoutId:c.id,repository:c.repository.fullName,branch,baseBranch:c.baseBranch,head,fingerprint,files,canPublish:!this.busy(c)&&!pending&&!!this.github.credential()&&c.repository.canPush&&!c.repository.archived,message:this.busy(c)?'Wait for coding to finish before publishing.':pending?'Review the current publication before starting another.':!c.repository.canPush?'Your GitHub account has read access to this repository.':'Review the files, then commit or publish this feature branch.',operations:this.publications().filter(p=>p.checkoutId===c.id).sort((a,b)=>b.createdAt-a.createdAt).slice(0,20).map(publicPublication)};
  }
  async publish(device:string,raw:unknown){
    this.open();const cmd=publishSchema.parse(raw);
    // Receipt replay is resolved before observing a possibly newer checkout.
    const existing=this.publications().find(p=>p.id===cmd.requestId);
    if(existing){this.store.admit(device,cmd,{type:'work.publish',...cmd},()=>existing.id);return publicPublication(existing);}
    const snapshot=await this.capture(cmd.conversationId),{c,head,tree,branch,fingerprint}=snapshot,credential=this.identity(c.accountId);
    if(fingerprint!==cmd.fingerprint)throw new Fault(409,'work_changed','The files changed since this review. Refresh and inspect the latest changes.');
    if(this.busy(c))throw new Fault(409,'work_busy','Finish or stop the coding task before publishing.');
    if(!c.repository.canPush||c.repository.archived)throw new Fault(409,'work_read_only','The connected GitHub account cannot publish to this repository.');
    if(this.publications().some(p=>p.checkoutId===c.id&&['prepared','running','unknown'].includes(p.state)))throw new Fault(409,'work_publication_pending','Check the original publication before starting another.');
    const committedTree=(await this.git(c.folder,['rev-parse','HEAD^{tree}'])).toString().trim();
    if(cmd.action==='commit'&&committedTree===tree)throw new Fault(409,'work_empty','There are no changes to commit.');
    if(cmd.action!=='commit'&&committedTree!==tree)throw new Fault(409,'work_uncommitted','Commit the reviewed changes before publishing.');
    const admitted=this.store.admit(device,cmd,{type:'work.publish',...cmd},()=>{
      if(this.busy(c)||this.publications().some(p=>p.checkoutId===c.id&&['prepared','running','unknown'].includes(p.state)))throw new Fault(409,'work_publication_pending','Check the original publication before starting another.');
      const p:Publication={id:cmd.requestId,device,epoch:cmd.epoch,conversationId:cmd.conversationId,checkoutId:c.id,state:'prepared',action:cmd.action,title:cmd.title,body:cmd.body,head:cmd.action==='commit'?undefined:head,parent:head,tree,fingerprint,branch,baseBranch:c.baseBranch,repository:c.repository.fullName,accountId:credential.identity.id,createdAt:this.now(),message:'Preparing the reviewed operation…'};this.savePublication(p);return p.id;
    });
    if(admitted.fresh)this.background(c.id,signal=>this.perform(admitted.value,signal));
    return publicPublication(this.publications().find(p=>p.id===admitted.value)!);
  }
  private async perform(id:string,signal:AbortSignal){
    let p=this.publications().find(p=>p.id===id)!;p=this.savePublication({...p,state:'running',message:p.action==='commit'?'Saving the reviewed commit…':p.action==='push'?'Publishing the feature branch…':'Opening the draft pull request…'});
    let dispatched=false;
    try{
      const {c}=await this.context(p.conversationId),credential=this.identity(p.accountId);
      if(p.action==='commit'){
        const head=(await this.git(c.folder,['commit-tree',p.tree,'-p',p.parent],{input:p.title+'\n\n'+p.body+'\n',signal,extra:{GIT_AUTHOR_NAME:credential.identity.name,GIT_COMMITTER_NAME:credential.identity.name,GIT_AUTHOR_EMAIL:credential.identity.email,GIT_COMMITTER_EMAIL:credential.identity.email}})).toString().trim();
        if(!sha(head))throw Error('Invalid commit result.');p=this.savePublication({...p,head});
        dispatched=true;
        await this.git(c.folder,['update-ref',`refs/heads/${p.branch}`,head,p.parent],{signal});
        await this.git(c.folder,['read-tree',head],{signal});
      }else if(p.action==='push'){
        dispatched=true;
        await this.git(c.folder,['push','--porcelain',`https://github.com/${p.repository}.git`,`${p.head}:refs/heads/${p.branch}`],{token:credential.token,signal,timeoutMs:120000});
        const remote=await this.github.api(`/repos/${p.repository}/git/ref/heads/${encodeURIComponent(p.branch)}`);if(remote.object?.sha!==p.head)throw Error('Remote head is unconfirmed.');
      }else{
        const remote=await this.github.api(`/repos/${p.repository}/git/ref/heads/${encodeURIComponent(p.branch)}`);if(remote.object?.sha!==p.head)throw new Fault(409,'work_push_first','Push this exact commit before opening its pull request.');
        const existing=await this.findPull(p);
        dispatched=true;
        const pr=existing??await this.github.api(`/repos/${p.repository}/pulls`,{method:'POST',body:{title:p.title,body:p.body+`\n\n<!-- nova-publication:${p.id} -->`,head:p.branch,base:p.baseBranch,draft:true},signal});
        if(typeof pr.html_url!=='string'||!pr.html_url.startsWith(`https://github.com/${p.repository}/pull/`))throw Error('Pull request result is unconfirmed.');p={...p,url:pr.html_url};
      }
      this.savePublication({...p,state:'complete',message:p.action==='commit'?'Reviewed changes committed.':p.action==='push'?'Feature branch published.':'Draft pull request ready for review.'});
    }catch(error){this.savePublication({...p,state:!dispatched?'failed':'unknown',message:error instanceof Fault?error.message:dispatched?'The original result needs checking. Use Check result; do not repeat the operation.':'This operation stopped before publication. Refresh the review before trying again.'});}
  }
  private async findPull(p:Publication){const pulls=await this.github.api(`/repos/${p.repository}/pulls?state=all&head=${encodeURIComponent(p.repository.split('/')[0]+':'+p.branch)}&base=${encodeURIComponent(p.baseBranch)}&per_page=100`);return pulls.find((r:any)=>r.head?.sha===p.head&&(r.state==='open'||String(r.body).includes(`nova-publication:${p.id}`)));}
  async reconcile(device:string,id:string){
    let p=this.publications().find(p=>p.id===id);if(!p||p.epoch!==this.store.epoch)throw new Fault(404,'publication_missing','The original publication is unavailable.');
    if(p.state!=='unknown'||this.jobs.has(p.checkoutId))return publicPublication(p);
    const {c}=await this.context(p.conversationId);this.identity(p.accountId);
    if(p.action==='commit'){
      const actual=(await this.git(c.folder,['rev-parse','HEAD'])).toString().trim();
      if(actual===p.head){await this.git(c.folder,['read-tree',p.head]);p=this.savePublication({...p,state:'complete',message:'The original commit is confirmed.'});}
      else if(actual===p.parent)p=this.savePublication({...p,state:'failed',message:'The branch still has its original commit. Your edits are kept; refresh and review them before trying again.'});
    }else if(p.action==='push'){
      try{const remote=await this.github.api(`/repos/${p.repository}/git/ref/heads/${encodeURIComponent(p.branch)}`);if(remote.object?.sha===p.head)p=this.savePublication({...p,state:'complete',message:'The original push is confirmed.'});}
      catch(error){if(!(error instanceof Fault&&error.code==='github_not_found'))throw error;await this.github.repositoryByName(p.repository);if(this.now()-p.createdAt>60000)p=this.savePublication({...p,state:'failed',message:'GitHub confirms this branch is absent. Refresh the review before requesting another push.'});}
    }else if(p.action==='pull-request'){
      const pr=await this.findPull(p);if(pr)p=this.savePublication({...p,state:'complete',url:pr.html_url,message:'The original pull request is confirmed.'});
      else if(this.now()-p.createdAt>60000)p=this.savePublication({...p,state:'failed',message:'GitHub has no matching pull request after checking the original result. Review the branch before trying again.'});
    }
    return publicPublication(p);
  }
  async close(){this.closed=true;for(const c of this.controllers)c.abort();await Promise.allSettled(this.jobs.values());}
}
