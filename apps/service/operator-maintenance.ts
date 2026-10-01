import {createHash} from 'node:crypto';
import {closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import type {UpdateHeartbeat} from './update-host-client.js';
import {guardedUpdatePath,readUpdateJson,writeUpdateJson} from './update-storage.js';

export const operatorMaintenanceSocket='/run/nova-update/operator.sock';
const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const phase=z.enum(['entered','held','stopping','stopped','snapshot','restore','checking','releasing','released','cancelled','failed']);
export const operatorLeaseSchema=z.object({format:z.literal(1),id,candidateId:hash,workspaceEpoch:id,phase,stopMarked:z.boolean(),createdAt:z.number().nonnegative(),updatedAt:z.number().nonnegative(),releaseKind:z.enum(['cancelled','unchanged','rehearsed','aborted']).optional(),proofSha256:hash.optional()}).strict().superRefine((value,context)=>{
  if(value.updatedAt<value.createdAt||(['entered','held','cancelled'].includes(value.phase)&&value.stopMarked)||(['stopping','stopped','snapshot','restore','checking'].includes(value.phase)&&!value.stopMarked)
    ||(['releasing','released','cancelled'].includes(value.phase)&&(!value.releaseKind||value.releaseKind!=='cancelled'&&!value.proofSha256))
    ||value.releaseKind==='cancelled'&&(value.stopMarked||value.proofSha256!==undefined)||value.releaseKind&&value.releaseKind!=='cancelled'&&!value.stopMarked||value.phase==='cancelled'&&value.releaseKind!=='cancelled'||value.phase==='released'&&value.releaseKind==='cancelled')context.addIssue({code:'custom',message:'Invalid operator maintenance state.'});
});
export type OperatorLease=z.infer<typeof operatorLeaseSchema>;
const proofBase={format:z.literal(1),kind:z.literal('operator-maintenance-acceptance'),leaseId:id,candidateId:hash,workspaceEpoch:id,evidenceSha256:hash,priorAcceptanceSha256:hash,returnedAcceptanceSha256:hash,accountsVerified:z.literal(true),healthVerified:z.literal(true)};
const abortProof=z.object({format:z.literal(1),kind:z.literal('operator-maintenance-abort-acceptance'),outcome:z.literal('aborted'),reason:z.literal('verification_failed_before_swap'),leaseId:id,candidateId:hash,workspaceEpoch:id,evidenceSha256:hash,returnedAcceptanceSha256:hash,snapshotManifestSha256:hash,snapshotVerifiedSha256:hash,originalRetained:z.literal(true),noWorkspaceSwap:z.literal(true),closedSnapshotVerified:z.literal(true),accountsVerified:z.literal(true),healthVerified:z.literal(true)}).strict();
export const operatorAcceptanceSchema=z.discriminatedUnion('outcome',[
  z.object({...proofBase,outcome:z.literal('unchanged'),reason:z.literal('insufficient_storage'),unchangedVerified:z.literal(true)}).strict(),
  z.object({...proofBase,outcome:z.literal('rehearsed'),savedWorkVerified:z.literal(true),recoveryVerified:z.literal(true)}).strict(),
  abortProof,
]);
export interface OperatorLeaseStore {
  read():unknown;
  find(id:string):unknown;
  save(lease:OperatorLease):void;
  proof(id:string):{value:unknown;sha256:string};
}
const terminal=(lease:OperatorLease)=>lease.phase==='released'||lease.phase==='cancelled';
export class OperatorMaintenanceError extends Error {}
function reject(message:string):never{throw new OperatorMaintenanceError(message);}

/** Independent operator authority. It never manufactures an installation job,
 * selects a release, or releases a post-stop hold merely because time passed. */
export class OperatorMaintenance {
  private lease?:OperatorLease;
  private heartbeat?:UpdateHeartbeat&{at:number;serial:number};
  private serial=0;
  private releaseAfter=0;
  private authorityUncertain=false;
  constructor(private readonly store:OperatorLeaseStore,private readonly current:()=>string,private readonly assertUpdateIdle:()=>void,private readonly now=Date.now){
    const saved=store.read();if(saved!==undefined)this.lease=operatorLeaseSchema.parse(saved);
    if(this.lease?.phase==='releasing'&&this.lease.releaseKind!=='cancelled')this.checkedProof(this.lease);
  }
  get active(){return this.authorityUncertain||!!this.lease&&!terminal(this.lease);}
  get holdFor(){return this.lease&&!terminal(this.lease)&&this.lease.phase!=='releasing'?this.lease.id:null;}
  private certain(){if(this.authorityUncertain)reject('Operator authority is uncertain. Restart the controller to reconcile its durable record.');}
  private fresh(){const age=this.heartbeat?this.now()-this.heartbeat.at:-1;return age>=0&&age<10000;}
  private matching(){return !!this.lease&&this.current()===this.lease.candidateId&&this.heartbeat?.candidateId===this.lease.candidateId&&this.heartbeat.epoch===this.lease.workspaceEpoch&&this.fresh();}
  private held(){return this.matching()&&this.heartbeat!.heldFor===this.lease!.id&&this.heartbeat!.nativeSuspended&&this.heartbeat!.blockers.length===0;}
  private save(next:OperatorLease){this.certain();operatorLeaseSchema.parse(next);if(this.lease&&next.updatedAt<this.lease.updatedAt)reject('Operator maintenance clock moved backwards.');try{this.store.save(next);}catch(error){this.authorityUncertain=true;throw error;}this.lease=next;}
  private change(patch:Partial<OperatorLease>){this.save({...this.lease!,...patch,updatedAt:this.now()});}
  private owned(leaseId:string){this.certain();id.parse(leaseId);this.assertUpdateIdle();if(!this.lease||this.lease.id!==leaseId)reject('This operator lease is not current.');if(this.current()!==this.lease.candidateId||this.heartbeat&&(this.heartbeat.candidateId!==this.lease.candidateId||this.heartbeat.epoch!==this.lease.workspaceEpoch))reject('The selected candidate or workspace changed.');return this.lease;}
  status(){this.certain();return {format:1,lease:this.lease??null,held:this.held(),freshHeartbeat:this.fresh()};}
  observe(input:UpdateHeartbeat){
    this.certain();
    this.heartbeat={...input,at:this.now(),serial:++this.serial};
    if(!this.active)return;
    let selected=false;try{selected=this.current()===this.lease!.candidateId;}catch{/* An uncertain selector cannot release authority. */}
    if(!selected||input.candidateId!==this.lease!.candidateId||input.epoch!==this.lease!.workspaceEpoch){this.change({phase:'failed'});return;}
    if(this.lease!.phase==='entered'&&this.held())this.change({phase:'held'});
    if(this.lease!.phase==='releasing'&&this.serial>this.releaseAfter&&input.heldFor===null&&!input.nativeSuspended&&input.blockers.length===0){
      if(this.lease!.releaseKind!=='cancelled'){try{this.checkedProof(this.lease!);}catch(error){this.change({phase:'failed'});throw error;}}
      this.change({phase:this.lease!.releaseKind==='cancelled'?'cancelled':'released'});
    }
  }
  enter(value:unknown){
    this.certain();
    const input=z.object({leaseId:id,candidateId:hash,workspaceEpoch:id}).strict().parse(value);this.assertUpdateIdle();
    if(this.lease?.id===input.leaseId){if(this.lease.candidateId!==input.candidateId||this.lease.workspaceEpoch!==input.workspaceEpoch)reject('The original operator identity changed.');return this.status();}
    if(this.active)reject('An operator maintenance lease is already active.');
    if(this.store.find(input.leaseId)!==undefined)reject('A completed operator identity cannot be reused.');
    const beat=this.heartbeat;
    if(!beat||!this.fresh()||this.current()!==input.candidateId||beat.candidateId!==input.candidateId||beat.epoch!==input.workspaceEpoch||beat.heldFor!==null||beat.nativeSuspended||beat.blockers.length)reject('A fresh idle workspace identity is required.');
    this.save({format:1,id:input.leaseId,candidateId:input.candidateId,workspaceEpoch:input.workspaceEpoch,phase:'entered',stopMarked:false,createdAt:this.now(),updatedAt:this.now()});return this.status();
  }
  mark(value:unknown){
    const input=z.object({leaseId:id,phase:z.enum(['stopping','stopped','snapshot','restore','checking'])}).strict().parse(value),lease=this.owned(input.leaseId);
    if(lease.phase===input.phase)return this.status();
    const allowed:Record<string,string[]>={held:['stopping'],stopping:['stopped','checking'],stopped:['snapshot','checking'],snapshot:['restore','checking'],restore:['checking'],failed:lease.stopMarked?['checking']:[]};
    if(!allowed[lease.phase]?.includes(input.phase))reject('Operator maintenance phase cannot be skipped or reversed.');
    if(input.phase==='stopping'&&!this.held())reject('The exact workspace and native process must acknowledge this hold.');
    if(input.phase==='checking'&&!lease.stopMarked)reject('No stopped operation was recorded.');
    this.change({phase:input.phase,stopMarked:true});return this.status();
  }
  cancel(value:unknown){
    const input=z.object({leaseId:id}).strict().parse(value),lease=this.owned(input.leaseId);
    if(lease.releaseKind==='cancelled'&&['releasing','cancelled'].includes(lease.phase))return this.status();
    if(lease.stopMarked||!['entered','held'].includes(lease.phase)||!this.matching())reject('Only an unchanged pre-stop lease can be cancelled.');
    // Desired release is not proof of native release. The app serially resolves
    // any in-flight/ambiguous prepare before reporting a subsequent clear beat.
    this.change({phase:'releasing',releaseKind:'cancelled'});this.releaseAfter=this.serial;return this.status();
  }
  private checkedProof(lease:OperatorLease){
    const saved=this.store.proof(lease.id),proof=operatorAcceptanceSchema.parse(saved.value);
    if(proof.leaseId!==lease.id||proof.candidateId!==lease.candidateId||proof.workspaceEpoch!==lease.workspaceEpoch||lease.proofSha256&&lease.proofSha256!==saved.sha256||lease.releaseKind&&lease.releaseKind!==proof.outcome)reject('Operator acceptance does not match the original lease.');
    return {proof,sha256:saved.sha256};
  }
  release(value:unknown){
    const input=z.object({leaseId:id}).strict().parse(value),lease=this.owned(input.leaseId);
    if(['releasing','released'].includes(lease.phase)&&lease.releaseKind!=='cancelled'){try{this.checkedProof(lease);}catch(error){if(lease.phase==='releasing')this.change({phase:'failed'});throw error;}return this.status();}
    if(lease.phase!=='checking'||!lease.stopMarked||!this.held())reject('A verified returned source and matching native hold are required.');
    const {proof,sha256}=this.checkedProof(lease);
    this.change({phase:'releasing',releaseKind:proof.outcome,proofSha256:sha256});this.releaseAfter=this.serial;return this.status();
  }
}

function privatePath(path:string,directory=false){guardedUpdatePath(path,directory);const info=lstatSync(path);if(!directory&&info.nlink!==1||process.platform!=='win32'&&(info.mode&0o077)!==0)throw Error('Operator evidence must be independently root-private.');}
function present(path:string){try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
/** One atomic current record is authoritative. Completed records are retained
 * before replacement; evidence is read only from the exact lease namespace. */
export class FileOperatorLeaseStore implements OperatorLeaseStore {
  constructor(private readonly directory:string){guardedUpdatePath(dirname(directory),true);mkdirSync(directory,{mode:0o700,recursive:true});privatePath(directory,true);if(process.platform!=='win32'){const parent=openSync(dirname(directory),'r');try{fsyncSync(parent);}finally{closeSync(parent);}}}
  read(){privatePath(this.directory,true);const path=join(this.directory,'current.json');if(!present(path))return;privatePath(path);return readUpdateJson(path,8192);}
  find(leaseId:string){id.parse(leaseId);const current=this.read();if(current&&operatorLeaseSchema.parse(current).id===leaseId)return current;const folder=join(this.directory,leaseId);if(!present(folder))return;privatePath(folder,true);const path=join(folder,'lease.json');if(!present(path))return;privatePath(path);return readUpdateJson(path,8192);}
  save(lease:OperatorLease){
    operatorLeaseSchema.parse(lease);privatePath(this.directory,true);const previous=this.read();
    if(previous){const old=operatorLeaseSchema.parse(previous);if(old.id!==lease.id){if(!terminal(old))throw Error('An operator lease cannot replace active authority.');privatePath(join(this.directory,old.id),true);writeUpdateJson(join(this.directory,old.id,'lease.json'),old);}}
    const folder=join(this.directory,lease.id);mkdirSync(folder,{mode:0o700,recursive:true});privatePath(folder,true);writeUpdateJson(join(this.directory,'current.json'),lease);
  }
  proof(leaseId:string){
    id.parse(leaseId);const folder=join(this.directory,leaseId);privatePath(this.directory,true);privatePath(folder,true);
    const path=join(folder,'acceptance.json');privatePath(path);const info=lstatSync(path);if(info.size>8192)throw Error('Operator acceptance exceeds its bound.');
    const bytes=readFileSync(path),value=operatorAcceptanceSchema.parse(JSON.parse(bytes.toString('utf8')));
    // An aborted rehearsal has no fabricated pre-run acceptance or restoration
    // claim. Its retained closed snapshot and returned source have separate proof.
    const companions:readonly (readonly [string,string,number])[]=value.outcome==='aborted'
      ?[['abort.json',value.evidenceSha256,8*1024*1024],['returned-acceptance.json',value.returnedAcceptanceSha256,1024*1024],['snapshot-manifest.json',value.snapshotManifestSha256,64*1024*1024],['snapshot-verified.json',value.snapshotVerifiedSha256,1024*1024]]
      :[['rehearsal.json',value.evidenceSha256,8*1024*1024],['prior-acceptance.json',value.priorAcceptanceSha256,1024*1024],['returned-acceptance.json',value.returnedAcceptanceSha256,1024*1024]];
    for(const [name,expected,maximum] of companions){const evidence=join(folder,name);privatePath(evidence);if(lstatSync(evidence).size>maximum||createHash('sha256').update(readFileSync(evidence)).digest('hex')!==expected)throw Error('Operator rehearsal evidence changed.');}
    return {value,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
}

/** This handler is attached only to the root-only operator socket. */
export function operatorMaintenanceRequestHandler(operator:OperatorMaintenance){return async(request:IncomingMessage,response:ServerResponse)=>{
  const send=(status:number,value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value));response.writeHead(status,{'Content-Type':'application/json','Content-Length':bytes.length,'Cache-Control':'no-store',Connection:'close'});response.end(bytes);};
  if(request.method!=='POST'||!/^\/v1\/(status|enter|phase|cancel|release)$/.test(request.url??'')||request.headers.origin||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type']??'')){send(400,{message:'Invalid operator request.'});request.resume();return;}
  const declared=request.headers['content-length'];if(declared&&(!/^\d+$/.test(declared)||Number(declared)>8192)){send(413,{message:'Operator request exceeds its bound.'});request.resume();return;}
  try{let size=0;const parts:Buffer[]=[];for await(const part of request){size+=part.length;if(size>8192){send(413,{message:'Operator request exceeds its bound.'});return;}parts.push(part);}const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
    if(request.url==='/v1/status'){z.object({}).strict().parse(input);send(200,operator.status());}
    else send(200,request.url==='/v1/enter'?operator.enter(input):request.url==='/v1/phase'?operator.mark(input):request.url==='/v1/cancel'?operator.cancel(input):operator.release(input));
  }catch(error){send(error instanceof OperatorMaintenanceError||error instanceof z.ZodError?409:500,{message:error instanceof OperatorMaintenanceError?error.message:'Operator maintenance requires review; its saved authority was retained.'});}
};}
