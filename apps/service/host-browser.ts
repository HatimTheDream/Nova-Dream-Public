import { randomUUID } from 'node:crypto';
import { readFile,realpath,stat } from 'node:fs/promises';
import { join,sep } from 'node:path';
import sharp from 'sharp';
import { browserInputSchema,type BrowserActionResult,type BrowserObservation,type HostBrowserState } from '../../packages/domain/host-browser.js';
import type { AssistantTransport } from './gateway.js';
import type { AccessTransport } from './full-access.js';
import { Fault,Store } from './store.js';
const profile='nova-work';
export class HostBrowser {
  private control?:AccessTransport;
  private connecting?:Promise<AccessTransport>;
  private closed=false;
  private configuring=false;
  private pending=new Map<string,Promise<BrowserActionResult>>();
  private pendingInputs=new Map<string,string>();
  constructor(private store:Store,private ordinary:AssistantTransport,private factory?:()=>AccessTransport,private configureRuntime?:(enabled:boolean)=>Promise<void>,private now=Date.now){
    for(const result of store.internalList<BrowserActionResult>('browser:action:'))if(result.state==='running')store.internalWrite('browser:action:'+result.id,{...result,state:'unknown',message:'The browser action was interrupted. Observe the page before requesting another action.'});
  }
  private enabled(){return this.store.internalRead<{epoch:string;enabled:boolean}>('browser:setting')?.epoch===this.store.epoch&&this.store.internalRead<{enabled:boolean}>('browser:setting')?.enabled===true;}
  private async client(){
    if(this.closed||!this.enabled()||this.store.recoveryEffectsPaused)throw new Fault(409,'browser_disabled','Enable the host browser in Work first.');
    const base=this.ordinary.status();if(base.state!=='ready'||!base.url||!['localhost','127.0.0.1','[::1]'].includes(new URL(base.url).hostname)||!this.factory)throw new Fault(503,'browser_host','The managed Assistant must be running on this workspace host.');
    if(this.control?.status().state==='ready'&&this.control.status().generation===base.generation)return this.control;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{await this.control?.stop();const client=this.factory!();this.control=client;client.start();const until=this.now()+12000;
      while(['connecting','unconfigured'].includes(client.status().state)&&this.now()<until&&!this.closed)await new Promise(r=>setTimeout(r,80));
      const state=client.status();if(this.closed||state.state!=='ready'||state.generation!==base.generation||this.ordinary.status().generation!==base.generation||!state.grantedScopes.includes('operator.admin'))throw new Fault(503,'browser_connection','The isolated browser connection is not ready.');return client;
    })().finally(()=>{this.connecting=undefined;});return this.connecting;
  }
  private async call(method:string,path:string,body?:unknown,query:Record<string,string>={}){
    const client=await this.client(),generation=client.status().generation;
    const result=await client.request<any>('browser.request',{method,path,query:{profile,...query},...(body?{body}:{}),timeoutMs:20000});
    if(this.closed||!this.enabled()||generation!==this.ordinary.status().generation)throw Error('The browser connection changed before the result was confirmed.');return result;
  }
  async configure(device:string,cmd:{requestId:string;epoch:string;enabled:boolean}){
    if(!this.configureRuntime)throw new Fault(409,'browser_managed_required','Start Nova’s managed Assistant before enabling its host browser.');
    if(this.configuring)throw new Fault(409,'browser_configuring','Wait for the current browser setting to finish.');
    const previous=this.store.internalRead('browser:setting');
    this.store.admit(device,cmd,{type:'browser.setting',...cmd},()=>this.store.internalWrite('browser:setting',{epoch:cmd.epoch,enabled:cmd.enabled,requestId:cmd.requestId}));
    if(this.store.internalRead<{requestId:string}>('browser:setting')?.requestId!==cmd.requestId)return this.state();
    this.configuring=true;
    try{await this.configureRuntime(cmd.enabled);if(!cmd.enabled){if(this.control?.status().state==='ready')await this.control.request('browser.request',{method:'POST',path:'/stop',query:{profile},timeoutMs:10000}).catch(()=>{});await this.control?.stop();this.control=undefined;}}
    catch(error){if(cmd.enabled&&previous)this.store.internalWrite('browser:setting',previous);else this.store.internalWrite('browser:setting',{epoch:cmd.epoch,enabled:false});throw error;}
    finally{this.configuring=false;}
    return this.state();
  }
  async state():Promise<HostBrowserState>{
    if(!this.enabled())return {enabled:false,available:!!this.configureRuntime,running:false,message:'Use a separate browser on the workspace host. Your personal browser and linked desktop stay separate.',tabs:[]};
    try{const status=await this.call('GET','/');const tabs=status.running?await this.tabs():[];return {enabled:true,available:status.enabled!==false,running:status.running===true,message:status.running?'Browser ready on the workspace host.':'The host browser starts when you open a page.',tabs};}
    catch(error){return {enabled:true,available:false,running:false,message:error instanceof Fault?error.message:'The host browser is reconnecting or unavailable. Refresh when ready; Chrome or Chromium is required on this host.',tabs:[]};}
  }
  private async tabs(){const result=await this.call('GET','/tabs');return (Array.isArray(result.tabs)?result.tabs:[]).slice(0,20).filter((t:any)=>typeof t.targetId==='string').map((t:any)=>({id:t.targetId as string,title:String(t.title??'').slice(0,300),url:String(t.url??'').slice(0,4000)}));}
  async observe(device:string,targetId:string):Promise<BrowserObservation>{
    const tab=(await this.tabs()).find((t:{id:string})=>t.id===targetId);if(!tab)throw new Fault(404,'browser_tab','This host browser tab is no longer open.');
    const snapshot=await this.call('GET','/snapshot',undefined,{targetId,format:'ai',limit:'400'});
    const id=randomUUID(),observation:BrowserObservation={id,targetId,url:typeof snapshot.url==='string'?snapshot.url:tab.url,text:String(snapshot.snapshot??'No readable page content.').slice(0,50000),at:this.now()};
    try{
      const screenshot=await this.call('POST','/screenshot',{targetId,type:'jpeg',fullPage:false});
      if(typeof screenshot.path==='string'){
        const root=await realpath(join(this.store.directory,'openclaw-runtime')),path=await realpath(screenshot.path);
        if(!path.startsWith(root+sep)||(await stat(path)).size>10*1024*1024)throw Error('Screenshot location is not owned by this runtime.');
        const {data,info}=await sharp(await readFile(path)).resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true}).jpeg({quality:65}).toBuffer({resolveWithObject:true});
        if(data.length<=680000){observation.image={mimeType:'image/jpeg',data:data.toString('base64'),width:info.width,height:info.height};}
      }
    }catch{/* Text remains an actual observation when a screenshot is unavailable. */}
    this.store.internalWrite('browser:observation:'+id,{...observation,image:undefined,generation:this.ordinary.status().generation,epoch:this.store.epoch});
    this.store.internalWrite('browser:tab:'+targetId,id);
    for(const old of this.store.internalList<BrowserObservation>('browser:observation:'))if(old.at<this.now()-600000)this.store.internalDelete('browser:observation:'+old.id);
    return observation;
  }
  result(id:string){const result=this.store.internalRead<BrowserActionResult>('browser:action:'+id);if(!result)throw new Fault(404,'browser_action','This original browser action is unavailable.');return result;}
  async act(device:string,id:string,raw:unknown,authorize:()=>void=()=>{}):Promise<BrowserActionResult>{
    const input=browserInputSchema.parse(raw);const saved=this.store.internalRead<BrowserActionResult & {input:unknown}>('browser:action:'+id);
    if(saved){if(JSON.stringify(saved.input)!==JSON.stringify(input))throw new Fault(409,'browser_reused','This browser action identity belongs to different input.');return this.pending.get(id)??saved;}
    if(this.pending.has(id)){if(this.pendingInputs.get(id)!==JSON.stringify(input))throw new Fault(409,'browser_reused','This browser action identity belongs to different input.');return this.pending.get(id)!;}
    authorize();
    const work=(async()=>{
      if('targetId'in input){const tabs=await this.tabs();if(!tabs.some((t:{id:string})=>t.id===input.targetId))throw new Fault(409,'browser_tab','The original tab is closed.');
        if('observationId'in input){const o=this.store.internalRead<BrowserObservation & {epoch:string;generation:string}>('browser:observation:'+input.observationId);if(!o||this.store.internalRead('browser:tab:'+input.targetId)!==input.observationId||o.epoch!==this.store.epoch||o.generation!==this.ordinary.status().generation||o.targetId!==input.targetId||this.now()-o.at>120000||tabs.find((t:{id:string})=>t.id===input.targetId)?.url!==o.url)throw new Fault(409,'browser_stale','Observe this tab again before acting.');}}
      authorize();let result:BrowserActionResult={id,state:'running',message:'Browser action started.',at:this.now()};this.store.internalWrite('browser:action:'+id,{...result,input});
      if('targetId'in input)this.store.internalDelete('browser:tab:'+input.targetId);
      try{
        let response:any;
        if(input.action==='open')response=await this.call('POST','/tabs/open',{url:input.url});
        else if(input.action==='close')response=await this.call('DELETE','/tabs/'+encodeURIComponent(input.targetId));
        else if(input.action==='navigate')response=await this.call('POST','/navigate',{targetId:input.targetId,url:input.url});
        else{const {action,observationId,...args}=input;response=await this.call('POST','/act',{...args,kind:action==='scroll'?'scrollIntoView':action,...(action==='type'?{submit:false}:{})});}
        result=response?.ok===false?{...result,state:'failed',message:'The browser rejected this action. Observe the page before requesting another action.'}:{...result,state:'completed',message:'The browser confirmed the action. Observe the page to verify its result.',targetId:input.action==='open'?response.targetId:'targetId'in input?input.targetId:undefined};
      }catch(error){result={...result,state:'unknown',message:'The browser result is unconfirmed. Observe the original page before deciding what to do next.'};}
      this.store.internalWrite('browser:action:'+id,{...result,input});return result;
    })();this.pending.set(id,work);this.pendingInputs.set(id,JSON.stringify(input));try{return await work;}finally{this.pending.delete(id);this.pendingInputs.delete(id);}
  }
  async close(){this.closed=true;await this.control?.stop();await Promise.allSettled(this.pending.values());}
}
