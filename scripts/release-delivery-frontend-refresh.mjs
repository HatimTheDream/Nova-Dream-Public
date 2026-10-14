/** Fixed genuine app heartbeat immediately before the unchanged executor.
 * This uses the supported authenticated app check; no controller beat is fabricated.
 */
import {readFileSync} from 'node:fs';
import {sha256} from './release-plan.mjs';
export const frontendRefreshSourceSha256='95175c291a101ac2a507e75eadb8a22a3dfaf0a569fbff79672d398eaabd2133';
const need=(v,s)=>{if(!v)throw Error(s);};
export function frontendRefreshBinding(request){const p=request.planInput;return{candidateId:p.baseCandidateId,serviceInputsSha256:p.serviceInputsSha256,epoch:p.workspaceEpoch,processIdentity:p.processIdentity};}
export function buildFrontendFreshExecution(program,request){
 const source=readFileSync(new URL('release-frontend-refresh.py',import.meta.url));need(sha256(source)===frontendRefreshSourceSha256,'frontend-refresh-source-changed');
 const payload=Buffer.from(JSON.stringify({source:source.toString('base64'),sha256:frontendRefreshSourceSha256,binding:frontendRefreshBinding(request)})).toString('base64');
 return `import base64,hashlib,json,sys\n_refresh_payload=json.loads(base64.b64decode('${payload}',validate=True))\n_refresh_source=base64.b64decode(_refresh_payload['source'],validate=True)\nassert hashlib.sha256(_refresh_source).hexdigest()==_refresh_payload['sha256']\n_refresh_scope={'__name__':'frontend_actual_app_refresh'}\nexec(compile(_refresh_source,'fixed-frontend-app-refresh','exec'),_refresh_scope)\n_refresh_result=_refresh_scope['refresh'](_refresh_payload['binding'])\nsys.stderr.write(json.dumps(_refresh_result,separators=(',',':'))+'\\n');sys.stderr.flush()\n`+program;
}
export function frontendRefreshProof(raw,request){
 const lines=String(raw?.stderr??'').split(/\r?\n/),proofs=[];
 for(const line of lines){let v;try{v=JSON.parse(line);}catch{continue;}if(v?.kind==='actual-app-update-check-before-frontend-execute')proofs.push(v);}
 if(proofs.length===0)return null;need(proofs.length===1,'frontend-refresh-proof-ambiguous');
 const v=proofs[0],b=frontendRefreshBinding(request);need(v.format===1&&v.candidateId===b.candidateId&&v.processIdentity===b.processIdentity&&v.epoch===b.epoch&&v.genuineAppHeartbeat===true&&v.directControllerHeartbeat===false&&v.credentialsRecorded===false&&Number.isSafeInteger(v.elapsedMs)&&v.elapsedMs>=0&&v.elapsedMs<=25000&&Number.isSafeInteger(v.afterCheckElapsedMs)&&v.afterCheckElapsedMs>=0&&v.afterCheckElapsedMs<=5000,'frontend-refresh-proof-changed');return v;
}
