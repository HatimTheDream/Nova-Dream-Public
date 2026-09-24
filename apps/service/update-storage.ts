import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HostUpdateJob, UpdateJournal } from './update-supervisor.js';
import { updateManifestSchema } from './update-feed.js';

export function guardedUpdatePath(path:string, directory:boolean, rootOwned=process.platform==='linux') {
  if(!isAbsolute(path)||resolve(path)!==path)throw Error('Use a canonical update path.');
  let part=path;
  for(;;){const info=lstatSync(part);if(info.isSymbolicLink()||part===path&&(directory?!info.isDirectory():!info.isFile())||rootOwned&&(info.uid!==0||(info.mode&0o022)!==0))throw Error('The update path must be protected and cannot be redirected.');if(part===parse(part).root)break;part=dirname(part);}
}
export function readUpdateJson(path:string,maximum=1024*1024):unknown {
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>maximum)throw Error('Invalid update state.');
  return JSON.parse(readFileSync(path,'utf8'));
}
export function writeUpdateJson(path:string,value:unknown) {
  const temporary=path+'.'+randomUUID(),bytes=Buffer.from(JSON.stringify(value));
  const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);
  if(process.platform!=='win32'){const parent=openSync(dirname(path),'r');try{fsyncSync(parent);}finally{closeSync(parent);}}
}
export const updateJournalLimits=Object.freeze({receipts:2048,bytes:16*1024*1024});
const id=z.string().uuid(),candidate=z.string().regex(/^[a-f0-9]{64}$/);
const release=updateManifestSchema.shape.releases.element.safeExtend({manifestSequence:z.number().int().positive(),manifestExpiresAt:z.number().finite().nonnegative()});
const jobSchema=z.object({
  id,candidateId:candidate,fromCandidateId:candidate,epoch:id,idempotencyKey:id,when:z.enum(['now','idle']),hold:z.boolean(),started:z.boolean(),prepared:z.boolean().optional(),
  state:z.enum(['waiting','downloading','verifying','preparing','installing','restarting','checking','completed','restored','failed','cancelled']),
  requestedAt:z.number().finite().nonnegative(),updatedAt:z.number().finite().nonnegative(),message:z.string().max(1000).optional(),
  download:z.object({received:z.number().int().nonnegative(),total:z.number().int().positive()}).strict().optional(),release,
}).strict().refine(job=>job.candidateId===job.release.candidateId&&job.fromCandidateId===job.release.fromCandidateId,'The saved release identity changed.');
const journalSchema=z.object({format:z.literal(1),currentId:id.nullable(),jobs:z.array(jobSchema).max(updateJournalLimits.receipts)}).strict().superRefine((state,ctx)=>{
  if(new Set(state.jobs.map(job=>job.id)).size!==state.jobs.length||new Set(state.jobs.map(job=>job.idempotencyKey)).size!==state.jobs.length||state.currentId!==null&&!state.jobs.some(job=>job.id===state.currentId)||state.currentId===null&&state.jobs.length)ctx.addIssue({code:'custom',message:'Invalid update receipt references.'});
});
type JournalState=z.infer<typeof journalSchema>;

/** The current job and every receipt commit in one atomic replacement. The
 * journal is bounded and refuses overflow without forgetting old requests. */
export class FileUpdateJournal implements UpdateJournal {
  constructor(private readonly directory:string){mkdirSync(directory,{recursive:true,mode:0o700});}
  private read():JournalState {
    const file=join(this.directory,'journal.json');
    if(existsSync(file))return journalSchema.parse(readUpdateJson(file,updateJournalLimits.bytes));
    if(readdirSync(this.directory).some(name=>name==='current.json'||/^request-.*\.json$/.test(name)||/^[a-f0-9-]{36}\.json$/.test(name)))throw Error('The previous update journal needs reviewed migration.');
    return {format:1,currentId:null,jobs:[]};
  }
  current(){const state=this.read();return state.jobs.find(job=>job.id===state.currentId);}
  find(key:string){id.parse(key);return this.read().jobs.find(job=>job.idempotencyKey===key);}
  save(value:HostUpdateJob){
    const job=jobSchema.parse(value),state=this.read(),prior=state.jobs.find(item=>item.id===job.id);
    if(prior&&(prior.idempotencyKey!==job.idempotencyKey||prior.epoch!==job.epoch||prior.candidateId!==job.candidateId||prior.fromCandidateId!==job.fromCandidateId||prior.when!==job.when||JSON.stringify(prior.release)!==JSON.stringify(job.release)))throw Error('An update receipt cannot change its original identity.');
    const next=journalSchema.parse({format:1,currentId:job.id,jobs:prior?state.jobs.map(item=>item.id===job.id?job:item):[...state.jobs,job]});
    if(Buffer.byteLength(JSON.stringify(next))>updateJournalLimits.bytes)throw Error('The retained update journal is full. Host review is required.');
    writeUpdateJson(join(this.directory,'journal.json'),next);
  }
}
