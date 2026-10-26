"""Local Windows retained startup/restoration, admitted by a separate exact intent.

No actions occur on import. Planning never opens a database or starts a host.
The original Node host remains owned on a pending close; no timeout kills it.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid

RUNNER = Path(__file__).resolve().parents[1] / 'deploy/update-runner'
sys.path.insert(0, str(RUNNER))
import recovery
import local_windows_capture as capture
import local_windows_failure_evidence as failure_evidence


def need(value, message):
    if not value:
        raise RuntimeError(message)


def qualification_return_reserve(ready_timeout_ms, total_timeout_ms, max_report_bytes):
    """Select finite admission timing without changing an existing deadline."""
    enlarged = type(max_report_bytes) is int and max_report_bytes == capture.MAX_REPORT_BYTES
    upper = 3600000 if enlarged else 1800000
    minimum = max(1800000, ready_timeout_ms + 60000 + 900000) if enlarged and type(ready_timeout_ms) is int else 0
    need(type(ready_timeout_ms) is int and 1000 <= ready_timeout_ms <= 300000
         and type(total_timeout_ms) is int
         and max(ready_timeout_ms + 60000, minimum) <= total_timeout_ms <= upper,
         'Finite original readiness and qualification budgets required')
    return 900 if enlarged else min(300, total_timeout_ms / 3000)


def json_read(path, maximum=16*1024*1024):
    path = Path(path)
    row = path.lstat()
    need(path.is_file() and not path.is_symlink() and row.st_size <= maximum, 'Bounded ordinary JSON input required')
    raw = path.read_bytes()
    need(len(raw) == row.st_size, 'JSON input changed')
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def save(path, value):
    data = (json.dumps(value, ensure_ascii=True, allow_nan=False)+'\n').encode('ascii')
    need(len(data) <= capture.MAX_REPORT_BYTES, 'Evidence record exceeded bound')
    with Path(path).open('xb') as stream:
        need(stream.write(data) == len(data), 'Short evidence write')
        stream.flush(); os.fsync(stream.fileno())


def error_record(error):
    return {'type':type(error).__name__,'message':str(error)[:4096],
            'errno':getattr(error,'errno',None),'winerror':getattr(error,'winerror',None),
            'observations':getattr(error,'observations',None)}


def refs_check(refs):
    need(type(refs) is list and 0 < len(refs) <= 100000, 'Bounded exact source references required')
    paths = set(); total=0
    for ref in refs:
        need(type(ref) is dict and set(ref) == {'path','sha256','bytes'}, 'Closed source reference required')
        path = Path(ref['path'])
        need(path.is_absolute() and path not in paths and path.is_file() and not path.is_symlink(), 'Ordinary unique source required')
        paths.add(path)
        need(type(ref['bytes']) is int and 0 <= ref['bytes'] <= 256*1024*1024
             and path.stat().st_size == ref['bytes'] and recovery.digest(path) == ref['sha256'], 'Exact source input changed')
        total+=ref['bytes'];need(total <= 2*1024**3,'Aggregate source read bound exceeded')
    return paths


PATH_FIELDS = ('sourceRoot','workingRoot','parkedRoot','preservedRoot','captureRoot','evidenceRoot','releaseRoot','vendorRoot','node')
INPUT_FIELDS = {'format','kind','operationId',*PATH_FIELDS,'retiredPids','limits','readyTimeoutMs',
                'totalTimeoutMs','candidate','sourceRefs','sourceReview','runtimeEvidence','appManifest','failureEvidence'}


def failure_evidence_configuration(value, ledger=None):
    """Bind one finite ledger across the complete outer/inner Python operation."""
    spec=value['failureEvidence']
    need(type(spec) is dict and set(spec) == {'root','maximumBytes','segmentBytes','primaryRecordBytes','emergencyBytes','portErrorReserveBytes'},
         'Closed shared failure-evidence configuration required')
    constants={'maximumBytes':failure_evidence.MAX_FAILURE_EVIDENCE_BYTES,
               'segmentBytes':failure_evidence.SEGMENT_BYTES,
               'primaryRecordBytes':failure_evidence.PRIMARY_RECORD_BYTES,
               'emergencyBytes':failure_evidence.EMERGENCY_BYTES,
               'portErrorReserveBytes':failure_evidence.PORT_ERROR_RESERVE_BYTES}
    need(all(type(spec[key]) is int and spec[key] == wanted for key,wanted in constants.items()),
         'Exact finite failure-evidence allocation and reserves required')
    failure_evidence_commit_reserve(value['limits']['maxReportBytes'])
    root=Path(spec['root'])
    need(type(spec['root']) is str and root.is_absolute() and str(root) == os.path.abspath(root),
         'Exact absolute failure-evidence root required')
    for key in ('sourceRoot','workingRoot','parkedRoot','preservedRoot','captureRoot','releaseRoot','vendorRoot'):
        role=Path(value[key])
        need(not root.is_relative_to(role) and not role.is_relative_to(root),
             'Failure evidence must not overlap source, runtime, image or namespace roles')
    failure_evidence.FailureEvidenceLedger.validate_configuration(root,spec['maximumBytes'],must_be_absent=ledger is None)
    if ledger is None:
        return spec['maximumBytes']
    need(type(ledger) is failure_evidence.FailureEvidenceLedger, 'The original in-process failure ledger is required')
    ledger.require_idle()
    receipt=ledger.receipt()
    need(receipt['root'] == str(root) and receipt['maximumBytes'] == spec['maximumBytes']
         and type(receipt['committedBytes']) is int and 0 <= receipt['committedBytes'] <= spec['maximumBytes']
         and receipt['reservedBytes'] == 0 and receipt['activePorts'] == 0 and receipt['activeScopes'] == 0,
         'Shared failure ledger identity, allocation or idle state changed')
    return spec['maximumBytes']-receipt['committedBytes']


def failure_evidence_commit_reserve(max_report_bytes):
    need(type(max_report_bytes) is int and max_report_bytes == capture.MAX_REPORT_BYTES,
         'The shared failure-evidence route requires the reviewed 384MiB report bound')
    return 2*(failure_evidence.PRIMARY_RECORD_BYTES-max_report_bytes)


def admit_failure_evidence_commit_capacity(value):
    """Extend the same fresh observation; never refresh capacity during recovery."""
    maximum=value['limits']['maxReportBytes']
    additional=failure_evidence_commit_reserve(maximum)
    observed=capture.admit_report_commit_capacity(maximum)
    base=capture.required_report_commit_bytes(maximum)
    need(observed.get('admissionRequired') is True and observed.get('maxReportBytes') == maximum
         and observed.get('requiredCommitBytes') == base
         and type(observed.get('availableCommitBytes')) is int
         and observed['availableCommitBytes'] >= base+additional,
         'Current commit headroom does not cover the fixed primary-evidence serialization reserve')
    return {**observed,'reportRequiredCommitBytes':base,
            'primarySerializationReserveBytes':additional,'requiredCommitBytes':base+additional}


def prepare_failure_evidence(value, ledger=None):
    failure_evidence_configuration(value,ledger)
    if ledger is None:
        ledger=failure_evidence.FailureEvidenceLedger(value['failureEvidence']['root'],
                    maximum_bytes=value['failureEvidence']['maximumBytes'])
    return ledger


def record_failure_evidence(report, ledger):
    # This cannot gate physical restoration; it runs after the recovery finally.
    try:
        report['failureEvidence']=ledger.receipt()
        if report['failureEvidence']['activePorts'] or report['failureEvidence']['activeScopes'] or report['failureEvidence']['failed']:
            report['qualified']=False
    except BaseException as error:
        report['failureEvidenceError']=error_record(error)
        report['qualified']=False


def app_release_bindings(value):
    """Select the two releases from the caller's already hash-checked source refs.

    A retained launcher release is optional, explicit, and the same authenticated
    candidate. Its complete existing verifier receipt and artifact closure are
    reused; this never invents a release from a catalog path or starts a candidate.
    """
    current, current_hash = json_read(value['appManifest'])
    after = (value['releaseRoot'], current)
    if 'beforeAppRelease' not in value:
        return [after, after]
    spec = value['beforeAppRelease']
    need(type(spec) is dict and set(spec) == {'root','manifest','authentication'},
         'Closed explicit before application release required')
    for path in spec.values():
        need(type(path) is str and Path(path).is_absolute() and str(Path(path)) == path,
             'Exact absolute before release paths required')
    root = Path(spec['root']); release = Path(value['releaseRoot'])
    need(Path(spec['manifest']) == root/'dist/candidate.json'
         and root.parent == release/'.launcher/candidates', 'Before release must be the retained launcher candidate')
    refs = {row['path']:row for row in value['sourceRefs']}
    need(len(refs) == len(value['sourceRefs'])
         and all(path in refs for path in (spec['manifest'],spec['authentication'],value['appManifest'],str(release/'package.json'))),
         'Before release is missing authenticated evidence')
    auth, auth_hash = json_read(spec['authentication'])
    before, before_hash = json_read(spec['manifest'])
    need(refs[spec['authentication']]['sha256'] == auth_hash
         and auth.get('format') == 1 and auth.get('kind') == 'retained-launcher-candidate-authentication'
         and auth.get('qualified') is True and auth.get('noUndeclaredFiles') is True
         and auth.get('allDeclaredArtifactHashesPassed') is True and auth.get('packageAndManifestExactlyCurrent') is True,
         'Complete retained candidate authentication is required')
    need(auth['root'] == spec['root'] and auth['manifest'] == refs[spec['manifest']]
         and auth['currentManifest'] == refs[value['appManifest']]
         and before_hash == current_hash == refs[value['appManifest']]['sha256']
         and before == current and auth['priorCandidateId'] == auth['currentCandidateId'] == root.name
         and all(auth[key] == current[key] for key in ('version','buildVersion','schemaVersion','apiVersion','appId')),
         'Retained before candidate identity differs from the current candidate')
    verifier = auth['verifier']
    need(verifier['path'] == str(release/'scripts/candidate.mjs') and refs.get(verifier['path']) == verifier,
         'Maintained candidate verifier source is unbound')
    expected = {item['path']:item['sha256'] for item in before['artifacts']}
    need(len(expected) == len(before['artifacts']) > 0
         and all(not Path(name).is_absolute() and name.startswith(('dist/client/','dist/service/','dist/desktop/'))
                 and all(part not in ('','..','.') for part in name.split('/')) for name in expected),
         'Retained candidate artifact paths are invalid')
    expected.update({'package.json':auth['packageSha256'],'dist/candidate.json':before_hash})
    files = auth['artifacts']; seen = set(); total = 0
    need(type(files) is list and len(files) == auth['completeFilesCount'] == len(expected)
         and auth['declaredArtifactCount'] == len(before['artifacts'])
         and refs[str(release/'package.json')]['sha256'] == auth['packageSha256'], 'Retained candidate closure is incomplete')
    for item in files:
        need(type(item) is dict and set(item) == {'path','relativePath','sha256','bytes'}, 'Closed retained artifact reference required')
        name = item['relativePath']; reference = {key:item[key] for key in ('path','sha256','bytes')}
        need(name in expected and name not in seen and item['path'] == str(root/Path(name))
             and item['sha256'] == expected[name] and refs.get(item['path']) == reference,
             'Retained candidate artifact is missing or differs from the authenticated closure')
        seen.add(name); total += item['bytes']
    need(seen == set(expected) and total == auth['totalBytes'], 'Retained candidate complete allocation binding changed')
    return [(spec['root'],before), after]


def qualification_representation(value):
    representation=value.get('captureRepresentation','physical-graph-v2')
    need(representation in ('physical-graph-v2','physical-graph-v3'), 'Explicit supported physical representation required')
    return representation


def validate_plan(value, *, fresh, failure_evidence_ledger=None):
    need(type(value) is dict and INPUT_FIELDS<=set(value)<=INPUT_FIELDS|{'beforeAppRelease','captureRepresentation'} and value['format'] == 1
         and value['kind'] == 'local-native-retained-qualification', 'Closed local qualification plan required')
    qualification_representation(value)
    failure_allocation=failure_evidence_configuration(value,failure_evidence_ledger)
    need(str(uuid.UUID(value['operationId'],version=4)) == value['operationId'], 'Operation UUID required')
    for key in PATH_FIELDS:
        need(type(value[key]) is str and Path(value[key]).is_absolute()
             and str(Path(os.path.abspath(value[key]))) == value[key], 'Exact absolute local paths required')
    source = Path(value['sourceRoot'])
    need(source.is_dir() and not source.is_symlink(), 'Original stopped workspace required')
    names = [Path(value[k]) for k in ('sourceRoot','workingRoot','parkedRoot','preservedRoot')]
    need(len(set(names)) == 4 and all(p.parent == source.parent for p in names), 'Four distinct same-parent roles required')
    for key in ('captureRoot','evidenceRoot','releaseRoot','vendorRoot'):
        path = Path(value[key])
        need(not path.is_relative_to(source) and not source.is_relative_to(path), 'External role overlaps original workspace')
    need(Path(value['evidenceRoot']).is_dir(), 'Private evidence directory must already exist')
    if fresh:
        need(all(not os.path.lexists(value[k]) for k in ('workingRoot','parkedRoot','preservedRoot','captureRoot')), 'A future operation role already exists')
        outputs=('before-original.json','clone-authority.json','before-startup.json','host-input.json',
                 'host-result.json','host-result.json.started.json','host-stdout.log','host-stderr.log',
                 'after-startup.json','restored-original.json','pending-original-owner.json','RESULT.json')
        need(all(not os.path.lexists(Path(value['evidenceRoot'])/name) for name in outputs),
             'An original output already exists; resume requires a separately reviewed recovery plan')
        need(all(not os.path.lexists(Path(value['evidenceRoot'])/(phase+'-'+suffix+'.json'))
                 for phase in ('park-pristine','activate-working','preserve-working','return-pristine')
                 for suffix in ('intent','result')),'An original rename phase already exists')
        need(all(not os.path.lexists(Path(value['evidenceRoot'])/('host-result.json.close-'+str(i)+'.json'))
                 for i in range(1,129)),'A prior host close observation exists')
    need(type(value['retiredPids']) is list and 0 < len(value['retiredPids']) <= 1024
         and all(type(pid) is int and 0 < pid <= 0xffffffff for pid in value['retiredPids']), 'Exact prior owner PID roster required')
    qualification_return_reserve(value['readyTimeoutMs'], value['totalTimeoutMs'], value['limits']['maxReportBytes'])
    need(type(value['candidate']) is dict and set(value['candidate']) == {'version','buildVersion','schemaVersion'}
         and value['candidate']['schemaVersion'] == 60, 'Exact local schema60 candidate required')
    need(value['limits']['node'] == value['node'], 'Capture and owner Node must agree')
    paths = refs_check(value['sourceRefs'])
    required = {Path(__file__).resolve(), *(RUNNER/name for name in ('recovery.py','local_windows_capture.py',
        'windows_same_handle.py','local_windows_clone.py','local_retained_context.py','local_retained_configuration.py',
        'local-retained-configuration.mjs','verify-session-bindings.mjs','local_windows_neutral_io.py','local_windows_failure_evidence.py')),
        Path(value['node']),Path(value['releaseRoot'])/'scripts/local-native-retained-host.mjs',
        Path(value['vendorRoot'])/'openclaw.mjs',Path(value['vendorRoot'])/'package.json'}
    need(required <= paths, 'Plan omits a maintained execution source')
    for folder in (Path(value['releaseRoot'])/'dist/service',Path(value['releaseRoot'])/'node_modules/zod'):
        need(folder.is_dir() and not folder.is_symlink(), 'Current maintained closure folder is missing')
        members=list(folder.rglob('*'))
        need(len(members) <= 100000 and all(not p.is_symlink() for p in members)
             and {p for p in members if p.is_file()} <= paths, 'Plan omits current compiled/builder closure')
    for name in ('sourceReview','runtimeEvidence','appManifest'):
        need(Path(value[name]) in paths, 'Plan omits required source/engine/candidate evidence')
    app_release_bindings(value)
    # Allocation includes four expanded immutable images plus one physical clone,
    # with distinct fixed recovery reserve. No cleanup is performed for capacity.
    required_bytes = value['limits']['maxBytes'] * 5 + 2*1024**3 + failure_allocation
    for parent in {source.parent,Path(value['captureRoot']).parent,Path(value['evidenceRoot']),Path(value['failureEvidence']['root']).parent}:
        need(shutil.disk_usage(parent).free >= required_bytes, 'Retained qualification allocation and reserve do not fit')


def parse_z(value):
    need(type(value) is str and value.endswith('Z'), 'Literal UTC timestamp required')
    return datetime.fromisoformat(value[:-1]+'+00:00').timestamp()


def admit(plan_path, intent_path, *, failure_evidence_ledger=None):
    plan, plan_hash = json_read(plan_path)
    intent, _ = json_read(intent_path,65536)
    need(type(intent) is dict and set(intent) == {'format','kind','operationId','planSha256','issuedAt','launchNotAfter','deadline','independentReview'},
         'Separate closed execution intent required')
    need(intent['format'] == 1 and intent['kind'] == 'local-native-retained-execution'
         and intent['operationId'] == plan['operationId'] and intent['planSha256'] == plan_hash, 'Intent plan binding changed')
    issued, launch, end = (parse_z(intent[k]) for k in ('issuedAt','launchNotAfter','deadline'))
    now = time.time()
    need(issued <= now <= launch <= issued+15 and end-issued == plan['totalTimeoutMs']/1000,
         'Original execution intent expired or its finite budget changed')
    refs_check([intent['independentReview']])
    review, review_hash = json_read(intent['independentReview']['path'],1024*1024)
    need(review_hash == intent['independentReview']['sha256'],'Independent review changed')
    need(review.get('planSha256') == plan_hash and review.get('approved') is True
         and review.get('operationId') == plan['operationId'], 'Exact independent execution review is required')
    validate_plan(plan,fresh=True,failure_evidence_ledger=failure_evidence_ledger)
    need(time.time() <= launch, 'Immediate launch admission expired during current readback')
    return plan, time.monotonic() + max(0,end-time.time())


def rename_role(source, target, expected_information, deadline, *, operation_id, phase, evidence, state):
    capture._check(deadline)
    source, target = Path(source), Path(target)
    before = source.lstat()
    need(source.parent == target.parent and not capture._reparse(before)
         and not os.path.lexists(target), 'No-replace ordinary same-parent directory rename required')
    capture._identity_join(before,expected_information,'directory')
    intent={'operationId':operation_id,'phase':phase,'from':str(source),'to':str(target),
            'expectedInformation':expected_information,'beforePath':capture._stat_row(before)}
    save(evidence/(phase+'-intent.json'),intent)
    state[phase]='attempted'
    os.rename(source,target)  # Windows refuses an existing destination.
    state[phase]='returned'
    after = target.lstat()
    need(not capture._reparse(after) and not os.path.lexists(source),
         'Directory rename identity is unresolved')
    capture._identity_join(after,expected_information,'directory')
    receipt={**intent,'afterPath':capture._stat_row(after),'renameReturned':True,'identityConfirmed':True}
    save(evidence/(phase+'-result.json'),receipt)
    state[phase]='confirmed'
    return receipt


def assert_restored(before, after):
    """Exact physical return; comparison-image IDs are never source authority."""
    if before.get('format') in (2,3) or after.get('format') in (2,3):
        return compare_graph_captures(before,after,independent=False)
    for value in (before,after):
        need(value.get('kind') == 'local-windows-closed-tree' and value.get('format') == 1
             and value.get('complete') is True and value.get('allHandlesClosed') is True
             and value.get('primitiveSha256') == capture.PRIMITIVE_SHA256
             and value.get('saclNotRequested') is True, 'Complete closed restoration captures required')
    need(before['sourceRoot'] == after['sourceRoot']
         and before['canonicalSourceRoot'] == after['canonicalSourceRoot'], 'Restored source namespace changed')
    need(set(before['entries']) == set(after['entries']), 'Restored complete file roster changed')
    for key, old in before['entries'].items():
        new = after['entries'][key]
        fields=('kind','physicalPath','information','security','streams','nodeIdentity')
        need(all(old[name] == new[name] for name in fields), 'Restored full source metadata differs: '+key)
        if old['kind'] == 'file':
            need(old['bytes'] == new['bytes'] and old['sha256'] == new['sha256'], 'Restored source bytes differ: '+key)
        for row in (old,new):
            observed=row['nativeObservations']
            need(row.get('sameHandleStable') is True and observed.get('handleClosed') is True
                 and observed['before'] == row['information'] == observed['after']
                 and observed['ownerGroupDaclBeforeBase64'] == row['security']['ownerGroupDaclBase64']
                 == observed['ownerGroupDaclAfterBase64']
                 and row['nodeIdentityBefore'] == row['nodeIdentity'], 'Restoration observation is incomplete')
    old_links={row['path']:row for row in before['junctions']}
    new_links={row['path']:row for row in after['junctions']}
    need(len(old_links) == len(before['junctions']) and len(new_links) == len(after['junctions'])
         and set(old_links) == set(new_links), 'Restored physical junction roster changed')
    for key,old in old_links.items():
        new=new_links[key]
        fields=('rawTarget','canonicalTarget','targetRole','physicalPath','information','security','streams')
        need(all(old[name] == new[name] for name in fields), 'Restored physical junction differs: '+key)
        for row in (old,new):
            observed=row['nativeObservations']
            need(row.get('sameHandleStable') is True and observed.get('handleClosed') is True
                 and observed['before'] == row['information'] == observed['after']
                 and observed['ownerGroupDaclBeforeBase64'] == row['security']['ownerGroupDaclBase64']
                 == observed['ownerGroupDaclAfterBase64'], 'Restored junction observation is incomplete')
    return {'completePhysicalReturn':True,'sourceIdsRetained':True,'saclNotRequested':True}


def assert_working_baseline(before, after, clone_authority=None):
    """Bind every pre-start member; copied directory storage needs exact authority."""
    if before.get('format') in (2,3) or after.get('format') in (2,3):
        return compare_graph_captures(before,after,independent=True,clone_authority=clone_authority)
    for value in (before,after):
        need(value.get('kind') == 'local-windows-closed-tree' and value.get('format') == 1
             and value.get('complete') is True and value.get('allHandlesClosed') is True
             and value.get('primitiveSha256') == capture.PRIMITIVE_SHA256
             and value.get('saclNotRequested') is True,'Complete pre-start captures required')
    need(before['sourceRoot'] == after['sourceRoot']
         and before['canonicalSourceRoot'] == after['canonicalSourceRoot']
         and set(before['entries']) == set(after['entries']),'Pre-start complete source roster changed')
    def compare(old,new,*,independent,node):
        excluded={'fileIndex64','fileId128Hex'} if independent else set()
        need(set(old['information']) == set(new['information'])
             and all(old['information'][k] == new['information'][k] for k in old['information'] if k not in excluded),
             'Pre-start full native metadata changed')
        need(all(old['information'][k] != new['information'][k] for k in excluded),
             'Working physical identity is not independent')
        need(old['security'] == new['security'] and old['streams'] == new['streams'],
             'Pre-start security or stream roster changed')
        for row in (old,new):
            observed=row['nativeObservations']
            need(row.get('sameHandleStable') is True and observed.get('handleClosed') is True
                 and observed['before'] == row['information'] == observed['after']
                 and observed['ownerGroupDaclBeforeBase64'] == row['security']['ownerGroupDaclBase64']
                 == observed['ownerGroupDaclAfterBase64'],'Incomplete pre-start held observation')
            if node:
                need(row['nodeIdentityBefore'] == row['nodeIdentity'],'Pre-start Node observation changed')
                capture._node_join(row['nodeIdentity'],row['information'])
        if node:
            need(set(old['nodeIdentity']) == set(new['nodeIdentity'])
                 and all(old['nodeIdentity'][k] == new['nodeIdentity'][k]
                         for k in old['nodeIdentity'] if not (independent and k == 'ino')),
                 'Pre-start Node metadata changed')
    for key,old in before['entries'].items():
        new=after['entries'][key]
        need(old['kind'] == new['kind'] and old['physicalPath'] == new['physicalPath'],
             'Pre-start physical mapping changed: '+key)
        if old['kind'] == 'file':
            need(old['bytes'] == new['bytes'] and old['sha256'] == new['sha256'],
                 'Pre-start file or database-family bytes changed: '+key)
        compare(old,new,independent=Path(old['physicalPath']).is_relative_to(Path(before['sourceRoot'])),node=True)
    old_links={r['path']:r for r in before['junctions']};new_links={r['path']:r for r in after['junctions']}
    need(len(old_links) == len(before['junctions']) and len(new_links) == len(after['junctions'])
         and set(old_links) == set(new_links),'Pre-start physical junction roster changed')
    for key,old in old_links.items():
        new=new_links[key]
        need(all(old[k] == new[k] for k in ('rawTarget','canonicalTarget','targetRole','physicalPath')),
             'Pre-start junction target changed: '+key)
        compare(old,new,independent=Path(old['physicalPath']).is_relative_to(Path(before['sourceRoot'])),node=False)
    return {'completePreStartEquality':True,'onlyCopiedPhysicalIdsDiffer':True,
            'completeFileAndDatabaseFamilyRoster':True,'saclNotRequested':True}


def working_directory_authority(before, authority):
    """Bind construction-derived directory storage to its completed actual copy."""
    import local_windows_clone as clone
    need(type(authority) is dict and authority.get('kind')=='local-windows-working-copy'
        and authority.get('complete') is True and authority.get('allHandlesClosed') is True
        and authority.get('sourceChildrenWritten') is False and authority.get('renamesPerformed') is False
        and authority['sourceRoot']==before['sourceRoot'],'Completed exact working-copy authority required')
    source=Path(before['sourceRoot']);target=Path(authority['destinationRoot'])
    need(target!=source and target.parent==source.parent,'Independent sibling copy authority required')
    old_rows=before['physicalEntries']['root'];entries=authority['entries']
    need(set(entries)=={key for key,row in old_rows.items() if row['kind']!='junction'},'Complete copied ordinary roster required')
    handles={row['path']:row for row in authority['handles']}
    need(len(handles)==len(authority['handles']),'Duplicate copied handle authority')
    result={};changed=False
    for key,old in old_rows.items():
        if old['kind']!='directory':continue
        row=entries[key];derivation=row.get('directoryStorageDerivation')
        need(row['kind']=='directory' and type(derivation) is dict and derivation=={
            'kind':'independent-directory-index-storage','sourcePath':old['physicalPath'],
            'sourceInformation':old['information'],'sourceMembers':old['members'],
            'targetInformationRef':'information','membersExactlyCreated':True},'Directory construction source binding changed')
        info=row['information'];clone._same_metadata(old['information'],info,True,derive_directory_storage=True)
        need(row['security']==old['security'] and row['streams']==old['streams'],'Directory construction saved state changed')
        observed=handles.get(str(target/capture._relative(key)))
        need(type(observed) is dict and observed['kind']=='directory' and observed.get('handleClosed') is True
            and observed['before']==info==observed['after'] and observed['streams']==row['streams']
            and observed['ownerGroupDaclBeforeBase64']==row['security']['ownerGroupDaclBase64']
            ==observed['ownerGroupDaclAfterBase64'],'Directory construction native observation changed')
        changed=changed or any(old['information'][field]!=info[field] for field in ('size','allocationBytes'))
        result[key]=row
    need(authority.get('directoryStorageDerived') is changed and authority.get('independentIdsOnly') is (not changed),
        'Directory construction declaration changed')
    need(authority['rootInformation']==entries['.']['information']
        and authority['rootSecurity']==entries['.']['security'] and authority['rootStreams']==entries['.']['streams'],
        'Copied root authority changed')
    return result,changed


def working_file_authority(before, authority):
    """Bind every format3 file and its closed family to the completed clone."""
    if before['format']!=3:return {}
    import local_windows_clone as clone
    need(type(authority) is dict and authority.get('complete') is True and authority.get('allHandlesClosed') is True,
        'Format3 requires completed working-copy file authority')
    families=capture.graph_family_map(before,'root')
    proofs=authority.get('hardlinkFamilies')
    need(type(proofs) is dict and set(proofs)==set(families),'Exact copied hardlink-family roster required')
    target=Path(authority['destinationRoot']);handles={row['path']:row for row in authority['handles']}
    source_ids={native_file_identity(row['information']) for rows in before['physicalEntries'].values()
                for row in rows.values() if row['kind']=='file'}
    result={};old_to_new={};new_to_old={}
    for key,old in before['physicalEntries']['root'].items():
        if old['kind']!='file':continue
        row=authority['entries'][key];info=row['information'];count=old['information']['links']
        capture._info_checked(info,'file',expected_links=count)
        clone._same_metadata(old['information'],info,True)
        need(row['kind']=='file' and row['bytes']==old['bytes'] and row['sha256']==old['sha256']
            and row['security']==old['security'] and row['streams']==old['streams'],
            'Copied file saved state changed')
        path=str(target/capture._relative(key));observed=handles.get(path)
        need(type(observed) is dict and observed['kind']=='file' and observed.get('handleClosed') is True
            and observed['before']==info==observed['after'] and observed['streams']==row['streams']
            and observed['ownerGroupDaclBeforeBase64']==row['security']['ownerGroupDaclBase64']
            ==observed['ownerGroupDaclAfterBase64'],'Copied file native observation changed')
        old_id,new_id=native_file_identity(old['information']),native_file_identity(info)
        need(new_id not in source_ids,'Copied file shares an original physical identity')
        need(old_to_new.setdefault(old_id,new_id)==new_id and new_to_old.setdefault(new_id,old_id)==old_id,
            'Copied hardlink partition split or merged')
        result[key]=row
    for representative,members in families.items():
        proof=proofs[representative];old=before['physicalEntries']['root'][representative]
        expected={'kind':'independent-closed-hardlink-family','sourceRepresentative':representative,
            'sourceInformation':old['information'],'members':members,
            'targetInformationRef':{'entry':representative,'field':'information'},
            'memberHandlePaths':{name:str(target/capture._relative(name)) for name in members}}
        need(type(proof) is dict and set(proof)==set(expected)|{'linkEvents'}
            and all(proof[key]==value for key,value in expected.items()),'Copied hardlink-family source binding changed')
        events=proof['linkEvents'];need(type(events) is list and len(events)==len(members)-1,
            'Complete hardlink creation evidence required')
        for name,event in zip(members[1:],events):
            need(type(event) is dict and event.get('api')=='CreateHardLinkW:owned-family'
                and event.get('arguments')=={'path':str(target/capture._relative(name)),
                    'existingPath':str(target/capture._relative(representative)),'reserved':None}
                and type(event.get('result')) is int and event['result']!=0,
                'Hardlink creation was not confirmed for its exact owned member')
        need(all(result[name]['information']==result[representative]['information'] for name in members),
            'Copied family full native tuple changed')
    return result


def native_file_identity(info):
    return tuple(info[key] for key in ('volumeSerial32','volumeSerial64','fileIndex64','fileId128Hex'))


def file_partition(value,role):
    groups={}
    for name,row in value['physicalEntries'][role].items():
        if row['kind']=='file':groups.setdefault(native_file_identity(row['information']),[]).append(name)
    return sorted(tuple(sorted(names)) for names in groups.values())


def compare_graph_captures(before,after,*,independent,clone_authority=None):
    """Pure complete graph equality. Transport IDs never replace source IDs."""
    for value in (before,after):capture.validate_physical_graph(value)
    need(before['format']==after['format'],'Physical capture representations changed')
    need(independent or clone_authority is None,'Original return must not use copy-derived authority')
    directory_authority,storage_changed=working_directory_authority(before,clone_authority) if clone_authority is not None else ({},False)
    file_authority=working_file_authority(before,clone_authority) if independent and before['format']==3 else {}
    require_fields=('sourceRoot','canonicalSourceRoot','vendorRoot','canonicalVendorRoot')
    need(all(before[k]==after[k] for k in require_fields),'Original physical namespace changed')
    for role in ('root','vendor'):
        old_rows,new_rows=before['physicalEntries'][role],after['physicalEntries'][role]
        need(set(old_rows)==set(new_rows),'Complete physical closure roster changed')
        copied=independent and role=='root'
        if before['format']==3:
            need(file_partition(before,role)==file_partition(after,role),'Complete hardlink-family partition changed')
        for key,old in old_rows.items():
            new=new_rows[key]
            need(old['kind']==new['kind'] and old['physicalPath']==new['physicalPath'],'Physical source mapping changed')
            excluded={'fileIndex64','fileId128Hex'} if copied else set()
            expected=old['information']
            if copied and old['kind']=='directory' and clone_authority is not None:
                expected=directory_authority[key]['information'];excluded=set()
                need(directory_authority[key]['security']==new['security'] and directory_authority[key]['streams']==new['streams'],
                    'Actual copied directory state changed before start')
            elif copied and old['kind']=='file' and before['format']==3:
                expected=file_authority[key]['information'];excluded=set()
                need(file_authority[key]['security']==new['security'] and file_authority[key]['streams']==new['streams'],
                    'Actual copied file state changed before start')
            need(set(expected)==set(new['information'])
                and all(expected[k]==new['information'][k] for k in expected if k not in excluded),
                'Full physical source metadata changed')
            need(all(old['information'][k]!=new['information'][k] for k in excluded),'Working physical identity is not independent')
            need(old['security']==new['security'] and old['streams']==new['streams'],'Physical security or streams changed')
            if old['kind']=='directory':need(old['members']==new['members'],'Physical directory membership changed')
            elif old['kind']=='file':need(old['bytes']==new['bytes'] and old['sha256']==new['sha256'],'Physical file/database bytes changed')
            if old['kind']!='junction':
                need(all(old['nodeIdentity'][k]==new['nodeIdentity'][k] for k in capture.NODE_FIELDS if not (copied and k=='ino')),
                    'Original Node metadata changed')
    old_edges,new_edges=capture.graph_index(before),capture.graph_index(after)
    need(set(old_edges)==set(new_edges),'Complete physical junction roster changed')
    for key,old in old_edges.items():
        new=new_edges[key]
        need(all(old[k]==new[k] for k in ('sourceRole','path','rawTarget','canonicalTarget','targetRole','targetPath')),
             'Original junction target graph changed')
    if not independent:return {'completePhysicalReturn':True,'sourceIdsRetained':True,'saclNotRequested':True}
    result={'completePreStartEquality':True,'onlyCopiedPhysicalIdsDiffer':not storage_changed,
            'copiedDirectoryStorageBound':clone_authority is not None,
            'completeFileAndDatabaseFamilyRoster':True,'saclNotRequested':True}
    if before['format']==3:result['copiedHardlinkFamiliesBound']=len(capture.graph_family_map(before,'root'))
    if clone_authority is not None:
        changed_count=sum(any(row['information'][field]!=row['directoryStorageDerivation']['sourceInformation'][field]
                              for field in ('size','allocationBytes')) for row in directory_authority.values())
        result['directoryStorageDerivation']={'boundCount':len(directory_authority),'changedCount':changed_count,
            'fields':['size','allocationBytes'],'exactTargetTupleMatched':True}
    return result


def assert_native_return_chain(baseline, before_startup, after_startup, restored, host, *, operation_id):
    """Exact workspace return plus a bounded, observed vendor-read transition.

    This does not identify the reader. Every vendor field except a forward access
    timestamp inside the actual host window stays exact, including post-host return.
    """
    values=(baseline,before_startup,after_startup,restored)
    for value in values:capture.validate_physical_graph(value)
    need(all(value['format']==baseline['format'] for value in values),'Native return capture representations changed')
    namespace=('sourceRoot','canonicalSourceRoot','vendorRoot','canonicalVendorRoot')
    need(all(all(value[key]==baseline[key] for key in namespace) for value in values),
         'Native return physical namespace changed')
    need(type(host) is dict and host.get('format')==1 and host.get('kind')=='local-native-retained-host-result'
        and host.get('operationId')==operation_id and type(operation_id) is str and bool(operation_id)
        and host.get('workspaceRoot')==baseline['sourceRoot'] and host.get('ready') is True
        and host.get('passed') is True and host.get('closed') is True
        and host.get('providerRequestSubmitted') is False,'Successful exact native host required for return chain')
    start,end=host.get('startedEpochMs'),host.get('endedEpochMs');identity=host.get('nativeIdentity');observer=host.get('observer')
    need(type(start) is int and type(end) is int and 0<=start<=end<=2**53-1
        and type(observer) is dict and type(observer.get('pid')) is int and observer['pid']>0
        and type(identity) is dict and type(identity.get('pid')) is int and identity['pid']>0
        and type(host.get('observedNativePids')) is list
        and all(type(pid) is int and pid>0 for pid in host['observedNativePids'])
        and identity['pid'] in host['observedNativePids']
        and all(type(identity.get(key)) is str and identity[key] for key in ('epoch','generation','version'))
        and type(identity.get('startedAt')) is int and start<=identity['startedAt']<=end,
        'Bounded observed native identity and startup window required')
    need(baseline['endedEpochMs']<=before_startup['startedEpochMs']
        and before_startup['endedEpochMs']<=start<=end<=after_startup['startedEpochMs']
        and after_startup['endedEpochMs']<=restored['startedEpochMs'],'Native return capture chronology changed')
    minimum,maximum=(116444736000000000+value*10000 for value in (start,end))
    semantic_fields=('kind','physicalPath','imageRelativePath','security','streams','bytes','sha256','members',
                     'nodeIdentity','nodeIdentityBefore')
    def role_equal(first,second,role,*,vendor_window=False):
        old_rows,new_rows=first['physicalEntries'][role],second['physicalEntries'][role]
        need(set(old_rows)==set(new_rows),'Return-chain complete '+role+' roster changed')
        if first['format']==3:
            need(file_partition(first,role)==file_partition(second,role),'Return-chain hardlink partition changed')
        changes=[]
        for key,old in old_rows.items():
            new=new_rows[key]
            need(all(old.get(field)==new.get(field) for field in semantic_fields),
                'Return-chain saved state changed: '+role+'/'+key)
            a,b=old['information'],new['information']
            if not vendor_window:
                need(a==b,'Return-chain full native metadata changed: '+role+'/'+key)
                continue
            need(role=='vendor' and set(a)==set(b) and all(a[field]==b[field] for field in a if field!='access100ns'),
                'Vendor non-access native metadata changed: '+key)
            if a['access100ns']!=b['access100ns']:
                need(old['kind'] in ('file','directory') and a['reparseTag']==b['reparseTag']==0
                    and a['access100ns']<b['access100ns'] and minimum<=b['access100ns']<=maximum,
                    'Vendor access timestamp changed outside native window: '+key)
                changes.append({'relativePath':key,'kind':old['kind'],
                    'beforeAccess100ns':a['access100ns'],'afterAccess100ns':b['access100ns']})
        fields=('sourceRole','path','rawTarget','canonicalTarget','targetRole','targetPath')
        edges=lambda value:{(edge['sourceRole'],edge['path']):{field:edge[field] for field in fields}
            for edge in value['junctions'] if edge['sourceRole']==role}
        need(edges(first)==edges(second),'Return-chain complete '+role+' alias graph changed')
        return changes
    role_equal(baseline,restored,'root')
    role_equal(baseline,before_startup,'vendor')
    changes=role_equal(before_startup,after_startup,'vendor',vendor_window=True)
    role_equal(after_startup,restored,'vendor')
    return {'completeWorkspaceReturn':True,'sourceIdsRetained':True,'saclNotRequested':True,
        'vendorBeforeStartupExact':True,'vendorAfterStartupToReturnExact':True,
        'vendorAccessTransition':{'kind':'observed-vendor-access-during-native-startup',
            'operationId':operation_id,'nativeIdentity':identity,'startedEpochMs':start,'endedEpochMs':end,
            'readerIdentityAttributed':False,'changedCount':len(changes),'changes':changes}}


def reconcile_host_close(result_path, operation_id, original_pid, node):
    result,result_hash=json_read(result_path,262144)
    need(result.get('operationId') == operation_id and result.get('observer',{}).get('pid') == original_pid
         and Path(result['observer']['node']) == Path(node),'Host result does not name the original process/runtime')
    receipts=[{'path':str(result_path),'sha256':result_hash}]
    closed=result.get('closed') is True
    # The host writes at most 128 exclusive observations for this original owner.
    # A late closure permits restoration only; it never changes original passed.
    for index in range(1,129):
        path=Path(str(result_path)+'.close-'+str(index)+'.json')
        if not os.path.lexists(path):
            continue
        row,digest=json_read(path,65536)
        need(type(row) is dict and row.get('operationId') == operation_id
             and type(row.get('closed')) is bool,'Invalid original close observation')
        receipts.append({'path':str(path),'sha256':digest})
        if row['closed']:
            closed=True
            break
    need(closed,'Original host closure is unproven; do not restore')
    return result,receipts


def run_host(plan, evidence, deadline, closure_deadline, ownership):
    need(deadline-time.monotonic() >= plan['readyTimeoutMs']/1000+30,
         'Insufficient original time for one maintained startup and closure observation')
    result_path = evidence/'host-result.json'
    input_path = evidence/'host-input.json'
    save(input_path,{'format':1,'kind':'local-native-retained-host','operationId':plan['operationId'],
        'workspaceRoot':plan['sourceRoot'],'releaseRoot':plan['releaseRoot'],
        'expectedVersion':plan['candidate']['version'],'expectedBuildVersion':plan['candidate']['buildVersion'],
        'expectedSchema':60,'readyTimeoutMs':plan['readyTimeoutMs'],'resultPath':str(result_path)})
    env = {k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','TEMP','TMP','PATH','HOME','USERPROFILE','LOCALAPPDATA','APPDATA'}}
    env.update(NODE_DISABLE_COMPILE_CACHE='1',NODE_USE_SYSTEM_CA='1',
               E3_OPENCLAW_ENTRY=str(Path(plan['vendorRoot'])/'openclaw.mjs'),E3_OPENCLAW_NODE=plan['node'])
    original = None
    with (evidence/'host-stdout.log').open('xb') as stdout, (evidence/'host-stderr.log').open('xb') as stderr:
        ownership['dispatchAttempted']=True
        original = subprocess.Popen([plan['node'],str(Path(plan['releaseRoot'])/'scripts/local-native-retained-host.mjs'),str(input_path)],
            cwd=plan['releaseRoot'],env=env,stdin=subprocess.PIPE,stdout=stdout,stderr=stderr,
            creationflags=getattr(subprocess,'DETACHED_PROCESS',0))
        ownership['pid']=original.pid
        # The only forwarded control observes the existing host's maintained drain.
        def forward():
            for raw in sys.stdin:
                if len(raw) > 1024:
                    continue
                try:
                    command=json.loads(raw)
                    if command == {'action':'observe-close','operationId':plan['operationId']}:
                        original.stdin.write((json.dumps(command)+'\n').encode());original.stdin.flush()
                except (ValueError,OSError,BrokenPipeError):
                    pass
        threading.Thread(target=forward,daemon=True).start()
        pending_reported = False
        while original.poll() is None:
            if time.monotonic() >= deadline and not pending_reported:
                save(evidence/'pending-original-owner.json',{'operationId':plan['operationId'],
                    'pid':original.pid,'deadlineExpired':True,'restorationAdmitted':False})
                print(json.dumps({'operationId':plan['operationId'],'pendingOriginalOwner':original.pid}),flush=True)
                pending_reported=True
            time.sleep(.2)
        ownership['processExited']=True
        result,ownership['closureReceipts']=reconcile_host_close(result_path,plan['operationId'],original.pid,plan['node'])
        pids=[original.pid,*result['observedNativePids']]
        retirement=capture.assert_processes_retired(plan['node'],pids,closure_deadline)
        ownership['closed']=True
        ownership['retirement']=retirement
        return result,retirement


def execute(plan_path, intent_path, *, failure_evidence_ledger=None):
    need(os.name == 'nt','Windows qualification requires Windows')
    plan,deadline=admit(plan_path,intent_path,failure_evidence_ledger=failure_evidence_ledger)
    # Check once before any capture or role mutation. A later recovery must
    # return the pristine generation even if system memory availability falls.
    resource_admission=admit_failure_evidence_commit_capacity(plan)
    failure_evidence_ledger=prepare_failure_evidence(plan,failure_evidence_ledger)
    # Preserve a fixed part of the SAME original budget for returning the
    # pristine generation; no failure-time clock reset grants extra authority.
    work_deadline=deadline-qualification_return_reserve(plan['readyTimeoutMs'],plan['totalTimeoutMs'],plan['limits']['maxReportBytes'])
    import local_windows_clone as clone
    evidence,images=Path(plan['evidenceRoot']),Path(plan['captureRoot'])
    report={'operationId':plan['operationId'],'stages':[],'qualified':False,'restored':False,
            'resourceAdmission':resource_admission}
    baseline=None; clone_authority=None; before=None; after=None; host=None
    ownership={'dispatchAttempted':False,'closed':False}
    renames={}
    primary=None
    def tree(name,*,restoring=False):
        scope=failure_evidence_ledger.new_scope(plan['operationId']+'-'+name)
        value=capture.capture_closed_tree(plan['sourceRoot'],images/name,vendor_root=plan['vendorRoot'],limits=plan['limits'],deadline=deadline if restoring else work_deadline,
            representation=qualification_representation(plan),failure_evidence=scope)
        failure_evidence_ledger.require_idle()
        save(evidence/(name+'.json'),value);return value
    try:
        report['priorRetirement']=capture.assert_processes_retired(plan['node'],plan['retiredPids'],work_deadline)
        images.mkdir()
        baseline=tree('before-original')
        clone_limits={key:plan['limits'][key] for key in ('maxEntries','maxBytes','maxFileBytes','maxAliases','maxReportBytes')}
        clone_authority=clone.prepare_working_copy(baseline,plan['workingRoot'],node=plan['node'],limits=clone_limits,deadline=work_deadline)
        save(evidence/'clone-authority.json',clone_authority)
        report['stages'].append(rename_role(plan['sourceRoot'],plan['parkedRoot'],capture.source_root_entry(baseline)['information'],
            work_deadline,operation_id=plan['operationId'],phase='park-pristine',evidence=evidence,state=renames))
        report['stages'].append(rename_role(plan['workingRoot'],plan['sourceRoot'],clone_authority['rootInformation'],
            work_deadline,operation_id=plan['operationId'],phase='activate-working',evidence=evidence,state=renames))
        clone.finalize_renamed_root(clone_authority,plan['sourceRoot'],deadline=work_deadline)
        before=tree('before-startup')
        report['preStartComparison']=assert_working_baseline(baseline,before,clone_authority=clone_authority)
        host,report['hostRetirement']=run_host(plan,evidence,work_deadline,deadline,ownership)
        report['hostResult']={'path':str(evidence/'host-result.json'),'sha256':recovery.digest(evidence/'host-result.json')}
        after=tree('after-startup')
        need(host.get('passed') is True and len(host['observedNativePids']) > 0,'Original maintained startup did not qualify')
        app_releases=app_release_bindings(plan)
        derivation={'kind':'maintained-local-configuration','releaseRoot':plan['releaseRoot'],
                    'sourceRefs':plan['sourceRefs'],'hostResult':host}
        # Builder references are the exact subset inside the admitted release.
        derivation['sourceRefs']=[r for r in plan['sourceRefs'] if Path(r['path']).is_relative_to(Path(plan['releaseRoot']))]
        report['comparison']=recovery.local_windows_native_saved_state(before,after,node=plan['node'],
            app_releases=app_releases,
            startup_window=(host['startedEpochMs'],host['endedEpochMs']),catalog_runtime_root=plan['vendorRoot'],
            configuration_derivation=derivation,deadline=work_deadline)
    except BaseException as error:
        primary=error;report['primaryError']=error_record(error)
    finally:
        host_closed=not ownership['dispatchAttempted'] or ownership['closed']
        rename_settled=(renames.get('park-pristine') == 'confirmed'
                        and renames.get('activate-working') in (None,'confirmed'))
        if rename_settled and host_closed:
            try:
                if renames.get('activate-working') == 'confirmed':
                    report['stages'].append(rename_role(plan['sourceRoot'],plan['preservedRoot'],clone_authority['rootInformation'],
                        deadline,operation_id=plan['operationId'],phase='preserve-working',evidence=evidence,state=renames))
                report['stages'].append(rename_role(plan['parkedRoot'],plan['sourceRoot'],capture.source_root_entry(baseline)['information'],
                    deadline,operation_id=plan['operationId'],phase='return-pristine',evidence=evidence,state=renames))
                clone.finalize_renamed_root(baseline,plan['sourceRoot'],deadline=deadline)
                restored=tree('restored-original',restoring=True)
                if before is not None and after is not None and host is not None and host.get('passed') is True:
                    report['restorationComparison']=assert_native_return_chain(
                        baseline,before,after,restored,host,operation_id=plan['operationId'])
                else:
                    report['restorationComparison']=assert_restored(baseline,restored)
                report['restored']=True
            except BaseException as error:
                report['restorationError']=error_record(error)
        report['qualified']=primary is None and report['restored']
        report['originalOwnerClosed']=host_closed
        report['ownerState']=ownership
        report['renameStates']=renames
        report['endedEpochMs']=time.time_ns()//1000000
        record_failure_evidence(report,failure_evidence_ledger)
        save(evidence/'RESULT.json',report)
    return 0 if report['qualified'] else 1


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=('plan','execute'));parser.add_argument('input');parser.add_argument('output')
    args=parser.parse_args()
    if args.mode == 'plan':
        value,_=json_read(args.input);validate_plan(value,fresh=True);save(args.output,value);return 0
    return execute(args.input,args.output)


if __name__ == '__main__':
    raise SystemExit(main())
