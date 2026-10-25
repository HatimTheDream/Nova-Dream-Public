import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ClientRequest,IncomingMessage,RequestOptions} from 'node:http';
import {fetchNewsFeed,type NewsFetchPorts} from '../apps/service/news-feed-fetch';
import {canonicalNewsUrl,NEWS_FEED_BYTES} from '../apps/service/news-feed-parser';
import {publicNetworkAddress} from '../apps/service/public-network-address';

const source={id:'source:test',title:'Publisher',url:'https://publisher.example/feed',enabled:true};
const xml='<rss><channel><item><title>Writing</title><link>/story</link><description>Writing in practice.</description></item></channel></rss>';
type Reply={status?:number;headers?:Record<string,string>;body?:string|Buffer;afterRequest?:()=>void};
function fixture(replies:Reply[]=[{}],addresses=['93.184.216.34']){
 const calls:{url:URL;options:RequestOptions}[]=[],dns:string[]=[];
 const io:Partial<NewsFetchPorts>={
  resolve4:async host=>{dns.push(host);return addresses;},now:()=> '2026-10-20T12:00:00.000Z',
  request:(url,options,listener)=>{
   const reply=replies[calls.length]??{};calls.push({url,options});
   const request=new EventEmitter() as ClientRequest;
   request.destroy=()=>request;request.end=(()=>{
    queueMicrotask(()=>{
     const stream=new PassThrough(),message=stream as unknown as IncomingMessage;
     message.statusCode=reply.status??200;message.headers={'content-type':'application/rss+xml',...reply.headers};
     reply.afterRequest?.();listener(message);
     if(!message.destroyed)stream.end(reply.body??xml);
    });return request;
   }) as ClientRequest['end'];return request;
  },
 };return {io,calls,dns};
}
test('public feeds use pinned DNS, original TLS host, bounded GET and no account credentials',async()=>{
 const f=fixture(),result=await fetchNewsFeed(source,new AbortController().signal,()=>true,f.io),call=f.calls[0];
 assert.equal(result.stories.length,1);assert.equal(call.url.hostname,'publisher.example');assert.equal(call.options.agent,false);assert.equal(call.options.method,'GET');
 const headers=call.options.headers as Record<string,string>;assert.equal(headers['Accept-Encoding'],'identity');assert.equal(headers.Authorization,undefined);assert.equal(headers.Cookie,undefined);
 let pinned:unknown;const lookup=call.options.lookup as (host:string,options:unknown,done:(error:unknown,address:string,family:number)=>void)=>void;
 lookup('publisher.example',{},(_error,address,family)=>{pinned={address,family};});assert.deepEqual(pinned,{address:'93.184.216.34',family:4});
});
test('every redirect is re-resolved and checked; secure-to-insecure and private hops stop before dispatch',async()=>{
 const f=fixture([{status:302,headers:{location:'https://cdn.example/feed'}},{}]);
 await fetchNewsFeed(source,new AbortController().signal,()=>true,f.io);assert.deepEqual(f.dns,['publisher.example','cdn.example']);
 for(const location of ['http://publisher.example/feed','https://127.0.0.1/feed','https://169.254.169.254/latest/meta-data','https://user:secret@publisher.example/feed']){
  const f=fixture([{status:302,headers:{location}}]);await assert.rejects(fetchNewsFeed(source,new AbortController().signal,()=>true,f.io));assert.equal(f.calls.length,1);
 }
});
test('all resolved addresses must be public; numeric aliases, IPv6 and local names are refused',async()=>{
 for(const address of ['127.0.0.1','10.0.0.1','100.64.0.1','169.254.169.254','172.31.0.1','192.168.1.1','198.18.0.1','203.0.113.1','224.0.0.1','::1'])assert.equal(publicNetworkAddress(address),false);
 const f=fixture([],['93.184.216.34','127.0.0.1']);await assert.rejects(fetchNewsFeed(source,new AbortController().signal,()=>true,f.io),/non-public/);assert.equal(f.calls.length,0);
 for(const url of ['http://2130706433/a','http://0x7f000001/a','http://[::1]/a','http://router/a','http://host.local/a','http://host.internal/a','http://host.home.arpa/a'])
  assert.equal(canonicalNewsUrl(url),undefined,url);
});
test('permission withdrawal after DNS, after request and after response prevents reading or storing a result',async()=>{
 let allowed=true;const f=fixture();f.io.resolve4=async()=>{allowed=false;return ['93.184.216.34'];};
 await assert.rejects(fetchNewsFeed(source,new AbortController().signal,()=>allowed,f.io),/permitted/);assert.equal(f.calls.length,0);
 allowed=true;const g=fixture([{afterRequest:()=>{allowed=false;}}]);
 await assert.rejects(fetchNewsFeed(source,new AbortController().signal,()=>allowed,g.io),/permitted/);
});
test('unsupported response types, compression, excessive bytes and incomplete lengths preserve a failed fetch',async()=>{
 for(const reply of [
  {status:401},{headers:{'content-type':'text/html'}},{headers:{'content-encoding':'gzip'}},
  {headers:{'content-length':String(NEWS_FEED_BYTES+1)}},{headers:{'content-length':'100000'}},
  {body:Buffer.alloc(NEWS_FEED_BYTES+1)},
 ] as Reply[]){
  const f=fixture([reply]);await assert.rejects(fetchNewsFeed(source,new AbortController().signal,()=>true,f.io));
 }
});
test('disabled, already-aborted and redirect-loop requests are bounded without silently retrying',async()=>{
 const f=fixture();await assert.rejects(fetchNewsFeed({...source,enabled:false},new AbortController().signal,()=>true,f.io));assert.equal(f.calls.length,0);
 const controller=new AbortController();controller.abort();await assert.rejects(fetchNewsFeed(source,controller.signal,()=>true,f.io));assert.equal(f.calls.length,0);
 const g=fixture(Array.from({length:5},()=>({status:302,headers:{location:'/feed'}})));
 await assert.rejects(fetchNewsFeed(source,new AbortController().signal,()=>true,g.io),/too many/);assert.equal(g.calls.length,4);
});
