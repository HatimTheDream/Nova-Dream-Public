import test from 'node:test';
import assert from 'node:assert/strict';
import {request as requestHttp} from 'node:http';
import {BrowserNetwork,browserTarget} from '../apps/service/browser-network.js';

test('browser network resolves once and pins only public IPv4 endpoints on web ports',async()=>{
  let lookups=0;assert.deepEqual(await browserTarget('example.com',443,async()=>{lookups++;return ['93.184.216.34'];}),{host:'93.184.216.34',port:443,family:4});assert.equal(lookups,1);
  for(const address of ['127.0.0.1','10.0.0.1','100.100.100.100','169.254.169.254','192.168.1.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1'])await assert.rejects(browserTarget(address,443),/Non-public/);
  await assert.rejects(browserTarget('mixed.example',443,async()=>['93.184.216.34','127.0.0.1']),/Non-public/);
  await assert.rejects(browserTarget('example.com',22),/Unsupported/);
  await assert.rejects(browserTarget('rebound.example',443,async()=>['169.254.169.254']),/Non-public/);
});
test('the actual proxy denies loopback HTTP and CONNECT requests and closes its owned listener',async()=>{
  const proxy=new BrowserNetwork(),origin=await proxy.start(),target=new URL(origin);
  try{
    proxy.enable(true);assert.equal(await proxy.start(),origin);
    for(const path of ['http://127.0.0.1/','http://2130706433/','http://[::1]/','http://169.254.169.254/latest/meta-data/']){
      const status=await new Promise<number>((ok,no)=>{const r=requestHttp({hostname:target.hostname,port:target.port,path},response=>{response.resume();ok(response.statusCode!);});r.on('error',no);r.end();});assert.equal(status,403,path);
    }
    const tunnel=await new Promise<number>((ok,no)=>{const r=requestHttp({hostname:target.hostname,port:target.port,method:'CONNECT',path:'127.0.0.1:443'});r.on('connect',(response,socket)=>{socket.destroy();ok(response.statusCode!);});r.on('error',no);r.end();});assert.equal(tunnel,403);
  }finally{await proxy.close();}
  await assert.rejects(fetch(origin,{signal:AbortSignal.timeout(1000)}));
});
