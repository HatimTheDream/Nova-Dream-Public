import {types} from 'node:util';
import {adaptiveCanonical,prepareAdaptiveLearningCaptures} from '../../packages/domain/news-feed-adaptive.js';
import type {FeedAdaptiveContext,AdaptiveWrittenBasis,AdaptiveResult,AdaptiveLearningCapture,PreparedLearningCaptures} from '../../packages/domain/news-feed-adaptive.js';
import type {FeedStory} from '../../packages/domain/news-feed.js';
import {workerInputHash} from './worker-plugin/identity.js';
import {MutationPlanBudget,mutationNeed as need} from './feed-history-projected-inventory.js';

export const producerSelectionLimits=Object.freeze({qualification:'unqualified' as const,entries:16384,bytes:16777216,queries:4096});
type Size={bytes:number;slots:number;depth:number;objects:number;arrays:number;keys:number;primitives:number};
const learningBodyFixedBytes='{"format":2,"requestId":,"at":,"context":,"basis":,"contextSha256":""}'.length+64;
/** Added selector work only. Complete proof and lens copies keep their own
 * unchanged allowance. Inputs are trusted strict JSON from that scoped lens. */
export class SelectionWork{
 constructor(readonly budget:MutationPlanBudget,private readonly check:()=>void){
  need(budget.limits.entries<=producerSelectionLimits.entries&&budget.limits.bytes<=producerSelectionLimits.bytes&&budget.limits.queries<=producerSelectionLimits.queries,'Selector allowance exceeded');
  // Scope/child closures and genuine-Promise rejection cleanup are prepaid.
  this.reserve(24,1024);
 }
 reserve(entries:number,bytes:number){need(Number.isSafeInteger(entries)&&entries>=0&&Number.isSafeInteger(bytes)&&bytes>=0,'Selector arithmetic overflow');
  this.budget.reserveBytes(bytes);for(let i=0;i<entries;i++)this.budget.entry();}
 guard(){this.budget.checked(()=>{this.budget.query();const value:unknown=this.check();
  if(value!==undefined){if(types.isPromise(value))Promise.prototype.then.call(value,undefined,()=>undefined);throw Error('Selector guard must return undefined synchronously');}});}
 measure(value:unknown):Size{
  this.reserve(3,64);let bytes=0,slots=0,maximumDepth=0,objects=0,arrays=0,keys=0,primitives=0;
  const add=(n:number)=>{bytes+=n;need(Number.isSafeInteger(bytes)&&bytes<=this.budget.limits.bytes,'Selector input byte bound');};
  const string=(s:string)=>{add(2);for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c===34||c===92||c===8||c===9||c===10||c===12||c===13)add(2);
   else if(c<32)add(6);else if(c>=0xd800&&c<=0xdbff){const low=s.charCodeAt(++i);need(low>=0xdc00&&low<=0xdfff,'Selector invalid Unicode');add(4);}
   else{need(c<0xdc00||c>0xdfff,'Selector invalid Unicode');add(c<128?1:c<2048?2:3);}}};
  const visit=(v:unknown,depth:number)=>{need(depth<=128,'Selector JSON depth bound');maximumDepth=Math.max(maximumDepth,depth);this.reserve(1,16);slots++;
   if(v===null){primitives++;add(4);return;}if(typeof v==='string'){primitives++;string(v);return;}if(typeof v==='boolean'){primitives++;add(v?4:5);return;}
   if(typeof v==='number'){primitives++;need(Number.isFinite(v),'Selector finite JSON required');this.reserve(1,64);add(JSON.stringify(v).length);return;}
   need(typeof v==='object'&&v!==null,'Selector strict JSON required');const a=Array.isArray(v);need(Object.getPrototypeOf(v)===(a?Array.prototype:Object.prototype)||Object.getPrototypeOf(v)===null,'Selector plain JSON required');
   if(a)arrays++;else objects++;this.reserve(1,32);need(Object.getOwnPropertySymbols(v).length===0,'Selector symbol property');add(2);let count=0;
   for(const key in v)if(Object.hasOwn(v,key)){this.reserve(2,32);slots++;const d=Object.getOwnPropertyDescriptor(v,key);need(d&&'value'in d,'Selector accessor forbidden');
    if(a)need(key===String(count),'Selector dense array required');else{keys++;string(key);add(1);}if(count++)add(1);visit(d.value,depth+1);}
   if(a)need(count===(v as unknown[]).length,'Selector dense array required');
  };visit(value,0);return {bytes,slots,depth:maximumDepth,objects,arrays,keys,primitives};
 }
 hash(value:unknown){const size=this.measure(value);this.reserve(8*size.slots+16,(6*size.depth+8)*size.bytes+512);this.budget.query();this.guard();
  const result=workerInputHash(adaptiveCanonical(value));this.guard();return result;}
 same(a:unknown,b:unknown){this.guard();this.budget.query();this.reserve(2,64);
  const compare=(x:unknown,y:unknown,depth:number):boolean=>{need(depth<=128,'Selector comparison depth bound');this.reserve(1,16);
   if(x===y)return true;if(typeof x!==typeof y||x===null||y===null||typeof x!=='object'||typeof y!=='object')return false;
   if(Array.isArray(x)!==Array.isArray(y))return false;let nx=0,ny=0;
   for(const key in x)if(Object.hasOwn(x,key)){nx++;if(!Object.hasOwn(y,key))return false;this.reserve(2,64);
    const a=Object.getOwnPropertyDescriptor(x,key),b=Object.getOwnPropertyDescriptor(y,key);need(a&&b&&'value'in a&&'value'in b,'Selector comparison accessor');if(!compare(a.value,b.value,depth+1))return false;}
   for(const key in y)if(Object.hasOwn(y,key))ny++;return nx===ny;
  };const same=compare(a,b,0);this.guard();return same;
 }
 /** All dependencies are measured before creating the small child tuple. */
 child<T>(context:FeedAdaptiveContext,dependencies:readonly unknown[],run:(hash:(text:string)=>string)=>T,kind:'learning'|'basis'|'preview'|'hard',story?:FeedStory):T{
  this.guard();this.budget.query();this.reserve(16,512);let B=0,S=0,depth=0;
  for(let index=0;index<dependencies.length;index++){const size=this.measure(dependencies[index]);B+=size.bytes;S+=size.slots;depth=Math.max(depth,size.depth);}
  const I=kind==='preview'?context.learning.interests.length:0;need(I<=64,'Selector interest bound');
  // Only the maintained hard filter joins this exact summary without parsing,
  // canonicalizing or hashing the story. Keep every other child reservation.
  let asciiHaystack=false;
  if(kind==='hard'&&story){
   this.reserve(2,64);this.budget.query();let matches=0;
   for(let index=0;index<dependencies.length;index++)if(dependencies[index]===story)matches++;
   if(matches===1){
    const ascii=(text:string)=>{for(let index=0;index<text.length;index++)if(text.charCodeAt(index)>127)return false;return true;};
    this.reserve(1,16);asciiHaystack=ascii(story.title);
    if(asciiHaystack){this.reserve(1,16);asciiHaystack=ascii(story.summary);}
    for(let index=0;asciiHaystack&&index<story.topics.length;index++){this.reserve(1,16);asciiHaystack=ascii(story.topics[index]);}
   }
  }
  const settings=context.profile.settings,control=context.control;
  const lengths=(rows:readonly string[])=>{let n=0;for(let index=0;index<rows.length;index++)n+=rows[index].length;return n;};
  const profileChars=lengths(settings.interests)+lengths(settings.exclusions),controlChars=lengths(control.kept)+lengths(control.stopped);
  let basisChars=0,basis:any;for(let index=0;index<dependencies.length;index++){const item=dependencies[index] as any;if(item?.kind==='accepted'){basis=item;basisChars+=lengths(item.capture.writing.interests)+lengths(item.capture.writing.exclusions);}}
  let interestChars=0;for(let index=0;index<context.learning.interests.length;index++)interestChars+=context.learning.interests[index].label.length;
  const D=settings.directions.length;let terms=D?1:0;for(let i=0;i<D;i++)if(settings.directions.charCodeAt(i)===59||settings.directions.charCodeAt(i)===10)terms++;
  const exclusionCount=settings.exclusions.length+terms,exclusionChars=lengths(settings.exclusions)+D;
  let normalizeUnits=kind==='hard'?0:8*(1+I)*(profileChars+basisChars)+(kind==='basis'?0:(1+I)*(controlChars+interestChars))+(story?lengths(story.topics):0);
  let literalCalls=kind==='hard'?1:2*I,wordHaystack=0,wordNeedles=0,wordCalls=0;
  if(kind==='hard'&&story){wordHaystack=exclusionCount*(story.title.length+story.summary.length+lengths(story.topics)+story.topics.length+2);wordNeedles=exclusionChars;wordCalls=exclusionCount;}
  if(kind==='preview'){
   normalizeUnits+=control.kept.length*lengths(control.stopped)+control.stopped.length*lengths(control.kept);
   for(let index=0;index<context.learning.interests.length;index++){const interest=context.learning.interests[index];normalizeUnits+=lengths(control.stopped)+control.stopped.length*interest.label.length;
    for(let ai=0;ai<interest.relation.anchors.length;ai++){const anchor=interest.relation.anchors[ai];if(anchor.kind==='kept')normalizeUnits+=lengths(control.kept)+control.kept.length*anchor.topic.length;}
    let haystack=interest.label.length;for(let si=0;si<interest.supports.length;si++)haystack+=interest.supports[si].span.quote.length;
    wordHaystack+=exclusionCount*haystack;wordNeedles+=(1+interest.supports.length)*exclusionChars;wordCalls+=(1+interest.supports.length)*exclusionCount;
   }
  }
  normalizeUnits+=literalCalls*3*(profileChars+D);
  const literalSlots=16*literalCalls*(terms+settings.interests.length+settings.exclusions.length+1)+8*wordCalls;
  // Exact per-shape logical allocation counts supplement the32S floor. Strict
  // successful Zod parse: payload/issues per value, result/proms/key work per
  // container. This is not an engine-internal/physical heap qualification.
  let weighted=0;
  const quota=(value:unknown,canonical:number,schemas:number)=>{const n=this.measure(value),nodes=n.objects+n.arrays+n.primitives;
   weighted+=canonical*(6*n.objects+4*n.arrays+4*n.keys+n.primitives+8)+schemas*(2*nodes+3*n.objects+2*n.arrays+16);};
  const writingQuota=(writing:{interests:readonly string[];exclusions:readonly string[];directions:string},canonical:number,schemas:number)=>{
   quota(writing.interests,canonical,schemas);quota(writing.exclusions,canonical,schemas);quota(writing.directions,canonical,schemas);weighted+=canonical*20+schemas*20;};
  if(kind!=='hard'){
   if(kind==='basis')quota(context.profile,5,2);else{quota(context,6+3*I,1+I);quota(context.profile,2+4*I,1+2*I);}
   writingQuota(settings,3+6*I,1+2*I);
   if(basis){quota(basis.capture,(kind==='basis'?10:12)+10*I,2*(1+I));writingQuota(basis.capture.writing,2*(1+I),0);
    quota(basis.plan,(kind==='basis'?5:7)+5*I,2*(1+I));quota(basis.approval,(kind==='basis'?4:6)+4*I,1+I);}
   if(kind==='preview'){quota(story,4,1);for(let index=0;index<context.learning.interests.length;index++)quota(context.learning.interests[index],4,1);}
  }
  // ASCII NFKC/lowercase do not expand: retain the parent four-string,
  // four-bytes-per-unit envelope (16), with unchanged Unicode needle work.
  // Deduct only unescaped summary units from the generic hard-child base;
  // 4*units separately prepays its one join contribution. Escaping overhead,
  // all other inputs and full preview/hash accounting remain charged.
  const summaryUnits=asciiHaystack?story!.summary.length:0;need(Number.isSafeInteger(summaryUnits)&&summaryUnits>=0&&B>=summaryUnits,'Selector summary accounting');
  this.reserve(Math.max(32*(1+I)*S,weighted)+512+literalSlots,64*(1+I)*(depth+1)*(B-summaryUnits)+65536+4*summaryUnits+864*normalizeUnits+(asciiHaystack?16:864)*wordHaystack+1728*wordNeedles+64*wordCalls);
  // The complete child reservation owns callback/canonical/UTF8 work too.
  const hash=(text:string)=>{this.guard();return workerInputHash(text);};const value=run(hash);this.guard();return value;
 }
 /** A lazy owned learning preparation lives only inside this synchronous call.
  * Guarded wrappers, never the raw prepared object, reach the consumer. */
 withLearningCaptures(context:FeedAdaptiveContext,basis:AdaptiveWrittenBasis,consume:(capture:(requestId:string,at:number)=>AdaptiveResult<AdaptiveLearningCapture>)=>void):void{
  // Preserve the original scope allowance and prepay the new owned eligible
  // closure plus prepared-object method slot, including capture-only callers.
  this.reserve(66,2112);
  const ended=Error('Learning capture scope ended'),reentry=Error('Learning capture scope reentered'),async=Error('Learning capture consumer must return undefined synchronously');
  let alive=true,inCall=false,prepared:AdaptiveResult<PreparedLearningCaptures>|undefined;
  let bodyBase=0,bodyDepth=0,tailEntries=0,evidenceBytes=0;
  const capture=(requestId:string,at:number):AdaptiveResult<AdaptiveLearningCapture>=>{
   if(!alive)return this.budget.fail(ended);if(inCall)return this.budget.fail(reentry);inCall=true;
   try{this.reserve(4,256);this.guard();this.budget.query();let result:AdaptiveResult<AdaptiveLearningCapture>;
    if(prepared===undefined){
     const c=this.measure(context),b=this.measure(basis),R=context.activity.length,M=context.learning.suppressed.length;
     this.reserve(4*b.slots+16+2*(c.objects+c.arrays)+16+8,4*b.bytes+16*b.slots+16*(c.objects+c.arrays));
     const canonical=(n:Size)=>6*n.objects+4*n.arrays+4*n.keys+n.primitives+8;
     bodyBase=c.bytes+b.bytes+learningBodyFixedBytes;bodyDepth=Math.max(c.depth,b.depth)+1;
     tailEntries=2*(canonical(c)+canonical(b)+26)+128+16*R+R*(1+M);
     let keys=0;for(let i=0;i<R;i++)keys+=context.activity[i].source.length+context.activity[i].sourceId.length+1;
     evidenceBytes=32*R+8*keys; // Both fields are validated ASCII identity strings.
     const first=this.child(context,[context,basis],hash=>{
      const strictHash=(text:string)=>{try{return hash(text);}catch(error){return this.budget.fail(error);}};
      const value=prepareAdaptiveLearningCaptures(context,basis,strictHash);
      return {prepared:value,result:value.ok?value.value.capture(requestId,at):value};
     },'learning');prepared=first.prepared;result=first.result;
    }else if(!prepared.ok)result=prepared;
    else{
     // Scalar formatting is itself prepaid by measure, before body allocation.
     const id=this.measure(requestId),time=this.measure(at),bytes=bodyBase+id.bytes+time.bytes;
     this.reserve(tailEntries,8*(bodyDepth+1)*bytes+1024+evidenceBytes);
     result=prepared.value.capture(requestId,at);
    }
    this.guard();return result;
   }catch(error){alive=false;return this.budget.fail(error);}finally{inCall=false;}
  };
  try{this.guard();const value:unknown=consume(capture);
   if(value!==undefined){if(types.isPromise(value))Promise.prototype.then.call(value,undefined,()=>undefined);throw async;}
   this.guard();
  }catch(error){return this.budget.fail(error);}finally{alive=false;}
 }
 get<K,V>(map:ReadonlyMap<K,V>,key:K):V|undefined{this.guard();this.budget.query();this.reserve(2,64);const value=map.get(key);this.guard();return value;}
 scan<K,V>(map:ReadonlyMap<K,V>,visit:(value:V)=>boolean|void){this.guard();this.budget.query();this.budget.query();this.reserve(6,160);const it=map.values();
  try{for(;;){this.guard();this.budget.query();this.reserve(2,48);const item=it.next();this.guard();if(item.done)return;if(visit(item.value)===false)return;}}
  finally{it.return?.();} // Return work was prepaid before creating this cursor.
 }
 result<T>(value:T):T{const size=this.measure(value);need(size.bytes<=4096,'Selector result byte bound');this.reserve(4*size.slots+8,4*size.bytes+256);this.guard();const result=this.budget.copy(value);this.guard();return result;}
}
