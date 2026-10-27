"""Bounded source observation with handle-local last-access suppression.

Opening an aged file may update its access time before suppression can be applied.
After complete bounded I/O, a separately evidenced same-handle preservation step
returns only that observed acquisition change to the original BasicInfo tuple.
Full metadata/security/streams must match before the write, after it and after
close. No content, allocation, ACL or global filesystem setting is changed.
"""
import base64
import codecs
import copy
import ctypes
import hashlib
import json
from pathlib import Path, PureWindowsPath
import struct
import zlib

import local_windows_capture as capture

CHUNK_BYTES = 1024 * 1024
PAGE_BYTES = 16384
MAX_FILE_BYTES = 2 * 1024**3
MAX_ENTRIES = 100000
MAX_DATA_PAGES = 4096
MAX_SWEEPS = 4
MAX_IO_EVIDENCE = 16 * 1024**2


def acquisition_clock(port):
    """Use Windows system FILETIME, preserving its actual raw clock observation.

    NTFS access timestamps follow the system clock's granularity. A separately
    interpolated precise clock must not invent a later lower bound.
    """
    native = capture._primitive()
    value = native.FileTime()
    port.call('GetSystemTimeAsFileTime', port.k.GetSystemTimeAsFileTime,
              (ctypes.byref(value),), {'bytes': ctypes.sizeof(value)},
              lambda: {'bytes': ctypes.sizeof(value),
                       'base64': base64.b64encode(bytes(value)).decode('ascii')})
    observed = (value.high << 32) | value.low
    capture.require(0 < observed <= 0x7fffffffffffffff, 'acquisition-system-clock-invalid')
    return {'value100ns': observed, 'apiEvent': copy.deepcopy(port.events[-1])}


def acquisition_transition(before, after, security_before, security_after, started_100ns, ended_100ns):
    """Admit only a current access-time update caused during handle acquisition.

    Keep both complete observations; no field is removed from later comparisons.
    This is not permission for a timestamp change during content observation.
    """
    capture.require(type(started_100ns) is int and type(ended_100ns) is int
                    and 0 <= started_100ns <= ended_100ns, 'acquisition-clock-window-invalid')
    capture.require(type(before) is dict and type(after) is dict
                    and set(before) == set(after) == capture._primitive().INFO_FIELDS,
                    'complete-acquisition-metadata-required')
    capture.require(all(before[key] == after[key] for key in before if key != 'access100ns')
                    and security_before == security_after, 'acquisition-changed-nonaccess-state')
    old, new = before['access100ns'], after['access100ns']
    capture.require(type(old) is int and type(new) is int and old >= 0 and new >= 0,
                    'acquisition-access-time-invalid')
    changed = old != new
    capture.require(not changed or (old < new and started_100ns <= new <= ended_100ns),
                    'acquisition-access-time-outside-window')
    # Fixed structural references point only inside this same native-evidence
    # row. Complete observations already exist there; repeating them for every
    # physical file would waste the bounded report budget.
    return {'kind': 'post-acquisition-pre-io-baseline', 'accessTimeChanged': changed,
            'started100ns': started_100ns, 'ended100ns': ended_100ns,
            'before': {'informationRef': 'acquisitionBaseline.before',
                       'ownerGroupDaclRef': 'acquisitionBaseline.ownerGroupDaclBeforeBase64',
                       'access100ns': old},
            'after': {'informationRef': 'openedInformation',
                      'ownerGroupDaclRef': 'suppressionSecurityBase64', 'access100ns': new},
            'contentIoStarted': False}


def directory_page_evidence(raw):
    """Retain the complete native buffer, including padding, losslessly."""
    capture.require(type(raw) is bytes and len(raw) == PAGE_BYTES, 'directory-page-size')
    return {'rawEncoding': 'zlib-base64', 'rawBytes': len(raw),
            'rawSha256': hashlib.sha256(raw).hexdigest(),
            'rawZlibBase64': base64.b64encode(zlib.compress(raw)).decode('ascii')}


def parse_directory_page(raw, seen, maximum):
    """Parse a successful fixed zero-initialized FILE_ID_BOTH_DIR_INFO page.

    BOOL success provides no initialized-byte count. Offsets/UTF-16 lengths
    bound every interpreted field; unused padding remains only raw evidence.
    A zero next offset ends this page, not enumeration (separate FALSE/18).
    """
    capture.require(type(raw) is bytes and len(raw) == PAGE_BYTES, 'directory-page-size')
    capture.require(type(seen) is set and type(maximum) is int and 0 < maximum <= MAX_ENTRIES,
                    'bounded-directory-parser-input')
    offset, result = 0, []
    for _ in range(PAGE_BYTES // 104):
        capture.require(offset + 104 <= PAGE_BYTES, 'directory-header-truncated')
        following, file_index = struct.unpack_from('<II', raw, offset)
        attributes, name_bytes = struct.unpack_from('<II', raw, offset + 56)
        short_bytes, = struct.unpack_from('<b', raw, offset + 68)
        capture.require(0 <= short_bytes <= 24 and short_bytes % 2 == 0, 'directory-short-name-length')
        extent = following if following else PAGE_BYTES - offset
        capture.require(name_bytes > 0 and name_bytes % 2 == 0 and name_bytes <= 510
                        and 104 + name_bytes <= extent and offset + 104 + name_bytes <= PAGE_BYTES,
                        'directory-name-out-of-bounds')
        if following:
            capture.require(following % 8 == 0 and following >= 104 + name_bytes
                            and offset + following + 104 <= PAGE_BYTES, 'directory-next-offset-invalid')
        name = codecs.utf_16_le_decode(raw[offset + 104:offset + 104 + name_bytes], 'strict', True)[0]
        short = codecs.utf_16_le_decode(raw[offset + 70:offset + 70 + short_bytes], 'strict', True)[0]
        capture.require(name and not any(ch in name for ch in '/\\:\x00')
                        and name.casefold() not in seen, 'directory-name-or-case-alias-invalid')
        if name in ('.', '..'):
            capture.require(bool(attributes & 0x10) and not attributes & 0x400
                            and (not short or short == name), 'directory-dot-entry-invalid')
        else:
            # Keep the same Windows ordinary-component boundary as actual opens.
            capture._primitive().canonical_path('C:\\' + name)
            capture.require(not short or (short not in ('.', '..')
                            and not any(ch in short for ch in '/\\:\x00')), 'directory-short-name-invalid')
            capture.require(len(seen) - int('.' in seen) - int('..' in seen) < maximum,
                            'directory-entry-budget-exceeded')
        seen.add(name.casefold())
        result.append({'name': name, 'shortName': short, 'attributes': attributes,
                       'fileIndex': file_index, 'fileId': struct.unpack_from('<Q', raw, offset + 96)[0]})
        if not following:
            return result
        offset += following
    raise capture.CaptureRefused('directory-page-record-budget-exceeded')


class NeutralHeld(capture._Held):
    """Reuse qualified metadata/stream/close behavior; separate bounded I/O log."""
    def __init__(self, path, kind, deadline, *, expected_links=1, failure_evidence=None, cleanup_budget=None):
        capture.require(kind in ('file', 'directory'), 'neutral-source-kind')
        if cleanup_budget is not None:
            capture.require(type(cleanup_budget) is capture.CaptureCleanupBudget,'admitted-cleanup-budget-required')
            cleanup_budget.validate_owner(deadline)
        self._cleanup_budget=cleanup_budget;self._cleanup_active=False
        self.path, self.kind, self.deadline = Path(path), kind, deadline
        self.expected_links = expected_links
        self.port, self.handle, self.closed = capture._primitive().Win32(), None, False
        self._owner_port, self._owner_handle, self._owner_kind = self.port, None, kind
        self.evidence = {'path': str(self.path), 'kind': kind,
                         'ioEvents': [], 'directorySweeps': []}
        if expected_links != 1:
            self.evidence['expectedLinks'] = expected_links
        self._io_bytes = 0
        self._read_attempted = False
        self._baseline = None
        self._original_baseline = None
        self._preservation_attempted = False
        self._capture_completed = False
        self._source_io_stopped = False
        self._active_io = None
        self._io_native_returned = True
        self._failure_reservation = None
        baseline = None
        primary = None
        close_errors = []
        try:
            capture._check(deadline)
            # The already-qualified metadata-only handle also proves coexistence
            # with the original share-READ file custody. It never reads content.
            baseline = capture._Held(self.path, kind, deadline, expected_links=expected_links)
            baseline.streams()
            self._baseline = baseline.capture()
            self._original_baseline = copy.deepcopy({key:self._baseline[key] for key in ('information','security','streams')})
            self.evidence['acquisitionBaseline'] = baseline.evidence
            if failure_evidence is not None:
                # The metadata-only baseline is complete; reserve the complete
                # negative/closure proof BEFORE the first data-owner open.
                self._failure_reservation = failure_evidence.admit_owner(self,self._original_baseline)
            native, p = capture._primitive(), self.port
            native.canonical_path(str(self.path))
            p.k.SetFileTime.argtypes = [native.HANDLE, ctypes.POINTER(native.FileTime),
                                       ctypes.POINTER(native.FileTime), ctypes.POINTER(native.FileTime)]
            p.k.SetFileTime.restype = native.BOOL
            p.k.ReadFile.argtypes = [native.HANDLE, ctypes.c_void_p, native.DWORD,
                                    ctypes.POINTER(native.DWORD), ctypes.c_void_p]
            p.k.ReadFile.restype = native.BOOL
            p.k.GetSystemTimeAsFileTime.argtypes = [ctypes.POINTER(native.FileTime)]
            p.k.GetSystemTimeAsFileTime.restype = None
            share = 0 if kind == 'directory' else 1
            clock = self.evidence['acquisitionClock'] = {}
            clock['beforeOpen'] = acquisition_clock(p)
            acquired_start = clock['beforeOpen']['value100ns']
            # Metadata admission may have consumed the original work budget.
            # A cleanup allowance never authorizes a new data-owner acquisition.
            if self._cleanup_budget is not None:capture._check(self.deadline)
            self.handle = p.call('CreateFileW', p.k.CreateFileW,
                (str(self.path), 0x20181, share, None, 3, 0x02200000, None),
                {'path': str(self.path), 'access': 0x20181, 'share': share,
                 'disposition': 3, 'flags': 0x02200000})
            self._owner_handle = self.handle
            p.require(self.handle not in (None, ctypes.c_void_p(-1).value), 'CreateFileW')
            sentinel = native.FileTime(0xffffffff, 0xffffffff)
            ok = p.call('SetFileTime:access-suppression', p.k.SetFileTime,
                (self.handle, None, ctypes.byref(sentinel), None),
                {'handle': self.handle, 'creation': None, 'accessLow': 0xffffffff,
                 'accessHigh': 0xffffffff, 'write': None})
            self.evidence['accessTimeSuppression'] = {
                'kind': 'per-handle-last-access-suppression', 'access': 0x20181,
                'creation': None, 'write': None, 'accessLow': 0xffffffff, 'accessHigh': 0xffffffff,
                'immediateAfterOpen': True, 'sameHandle': True, 'result': bool(ok), 'lastError': p.last_error}
            self.evidence['accessTimeSuppressionEvent'] = copy.deepcopy(p.events[-1])
            p.require(ok, 'SetFileTime')
            info = self.evidence['openedInformation'] = capture._info_checked(p.info(self.handle), kind, expected_links=expected_links)
            clock['afterInformation'] = acquisition_clock(p)
            acquired_end = clock['afterInformation']['value100ns']
            self.evidence['acquisitionWindow100ns'] = {'started': acquired_start, 'ended': acquired_end}
            security = base64.b64encode(native.checked_security(p.security(self.handle))).decode('ascii')
            self.evidence['suppressionSecurityBase64'] = security
            self.evidence['acquisitionTransition'] = acquisition_transition(
                self._baseline['information'], info,
                self._baseline['security']['ownerGroupDaclBase64'], security,
                acquired_start, acquired_end)
            # The pre-acquisition observation remains in acquisitionBaseline.
            # Only the qualified initial access transition changes this baseline;
            # security/streams and every later full equality remain unchanged.
            self._baseline = {**self._baseline, 'information': copy.deepcopy(info)}
        except BaseException as error:
            primary = error
        finally:
            if baseline is not None:
                try:
                    baseline.close()
                except BaseException as error:
                    close_errors.append({'role': 'metadata-baseline', 'error': capture._error(error)})
                self.evidence['acquisitionBaseline'] = baseline.evidence
        if primary is not None or close_errors:
            try:
                self.close()
            except BaseException as error:
                close_errors.append({'role': 'neutral-source', 'error': capture._error(error)})
            raise capture.CaptureRefused('neutral-source-open-refused', {
                **self.evidence, 'original': capture._error(primary) if primary else None,
                'originalObservations': getattr(primary, 'observations', None),
                'apiEvents': self.port.events, 'baselineApiEvents': baseline.port.events if baseline else None,
                'closeErrors': close_errors,
                'unresolvedHandle': bool(close_errors) or bool(getattr(primary, 'unresolved_handle', False))}) from primary

    def _metadata_deadline(self):
        if self._cleanup_active and self._cleanup_budget is not None:
            return self._cleanup_budget.begin()
        return self.deadline

    def _ready(self, kind, *, cleanup=False):
        capture.require(not self._cleanup_active or cleanup,'public-source-io-during-cleanup-refused')
        capture.require(not cleanup or self._cleanup_active,'internal-cleanup-context-required')
        capture._check(self._metadata_deadline() if cleanup else self.deadline)
        capture.require(not self._source_io_stopped, 'source-io-after-abort-settlement-refused', self.evidence)
        capture.require(not self._preservation_attempted, 'source-io-after-preservation-refused', self.evidence)
        capture.require(not self.closed and self.handle not in (None, ctypes.c_void_p(-1).value)
                        and self.handle == self._owner_handle and self.port is self._owner_port
                        and self.kind == self._owner_kind == kind
                        and self.evidence['accessTimeSuppression']['result'] is True,
                        'live-suppressed-source-handle-required', self.evidence)

    def close(self):
        # Only this internal dynamic scope may use the admitted cleanup clock.
        # Public I/O still refuses even if called from a native callback here.
        prior=self._cleanup_active
        self._cleanup_active=True
        try:
            return self._close_owner()
        finally:
            self._cleanup_active=prior

    def _close_owner(self):
        # Close only the originally returned handle, once, including on refusal.
        if self._owner_handle not in (None, ctypes.c_void_p(-1).value) and not self.closed:
            primary = None; close_error = None; post_error = None
            try:
                if self._cleanup_budget is not None:self._cleanup_budget.begin()
                if not self._capture_completed and not self._preservation_attempted:
                    self._settle_aborted_observation()
            except BaseException as error:
                primary = error
            finally:
                self.closed = True
                try:
                    self._owner_port.close(self._owner_handle)
                    self.evidence['handleClosed'] = True
                    capture.require(self.handle == self._owner_handle and self.port is self._owner_port,
                                    'source-handle-authority-replaced', self.evidence)
                except BaseException as error:
                    close_error = error
            if close_error is None:
                try:
                    if self._preservation_attempted:
                        self._post_close_observation()
                    elif self.evidence.get('abortedObservation',{}).get('verifiedBeforeClose') is True:
                        self._post_close_observation(self.evidence['abortedObservation'])
                except BaseException as error:
                    post_error = error
            if primary is not None or close_error is not None or post_error is not None:
                raise capture.CaptureRefused('source-close-preservation-refused', {
                    **self.evidence, 'settlementError':capture._error(primary) if primary else None,
                    'closeError':capture._error(close_error) if close_error else None,
                    'postCloseError':capture._error(post_error) if post_error else None,
                    'unresolvedHandle':close_error is not None or any(getattr(error,'unresolved_handle',False)
                        for error in (primary,close_error,post_error))}) from (primary or close_error or post_error)

    def _settle_aborted_observation(self):
        """Preserve a validated acquisition without claiming a complete capture."""
        settled=self._active_io is None or self._io_native_returned is True
        record=self.evidence['abortedObservation']={
            'kind':'aborted-source-observation','captureComplete':False,'contentIoComplete':False,
            'synchronousIoSettled':settled,'ioStopped':False,'verifiedBeforeClose':False,
            'readAttempted':self._read_attempted,'readProgress':copy.deepcopy(self.evidence.get('readResult')),
            'directoryProgress':[{'sequence':row['sequence'],'complete':row.get('complete') is True,
                'eof':row.get('eof') is True,'namesObserved':len(row.get('names',[]))}
                for row in self.evidence['directorySweeps']],
            'ioEventsObserved':len(self.evidence['ioEvents']),
            'lastNativeIoReturned':self._io_native_returned,
            'metadataRestorationProven':False}
        if self._cleanup_budget is not None:record['cleanupBudget']=self._cleanup_budget.receipt()
        try:
            capture.require(settled,'abort-source-io-not-settled',record)
            self._ready(self._owner_kind,cleanup=True)
            capture.require(self._original_baseline is not None and self._baseline is not None
                and self.evidence.get('acquisitionTransition',{}).get('kind')=='post-acquisition-pre-io-baseline'
                and type(self.evidence['acquisitionTransition'].get('accessTimeChanged')) is bool,
                'abort-acquisition-authority-incomplete',self.evidence)
            start=len(self.port.events)
            streams=super().streams()
            capture.require(streams==self._baseline['streams'],'abort-source-streams-mismatch',self.evidence)
            current=super().capture()
            capture.require(all(current[key]==self._baseline[key] for key in ('information','security','streams')),
                            'abort-source-acquired-state-mismatch',self.evidence)
            record['settledObservation']=capture.pack_metadata_observation(
                self._observation(current,self.evidence,self.port.events[start:]))
            if self.evidence['acquisitionTransition']['accessTimeChanged']:
                restored=self._preserve_original_access(current,self.port.events[start:],aborted=True)
            else:
                self._source_io_stopped=True;record['ioStopped']=True;restored=current
            capture.require(all(restored[key]==self._original_baseline[key] for key in ('information','security','streams')),
                            'abort-source-original-tuple-not-restored',self.evidence)
            record['verifiedBeforeClose']=True
        except BaseException as error:
            self._source_io_stopped=True;record['ioStopped']=True
            record['error']=capture._error(error)
            raise

    @staticmethod
    def _observation(result, evidence, events):
        return {'information':copy.deepcopy(result['information']),
                'security':copy.deepcopy(result['security']), 'streams':copy.deepcopy(result['streams']),
                'observations':{key:copy.deepcopy(evidence[key]) for key in
                    ('openedInformation','before','after','ownerGroupDaclBeforeBase64','ownerGroupDaclAfterBase64')},
                'apiEvents':copy.deepcopy(events)}

    def _post_close_observation(self, record=None):
        """One metadata-only reopen after the original data handle has closed."""
        record=self.evidence['metadataPreservation'] if record is None else record
        held=None;primary=None;close_error=None;value=None
        try:
            held=capture._Held(self.path,self._owner_kind,self._metadata_deadline(),expected_links=self.expected_links)
            held.streams();value=held.capture()
            if self._cleanup_budget is not None:capture._check(self._metadata_deadline())
            capture.require(all(value[key]==self._original_baseline[key] for key in ('information','security','streams')),
                            'source-preservation-postclose-mismatch',held.evidence)
        except BaseException as error:
            primary=error
        finally:
            if held is not None:
                try:held.close()
                except BaseException as error:close_error=error
                if value is not None:
                    observed=self._observation(value,held.evidence,held.port.events)
                    observed['observations']['handleClosed']=held.evidence.get('handleClosed') is True
                    record['postCloseObservation']=capture.pack_metadata_observation(observed)
                else:
                    record['postCloseFailureObservation']=capture.pack_metadata_observation({
                        'observations':held.evidence,'apiEvents':held.port.events})
            if primary is not None or close_error is not None:
                record['postCloseError']={'primary':capture._error(primary) if primary else None,
                                         'close':capture._error(close_error) if close_error else None}
        if primary is not None or close_error is not None:
            record['unresolvedHandle']=close_error is not None or any(getattr(error,'unresolved_handle',False)
                for error in (primary,close_error))
            raise capture.CaptureRefused('source-preservation-postclose-refused',record) from (primary or close_error)
        if 'abortedObservation' in self.evidence:
            self.evidence['abortedObservation']['metadataRestorationProven']=True

    def _preserve_original_access(self, result, prewrite_events, *, aborted=False):
        """Mutate only the original BasicInfo after all observations are complete."""
        self._ready(self._owner_kind,cleanup=aborted)
        original=self._original_baseline
        capture.require(self.evidence['acquisitionTransition']['accessTimeChanged'] is True
            and all(result[key]==self._baseline[key] for key in ('information','security','streams')),
            'source-preservation-prewrite-mismatch',self.evidence)
        expected=original['information'];p=self._owner_port;native=capture._primitive()
        basic={key:expected[key] for key in capture.PRESERVED_BASIC_FIELDS}
        record=self.evidence['metadataPreservation']={'kind':('same-handle-aborted-access-preservation' if aborted else 'same-handle-access-preservation'),
            'attempted':False,'completed':False,
            'preWriteObservation':capture.pack_metadata_observation(self._observation(result,self.evidence,prewrite_events)),
            'intent':{'kind':'restore-observed-access-on-original-handle','handle':self._owner_handle,
                'originalInformationRef':'acquisitionBaseline.before','expectedPreWriteInformationRef':'openedInformation',
                'originalBasicInfo':basic,'contentIoComplete':not aborted}}
        if aborted:
            capture.require(self.evidence['abortedObservation']['synchronousIoSettled'] is True,
                            'abort-native-io-not-settled',self.evidence)
            record['intent'].update(abortedObservationRef='abortedObservation',synchronousIoSettled=True)
            self._source_io_stopped=True;self.evidence['abortedObservation']['ioStopped']=True
        p.k.SetFileInformationByHandle.argtypes=[native.HANDLE,ctypes.c_int32,ctypes.c_void_p,native.DWORD]
        p.k.SetFileInformationByHandle.restype=native.BOOL
        value=native.BasicInfo(*(expected[key] for key in capture.PRESERVED_BASIC_FIELDS))
        # From this point no further content read or directory sweep is admitted,
        # even if the one write fails or its response is uncertain.
        if aborted and self._cleanup_budget is not None:capture._check(self._metadata_deadline())
        self._preservation_attempted=True;record['attempted']=True
        try:
            ok=p.call('SetFileInformationByHandle:source-basic-preservation',p.k.SetFileInformationByHandle,
                (self._owner_handle,0,ctypes.byref(value),ctypes.sizeof(value)),
                {'handle':self._owner_handle,'class':0,'bytes':ctypes.sizeof(value),'information':basic},
                lambda:{'bytes':ctypes.sizeof(value),'base64':base64.b64encode(bytes(value)).decode('ascii')})
            record['apiEvent']=copy.deepcopy(p.events[-1]);p.require(ok,'source-basic-preservation')
            streams=super().streams()
            capture.require(streams==original['streams'],'source-preservation-streams-mismatch',self.evidence)
            restored=super().capture()
            capture.require(all(restored[key]==original[key] for key in ('information','security','streams')),
                            'source-preservation-postwrite-mismatch',self.evidence)
            record['completed']=True
            return restored
        except BaseException as error:
            record.setdefault('apiEvent',copy.deepcopy(p.events[-1]))
            record['error']=capture._error(error)
            raise

    def _begin_io(self, event, reserve):
        # Charge before native dispatch; raw directory pages/failed results are
        # never dropped to fit a budget. Final capture owns the aggregate limit.
        capture.require(self._io_bytes + reserve <= MAX_IO_EVIDENCE, 'neutral-io-evidence-budget-exceeded', self.evidence)
        if self._failure_reservation is not None:
            self._failure_reservation.grow_io(reserve)
        self._io_bytes += reserve
        self.evidence['ioEvents'].append(event)
        self._active_io=event;self._io_native_returned=False
        return event

    def _finish_io(self, event, reserve):
        used = len(json.dumps(event, ensure_ascii=True, allow_nan=False).encode('ascii')) + 64
        capture.require(used <= reserve, 'neutral-io-event-reserve-exceeded', self.evidence)
        if self._failure_reservation is not None:
            self._failure_reservation.settle_io(reserve,used)
        self._io_bytes -= reserve - used
        self._active_io=None

    def _refused(self, reason, error):
        return capture.CaptureRefused(reason, {**self.evidence,
            'original': capture._error(error), 'apiEvents': self.port.events,
            'originalObservations': None if getattr(error, 'observations', None) is self.evidence
                else getattr(error, 'observations', None)})

    def streams(self):
        try:
            self._ready(self._owner_kind)
            rows = super().streams()
            capture.require(rows == self._baseline['streams'], 'source-streams-changed', self.evidence)
            return rows
        except BaseException as error:
            raise self._refused('neutral-source-stream-refused', error) from error

    def capture(self):
        self._ready(self._owner_kind)
        if self.kind == 'file':
            capture.require(self.evidence.get('readResult', {}).get('complete') is True,
                            'complete-same-handle-read-required', self.evidence)
        elif self.kind == 'directory':
            capture.require(self.evidence['directorySweeps'] and all(row.get('complete') is True
                            for row in self.evidence['directorySweeps']), 'complete-same-handle-enumeration-required', self.evidence)
        try:
            prewrite_start=len(self.port.events)
            # Recheck streams immediately before any preservation write.
            rows=super().streams()
            capture.require(rows==self._baseline['streams'],'source-streams-changed',self.evidence)
            result = super().capture()
            capture.require(result['information'] == self._baseline['information']
                            and result['security'] == self._baseline['security']
                            and result['streams'] == self._baseline['streams'],
                            'source-observation-changed-stored-metadata', self.evidence)
            if self.evidence['acquisitionTransition']['accessTimeChanged']:
                result=self._preserve_original_access(result,self.port.events[prewrite_start:])
            self._capture_completed=True
            return result
        except BaseException as error:
            raise self._refused('neutral-source-capture-refused', error) from error

    def read_chunks(self, maximum):
        self._ready('file')
        capture.require(type(maximum) is int and 0 < maximum <= MAX_FILE_BYTES and not self._read_attempted,
                        'one-bounded-source-read-required')
        self._read_attempted = True
        size = self.evidence['openedInformation']['size']
        capture.require(size <= maximum, 'held-file-size-exceeds-bound', self.evidence)
        native, total, digest = capture._primitive(), 0, hashlib.sha256()
        read_result = self.evidence['readResult'] = {'bytes': 0, 'sha256': None, 'complete': False, 'eof': False}
        calls = (size + CHUNK_BYTES - 1) // CHUNK_BYTES + 1
        try:
            for _ in range(calls):
                self._ready('file')
                buffer, returned = ctypes.create_string_buffer(CHUNK_BYTES), native.DWORD()
                event = self._begin_io({'api': 'ReadFile', 'requestedBytes': CHUNK_BYTES}, 1024)
                ctypes.set_last_error(0)
                ok = self.port.k.ReadFile(self.handle, buffer, CHUNK_BYTES, ctypes.byref(returned), None)
                self._io_native_returned=True
                event.update(result=bool(ok), lastError=ctypes.get_last_error(), returnedBytes=returned.value)
                capture.require(returned.value <= CHUNK_BYTES and (ok or (event['lastError'] == 38 and returned.value == 0)),
                                'same-handle-read-refused', self.evidence)
                chunk = buffer.raw[:returned.value]
                event['returnedSha256'] = hashlib.sha256(chunk).hexdigest()
                self._finish_io(event, 1024)
                total += len(chunk)
                capture.require(total <= size, 'same-handle-size-overrun', self.evidence)
                digest.update(chunk)
                read_result.update(bytes=total, sha256=digest.hexdigest())
                if not chunk:
                    read_result['eof'] = True
                    capture.require(total == size, 'same-handle-short-read', self.evidence)
                    read_result['complete'] = True
                    return
                yield chunk
            raise capture.CaptureRefused('same-handle-read-call-budget-exceeded', self.evidence)
        except BaseException as error:
            read_result['error'] = capture._error(error)
            raise self._refused('neutral-source-read-refused', error) from error

    def list_names(self, *, max_entries, max_pages):
        self._ready('directory')
        capture.require(type(max_entries) is int and 0 < max_entries <= MAX_ENTRIES
                        and type(max_pages) is int and 0 < max_pages <= MAX_DATA_PAGES
                        and len(self.evidence['directorySweeps']) < MAX_SWEEPS, 'bounded-directory-sweep-required')
        seen, names = set(), []
        sweep = {'sequence': len(self.evidence['directorySweeps']), 'maxEntries': max_entries,
                 'maxDataPages': max_pages, 'complete': False, 'eof': False, 'names': names}
        self.evidence['directorySweeps'].append(sweep)
        try:
            for index in range(max_pages + 1):
                self._ready('directory')
                buffer = (ctypes.c_uint64 * (PAGE_BYTES // 8))()
                info_class = 11 if index == 0 else 10
                event = self._begin_io({'api': 'GetFileInformationByHandleEx:directory',
                    'sweep': sweep['sequence'], 'class': info_class, 'bufferBytes': PAGE_BYTES}, 131072)
                ctypes.set_last_error(0)
                ok = self.port.k.GetFileInformationByHandleEx(self.handle, info_class, buffer, PAGE_BYTES)
                self._io_native_returned=True
                last_error, raw = ctypes.get_last_error(), bytes(buffer)
                event.update(result=bool(ok), lastError=last_error, **directory_page_evidence(raw))
                if not ok:
                    capture.require(last_error == 18, 'same-handle-directory-query-refused', self.evidence)
                    self._finish_io(event, 131072)
                    sweep.update(complete=True, eof=True)
                    return names.copy()
                capture.require(index < max_pages, 'directory-data-page-budget-exceeded', self.evidence)
                rows = parse_directory_page(raw, seen, max_entries)
                event['rows'] = rows
                self._finish_io(event, 131072)
                names.extend(row['name'] for row in rows if row['name'] not in ('.', '..'))
            raise capture.CaptureRefused('directory-terminal-query-missing', self.evidence)
        except BaseException as error:
            sweep['error'] = capture._error(error)
            raise self._refused('neutral-source-enumeration-refused', error) from error


def open_source(path, kind, deadline, *, expected_links=1, failure_evidence=None, cleanup_budget=None):
    if kind == 'junction':
        held = capture._Held(Path(path), kind, deadline)
        held.evidence['sourceObservationMode'] = 'metadata-only-junction'
        return held
    return NeutralHeld(path, kind, deadline,expected_links=expected_links,failure_evidence=failure_evidence,
        cleanup_budget=cleanup_budget)
