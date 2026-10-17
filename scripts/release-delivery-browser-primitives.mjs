/** Small portable browser-worker primitives; no application dependencies. */
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {isAbsolute,dirname,resolve} from 'node:path';
export const canonicalBrowser=value=>JSON.stringify(value,(_key,x)=>x&&typeof x==='object'&&!Array.isArray(x)
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export function readEvidenceFile(ref,{maximum=2*1024**2}={}) {
  if(!isAbsolute(ref?.path??'')||!/^[a-f0-9]{64}$/.test(ref?.sha256??''))throw Error('browser-reference-invalid');
  for(let part=resolve(ref.path);;part=dirname(part)){if(lstatSync(part).isSymbolicLink())throw Error('browser-reference-symlink');if(dirname(part)===part)break;}
  const info=lstatSync(ref.path);if(!info.isFile()||info.size>maximum)throw Error('browser-reference-not-bounded-file');
  const bytes=readFileSync(ref.path);if(sha256(bytes)!==ref.sha256)throw Error('browser-reference-sha256-changed');return bytes;
}
export function writeBrowserOnce(path,value) {
  const bytes=canonicalBrowser(value)+'\n';
  if(existsSync(path)){if(readFileSync(path,'utf8')!==bytes)throw Error('browser-original-file-changed');return;}
  const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}
