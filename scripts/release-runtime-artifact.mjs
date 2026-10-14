/** Bounded runtime-archive verification. Receipts and other roles keep their
 * existing bounds; this never loads the runtime archive into one Buffer. */
import {createHash} from 'node:crypto';
import {constants,lstatSync,realpathSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {isAbsolute,resolve,dirname} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';

export const RUNTIME_ARCHIVE_MAXIMUM=512*1024**2;
const need=(v,r)=>{if(!v)throw Error(r);};
const identity=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs];
const shared=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs];
export function verifyRuntimeArtifact(reference,expectedBytes){
 need(reference&&Object.keys(reference).sort().join(',')==='path,sha256'
  &&isAbsolute(reference.path)&&resolve(reference.path)===reference.path&&/^[a-f0-9]{64}$/.test(reference.sha256),'runtime-artifact-reference-invalid');
 need(Number.isSafeInteger(expectedBytes)&&expectedBytes>0&&expectedBytes<=RUNTIME_ARCHIVE_MAXIMUM,'runtime-artifact-size-bound');
 for(let p=reference.path;;p=dirname(p)){
  const s=lstatSync(p);need(!s.isSymbolicLink()&&(p===reference.path?s.isFile():s.isDirectory()),'runtime-artifact-redirected');
  if(dirname(p)===p)break;
 }
 need(resolve(realpathSync(reference.path))===reference.path,'runtime-artifact-redirected');
 const before=lstatSync(reference.path,{bigint:true});need(before.nlink===1n&&before.size===BigInt(expectedBytes),'runtime-artifact-size-or-link-changed');
 const fd=openSync(reference.path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)),started=performance.now();
 try{
  const opened=fstatSync(fd,{bigint:true});need(same(shared(before),shared(opened)),'runtime-artifact-open-identity-changed');
  const buffer=Buffer.alloc(1024**2),hash=createHash('sha256');let count=0;
  while(true){need(performance.now()-started<=30000,'runtime-artifact-verification-timeout');const n=readSync(fd,buffer,0,buffer.length,null);if(n===0)break;count+=n;need(count<=expectedBytes,'runtime-artifact-grew');hash.update(buffer.subarray(0,n));}
  need(count===expectedBytes&&hash.digest('hex')===reference.sha256,'runtime-artifact-content-changed');
  need(same(identity(opened),identity(fstatSync(fd,{bigint:true})))&&same(identity(before),identity(lstatSync(reference.path,{bigint:true}))),'runtime-artifact-read-identity-changed');
  return{bytes:count,sha256:reference.sha256};
 }finally{closeSync(fd);}
}

export function runtimeTransition(runtime,release){
 need(runtime&&runtime.description&&runtime.archive&&release?.runtimeBundle,'runtime-artifact-signed-description-required');
 const d=runtime.description;
 need(d.format===1&&d.fromVersion==='2026.9.6'&&d.toVersion==='2026.9.8'&&release.agentVersion===d.toVersion
  &&d.nodeVersion==='24.21.0'&&d.companion?.pluginVersion==='2026.9.8'&&d.companion.codexVersion==='0.158.0'
  &&d.archiveSha256===runtime.archive.sha256&&release.runtimeBundle.sha256===d.archiveSha256
  &&release.runtimeBundle.bytes===d.archiveBytes,'runtime-artifact-transition-changed');
 need(Number.isSafeInteger(d.expandedBytes)&&d.expandedBytes>0&&d.expandedBytes<=2*1024**3
  &&Number.isSafeInteger(d.fileCount)&&d.fileCount>0&&d.fileCount<=100000,'runtime-artifact-expansion-bound');
 verifyRuntimeArtifact(runtime.archive,d.archiveBytes);return d;
}
