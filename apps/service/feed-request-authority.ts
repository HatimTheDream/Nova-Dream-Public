import type {IncomingMessage} from 'node:http';
import {z} from 'zod';
import {authorizePrivateWeb,type PrivateWebOptions} from './private-web.js';
import {Fault} from './store.js';
import type {FeedAuthenticatedOwner} from './feed-semantic-authority.js';

const denied=()=>new Fault(403,'feed_request_authority','The original workspace access changed. Its request is kept.');
const mode=(value:PrivateWebOptions)=>value.auth??'tailscale';

/** Capture an already authenticated request's proxy proof, never its socket lifetime.
 * The caller must first apply the normal HTTP host/origin/surface/route guards.
 * Current proxy credentials and owner configuration are checked on every use. */
export function captureFeedWebRoute(request:IncomingMessage,current:()=>PrivateWebOptions):()=>void{
 const initial=current();authorizePrivateWeb(request,initial);
 const origin=initial.origin,auth=mode(initial);
 const names=['tailscale-user-login','x-nova-proxy-key','x-nova-public-origin'] as const;
 const headers=Object.freeze(Object.fromEntries(names.flatMap(name=>{
  const value=request.headers[name];return typeof value==='string'?[[name,value]]:[];
 })));
 const captured=Object.freeze({headers,socket:Object.freeze({remoteAddress:request.socket.remoteAddress})});
 return ()=>{
  const value=current();if(value.origin!==origin||mode(value)!==auth)throw denied();
  // Only the fields consumed by the maintained authorizer are captured above.
  authorizePrivateWeb(captured as IncomingMessage,value);
 };
}

type OwnerInput={deviceId:string;epoch:string;token:string;authorizeRoute():void;authenticate(token:string):string;currentEpoch():string};

/** Internal caller factory, not a browser proof format or a serializable lease.
 * Functions must be closures over maintained services, not body-supplied claims. */
export function captureFeedRequestOwner(input:OwnerInput):FeedAuthenticatedOwner{
 const deviceId=z.string().uuid().parse(input.deviceId),epoch=z.string().uuid().parse(input.epoch);
 const token=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(input.token);
 const {authorizeRoute,authenticate,currentEpoch}=input;
 if([authorizeRoute,authenticate,currentEpoch].some(value=>typeof value!=='function'))throw denied();
 const authorize=()=>{
  const route:unknown=authorizeRoute();
  if(route!==undefined||authenticate(token)!==deviceId||currentEpoch()!==epoch)throw denied();
 };
 authorize();return Object.freeze({deviceId,epoch,authorize});
}
