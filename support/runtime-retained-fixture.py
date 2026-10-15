"""Entirely synthetic in-memory retained-runtime evidence for consumer tests."""
import base64
import copy
import hashlib
import json


def fixture(changes=None):
    changes = changes or {}
    sha = lambda value: hashlib.sha256(value).hexdigest()
    enc = lambda value: (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
    files, roles = {}, {}
    root='/opt/nova-release-tools/synthetic-runtime'
    op='12345678-1234-4234-8234-123456789abc'; epoch='22345678-1234-4234-8234-123456789abc'
    fixture_root=root+'/'+op; evidence=fixture_root+'/evidence'
    def doc(role,value,path=None):
        value=copy.deepcopy(value)
        if role in changes:changes[role](value)
        path=path or root+'/'+role+'.json';raw=enc(value);files[path]=raw
        ref={'path':path,'sha256':sha(raw)};roles[role]=ref;return ref
    def opaque(role,raw,path=None):
        path=path or root+'/'+role;files[path]=raw
        ref={'path':path,'sha256':sha(raw)};roles[role]=ref;return ref
    runner=opaque('producer',b'SYNTHETIC RUNNER BYTES',root+'/fresh-runtime-held.py')
    materializer=sha(b'SYNTHETIC MATERIALIZER')
    names=('install.py','recovery.py','operator_rehearsal.py','app_dependencies.py','codex_log_retention.py','workspace_key.py','verify-session-bindings.mjs')
    helpers={name:sha(name.encode()) for name in names}
    service=b'export const synthetic = true;\n'
    package={'name':'nova-dream-edition-3','version':'8.0.0','edition3':{'schemaVersion':55,'apiVersion':1,'buildVersion':'1.0.800'},'dependencies':{'synthetic':'1.0.0'}}
    candidate={'version':'8.0.0','schemaVersion':55,'apiVersion':1,'artifacts':[{'path':'dist/service/apps/service/main.js','sha256':sha(service)}]}
    target_id=sha(enc(package)+enc(candidate));prior_id=sha(b'SYNTHETIC PRIOR')
    target={'path':'/opt/nova/releases/synthetic-target','candidateId':target_id,'version':'8.0.0'}
    prior={'path':'/opt/nova/releases/synthetic-prior','candidateId':prior_id,'version':'7.0.0'}
    files[target['path']+'/package.json']=enc(package);files[target['path']+'/dist/candidate.json']=enc(candidate)
    files[target['path']+'/dist/service/apps/service/main.js']=service
    app=b'SYNTHETIC APP ARCHIVE';deps=b'SYNTHETIC DEPENDENCIES'
    app_ref=opaque('app',app);dep_ref=opaque('dependencies',deps)
    pair={'format':1,'candidateId':target_id,'priorCandidateId':sha(b'prior accepted9.8'),
          'archiveSha256':sha(app),'archiveBytes':len(app),'applicationDependencies':{'archiveSha256':sha(deps),'archiveBytes':len(deps),'packageLockSha256':sha(b'LOCK'),'dependencyGraphSha256':sha(b'GRAPH')}}
    members={**{name:name.encode() for name in names if name!='operator_rehearsal.py'},'app.tgz':app,'reviewed-pair.json':enc(pair)}
    bundle=doc('bundle',{'format':1,'files':[{'name':name,'data':base64.b64encode(raw).decode(),'sha256':sha(raw)} for name,raw in members.items()]})
    host=doc('host',{'stateDirectory':'/var/lib/nova-updater'})
    stage='/var/lib/nova-updater/staging/'+bundle['sha256']
    old=bundle['path'];bundle={**bundle,'path':stage+'/bundle.json'};files[bundle['path']]=files.pop(old);roles['bundle']=bundle
    job='32345678-1234-4234-8234-123456789abc'
    release={'candidateId':target_id,'fromCandidateId':pair['priorCandidateId'],'novaVersion':'8.0.0','bundle':{'sha256':bundle['sha256']},'applicationDependenciesBundle':{'sha256':dep_ref['sha256'],'bytes':len(deps)}}
    accepted_request=doc('acceptedRequest',{'format':1,'jobId':job,'release':release,'hostConfiguration':host['path'],'expectedPrior':{'candidateId':pair['priorCandidateId'],'workspaceEpoch':epoch}},stage+'/attempts/'+job+'/request.json')
    accepted_result=doc('acceptedResult',{'format':1,'jobId':job,'candidateId':target_id,'priorCandidateId':pair['priorCandidateId'],
         'outcome':'completed','savedWorkVerified':True,'accountsVerified':True,'recoveryVerified':True,'healthVerified':True},stage+'/attempts/'+job+'/result.json')
    helper_spec={'directory':'/opt/nova-release-tools/synthetic-helpers','sha256':helpers}
    node_sha=sha(b'NODE22');native_sha=sha(b'NODE24');prior_node_sha=sha(b'PRIOR NODE')
    source={'format':1,'kind':'accepted-application-for-isolated-runtime-trial','target':target,
       'installation':{'jobId':job,'request':accepted_request,'result':accepted_result},'bundle':bundle,'applicationArchive':app_ref,
       'dependencyArchive':dep_ref,'helpers':helper_spec,'applicationNode':{'path':'/opt/nova/runtime/node/bin/node','sha256':node_sha},'updater':{}}
    source_ref=doc('acceptedSource',source)
    runtime_archive=opaque('runtimeArchive',b'SYNTHETIC RUNTIME')
    runtime={'format':1,'fromVersion':'2026.9.6','toVersion':'2026.9.8','archiveSha256':runtime_archive['sha256'],
             'archiveBytes':17,'expandedBytes':64,'fileCount':1,'nodeVersion':'24.21.0','nodeSha256':native_sha,
             'companion':{'codexVersion':'0.158.0','pluginVersion':'2026.9.8'}}
    runtime_ref=doc('runtime',runtime)
    cache_manifest=doc('cacheManifest',{'files':{'retained-caches/2026.9.8/_cacache/synthetic':{'bytes':1,'sha256':sha(b'x')}},'directories':[]})
    cache_receipt=doc('cacheReceipt',{'verified':True,'SDKExecuted':False,'installedRecordsMaterialized':False,'accountStateMaterialized':False,
                      'productionAdmission':False,'details':{'artifactManifestSha256':cache_manifest['sha256']}})
    technical=doc('technical',{'status':'passed','adapterSha256':runner['sha256'],'producerSha256':materializer,
                             'callContractsReviewed':True,'isolationReviewed':True})
    selected='recovered-workspaces/42345678-1234-4234-8234-123456789abc'
    baseline={'kind':'retained-operator-rehearsal-baseline','sourceAgentVersion':'2026.9.6','sourceApp':prior,'epoch':epoch}
    review={'format':2,'kind':'actual-retained-runtime-transition-qualification','operationId':op,'reviewReceipt':technical,
       'acceptedSourceProof':source_ref,'hostConfiguration':host,'baseline':baseline,'prior':prior,'target':target,'helpers':{**helper_spec,'directory':root+'/copied-qualification-helpers'},'serviceUid':999,
       'runtime':{'agentNodeSha256':native_sha},'transition':{'prior':{'agentNodeSha256':prior_node_sha},'archive':runtime_archive,
       'description':runtime_ref,'cacheReceipt':cache_receipt,'cacheManifest':cache_manifest}}
    review_ref=doc('review',review)
    namespace=lambda n:{'mnt':'mnt:['+str(n)+']','pid':'pid:['+str(n+1)+']','net':'net:['+str(n+2)+']'}
    parents=namespace(100);children=namespace(200)
    scenarios=['target-first-start','target-restart','prior-rollback']
    plan={'format':2,'kind':'actual-retained-runtime-transition-plan','operationId':op,'reviewSha256':review_ref['sha256'],
       'adapterSha256':runner['sha256'],'fixtureDirectory':fixture_root,'parentNamespaces':parents,
       'priorCandidateId':prior_id,'targetCandidateId':target_id,'workspaceEpoch':epoch,'selectedRelative':selected,
       'nodeSha256':node_sha,'helperHashes':helpers,'requiredFreeBytes':100,'observedFreeBytes':1000,'scenarios':scenarios,
       'inputHashes':{r['path']:r['sha256'] for r in (source_ref,runtime_ref,cache_receipt,cache_manifest)}}
    plan_ref=doc('plan',plan)
    intent={'format':2,'kind':'execute-actual-retained-runtime-transition','operationId':op,'reviewSha256':review_ref['sha256'],
       'adapterSha256':runner['sha256'],'plan':plan_ref,'reviewReceiptSha256':technical['sha256'],'fixtureDirectory':fixture_root}
    intent_ref=doc('executionIntent',intent)
    intention=doc('intention',{'intent':intent,'plan':plan,'freshAdmission':{**plan,'observedFreeBytes':999},
       'originalPlanSha256':plan_ref['sha256'],'intentSha256':intent_ref['sha256']},fixture_root+'/intention.json')
    scenario_refs=[];child_scenarios=[]
    for index,scenario in enumerate(scenarios,1):
        folder=evidence+'/attempt-'+str(index);role=lambda name:scenario+'/'+name
        app_spec=prior if scenario=='prior-rollback' else target
        started={'format':1,'kind':'actual-isolated-startup','operationId':op,'attempt':index,'scenario':scenario,
           'candidateId':app_spec['candidateId'],'epoch':epoch,'namespaces':children,'startedAtSeconds':index*100,
           'leaseId':'52345678-1234-4234-8234-123456789abc'}
        started_ref=doc(role('started'),started,folder+'/started.json')
        process={'pid':index*10+1,'startTicks':index*10,'cwd':app_spec['path'],'uid':999,'nodeSha256':node_sha,'namespaces':children}
        process_ref=doc(role('process'),process,folder+'/process.json')
        native={**process,'pid':index*10+2,'cwd':'/var/lib/nova/workspace/'+selected+'/openclaw-runtime',
                'nodeSha256':prior_node_sha if scenario=='prior-rollback' else native_sha}
        ready={'format':1,'candidateId':app_spec['candidateId'],'epoch':epoch,'startedSha256':started_ref['sha256'],
           'processSha256':process_ref['sha256'],'process':process,'nativeProcess':native,'readyAtSeconds':index*100+10,
           'heldReadiness':{'epoch':epoch,'accounts':[],'health':{'status':'ready','candidateId':app_spec['candidateId'],
              'version':app_spec['version'],'schemaVersion':55,'apiVersion':1}}}
        ready_ref=doc(role('ready'),ready,folder+'/ready.json')
        closed_ref=doc(role('closed'),{'format':1,'readySha256':ready_ref['sha256'],'owningServiceFullyStopped':True,
                    'closedAtSeconds':index*100+20},folder+'/closed.json')
        preserved_ref=doc(role('preservation'),{'format':1,'scenario':scenario,'candidateId':app_spec['candidateId'],
                    'savedStoreCount':2,'fullMaintainedNativeVerifier':True,'fullyStopped':True,'closedReceiptSha256':closed_ref['sha256']},folder+'/preservation.json')
        scenario_refs.append({'scenario':scenario,'started':started_ref,'process':process_ref,'ready':ready_ref,'closed':closed_ref,'preservation':preserved_ref})
        child_scenarios.append({'path':'/qualification/evidence/attempt-'+str(index)+'/preservation.json','sha256':preserved_ref['sha256']})
    migration_intent=doc('migrationIntent',{'format':1,'operationId':op,'reviewSha256':review_ref['sha256'],'fromVersion':'2026.9.6','toVersion':'2026.9.8',
                         'runtimeArchiveSha256':runtime_archive['sha256']},evidence+'/migration-intent.json')
    native_receipt=doc('nativeMigrationVerified',{'format':1,'fromVersion':'2026.9.6','toVersion':'2026.9.8','savedWorkVerified':True},evidence+'/attempt-1/native-migration-verified.json')
    migration={'receipt':{'path':'/qualification/evidence/attempt-1/native-migration-verified.json','sha256':native_receipt['sha256']}}
    migration_ref=doc('migrationCompleted',migration,evidence+'/migration-completed.json')
    restore={'format':1,'baseline':'/qualification/recovery/workspace','migratedTrial':'/var/lib/nova/workspace.migrated-trial','restored':'/var/lib/nova/workspace'}
    restoration_intent=doc('restorationIntent',{**restore,'independentOriginalRequired':True},evidence+'/restoration-intent.json')
    restoration=doc('restorationCompleted',{**restore,'independentOriginalRestored':True,'originalInventory':sha(b'baseline'),'restoredInventory':sha(b'baseline')},evidence+'/restoration-completed.json')
    transition={'migrationIntent':migration_intent,'migrationCompleted':migration_ref,'nativeMigrationVerified':native_receipt,
       'nativeMigrationLog':opaque('nativeMigrationLog',b'SYNTHETIC LOG',evidence+'/attempt-1/native-migration.log'),
       'companionInstallLog':opaque('companionInstallLog',b'SYNTHETIC LOG',evidence+'/attempt-1/codex-companion-install.log'),
       'restorationIntent':restoration_intent,'restorationCompleted':restoration}
    scope='retained-96-to-98-startup-restart-restoration'
    child={'format':2,'kind':'actual-retained-runtime-transition-result','operationId':op,'passed':True,'scenarios':child_scenarios,
       'migration':migration,'independentOriginalRestored':True,'fromVersion':'2026.9.6','toVersion':'2026.9.8',
       'qualificationScope':scope,'prior224IdleCompatibility':None,'freshActualSettledCopiedStartup':True,
       'completeMaintainedSavedAndNativeState':True,'sourceSqliteOpened':False,'productionMutation':False,'deliveryQualification':False,
       'freshPostFreezeRehearsalStillRequired':True,'liveAcceptanceStillRequired':True,'reviewSha256':review_ref['sha256'],
       'adapterSha256':runner['sha256'],'parentNamespaces':parents,'childNamespaces':children}
    child_ref=doc('child',child,evidence+'/child-result.json')
    closure=doc('closure',{'format':1,'kind':'rich-held-outside-closure','operationId':op,'childResultSha256':child_ref['sha256'],
       'originalSourceAndProtectedClosuresUnchanged':True,'ownedProcessesAndNamespacesClosed':True,
       'activeOwnedPids':[],'activeNamespaceOwners':[],'activeFixtureOwners':[],'sourceSqliteOpened':False,'productionMutation':False},evidence+'/parent-closure.json')
    parent={'format':2,'kind':'actual-retained-runtime-parent-verification','operationId':op,'passed':True,
       'originalSourceAndProtectedClosuresUnchanged':True,'adapterSha256':runner['sha256'],'reviewSha256':review_ref['sha256'],
       'review':review_ref,'originalPlan':plan_ref,'executionIntent':intent_ref,'technicalReview':technical,'originalIntention':intention,
       'acceptedSourceProof':source_ref,'targetCandidateId':target_id,'priorCandidateId':prior_id,'workspaceEpoch':epoch,
       'selectedRelative':selected,'scenarios':scenario_refs,'fromVersion':'2026.9.6','toVersion':'2026.9.8','migration':migration,
       'transitionEvidence':transition,'independentOriginalRestored':True,'qualificationScope':scope,'prior224IdleCompatibility':None,
       'childResult':child_ref,'childResultSha256':child_ref['sha256'],'outsideClosure':closure,
       'sourceSqliteOpened':False,'productionMutation':False,'deliveryQualification':False}
    parent_ref=doc('parent',parent,evidence+'/parent-verified.json')
    request={'format':1,'kind':'collect-actual-retained-runtime-proof','parent':parent_ref,'producer':runner}
    def read(path,maximum):
        value=files[path]
        if len(value)>maximum:raise RuntimeError('synthetic-read-bound')
        return value
    return {'request':request,'read':read,'files':files,'roles':roles,'runner':runner['sha256'],'materializer':materializer}
