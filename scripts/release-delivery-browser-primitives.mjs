/** Small portable browser-worker primitives; no application dependencies. */
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,fstatSync,readSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {isAbsolute,dirname,resolve} from 'node:path';
export const canonicalBrowser=value=>JSON.stringify(value,(_key,x)=>x&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const sha256=value=>createHash('sha256').update(value).digest('hex');
function referenceInfo(ref,maximum) {
  if(!isAbsolute(ref?.path??'')||!/^[a-f0-9]{64}$/.test(ref?.sha256??''))throw Error('browser-reference-invalid');
  for(let part=resolve(ref.path);;part=dirname(part)){if(lstatSync(part).isSymbolicLink())throw Error('browser-reference-symlink');if(dirname(part)===part)break;}
  const info=lstatSync(ref.path);if(!info.isFile()||info.size>maximum)throw Error('browser-reference-not-bounded-file');
  return info;
}
export function readEvidenceFile(ref,{maximum=2*1024**2}={}) {
  referenceInfo(ref,maximum);
  const bytes=readFileSync(ref.path);if(sha256(bytes)!==ref.sha256)throw Error('browser-reference-sha256-changed');return bytes;
}
/** Binaries can be hundreds of MiB; verify their exact bytes without retaining them. */
export function verifyBrowserTool(ref,{maximum=128*1024**2}={}) {
  const before=referenceInfo(ref,maximum),fd=openSync(ref.path,'r'),digest=createHash('sha256'),chunk=Buffer.allocUnsafe(64*1024);
  const unchanged=info=>info.isFile()&&['dev','ino','size','mtimeMs','ctimeMs'].every(key=>info[key]===before[key]);
  try{
    if(!unchanged(fstatSync(fd)))throw Error('browser-reference-changed-during-read');
    let total=0,count;
    while((count=readSync(fd,chunk,0,chunk.length,null))>0){
      total+=count;if(total>maximum||total>before.size)throw Error('browser-reference-not-bounded-file');
      digest.update(chunk.subarray(0,count));
    }
    if(total!==before.size||!unchanged(fstatSync(fd))||!unchanged(referenceInfo(ref,maximum)))throw Error('browser-reference-changed-during-read');
    if(digest.digest('hex')!==ref.sha256)throw Error('browser-reference-sha256-changed');
    return {path:ref.path,sha256:ref.sha256,bytes:total};
  }finally{closeSync(fd);}
}
export function writeBrowserOnce(path,value) {
  const bytes=canonicalBrowser(value)+'\n';
  if(existsSync(path)){if(readFileSync(path,'utf8')!==bytes)throw Error('browser-original-file-changed');return;}
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}
