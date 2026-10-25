import type {IncomingMessage} from 'node:http';
import {z} from 'zod';
import {Fault,type Store} from './store.js';
import type {PhoneAccess} from './phone-access.js';
import type {PrivateWebOptions} from './private-web.js';
import {captureFeedRequestOwner,captureFeedWebRoute} from './feed-request-authority.js';
import type {FeedAdaptiveController} from './feed-adaptive-controller.js';
import type {FeedAdaptiveView} from './feed-adaptive-view.js';
import type {FeedAdaptiveReading} from './feed-adaptive-reading.js';
import type {FeedAutomaticLocal} from './feed-automatic-local.js';
import {boundedFeedViewJson} from '../../packages/domain/news-feed-view.js';
import {adaptiveProtocolRequestSchema,adaptiveReviewCommandSchema} from '../../packages/domain/news-feed-adaptive-commands.js';
import {feedStartPreparationSchema,feedProtocolLimits} from '../../packages/domain/news-feed-semantic-protocol.js';

const prefix='/api/home/news/semantic';
const routes=new Map([
 ['GET '+prefix+'/feed',0],['POST '+prefix+'/reading',4096],['POST '+prefix+'/reading/receipt',4096],
 ['POST '+prefix+'/advance',4096],['POST '+prefix+'/prepare',4096],['POST '+prefix+'/command',16384],
 ['POST '+prefix+'/original/receipt',16384],['POST '+prefix+'/acceptance/receipt',4096],
 ['POST '+prefix+'/observe',4096],['GET '+prefix+'/history',0],
 ['GET '+prefix+'/original',0],['GET '+prefix+'/interpretation',0],['GET '+prefix+'/view',0],
]);
export const isFeedSemanticPassivePost=(method:string,path:string)=>method==='POST'&&
 (path===prefix+'/original/receipt'||path===prefix+'/acceptance/receipt'||path===prefix+'/reading/receipt');
/** Exact allowlist addition; never grant an arbitrary semantic prefix. */
export const feedSemanticPhoneRouteAllowed=(method:string,path:string)=>routes.has(method+' '+path);
export type FeedHttpSurface='desktop'|'phone'|'web';
export type FeedHttpPolicy={
 enabled:boolean;closing:boolean;ownOrigin:string;cookieName:string;candidateId?:string;
 developmentOrigin?:string;phoneOrigin?:string;privateWeb?:PrivateWebOptions;
};
type Controller=Pick<FeedAdaptiveController,'prepare'|'start'|'observe'|'nativeCapabilities'|'readOriginal'|'acceptance'|'history'|'readRetained'|'interpretation'|'stop'|'accept'|'applyLearning'|'closeOriginal'>;
type HttpStore=Pick<Store,'epoch'|'authenticate'|'recoveryHeld'|'recoveryEffectsPaused'|'updateMaintenanceHeld'>;
const surfaces=z.enum(['desktop','phone','web']);
const uuid=z.string().uuid();
const observation=z.object({format:z.literal(3),epoch:uuid,id:uuid}).strict();
const denied=()=>new Fault(403,'feed_request_authority','The original workspace access changed. Its request is kept.');
const tokenFrom=(cookie:string|undefined,name:string)=>cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
const header=(request:IncomingMessage,name:string)=>{const value=request.headers[name];return typeof value==='string'?value:undefined;};
function query(url:URL,allowed:readonly string[]){
 for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)
  throw new Fault(400,'feed_query','Use the exact original Feed query.');
}
async function body(request:IncomingMessage,maximum:number){
 if(header(request,'content-type')!=='application/json'||request.headers['content-encoding']!==undefined)
  throw new Fault(415,'content_type','Use uncompressed JSON for this operation.');
 let size=0;const chunks:Buffer[]=[];
 for await(const raw of request){const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);size+=chunk.length;
  if(size>maximum)throw new Fault(413,'too_large','This request is too large.');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
 catch{throw new Fault(400,'invalid_json','The request was incomplete.');}
}

/** Outside-app authenticated route seam. The maintained server must still run
 * its normal surface/host/origin guards; these original-request checks make the
 * seam independently fail closed and keep reauthorization outside socket life.
 * It has no native qualification substitute and constructs no worker/runtime. */
export class FeedSemanticHttp{
 constructor(private store:HttpStore,private phone:Pick<PhoneAccess,'enabled'|'authenticate'|'checkAuthentication'>,
  private controller:Controller,private policy:()=>FeedHttpPolicy,private consumer?:{view:Pick<FeedAdaptiveView,'read'>;readings:Pick<FeedAdaptiveReading,'command'|'receipt'>;automatic?:Pick<FeedAutomaticLocal,'advance'>}){}
 async handle(request:IncomingMessage,inputSurface:FeedHttpSurface){
  const surface=surfaces.parse(inputSurface),rawUrl=request.url??'';
  if(!rawUrl.startsWith(prefix+'/')&&rawUrl!==prefix)return;
  const initial=this.policy();
  if(!initial.enabled)throw new Fault(404,'not_found','This Feed route is unavailable.');
  if(initial.closing)throw new Fault(503,'service_closing','The workspace is restarting. The original request is kept.');
  const method=request.method??'',url=new URL(rawUrl,'http://127.0.0.1'),path=url.pathname;
  const maximum=routes.get(method+' '+path);
  if(maximum===undefined)throw new Fault(404,'not_found','This Feed route is unavailable.');
  const passive=isFeedSemanticPassivePost(method,path),write=method==='POST'&&!passive;
  const originalOrigin=surface==='web'?initial.privateWeb?.origin:surface==='phone'?initial.phoneOrigin:initial.ownOrigin;
  const headers=Object.freeze(Object.fromEntries(['host','origin','sec-fetch-site','x-edition3-client','x-edition3-candidate','x-edition3-desktop','tailscale-user-login']
   .map(name=>[name,header(request,name)]))) as Readonly<Record<string,string|undefined>>;
  if(request.headers['x-edition3-transfer']!==undefined)throw new Fault(400,'feed_transfer','Use the bounded original Feed JSON request.');
  const cookie=header(request,'cookie'),cookieName=initial.cookieName;
  const token=surface==='phone'?tokenFrom(cookie,'__Host-'+cookieName+'_phone')??'':surface==='web'?tokenFrom(cookie,'__Host-'+cookieName+'_web')??'':
   tokenFrom(cookie,cookieName)??tokenFrom(cookie,'e3_session')??'';
  const candidateCurrent=(value:FeedHttpPolicy)=>!value.candidateId||headers['x-edition3-candidate']===value.candidateId&&
   (headers['x-edition3-desktop']===undefined||headers['x-edition3-desktop']===value.candidateId);
  const checkSurface=()=>{
   const value=this.policy();if(!value.enabled||value.cookieName!==cookieName)throw denied();
   const origin=surface==='web'?value.privateWeb?.origin:surface==='phone'?value.phoneOrigin:value.ownOrigin;
   if(!origin||origin!==originalOrigin)throw denied();
   const allowed=surface==='desktop'?[origin,...(value.developmentOrigin?[value.developmentOrigin]:[])]:[origin];
   if(!allowed.includes(`${surface==='desktop'?'http':'https'}://${headers.host}`))throw new Fault(403,'host_rejected','Use this workspace address.');
   if(headers.origin&&!allowed.includes(headers.origin)||headers['sec-fetch-site']==='cross-site')throw new Fault(403,'origin_rejected','This origin is not allowed.');
   if(surface==='phone'&&(!this.phone.enabled||!headers['tailscale-user-login']||!feedSemanticPhoneRouteAllowed(method,path)))throw denied();
   if(method==='POST'&&headers['x-edition3-client']!=='1')throw new Fault(403,'client_required','Use the Nova Dream client for this operation.');
   if(write){
    if(!candidateCurrent(value))throw new Fault(409,'client_update','Keep your writing and reload before making this change.');
    if(this.store.recoveryHeld)throw new Fault(409,'recovery_held','This recovered copy is read-only.');
    if(this.store.recoveryEffectsPaused)throw new Fault(409,'recovery_connections_paused','Connected changes remain paused in this recovered workspace.');
    if(this.store.updateMaintenanceHeld)throw new Fault(409,'update_maintenance','The workspace is updating. The original request is kept.');
   }
  };
  checkSurface();
  const web=surface==='web'?captureFeedWebRoute(request,()=>{const value=this.policy().privateWeb;if(!value)throw denied();return value;}):undefined;
  const deviceId=surface==='phone'?this.phone.authenticate(token):this.store.authenticate(token);
  const owner=captureFeedRequestOwner({deviceId,epoch:this.store.epoch,token,currentEpoch:()=>this.store.epoch,
   authenticate:original=>surface==='phone'?this.phone.checkAuthentication(original):this.store.authenticate(original),
   authorizeRoute:()=>{checkSurface();web?.();}});
  let result:unknown;
  try{
   if(method==='POST'){
    query(url,[]);const input=await body(request,maximum);owner.authorize();
    if(write&&this.policy().closing)throw new Fault(503,'service_closing','The workspace is restarting. The original request is kept.');
    if(path===prefix+'/reading'||path===prefix+'/reading/receipt'){
     if(!this.consumer)throw new Fault(503,'feed_consumer_unavailable','The current Feed view is unavailable. Its original request is kept.');
     result=path===prefix+'/reading'?this.consumer.readings.command(owner,input):this.consumer.readings.receipt(owner,input);
    }else if(path===prefix+'/advance'){
     const tick=z.object({epoch:uuid}).strict().parse(input);if(tick.epoch!==owner.epoch)throw denied();
     if(!this.consumer?.automatic)throw new Fault(503,'feed_automatic_unavailable','Automatic Feed matching is unavailable.');
     result=await this.consumer.automatic.advance(owner);
    }else if(path===prefix+'/original/receipt')result=this.controller.readOriginal(owner,adaptiveProtocolRequestSchema.parse(input));
    else if(path===prefix+'/acceptance/receipt')result=this.controller.acceptance(owner,adaptiveReviewCommandSchema.parse(input));
    else if(path===prefix+'/prepare')result=await this.controller.prepare(owner,feedStartPreparationSchema.parse(input));
    else if(path===prefix+'/observe'){const target=observation.parse(input);if(target.epoch!==owner.epoch)throw denied();result=await this.controller.observe(owner,target.id);}
    else{
     const command=adaptiveProtocolRequestSchema.parse(input);
     if(!('format' in command.command)||command.command.format!==3)throw new Fault(409,'feed_legacy_read_only','Check the unchanged original receipt; earlier commands are read-only.');
     if(command.kind==='start')result=await this.controller.start(owner,command.command);
     // Terminal Stop is a local exact receipt. The maintained authority itself
     // requires original native qualification for an unfinished worker.
     else if(command.kind==='stop')result=await this.controller.stop(owner,command.command);
     else if(command.kind==='accept')result=this.controller.accept(owner,command.command);
     else if(command.kind==='apply-learning')result=this.controller.applyLearning(owner,command.command);
     else result=this.controller.closeOriginal(owner,command.command);
    }
   }else if(path===prefix+'/feed'){
    query(url,['following']);const following=url.searchParams.get('following');if(following!==null&&following!=='0'&&following!=='1')throw new Fault(400,'feed_query','Use the exact Feed selection.');
    if(!this.consumer)throw new Fault(503,'feed_consumer_unavailable','The current Feed view is unavailable.');
    result=this.consumer.view.read(owner,{following:following==='1'});
   }else if(path===prefix+'/history'){
    query(url,['after','limit']);const after=url.searchParams.get('after'),limit=url.searchParams.get('limit');
    if(limit!==null&&!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit))throw new Fault(400,'feed_query','Use a Feed history limit from 1 to 50.');
    result=this.controller.history(owner,{...(after!==null?{after:uuid.parse(after)}:{}),...(limit!==null?{limit:Number(limit)}:{})});
   }else if(path===prefix+'/view'){
    query(url,[]);const value=this.policy();
    result={format:3,epoch:owner.epoch,deviceId:owner.deviceId,permissions:{read:true,write:!value.closing&&!this.store.recoveryHeld&&!this.store.recoveryEffectsPaused&&!this.store.updateMaintenanceHeld&&candidateCurrent(value)},
     native:this.controller.nativeCapabilities(owner)};
   }else{
    query(url,['id']);const id=uuid.parse(url.searchParams.get('id'));
    result=path===prefix+'/original'?this.controller.readRetained(owner,id):this.controller.interpretation(owner,id);
   }
   owner.authorize();
   const text=path===prefix+'/feed'?boundedFeedViewJson(result):JSON.stringify(result),bound=path===prefix+'/history'?feedProtocolLimits.historyBytes:512*1024;
   if(text===undefined||Buffer.byteLength(text)>bound)throw new Fault(413,'feed_result_large','The original Feed result exceeds this bounded view.');
   const projected:unknown=JSON.parse(text);owner.authorize();
   // The outer HTTP handler awaits this result. Keep the exact captured token
   // guard for its final synchronous exposure; never serialize this callback.
   return {status:200 as const,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:projected,authorize:()=>owner.authorize()};
  }finally{owner.authorize();}
 }
}
