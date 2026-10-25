import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const {Store}=await import('../apps/service/store.js');
const {NewsFeed}=await import('../apps/service/news-feed.js');
const {FeedAdaptiveView}=await import('../apps/service/feed-adaptive-view.js');
const {FeedAdaptiveReading}=await import('../apps/service/feed-adaptive-reading.js');
const {FeedAdaptiveCurrentSource}=await import('../apps/service/feed-adaptive-current-source.js');
const {FeedAdaptiveAuthority}=await import('../apps/service/feed-adaptive-authority.js');
const {FeedAdaptiveController}=await import('../apps/service/feed-adaptive-controller.js');
const {captureFeedRequestOwner}=await import('../apps/service/feed-request-authority.js');
const {emptyFeedSettings}=await import('../packages/domain/news-feed.js');
const {adaptiveHash}=await import('../packages/domain/news-feed-adaptive.js');
const {preferenceProof}=await import('../packages/domain/news-feed-adaptive-capture.js');
const {verifyFeedLocalGraph}=await import('../packages/domain/news-feed-successor-journal.js');
const {workerInputHash:hash,workerNativeIdentity}=await import('../apps/service/worker-plugin/identity.js');
const {WorkerTransport}=await import('./fixtures/assignment-worker.js');
const suppliedOperation=process.env.NOVA_HISTORY_TEST_OPERATION;
if(suppliedOperation!==undefined&&!/^[a-zA-Z0-9_-]{1,80}$/.test(suppliedOperation))throw Error('Invalid automatic Feed test operation');
const operation=suppliedOperation??randomUUID();
const fixtures=fileURLToPath(new URL('../.tmp-qa/feed-auto/'+operation+'/',import.meta.url));mkdirSync(fixtures,{recursive:true});
export const publisher={id:'source:fixture',title:'Synthetic Publisher',url:'https://publisher.example/feed',enabled:true};
class Transport extends WorkerTransport{
 modelsRead=0;
 async modelsWithAuthority(authorize:()=>void){authorize();this.modelsRead++;return [{id:'openai/test-model',name:'Synthetic Test Model',provider:'openai',available:true,isDefault:true}];}
 override async models():Promise<never[]>{throw Error('Unguarded model list forbidden');}
}
export type Reopen={directory:string;session:any;at:number;generation:ReturnType<typeof randomUUID>;nativeId:ReturnType<typeof randomUUID>;observation:any};
export async function fixture(run:(f:any)=>Promise<void>|void,reopen?:Reopen){
 const directory=reopen?.directory??mkdtempSync(join(fixtures,'f-')),store=new Store(directory);let clock=reopen?.at??Date.now(),allowed=true,read=true,write=true,passed=false,fetches=0,accountReads=0;
 const session=reopen?.session??store.session();assert(session.token);const gateway=new Transport(directory,store.epoch);gateway.methods.push('models.list','e3.accounts.snapshot');
 if(reopen){gateway.generation=reopen.generation;gateway.nativeId=reopen.nativeId;gateway.observation=structuredClone(reopen.observation);}
 else store.internalWrite('gateway:configuration',{url:'https://synthetic.invalid',token:'synthetic-fixture'});
 const news=new NewsFeed(store,()=>clock,async()=>{fetches++;throw Error('Public fetch forbidden');});
 const owner=captureFeedRequestOwner({deviceId:session.deviceId,epoch:store.epoch,token:session.token,currentEpoch:()=>store.epoch,authenticate:token=>store.authenticate(token),authorizeRoute(){if(!allowed)throw Error('Original owner revoked');}});
 const permission=()=>({read,write}),view=new FeedAdaptiveView(store,news,permission,()=>clock),source=new FeedAdaptiveCurrentSource(store,news,permission);
 // Synthetic worker seeding only; production composition has unavailable native
 // qualification. The view itself has no gateway/account/qualification port.
 const authority=new FeedAdaptiveAuthority(store,gateway,{async route(){accountReads++;return {profileId:'synthetic-account',label:'Fixture',reason:'preferred' as const,checkedAt:clock};}},
  {routingPolicy:()=>({revision:'synthetic-routing',busy:false}),qualification:()=>({id:'synthetic-seed-only',available:true}),permissions:o=>source.permissions(o),source:o=>source.source(o),story:(o,id)=>source.story(o,id)?.story},()=>store.internalFeedLedger(),()=>clock);
 const controller=new FeedAdaptiveController(store,authority,source,()=>clock),readings=new FeedAdaptiveReading(store,news,view,permission);
 const saved=()=>store.internalRead<any>('home:news:state');
 const command=(type:string,extra:any={},device=session.deviceId)=>{const input={requestId:randomUUID(),epoch:store.epoch,expectedRevision:saved()?.revision??1,type,...extra},result=news.command(device,input);assert.equal(result.state,'saved');return {command:input,result};};
 const f:any={directory,store,news,view,readings,source,owner,controller,authority,gateway,session,hash,
  reopen:():Reopen=>({directory,session,at:clock,generation:gateway.generation,nativeId:gateway.nativeId,observation:structuredClone(gateway.observation)}),accountReads:()=>accountReads,now:()=>clock,saved,command,read(v:boolean){read=v;},write(v:boolean){write=v;},revoke(){allowed=false;},restore(){allowed=true;},advance(ms:number){clock+=ms;},
  configure(settings:any={}){return command('settings',{settings:{...emptyFeedSettings(),sources:[publisher],...settings}});},
  stories(count=1,summary='Energy storage research.',title='Research Update'){
   const stories=Array.from({length:count},(_,i)=>{const canonicalUrl='https://publisher.example/story-'+i;return {id:hash(canonicalUrl),revision:1,canonicalUrl,sourceId:publisher.id,publisherId:'publisher.example',publisher:'Synthetic Publisher',title,summary,summaryKind:'publisher-preview',publishedAt:new Date(clock).toISOString(),updatedAt:null,fetchedAt:new Date(clock).toISOString(),sourceDigest:hash('source-bytes'),topics:[]};});
   store.internalWrite('home:news:cache',[{source:publisher,profileRevision:saved().profile.revision,fetchedAt:new Date(clock).toISOString(),sourceDigest:hash('source-bytes'),stories,rejectedCount:0}]);return stories;
  },
  async worker(descriptor:any,output:(record:any)=>unknown){const command=await controller.prepare(owner,{format:3,requestId:randomUUID(),epoch:store.epoch,...descriptor});
   await controller.start(owner,command);await (authority as any).worker.settle();const record=store.internalRead<any>('news:semantic-adaptive-worker:'+command.requestId)!;
   gateway.finish(JSON.stringify(output(record)));gateway.observation.endedAt=clock;gateway.observation.terminalReceipt.effective={provider:'openai',model:'test-model'};gateway.observation.terminalReceipt.sourceReplyDelivered=false;
   assert.equal((await controller.observe(owner,command.requestId)).state,'completed');return store.internalRead<any>('news:semantic-adaptive-worker:'+command.requestId)!;
  },
  async accepted(){const record=await f.worker({kind:'interpret'},(value:any)=>{const brief=value.capture.brief,writing=brief.writing;
    const sources=[...(writing.directions?[{field:'directions',start:0,end:writing.directions.length,quote:writing.directions}]:[]),...writing.interests.map((text:string,index:number)=>({field:'interests',index,start:0,end:text.length,quote:text}))];
    return {format:2,requestId:value.id,briefSha256:brief.briefSha256,rules:[{id:'energy',kind:'include',meaning:'Energy discovery',sources}],unsupported:[]};});
   const review={format:3,requestId:randomUUID(),epoch:store.epoch,operationId:record.id,expectedRevision:record.capture.source.context.profile.revision,briefSha256:record.capture.brief.briefSha256,planSha256:adaptiveHash(JSON.parse(record.output.text),hash),terminalSha256:adaptiveHash(record.terminal,hash)};
   controller.accept(owner,review);return {kind:'accepted',reviewId:review.requestId,originalProofSha256:adaptiveHash(f.graph().adaptiveReviews.get(review.requestId).source,hash)};
  },
  emptyBasis(){const current=source.current(owner).source;assert(current);return {kind:'empty-written',preferenceProofSha256:preferenceProof(current,hash)};},
  async classify(story:any,basis:any,outcome='met'){return f.worker({kind:'classify',basis,story:{id:story.id,revision:story.revision,sourceId:story.sourceId,sourceDigest:story.sourceDigest}},(record:any)=>{
   const preview=record.capture.preview,evidence=outcome==='unknown'?[]:[{field:'summary',start:0,end:Math.min(6,story.summary.length),quote:story.summary.slice(0,6)}];
   const rules=preview.basis.kind==='accepted'?preview.basis.plan.rules:[];
   return {format:2,requestId:record.id,previewSha256:preview.previewSha256,rules:rules.map((r:any)=>({id:r.id,outcome,evidence})),candidates:preview.candidates.map((c:any)=>({id:c.kind+':'+c.id,outcome,evidence}))};
  });},
  async learn(apply=true){const record=await f.worker({kind:'learn',basis:f.emptyBasis()},(record:any)=>({format:2,requestId:record.id,captureSha256:record.capture.learning.captureSha256,candidates:[{id:'energy',label:'Energy discovery',supports:record.capture.source.context.activity.map((row:any)=>({activityId:row.id,start:0,end:row.text.length,quote:row.text})),relation:{kind:'activity-only',anchors:[]},constraints:[]}]}));
   if(apply)controller.applyLearning(owner,{format:3,requestId:randomUUID(),epoch:store.epoch,operationId:record.id,expectedLearningRevision:record.capture.source.context.learning.revision,terminalSha256:adaptiveHash(record.terminal,hash),captureSha256:record.capture.learning.captureSha256});return record;
  },
  library(){for(const id of ['note-one','note-two'])store.internalWrite('home:library:item:'+id,{id,kind:'note',revision:1,title:'Private energy note',body:'Current permitted source text '+id,archived:false,updatedAt:new Date(clock).toISOString()});},
  graph(){return verifyFeedLocalGraph(store.internalFeedLedger(),hash,workerNativeIdentity);},
  capture(){return {records:(store as any).db.prepare('SELECT id,revision,hex(payload) AS payload FROM service_records ORDER BY id').all(),receipts:(store as any).db.prepare('SELECT * FROM receipts ORDER BY request_id').all(),calls:gateway.calls.length,models:gateway.modelsRead,accounts:accountReads};},
 };
 try{await run(f);assert.equal(fetches,0);passed=true;}finally{const close=await controller.close(1000);news.close();gateway.stopJournal?.();if(close.localSettled)store.close();else passed=false;
  assert(resolve(directory).startsWith(resolve(fixtures)+sep));writeFileSync(join(directory,reopen?'RESULT-reopen.json':'RESULT-initial.json'),JSON.stringify({operation,passed,retained:true,syntheticNative:true,providerExecution:false}));
  assert.equal(close.localSettled,true,'Original fixture did not drain; saved copy retained');}
}
