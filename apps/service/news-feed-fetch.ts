import {Resolver} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpRequest,type ClientRequest,type IncomingMessage,type RequestOptions} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {feedSourceSchema,feedSourceUrl,type FeedSource} from '../../packages/domain/news-feed.js';
import {publicNetworkAddress} from './public-network-address.js';
import {canonicalNewsUrl,NEWS_FEED_BYTES,parseNewsFeed,type ParsedNewsFeed} from './news-feed-parser.js';

type RequestPort=(url:URL,options:RequestOptions,listener:(response:IncomingMessage)=>void)=>ClientRequest;
export type NewsFetchPorts={
 resolve4:(host:string,signal:AbortSignal)=>Promise<string[]>;
 request:RequestPort;
 now:()=>string;
};
const ports:NewsFetchPorts={
 async resolve4(host,signal){
  const resolver=new Resolver({timeout:4000,tries:1}),cancel=()=>resolver.cancel();
  signal.throwIfAborted();signal.addEventListener('abort',cancel,{once:true});
  try{return await resolver.resolve4(host);}finally{signal.removeEventListener('abort',cancel);}
 },
 request:(url,options,listener)=>(url.protocol==='https:'?httpsRequest:httpRequest)(url,options,listener),
 now:()=>new Date().toISOString(),
};
type Response={bytes:Buffer}|{location:string};
const supportedTypes=new Set(['application/rss+xml','application/atom+xml','application/feed+json','application/json','application/xml','text/xml']);

/** Public feeds only, with an overall deadline and a fresh DNS check/pin on
 * every redirect. No account cookies, tokens, article fetches or automatic save.
 * permitted must join the exact current source/profile identity, not just login. */
export async function fetchNewsFeed(source:FeedSource,signal:AbortSignal,permitted:()=>boolean,overrides:Partial<NewsFetchPorts>={}):Promise<ParsedNewsFeed>{
 feedSourceSchema.parse(source);
 const io={...ports,...overrides},bounded=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
 const check=()=>{bounded.throwIfAborted();if(!source.enabled||!permitted())throw Error('This feed source is no longer permitted.');};
 let current=source.url;
 for(let hop=0;hop<=3;hop++){
  check();const valid=canonicalNewsUrl(current);if(!valid||!feedSourceUrl(current))throw Error('Use a supported public feed address.');
  const url=new URL(valid),addresses=isIP(url.hostname)?[url.hostname]:await io.resolve4(url.hostname,bounded);
  check();if(!addresses.length||addresses.some(address=>!publicNetworkAddress(address)))throw Error('The feed resolved to a non-public address.');
  const response=await new Promise<Response>((resolve,reject)=>{
   let settled=false,request:ClientRequest|undefined,incoming:IncomingMessage|undefined;
   const finish=(error?:Error,value?:Response)=>{if(settled)return;settled=true;bounded.removeEventListener('abort',abort);if(error){incoming?.destroy();request?.destroy();reject(error);}else resolve(value!);};
   const abort=()=>finish(Error('Feed request was interrupted or timed out.'));
   bounded.addEventListener('abort',abort,{once:true});
   try{
    check();
    request=io.request(url,{
     method:'GET',agent:false,family:4,signal:bounded,maxHeaderSize:16384,
     lookup:(_host,_options,done)=>done(null,addresses[0],4),
     headers:{Accept:'application/rss+xml,application/atom+xml,application/feed+json,application/json,application/xml,text/xml','Accept-Encoding':'identity','User-Agent':'NovaDream-Feed/1'},
    },message=>{
     incoming=message;
     // Always handle an aborted/error stream, including refused responses.
     message.on('error',error=>finish(error));message.on('aborted',()=>finish(Error('The feed response was incomplete.')));
     try{
      check();
      const status=message.statusCode??0;
      if([301,302,303,307,308].includes(status)&&typeof message.headers.location==='string'){
       const location=message.headers.location;
       if(location.length>2048)throw Error('Feed redirect is too long.');
       finish(undefined,{location});message.destroy();return;
      }
      const type=String(message.headers['content-type']??'').split(';')[0].trim().toLowerCase();
      const length=message.headers['content-length'];
      if(status!==200||!supportedTypes.has(type)||length!==undefined&&(!/^\d+$/u.test(length)||Number(length)>NEWS_FEED_BYTES)
       ||message.headers['content-encoding']&&message.headers['content-encoding']!=='identity')throw Error('This source did not provide a supported bounded feed.');
      let size=0;const chunks:Buffer[]=[];
      message.on('data',(chunk:Buffer)=>{try{check();size+=chunk.length;if(size>NEWS_FEED_BYTES)throw Error('The feed exceeds 2 MB.');chunks.push(chunk);}catch(error){finish(error as Error);}});
      message.on('end',()=>{try{check();if(length!==undefined&&size!==Number(length))throw Error('The feed response was incomplete.');finish(undefined,{bytes:Buffer.concat(chunks)});}catch(error){finish(error as Error);}});
     }catch(error){finish(error as Error);}
    });
    request.on('error',error=>finish(error));request.end();
   }catch(error){finish(error as Error);}
  });
  check();
  if('location'in response){
   const next=new URL(response.location,url);
   if(url.protocol==='https:'&&next.protocol!=='https:')throw Error('The secure feed redirected to an insecure address.');
   current=next.href;continue;
  }
  return parseNewsFeed(source,response.bytes,io.now(),current);
 }
 throw Error('The feed redirected too many times.');
}
