"""Synthetic original-receipt graph; never production qualification evidence."""
import copy
import hashlib
import json


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def fixture(changes=None):
    changes = changes or {}; files = {}; roles = {}
    op = '11111111-1111-4111-8111-111111111111'; epoch = '22222222-2222-4222-8222-222222222222'
    root = '/fixture/' + op; evidence = root + '/evidence'; target = '/apps/target'; prior = '/apps/prior'
    scope = 'retained-same-runtime-startup-restart-restoration'
    helpers = {n: sha(n.encode()) for n in ('install.py', 'recovery.py', 'operator_rehearsal.py', 'app_dependencies.py', 'codex_log_retention.py', 'workspace_key.py', 'verify-session-bindings.mjs')}
    def put(role, path, value):
        value = copy.deepcopy(value)
        if role in changes: changes[role](value)
        raw = value if isinstance(value, bytes) else encoded(value)
        files[path] = raw; roles[role] = {'path': path, 'sha256': sha(raw)}
        return roles[role]
    def doc(role): return json.loads(files[roles[role]['path']])
    source_files = {n: put('source/' + n, '/sources/' + n, ('# synthetic ' + n).encode()) for n in
                    ('qualified-startup.py', 'qualified-parent.py', 'produce-startup-inputs.py', 'contracts.py')}
    sources = {n: r['sha256'] for n, r in source_files.items()}; roles['producer'] = source_files['qualified-startup.py']
    runner = sources['qualified-startup.py']
    package = put('package', target + '/package.json', {'version': '2.8.1'})
    lock = put('lock', target + '/package-lock.json', {'version': '2.8.1'})
    host = put('host', target + '/scripts/host.mjs', b'// synthetic host')
    service = {p: put(p, target + '/' + p, ('// ' + p).encode())['sha256'] for p in
        ['dist/service/apps/service/' + n for n in ('main.js', 'gateway.js', 'http.js', 'runtime.js', 'software-updates.js', 'store.js', 'update-maintenance.js', 'update-native-idle.js', 'update-native-startup.js')]}
    manifest = put('manifest', target + '/dist/candidate.json', {'version': '2.8.1', 'buildVersion': '1.0.312', 'schemaVersion': 55, 'apiVersion': 1,
        'artifacts': [{'path': p, 'sha256': v} for p, v in service.items()]})
    target_id = sha(files[package['path']] + files[manifest['path']]); prior_id = 'a' * 64
    runtime = {'agentVersion': '2026.9.8', 'agent': '/runtime/openclaw', 'agentNodeSha256': 'b' * 64}
    target_binding = {'candidateId': target_id, 'version': '2.8.1', 'buildVersion': '1.0.312', 'archiveSha256': 'c' * 64,
        'archiveBytes': 123, 'ciSourceSha256': 'd' * 64, 'packageSha256': package['sha256'], 'packageLockSha256': lock['sha256'],
        'candidateManifestSha256': manifest['sha256']}
    binding = {'format': 1, 'kind': 'same-runtime-startup-candidate-binding', 'sourceCommits': {'private': 'a' * 40, 'public': 'b' * 40},
        'prior': {'candidateId': prior_id, 'version': '2.7.11'}, 'targets': {'private': target_binding, 'public': {**target_binding, 'candidateId': 'e' * 64}},
        'serviceArtifacts': service, 'hostEntrypointSha256': host['sha256'], 'dependencyGraphSha256': 'f' * 64,
        'helpers': helpers, 'runtime': runtime, 'workspaceEpoch': epoch}
    if 'binding' in changes: changes['binding'](binding)
    negative_source = put('negativeVerifierSource', '/sources/negative-verifier.py', b'# synthetic negative fixture')
    negative_result = put('negativeVerifierResult', '/sources/negative-verifier.log', b'Synthetic test result; not production qualification')
    technical = put('technical', '/sources/independent-review.json', {'status': 'passed', 'sourceHashes': sources,
        'callContractsReviewed': True, 'isolationReviewed': True, 'heldBootstrapReviewed': True,
        'negativeVerifierEvidence': {'source': negative_source, 'result': negative_result}})
    review = put('review', root + '/review.json', {'format': 1, 'kind': 'actual-retained-startup-qualification', 'operationId': op,
        'reviewReceipt': technical, 'qualificationBinding': binding, 'baseline': {'epoch': epoch, 'manifest': {'path': '/baseline/manifest.json', 'sha256': '3' * 64}},
        'homeSeed': {'inventory': {'path': '/baseline/home-inventory.json', 'sha256': '4' * 64}}, 'runtime': runtime,
        'helpers': {'sha256': helpers}, 'prior': {'path': prior, 'candidateId': prior_id, 'version': '2.7.11'},
        'target': {'path': target, 'candidateId': target_id, 'version': '2.8.1'}, 'serviceUid': 999})
    names = ['target-first-start', 'target-restart', 'pristine-prior-restoration']
    parent_ns = {'mnt': 'mnt:[1]', 'net': 'net:[2]', 'pid': 'pid:[3]'}
    child_ns = {'mnt': 'mnt:[4]', 'net': 'net:[5]', 'pid': 'pid:[6]'}
    selected = 'recovered-workspaces/' + epoch
    plan = put('plan', root + '/plan.json', {'format': 1, 'kind': 'actual-retained-startup-plan', 'operationId': op,
        'reviewSha256': review['sha256'], 'adapterSha256': runner, 'qualificationBinding': binding, 'workspaceEpoch': epoch,
        'helperHashes': helpers, 'nodeSha256': '9' * 64, 'fixtureDirectory': root, 'requiredFreeBytes': 100, 'observedFreeBytes': 200,
        'scenarios': names, 'parentNamespaces': parent_ns, 'selectedRelative': selected})
    intent = put('intent', root + '/intent.json', {'format': 1, 'kind': 'execute-actual-retained-startup', 'operationId': op,
        'adapterSha256': runner, 'reviewSha256': review['sha256'], 'plan': plan, 'reviewReceiptSha256': technical['sha256'], 'fixtureDirectory': root})
    intention = put('intention', root + '/intention.json', {'intent': doc('intent'), 'plan': doc('plan'),
        'originalPlanSha256': plan['sha256'], 'intentSha256': intent['sha256'], 'freshAdmission': {**doc('plan'), 'observedFreeBytes': 190}})
    scenario_refs = []; child_refs = []
    for i, name in enumerate(names, 1):
        folder = evidence + '/attempt-' + str(i); app = doc('review')['prior' if i == 3 else 'target']; lease = str(i) * 8 + '-1111-4111-8111-111111111111'
        started = put(name + '/started', folder + '/started.json', {'format': 1, 'kind': 'actual-isolated-startup', 'operationId': op,
            'attempt': i, 'scenario': name, 'candidateId': app['candidateId'], 'epoch': epoch, 'leaseId': lease,
            'startedAtSeconds': i * 100, 'namespaces': child_ns})
        process = put(name + '/process', folder + '/process.json', {'pid': 10 + i, 'startTicks': 1000 + i,
            'cwd': app['path'], 'uid': 999, 'nodeSha256': '9' * 64, 'namespaces': child_ns})
        ready = put(name + '/ready', folder + '/ready.json', {'candidateId': app['candidateId'], 'epoch': epoch,
            'startedSha256': started['sha256'], 'processSha256': process['sha256'], 'process': doc(name + '/process'), 'readyAtSeconds': i * 100 + 20,
            'heldReadiness': {'epoch': epoch, 'accounts': [], 'health': {'status': 'ready', 'candidateId': app['candidateId'], 'version': app['version'], 'schemaVersion': 55, 'apiVersion': 1}},
            'nativeProcess': {'pid': 20 + i, 'startTicks': 2000 + i, 'uid': 999, 'namespaces': child_ns,
                'cwd': '/var/lib/nova/workspace/' + selected + '/openclaw-runtime', 'nodeSha256': runtime['agentNodeSha256']}})
        closed = put(name + '/closed', folder + '/closed.json', {'readySha256': ready['sha256'], 'owningServiceFullyStopped': True, 'closedAtSeconds': i * 100 + 30})
        preservation = put(name + '/preservation', folder + '/preservation.json', {'scenario': name, 'candidateId': app['candidateId'],
            'fullyStopped': True, 'fullMaintainedNativeVerifier': True, 'closedReceiptSha256': closed['sha256'], 'savedStoreCount': 2})
        controller = {'held': True, 'freshHeartbeat': True, 'lease': {'id': lease, 'phase': 'checking', 'candidateId': app['candidateId'], 'workspaceEpoch': epoch, 'stopMarked': True}}
        before = {**controller, 'held': False, 'freshHeartbeat': False}
        bootstrap = put(name + '/bootstrap', folder + '/bootstrap.json', {'format': 1, 'kind': 'actual-held-bootstrap-observation', 'operationId': op,
            'scenario': name, 'attempt': i, 'candidateId': app['candidateId'], 'leaseId': lease,
            'startedSha256': started['sha256'], 'processSha256': process['sha256'], 'controllerBefore': before, 'controllerAfter': controller,
            'controllerBeforeControl': {'holdFor': lease}, 'controllerBeforeProcessClosure': {'onlyPrivateController': True, 'controllerPid': 30 + i},
            'acceptanceGuard': {'candidateId': app['candidateId'], 'epoch': epoch, 'heldFor': lease, 'maintenanceHeld': True, 'nativeSuspended': True, 'blockers': []},
            'processAuthority': {**doc(name + '/process'), 'updateSocket': '/run/nova-update/control.sock'}, 'networkInterfaces': ['lo'], 'productionMutation': False})
        clock = put(name + '/clock-attribution', folder + '/clock-attribution.json', {'ordinaryNativeWindow': [i * 100, i * 100 + 30],
            'eventHistoryWindow': [100, 130] if i == 2 else [i * 100, i * 100 + 30], 'eventClockAttribution': 'selected-shared-only',
            'windowWidened': False, 'incrementalRestartQualified': False})
        scenario_refs.append({'scenario': name, 'started': started, 'process': process, 'ready': ready, 'closed': closed, 'preservation': preservation, 'bootstrap': bootstrap, 'clock-attribution': clock})
        child_refs.append({'path': '/qualification/evidence/attempt-' + str(i) + '/preservation.json', 'sha256': preservation['sha256']})
    restore_intent = put('restorationIntent', evidence + '/workspace-restoration-intent.json', {'operationId': op,
        'kind': 'restore-independent-pristine-private-state', 'independentOriginalRequired': True, 'productionMutation': False,
        'sourceManifestSha256': '3' * 64, 'sourceHomeInventorySha256': '4' * 64})
    restored = put('restorationCompleted', evidence + '/workspace-restoration-result.json', {'operationId': op,
        'kind': 'independent-pristine-private-restoration-completed', 'passed': True, 'intentSha256': restore_intent['sha256'],
        'targetMutatedStateRetained': True, 'independentlyRestoredPristine': True, 'productionMutation': False,
        'sourceManifestSha256': '3' * 64, 'sourceHomeInventorySha256': '4' * 64, 'independentOriginalRestored': True,
        'independentHomeRestored': True, 'fullPreStartSavedAndNativeEquality': True, 'workspaceInodesDisjoint': True, 'homeInodesDisjoint': True,
        'originalInventorySha256': '1' * 64, 'restoredInventorySha256': '1' * 64, 'originalHomeInventorySha256': '2' * 64, 'restoredHomeInventorySha256': '2' * 64})
    child = put('child', evidence + '/child-result.json', {'format': 1, 'kind': 'actual-retained-startup-result', 'operationId': op,
        'passed': True, 'qualificationScope': scope, 'adapterSha256': runner, 'reviewSha256': review['sha256'], 'qualificationBinding': binding,
        'freshActualSettledCopiedStartup': True, 'completeMaintainedSavedAndNativeState': True, 'independentOriginalRestored': True,
        'sourceSqliteOpened': False, 'productionMutation': False, 'deliveryQualification': False, 'freshPostFreezeRehearsalStillRequired': True,
        'liveAcceptanceStillRequired': True, 'scenarios': child_refs, 'parentNamespaces': parent_ns, 'childNamespaces': child_ns})
    closure = put('closure', evidence + '/outside-closure.json', {'kind': 'rich-held-outside-closure', 'operationId': op,
        'originalSourceAndProtectedClosuresUnchanged': True, 'ownedProcessesAndNamespacesClosed': True, 'sourceSqliteOpened': False,
        'productionMutation': False, 'childResultSha256': child['sha256'], 'activeOwnedPids': [], 'activeNamespaceOwners': [], 'activeFixtureOwners': []})
    worker = {'pid': 55, 'startTicks': 8888, 'controlGroup': '/system.slice/nova-qa-qualified-' + op + '.service'}
    profile = put('effectiveProfile', root + '/qualified-effective-profile.json', {'unit': 'nova-qa-qualified-' + op + '.service',
        'properties': {'MainPID': '55', 'ControlGroup': worker['controlGroup'], 'Type': 'exec', 'Restart': 'no', 'KillMode': 'control-group',
                       'RuntimeMaxUSec': '4200000000', 'TimeoutStopUSec': '60000000'}})
    parent = put('parent', evidence + '/parent-verified.json', {'format': 1, 'kind': 'actual-retained-startup-parent-verification', 'operationId': op,
        'passed': True, 'adapterSha256': runner, 'qualificationScope': scope, 'originalSourceAndProtectedClosuresUnchanged': True,
        'independentOriginalRestored': True, 'sourceSqliteOpened': False, 'productionMutation': False, 'deliveryQualification': False,
        'qualificationBinding': binding, 'sourceFiles': source_files, 'review': review, 'reviewSha256': review['sha256'], 'originalPlan': plan,
        'executionIntent': intent, 'technicalReview': technical, 'originalIntention': intention, 'childResult': child, 'childResultSha256': child['sha256'],
        'outsideClosure': closure, 'restorationIntent': restore_intent, 'restorationCompleted': restored, 'scenarios': scenario_refs,
        'workerIdentity': worker, 'effectiveProfile': profile})
    def read(path, maximum):
        raw = files[path]
        if len(raw) > maximum: raise RuntimeError('synthetic-read-bound')
        return raw
    return {'request': {'format': 1, 'kind': 'collect-actual-retained-startup-proof', 'parent': parent, 'producer': source_files['qualified-startup.py']},
            'sources': sources, 'read': read, 'files': files, 'roles': roles}
