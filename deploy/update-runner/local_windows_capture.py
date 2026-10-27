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
import zlib

PRIMITIVE_SHA256 = 'c7022c40ebdb88f3ee55b768e87a15b22fb724a16bfb07bfcc095e393d0c876e'
MOUNT_POINT = 0xA0000003
REPARSE = 0x400
STREAM_BUFFER = 65536
MAX_REPORT_BYTES = 384 * 1024**2
LEGACY_MAX_REPORT_BYTES = 256 * 1024**2
# Six retained/temporary report graphs at a conservative sixfold object budget,
# two simultaneous serialized buffers, and a separate 2 GiB process reserve.
# This finite admission allowance is not a claim of physical-RAM residency.
REPORT_COMMIT_MULTIPLIER = 38
REPORT_COMMIT_RESERVE_BYTES = 2 * 1024**3
NODE_FIELDS = frozenset(('dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'))
PRESERVED_BASIC_FIELDS = ('creation100ns', 'access100ns', 'write100ns', 'change100ns', 'attributes')
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


def required_report_commit_bytes(max_report_bytes):
    require(type(max_report_bytes) is int and 0 < max_report_bytes <= MAX_REPORT_BYTES,
            'report-memory-budget-range')
    return REPORT_COMMIT_MULTIPLIER * max_report_bytes + REPORT_COMMIT_RESERVE_BYTES


def observe_windows_commit_capacity():
    """Read current system commit pages; never resize pagefiles or change settings.

    https://learn.microsoft.com/windows/win32/api/psapi/ns-psapi-performance_information
    CommitLimit and CommitTotal are page counts, not byte or physical-RAM counts.
    """
    require(os.name == 'nt', 'windows-commit-observation-required')
    from ctypes import wintypes

    class PerformanceInformation(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD),
                    *[(name, ctypes.c_size_t) for name in (
                        'CommitTotal', 'CommitLimit', 'CommitPeak', 'PhysicalTotal',
                        'PhysicalAvailable', 'SystemCache', 'KernelTotal', 'KernelPaged',
                        'KernelNonpaged', 'PageSize')],
                    ('HandleCount', wintypes.DWORD), ('ProcessCount', wintypes.DWORD),
                    ('ThreadCount', wintypes.DWORD)]

    api = ctypes.WinDLL('psapi.dll', use_last_error=True).GetPerformanceInfo
    api.argtypes = [ctypes.POINTER(PerformanceInformation), wintypes.DWORD]
    api.restype = wintypes.BOOL
    value = PerformanceInformation()
    value.cb = ctypes.sizeof(value)
    require(bool(api(ctypes.byref(value), value.cb)), 'windows-commit-observation-failed',
            {'win32Error': ctypes.get_last_error()})
    require(0 < value.PageSize <= 1024**2 and value.CommitLimit > 0
            and value.CommitTotal <= value.CommitLimit
            and value.PhysicalAvailable <= value.PhysicalTotal,
            'windows-commit-observation-invalid')
    return {'source': 'GetPerformanceInfo', 'observedEpochMs': time.time_ns() // 1000000,
            'pageSizeBytes': value.PageSize,
            'commitLimitBytes': value.CommitLimit * value.PageSize,
            'committedBytes': value.CommitTotal * value.PageSize,
            'availableCommitBytes': (value.CommitLimit - value.CommitTotal) * value.PageSize,
            'physicalAvailableBytes': value.PhysicalAvailable * value.PageSize}


def admit_report_commit_capacity(max_report_bytes):
    """Fresh pre-effect admission only. Recovery must never call this gate."""
    required = required_report_commit_bytes(max_report_bytes)
    if max_report_bytes <= LEGACY_MAX_REPORT_BYTES:
        # Do not add a machine gate to already qualified legacy report limits.
        return {'admissionRequired': False, 'maxReportBytes': max_report_bytes,
                'reason': 'within-original-report-ceiling'}
    observed = observe_windows_commit_capacity()
    fields = {'source', 'observedEpochMs', 'pageSizeBytes', 'commitLimitBytes',
              'committedBytes', 'availableCommitBytes', 'physicalAvailableBytes'}
    require(type(observed) is dict and set(observed) == fields
            and observed['source'] == 'GetPerformanceInfo'
            and all(type(observed[key]) is int and observed[key] >= 0 for key in fields - {'source'})
            and observed['observedEpochMs'] > 0 and observed['pageSizeBytes'] > 0
            and observed['commitLimitBytes'] > 0
            and observed['committedBytes'] + observed['availableCommitBytes'] == observed['commitLimitBytes'],
            'windows-commit-observation-invalid')
    result = {**observed, 'admissionRequired': True,
              'maxReportBytes': max_report_bytes, 'requiredCommitBytes': required,
              'reportGraphEquivalents': 6, 'objectMultiplier': 6, 'serializedBuffers': 2,
              'processReserveBytes': REPORT_COMMIT_RESERVE_BYTES}
    require(observed['availableCommitBytes'] >= required,
            'report-commit-capacity-unavailable', result)
    return result


def _check(deadline):
    require(type(deadline) in (int, float) and math.isfinite(deadline)
            and time.monotonic() < deadline, 'capture-deadline-expired')


def _error(error):
    return {'type': type(error).__name__, 'message': str(error)[:2048],
            'errno': getattr(error, 'errno', None), 'winerror': getattr(error, 'winerror', None)}


class CaptureCleanupBudget:
    """Explicit caller-admitted, single-capture metadata cleanup allowance."""
    def __init__(self, work_deadline, *, maximum_seconds, effective_worker_seconds,
                 admitted_work_seconds, finalization_seconds):
        values=(work_deadline,maximum_seconds,effective_worker_seconds,
                admitted_work_seconds,finalization_seconds)
        require(all(type(value) in (int,float) and math.isfinite(value) for value in values),
                'cleanup-admission-finite-values-required')
        require(0<maximum_seconds<=900 and admitted_work_seconds>0 and finalization_seconds>0
                and effective_worker_seconds>=admitted_work_seconds+maximum_seconds+finalization_seconds,
                'cleanup-worker-timeout-not-admitted')
        _check(work_deadline)
        require(work_deadline-time.monotonic()<=admitted_work_seconds,
                'cleanup-admitted-work-does-not-bound-deadline')
        self.work_deadline=work_deadline
        self.maximum_seconds=maximum_seconds
        self.effective_worker_seconds=effective_worker_seconds
        self.admitted_work_seconds=admitted_work_seconds
        self.finalization_seconds=finalization_seconds
        self.started=None;self.deadline=None;self.claimed=False

    def claim(self, work_deadline):
        require(not self.claimed and self.started is None and work_deadline==self.work_deadline,
                'fresh-per-capture-cleanup-budget-required')
        self.claimed=True

    def validate_owner(self, work_deadline):
        require(work_deadline==self.work_deadline and self.started is None,
                'cleanup-budget-owner-after-cleanup-start-refused')

    def begin(self):
        if self.started is None:
            self.started=time.monotonic();self.deadline=self.started+self.maximum_seconds
        return self.deadline

    def receipt(self):
        return {'kind':'admitted-shared-capture-cleanup','originalWorkDeadline':self.work_deadline,
            'maximumSeconds':self.maximum_seconds,'effectiveWorkerSeconds':self.effective_worker_seconds,
            'admittedWorkSeconds':self.admitted_work_seconds,'finalizationSeconds':self.finalization_seconds,
            'startedMonotonic':self.started,'deadlineMonotonic':self.deadline}


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


def _info_checked(info, kind, *, expected_links=1):
    native = _primitive()
    require(type(expected_links) is int and 1 <= expected_links <= 100000
            and (expected_links == 1 or kind == 'file'), 'explicit-file-family-size-required')
    if expected_links > 1:
        # Format3 has a separate, explicit complete-family contract. Keep the
        # pinned single-file primitive unchanged and validate the ACTUAL tuple;
        # never substitute links=1 or omit a native field to call that primitive.
        require(type(info) is dict and set(info) == native.INFO_FIELDS, 'complete-family-handle-info-required')
        integers = native.INFO_FIELDS - {'fileId128Hex','directory','deletePending'}
        require(all(type(info[k]) is int and info[k] >= 0 for k in integers)
            and type(info['directory']) is bool and type(info['deletePending']) is bool,
            'literal-family-handle-fields-required')
        require(info['volumeSerial32'] <= 0xffffffff and info['volumeSerial64'] <= 0xffffffffffffffff
            and 0 < info['fileIndex64'] <= 0xffffffffffffffff
            and all(info[k] <= 0xffffffff for k in ('attributes','reparseTag','links'))
            and all(info[k] <= 0x7fffffffffffffff for k in ('size','allocationBytes','creation100ns',
                'access100ns','write100ns','change100ns')), 'family-native-width-bounds-required')
        require(type(info['fileId128Hex']) is str and re.fullmatch('[0-9a-f]{32}',info['fileId128Hex'])
            and info['fileId128Hex'] != '0'*32 and not info['attributes'] & 0x400
            and info['reparseTag'] == 0 and not info['deletePending'] and info['directory'] is False
            and not info['attributes'] & 0x10 and info['links'] == expected_links,
            'ordinary-exact-family-file-required')
        return info
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
    def __init__(self, path, kind, deadline, *, expected_links=1):
        self.path, self.kind, self.deadline = path, kind, deadline
        self.expected_links = expected_links
        self.port, self.handle, self.closed = _primitive().Win32(), None, False
        self.evidence = {'path': str(path), 'kind': kind}
        if expected_links != 1:
            self.evidence['expectedLinks'] = expected_links
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
            self.evidence['openedInformation'] = _info_checked(p.info(self.handle), kind, expected_links=expected_links)
        except BaseException as error:
            close_error = None
            try:
                self.close()
            except BaseException as exc:
                close_error = _error(exc)
            raise CaptureRefused('native-open-refused', {**self.evidence, 'original': _error(error),
                'closeError': close_error, 'unresolvedHandle': close_error is not None,
                'apiEvents': self.port.events}) from error

    def _metadata_deadline(self):
        return self.deadline

    def streams(self):
        _check(self._metadata_deadline())
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
        _check(self._metadata_deadline())
        p, h, native = self.port, self.handle, _primitive()
        first = self.evidence['before'] = copy.deepcopy(p.info(h))
        _info_checked(first, self.kind, expected_links=self.expected_links)
        sec1 = native.checked_security(p.security(h))
        self.evidence['ownerGroupDaclBeforeBase64'] = base64.b64encode(sec1).decode('ascii')
        _check(self._metadata_deadline())
        sec2 = native.checked_security(p.security(h))
        self.evidence['ownerGroupDaclAfterBase64'] = base64.b64encode(sec2).decode('ascii')
        last = self.evidence['after'] = copy.deepcopy(p.info(h))
        _info_checked(last, self.kind, expected_links=self.expected_links)
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
    # libuv projects Windows directory st_size to zero. The native directory
    # size/allocation remain captured and compared independently in full.
    require(int(identity['dev']) == info['volumeSerial32'] and int(identity['ino']) == info['fileIndex64']
            and stat.S_ISDIR(int(identity['mode'])) == info['directory']
            and int(identity['size']) == (0 if info['directory'] else info['size'])
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
    if capture.get('format') in (2,3):
        return verify_graph_content(capture, deadline)
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


def capture_closed_tree(root, destination, *, vendor_root, limits, deadline, representation='expanded-v1', failure_evidence=None, cleanup_budget=None):
    if representation in ('physical-graph-v2','physical-graph-v3'):
        try:
            return capture_physical_graph(root, destination, vendor_root=vendor_root, limits=limits, deadline=deadline,
                format_version=3 if representation == 'physical-graph-v3' else 2, failure_evidence=failure_evidence,
                cleanup_budget=cleanup_budget)
        except BaseException as error:
            if failure_evidence is not None and not failure_evidence.closed:
                failure_evidence.primary_capture(_error(error),getattr(error,'observations',None))
                manifest=failure_evidence.finish()
                raise CaptureRefused('physical-graph-preparation-refused',{
                    'original':_error(error),'failureEvidence':manifest,
                    'unresolvedHandle':bool(getattr(error,'unresolved_handle',False)) or manifest['unresolvedHandle']}) from error
            raise
        finally:
            if failure_evidence is not None and not failure_evidence.closed:
                failure_evidence.finish()
    require(failure_evidence is None,'segmented-failure-evidence-requires-physical-graph')
    require(cleanup_budget is None,'cleanup-budget-requires-physical-graph')
    require(representation == 'expanded-v1', 'unknown-capture-representation')
    _check(deadline)
    _windows_required()
    require(type(limits) is dict and set(limits) == LIMIT_FIELDS, 'closed-capture-limits-required')
    ceilings = {'maxEntries': 100000, 'maxBytes': 64 * 1024**3, 'maxFileBytes': 2 * 1024**3,
                'maxDepth': 128, 'maxAliases': 1024, 'maxReportBytes': MAX_REPORT_BYTES}
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


# Format2 retains one source record/image for each physical object. The logical
# namespace is an observed graph; no original path is an image-link target.
GRAPH_FIELDS = frozenset(('format','kind','sourceRoot','canonicalSourceRoot','vendorRoot','canonicalVendorRoot',
    'storageRoot','destinationRoot','vendorDestinationRoot','startedEpochMs','endedEpochMs','physicalEntries',
    'junctions','counts','limits','primitiveSha256','saclNotRequested','complete','allHandlesClosed','canonicalRootObservations'))
GRAPH3_FIELDS = GRAPH_FIELDS | {'hardlinkFamilies'}
FAMILY_FIELDS = frozenset(('role','representative','members','bytes','sha256','owner'))
EDGE_FIELDS = frozenset(('sourceRole','path','rawTarget','canonicalTarget','targetRole','targetPath',
    'targetNodeIdentityBefore','targetNodeIdentityAfter','imagePath','imageRawTarget','imageCanonicalTarget',
    'imageInformation','imageHandleClosed'))
COUNT_FIELDS = frozenset(('physicalEntries','physicalFiles','physicalBytes','physicalAliases','imageEntries',
    'logicalEntries','logicalFiles','logicalBytes','reportBytes'))


def graph_image_root(value, role):
    require(role in ('root','vendor'), 'unknown-physical-role')
    return Path(value['destinationRoot' if role == 'root' else 'vendorDestinationRoot'])


def graph_source_root(value, role):
    require(role in ('root','vendor'), 'unknown-physical-role')
    return Path(value['sourceRoot' if role == 'root' else 'vendorRoot'])


def source_root_entry(value):
    return value['physicalEntries']['root']['.'] if value.get('format') in (2,3) else value['entries']['.']


def graph_hardlink_families(value):
    if value.get('format') == 2:
        require('hardlinkFamilies' not in value,'format2-family-extension-refused')
        return {}
    require(value.get('format') == 3 and type(value.get('hardlinkFamilies')) is dict,
            'explicit-format3-family-map-required')
    families=value['hardlinkFamilies'];seen=set()
    for family_key,family in families.items():
        require(type(family) is dict and set(family)==FAMILY_FIELDS and family['role'] in ('root','vendor')
            and type(family['representative']) is str and type(family['members']) is list
            and 2<=len(family['members'])<=value['limits']['maxEntries']
            and all(type(k) is str for k in family['members'])
            and family['members']==sorted(set(family['members']))
            and family['representative']==family['members'][0]
            and family_key==family['role']+':'+family['representative'],'closed-family-shape-required')
        for key in family['members']:
            _relative(key);pair=(family['role'],key)
            require(pair not in seen,'multiply-covered-family-member');seen.add(pair)
    return families


def graph_family_map(value, role):
    require(role in ('root','vendor'),'unknown-physical-role')
    return {f['representative']:list(f['members']) for f in graph_hardlink_families(value).values() if f['role']==role}


def graph_row_evidence(value, role, key):
    """Return the actual owner record, never attach its evidence to another name."""
    row=value['physicalEntries'][role][key]
    if 'familyKey' not in row:return row
    family=graph_hardlink_families(value).get(row['familyKey'])
    require(family is not None and family['role']==role and key in family['members'],
            'file-family-owner-binding-required')
    return family['owner']


def graph_index(value):
    result={}
    for edge in value['junctions']:
        require(type(edge) is dict and set(edge)==EDGE_FIELDS,'closed-alias-edge-required')
        key=(edge['sourceRole'],edge['path'])
        require(key not in result,'duplicate-physical-alias')
        result[key]=edge
    return result


def graph_resolve(value, role, relative, *, edges=None):
    """Resolve recorded aliases to a captured physical row, without filesystem IO."""
    edges=graph_index(value) if edges is None else edges
    parts=list(_relative(relative).parts); current='.'; seen=set()
    for _ in range(value['limits']['maxDepth']+value['limits']['maxAliases']+2):
        row=value['physicalEntries'][role].get(current)
        require(row is not None,'logical-member-not-captured',{'role':role,'path':current})
        if row['kind'] == 'junction':
            key=(role,current)
            require(key not in seen and key in edges,'alias-cycle-or-missing-edge')
            seen.add(key);edge=edges[key];role,current=edge['targetRole'],edge['targetPath']
            continue
        if not parts:
            return role,current,row
        require(row['kind'] == 'directory','logical-parent-not-directory')
        name=parts.pop(0)
        require(name in row['members'],'logical-member-not-in-observed-directory')
        current=name if current == '.' else current+'/'+name
    raise CaptureRefused('alias-resolution-bound-exceeded')


def graph_logical_rows(value, role='root', relative='.', *, deadline=None):
    """Stream complete logical names with source identity explicitly derived."""
    edges=graph_index(value); stack=[(relative,0)]
    # Count is computed over the finite graph before any consumer enumerates it.
    maximum=value['counts']['logicalEntries'] if role == 'root' and relative == '.' else 100000000
    emitted=0
    while stack:
        if deadline is not None:_check(deadline)
        name,depth=stack.pop();require(depth <= value['limits']['maxDepth'],'logical-depth-exceeded')
        physical_role,key,row=graph_resolve(value,role,name,edges=edges)
        emitted+=1;require(emitted <= maximum,'logical-count-exceeded')
        yield name,physical_role,key,row
        if row['kind'] == 'directory':
            stack.extend((child if name == '.' else name+'/'+child,depth+1) for child in reversed(row['members']))


def graph_counts(value):
    edges=graph_index(value);memo={};active=set()
    def count(role,key,depth):
        require(depth <= value['limits']['maxDepth'],'logical-depth-exceeded')
        identity=(role,key)
        require(identity not in active,'physical-alias-graph-cycle')
        if identity in memo:
            require(depth+memo[identity][3]<=value['limits']['maxDepth'],'logical-depth-exceeded')
            return memo[identity]
        active.add(identity);row=value['physicalEntries'][role][key]
        if row['kind'] == 'junction':
            edge=edges[identity];result=count(edge['targetRole'],edge['targetPath'],depth)
        elif row['kind'] == 'file':result=(1,1,row['bytes'],0)
        else:
            children=[count(role,n if key == '.' else key+'/'+n,depth+1) for n in row['members']]
            result=(1+sum(r[0] for r in children),sum(r[1] for r in children),sum(r[2] for r in children),
                    1+max((r[3] for r in children),default=-1))
        require(result[0] <= 100000000 and result[2] <= 2**63-1 and depth+result[3] <= value['limits']['maxDepth'],
                'derived-logical-closure-exceeds-finite-bound')
        active.remove(identity);memo[identity]=result;return result
    logical=count('root','.',0)
    count('vendor','.',0)  # A hidden cycle in the captured vendor tree also refuses.
    rows=[r for entries in value['physicalEntries'].values() for r in entries.values()]
    return {'physicalEntries':len(rows),'physicalFiles':sum(r['kind']=='file' for r in rows),
            'physicalBytes':sum(r['bytes'] for r in rows if r['kind']=='file'),
            'physicalAliases':len(edges),'imageEntries':len(rows)+1,
            'logicalEntries':logical[0],'logicalFiles':logical[1],'logicalBytes':logical[2]}


def graph_report_bytes(value):
    # The canonical count sets its own numeric field to zero; no fixed-point or
    # circular hash is implied. The actual encoded record is independently capped.
    projected=dict(value,counts=dict(value['counts'],reportBytes=0))
    return len(json.dumps(projected,ensure_ascii=True,allow_nan=False,separators=(',',':')).encode('ascii'))


def pack_metadata_observation(value):
    """Lossless bounded private native evidence, without repeated plaintext rows."""
    raw=json.dumps(value,ensure_ascii=True,allow_nan=False,separators=(',',':')).encode('ascii')
    require(len(raw)<=131072,'metadata-observation-budget')
    return {'encoding':'zlib-json-base64','bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
            'data':base64.b64encode(zlib.compress(raw)).decode('ascii')}


def unpack_metadata_observation(value):
    require(type(value) is dict and set(value)=={'encoding','bytes','sha256','data'}
        and value['encoding']=='zlib-json-base64' and type(value['bytes']) is int
        and 0<value['bytes']<=131072 and type(value['data']) is str and len(value['data'])<=175000,
        'bounded-metadata-observation-required')
    compressed=base64.b64decode(value['data'],validate=True)
    decoder=zlib.decompressobj();raw=decoder.decompress(compressed,value['bytes']+1)
    require(len(raw)==value['bytes'] and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
        and hashlib.sha256(raw).hexdigest()==value['sha256'],'metadata-observation-encoding-changed')
    def object_pairs(pairs):
        result={}
        for key,item in pairs:
            require(key not in result,'duplicate-metadata-observation-key');result[key]=item
        return result
    result=json.loads(raw,object_pairs_hook=object_pairs)
    require(type(result) is dict,'metadata-observation-object-required')
    return result


def validate_source_preservation(obs, info, security, streams, *, require_closed, expected_links=1):
    """Accept an explicit original-tuple preservation chain, never an omitted time."""
    record=obs.get('metadataPreservation')
    if record is None:
        require(obs.get('openedInformation')==info,'source-observer-changed-full-metadata')
        return
    required={'kind','attempted','completed','preWriteObservation','intent','apiEvent'}
    allowed=required|{'postCloseObservation'}
    require(type(record) is dict and required<=set(record)<=allowed
        and (not require_closed or set(record)==allowed) and record.get('kind')=='same-handle-access-preservation'
        and record.get('attempted') is True and record.get('completed') is True,
        'complete-source-preservation-required')
    baseline=obs['acquisitionBaseline'];opened=obs['openedInformation'];transition=obs['acquisitionTransition']
    original=baseline['before']
    _info_checked(opened,'directory' if info['directory'] else 'file',expected_links=expected_links)
    require(original==baseline['after']==info and baseline['ownerGroupDaclBeforeBase64']==security
        ==baseline['ownerGroupDaclAfterBase64'] and baseline['streams']==streams,
        'preserved-original-tuple-required')
    require(all(original[k]==opened[k] for k in original if k!='access100ns')
        and original['access100ns']<opened['access100ns']
        and transition.get('kind')=='post-acquisition-pre-io-baseline'
        and transition.get('contentIoStarted') is False
        and transition.get('accessTimeChanged') is True
        and transition['started100ns']<=opened['access100ns']<=transition['ended100ns']
        and transition['before']=={'informationRef':'acquisitionBaseline.before',
            'ownerGroupDaclRef':'acquisitionBaseline.ownerGroupDaclBeforeBase64','access100ns':original['access100ns']}
        and transition['after']=={'informationRef':'openedInformation',
            'ownerGroupDaclRef':'suppressionSecurityBase64','access100ns':opened['access100ns']}
        and obs['suppressionSecurityBase64']==security,'preservation-acquisition-chain-changed')
    pre=unpack_metadata_observation(record['preWriteObservation'])
    require(pre['information']==opened and pre['security']=={'ownerGroupDaclBase64':security,'saclNotRequested':True}
        and pre['streams']==streams and pre['observations']['before']==opened==pre['observations']['after']
        and pre['observations']['openedInformation']==opened
        and pre['observations']['ownerGroupDaclBeforeBase64']==security==pre['observations']['ownerGroupDaclAfterBase64'],
        'preservation-prewrite-state-changed')
    intent=record['intent'];event=record['apiEvent']
    expected_basic={key:original[key] for key in PRESERVED_BASIC_FIELDS}
    require(type(event['arguments']['handle']) is int and event['arguments']['handle']>0
        and event['arguments']['handle']==obs['accessTimeSuppressionEvent']['arguments']['handle'],
        'preservation-original-handle-binding-changed')
    if info['directory']:
        require(obs['directorySweeps'] and all(s.get('complete') is True and s.get('eof') is True
            for s in obs['directorySweeps']),'preservation-incomplete-directory-io')
    else:
        require(obs['readResult'].get('complete') is True and obs['readResult'].get('eof') is True
            and obs['readResult']['bytes']==info['size'],'preservation-incomplete-file-io')
    require(intent=={'kind':'restore-observed-access-on-original-handle','handle':event['arguments']['handle'],
        'originalInformationRef':'acquisitionBaseline.before','expectedPreWriteInformationRef':'openedInformation',
        'originalBasicInfo':expected_basic,'contentIoComplete':True},'preservation-intent-changed')
    require(event['api']=='SetFileInformationByHandle:source-basic-preservation'
        and event['arguments']=={'handle':intent['handle'],'class':0,'bytes':ctypes.sizeof(_primitive().BasicInfo),
                                  'information':expected_basic}
        and type(event['result']) is int and event['result']!=0,
        'preservation-native-write-not-confirmed')
    raw=base64.b64decode(event['raw']['base64'],validate=True)
    expected_raw=bytes(_primitive().BasicInfo(*(original[key] for key in PRESERVED_BASIC_FIELDS)))
    require(event['raw']['bytes']==len(raw)==len(expected_raw) and raw==expected_raw,'preservation-native-payload-changed')
    if require_closed:
        post=unpack_metadata_observation(record['postCloseObservation'])
        require(post['information']==info and post['security']=={'ownerGroupDaclBase64':security,'saclNotRequested':True}
            and post['streams']==streams and post['observations']['before']==info==post['observations']['after']
            and post['observations']['openedInformation']==info and post['observations']['handleClosed'] is True
            and post['observations']['ownerGroupDaclBeforeBase64']==security==post['observations']['ownerGroupDaclAfterBase64'],
            'preservation-postclose-state-changed')


def validate_physical_graph(value, *, require_closed=True):
    require(type(value) is dict and value.get('format') in (2,3)
            and set(value)==(GRAPH3_FIELDS if value['format']==3 else GRAPH_FIELDS)
            and value['kind']=='local-windows-closed-tree' and value['primitiveSha256']==PRIMITIVE_SHA256
            and value['saclNotRequested'] is True and value['complete'] is True,'closed-physical-graph-required')
    require(not require_closed or value['allHandlesClosed'] is True,'physical-graph-handles-not-closed')
    require(all(type(value[k]) is int and 0<=value[k]<=2**53-1 for k in ('startedEpochMs','endedEpochMs'))
        and value['startedEpochMs']<=value['endedEpochMs'],'physical-capture-clock-shape')
    limits=value['limits'];require(set(limits)==LIMIT_FIELDS,'closed-physical-graph-limits')
    caps={'maxEntries':100000,'maxBytes':64*1024**3,'maxFileBytes':2*1024**3,'maxDepth':128,'maxAliases':1024,'maxReportBytes':MAX_REPORT_BYTES}
    require(all(type(limits[k]) is int and 0<limits[k]<=cap for k,cap in caps.items()),'physical-graph-limit-range')
    storage=_absolute(value['storageRoot']); require(graph_image_root(value,'root')==storage/'root'
        and graph_image_root(value,'vendor')==storage/'vendor','fixed-physical-image-layout-required')
    require(type(value['physicalEntries']) is dict and set(value['physicalEntries'])=={'root','vendor'},'two-physical-roles-required')
    require(type(value['junctions']) is list and len(value['junctions'])<=limits['maxAliases'],'physical-alias-budget')
    edges=graph_index(value); native=_primitive();families=graph_hardlink_families(value)
    observed_families={};file_ids={}
    canonical=value['canonicalRootObservations']
    require(type(canonical) is dict and set(canonical)=={'root','vendor'},'canonical-root-observations-required')
    for role,entries in value['physicalEntries'].items():
        require(type(entries) is dict and '.' in entries and entries['.']['kind']=='directory','physical-root-missing')
        source=graph_source_root(value,role);require(source.is_absolute(),'absolute-physical-source-required')
        observed=canonical[role];expected=value['canonicalSourceRoot' if role=='root' else 'canonicalVendorRoot']
        require(type(observed) is dict and set(observed)=={'before','after'} and observed['before']==expected==observed['after']
            and type(expected) is str and Path(expected).is_absolute() and '\x00' not in expected,'canonical-physical-root-changed')
        require(not _below(storage,source) and not _below(source,storage),'image-source-overlap')
        for key,row in entries.items():
            rel=_relative(key);kind=row['kind'];require(kind in ('file','directory','junction'),'physical-kind-refused')
            common={'kind','physicalPath','imageRelativePath','information','security','streams','sameHandleStable','nativeObservations'}
            extra=({'bytes','sha256','nodeIdentity','nodeIdentityBefore'} if kind=='file' else
                   {'members','nodeIdentity','nodeIdentityBefore'} if kind=='directory' else set())
            family=families.get(row.get('familyKey')) if value['format']==3 else None
            if 'familyKey' in row:
                require(family is not None and kind=='file' and family['role']==role and key in family['members'],
                        'exact-file-family-membership-required')
                extra=extra|{'familyKey'};observed_families.setdefault(row['familyKey'],[]).append(key)
            require(type(row) is dict and set(row)==common|extra,'closed-physical-row-required')
            require(Path(row['physicalPath'])==source/rel and row['imageRelativePath']==(Path(role)/rel).as_posix(),
                    'physical-path-binding-changed')
            info=_info_checked(row['information'],kind,expected_links=len(family['members']) if family else 1)
            sec=row['security'];obs=row['nativeObservations']
            if kind=='file' and value['format']==3:
                file_ids.setdefault((info['volumeSerial64'],info['fileId128Hex']),[]).append((role,key))
            require(type(sec) is dict and set(sec)=={'ownerGroupDaclBase64','saclNotRequested'} and sec['saclNotRequested'] is True,'physical-security-scope')
            native.checked_security(base64.b64decode(sec['ownerGroupDaclBase64'],validate=True))
            require(row.get('sameHandleStable') is True and obs['before']==info==obs['after']
                    and obs['ownerGroupDaclBeforeBase64']==sec['ownerGroupDaclBase64']==obs['ownerGroupDaclAfterBase64']
                    and (not require_closed or obs.get('handleClosed') is True),'physical-observation-not-stable')
            if family:
                require(obs.get('sourceObservationMode')=='metadata-only-hardlink-member'
                    and obs.get('path')==row['physicalPath'] and obs.get('kind')=='file'
                    and obs.get('expectedLinks')==len(family['members']) and obs['openedInformation']==info
                    and 'accessTimeSuppression' not in obs and 'metadataPreservation' not in obs,
                    'genuine-per-name-family-metadata-required')
            elif kind=='junction':
                require(obs.get('sourceObservationMode')=='metadata-only-junction'
                    and 'accessTimeSuppression' not in obs and 'metadataPreservation' not in obs,
                    'metadata-only-junction-observation-required')
            else:
                suppression=obs.get('accessTimeSuppression')
                suppression_fields={'kind','access','creation','write','accessLow','accessHigh','immediateAfterOpen','result','lastError','sameHandle'}
                require(type(suppression) is dict and set(suppression)==suppression_fields
                    and suppression['kind']=='per-handle-last-access-suppression' and suppression['access']==0x20181
                    and suppression['creation'] is None and suppression['write'] is None
                    and type(suppression['accessLow']) is int and suppression['accessLow']==0xffffffff
                    and type(suppression['accessHigh']) is int and suppression['accessHigh']==0xffffffff
                    and suppression['immediateAfterOpen'] is True and suppression['result'] is True and suppression['sameHandle'] is True
                    and type(suppression['lastError']) is int and 0<=suppression['lastError']<=0xffffffff,
                    'same-source-handle-suppression-evidence-required')
            streams=row['streams']
            require(type(streams) is list and all(type(s) is dict and set(s)=={'name','bytes','allocationBytes','rawBase64'}
                and s['name']=='::$DATA' and type(s['bytes']) is int and type(s['allocationBytes']) is int for s in streams),
                'physical-stream-record-invalid')
            for stream in streams:
                raw=base64.b64decode(stream['rawBase64'],validate=True)
                require(24<len(raw)<=4120 and parse_streams(raw+bytes(STREAM_BUFFER-len(raw)))==[stream],
                    'physical-stream-raw-observation-changed')
            require((kind=='file' and len(streams)==1 and streams[0]['bytes']==info['size']
                and streams[0]['allocationBytes']==info['allocationBytes']) or (kind!='file'
                and len(streams)<=1 and all(s['bytes']==s['allocationBytes']==0 for s in streams)),
                'physical-default-stream-completeness')
            if not family:
                validate_source_preservation(obs,info,sec['ownerGroupDaclBase64'],streams,require_closed=require_closed)
            if kind!='junction':
                identity=row['nodeIdentity'];require(set(identity)==NODE_FIELDS and identity==row['nodeIdentityBefore']
                    and all(type(v) is str and re.fullmatch('[0-9]{1,40}',v) for v in identity.values()),'physical-node-types')
                _node_join(identity,info)
                require(stat.S_ISREG(int(identity['mode']))==(kind=='file'),'physical-node-regular-type')
            if key!='.':
                parent=rel.parent.as_posix();require(parent in entries and entries[parent]['kind']=='directory'
                    and rel.name in entries[parent]['members'],'physical-parent-roster-mismatch')
            if kind=='directory':
                names=row['members'];require(type(names) is list and names==sorted(names)
                    and len(names)==len(set(n.casefold() for n in names)),'physical-member-roster-invalid')
                require(all(type(n) is str and n not in ('','.','..') and not any(c in n for c in '/\\:\x00')
                    and (n if key=='.' else key+'/'+n) in entries for n in names),'physical-member-missing')
            elif kind=='file':
                require(type(row['bytes']) is int and 0<=row['bytes']<=limits['maxFileBytes'] and row['bytes']==info['size']
                    and re.fullmatch('[a-f0-9]{64}',row['sha256']),'physical-file-content-shape')
            else:require((role,key) in edges,'physical-junction-edge-missing')
    for family_key,family in families.items():
        require(sorted(observed_families.get(family_key,[]))==family['members'],'orphan-or-uncovered-family-refused')
        owner=family['owner'];rows=value['physicalEntries'][family['role']]
        representative=rows[family['representative']];n=len(family['members'])
        require(type(owner) is dict and set(owner)=={'physicalPath','information','security','streams','sameHandleStable','nativeObservations'}
            and owner['physicalPath']==representative['physicalPath'] and owner.get('sameHandleStable') is True,
            'genuine-family-representative-owner-required')
        for key in family['members']:
            row=rows[key]
            require(all(row[k]==owner[k] for k in ('information','security','streams'))
                and row['bytes']==family['bytes'] and row['sha256']==family['sha256'],
                'family-member-tuple-or-content-mismatch')
        info=_info_checked(owner['information'],'file',expected_links=n);obs=owner['nativeObservations'];sec=owner['security']['ownerGroupDaclBase64']
        require(obs.get('path')==owner['physicalPath'] and obs.get('kind')=='file' and obs.get('expectedLinks')==n
            and obs.get('sourceObservationMode')=='neutral-hardlink-family-owner'
            and obs['before']==info==obs['after'] and obs['ownerGroupDaclBeforeBase64']==sec==obs['ownerGroupDaclAfterBase64']
            and (not require_closed or obs.get('handleClosed') is True),'stable-genuine-family-owner-required')
        suppression=obs.get('accessTimeSuppression')
        require(type(suppression) is dict and set(suppression)=={'kind','access','creation','write','accessLow','accessHigh','immediateAfterOpen','result','lastError','sameHandle'}
            and suppression['kind']=='per-handle-last-access-suppression' and suppression['access']==0x20181
            and suppression['creation'] is None and suppression['write'] is None
            and type(suppression['accessLow']) is int and suppression['accessLow']==0xffffffff
            and type(suppression['accessHigh']) is int and suppression['accessHigh']==0xffffffff
            and suppression['immediateAfterOpen'] is True and suppression['result'] is True and suppression['sameHandle'] is True
            and type(suppression['lastError']) is int and 0<=suppression['lastError']<=0xffffffff,
            'family-owner-suppression-required')
        read=obs.get('readResult',{})
        require(read.get('complete') is True and read.get('eof') is True
            and read.get('bytes')==family['bytes'] and read.get('sha256')==family['sha256'],
            'family-owner-complete-content-read-required')
        validate_source_preservation(obs,info,sec,owner['streams'],require_closed=require_closed,expected_links=n)
        require(sorted(file_ids.get((info['volumeSerial64'],info['fileId128Hex']),[]))==[(family['role'],k) for k in family['members']],
                'family-native-name-count-or-role-mismatch')
    if value['format']==3:
        for members in file_ids.values():
            if len(members)>1:
                keys={value['physicalEntries'][r][k].get('familyKey') for r,k in members}
                require(len(keys)==1 and None not in keys,'unaccounted-or-cross-role-file-family')
    for edge in value['junctions']:
        require(type(edge) is dict and set(edge)==EDGE_FIELDS,'closed-alias-edge-required')
        role,key=edge['sourceRole'],edge['path'];target_role,target_key=edge['targetRole'],edge['targetPath']
        require(role in ('root','vendor') and target_role in ('root','vendor'),'alias-role-invalid')
        row=value['physicalEntries'][role].get(key);target=value['physicalEntries'][target_role].get(target_key)
        require(row is not None and row['kind']=='junction' and target is not None and target['kind']=='directory','alias-target-not-physical-directory')
        expected_source=str(graph_source_root(value,target_role)/_relative(target_key))
        actual,actual_role=_junction_target(edge['rawTarget'],value['sourceRoot'],value['vendorRoot'])
        require(actual==expected_source==edge['canonicalTarget'] and actual_role==target_role,'alias-source-target-binding')
        image_target=graph_image_root(value,target_role)/_relative(target_key)
        require(Path(edge['imagePath'])==graph_image_root(value,role)/_relative(key)
            and edge['imageRawTarget']=='\\\\?\\'+str(image_target)
            and edge['imageCanonicalTarget']==str(image_target),'image-alias-escaped-capture')
        require(edge['targetNodeIdentityBefore']==edge['targetNodeIdentityAfter']==target['nodeIdentity'],
                'alias-root-target-identity-changed')
        _info_checked(edge['imageInformation'],'junction')
        require(not require_closed or edge['imageHandleClosed'] is True,'image-alias-handle-not-closed')
    counts=graph_counts(value)
    require(set(value['counts'])==COUNT_FIELDS and all(value['counts'][k]==v for k,v in counts.items()),'physical-logical-count-mismatch')
    require(counts['physicalEntries']<=limits['maxEntries'] and counts['physicalBytes']<=limits['maxBytes'],'physical-closure-budget')
    require(value['counts']['reportBytes']==graph_report_bytes(value)
        and len(json.dumps(value,ensure_ascii=True,allow_nan=False).encode('ascii'))<=limits['maxReportBytes'],'physical-evidence-budget')
    return True


def verify_graph_content(value, deadline, *, require_closed=True):
    _check(deadline);validate_physical_graph(value,require_closed=require_closed)
    storage=Path(value['storageRoot']);require(not _reparse(storage.lstat()) and sorted(os.listdir(storage))==['root','vendor'],'physical-storage-roster-changed')
    edges=graph_index(value)
    for role,entries in value['physicalEntries'].items():
        image=graph_image_root(value,role)
        for key,expected in entries.items():
            _check(deadline);path=image/_relative(key);row=path.lstat()
            if expected['kind']=='junction':
                edge=edges[(role,key)]
                require(_reparse(row) and getattr(row,'st_reparse_tag',0)==MOUNT_POINT
                    and os.readlink(path)==edge['imageRawTarget'] and os.path.realpath(path)==edge['imageCanonicalTarget'],
                    'image-alias-target-changed')
                _identity_join(row,edge['imageInformation'],'junction')
                continue
            require(not _reparse(row),'undeclared-image-reparse')
            if expected['kind']=='directory':
                require(stat.S_ISDIR(row.st_mode) and sorted(os.listdir(path))==expected['members'],'physical-image-directory-roster-changed')
            else:
                require(stat.S_ISREG(row.st_mode) and row.st_nlink==1 and row.st_size==expected['bytes'],'physical-image-file-changed')
                with path.open('rb') as stream:
                    opened=os.fstat(stream.fileno());require(_common(row)==_common(opened),'physical-image-open-changed')
                    digest=hashlib.file_digest(stream,'sha256').hexdigest()
                    require(_stat_row(opened)==_stat_row(os.fstat(stream.fileno()))
                        and _common(row)==_common(path.lstat()),'physical-image-read-changed')
                require(digest==expected['sha256'],'physical-image-content-changed')
    return True


def _unrepresented_source_owners(report,source_ports,family_ports):
    represented={id(source_ports[(role,key)]) for role,items in report['physicalEntries'].items()
        for key in items if (role,key) in source_ports}
    represented.update(id(family_ports[key]) for key,family in report.get('hardlinkFamilies',{}).items()
        if family.get('owner') is not None and key in family_ports)
    return [port for port in [*source_ports.values(),*family_ports.values()]
        if hasattr(port,'_capture_completed') and id(port) not in represented]


def capture_physical_graph(root, destination, *, vendor_root, limits, deadline, format_version=2, failure_evidence=None, cleanup_budget=None):
    """One complete physical capture plus image-only alias views; never links live state."""
    _check(deadline);_windows_required()
    require(format_version in (2,3),'explicit-physical-graph-version-required')
    if cleanup_budget is not None:
        require(format_version==3 and type(cleanup_budget) is CaptureCleanupBudget,
                'explicit-format3-cleanup-budget-required')
        cleanup_budget.claim(deadline)
    require(type(limits) is dict and set(limits)==LIMIT_FIELDS,'closed-capture-limits-required')
    caps={'maxEntries':100000,'maxBytes':64*1024**3,'maxFileBytes':2*1024**3,
          'maxDepth':128,'maxAliases':1024,'maxReportBytes':MAX_REPORT_BYTES}
    require(all(type(limits[k]) is int and 0<limits[k]<=v for k,v in caps.items()),'capture-limit-range')
    root,storage,vendor=map(_absolute,(root,destination,vendor_root))
    require(not _below(root,vendor) and not _below(vendor,root),'disjoint-physical-source-roles-required')
    for source in (root,vendor):
        require(not _below(storage,source) and not _below(source,storage),'disjoint-snapshot-required')
        if failure_evidence is not None:
            evidence_root=_absolute(failure_evidence.root)
            require(not _below(evidence_root,source) and not _below(source,evidence_root),
                    'disjoint-failure-evidence-required')
    from local_windows_neutral_io import open_source
    from local_windows_clone import Win32Target, _junction_payload
    report={'format':format_version,'kind':'local-windows-closed-tree','sourceRoot':str(root),
        'canonicalSourceRoot':os.path.realpath(root),'vendorRoot':str(vendor),'canonicalVendorRoot':os.path.realpath(vendor),
        'storageRoot':str(storage),'destinationRoot':str(storage/'root'),'vendorDestinationRoot':str(storage/'vendor'),
        'startedEpochMs':time.time_ns()//1000000,'endedEpochMs':0,'physicalEntries':{'root':{},'vendor':{}},
        'junctions':[],'counts':{},'limits':dict(limits),'primitiveSha256':PRIMITIVE_SHA256,
        'saclNotRequested':True,'complete':False,'allHandlesClosed':False}
    if format_version==3:report['hardlinkFamilies']={}
    if failure_evidence is not None:failure_evidence.capture_report=report
    report['canonicalRootObservations']={'root':{'before':report['canonicalSourceRoot'],'after':None},
        'vendor':{'before':report['canonicalVendorRoot'],'after':None}}
    source_ports={}; family_ports={}; image_ports=[]; image_links={}; ancestors=[]; inventory={'root':{},'vendor':{}}
    linked_groups={}
    failure=None;close_errors=[];close_error_count=0;physical_count=physical_bytes=0;charged=4096
    failure_envelope=2*1024**2+(failure_evidence.aggregate_reserve_bytes() if failure_evidence is not None else 0)
    if failure_evidence is not None:
        require(failure_envelope<limits['maxReportBytes'],'failure-envelope-exceeds-report-budget')
    def metadata_port(path,kind):
        token=failure_evidence.admit_port(path,kind) if failure_evidence is not None else None
        port=_Held(path,kind,deadline)
        if token is not None:token.owner=port
        return port
    def source_port(path,kind,**options):
        token=None
        if cleanup_budget is not None:options['cleanup_budget']=cleanup_budget
        if failure_evidence is not None:
            if kind=='junction':token=failure_evidence.admit_port(path,kind)
            options['failure_evidence']=failure_evidence
        port=open_source(path,kind,deadline,**options)
        if token is not None:token.owner=port
        return port
    def budget(value):
        nonlocal charged
        charged+=len(json.dumps(value,ensure_ascii=True,allow_nan=False).encode('ascii'))+512
        require(charged+failure_envelope<=limits['maxReportBytes'],'physical-report-reserve-exceeded')
    def ancestry(path):
        for ancestor in reversed(path.parents):
            if ancestor==Path(ancestor.anchor):continue
            row=ancestor.lstat();require(stat.S_ISDIR(row.st_mode) and not _reparse(row),'ordinary-ancestor-required')
            if any(p.path==ancestor for p in ancestors):continue
            port=metadata_port(ancestor,'directory');ancestors.append(port)
            _identity_join(row,port.evidence['openedInformation'],'directory')
    def visit(role,path,key,depth):
        nonlocal physical_count,physical_bytes
        _check(deadline);require(depth<=limits['maxDepth'],'physical-depth-budget')
        physical_count+=1;require(physical_count<=limits['maxEntries'],'physical-entry-budget')
        before=path.lstat();kind='junction' if _reparse(before) else ('directory' if stat.S_ISDIR(before.st_mode) else 'file')
        if kind=='junction':require(getattr(before,'st_reparse_tag',0)==MOUNT_POINT,'unknown-reparse-kind')
        elif kind=='file':require(stat.S_ISREG(before.st_mode) and (before.st_nlink==1 or format_version==3 and 2<=before.st_nlink<=limits['maxEntries']),
                                 'ordinary-single-link-source-required')
        linked=kind=='file' and before.st_nlink>1
        if linked:
            token=failure_evidence.admit_port(path,kind) if failure_evidence is not None else None
            port=_Held(path,kind,deadline,expected_links=before.st_nlink)
            if token is not None:token.owner=port
            port.evidence['sourceObservationMode']='metadata-only-hardlink-member'
        else:port=source_port(path,kind)
        source_ports[(role,key)]=port
        _identity_join(before,port.evidence['openedInformation'],kind)
        item={'kind':kind,'path':path};inventory[role][key]=item
        if linked:
            information=port.evidence['openedInformation']
            linked_groups.setdefault((information['volumeSerial64'],information['fileId128Hex']),[]).append((role,key))
        if kind=='junction':
            raw=os.readlink(path);target,target_role=_junction_target(raw,str(root),str(vendor))
            target_key=Path(target).relative_to(root if target_role=='root' else vendor).as_posix()
            require(len(report['junctions'])<limits['maxAliases'],'physical-alias-budget')
            image_path=storage/role/_relative(key);image_target=storage/target_role/_relative(target_key)
            report['junctions'].append({'sourceRole':role,'path':key,'rawTarget':raw,'canonicalTarget':target,
                'targetRole':target_role,'targetPath':target_key,'targetNodeIdentityBefore':None,'targetNodeIdentityAfter':None,
                'imagePath':str(image_path),'imageRawTarget':'\\\\?\\'+str(image_target),'imageCanonicalTarget':str(image_target),
                'imageInformation':None,'imageHandleClosed':False})
        elif kind=='directory':
            names=sorted(port.list_names(max_entries=limits['maxEntries'],max_pages=4096))
            require(len(names)==len(set(n.casefold() for n in names)) and all(type(n) is str and n not in ('','.','..')
                and not any(c in n for c in '/\\:\x00') for n in names),'ordinary-directory-members-required')
            item['members']=names
            for name in names:visit(role,path/name,name if key=='.' else key+'/'+name,depth+1)
        else:
            size=port.evidence['openedInformation']['size'];require(size<=limits['maxFileBytes'],'physical-file-budget')
            physical_bytes+=size;require(physical_bytes<=limits['maxBytes'],'physical-byte-budget');item['bytes']=size
    try:
        ancestry(root);ancestry(vendor);ancestry(storage)
        require(not os.path.lexists(storage),'fresh-storage-required')
        visit('root',root,'.',0);visit('vendor',vendor,'.',0)
        # Every physical name is inventoried and held before opening the ONE
        # data/preservation owner for each inode. A missing/outside/cross-role
        # name refuses before any transport image is created.
        for members in linked_groups.values():
            members=sorted(members);role=members[0][0];keys=[k for _,k in members]
            require(all(r==role for r,_ in members),'cross-role-hardlink-family-refused')
            n=len(members);rep=keys[0];family_key=role+':'+rep
            tuples=[source_ports[pair].evidence['openedInformation'] for pair in members]
            require(2<=n<=limits['maxEntries'] and all(info==tuples[0] and info['links']==n for info in tuples),
                    'unaccounted-hardlink-family-member')
            owner=source_port(inventory[role][rep]['path'],'file',expected_links=n)
            owner.evidence['sourceObservationMode']='neutral-hardlink-family-owner';family_ports[family_key]=owner
            report['hardlinkFamilies'][family_key]={'role':role,'representative':rep,'members':keys,
                'bytes':inventory[role][rep]['bytes'],'sha256':None,'owner':None}
            for key in keys:inventory[role][key]['familyKey']=family_key
        # Validate edge destinations and cycles from the actual inventory before
        # copying or creating any transport junction.
        temporary={'physicalEntries':inventory,'junctions':report['junctions'],'limits':limits}
        for edge in report['junctions']:
            target=inventory[edge['targetRole']].get(edge['targetPath'])
            require(target is not None and target['kind']=='directory','source-alias-target-missing-or-reparse')
        counts=graph_counts(temporary)
        ordinary=[str(item['path']) for items in inventory.values() for item in items.values() if item['kind']!='junction']
        alias_paths=[str(inventory[e['sourceRole']][e['path']]['path']) for e in report['junctions']]
        before_node=node_identities(limits['node'],ordinary+alias_paths,deadline)
        storage.mkdir();image_ports.append(metadata_port(storage,'directory'))
        # All independent image parents exist before representative bytes are
        # copied. Family image names remain ordinary separate single-link files.
        for role,items in inventory.items():
            for key,item in items.items():
                _check(deadline);target=storage/role/_relative(key)
                if item['kind'] in ('directory','junction'):
                    target.mkdir()
                    if item['kind']=='directory':image_ports.append(metadata_port(target,'directory'))
        for role,items in inventory.items():
            for key in sorted(items):
                item=items[key]
                if item['kind']!='file':continue
                _check(deadline);target=storage/role/_relative(key)
                family=report.get('hardlinkFamilies',{}).get(item.get('familyKey'))
                if family and key!=family['representative']:
                    copied=_copy_default(storage/role/_relative(family['representative']),target,limits['maxFileBytes'],deadline)
                    require(copied['bytes']==item['bytes'] and copied['sha256']==family['sha256'],'family-image-copy-content-changed')
                    item['sha256']=copied['sha256'];image_ports.append(metadata_port(target,'file'));continue
                digest=hashlib.sha256();total=0
                port=family_ports[item['familyKey']] if family else source_ports[(role,key)]
                with target.open('xb') as outgoing:
                    for chunk in port.read_chunks(limits['maxFileBytes']):
                        _check(deadline);total+=len(chunk);require(total<=item['bytes'],'physical-source-size-changed')
                        digest.update(chunk);require(outgoing.write(chunk)==len(chunk),'physical-image-short-write')
                    outgoing.flush();os.fsync(outgoing.fileno())
                require(total==item['bytes'],'physical-source-short-read')
                item['sha256']=digest.hexdigest();image_ports.append(metadata_port(target,'file'))
                if family:family['sha256']=item['sha256']
        for edge in report['junctions']:
            token=failure_evidence.admit_port(Path(edge['imagePath']),'image-junction') if failure_evidence is not None else None
            port=Win32Target(Path(edge['imagePath']),'directory',deadline);image_links[(edge['sourceRole'],edge['path'])]=port
            if token is not None:token.owner=port
            port.set_junction(_junction_payload(edge['imageRawTarget']),edge['imageRawTarget'])
            observation=port.observe();edge['imageInformation']=observation['information']
        # Owner preservation completes BEFORE final member metadata is sampled.
        # Per-name handles remain open throughout and have their own observations.
        for family_key,port in family_ports.items():
            port.streams();captured=port.capture();family=report['hardlinkFamilies'][family_key]
            family['owner']={'physicalPath':str(port.path),**captured};budget(family)
        for role,items in inventory.items():
            for key,item in items.items():
                port=source_ports[(role,key)]
                if item['kind']=='directory':require(sorted(port.list_names(max_entries=limits['maxEntries'],max_pages=4096))==item['members'],'source-membership-changed')
        for edge in report['junctions']:
            require(os.readlink(inventory[edge['sourceRole']][edge['path']]['path'])==edge['rawTarget'],'source-alias-target-changed')
        after_node=node_identities(limits['node'],ordinary+alias_paths,deadline)
        require(before_node==after_node,'physical-node-source-identity-changed',{'before':before_node,'after':after_node})
        for role,source in (('root',root),('vendor',vendor)):
            report['canonicalRootObservations'][role]['after']=os.path.realpath(source)
        for role,items in inventory.items():
            for key,item in items.items():
                port=source_ports[(role,key)];port.streams();captured=port.capture()
                row={'kind':item['kind'],'physicalPath':str(item['path']),
                     'imageRelativePath':(Path(role)/_relative(key)).as_posix(),**captured}
                if item['kind']!='junction':
                    row.update(nodeIdentity=after_node[str(item['path'])],nodeIdentityBefore=before_node[str(item['path'])])
                    _node_join(row['nodeIdentity'],row['information'])
                if item['kind']=='directory':row['members']=item['members']
                elif item['kind']=='file':row.update(bytes=item['bytes'],sha256=item['sha256'])
                if 'familyKey' in item:
                    row['familyKey']=item['familyKey'];family=report['hardlinkFamilies'][item['familyKey']]
                    require(all(row[k]==family['owner'][k] for k in ('information','security','streams')),
                            'family-final-member-metadata-changed')
                report['physicalEntries'][role][key]=row;budget(row)
        for edge in report['junctions']:
            alias=str(inventory[edge['sourceRole']][edge['path']]['path'])
            edge['targetNodeIdentityBefore']=before_node[alias];edge['targetNodeIdentityAfter']=after_node[alias];budget(edge)
        report['counts']={**counts,'reportBytes':0};report['complete']=True
        report['endedEpochMs']=time.time_ns()//1000000
        report['counts']['reportBytes']=graph_report_bytes(report)
        verify_graph_content(report,deadline,require_closed=False)
    except BaseException as error:failure=error
    finally:
        if cleanup_budget is not None:cleanup_budget.begin()
        for port in reversed([*ancestors,*source_ports.values(),*family_ports.values(),*image_ports,*image_links.values()]):
            try:port.close()
            except BaseException as error:
                close_error_count+=1
                if failure_evidence is None:close_errors.append({'path':str(port.path),'error':_error(error)})
                else:failure_evidence.close_error(port,_error(error))
        for key,port in image_links.items():
            for edge in report['junctions']:
                if (edge['sourceRole'],edge['path'])==key:edge['imageHandleClosed']=port.evidence.get('handleClosed') is True
        report['allHandlesClosed']=(not close_error_count and not getattr(failure,'unresolved_handle',False)
            and all(p.evidence.get('handleClosed') for p in [*ancestors,*source_ports.values(),*family_ports.values(),*image_ports,*image_links.values()]))
        # Inventory can fail before any complete physical row exists. Preserve
        # each acquired, uncaptured data owner's real cleanup evidence once;
        # completed rows/family owners already retain their original evidence.
        aborted_ports=(_unrepresented_source_owners(report,source_ports,family_ports) if failure_evidence is not None
            else [port for port in [*source_ports.values(),*family_ports.values()]
                if hasattr(port,'_capture_completed') and not port._capture_completed])
        aborted_owners=[]
        if failure_evidence is None:
            aborted_owners=[{'physicalPath':str(port.path),'kind':port.kind,'nativeObservations':port.evidence}
                for port in aborted_ports]
        else:
            # Writer failures are recorded, never allowed to interrupt source
            # handle closure. Each complete owner proof is written exactly once.
            for port in aborted_ports:
                try:failure_evidence.owner(port)
                except BaseException as error:failure_evidence._fail(error)
            if aborted_ports:
                report['abortedSourcePreservation']={'kind':'aborted-acquired-source-owner-references',
                    'captureComplete':False,'contentIoComplete':False,'ownerCount':len(aborted_ports),
                    'allListedOwnersClosed':all(port.evidence.get('handleClosed') is True for port in aborted_ports),
                    'allListedOwnersMetadataProven':all(port.evidence.get('abortedObservation',{}).get('metadataRestorationProven') is True
                        for port in aborted_ports),
                    'ownerEvidenceRef':'failureEvidence','failedConstructorEvidenceRef':'failureEvidence.primary',
                    'failedConstructorCoveredByOwnerList':False}
        if aborted_owners:
            report['abortedSourcePreservation']={'kind':'aborted-acquired-source-owners',
                'captureComplete':False,'contentIoComplete':False,'owners':aborted_owners,
                'ownerCount':len(aborted_owners),
                'allListedOwnersClosed':all(row['nativeObservations'].get('handleClosed') is True for row in aborted_owners),
                'allListedOwnersMetadataProven':all(row['nativeObservations'].get('abortedObservation',{}).get('metadataRestorationProven') is True
                    for row in aborted_owners),
                'failedConstructorEvidenceRef':'failureObservations',
                'failedConstructorCoveredByOwnerList':False}
        report['endedEpochMs']=time.time_ns()//1000000
    if failure is not None or close_error_count:
        if cleanup_budget is not None:report['cleanupBudget']=cleanup_budget.receipt()
        if failure_evidence is not None:
            # The complete existing partial report and primary observations are
            # retained in one independently bounded emergency record. Only its
            # exact durable references enter the capped aggregate exception.
            report['complete']=False
            failure_evidence.primary_capture(_error(failure) if failure else None,
                getattr(failure,'observations',None))
            manifest=failure_evidence.finish()
            summary={key:report[key] for key in ('format','kind','sourceRoot','vendorRoot','storageRoot',
                'startedEpochMs','endedEpochMs','complete','allHandlesClosed')}
            summary.update(originalError=_error(failure) if failure else None,closeErrorCount=close_error_count,
                failureEvidence=manifest,abortedSourcePreservation=report.get('abortedSourcePreservation'),
                unresolvedHandle=bool(getattr(failure,'unresolved_handle',False)) or manifest['unresolvedHandle'])
            if cleanup_budget is not None:summary['cleanupBudget']=cleanup_budget.receipt()
            summary['allHandlesClosed']=summary['allHandlesClosed'] and not manifest['unresolvedHandle']
            require(len(json.dumps(summary,ensure_ascii=True,allow_nan=False).encode('ascii'))<=limits['maxReportBytes'],
                'failure-envelope-reservation-exceeded',{'complete':False,'allHandlesClosed':summary['allHandlesClosed'],
                    'evidenceRoot':str(failure_evidence.root),'scope':failure_evidence.name})
            raise CaptureRefused('physical-graph-capture-refused',summary) from failure
        report.update(complete=False,originalError=_error(failure) if failure else None,
            failureObservations=getattr(failure,'observations',None),closeErrors=close_errors)
        raise CaptureRefused('physical-graph-capture-refused',report) from failure
    report['counts']['reportBytes']=graph_report_bytes(report)
    validate_physical_graph(report)
    if failure_evidence is not None:failure_evidence.finish()
    return report
