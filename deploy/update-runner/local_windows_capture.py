"""Bounded, closed-workspace Windows capture; no CLI or import-time effects.

The caller supplies a stopped-workspace/process proof and an absolute monotonic
deadline. This records source observations, not snapshot inode equivalence.
Only owner/group/DACL are requested; SACL authority is deliberately absent.
Unknown streams, reparse kinds, aliases, races and process states refuse capture.
"""
import base64
import copy
import ctypes
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import struct
import subprocess
import time

PRIMITIVE_SHA256 = 'c7022c40ebdb88f3ee55b768e87a15b22fb724a16bfb07bfcc095e393d0c876e'
MOUNT_POINT = 0xA0000003
REPARSE = 0x400
STREAM_BUFFER = 65536
NODE_FIELDS = frozenset(('dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'))
LIMIT_FIELDS = frozenset(('node', 'maxEntries', 'maxBytes', 'maxFileBytes', 'maxDepth', 'maxAliases', 'maxReportBytes'))
_module = None


class CaptureRefused(RuntimeError):
    def __init__(self, reason, observations=None):
        super().__init__(reason)
        self.observations = observations or {}
        self.unresolved_handle = self.observations.get('unresolvedHandle') is True


def require(value, reason, observations=None):
    if not value:
        raise CaptureRefused(reason, observations)


def _check(deadline):
    require(type(deadline) in (int, float) and math.isfinite(deadline)
            and time.monotonic() < deadline, 'capture-deadline-expired')


def _error(error):
    return {'type': type(error).__name__, 'message': str(error)[:2048],
            'errno': getattr(error, 'errno', None), 'winerror': getattr(error, 'winerror', None)}


def _primitive():
    global _module
    if _module is None:
        path = Path(__file__).with_name('windows_same_handle.py')
        raw = path.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == PRIMITIVE_SHA256, 'same-handle-source-changed')
        spec = importlib.util.spec_from_file_location('_local_qualified_same_handle', path)
        module = importlib.util.module_from_spec(spec)
        exec(compile(raw, str(path), 'exec'), module.__dict__)
        _module = module
    return _module


def _absolute(value):
    require(isinstance(value, (str, os.PathLike)), 'absolute-path-required')
    require(os.path.isabs(os.fspath(value)), 'absolute-path-required')
    path = Path(os.path.abspath(os.fspath(value)))
    require(path.is_absolute() and '\x00' not in str(path), 'absolute-path-required')
    return path


def _windows_required():
    require(os.name == 'nt', 'windows-required')


def _below(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _stat_row(value):
    return {name: getattr(value, name, None) for name in
            ('st_dev', 'st_ino', 'st_mode', 'st_size', 'st_mtime_ns', 'st_ctime_ns',
             'st_birthtime_ns', 'st_nlink', 'st_file_attributes', 'st_reparse_tag')}


def _reparse(value):
    return bool(getattr(value, 'st_file_attributes', 0) & REPARSE) or stat.S_ISLNK(value.st_mode)


def _common(value):
    return (value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode), value.st_size,
            value.st_mtime_ns, getattr(value, 'st_birthtime_ns', None), value.st_nlink)


def _identity_join(row, info, kind):
    # CPython's Windows path identity uses FileIdInfo; Node's identity below
    # independently uses the legacy volume/index pair. Neither is fabricated.
    require(row.st_dev == info['volumeSerial64']
            and row.st_ino == int.from_bytes(bytes.fromhex(info['fileId128Hex']), 'little')
            and stat.S_ISDIR(row.st_mode) == (kind != 'file')
            and stat.S_ISREG(row.st_mode) == (kind == 'file'),
            'path-native-identity-mismatch', {'path': _stat_row(row), 'native': info})


def _junction_target(raw, root, vendor):
    require(type(raw) is str and raw and '\x00' not in raw, 'junction-target-required')
    target = raw[4:] if raw.startswith('\\\\?\\') else raw
    p = PureWindowsPath(target)
    require(p.is_absolute() and re.fullmatch('[A-Za-z]:', p.drive)
            and not any(part in ('.', '..') for part in p.parts), 'ordinary-junction-target-required')
    for role, base in (('root', PureWindowsPath(root)), ('vendor', PureWindowsPath(vendor))):
        try:
            p.relative_to(base)
            return str(p), role
        except ValueError:
            pass
    raise CaptureRefused('junction-escape-refused', {'rawTarget': raw})


def parse_streams(raw):
    """Parse a successful fixed-size FILE_STREAM_INFO buffer, ignoring padding."""
    require(type(raw) is bytes and len(raw) == STREAM_BUFFER, 'stream-buffer-size')
    result, offset = [], 0
    for _ in range(128):
        require(offset + 24 <= len(raw), 'stream-header-truncated')
        following, size, length, allocated = struct.unpack_from('<IIqq', raw, offset)
        require(size > 0 and size % 2 == 0 and size <= 4096 and length >= 0 and allocated >= 0,
                'invalid-stream-header')
        end = offset + 24 + size
        require(end <= len(raw), 'stream-name-truncated')
        name = raw[offset + 24:end].decode('utf-16-le', 'strict')
        require(name == '::$DATA' and not result, 'unknown-or-duplicate-stream', {'name': name})
        result.append({'name': name, 'bytes': length, 'allocationBytes': allocated,
                       'rawBase64': base64.b64encode(raw[offset:end]).decode('ascii')})
        if not following:
            return result
        require(following % 8 == 0 and following >= 24 + size
                and offset + following + 24 <= len(raw), 'invalid-stream-offset')
        offset += following
    raise CaptureRefused('stream-count-exceeded')


def _info_checked(info, kind):
    native = _primitive()
    if kind != 'junction':
        return native.checked_info(info, kind)
    require(type(info) is dict and set(info) == native.INFO_FIELDS, 'junction-full-information-required')
    require(all(type(info[k]) is int and info[k] >= 0 for k in
                native.INFO_FIELDS - {'fileId128Hex', 'directory', 'deletePending'}), 'junction-native-integers')
    require(type(info['fileId128Hex']) is str and re.fullmatch('[0-9a-f]{32}', info['fileId128Hex'])
            and info['fileId128Hex'] != '0' * 32 and info['fileIndex64'] > 0
            and info['volumeSerial32'] <= 0xffffffff and info['fileIndex64'] <= 0xffffffffffffffff
            and info['volumeSerial64'] <= 0xffffffffffffffff
            and info['attributes'] <= 0xffffffff and info['reparseTag'] == MOUNT_POINT
            and info['links'] <= 0xffffffff and all(info[k] <= 0x7fffffffffffffff for k in
                ('size', 'allocationBytes', 'creation100ns', 'access100ns', 'write100ns', 'change100ns'))
            and info['attributes'] & REPARSE and info['attributes'] & 0x10
            and info['directory'] is True and info['deletePending'] is False and info['links'] >= 1,
            'ordinary-junction-information-required')
    return info


class _Held:
    """One qualified metadata port per handle; setup + streams stay below 64 calls."""
    def __init__(self, path, kind, deadline):
        self.path, self.kind, self.deadline = path, kind, deadline
        self.port, self.handle, self.closed = _primitive().Win32(), None, False
        self.evidence = {'path': str(path), 'kind': kind}
        try:
            _check(deadline)
            native = _primitive()
            native.canonical_path(str(path))
            p = self.port
            anchor = PureWindowsPath(path).anchor
            require(p.call('GetDriveTypeW', p.k.GetDriveTypeW, (anchor,), {'root': anchor}) == 3,
                    'fixed-drive-required')
            share = 3 if kind == 'directory' else 1
            self.handle = p.call('CreateFileW', p.k.CreateFileW,
                (str(path), 0x20080, share, None, 3, 0x02200000, None),
                {'path': str(path), 'access': 0x20080, 'share': share, 'disposition': 3, 'flags': 0x02200000})
            p.require(self.handle not in (None, ctypes.c_void_p(-1).value), 'CreateFileW')
            self.evidence['openedInformation'] = _info_checked(p.info(self.handle), kind)
        except BaseException as error:
            close_error = None
            try:
                self.close()
            except BaseException as exc:
                close_error = _error(exc)
            raise CaptureRefused('native-open-refused', {**self.evidence, 'original': _error(error),
                'closeError': close_error, 'unresolvedHandle': close_error is not None,
                'apiEvents': self.port.events}) from error

    def streams(self):
        _check(self.deadline)
        buffer = (ctypes.c_uint64 * (STREAM_BUFFER // 8))()
        p = self.port
        ok = p.call('GetFileInformationByHandleEx:streams', p.k.GetFileInformationByHandleEx,
                    (self.handle, 7, buffer, STREAM_BUFFER),
                    {'handle': self.handle, 'class': 7, 'bytes': STREAM_BUFFER})
        raw = bytes(buffer)
        try:
            if p.last_error == 38 and raw == bytes(STREAM_BUFFER):
                require(self.kind != 'file', 'file-default-stream-missing')
                rows = []
            else:
                p.require(ok, 'GetFileInformationByHandleEx:streams')
                rows = parse_streams(raw)
            if self.kind == 'file':
                require(len(rows) == 1, 'file-default-stream-required')
            else:
                require(all(row['bytes'] == 0 and row['allocationBytes'] == 0 for row in rows),
                        'directory-data-stream-refused')
        except BaseException as error:
            raise CaptureRefused('stream-observation-refused', {'path': str(self.path),
                'original': _error(error), 'originalObservations': getattr(error, 'observations', None),
                'result': bool(ok), 'lastError': p.last_error,
                'rawStreamBufferBase64': base64.b64encode(raw).decode('ascii')}) from error
        self.evidence['streams'] = rows
        return rows

    def capture(self):
        _check(self.deadline)
        p, h, native = self.port, self.handle, _primitive()
        first = self.evidence['before'] = copy.deepcopy(p.info(h))
        _info_checked(first, self.kind)
        sec1 = native.checked_security(p.security(h))
        self.evidence['ownerGroupDaclBeforeBase64'] = base64.b64encode(sec1).decode('ascii')
        _check(self.deadline)
        sec2 = native.checked_security(p.security(h))
        self.evidence['ownerGroupDaclAfterBase64'] = base64.b64encode(sec2).decode('ascii')
        last = self.evidence['after'] = copy.deepcopy(p.info(h))
        _info_checked(last, self.kind)
        require(first == last and sec1 == sec2, 'same-handle-information-or-security-changed', self.evidence)
        opened = self.evidence['openedInformation']
        require(all(first[k] == opened[k] for k in
                    ('volumeSerial32', 'fileIndex64', 'volumeSerial64', 'fileId128Hex', 'creation100ns',
                     'directory', 'reparseTag')), 'held-object-identity-changed', self.evidence)
        return {'information': first, 'security': {'ownerGroupDaclBase64': self.evidence['ownerGroupDaclBeforeBase64'],
                'saclNotRequested': True}, 'streams': self.evidence['streams'], 'sameHandleStable': True,
                'nativeObservations': self.evidence}

    def close(self):
        if self.handle not in (None, ctypes.c_void_p(-1).value) and not self.closed:
            # Mark attempted before call: never retry an uncertain CloseHandle.
            self.closed = True
            self.port.close(self.handle)
            self.evidence['handleClosed'] = True


NODE_STAT_SCRIPT = r"""
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(input) || input.length > 100000) throw Error('bounded roster required');
const rows = input.map(path => {
  if (typeof path !== 'string' || path.length > 4096) throw Error('bounded path required');
  const s = fs.statSync(path, {bigint:true});
  if (!s.isFile() && !s.isDirectory()) throw Error('ordinary target required');
  return {path, identity:Object.fromEntries(['dev','ino','mode','size','mtimeNs','ctimeNs','birthtimeNs'].map(k=>[k,String(s[k])]))};
});
process.stdout.write(JSON.stringify(rows));
"""
NODE_RETIRE_SCRIPT = r"""
const fs = require('node:fs');
const pids = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(pids) || pids.length > 1024) throw Error('bounded PID list required');
const rows = pids.map(pid => {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) throw Error('invalid PID');
  try { process.kill(pid,0); return {pid,retired:false,code:'ALIVE'}; }
  catch (error) { return {pid,retired:error.code==='ESRCH',code:error.code || 'UNKNOWN'}; }
});
process.stdout.write(JSON.stringify(rows));
"""


def _node(node, script, values, deadline):
    _check(deadline)
    node = _absolute(node)
    row = node.lstat()
    require(stat.S_ISREG(row.st_mode) and not _reparse(row), 'ordinary-node-executable-required')
    raw = json.dumps(values, ensure_ascii=True).encode('ascii')
    require(len(raw) <= 32 * 1024 * 1024, 'node-input-budget-exceeded')
    env = {k: v for k, v in os.environ.items() if k.upper() in ('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP')}
    result = subprocess.run([str(node), '-e', script], input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env, timeout=min(30, max(.001, deadline - time.monotonic())),
        creationflags=getattr(subprocess, 'DETACHED_PROCESS', 0))
    require(result.returncode == 0 and len(result.stdout) <= 64 * 1024 * 1024,
            'node-observation-refused', {'returncode': result.returncode,
              'stderr': result.stderr[:8192].decode('utf8', 'replace')})
    _check(deadline)
    return json.loads(result.stdout)


def node_identities(node, paths, deadline):
    values = [str(_absolute(path)) for path in paths]
    require(len(values) <= 100000 and len(set(values)) == len(values), 'bounded-unique-node-paths-required')
    rows = _node(node, NODE_STAT_SCRIPT, values, deadline)
    require(type(rows) is list and len(rows) == len(values), 'complete-node-identities-required')
    result = {}
    for path, row in zip(values, rows):
        require(type(row) is dict and set(row) == {'path', 'identity'} and row['path'] == path,
                'node-path-order-changed')
        identity = row['identity']
        require(type(identity) is dict and set(identity) == NODE_FIELDS and
                all(type(v) is str and re.fullmatch('0|[1-9][0-9]*', v) for v in identity.values()),
                'typed-node-identity-required')
        require(int(identity['ino']) > 0 and stat.S_IFMT(int(identity['mode'])) in (stat.S_IFREG, stat.S_IFDIR),
                'ordinary-node-identity-required')
        result[path] = identity
    return result


def assert_processes_retired(node, pids, deadline):
    require(type(pids) is list and len(pids) <= 1024 and len(set(pids)) == len(pids)
            and all(type(pid) is int and 0 < pid <= 0xffffffff for pid in pids), 'bounded-original-pids-required')
    rows = _node(node, NODE_RETIRE_SCRIPT, pids, deadline)
    require(type(rows) is list and len(rows) == len(pids), 'complete-retirement-observation-required')
    for pid, row in zip(pids, rows):
        require(type(row) is dict and set(row) == {'pid', 'retired', 'code'} and row['pid'] == pid
                and row['retired'] is True and row['code'] == 'ESRCH', 'process-not-proven-retired', {'rows': rows})
    return {'format': 1, 'allRetired': True, 'observations': rows}


def _node_join(identity, info):
    require(int(identity['dev']) == info['volumeSerial32'] and int(identity['ino']) == info['fileIndex64']
            and stat.S_ISDIR(int(identity['mode'])) == info['directory']
            and int(identity['size']) == info['size']
            and int(identity['birthtimeNs']) == (info['creation100ns'] - 116444736000000000) * 100
            and int(identity['mtimeNs']) == (info['write100ns'] - 116444736000000000) * 100,
            'node-native-identity-mismatch', {'node': identity, 'native': info})


def _copy_default(source, target, limit, deadline):
    before = source.lstat()
    require(stat.S_ISREG(before.st_mode) and not _reparse(before) and before.st_nlink == 1,
            'ordinary-single-link-source-required')
    h, total = hashlib.sha256(), 0
    observations = {'pathBefore': _stat_row(before)}
    with source.open('rb') as incoming:
        opened = os.fstat(incoming.fileno())
        observations['opened'] = _stat_row(opened)
        require(_common(before) == _common(opened), 'copy-open-identity-changed', observations)
        with target.open('xb') as outgoing:
            while True:
                _check(deadline)
                chunk = incoming.read(min(1024 * 1024, limit - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                require(total <= limit, 'copy-file-budget-exceeded', observations)
                h.update(chunk)
                require(outgoing.write(chunk) == len(chunk), 'snapshot-short-write')
            outgoing.flush()
            os.fsync(outgoing.fileno())
        path_after = source.lstat()
        observations['pathAfter'] = _stat_row(path_after)
        final = os.fstat(incoming.fileno())
        observations['after'] = _stat_row(final)
        require(_common(before) == _common(path_after) and _stat_row(opened) == _stat_row(final)
                and total == opened.st_size, 'copy-read-identity-changed', observations)
    return {'bytes': total, 'sha256': h.hexdigest(), 'copyObservations': observations}


def _relative(key):
    require(type(key) is str and key and '\\' not in key and '\x00' not in key,
            'relative-snapshot-path-required')
    if key == '.':
        return Path()
    parts = key.split('/')
    require(all(p and p not in ('.', '..') and ':' not in p for p in parts), 'relative-snapshot-path-required')
    return Path(*parts)


def verify_capture_content(capture, deadline):
    """Revalidate ordinary snapshot roster and bytes; never interpret its IDs as source IDs."""
    _check(deadline)
    require(type(capture) is dict and capture.get('complete') is True
            and capture.get('kind') == 'local-windows-closed-tree', 'complete-capture-required')
    root = _absolute(capture['destinationRoot'])
    expected, found = capture['entries'], {}
    require(type(expected) is dict and '.' in expected, 'complete-snapshot-roster-required')
    pending = [('.', root)]
    while pending:
        _check(deadline)
        key, path = pending.pop()
        require(key not in found and key in expected and root / _relative(key) == path, 'snapshot-roster-changed')
        row = path.lstat()
        require(not _reparse(row), 'snapshot-link-refused')
        if stat.S_ISDIR(row.st_mode):
            require(expected[key]['kind'] == 'directory', 'snapshot-kind-changed')
            found[key] = 'directory'
            for name in sorted(os.listdir(path), reverse=True):
                child = name if key == '.' else key + '/' + name
                pending.append((child, path / name))
        else:
            require(stat.S_ISREG(row.st_mode) and row.st_nlink == 1
                    and expected[key]['kind'] == 'file', 'snapshot-kind-changed')
            h, total = hashlib.sha256(), 0
            with path.open('rb') as stream:
                opened = os.fstat(stream.fileno())
                require(_common(row) == _common(opened), 'snapshot-open-changed')
                while True:
                    _check(deadline)
                    block = stream.read(1024 * 1024)
                    if not block:
                        break
                    total += len(block)
                    require(total <= expected[key]['bytes'], 'snapshot-size-changed')
                    h.update(block)
                require(_stat_row(opened) == _stat_row(os.fstat(stream.fileno()))
                        and _common(row) == _common(path.lstat()), 'snapshot-read-changed')
            require(total == expected[key]['bytes'] and h.hexdigest() == expected[key]['sha256'], 'snapshot-content-changed')
            found[key] = 'file'
    require(set(found) == set(expected), 'snapshot-roster-changed')
    return True


def capture_closed_tree(root, destination, *, vendor_root, limits, deadline):
    _check(deadline)
    _windows_required()
    require(type(limits) is dict and set(limits) == LIMIT_FIELDS, 'closed-capture-limits-required')
    ceilings = {'maxEntries': 100000, 'maxBytes': 64 * 1024**3, 'maxFileBytes': 2 * 1024**3,
                'maxDepth': 128, 'maxAliases': 1024, 'maxReportBytes': 256 * 1024**2}
    require(all(type(limits[k]) is int and 0 < limits[k] <= cap for k, cap in ceilings.items()), 'capture-limit-range')
    root, destination, vendor = _absolute(root), _absolute(destination), _absolute(vendor_root)
    require(not _below(destination, root) and not _below(root, destination)
            and not _below(destination, vendor) and not _below(vendor, destination), 'disjoint-snapshot-required')
    report = {'format': 1, 'kind': 'local-windows-closed-tree', 'sourceRoot': str(root),
              'canonicalSourceRoot': os.path.realpath(root), 'destinationRoot': str(destination),
              'startedEpochMs': time.time_ns() // 1000000, 'entries': {}, 'junctions': [], 'complete': False,
              'primitiveSha256': PRIMITIVE_SHA256, 'saclNotRequested': True}
    held, inventory, listing, cache, file_evidence, junction_evidence = {}, {}, {}, {}, {}, {}
    failure, close_errors = None, []
    total, report_bytes = 0, 4096

    def record_budget(value):
        nonlocal report_bytes
        report_bytes += len(json.dumps(value, ensure_ascii=True).encode('ascii')) + 256
        require(report_bytes <= limits['maxReportBytes'], 'capture-report-budget-exceeded',
                {'estimatedBytes': report_bytes, 'maximumBytes': limits['maxReportBytes']})

    def hold(path, kind):
        nonlocal held
        name = str(path)
        if name not in held:
            before = path.lstat()
            require(_reparse(before) == (kind == 'junction'), 'path-reparse-kind-changed')
            port = _Held(path, kind, deadline)
            held[name] = port
            _identity_join(before, port.evidence['openedInformation'], kind)
            after = path.lstat()
            require(_common(before) == _common(after), 'held-path-identity-changed')
        require(held[name].kind == kind and not held[name].closed, 'held-path-kind-changed')
        return held[name]

    def ordinary_chain(path):
        for ancestor in reversed((path, *path.parents)):
            row = ancestor.lstat()
            require(stat.S_ISDIR(row.st_mode) and not _reparse(row), 'ordinary-ancestor-required', {'path': str(ancestor)})
            # The fixed drive root cannot be renamed as a child directory; the
            # qualified primitive deliberately accepts only paths below it.
            if ancestor != Path(ancestor.anchor):
                hold(ancestor, 'directory')

    def visit(path, key, active, depth):
        nonlocal total
        _check(deadline)
        require(depth <= limits['maxDepth'] and len(inventory) < limits['maxEntries'], 'tree-roster-budget-exceeded')
        require(key not in inventory, 'duplicate-logical-path')
        row = path.lstat()
        # Always inspect the reparse tag before directory handling. Junctions
        # are inventoried explicitly, then materialized as ordinary snapshots.
        if _reparse(row):
            require(getattr(row, 'st_reparse_tag', 0) == MOUNT_POINT, 'unknown-reparse-kind')
            port = hold(path, 'junction')
            raw = os.readlink(path)
            target, role = _junction_target(raw, str(root), str(vendor))
            target = Path(target)
            ordinary_chain(target)
            require(len(report['junctions']) < limits['maxAliases'], 'junction-budget-exceeded')
            require(os.readlink(path) == raw, 'junction-target-changed')
            report['junctions'].append({'path': key, 'rawTarget': raw, 'canonicalTarget': str(target),
                                       'targetRole': role, 'physicalPath': str(path)})
            return visit(target, key, active, depth)
        if stat.S_ISDIR(row.st_mode):
            hold(path, 'directory')
            canonical = str(path)
            require(canonical.casefold() not in active, 'junction-cycle-refused')
            names = sorted(os.listdir(path))
            require(len({name.casefold() for name in names}) == len(names), 'ambiguous-directory-names')
            listing[canonical] = names
            inventory[key] = {'kind': 'directory', 'physical': canonical}
            for name in names:
                require(name not in ('.', '..') and '/' not in name and '\\' not in name and ':' not in name,
                        'ordinary-directory-member-required')
                visit(path / name, name if key == '.' else key + '/' + name, active | {canonical.casefold()}, depth + 1)
        else:
            require(stat.S_ISREG(row.st_mode) and row.st_nlink == 1, 'ordinary-single-link-file-required')
            require(row.st_size <= limits['maxFileBytes'], 'file-size-budget-exceeded')
            total += row.st_size
            require(total <= limits['maxBytes'], 'expanded-copy-budget-exceeded')
            inventory[key] = {'kind': 'file', 'physical': str(path), 'plannedBytes': row.st_size}

    try:
        ordinary_chain(root)
        ordinary_chain(vendor)
        ordinary_chain(destination.parent)
        require(not os.path.lexists(destination), 'fresh-destination-required')
        visit(root, '.', set(), 0)
        logical = [str(root / _relative(key)) for key in inventory]
        before_node = node_identities(limits['node'], logical, deadline)
        destination.mkdir()
        hold(destination, 'directory')
        for key, item in inventory.items():
            _check(deadline)
            target, source = destination / _relative(key), Path(item['physical'])
            if item['kind'] == 'directory':
                if key != '.':
                    target.mkdir()
                    hold(target, 'directory')
                continue
            if str(source) not in cache:
                port = hold(source, 'file')
                original = close_error = None
                try:
                    data = _copy_default(source, target, limits['maxFileBytes'], deadline)
                    streams = port.streams()
                    captured = port.capture()
                    require(data['bytes'] == item['plannedBytes'] == captured['information']['size']
                            and streams[0]['bytes'] == data['bytes']
                            and streams[0]['allocationBytes'] == captured['information']['allocationBytes'],
                            'copied-default-stream-size-or-allocation-changed')
                    file_evidence[str(source)] = {**data, **captured}
                    cache[str(source)] = target
                    hold(target, 'file')
                except BaseException as error:
                    original = error
                finally:
                    try:
                        port.close()
                    except BaseException as error:
                        close_error = error
                if original is not None or close_error is not None:
                    raise CaptureRefused('file-copy-or-close-refused', {'path': str(source),
                        'original': _error(original) if original else None,
                        'originalObservations': getattr(original, 'observations', None),
                        'closeError': _error(close_error) if close_error else None,
                        'nativeObservations': port.evidence, 'apiEvents': port.port.events}) from original
            else:
                copied = _copy_default(cache[str(source)], target, limits['maxFileBytes'], deadline)
                require(copied['sha256'] == file_evidence[str(source)]['sha256']
                        and copied['bytes'] == file_evidence[str(source)]['bytes'], 'alias-copy-changed')
                hold(target, 'file')
        for physical, names in listing.items():
            _check(deadline)
            require(sorted(os.listdir(physical)) == names, 'source-membership-changed', {'path': physical})
        for alias in report['junctions']:
            require(os.readlink(root / _relative(alias['path'])) == alias['rawTarget'], 'junction-target-changed')
        after_node = node_identities(limits['node'], logical, deadline)
        require(before_node == after_node, 'node-source-identity-changed', {'before': before_node, 'after': after_node})
        for alias in report['junctions']:
            physical = alias['physicalPath']
            if physical not in junction_evidence:
                port = held[physical]
                port.streams()
                junction_evidence[physical] = port.capture()
            alias.update(junction_evidence[physical])
            record_budget(alias)
        directory_evidence = {}
        for key, item in inventory.items():
            _check(deadline)
            physical = item['physical']
            if item['kind'] == 'directory' and physical not in directory_evidence:
                port = held[physical]
                port.streams()
                directory_evidence[physical] = port.capture()
            captured = directory_evidence[physical] if item['kind'] == 'directory' else file_evidence[physical]
            identity = after_node[str(root / _relative(key))]
            _node_join(identity, captured['information'])
            entry = {'kind': item['kind'], 'physicalPath': physical,
                **captured, 'nodeIdentity': identity, 'nodeIdentityBefore': before_node[str(root / _relative(key))]}
            record_budget({key: entry})
            report['entries'][key] = entry
        report['expandedBytes'] = total
        report['physicalFileReads'] = len(cache)
        # Snapshot roots/backing files remain held while the complete no-link
        # roster and hashes are verified. Only then may any hold be released.
        report['complete'] = True
        verify_capture_content(report, deadline)
    except BaseException as error:
        failure = error
    finally:
        for name, port in reversed(list(held.items())):
            try:
                port.close()
            except BaseException as error:
                close_errors.append({'path': name, 'error': _error(error)})
        report['allHandlesClosed'] = (not close_errors and not getattr(failure, 'unresolved_handle', False)
                                     and all(p.evidence.get('handleClosed') for p in held.values()))
        report['endedEpochMs'] = time.time_ns() // 1000000
    if failure is not None or close_errors:
        report['complete'] = False
        report['originalError'] = _error(failure) if failure is not None else None
        report['failureObservations'] = getattr(failure, 'observations', None)
        report['closeErrors'] = close_errors
        raise CaptureRefused('closed-tree-capture-refused', report) from failure
    try:
        _check(deadline)
        require(report['allHandlesClosed'], 'unclosed-native-capture')
        report['complete'] = True
        require(len(json.dumps(report, ensure_ascii=True).encode('ascii')) <= limits['maxReportBytes'], 'capture-report-budget-exceeded')
    except BaseException as error:
        report['complete'] = False
        report['originalError'] = _error(error)
        raise CaptureRefused('closed-tree-final-verification-refused', report) from error
    return report
