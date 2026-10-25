import {createHash} from 'node:crypto';
import {lstatSync,openSync,fstatSync,readSync,closeSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {withWorkerPlugin} from './worker-runtime-config.js';

export type FeedRuntimeFiles={root:string;serviceDirectory:string;entry:string;epoch:string;version:string};
/** Feed uses the existing tools-disabled assignment RPC. This identity binds
 * its installed code and policy; it is not a global idle or retained-startup
 * receipt. Candidate-wide retained-startup qualification remains separate. */
export function feedRuntimeFingerprint(input:FeedRuntimeFiles):string{
 const {root,serviceDirectory,entry,epoch,version}=input;
 if(!['2026.9.2','2026.9.6','2026.9.8'].includes(version)||!/^[0-9a-f-]{36}$/i.test(epoch))throw Error('Unsupported Feed runtime identity');
 const hash=createHash('sha256');let total=0;
 const read=(name:string,path:string)=>{
  const before=lstatSync(path);
  if(!before.isFile()||before.isSymbolicLink()||before.size>2*1024*1024||realpathSync(path)!==resolve(path))throw Error('Feed runtime file is unavailable');
  const stamp=(value:typeof before)=>[value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs,value.birthtimeMs];
  total+=before.size;if(total>16*1024*1024)throw Error('Feed runtime files exceed their bound');
  const fd=openSync(path,'r');let bytes:Buffer;
  try{
   const opened=fstatSync(fd);
   if(!opened.isFile()||JSON.stringify(stamp(before))!==JSON.stringify(stamp(opened)))throw Error('Feed runtime file changed before reading');
   // Read at most the admitted size plus one byte, even if another process
   // grows/replaces the file between inspection and reading.
   const buffer=Buffer.alloc(before.size+1);let offset=0;
   while(offset<buffer.length){const count=readSync(fd,buffer,offset,buffer.length-offset,offset);if(!count)break;offset+=count;}
   if(offset!==before.size||JSON.stringify(stamp(before))!==JSON.stringify(stamp(fstatSync(fd))))throw Error('Feed runtime file changed while reading');
   bytes=buffer.subarray(0,offset);
  }finally{closeSync(fd);}
  const after=lstatSync(path);
  if(after.isSymbolicLink()||realpathSync(path)!==resolve(path)||JSON.stringify(stamp(before))!==JSON.stringify(stamp(after)))throw Error('Feed runtime file changed during observation');
  hash.update(name+'\0').update(JSON.stringify(stamp(after))).update('\0').update(bytes).update('\0');return bytes;
 };
 if(read('owner',join(root,'edition3-runtime.identity')).toString()!=='edition3-owned-gateway\n')throw Error('Feed runtime owner changed');
 const config=JSON.parse(read('configuration',join(root,'openclaw.json')).toString());
 const expected=withWorkerPlugin(config,epoch,join(serviceDirectory,'worker-plugin'),join(root,'assignment-receipts'));
 if(!isDeepStrictEqual(expected,config))throw Error('Feed worker configuration or policy changed');
 read('native-entry',entry);
 const pkg=JSON.parse(read('native-package',join(dirname(entry),'package.json')).toString());
 if(pkg.name!=='openclaw'||pkg.version!==version)throw Error('Feed native package identity changed');
 for(const name of ['worker-plugin/index.js','worker-plugin/journal.js','worker-plugin/identity.js',
  'worker-plugin/package.json','worker-plugin/openclaw.plugin.json','worker-runtime-config.js',
  '../../packages/domain/agent-capabilities.js','../../packages/domain/worker.js','../../packages/domain/worker-failure.js'])read(name,join(serviceDirectory,name));
 return hash.update(JSON.stringify({format:1,policy:'feed-tools-disabled-worker',epoch,version,entry:resolve(entry),serviceDirectory:resolve(serviceDirectory)})).digest('hex');
}
