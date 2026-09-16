import { Resolver } from 'node:dns/promises';
import { createServer,request as requestHttp,type Server,type IncomingMessage,type IncomingHttpHeaders } from 'node:http';
import { createConnection,isIP,type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { publicImageAddress } from './email-image-fetch.js';

/** The browser sends every HTTP(S) connection through this loopback proxy.
 * Resolve once, reject private/reserved addresses, and dial the approved numeric
 * address. Redirects, frames, service workers and background requests use the
 * same boundary. HTTPS is tunneled unchanged; Chromium still validates TLS. */
export async function browserTarget(host:string,port:number,resolve4:(host:string)=>Promise<string[]>=async host=>new Resolver({timeout:4000,tries:1}).resolve4(host)){
  if(![80,443].includes(port)||host.length>253)throw Error('Unsupported destination');
  const addresses=isIP(host)?[host]:await resolve4(host);
  if(!addresses.length||addresses.some(address=>!publicImageAddress(address)))throw Error('Non-public destination');
  return {host:addresses[0],port,family:4};
}
const blocked='HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
function destination(raw:string,connect=false){
  const url=new URL(connect?'http://'+raw:raw);
  if(url.protocol!=='http:'||url.username||url.password||url.hash||connect&&(url.pathname!=='/'||url.search))throw Error('Unsupported destination');
  return {url,host:url.hostname,port:Number(url.port||(connect?443:80))};
}
function headersOf(request:IncomingMessage,host:string){
  const headers:IncomingHttpHeaders={...request.headers,host};
  for(const name of ['connection','proxy-connection','proxy-authorization','proxy-authenticate','keep-alive','upgrade',...String(request.headers.connection??'').toLowerCase().split(',').map(v=>v.trim())])delete headers[name];
  return headers;
}
export class BrowserNetwork {
  private server?:Server;
  private starting?:Promise<string>;
  private sockets=new Set<Duplex>();
  private stopped=true;
  private permitted=false;
  enable(value:boolean){this.permitted=value;if(!value)for(const socket of this.sockets)socket.destroy();}
  private address?:string;
  private track(socket:Duplex){
    if(this.stopped||!this.permitted||this.sockets.size>=192){socket.destroy();return false;}
    this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});
    if('setTimeout'in socket)(socket as Socket).setTimeout(120000,()=>socket.destroy());
    let bytes=0;socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>64*1024*1024)socket.destroy();});return true;
  }
  async start():Promise<string>{
    if(this.address)return this.address;if(this.starting)return this.starting;
    this.stopped=false;
    this.starting=(async()=>{
      const server=createServer({maxHeaderSize:16384,headersTimeout:10000,requestTimeout:120000},(request,response)=>{
        void (async()=>{
          try{
            const {url,host,port}=destination(request.url??'');const pinned=await browserTarget(host,port);
            if(this.stopped||!this.permitted||request.destroyed){response.destroy();return;}
            const upstream=requestHttp({hostname:pinned.host,port,path:url.pathname+url.search,method:request.method,headers:headersOf(request,url.host),agent:false,family:4,timeout:30000},incoming=>{response.writeHead(incoming.statusCode??502,incoming.headers);incoming.pipe(response);});
            upstream.on('socket',socket=>this.track(socket));upstream.once('timeout',()=>upstream.destroy());
            upstream.once('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});response.once('close',()=>upstream.destroy());request.pipe(upstream);
          }catch{response.writeHead(403,{'Content-Type':'text/plain','Cache-Control':'no-store'});response.end('Only public websites on ports 80 and 443 are available.');}
        })();
      });
      this.server=server;server.on('connection',socket=>this.track(socket));server.on('clientError',(_error,socket)=>socket.destroy());
      server.on('connect',(request,client,head)=>{
        void (async()=>{try{
          const {host,port}=destination(request.url??'',true),pinned=await browserTarget(host,port);
          if(this.stopped||!this.permitted||client.destroyed){client.destroy();return;}
          const upstream=createConnection(pinned);if(!this.track(upstream)){client.destroy();return;}
          upstream.once('connect',()=>{if(client.destroyed){upstream.destroy();return;}client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
          upstream.once('error',()=>client.destroy());upstream.once('close',()=>client.destroy());client.once('close',()=>upstream.destroy());
        }catch{if(!client.destroyed)client.end(blocked);}})();
      });
      await new Promise<void>((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{server.off('error',no);ok();});});
      const address=server.address();if(!address||typeof address==='string')throw Error('Browser network unavailable');
      this.address=`http://127.0.0.1:${address.port}`;return this.address;
    })().finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  async close(){this.stopped=true;await this.starting?.catch(()=>{});this.address=undefined;for(const socket of this.sockets)socket.destroy();if(this.server?.listening)await new Promise<void>(ok=>this.server!.close(()=>ok()));this.server=undefined;}
}
