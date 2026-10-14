"""Read-only current rehearsal inputs. Run only from an exact reviewed helper tree.

This does not acquire a lease, capture a snapshot or qualify a baseline. The
unchanged operator --plan freshly verifies the dedup generation; --execute owns
the fresh stopped snapshot and three-start rehearsal.
"""
import argparse,hashlib,json,os,pathlib,re,signal,sys,time,urllib.request,uuid
from types import SimpleNamespace
P=pathlib.Path
PRIOR=None
SOURCE=None
BASE=None

def need(value,message):
 if not value:raise RuntimeError(message)

def digest(path):
 with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def require_closed_operator(status,epoch):
 lease=status.get('lease')
 need(status.get('held') is False and isinstance(lease,dict) and lease.get('phase') in ('released','cancelled') and re.fullmatch('[a-f0-9]{64}',lease.get('candidateId','')) and lease.get('workspaceEpoch')==epoch,'current-idle-historical-lease-required')

def require_current_installation(record):
 need(set(record)=={'format','jobId','candidateId','priorCandidateId','outcome','savedWorkVerified','accountsVerified','recoveryVerified','healthVerified'},'exact-accepted-installer-result-schema')
 need(record['format']==1 and record['jobId']==BASE['priorJobId'] and record['candidateId']==PRIOR and re.fullmatch('[a-f0-9]{64}',record['priorCandidateId']) and record['outcome']=='completed' and all(record[n] is True for n in ('savedWorkVerified','accountsVerified','recoveryVerified','healthVerified')),'actual-current-accepted-installation-required')

def collect(spec):
 global PRIOR,SOURCE,BASE
 BASE=spec['base'];PRIOR=BASE['candidateId'];SOURCE=spec['sourceCommit']
 need(set(BASE)=={'candidateId','priorVersion','priorBuildVersion','agentVersion','priorJobId'} and re.fullmatch('[a-f0-9]{64}',PRIOR) and re.fullmatch('[a-f0-9]{40}',SOURCE),'exact-current-base-required')
 need(sys.platform=='linux' and os.geteuid()==0,'root-linux-required')
 need(set(spec)=={'format','sourceCommit','helperDirectory','helperHashes','hostConfiguration','startupGuardFile','workspaceEpoch','leaseId','acceptedInstallation','base','hostConfigurationSha256'},'exact-facts-spec-required')
 need(spec['format']==2 and spec['sourceCommit']==SOURCE,'exact-source-required')
 for name in ('workspaceEpoch','leaseId'):need(str(uuid.UUID(spec[name]))==spec[name],'canonical-identity-required')
 directory=P(spec['helperDirectory']);need(directory.is_absolute() and directory.resolve(strict=True)==directory,'helper-path-redirected')
 # Check the complete source graph before importing any helper.
 for name,expected in spec['helperHashes'].items():
  need(re.fullmatch(r'[A-Za-z0-9_.-]+',name) and re.fullmatch('[a-f0-9]{64}',expected),'invalid-helper-reference')
  path=directory/name
  for parent in (path,*path.parents):
   st=parent.lstat();need(not parent.is_symlink() and st.st_uid==0 and not st.st_mode&0o022,'unprotected-helper')
  need(path.is_file() and path.stat().st_nlink==1 and path.stat().st_size<=2*1024*1024 and digest(path)==expected,'helper-changed')
 sys.path.insert(0,str(directory));sys.dont_write_bytecode=True
 import install,app_dependencies,operator_rehearsal
 need(set(spec['helperHashes'])==operator_rehearsal.HELPERS,'complete-helper-set-required')
 for module in (install,app_dependencies,operator_rehearsal):need(P(module.__file__).parent==directory,'helper-import-redirected')
 class ReadOnly(operator_rehearsal.Rehearsal):
  def request_failure(self,*args):raise RuntimeError('read-only-status-failed')
 controller=object.__new__(ReadOnly)
 status=controller.operator('status');lease=status.get('lease')
 require_closed_operator(status,spec['workspaceEpoch'])
 accepted=spec['acceptedInstallation']
 need(set(accepted)=={'path','sha256'} and re.fullmatch('/var/lib/nova-update/staging/[a-f0-9]{64}/attempts/'+re.escape(BASE['priorJobId'])+'/result.json',accepted['path']) and re.fullmatch('[a-f0-9]{64}',accepted['sha256']),'exact-accepted-installation-reference-required')
 install.protected(P(accepted['path']),private=True)
 need(P(accepted['path']).stat().st_size<=65536 and digest(P(accepted['path']))==accepted['sha256'],'accepted-installation-receipt-changed')
 require_current_installation(install.read_json(P(accepted['path']),65536))
 host_path=P(spec['hostConfiguration']);runner_path=host_path.with_name('runner.json')
 for path in (host_path,runner_path):install.protected(path,private=True)
 need(digest(host_path)==spec['hostConfigurationSha256'],'host-configuration-changed')
 host=install.read_json(host_path,65536);runner=install.read_json(runner_path,65536)
 current=P(host['stateDirectory'])/'operator-maintenance/current.json';install.protected(current,private=True)
 need(install.read_json(current,8192)==lease,'socket-durable-lease-mismatch')
 prior=install.protected_selector(P(host['appCurrent']),P(host['releaseDirectory']),True)
 manifest=install.candidate(prior,PRIOR,BASE['priorVersion'])
 need(manifest['buildVersion']==BASE['priorBuildVersion'],'prior-build-changed')
 selector=SimpleNamespace(configured_dependencies=P(runner['dependencyDirectory']),dependency_root=P(runner['dependencyDirectory']).parent)
 dependencies=install.Driver.selected_prior_dependencies(selector,prior)
 description=app_dependencies.inspect_retained_dependencies(dependencies)
 for name in runner['protectedFiles']:install.protected(P(name))
 guard_name=spec['startupGuardFile']
 if guard_name is None:
  expected=('ConditionPathIsDirectory='+host['workspaceDirectory']).encode()
  candidates=[name for name in runner['protectedFiles'] if name.endswith('.conf') and P(name).stat().st_size<=65536 and expected in P(name).read_bytes().splitlines()]
  need(len(candidates)==1,'one-explicit-retained-workspace-guard-required');guard_name=candidates[0]
 guard=P(guard_name);need(str(guard) in runner['protectedFiles'],'guard-not-retained')
 operator_rehearsal.loaded_workspace_guard(runner['serviceName'],P(host['workspaceDirectory']))
 baseline=P(runner['baselineDirectory']);install.protected(baseline,True,True)
 baseline_manifest=baseline/('snapshot-manifest.json' if (baseline/'snapshot-manifest.json').exists() else 'linked-snapshot-source.json')
 baseline_receipt=baseline/'snapshot-verified.json'
 for path in (baseline_manifest,baseline_receipt):install.protected(path,private=True)
 need(install.read_json(baseline_receipt)['manifestSha256']==digest(baseline_manifest),'dedup-receipt-mismatch')
 node=P(runner['nodePath']);install.protected(node)
 agent=P(host['agentDirectory']).resolve(strict=True);install.protected(agent,True)
 need(install.read_json(agent/'package.json')['version']==BASE['agentVersion'],'engine-changed')
 origin='http://127.0.0.1:'+str(runner['healthPort']);opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),install.NoRedirect())
 def api(name):
  request=urllib.request.Request(origin+'/api/'+name,headers={'Origin':origin,'X-Edition3-Client':'1'})
  with opener.open(request,timeout=5) as response:
   value=response.read(65537);need(response.status==200 and len(value)<=65536,'bounded-identity-read-failed')
  return json.loads(value)
 health=api('health');context=api('access/context')
 need(health.get('status')=='ready' and health.get('candidateId')==PRIOR and health.get('version')==BASE['priorVersion'] and context.get('workspaceEpoch')==spec['workspaceEpoch'],'current-live-identity-changed')
 artifacts={item['path']:item['sha256'] for item in manifest['artifacts']}
 review={'format':1,'kind':'operator-rehearsal-review','leaseId':spec['leaseId'],'candidateId':PRIOR,'workspaceEpoch':spec['workspaceEpoch'],'novaVersion':BASE['priorVersion'],'agentVersion':BASE['agentVersion'],'hostConfiguration':str(host_path),'baselineDirectory':str(baseline),'baselineManifestSha256':digest(baseline_manifest),'labParent':'/var/lib/nova-operator-rehearsals','startupGuardFile':str(guard),'startupGuardSha256':digest(guard),'startupBarrier':{name:artifacts[name] for name in sorted(install.STARTUP_FILES)},'helperHashes':spec['helperHashes'],'nodeSha256':digest(node),'sourceDependencies':description,'sourceHostHashes':{name:digest(prior/name) for name in ('scripts/host.mjs','scripts/candidate.mjs')}}
 tracked=[P(accepted['path']),host_path,runner_path,current,guard,baseline_manifest,baseline_receipt,node,*[P(name) for name in runner['protectedFiles']]]
 hashes={str(path):digest(path) for path in tracked}
 need(hashes[accepted['path']]==accepted['sha256'],'accepted-installation-changed-during-collection')
 final=controller.operator('status')
 need(final.get('held') is False and final.get('lease')==lease and install.read_json(current,8192)==lease,'idle-lease-changed')
 need(all(digest(P(path))==value for path,value in hashes.items()) and all(digest(directory/name)==value for name,value in spec['helperHashes'].items()) and P(host['appCurrent']).resolve(strict=True)==prior,'inputs-changed')
 return {'format':2,'kind':'current-rehearsal-facts','health':health,'accessContext':context,'base':BASE,'acceptedInstallation':spec['acceptedInstallation'],'historicalClosedLeaseRetained':True,'readOnly':True,'sourceCommit':SOURCE,'observedAtMilliseconds':time.time_ns()//1000000,'operatorStatus':status,'operatorLeaseSha256':hashes[str(current)],'stateDirectory':host['stateDirectory'],'hostPaths':host,'runnerPaths':runner,'appRoot':str(prior),'review':review,'protectedHashes':hashes,'baselineRole':'deduplication-only','baselineInventoryFreshlyVerified':False,'fullMaintainedPlanStillRequired':True,'freshStoppedSnapshotStillRequired':True,'noHostWrites':True}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--spec',type=P,required=True);args=parser.parse_args()
 signal.alarm(600)
 for path in (args.spec,*args.spec.parents):
  st=path.lstat();need(path.resolve(strict=True)==path and st.st_uid==0 and not st.st_mode&0o022,'protected-spec-required')
 need(args.spec.is_file() and args.spec.stat().st_nlink==1 and args.spec.stat().st_size<=65536,'bounded-spec-required');print(json.dumps(collect(json.loads(args.spec.read_bytes()))))
if __name__=='__main__':main()
