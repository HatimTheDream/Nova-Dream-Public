/** Early, read-only directory prerequisites. A result never replaces the
 * fresh metadata-stage plan, capacity or rehearsal gates. */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { readEvidenceFile, sha256 } from './release-plan.mjs';
import { releaseTransportSchema, runInstallTransport } from './release-adapters.mjs';

const gaps = new Set(['full-host-stage-parent-missing','full-host-stage-parent-unsafe',
  'full-host-recovery-parent-missing','full-host-recovery-parent-unsafe',
  'full-host-lab-parent-missing','full-host-lab-parent-unsafe','full-host-configuration-unavailable']);
const need=(value,reason)=>{if(!value)throw Error(reason);};
export function buildHostPrerequisiteProgram(options){
  const input={format:1,stageParent:options.stageParent,hostConfiguration:options.hostConfiguration};
  const source=readFileSync(new URL('./full-host-primitives/preflight.py',import.meta.url));
  const payload=Buffer.from(JSON.stringify({input,source:source.toString('base64'),sha256:sha256(source)})).toString('base64');
  return `import base64,hashlib,json,signal\nsignal.alarm(20)\nv=json.loads(base64.b64decode('${payload}',validate=True))\ns=base64.b64decode(v['source'],validate=True)\nassert hashlib.sha256(s).hexdigest()==v['sha256']\nn={'__name__':'full_host_directory_preflight'}\nexec(compile(s,'fixed-full-host-directory-preflight','exec'),n)\nprint(json.dumps(n['collect'](v['input'])))\n`;
}
export async function fullHostPrerequisiteGaps({transport,options,run=runInstallTransport}){
  const target=releaseTransportSchema.parse(JSON.parse(readEvidenceFile(transport,{maximum:65536})));
  readEvidenceFile(target.sshConfig,{maximum:65536});
  let observed;
  try{observed=await run(target,buildHostPrerequisiteProgram(options),{captureDiagnostics:true});}
  catch{return ['full-host-prerequisite-observation-unavailable'];}
  if(observed.uncertain||observed.exitCode!==0||typeof observed.stdout!=='string'||Buffer.byteLength(observed.stdout)>65536)
    return ['full-host-prerequisite-observation-unavailable'];
  let value;try{value=JSON.parse(observed.stdout);}catch{return ['full-host-prerequisite-observation-unavailable'];}
  need(value&&Object.keys(value).sort().join(',')==='capacityAdmitted,directories,format,gaps,hostConfiguration,kind,noHostWrites,passed,readOnly,recoveryAdmitted,stageParent'
    &&value.format===1&&value.kind==='full-host-directory-preflight'&&value.readOnly===true&&value.noHostWrites===true
    &&value.capacityAdmitted===false&&value.recoveryAdmitted===false&&value.stageParent===options.stageParent
    &&isDeepStrictEqual(value.hostConfiguration,options.hostConfiguration)&&Array.isArray(value.gaps)
    &&value.gaps.length<=4&&new Set(value.gaps).size===value.gaps.length&&value.gaps.every(x=>gaps.has(x))
    &&value.passed===(value.gaps.length===0),'full-host-prerequisite-response-changed');
  if(value.passed){
    need(Object.keys(value.directories??{}).sort().join(',')==='lab-parent,recovery-parent,stage-parent'
      &&value.directories['stage-parent'].path===options.stageParent&&value.directories['lab-parent'].path==='/var/lib/nova-operator-rehearsals','full-host-prerequisite-directories-changed');
    for(const record of Object.values(value.directories))need(record&&Object.keys(record).sort().join(',')==='dev,gid,ino,mode,path,uid'
      &&typeof record.path==='string'&&record.path.startsWith('/')&&record.path.length<=4096&&!record.path.split('/').some(x=>x==='.'||x==='..')
      &&['dev','ino','mode','uid','gid'].every(x=>Number.isSafeInteger(record[x])&&record[x]>=0)&&record.uid===0
      &&(record.mode&0o170000)===0o040000&&(record.mode&0o022)===0,'full-host-prerequisite-directory-identity-changed');
  }
  return value.gaps;
}
