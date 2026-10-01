import {lstatSync} from 'node:fs';
import {request} from 'node:http';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const socket='/run/nova-update/operator.sock';
export function parseOperatorCommand(args){
  const [action,...values]=args,id=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,candidate=/^[a-f0-9]{64}$/;
  if(action==='status'&&!values.length)return {action,body:{}};
  if(action==='enter'&&values.length===3&&id.test(values[0])&&candidate.test(values[1])&&id.test(values[2]))return {action,body:{leaseId:values[0],candidateId:values[1],workspaceEpoch:values[2]}};
  if(action==='phase'&&values.length===2&&id.test(values[0])&&['stopping','stopped','snapshot','restore','checking'].includes(values[1]))return {action,body:{leaseId:values[0],phase:values[1]}};
  if(['cancel','release'].includes(action)&&values.length===1&&id.test(values[0]))return {action,body:{leaseId:values[0]}};
  throw Error('Usage: operator-maintenance.mjs status | enter LEASE_UUID CANDIDATE_SHA256 WORKSPACE_UUID | phase LEASE_UUID PHASE | cancel LEASE_UUID | release LEASE_UUID');
}
export async function operatorMaintenanceRequest(command){
  if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Use the provisioned Linux root operator.');
  const info=lstatSync(socket);if(!info.isSocket()||info.uid!==0||info.gid!==0||(info.mode&0o777)!==0o600)throw Error('Operator socket is not root-private.');
  for(let path=dirname(socket);;path=dirname(path)){const parent=lstatSync(path);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==0||(parent.mode&0o022))throw Error('Operator socket ancestors are not protected.');if(path===dirname(path))break;}
  const checked=parseOperatorCommand(command),bytes=Buffer.from(JSON.stringify(checked.body));
  return await new Promise((accept,reject)=>{
    const req=request({socketPath:socket,path:'/v1/'+checked.action,method:'POST',headers:{'Content-Type':'application/json','Content-Length':bytes.length}},response=>{
      let size=0;const chunks=[];response.on('data',part=>{size+=part.length;if(size>16384){response.destroy(Error('Operator response exceeded its bound.'));return;}chunks.push(part);});response.on('error',reject);
      response.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(response.statusCode!==200)throw Error('Operator request was refused or is uncertain; reconcile the same lease with status.');accept(value);}catch(error){reject(error);}});
    });req.setTimeout(10000,()=>req.destroy(Error('Operator response timed out; reconcile the same lease with status.')));req.on('error',reject);req.end(bytes);
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await operatorMaintenanceRequest(process.argv.slice(2))));}catch(error){console.error(error instanceof Error?error.message:'Operator request failed.');process.exitCode=1;}}
