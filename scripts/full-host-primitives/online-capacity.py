"""Measured online projection through unchanged recovery primitives.

No snapshot, stop, lease or cleanup. The installer still owns current stopped
and post-start admission; no projected reclaim or dependency reuse is credited.
"""
import base64,hashlib,json,os,pathlib,re,signal,time
P=pathlib.Path
def need(v,r):
 if not v:raise RuntimeError(r)

def runtime_allocation(runtime,facts,live,workspace,volume,fragment,installer):
 """Conservative online projection, never runtime qualification or admission.

 The maintained installer measures only selected native DBs plus WAL. This
 online projection charges every workspace SQLite DB/WAL logical byte twice,
 including dormant workspaces and embedded stores, without opening SQLite.
 No retained runtime/dependency allocation credit is assumed.
 """
 if runtime is None:return None
 need(isinstance(runtime,dict) and set(runtime)=={'format','fromVersion','toVersion','archiveBytes','archiveSha256','expandedBytes','fileCount','nodeVersion','nodeSha256','companion'},'exact-runtime-capacity-description')
 need(runtime['format']==1 and runtime['fromVersion']=='2026.9.6' and runtime['toVersion']=='2026.9.8'
  and facts['review']['agentVersion']==runtime['fromVersion'] and runtime['nodeVersion']=='24.21.0','runtime-capacity-transition-unsupported')
 need(all(isinstance(runtime[k],str) and re.fullmatch('[a-f0-9]{64}',runtime[k]) for k in ('archiveSha256','nodeSha256')),'runtime-capacity-hash-invalid')
 for name,maximum in [('archiveBytes',installer.RUNTIME_MAXIMUM),('expandedBytes',installer.RUNTIME_EXPANDED_MAXIMUM),('fileCount',100000)]:
  need(type(runtime[name]) is int and 0<runtime[name]<=maximum,'runtime-capacity-dimensions-invalid')
 companion=runtime['companion']
 need(isinstance(companion,dict) and set(companion)=={'pluginVersion','codexVersion','packageLockSha256','binarySha256'}
  and companion['pluginVersion']==runtime['toVersion'] and companion['codexVersion']==installer.RUNTIME_PROFILES[runtime['toVersion']]['codexVersion']
  and all(isinstance(companion[k],str) and re.fullmatch('[a-f0-9]{64}',companion[k]) for k in ('packageLockSha256','binarySha256')),'runtime-capacity-companion-invalid')
 managed=installer.managed_companion_capacity(runtime,runtime['toVersion'])
 need(managed['managedCompanionBytes']>0,'runtime-capacity-managed-profile-required')
 import pwd
 service_home=P(pwd.getpwnam(facts['runnerPaths']['serviceUser']).pw_dir)
 runtime_root=P(facts['hostPaths']['runtimeDirectory'])
 for path in (workspace,volume,service_home,runtime_root):
  need(path.is_absolute() and path.resolve(strict=True)==path and path.is_dir() and not path.is_symlink(),'runtime-capacity-root-missing-or-redirected')
 installer.protected(runtime_root,True)
 native_roots=[];database_bytes=0;database_count=0
 for relative,entry in live.items():
  path=pathlib.PurePosixPath(relative)
  need(not path.is_absolute() and all(p not in ('','..') for p in path.parts),'runtime-capacity-inventory-path-invalid')
  if path.name=='openclaw-runtime':
   need(entry['kind']=='directory','runtime-capacity-native-root-redirected')
   native_roots.append(workspace/P(relative))
  if path.name.endswith(('.sqlite','.sqlite-wal')):
   need(entry['kind']=='file' and type(entry.get('size')) is int and entry['size']>=0,'runtime-capacity-database-size-unavailable')
   database_bytes+=entry['size'];database_count+=1
 need(0<len(native_roots)<=128,'runtime-capacity-native-roots-missing')
 roots=[service_home,service_home/'.npm',runtime_root,P('/var/tmp')]
 for native in native_roots:
  need(native.resolve(strict=True)==native and native.is_dir() and not native.is_symlink(),'runtime-capacity-native-root-redirected')
  # These are the actual maintained migration/companion TMPDIR/project roots.
  # Global /tmp is not used by this route and receives no allocation claim.
  roots.extend((native/'tmp',native/'state'/'npm'/'projects'))
 installer.require_capacity_filesystem(tuple(roots),volume)
 rounded=lambda value:((value+fragment-1)//fragment)*fragment
 archive_bytes=2*rounded(runtime['archiveBytes'])
 expansion_bytes=runtime['expandedBytes']+runtime['fileCount']*max(fragment,4096)
 return {'format':1,'kind':'conservative-runtime-online-projection','fromVersion':runtime['fromVersion'],'toVersion':runtime['toVersion'],
  'archiveSha256':runtime['archiveSha256'],'runtimeArchiveBytes':archive_bytes,'runtimeExpansionBytes':expansion_bytes,
  'nativeMigrationBytes':2*database_bytes,'nativeDatabaseLogicalBytes':database_bytes,'nativeDatabaseFileCount':database_count,
  **managed,'nativeSizingScope':'all-workspace-sqlite-and-wal-logical-bytes','sourceSqliteOpened':False,
  'capacityRoots':[str(p) for p in roots],'temporaryRoots':[str(p/'tmp') for p in native_roots],
  'runtimeReuseCreditBytes':0,'actualTargetStartupQualified':False,'runtimeAdmission':False}

def collect_capacity(request):
 fields={'spec','collectorSource','collectorSha256','application','dependencies','bundleBytes','recoveryEvidence'}
 need(set(request) in (fields,fields|{'runtime'}),'exact-capacity-request')
 source=base64.b64decode(request['collectorSource'],validate=True)
 need(hashlib.sha256(source).hexdigest()==request['collectorSha256'],'fixed-capacity-facts-source')
 namespace={'__name__':'full_capacity_facts'};exec(compile(source,'fixed-full-facts','exec'),namespace)
 facts=namespace['collect'](request['spec']);need(facts['readOnly'] is True and facts['noHostWrites'] is True,'actual-capacity-facts')
 import install,recovery,app_dependencies
 directory=P(request['spec']['helperDirectory'])
 need(all(P(m.__file__).parent==directory for m in (install,recovery,app_dependencies)),'capacity-helper-import-changed')
 host=facts['hostPaths'];runner=facts['runnerPaths'];workspace=P(host['workspaceDirectory']);baseline=P(runner['baselineDirectory'])/'workspace'
 volume=P(runner['recoveryDirectory']);install.protected(P(runner['baselineDirectory']),True,True);install.protected(volume,True,True)
 # Workspace content remains service-owned. Preserve the maintained rehearsal's
 # canonical-root checks; root-only authority applies to the recovery container.
 need(workspace.is_absolute() and workspace.resolve(strict=True)==workspace and workspace.is_dir() and not workspace.is_symlink(),'capacity-live-root-redirected')
 need(baseline.resolve(strict=True)==baseline and baseline.is_dir() and not baseline.is_symlink(),'capacity-baseline-root-redirected')
 need(workspace.stat().st_dev==workspace.parent.stat().st_dev==volume.stat().st_dev,'capacity-live-parent-filesystem-changed')
 need(not workspace.is_relative_to(volume) and not volume.is_relative_to(workspace),'capacity-roots-overlap')
 geometry=os.statvfs(volume);fragment=geometry.f_frsize
 need(type(fragment) is int and 512<=fragment<=65536 and not fragment&(fragment-1),'capacity-allocation-geometry')
 for p in (workspace,baseline,P(host['stateDirectory']),P(host['releaseDirectory']),P(runner['dependencyDirectory']).parent,P('/var/tmp')):
  need(p.stat().st_dev==volume.stat().st_dev,'capacity-filesystem-split-unsupported')
 allocation={};live,live_inodes=recovery.inventory(workspace,allocation=allocation);old,old_inodes=recovery.inventory(baseline)
 accepted=request['recoveryEvidence'];need(set(accepted)=={'path','sha256'} and re.fullmatch('/var/lib/nova-update/operator-maintenance/[a-f0-9-]{36}/rehearsal.json',accepted['path']),'exact-current-rehearsal-evidence')
 evidence_path=P(accepted['path']);install.protected(evidence_path,private=True);need(evidence_path.stat().st_size<=2*1024**2 and namespace['digest'](evidence_path)==accepted['sha256'],'current-rehearsal-evidence-changed')
 evidence=install.read_json(evidence_path,2*1024**2)
 need(evidence['candidateId']==facts['review']['candidateId'] and evidence['workspaceEpoch']==facts['review']['workspaceEpoch'] and evidence['outcome']=='rehearsed' and evidence['sourceRootIdentity']==evidence['returnedRootIdentity'] and evidence.get('manualResumption') is not True,'actual-closed-measurement-required')
 app=request['application'];deps=request['dependencies'];need(set(app)=={'archiveBytes','expandedBytes','fileCount'},'exact-application-dimensions')
 for n in ('archiveBytes','expandedBytes','fileCount'):need(type(app[n]) is int and 0<app[n]<=2*1024**3,'bounded-application-dimensions')
 app_dependencies.validate_description(deps)
 need(type(request['bundleBytes']) is int and 0<request['bundleBytes']<=128*1024**2,'bounded-actual-bundle')
 unit=max(fragment,4096);rounded=lambda n:((n+fragment-1)//fragment)*fragment
 # The qualified 234 prestager conservatively reserves two archive copies,
 # three candidate trees, fresh dependency expansion and bounded metadata.
 artifacts=2*(rounded(request['bundleBytes'])+rounded(deps['archiveBytes']))
 candidate=rounded(app['archiveBytes'])+3*(app['expandedBytes']+app['fileCount']*unit)
 dependency=deps['expandedBytes']+deps['fileCount']*unit
 extra=artifacts+candidate+dependency+2*1024**2+8*fragment
 runtime=runtime_allocation(request.get('runtime'),facts,live,workspace,volume,fragment,install)
 if runtime is not None:extra+=runtime['runtimeArchiveBytes']+runtime['runtimeExpansionBytes']
 sizes=tuple(max(p.stat().st_size,p.stat().st_blocks*512) for p in (P(x) for x in runner['protectedFiles']))
 fresh=os.statvfs(volume);need(fresh.f_frsize==fragment,'capacity-geometry-changed')
 measured=recovery.capacity(live,live_inodes,old,old_inodes,fresh.f_bavail*fragment,extra,allocation=allocation,protected_sizes=sizes)
 closed=evidence['closedAllocatedBytes'];need(type(closed) is int and closed>=0,'actual-closed-allocation-required')
 growth=max(0,measured['independentRestoreBytes']-closed)+recovery.ALLOWANCE
 migration=runtime['nativeMigrationBytes'] if runtime is not None else 0
 managed=runtime['managedCompanionBytes'] if runtime is not None else 0
 required=measured['requiredFreeBytes']+growth+migration+managed;need(measured['freeBytes']>=required,'online-full-lifecycle-capacity-refused')
 # Recheck stable configuration/selection/receipt after the measured inventory.
 need(all(namespace['digest'](P(p))==h for p,h in facts['protectedHashes'].items()) and P(host['appCurrent']).resolve(strict=True)==P(facts['appRoot']) and namespace['digest'](evidence_path)==accepted['sha256'],'capacity-authority-changed')
 return {'format':2 if runtime is not None else 1,'kind':'measured-full-online-capacity','readOnly':True,'hostEffects':False,'observedAtMilliseconds':time.time_ns()//1000000,
  'workspaceEpoch':facts['review']['workspaceEpoch'],'health':facts['health'],'runtime':{'agentVersion':facts['review']['agentVersion']},
  'capacity':{**measured,'lifecycle':'online','startupGrowthAllowanceBytes':growth,'nativeMigrationBytes':migration,'managedCompanionBytes':managed,'requiredFreeBytes':required},
  'sourceCommit':facts['sourceCommit'],'priorCandidateId':facts['review']['candidateId'],'helperHashes':facts['review']['helperHashes'],
  'allocationRoles':{'archives':artifacts,'candidateCode':candidate,'dependencies':dependency,'metadata':2*1024**2+8*fragment,
   **({'runtimeArchives':runtime['runtimeArchiveBytes'],'runtimeExpansion':runtime['runtimeExpansionBytes']} if runtime is not None else {})},
  **({'runtimeProjection':runtime} if runtime is not None else {}),
  'originalClosedEvidence':accepted,'expectedReclaimBytes':0,'dependencyReuseCreditBytes':0,'authoritativeStoppedAdmission':False,
  'stoppedAndPostStartChecksStillRequired':True}
