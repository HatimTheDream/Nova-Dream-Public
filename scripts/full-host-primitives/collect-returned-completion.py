"""Read the returned rehearsal's original, protected startup receipts."""

import hashlib
import json
import os
from pathlib import Path
import stat


def returned_check(ok, message):
    if not ok:
        raise ValueError(message)


def returned_role_limits():
    limits = {}
    for attempt in (1, 2, 3):
        roles = ['capacity', 'capture-before', 'fork-observed', 'process', 'ready', 'started']
        if attempt < 3:
            roles.extend(('capture-closed', 'capture-writer', 'closed'))
        for role in roles:
            limits[f'startup-{attempt}-{role}.json'] = 131072 if role in ('capture-before', 'capture-closed') else 65536
    return limits


def returned_unique(pairs):
    result = dict(pairs)
    returned_check(len(result) == len(pairs), 'Duplicate startup receipt key.')
    return result


def returned_stat(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def returned_file(path, limit):
    protected(path, private=True)
    before = path.lstat()
    returned_check(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= limit,
                   'Returned receipt is linked, empty or oversized.')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOATIME)
    with os.fdopen(fd, 'rb') as stream:
        returned_check(returned_stat(os.fstat(fd)) == returned_stat(before), 'Returned receipt was replaced.')
        raw = stream.read(limit + 1)
        returned_check(len(raw) == before.st_size and returned_stat(os.fstat(fd)) == returned_stat(before)
                       and returned_stat(path.lstat()) == returned_stat(before), 'Returned receipt changed while reading.')
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}, json.loads(raw, object_pairs_hook=returned_unique)


def returned_roster(output, values, detail, expected=None):
    limits = returned_role_limits()
    expected_dir = Path('/var/lib/nova-operator-rehearsals') / ('rehearsal-' + values['leaseId'])
    returned_check(output == expected_dir, 'Returned proof directory differs.')
    protected(output, directory=True, private=True)
    original_dir = returned_stat(output.stat())
    def names():
        with os.scandir(output) as entries:
            found = set()
            for entry in entries:
                if entry.name.startswith('startup-') and entry.name.endswith('.json'):
                    returned_check(entry.name in limits, 'Unexpected returned startup role.')
                    found.add(entry.name)
        return found
    returned_check(names() == set(limits), 'Returned startup roster is incomplete.')
    if expected is not None:
        returned_check(type(expected) is dict and expected.keys() == limits.keys(), 'Planned returned roster differs.')
    docs, rows = {}, {}
    total = 0
    for name, limit in sorted(limits.items()):
        row, docs[name] = returned_file(output / name, min(limit, 1024 * 1024 - total))
        if expected is not None:
            wanted = expected[name]
            returned_check(type(wanted) is dict and type(wanted.get('bytes')) is int and wanted == row,
                           'Original returned startup receipt changed: ' + name)
        rows[name] = row
        total += row['bytes']

    lease, candidate, epoch = (values[k] for k in ('leaseId', 'candidateId', 'workspaceEpoch'))
    budgets = detail['startupCapacityBudgets']
    returned_check([b['attempt'] for b in budgets] == [1, 2, 3], 'Actual three startup budgets required.')
    def canonical(data):
        return json.dumps(data, separators=(',', ':'), sort_keys=True, allow_nan=False)
    for i, budget in enumerate(budgets, 1):
        def doc(role):
            return docs[f'startup-{i}-{role}.json']
        def digest(role):
            return rows[f'startup-{i}-{role}.json']['sha256']
        owner = [lease, candidate, i]
        returned_check(budget['receiptSha256'] == digest('capacity')
                       and canonical(doc('capacity')) == canonical({k:v for k,v in budget.items() if k != 'receiptSha256'}),
                       'Capacity disagrees with accepted rehearsal evidence.')
        for role in ('started', 'process', 'ready', 'capture-before'):
            state = doc(role)
            returned_check([state['jobId'], state['candidateId'], state['attempt']] == owner and state['epoch'] == epoch,
                           'Startup receipt belongs to another rehearsal.')
        returned_check(doc('fork-observed')['startedReceiptSha256'] == digest('started')
                       and doc('process')['bindingReceiptSha256'] == digest('fork-observed')
                       and doc('ready')['processReceiptSha256'] == digest('process'), 'Startup process lineage changed.')
        if i < 3:
            captured, writer, closed = doc('capture-closed'), doc('capture-writer'), doc('closed')
            returned_check([captured['jobId'], captured['candidateId'], captured['attempt']] == writer['owner'] == owner
                           and captured['epoch'] == writer['epoch'] == epoch and captured['beforeSha256'] == digest('capture-before')
                           and closed['readyReceiptSha256'] == digest('ready') and closed['owningServiceFullyStopped'] is True,
                           'Settled capture receipt lineage changed.')
            marked = captured['deferredCapture']
            returned_check(marked['owner'] == owner and marked['epoch'] == epoch, 'Closed capture has a different owner.')
            if marked['writerSha256'] is not None:
                returned_check(marked['writerSha256'] == hashlib.sha256(canonical(writer).encode()).hexdigest(),
                               'Closed capture writer commitment differs.')
    custody = Path(values['stateDirectory'])/'operator-maintenance'/lease/'native-capture-source.json'
    custody_row, source = returned_file(custody, 65536)
    returned_check(custody_row['sha256'] == detail['nativeCaptureSourceSha256'] and source['output'] == str(output)
                   and source['leaseId'] == lease and source['candidateId'] == candidate and source['epoch'] == epoch,
                   'Accepted original capture source differs.')
    origin = source['originalSource']
    held_path = output/'held-prior-native-capture.json'
    held_row, held = returned_file(held_path, 1024*1024)
    returned_check(origin == {'path':str(held_path), 'sha256':held_row['sha256']} and held['owner'] == [lease,candidate,0]
                   and held['epoch'] == epoch, 'Original held capture authority differs.')
    _, moved = returned_file(output/'returned-original-capture.json', 65536)
    before3 = docs['startup-3-capture-before.json']['deferredBefore']
    returned_check(moved['leaseId'] == lease and moved['candidateId'] == candidate and moved['workspaceEpoch'] == epoch
                   and moved['snapshotManifestSha256'] == detail['snapshotManifestSha256']
                   and moved['returnedPhysicalRoot'] == source['returnedRoot'] and moved['heldSourceSha256'] == held_row['sha256']
                   and moved['trialCaptureSha256'] == rows['startup-1-capture-closed.json']['sha256']
                   and before3['predecessor'] == {'path':str(output/'startup-2-capture-closed.json'),
                                                  'sha256':rows['startup-2-capture-closed.json']['sha256']},
                   'Original return or subsequent restart predecessor changed.')
    returned_check(names() == set(limits) and returned_stat(output.stat()) == original_dir, 'Returned directory changed.')
    return rows
