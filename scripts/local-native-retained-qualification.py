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


def need(value, message):
    if not value:
        raise RuntimeError(message)


def json_read(path, maximum=16*1024*1024):
    path = Path(path)
    row = path.lstat()
    need(path.is_file() and not path.is_symlink() and row.st_size <= maximum, 'Bounded ordinary JSON input required')
    raw = path.read_bytes()
    need(len(raw) == row.st_size, 'JSON input changed')
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def save(path, value):
    data = (json.dumps(value, ensure_ascii=True, allow_nan=False, indent=2)+'\n').encode('ascii')
    need(len(data) <= 256*1024*1024, 'Evidence record exceeded bound')
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
                'totalTimeoutMs','candidate','sourceRefs','sourceReview','runtimeEvidence','appManifest'}


def validate_plan(value, *, fresh):
    need(type(value) is dict and set(value) == INPUT_FIELDS and value['format'] == 1
         and value['kind'] == 'local-native-retained-qualification', 'Closed local qualification plan required')
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
    need(type(value['readyTimeoutMs']) is int and 1000 <= value['readyTimeoutMs'] <= 300000
         and type(value['totalTimeoutMs']) is int and value['readyTimeoutMs'] + 60000 <= value['totalTimeoutMs'] <= 1800000,
         'Finite original readiness and qualification budgets required')
    need(type(value['candidate']) is dict and set(value['candidate']) == {'version','buildVersion','schemaVersion'}
         and value['candidate']['schemaVersion'] == 60, 'Exact local schema60 candidate required')
    need(value['limits']['node'] == value['node'], 'Capture and owner Node must agree')
    paths = refs_check(value['sourceRefs'])
    required = {Path(__file__).resolve(), *(RUNNER/name for name in ('recovery.py','local_windows_capture.py',
        'windows_same_handle.py','local_windows_clone.py','local_retained_context.py','local_retained_configuration.py',
        'local-retained-configuration.mjs','verify-session-bindings.mjs')),
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
    # Allocation includes four expanded immutable images plus one physical clone,
    # with distinct fixed recovery reserve. No cleanup is performed for capacity.
    required_bytes = value['limits']['maxBytes'] * 5 + 2*1024**3
    for parent in {source.parent,Path(value['captureRoot']).parent,Path(value['evidenceRoot'])}:
        need(shutil.disk_usage(parent).free >= required_bytes, 'Retained qualification allocation and reserve do not fit')


def parse_z(value):
    need(type(value) is str and value.endswith('Z'), 'Literal UTC timestamp required')
    return datetime.fromisoformat(value[:-1]+'+00:00').timestamp()


def admit(plan_path, intent_path):
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
    validate_plan(plan,fresh=True)
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


def assert_working_baseline(before, after):
    """Compare every captured member before START; only copied physical IDs differ."""
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


def execute(plan_path, intent_path):
    need(os.name == 'nt','Windows qualification requires Windows')
    plan,deadline=admit(plan_path,intent_path)
    # Preserve a fixed part of the SAME original budget for returning the
    # pristine generation; no failure-time clock reset grants extra authority.
    work_deadline=deadline-min(300,plan['totalTimeoutMs']/3000)
    import local_windows_clone as clone
    evidence,images=Path(plan['evidenceRoot']),Path(plan['captureRoot'])
    report={'operationId':plan['operationId'],'stages':[],'qualified':False,'restored':False}
    baseline=None; clone_authority=None
    ownership={'dispatchAttempted':False,'closed':False}
    renames={}
    primary=None
    def tree(name,*,restoring=False):
        value=capture.capture_closed_tree(plan['sourceRoot'],images/name,vendor_root=plan['vendorRoot'],limits=plan['limits'],deadline=deadline if restoring else work_deadline)
        save(evidence/(name+'.json'),value);return value
    try:
        report['priorRetirement']=capture.assert_processes_retired(plan['node'],plan['retiredPids'],work_deadline)
        images.mkdir()
        baseline=tree('before-original')
        clone_limits={key:plan['limits'][key] for key in ('maxEntries','maxBytes','maxFileBytes','maxAliases','maxReportBytes')}
        clone_authority=clone.prepare_working_copy(baseline,plan['workingRoot'],node=plan['node'],limits=clone_limits,deadline=work_deadline)
        save(evidence/'clone-authority.json',clone_authority)
        report['stages'].append(rename_role(plan['sourceRoot'],plan['parkedRoot'],baseline['entries']['.']['information'],
            work_deadline,operation_id=plan['operationId'],phase='park-pristine',evidence=evidence,state=renames))
        report['stages'].append(rename_role(plan['workingRoot'],plan['sourceRoot'],clone_authority['rootInformation'],
            work_deadline,operation_id=plan['operationId'],phase='activate-working',evidence=evidence,state=renames))
        clone.finalize_renamed_root(clone_authority,plan['sourceRoot'],deadline=work_deadline)
        before=tree('before-startup')
        report['preStartComparison']=assert_working_baseline(baseline,before)
        host,report['hostRetirement']=run_host(plan,evidence,work_deadline,deadline,ownership)
        report['hostResult']={'path':str(evidence/'host-result.json'),'sha256':recovery.digest(evidence/'host-result.json')}
        after=tree('after-startup')
        need(host.get('passed') is True and len(host['observedNativePids']) > 0,'Original maintained startup did not qualify')
        manifest,_=json_read(plan['appManifest'])
        derivation={'kind':'maintained-local-configuration','releaseRoot':plan['releaseRoot'],
                    'sourceRefs':plan['sourceRefs'],'hostResult':host}
        # Builder references are the exact subset inside the admitted release.
        derivation['sourceRefs']=[r for r in plan['sourceRefs'] if Path(r['path']).is_relative_to(Path(plan['releaseRoot']))]
        report['comparison']=recovery.local_windows_native_saved_state(before,after,node=plan['node'],
            app_releases=[(plan['releaseRoot'],manifest),(plan['releaseRoot'],manifest)],
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
                report['stages'].append(rename_role(plan['parkedRoot'],plan['sourceRoot'],baseline['entries']['.']['information'],
                    deadline,operation_id=plan['operationId'],phase='return-pristine',evidence=evidence,state=renames))
                clone.finalize_renamed_root(baseline,plan['sourceRoot'],deadline=deadline)
                restored=tree('restored-original',restoring=True)
                report['restorationComparison']=assert_restored(baseline,restored)
                report['restored']=True
            except BaseException as error:
                report['restorationError']=error_record(error)
        report['qualified']=primary is None and report['restored']
        report['originalOwnerClosed']=host_closed
        report['ownerState']=ownership
        report['renameStates']=renames
        report['endedEpochMs']=time.time_ns()//1000000
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
