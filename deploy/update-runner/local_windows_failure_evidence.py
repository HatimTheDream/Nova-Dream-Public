"""Bounded private failure evidence. No native APIs or import-time effects.

Transcript durability follows the independently qualified local-activation-r2
writer. JSONL records are complete JSON objects; no alternate encoding is used.
The ledger is shared by the synchronous outer/inner qualification lifecycle.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat

MAX_FAILURE_EVIDENCE_BYTES = 32 * 1024**3
SEGMENT_BYTES = 64 * 1024**2
EMERGENCY_BYTES = 512 * 1024**2
PRIMARY_RECORD_BYTES = 512 * 1024**2
PORT_ERROR_RESERVE_BYTES = 64 * 1024
OWNER_NEGATIVE_BYTES = 640 * 1024
MAX_BASELINE_BYTES = 512 * 1024
MAX_IO_BYTES = 16 * 1024**2
MAX_RECORD_BYTES = 32 * MAX_BASELINE_BYTES + OWNER_NEGATIVE_BYTES + 2 * MAX_IO_BYTES
MAX_SCOPES = 32
MAX_SEGMENTS = 2 * math.ceil(MAX_FAILURE_EVIDENCE_BYTES / SEGMENT_BYTES) + 2 * MAX_SCOPES


def need(value, message):
    if not value:
        raise RuntimeError(message)


def encoded(value):
    return (json.dumps(value, ensure_ascii=True, allow_nan=False) + '\n').encode('ascii')


def ordinary(path, *, absent=False):
    path = Path(os.path.abspath(path))
    need(len(str(path)) <= 4096, 'Failure evidence path exceeds native bound')
    for parent in reversed(path.parents):
        row = parent.lstat()
        need(stat.S_ISDIR(row.st_mode) and not stat.S_ISLNK(row.st_mode)
             and not getattr(row, 'st_file_attributes', 0) & 0x400,
             'Failure evidence parent is redirected')
    if absent:
        need(not os.path.lexists(path), 'Failure evidence path already exists')
    else:
        row = path.lstat()
        need(not stat.S_ISLNK(row.st_mode) and not getattr(row, 'st_file_attributes', 0) & 0x400,
             'Failure evidence path is redirected')
    return path


def validate_configuration(root, maximum_bytes, *, must_be_absent=True):
    need(type(maximum_bytes) is int and EMERGENCY_BYTES < maximum_bytes <= MAX_FAILURE_EVIDENCE_BYTES,
         'Finite failure evidence budget required')
    path = ordinary(root, absent=must_be_absent)
    if not must_be_absent:
        need(path.is_dir(), 'Failure evidence root is not a directory')
    return {'root': str(path), 'maximumBytes': maximum_bytes}


def owner_reservation_bytes(path, baseline):
    # B includes the actual Unicode path and only the admitted original tuple.
    # Persistent fields <=6B; three guard-equal packed observations <=7B each
    # including worst-case base64/deflate expansion: 32B leaves control margin.
    # Separate negative allowance: three 64KiB security descriptors in base64,
    # one bounded packed post-close witness, one 64KiB raw stream refusal, and
    # 64KiB of fixed tuple/API/error control =590072 bytes; round to640KiB.
    value = {'path': str(path), **{key: baseline[key] for key in ('information', 'security', 'streams')}}
    size = len(encoded(value))
    need(len(str(path)) <= 4096 and size <= MAX_BASELINE_BYTES, 'Bounded original metadata required')
    return 32 * size + OWNER_NEGATIVE_BYTES


def verify_reference(reference, maximum):
    """Bounded full readback; never pass a primary artifact to a JSON reader."""
    path=ordinary(reference['path']);before=path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink==1
         and 0<=reference['bytes']<=maximum and before.st_size==reference['bytes'],
         'Failure evidence readback size or kind changed')
    digest=hashlib.sha256();total=0
    def identity(row):
        if os.name=='nt':
            # CPython#157671: Windows path stat reports legacy creation ctime,
            # while fstat reports change ctime. Compare explicit birthtime across
            # APIs and retain each API's own change/ctime stability below.
            need(type(getattr(row,'st_birthtime_ns',None)) is int,'Windows birthtime is unavailable')
            return (row.st_dev,row.st_ino,row.st_size,row.st_mtime_ns,row.st_birthtime_ns,row.st_nlink)
        return (row.st_dev,row.st_ino,row.st_size,row.st_mtime_ns,row.st_ctime_ns,row.st_nlink)
    with path.open('rb') as stream:
        opened=os.fstat(stream.fileno())
        need(identity(opened)==identity(before),'Failure evidence opened identity changed')
        while True:
            block=stream.read(min(1024*1024,maximum-total+1))
            if not block:break
            total+=len(block);need(total<=maximum,'Failure evidence readback bound exceeded');digest.update(block)
        after=os.fstat(stream.fileno())
        need(identity(after)==identity(opened) and after.st_ctime_ns==opened.st_ctime_ns,
             'Failure evidence changed during readback')
    final=path.lstat()
    need(identity(final)==identity(before) and final.st_ctime_ns==before.st_ctime_ns and total==reference['bytes']
         and digest.hexdigest()==reference['sha256'],'Failure evidence full readback mismatch')
    return reference


class Transcript:
    """Durability semantics copied from qualified local-activation-r2 Transcript."""
    def __init__(self, path, maximum):
        ordinary(path, absent=True); self.path = Path(path); self.maximum = maximum
        stream=self.path.open('xb')
        try:
            self.stream=stream;self.bytes=0;self.digest=hashlib.sha256();self.closed=False
            self.durable=False;self.failed=False
        except BaseException as primary:
            close_error=None
            try:stream.close()
            except BaseException as error:close_error=error
            error=RuntimeError('Failure transcript construction refused')
            error.unresolved_handle=not stream.closed
            error.observations={'path':str(self.path),'closed':stream.closed,
                'primary':type(primary).__name__,'close':type(close_error).__name__ if close_error else None}
            raise error from primary

    def write(self, value):
        try:
            data = encoded(value)
            need(self.bytes+len(data) <= self.maximum, 'Source closure transcript limit exceeded')
            need(self.stream.write(data) == len(data), 'Short closure transcript write')
            self.bytes += len(data); self.digest.update(data)
        except BaseException:
            self.failed = True
            raise

    def close(self):
        if self.closed:
            return
        primary = close_error = None
        try:
            self.stream.flush(); os.fsync(self.stream.fileno()); self.durable = True
        except BaseException as error:
            primary = error
        finally:
            try:
                self.stream.close()
            except BaseException as error:
                close_error = error
            self.closed = self.stream.closed
        if primary is not None or close_error is not None:
            self.failed = True
            error = RuntimeError('Activation transcript close refused')
            error.unresolved_handle = not self.closed
            error.observations = {'path':str(self.path),'durable':self.durable,
                                  'primary':type(primary).__name__ if primary else None,
                                  'close':type(close_error).__name__ if close_error else None}
            raise error from (primary or close_error)

    def ref(self):
        need(self.closed and self.durable and not self.failed, 'Complete durable closed transcript required')
        return {'path':str(self.path),'bytes':self.bytes,'sha256':self.digest.hexdigest()}


class Reservation:
    def __init__(self, scope, amount, kind, path, owner=None):
        self.scope, self.amount, self.kind, self.path, self.owner = scope, amount, kind, str(path), owner
        self.io_bytes = 0
        self.released = False

    def grow_io(self, reserve):
        need(type(reserve) is int and reserve >= 0 and self.io_bytes + reserve <= MAX_IO_BYTES,
             'Bounded failure I/O reservation required')
        self.scope.ledger._reserve(2 * reserve)
        self.amount += 2 * reserve; self.io_bytes += reserve

    def settle_io(self, reserve, used):
        need(0 <= used <= reserve, 'Failure I/O reservation exceeded')
        refund = 2 * (reserve - used)
        self.amount -= refund; self.io_bytes -= reserve - used
        self.scope.ledger.reserved_bytes -= refund


class FailureEvidenceLedger:
    validate_configuration = staticmethod(validate_configuration)

    def __init__(self, root, maximum_bytes=MAX_FAILURE_EVIDENCE_BYTES):
        config = validate_configuration(root, maximum_bytes)
        self.root = Path(config['root']); self.maximum_bytes = maximum_bytes
        self.root.mkdir()
        self.committed_bytes = self.reserved_bytes = self.uncertain_bytes = 0
        self.active_scope = None; self.scopes = []; self.names = set(); self.failed = False; self.segment_count = 0

    def _reserve(self, amount):
        need(type(amount) is int and amount >= 0, 'Nonnegative evidence reservation required')
        need(self.committed_bytes + self.reserved_bytes + self.uncertain_bytes + amount <= self.maximum_bytes,
             'Shared failure evidence capacity exhausted before source effect')
        self.reserved_bytes += amount

    def new_scope(self, name):
        self.require_idle()
        need(type(name) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', name)
             and name not in self.names and len(self.names)<MAX_SCOPES, 'Fresh bounded failure evidence scope required')
        self._reserve(EMERGENCY_BYTES)
        scope = FailureEvidenceScope(self, name)
        self.active_scope = scope; self.names.add(name)
        return scope

    def require_idle(self):
        need(self.active_scope is None and self.reserved_bytes == 0, 'Failure evidence owners remain active')
        return True

    def receipt(self):
        scope = self.active_scope
        return {'kind':'local-windows-failure-evidence-ledger','root':str(self.root),
            'maximumBytes':self.maximum_bytes,'committedBytes':self.committed_bytes,
            'reservedBytes':self.reserved_bytes,'uncertainBytes':self.uncertain_bytes,
            'chargedBytes':self.committed_bytes+self.uncertain_bytes,
            'remainingBytes':self.maximum_bytes-self.committed_bytes-self.uncertain_bytes-self.reserved_bytes,
            'activeScopes':int(scope is not None),'activePorts':len(scope.reservations) if scope else 0,
            'failed':self.failed,'scopes':list(self.scopes)}


class FailureEvidenceScope:
    def __init__(self, ledger, name):
        self.ledger, self.name = ledger, name
        self.reservations = []; self.owner_tokens = {}; self.segment = None; self.references = []
        self.segment_count = self.records = self.owner_records = self.primary_records = self.close_errors = 0
        self.closed = self.failed = False; self.errors = []; self.emergency_remaining = EMERGENCY_BYTES
        self.pending_bytes = 0; self.unresolved_handle = False; self.failed_segments = []; self.capture_report = None

    @property
    def root(self):
        return self.ledger.root

    def aggregate_reserve_bytes(self):
        # Every possible reference is accounted for using the actual root path,
        # with space for small counters/errors and conservative JSON punctuation.
        path = str(self.root / (self.name + '-segment-9999.jsonl'))
        return MAX_SEGMENTS * (len(encoded(path)) + 512) + 256*1024

    def admit_owner(self, owner, baseline):
        need(not self.closed and id(owner) not in self.owner_tokens, 'Unique active evidence owner required')
        amount = owner_reservation_bytes(owner.path, baseline)
        self.ledger._reserve(amount)
        token = Reservation(self, amount, 'owner', owner.path, owner)
        self.reservations.append(token); self.owner_tokens[id(owner)] = token
        return token

    def admit_port(self, path, kind):
        need(not self.closed and len(str(path)) <= 4096, 'Bounded active metadata port required')
        self.ledger._reserve(PORT_ERROR_RESERVE_BYTES)
        token = Reservation(self, PORT_ERROR_RESERVE_BYTES, kind, path)
        self.reservations.append(token)
        return token

    def _fail(self, error):
        self.failed = self.ledger.failed = True
        self.unresolved_handle |= bool(getattr(error, 'unresolved_handle', False))
        if len(self.errors) < 8:
            self.errors.append({'type':type(error).__name__,'message':str(error)[:2048]})

    def _close_segment(self):
        if self.segment is None:
            return
        segment = self.segment; self.segment = None
        try:
            segment.close()
            ref = {**verify_reference(segment.ref(),segment.maximum),
                'role':segment.role,'maximumBytes':segment.maximum}; self.references.append(ref)
            self.ledger.committed_bytes += ref['bytes']; self.pending_bytes -= ref['bytes']
        except BaseException as error:
            self.failed_segments.append({'path':str(segment.path),'bytesWrittenKnown':segment.bytes,
                'closed':segment.closed,'durable':segment.durable,'role':segment.role,'maximumBytes':segment.maximum})
            self._fail(error)
            raise

    def _new_segment(self, maximum):
        need(self.ledger.segment_count < MAX_SEGMENTS, 'Failure evidence segment count exhausted')
        path = self.root / (self.name + '-segment-' + str(self.segment_count).zfill(4) + '.jsonl')
        self.segment_count += 1; self.ledger.segment_count += 1
        try:
            self.segment = Transcript(path, maximum)
            self.segment.role='primary' if maximum>SEGMENT_BYTES else 'records'
        except BaseException:
            self.failed_segments.append({'path':str(path),'constructorOutcome':'uncertain','maximumBytes':maximum})
            raise

    def _write(self, value, token=None, *, primary=False):
        try:
            need(not self.closed and not self.failed, 'Failure evidence sink is not writable')
            data_bytes = len(encoded(value))
            available = self.emergency_remaining if token is None else token.amount
            need(data_bytes <= available, 'Failure evidence exceeds its pre-effect reservation')
            need(data_bytes <= (PRIMARY_RECORD_BYTES if primary else MAX_RECORD_BYTES), 'Failure record exceeds finite bound')
            need(primary or data_bytes<=SEGMENT_BYTES,'Owner evidence cannot use oversized primary segment')
            if primary:
                need(self.primary_records == 0, 'Only one primary exception record per capture')
            if self.segment is not None and (data_bytes > SEGMENT_BYTES or self.segment.bytes + data_bytes > self.segment.maximum):
                self._close_segment()
            if self.segment is None:
                self._new_segment(PRIMARY_RECORD_BYTES if data_bytes > SEGMENT_BYTES else SEGMENT_BYTES)
            # Keep the complete reservation until durable segment closure. The
            # final scope accounting converts only actual written bytes to used.
            self.segment.write(value); self.pending_bytes += data_bytes
            self.records += 1
            if token is None:self.emergency_remaining -= data_bytes
            else:token.amount -= data_bytes
            # This transferred part is still reserved while the segment is open.
            if primary:self.primary_records += 1
            if data_bytes > SEGMENT_BYTES:self._close_segment()
            return True
        except BaseException as error:
            self._fail(error)
            return False

    def primary(self, error, observations):
        return self._write({'kind':'primary-capture-failure','error':error,'observations':observations}, primary=True)

    def primary_capture(self, error, observations):
        value={'captureReport':self.capture_report}
        if self.capture_report is not None and observations is self.capture_report:
            value['failureObservationsRef']='captureReport'
        else:value['failureObservations']=observations
        return self.primary(error,value)

    def close_error(self, port, error):
        self.close_errors += 1
        token = next((t for t in self.reservations if t.owner is port), None)
        return self._write({'kind':'port-close-failure','path':str(port.path),'error':error}, token)

    def owner(self, port):
        token = self.owner_tokens.get(id(port))
        need(token is not None, 'Abort owner lacks its pre-acquisition reservation')
        self.owner_records += 1
        return self._write({'kind':'aborted-source-owner','physicalPath':str(port.path),
            'ownerKind':port.kind,'captureComplete':getattr(port,'_capture_completed',False),
            'nativeObservations':port.evidence}, token)

    def finish(self):
        if self.closed:
            return self.manifest
        try:
            self._close_segment()
        except BaseException:
            pass
        # All original source handles are closed by capture, independently of
        # this writer. Uncertain/failed proof space remains permanently charged.
        written = sum(r['bytes'] for r in self.references)
        # token/emergency amounts exclude bytes sent to the writer; recover the
        # complete reservation from pending+durable output, then release it once.
        outstanding = self.emergency_remaining + sum(t.amount for t in self.reservations) + self.pending_bytes + written
        self.ledger.reserved_bytes -= outstanding
        if self.failed:
            self.ledger.uncertain_bytes += max(0, outstanding - written)
        need(self.ledger.reserved_bytes >= 0, 'Failure evidence reservation accounting underflow')
        self.closed = True; self.ledger.active_scope = None
        self.capture_report = None
        self.manifest = {'kind':'local-windows-capture-failure-evidence','scope':self.name,
            'complete':not self.failed,'records':self.records,'ownerRecords':self.owner_records,
            'primaryRecords':self.primary_records,'closeErrors':self.close_errors,
            'segments':list(self.references),'failedSegmentCount':self.segment_count-len(self.references),
            'failedSegments':list(self.failed_segments),
            'errors':list(self.errors),'unresolvedHandle':self.unresolved_handle}
        self.ledger.scopes.append(self.manifest)
        return self.manifest
