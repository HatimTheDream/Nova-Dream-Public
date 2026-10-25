import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {adaptiveWorkerBounds} from '../../packages/domain/news-feed-adaptive-capture.js';
import {MutationPlanBudget} from './feed-history-projected-inventory.js';
import {isOwnedFeedSourceBeforeView} from './feed-adaptive-owned-source.js';

/** This slice encodes source/context data, not the larger worker envelopes. */
export const strictCanonicalByteLimit=adaptiveWorkerBounds.sourceBytes;
type Part='source'|'context';
export type StrictCanonicalView=Readonly<{
 byteLength:number;
 contextRange:Readonly<{start:number;end:number}>|undefined;
 producerEquivalent:boolean;
 /** Copies are diagnostic data, never authority or the private mutable buffer. */
 text:(part?:Part)=>string|undefined;
 sha256:(part?:Part)=>string|undefined;
 producerSha256:()=>string|undefined;
}>;

/** Isolated data codec: no Store facts, source authority, or public adoption.
 * It owns its byte buffer. Input mutation after encoding cannot alter it.
 * One original budget owns every allocation and the first refusal. Entry
 * charges count logical nodes/slots/native work records, not CPU instructions;
 * comparison/UTF-8 work is separately byte-metered. See the static ledger. */
export function withStrictCanonicalBytes(value:unknown,budget:MutationPlanBudget,check:()=>void,
 consume:(view:StrictCanonicalView)=>void,maxBytes=strictCanonicalByteLimit):void{
 // The added public-to-private delegation frame; the core's fixed64 stays.
 budget.reserveBytes(64);budget.entry();
 return withCanonicalBytes(value,budget,check,consume,maxBytes,false);
}
/** Only the owner's unexposed fresh JSON copy can take this internal route.
 * The caller cannot assert ownership, supply a proof, or choose encoder mode. */
export function withOwnedFeedSourceBytes(value:unknown,budget:MutationPlanBudget,check:()=>void,
 consume:(view:StrictCanonicalView)=>void,maxBytes=strictCanonicalByteLimit):void{
 // Checked callback, custody/error record and shared-core delegation frame.
 budget.reserveBytes(192);for(let i=0;i<3;i++)budget.entry();
 return budget.checked(()=>{
  if(!isOwnedFeedSourceBeforeView(value,budget))budget.fail(Error('Canonical owned source custody missing'));
  return withCanonicalBytes(value,budget,check,consume,maxBytes,true);
 });
}
function withCanonicalBytes(value:unknown,budget:MutationPlanBudget,check:()=>void,
 consume:(view:StrictCanonicalView)=>void,maxBytes:number,owned:boolean):void{
 return budget.checked(()=>{
  const charge=(entries:number,bytes:number)=>{budget.reserveBytes(bytes);for(let i=0;i<entries;i++)budget.entry();};
  // Scope, fixed helper closures, port/method closures, errors, ancestor set,
  // result metadata and bounded Promise rejection cleanup, before creation.
  charge(64,4096);
  function need(ok:unknown,message:string):asserts ok{if(!ok)budget.fail(Error(message));}
  need(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=strictCanonicalByteLimit,'Canonical buffer bound');
  need(budget.limits.entries<=16384&&budget.limits.bytes<=16777216&&budget.limits.queries<=4096,'Canonical allowance bound');
  let alive=false,busy=false,position=0,contextStart=-1,contextEnd=-1,equivalent=true;
  let sourceDigest:string|undefined,contextDigest:string|undefined;
  const ended=Error('Canonical byte scope ended'),reentered=Error('Canonical byte scope reentered');
  const badReturn=Error('Canonical byte scope requires synchronous undefined return');
  const guard=()=>{budget.query();const result:unknown=check();if(result!==undefined){
   if(types.isPromise(result))Promise.prototype.then.call(result,undefined,()=>undefined);
   budget.fail(badReturn);
  }};
  guard();
  charge(1,maxBytes);const bytes=Buffer.alloc(maxBytes);
  // The private owner has already JSON-parsed and deeply frozen this tree.
  // Generic callers still pay for and use the complete cycle validator.
  const ancestors=owned?undefined:new Set<object>();
  const space=(length:number)=>{need(position+length<=maxBytes,'Canonical encoded byte bound');budget.reserveBytes(length);};
  const ascii=(text:string)=>{space(text.length);for(let i=0;i<text.length;i++)bytes[position++]=text.charCodeAt(i);};
  const mark=(byte:number)=>{space(1);bytes[position++]=byte;};
  const string=(text:string)=>{
   mark(34);
   for(let i=0;i<text.length;i++){
    const n=text.charCodeAt(i);
    if(n===34||n===92){space(2);bytes[position++]=92;bytes[position++]=n;}
    else if(n===8||n===9||n===10||n===12||n===13){space(2);bytes[position++]=92;bytes[position++]=n===8?98:n===9?116:n===10?110:n===12?102:114;}
    else if(n<32){space(6);bytes[position++]=92;bytes[position++]=117;bytes[position++]=48;bytes[position++]=48;
     const high=n>>>4,low=n&15;bytes[position++]=high<10?48+high:87+high;bytes[position++]=low<10?48+low:87+low;}
    else if(n<128){mark(n);}
    else if(n<2048){space(2);bytes[position++]=192|(n>>>6);bytes[position++]=128|(n&63);}
    else if(n>=0xd800&&n<=0xdbff){const low=text.charCodeAt(++i);need(low>=0xdc00&&low<=0xdfff,'Canonical invalid Unicode');
     const point=0x10000+((n-0xd800)<<10)+(low-0xdc00);space(4);bytes[position++]=240|(point>>>18);bytes[position++]=128|((point>>>12)&63);bytes[position++]=128|((point>>>6)&63);bytes[position++]=128|(point&63);}
    else{need(n<0xdc00||n>0xdfff,'Canonical invalid Unicode');space(3);bytes[position++]=224|(n>>>12);bytes[position++]=128|((n>>>6)&63);bytes[position++]=128|(n&63);}
   }
   mark(34);
  };
  // In-place heapsort: one existing key-reference vector, no recursive sort,
  // comparator closure per object, temporary tuples, or second order vector.
  const less=(a:string,b:string)=>{budget.reserveBytes(2*(a.length+b.length));return a<b;};
  const down=(keys:string[],start:number,end:number)=>{
   let parent=start;
   for(;;){let child=parent*2+1;if(child>=end)return;
    if(child+1<end&&less(keys[child]!,keys[child+1]!))child++;
    if(!less(keys[parent]!,keys[child]!))return;
    const saved=keys[parent]!;keys[parent]=keys[child]!;keys[child]=saved;parent=child;
   }
  };
  const sort=(keys:string[])=>{
   for(let i=Math.floor(keys.length/2)-1;i>=0;i--)down(keys,i,keys.length);
   for(let end=keys.length-1;end>0;end--){const saved=keys[0]!;keys[0]=keys[end]!;keys[end]=saved;down(keys,0,end);}
  };
  // A stable producer sort has this exact sequence iff it is locale ordered,
  // and each adjacent equal-comparison pair retains its original insertion
  // order. Re-enumerating only ties avoids a second per-key index vector.
  const producerOrder=(object:object,keys:readonly string[])=>{
   for(let i=1;equivalent&&i<keys.length;i++){
    const a=keys[i-1]!,b=keys[i]!;charge(1,64+8*(a.length+b.length));const compared=a.localeCompare(b);
    if(compared>0){equivalent=false;return;}
    if(compared===0){
     for(const original in object)if(Object.hasOwn(object,original)){
      charge(1,16+2*original.length);
      if(original===a)break;
      if(original===b){equivalent=false;return;}
     }
    }
   }
  };
  const visit=(item:unknown,depth:number)=>{
   need(depth<=128,'Canonical JSON depth bound');charge(1,48);
   if(item===null){ascii('null');return;}
   if(typeof item==='string'){string(item);return;}
   if(typeof item==='boolean'){ascii(item?'true':'false');return;}
   if(typeof item==='number'){need(Number.isFinite(item),'Canonical finite JSON required');charge(1,96);ascii(JSON.stringify(item)!);return;}
   need(typeof item==='object'&&item!==null,'Canonical strict JSON required');
   need(!types.isProxy(item),'Canonical Proxy forbidden');
   const object=item as object,array=Array.isArray(object),prototype=Object.getPrototypeOf(object);
   need(prototype===(array?Array.prototype:Object.prototype)||!array&&prototype===null,'Canonical plain JSON required');
   if(!owned){
    need(!ancestors!.has(object),'Canonical cycle forbidden');
    // Ancestor set slot and own-symbol result array. A nonempty symbol result
    // immediately refuses; no result is enrolled or traversed.
    charge(2,80);need(Object.getOwnPropertySymbols(object).length===0,'Canonical symbol property');ancestors!.add(object);
   }
   try{
    if(array){
     let length:number;
     if(owned)length=(object as unknown[]).length;
     else{charge(1,96);const descriptor=Object.getOwnPropertyDescriptor(object,'length');
      need(descriptor&&'value'in descriptor&&Number.isSafeInteger(descriptor.value)&&descriptor.value>=0,'Canonical array length');length=descriptor.value;}
     mark(91);let count=0;
     for(const key in object)if(Object.hasOwn(object,key)){
      charge(1,64);if(!owned)need(key===String(count),'Canonical dense array required');
      let child:unknown;
      if(owned)child=(object as unknown as Record<string,unknown>)[key];
      else{charge(1,96);const descriptor=Object.getOwnPropertyDescriptor(object,key);need(descriptor&&'value'in descriptor,'Canonical accessor forbidden');child=descriptor.value;}
      if(count++)mark(44);visit(child,depth+1);
     }
     if(!owned)need(count===length,'Canonical dense array required');mark(93);
    }else{
     charge(1,32);const keys:string[]=[];
     for(const key in object)if(Object.hasOwn(object,key)){charge(1,16+2*key.length);keys.push(key);}
     sort(keys);if(equivalent)producerOrder(object,keys);mark(123);
     for(let i=0;i<keys.length;i++){
      const key=keys[i]!;let child:unknown;
      if(owned)child=(object as Record<string,unknown>)[key];
      else{charge(1,96);const descriptor=Object.getOwnPropertyDescriptor(object,key);need(descriptor&&'value'in descriptor,'Canonical accessor forbidden');child=descriptor.value;}
      if(i)mark(44);string(key);mark(58);
      const context=depth===0&&key==='context';if(context)contextStart=position;
      visit(child,depth+1);if(context)contextEnd=position;
     }
     mark(125);
    }
   }finally{ancestors?.delete(object);}
  };
  visit(value,0);guard();
  const range=(part:Part)=>{need(part==='source'||part==='context','Canonical part invalid');return part==='context'?contextStart:0;};
  const digest=(part:Part)=>{
   const start=range(part);if(start<0)return undefined;
   const saved=part==='source'?sourceDigest:contextDigest;if(saved!==undefined)return saved;
   const end=part==='source'?position:contextEnd;
   // Hash instance, bounded Buffer view, digest result, native block scratch.
   charge(3,512+end-start);const result=createHash('sha256').update(bytes.subarray(start,end)).digest('hex');
   if(part==='source')sourceDigest=result;else contextDigest=result;return result;
  };
  const scope=(kind:'text'|'hash'|'producer',part:Part)=>{
   charge(1,32);return budget.checked(()=>{
    if(!alive)budget.fail(ended);if(busy)budget.fail(reentered);busy=true;
    try{
     guard();let result:string|undefined;
     if(kind==='text'){
      const start=range(part);if(start>=0){const end=part==='source'?position:contextEnd;charge(1,32+2*(end-start));result=bytes.toString('utf8',start,end);}
     }else result=kind==='producer'&&!equivalent?undefined:digest(part);
     guard();return result;
    }finally{busy=false;}
   });
  };
  const view:StrictCanonicalView=Object.freeze({byteLength:position,
   contextRange:contextStart<0?undefined:Object.freeze({start:contextStart,end:contextEnd}),producerEquivalent:equivalent,
   text:(part:Part='source')=>scope('text',part),
   sha256:(part:Part='source')=>scope('hash',part),
   producerSha256:()=>scope('producer','source'),
  });
  alive=true;
  try{
   const result:unknown=consume(view);alive=false;
   if(result!==undefined){if(types.isPromise(result))Promise.prototype.then.call(result,undefined,()=>undefined);budget.fail(badReturn);}
   guard();budget.checked(()=>undefined);
  }finally{alive=false;}
 });
}
