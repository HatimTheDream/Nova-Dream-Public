import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,createReadStream,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,statfsSync,writeFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {z} from 'zod';
import type {Installer,InstallerResult} from './update-supervisor.js';
import type {VerifiedUpdateRelease} from './update-feed.js';
import {readUpdateJson,writeUpdateJson} from './update-storage.js';

const maxBundle=128*1024*1024;
const bundleSchema=z.object({format:z.literal(1),files:z.array(z.object({name:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/),data:z.string().max(maxBundle),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(64)}).strict();
const resultIdentity={format:z.literal(1),jobId:z.string().uuid(),candidateId:z.string().regex(/^[a-f0-9]{64}$/),priorCandidateId:z.string().regex(/^[a-f0-9]{64}$/)};
const resultSchema=z.discriminatedUnion('outcome',[
  z.object({...resultIdentity,outcome:z.enum(['completed','restored']),savedWorkVerified:z.literal(true),accountsVerified:z.literal(true),recoveryVerified:z.literal(true),healthVerified:z.literal(true)}).strict(),
  z.object({...resultIdentity,outcome:z.literal('unchanged'),unchangedVerified:z.literal(true),healthVerified:z.literal(true),reason:z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),reasonCode:z.enum(['insufficient_storage','preflight_failed']).optional()}).strict(),
]);
async function hashFile(path:string){const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return hash.digest('hex');}

/** Executes only the fixed install.py entry from a publisher-authenticated,
 * exact-candidate bundle. The reviewed runner owns platform-specific staging,
 * closed snapshots, paired rollback and retained-work acceptance. */
export class ManagedUpdateInstaller implements Installer {
  constructor(private readonly directory:string,private readonly hostConfiguration:string,private readonly python='/usr/bin/python3',private readonly fetch=globalThis.fetch){}
  private folder(release:VerifiedUpdateRelease){
    if(!/^[a-f0-9]{64}$/.test(release.candidateId))throw Error('Invalid update candidate identity.');
    const folder=join(this.directory,release.candidateId);
    if(existsSync(folder)){const info=lstatSync(folder);if(!info.isDirectory()||info.isSymbolicLink())throw Error('An update path needs review.');}
    return folder;
  }
  private async verifiedBundle(release:VerifiedUpdateRelease,path:string){
    if(!existsSync(path))return false;
    const info=lstatSync(path);
    return info.isFile()&&!info.isSymbolicLink()&&info.size===release.bundle.bytes&&await hashFile(path)===release.bundle.sha256;
  }
  private attempt(release:VerifiedUpdateRelease,jobId:string,create=false){
    z.string().uuid().parse(jobId);
    const parent=join(this.folder(release),'attempts'),folder=join(parent,jobId);
    for(const path of [parent,folder]){
      if(create&&!existsSync(path))mkdirSync(path,{mode:0o700});
      if(existsSync(path)){const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('An update attempt path needs review.');}
    }
    return folder;
  }
  async prepare(release:VerifiedUpdateRelease,progress:(received:number,total:number)=>void){
    if(release.bundle.bytes>maxBundle)throw Error('This update package exceeds the supported size.');
    const dir=this.folder(release),download=join(dir,'bundle.json');mkdirSync(dir,{mode:0o700,recursive:true});
    if(await this.verifiedBundle(release,download)){this.extract(release,download);progress(release.bundle.bytes,release.bundle.bytes);return;}
    const space=statfsSync(this.directory);if(Number(space.bavail)*Number(space.bsize)<release.bundle.bytes+128*1024*1024)throw Error('Not enough space to stage this update.');
    // A previous incomplete download stays as evidence. Each fresh attempt uses
    // a separate exclusive temporary file, never overwriting a verified package.
    if(existsSync(download)){const info=lstatSync(download);if(!info.isFile()||info.isSymbolicLink())throw Error('An update path needs review.');renameSync(download,join(dir,'incomplete-'+randomUUID()+'.json'));}
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),10*60*1000);timer.unref();
    let file:Awaited<ReturnType<typeof open>>|undefined;
    try{
      const response=await this.fetch(release.bundle.url,{redirect:'error',credentials:'omit',signal:abort.signal});
      if(response.status!==200||response.redirected||response.url&&response.url!==release.bundle.url||!response.body)throw Error('Could not download the exact reviewed package.');
      const declared=response.headers.get('content-length');if(declared&&Number(declared)!==release.bundle.bytes)throw Error('Update package size changed.');
      file=await open(download,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      const hash=createHash('sha256');let received=0,lastReport=0;
      for await(const part of response.body as unknown as AsyncIterable<Uint8Array>){received+=part.length;if(received>release.bundle.bytes)throw Error('Update package exceeded its verified size.');hash.update(part);await file.writeFile(part);if(Date.now()-lastReport>=250||received===release.bundle.bytes){progress(received,release.bundle.bytes);lastReport=Date.now();}}
      await file.sync();await file.close();file=undefined;
      if(received!==release.bundle.bytes||hash.digest('hex')!==release.bundle.sha256)throw Error('Update package verification failed.');
      this.extract(release,download);
    }finally{clearTimeout(timer);await file?.close();}
  }
  private extract(release:VerifiedUpdateRelease,path:string){
    const bundle=bundleSchema.parse(readUpdateJson(path,maxBundle));
    if(new Set(bundle.files.map(f=>f.name)).size!==bundle.files.length)throw Error('Duplicate update files.');
    if(bundle.files.some(f=>['bundle.json','request.json','result.json','runner.log','attempts'].includes(f.name)))throw Error('Reserved update file.');
    const runner=bundle.files.find(f=>f.name==='install.py');if(!runner||runner.sha256!==release.bundle.runnerSha256)throw Error('The installer does not match its reviewed identity.');
    for(const file of bundle.files){const bytes=Buffer.from(file.data,'base64');if(bytes.toString('base64')!==file.data||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('An update file did not verify.');const dest=join(this.folder(release),file.name);if(existsSync(dest)){const info=lstatSync(dest);if(!info.isFile()||info.isSymbolicLink()||!readFileSync(dest).equals(bytes))throw Error('A staged update file changed.');}else{const fd=openSync(dest,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}}
  }
  async reconcile(release:VerifiedUpdateRelease,jobId:string):Promise<InstallerResult|undefined>{
    const file=join(this.attempt(release,jobId),'result.json');if(!existsSync(file))return;
    const result=resultSchema.parse(readUpdateJson(file,4096));
    if(result.jobId!==jobId||result.candidateId!==release.candidateId||result.priorCandidateId!==release.fromCandidateId)throw Error('Update acceptance does not match its original request.');
    return result.outcome==='unchanged'&&result.reasonCode?{outcome:'unchanged',reasonCode:result.reasonCode}:result.outcome;
  }
  async run(release:VerifiedUpdateRelease,jobId:string,phase:Parameters<Installer['run']>[2]){
    const directory=this.folder(release),runner=join(directory,'install.py');
    const bundle=join(directory,'bundle.json');
    if(!await this.verifiedBundle(release,bundle))throw Error('Update package changed after verification.');
    this.extract(release,bundle);
    const runnerInfo=lstatSync(runner);
    if(!runnerInfo.isFile()||runnerInfo.isSymbolicLink()||await hashFile(runner)!==release.bundle.runnerSha256)throw Error('Installer changed after verification.');
    const attempt=this.attempt(release,jobId,true),request=join(attempt,'request.json');if(existsSync(request))throw Error('The original installation attempt must be reconciled, not repeated.');
    writeUpdateJson(request,{format:1,jobId,release,hostConfiguration:this.hostConfiguration});
    const log=openSync(join(attempt,'runner.log'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {await new Promise<void>((resolve,reject)=>{
      const child=spawn(this.python,[runner,'--request',request],{cwd:directory,stdio:['ignore','pipe',log],shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
      let pending='',reported=0,invalid=false,childError:Error|undefined;
      child.stdout!.on('data',(bytes:Buffer)=>{
        reported+=bytes.length;if(reported>1024*1024){invalid=true;return;}
        try{writeFileSync(log,bytes);}catch{invalid=true;return;}
        pending+=bytes.toString('utf8');let boundary;
        while((boundary=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,boundary);pending=pending.slice(boundary+1);let data;
          try{data=JSON.parse(line);}catch{continue;}
          if(['preparing','installing','restarting','checking'].includes(data?.stage))try{phase(data.stage);}catch{invalid=true;}
        }
      });
      child.on('error',error=>{childError=error;});child.on('close',code=>code===0&&!invalid&&!childError?resolve():reject(childError??Error('The reviewed installer did not finish acceptance.')));
    });}finally{fsyncSync(log);closeSync(log);}
    const outcome=await this.reconcile(release,jobId);if(!outcome)throw Error('The installer did not provide verified acceptance.');return outcome;
  }
}
