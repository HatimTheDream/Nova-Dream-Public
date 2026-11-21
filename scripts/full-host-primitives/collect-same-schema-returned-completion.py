"""Read the native same-schema return where capture recording was inactive."""
import re

SAME_SCHEMA = {'format': 1, 'kind': 'schema-60-same-runtime', 'schemaVersion': 60,
               'apiVersion': 1, 'agentVersion': '2026.9.8'}
RETIRED_OWNER = 'f9b7a02201bbcec6133d5d043ba09d189aec76517b4db7e337696cd16d40db9b'


def ordinary_return_source(output, values, detail):
    lease = values['leaseId']
    review_reference, review = returned_file(Path(values['stage'])/'operator-review.json', 1024*1024)
    returned_check(review_reference['sha256'] == values['files']['operator-review.json'] == detail['reviewSha256']
                   and review['helperHashes'] == values['stageResult']['helperHashes'] == RETAINED_CAPTURE_HELPERS
                   and review['leaseId'] == lease and review['candidateId'] == values['candidateId']
                   and review['workspaceEpoch'] == values['workspaceEpoch'] and review['novaVersion'] == '2.28.50'
                   and review['agentVersion'] == SAME_SCHEMA['agentVersion'] and 'applicationTransition' not in review
                   and json.dumps(review['sameSchemaQualification'],sort_keys=True) == json.dumps(SAME_SCHEMA,sort_keys=True),
                   'Original same-schema prior review required.')
    returned_check('nativeCaptureSourceSha256' not in detail
                   and not any(os.path.lexists(p) for p in (
                       Path(values['stateDirectory'])/'operator-maintenance'/lease/'native-capture-source.json',
                       output/'returned-original-capture.json', output/'held-prior-native-capture.json')),
                   'Capture-bearing source requires its own complete proof.')
    prior_ref, prior = returned_file(output/'same-schema-prior-source.json', 65536)
    snapshot = Path('/var/lib/nova-update-recovery')/('operator-rehearsal-'+lease)
    source = snapshot/'workspace'
    protected(snapshot, directory=True, private=True)
    identity = source.lstat()
    returned_check(source.resolve(strict=True) == source and stat.S_ISDIR(identity.st_mode)
                   and prior['format'] == 1 and prior['kind'] == 'same-schema-closed-prior-source'
                   and prior['workspaceEpoch'] == values['workspaceEpoch'] and prior['candidateId'] == values['candidateId']
                   and prior['sourceClosed'] is True and prior['sourceRoot'] == str(source)
                   and prior['sourceIdentity'] == [identity.st_dev,identity.st_ino], 'Unexpected stopped prior source.')
    manifest_ref, manifest = returned_file(snapshot/'snapshot-manifest.json', 64*1024*1024)
    returned_check(manifest_ref['sha256'] == detail['snapshotManifestSha256'] == prior['manifestSha256'],
                   'Original stopped manifest changed.')
    config = prior['configuration']
    relative = Path(config['path']).relative_to(source)
    returned_check('..' not in relative.parts and relative.parts[-2:] == ('openclaw-runtime','openclaw.json')
                   and manifest[str(relative)]['kind'] == 'file' and manifest[str(relative)]['size'] == config['bytes']
                   and manifest[str(relative)]['sha256'] == config['sha256'], 'Selected stopped configuration differs.')
    prefix = str(relative.parent/'state/tmp/plugin-captures') + '/'
    owners = {}
    for name, item in manifest.items():
        if not name.startswith(prefix):
            continue
        relative_role = name[len(prefix):].split('/')
        if len(relative_role) == 2 and relative_role[1].startswith('owner.sqlite'):
            returned_check(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', relative_role[0])
                           and relative_role[1] == 'owner.sqlite' and item['kind'] == 'file'
                           and item['size'] == 4096 and item['sha256'] == RETIRED_OWNER,
                           'Capture owner is staged, changed or has a sidecar.')
            owners[relative_role[0]] = item['sha256']
    returned_check(len(owners) == 2, 'Expected the two retired source tokens.')
    return prior_ref


def ordinary_attempt(attempt, rows, docs, values, budget):
    prefix = 'startup-'+str(attempt)+'-'
    def row(role):
        return rows[prefix+role+'.json']['sha256']
    def doc(role):
        return docs[prefix+role+'.json']
    capacity = doc('capacity')
    stable = {key:value for key,value in budget.items() if key != 'receiptSha256'}
    returned_check(row('capacity') == budget['receiptSha256'] and budget['attempt'] == attempt
                   and json.dumps(capacity,sort_keys=True) == json.dumps(stable,sort_keys=True),
                   'Settled capacity differs from the accepted proof.')
    started, fork, process, ready = [doc(key) for key in ('started','fork-observed','process','ready')]
    common = {'format':1, 'jobId':values['leaseId'], 'attempt':attempt}
    returned_check(all(all(type(value.get(k)) is type(v) and value[k] == v for k,v in common.items())
                       for value in (started,fork,process,ready)), 'Startup attempt owner differs.')
    returned_check(started['candidateId'] == values['candidateId'] and started['epoch'] == values['workspaceEpoch']
                   and started['agentVersion'] == SAME_SCHEMA['agentVersion'] and bool(started['service'])
                   and fork['startedReceiptSha256'] == row('started') and process['bindingReceiptSha256'] == row('fork-observed')
                   and process['processBinding'] == {'invocationId':fork['invocationId'], 'process':fork['process']}
                   and process['process'] == fork['process'] and bool(re.fullmatch('[0-9a-f]{32}',fork['invocationId']))
                   and type(fork['process']['pid']) is int and fork['process']['pid'] > 0
                   and fork['process']['startTicks'] >= started['notBeforeTicks']
                   and started['startedAtSeconds'] <= fork['observedAtSeconds'] <= ready['readyAtSeconds']
                   and all(process.get(k) == v for k,v in started.items())
                   and all(ready.get(k) == v for k,v in process.items()) and ready['processReceiptSha256'] == row('process'),
                   'Original startup process lineage differs.')
    if attempt < 3:
        closed = doc('closed')
        returned_check(all(closed.get(k) == v for k,v in ready.items())
                       and closed['readyReceiptSha256'] == row('ready') and closed['owningServiceFullyStopped'] is True
                       and closed['closedAtSeconds'] >= ready['readyAtSeconds'], 'Original stop lineage differs.')
    return fork['invocationId']


def ordinary_return_roster(output, values, detail, expected):
    returned_check(output == Path('/var/lib/nova-operator-rehearsals')/('rehearsal-'+values['leaseId']),
                   'Unexpected returned proof directory.')
    protected(output, directory=True, private=True)
    original = returned_stat(output.stat())
    prior_ref = ordinary_return_source(output, values, detail)
    names = {f'startup-{attempt}-{role}.json' for attempt in (1,2,3)
             for role in ('capacity','fork-observed','started','process','ready','closed')
             if not (attempt == 3 and role == 'closed')}
    def roster():
        with os.scandir(output) as entries:
            return {e.name for e in entries if e.name.startswith('startup-') and e.name.endswith('.json')}
    returned_check(roster() == names and (expected is None or set(expected) == names),
                   'Same-schema startup membership differs.')
    docs, rows, total = {}, {}, 0
    for name in sorted(names):
        item, docs[name] = returned_file(output/name, min(65536,1024*1024-total))
        returned_check(expected is None or (type(expected[name]['bytes']) is int and expected[name] == item),
                       'Planned same-schema startup receipt changed.')
        rows[name] = item
        total += item['bytes']
    budgets = detail['startupCapacityBudgets']
    returned_check([x['attempt'] for x in budgets] == [1,2,3], 'Three real startup budgets required.')
    invocations = [ordinary_attempt(i,rows,docs,values,budgets[i-1]) for i in (1,2,3)]
    returned_check(len(set(invocations)) == 3 and returned_stat(output.stat()) == original and roster() == names
                   and returned_file(output/'same-schema-prior-source.json',65536)[0] == prior_ref,
                   'Original startup receipts changed.')
    return rows
