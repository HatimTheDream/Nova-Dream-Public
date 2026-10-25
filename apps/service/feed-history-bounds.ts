/** Count the exact JSON UTF-8 serialization before allocating that serialized
 * string or cloning a complete backup. JSON data only: no getter, toJSON,
 * prototype conversion, nonfinite number, sparse array or cyclic projection.
 * The caller supplies its existing explicit unqualified byte budget; this does
 * not introduce a lifetime row limit or production capacity policy. */
export function historyJsonBytes(input:unknown,limit:number):number{
 if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid history JSON byte budget');
 let bytes=0;const add=(amount:number)=>{bytes+=amount;if(!Number.isSafeInteger(bytes)||bytes>limit)throw new Error('History JSON input byte bound');};
 function string(value:string){add(2);for(let i=0;i<value.length;i++){
  const code=value.charCodeAt(i);
  if(code===34||code===92||[8,9,10,12,13].includes(code))add(2);
  else if(code<32)add(6);
  else if(code>=0xd800&&code<=0xdbff){const low=value.charCodeAt(i+1);if(low>=0xdc00&&low<=0xdfff){add(4);i++;}else add(6);}
  else if(code>=0xdc00&&code<=0xdfff)add(6);else add(code<128?1:code<2048?2:3);
 }}
 const live=new Set<object>(),stack:{value:object;iterator:Iterator<unknown>}[]=[];
 function* children(value:Record<string,unknown>|unknown[]){let first=true;
  if(Array.isArray(value)){
   for(const key in value)if(Object.hasOwn(value,key)&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))throw new Error('History JSON array property unsupported');
   for(let i=0;i<value.length;i++){const descriptor=Object.getOwnPropertyDescriptor(value,String(i));if(!descriptor||!('value'in descriptor))throw new Error('History JSON sparse/accessor array unsupported');if(!first)add(1);first=false;yield descriptor.value;}
  }else for(const key in value)if(Object.hasOwn(value,key)){
   const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value'in descriptor))throw new Error('History JSON accessor unsupported');
   if(!first)add(1);first=false;string(key);add(1);yield descriptor.value;
  }
 }
 let next:unknown=input,hasNext=true;
 while(hasNext){
  if(next===null)add(4);else if(typeof next==='string')string(next);else if(typeof next==='boolean')add(next?4:5);
  else if(typeof next==='number'){if(!Number.isFinite(next))throw new Error('History JSON number unsupported');add(JSON.stringify(next).length);}
  else if(typeof next==='object'){
   const value=next as object,prototype=Object.getPrototypeOf(value);
   if(live.has(value)||Object.getOwnPropertySymbols(value).length||prototype!==(Array.isArray(value)?Array.prototype:Object.prototype)&&prototype!==null)throw new Error('History JSON object unsupported');
   // JSON.stringify resolves toJSON even when it is hidden/non-enumerable.
   // Inspect descriptors without invoking a getter, including the accepted
   // standard prototypes. An inert JSON field named toJSON remains ordinary data.
   for(let target:object|null=value;target;target=Object.getPrototypeOf(target)){
    const hook=Object.getOwnPropertyDescriptor(target,'toJSON');
    if(hook){if(!('value'in hook)||typeof hook.value==='function')throw new Error('History JSON conversion hook unsupported');break;}
   }
   add(2);live.add(value);stack.push({value,iterator:children(value as Record<string,unknown>)});
  }else throw new Error('History JSON value unsupported');
  hasNext=false;while(stack.length){const top=stack[stack.length-1],item=top.iterator.next();if(!item.done){next=item.value;hasNext=true;break;}live.delete(top.value);stack.pop();}
 }
 return bytes;
}
