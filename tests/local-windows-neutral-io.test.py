"""New neutral-observer boundaries only: fake API calls, no native filesystem I/O."""
import base64
import copy
import ctypes
import hashlib
import importlib.util
from pathlib import Path
import struct
import sys
import time
import types
import unittest
import zlib
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/update-runner'))
import local_windows_capture as capture
import local_windows_neutral_io as subject

native = capture._primitive()  # Authenticated definitions only, never Win32().
SECURITY = b'x' * 20


def info(kind='file', size=7):
    return {'volumeSerial32': 1, 'fileIndex64': 2, 'volumeSerial64': 1,
        'fileId128Hex': '02' + '00' * 15, 'attributes': 16 if kind == 'directory' else 32,
        'reparseTag': 0, 'links': 1, 'directory': kind == 'directory', 'deletePending': False,
        'size': size, 'allocationBytes': 4096, 'creation100ns': 100,
        'access100ns': 200, 'write100ns': 300, 'change100ns': 400}


def directory_page(names):
    raw = bytearray(subject.PAGE_BYTES)
    offset = 0
    for index, name in enumerate(names):
        encoded = name.encode('utf-16-le')
        length = (104 + len(encoded) + 7) // 8 * 8
        struct.pack_into('<II', raw, offset, length if index + 1 < len(names) else 0, index)
        struct.pack_into('<II', raw, offset + 56, 16 if name in ('.', '..', 'child') else 32, len(encoded))
        struct.pack_into('<Q', raw, offset + 96, index + 1)
        raw[offset + 104:offset + 104 + len(encoded)] = encoded
        offset += length
    return bytes(raw)


class Function:
    def __init__(self, body): self.body = body
    def __call__(self, *args): return self.body(*args)


class Fixture:
    def __init__(self, kind='file', payload=b'fixture'):
        self.kind, self.payload = kind, payload
        self.row = info(kind, len(payload) if kind == 'file' else 0)
        self.calls, self.ports = [], []
        self.error = 0
        self.suppress_ok = True
        self.close_fails = False
        self.read_fails = False
        self.query_fails = False
        self.query_names = ['.', '..', 'child', 'résumé.txt']
        self.baseline_closed = 0
        self.clock_values = [1000, 1100]

    def baseline_type(self):
        fixture = self
        class Baseline:
            def __init__(self, path, kind, deadline):
                fixture.calls.append('baseline-open')
                self.evidence = {'openedInformation': copy.deepcopy(fixture.row)}
                self.port = types.SimpleNamespace(events=[{'api': 'synthetic-baseline'}])
                self.closed = False
            def streams(self):
                self.evidence['streams'] = [] if fixture.kind == 'directory' else [
                    {'name': '::$DATA', 'bytes': len(fixture.payload), 'allocationBytes': 4096,
                     'rawBase64': base64.b64encode(stream_bytes(fixture.payload)[:38]).decode('ascii')}]
            def capture(self):
                self.evidence.update(before=copy.deepcopy(fixture.row), after=copy.deepcopy(fixture.row),
                    ownerGroupDaclBeforeBase64=base64.b64encode(SECURITY).decode('ascii'),
                    ownerGroupDaclAfterBase64=base64.b64encode(SECURITY).decode('ascii'))
                return {'information': copy.deepcopy(fixture.row), 'security': {
                    'ownerGroupDaclBase64': base64.b64encode(SECURITY).decode('ascii'), 'saclNotRequested': True},
                    'streams': self.evidence['streams'], 'nativeObservations': self.evidence}
            def close(self):
                if not self.closed:
                    self.closed = True
                    fixture.baseline_closed += 1
                    fixture.calls.append('baseline-close')
                    self.evidence['handleClosed'] = True
        return Baseline

    def port_type(self):
        fixture = self
        class Port:
            def __init__(self):
                self.events, self.last_error, self.closes, self.position, self.page = [], 0, 0, 0, 0
                fixture.ports.append(self)
                self.k = types.SimpleNamespace(CreateFileW=Function(self.open), SetFileTime=Function(self.suppress),
                    ReadFile=Function(self.read), GetFileInformationByHandleEx=Function(self.query),
                    GetSystemTimeAsFileTime=Function(self.clock),
                    SetFileInformationByHandle=Function(self.set_basic))
            def set_basic(self, handle, information_class, raw, length):
                fixture.calls.append(('set-basic',handle,information_class,length))
                if information_class != 0 or length != ctypes.sizeof(native.BasicInfo):
                    raise AssertionError('Only exact BasicInfo is permitted')
                value=ctypes.cast(raw,ctypes.POINTER(native.BasicInfo)).contents
                for field,attr in (('creation100ns','creation'),('access100ns','access'),('write100ns','write'),
                                   ('change100ns','change'),('attributes','attributes')):
                    fixture.row[field]=getattr(value,attr)
                return 1
            def clock(self, output):
                value = fixture.clock_values.pop(0)
                target = ctypes.cast(output, ctypes.POINTER(native.FileTime)).contents
                target.low, target.high = value & 0xffffffff, value >> 32
                return None
            def open(self, path, access, share, security, disposition, flags, template):
                fixture.calls.append(('open', access, share, flags))
                return 11
            def suppress(self, handle, creation, access, write):
                sentinel = ctypes.cast(access, ctypes.POINTER(native.FileTime)).contents
                fixture.calls.append(('suppress', handle, creation, sentinel.low, sentinel.high, write))
                fixture.error = 0 if fixture.suppress_ok else 5
                return fixture.suppress_ok
            def call(self, name, function, arguments, description, raw=None):
                event = {'api': name, 'arguments': description}
                self.events.append(event)
                result = function(*arguments)
                self.last_error = fixture.error
                event.update(result=result, lastError=self.last_error)
                if raw is not None: event['raw'] = raw()
                return result
            def require(self, ok, phase):
                if not ok: raise OSError(self.last_error, phase)
            def info(self, handle):
                fixture.calls.append('info')
                return copy.deepcopy(fixture.row)
            def security(self, handle): return SECURITY
            def close(self, handle):
                self.closes += 1
                fixture.calls.append(('close', handle))
                if fixture.close_fails: raise OSError(6, 'synthetic close')
            def read(self, handle, buffer, maximum, returned, overlapped):
                fixture.calls.append('ReadFile')
                if fixture.read_fails:
                    fixture.error = 5
                    return False
                data = fixture.payload[self.position:self.position + maximum]
                self.position += len(data)
                ctypes.memmove(buffer, data, len(data))
                ctypes.cast(returned, ctypes.POINTER(native.DWORD)).contents.value = len(data)
                fixture.error = 38 if not data else 0
                return bool(data)
            def query(self, handle, info_class, buffer, length):
                if info_class == 7:
                    if fixture.kind == 'directory':
                        fixture.error = 38
                        return False
                    ctypes.memmove(buffer, stream_bytes(fixture.payload), length)
                    fixture.error = 0
                    return True
                fixture.calls.append(('query', info_class))
                if fixture.query_fails:
                    fixture.error = 5
                    return False
                if info_class == 11: self.page = 0
                if self.page == 0:
                    self.page += 1
                    ctypes.memmove(buffer, directory_page(fixture.query_names), length)
                    fixture.error = 0
                    return True
                fixture.error = 18
                return False
        return Port


def stream_bytes(payload):
    raw = bytearray(capture.STREAM_BUFFER)
    name = '::$DATA'.encode('utf-16-le')
    struct.pack_into('<IIqq', raw, 0, 0, len(name), len(payload), 4096)
    raw[24:24 + len(name)] = name
    return bytes(raw)


class NeutralIOTests(unittest.TestCase):
    def test_directory_page_evidence_is_lossless_and_bounded(self):
        for raw in (bytes(subject.PAGE_BYTES), bytes(range(256)) * (subject.PAGE_BYTES // 256)):
            evidence = subject.directory_page_evidence(raw)
            restored = zlib.decompress(base64.b64decode(evidence['rawZlibBase64'], validate=True))
            self.assertEqual(restored, raw)
            self.assertEqual(evidence['rawEncoding'], 'zlib-base64')
            self.assertEqual(evidence['rawBytes'], len(raw))
            self.assertEqual(evidence['rawSha256'], hashlib.sha256(raw).hexdigest())
        with self.assertRaisesRegex(capture.CaptureRefused, 'directory-page-size'):
            subject.directory_page_evidence(b'short')

    def environment(self, fixture):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(capture, '_Held', fixture.baseline_type()))
        stack.enter_context(patch.object(native, 'Win32', fixture.port_type()))
        stack.enter_context(patch.object(ctypes, 'set_last_error', lambda value: setattr(fixture, 'error', value)))
        stack.enter_context(patch.object(ctypes, 'get_last_error', lambda: fixture.error))
        return stack

    def test_junction_uses_only_qualified_metadata_handle(self):
        fixture = Fixture('directory')
        with self.environment(fixture):
            held = subject.open_source(Path('C:/owned/link'), 'junction', time.monotonic() + 30)
            self.assertEqual(held.evidence['sourceObservationMode'], 'metadata-only-junction')
            self.assertNotIn('accessTimeSuppression', held.evidence)
            self.assertEqual(fixture.ports, [])
            held.close()
            self.assertEqual(fixture.baseline_closed, 1)

    def test_actual_read_handle_gets_immediate_sentinel_and_separate_large_read_budget(self):
        fixture = Fixture(payload=b'x' * 257)
        with self.environment(fixture), patch.object(subject, 'CHUNK_BYTES', 4):
            held = subject.open_source(Path('C:/owned/payload'), 'file', time.monotonic() + 30)
            self.assertEqual(fixture.calls[1:3], [('open', 0x20181, 1, 0x02200000),
                ('suppress', 11, None, 0xffffffff, 0xffffffff, None)])
            self.assertEqual(fixture.baseline_closed, 1)
            self.assertEqual(b''.join(held.read_chunks(1024)), fixture.payload)
            self.assertEqual(len(held.evidence['ioEvents']), 66)
            self.assertEqual(len(held.port.events), 4)
            self.assertTrue(held.evidence['readResult']['complete'])
            held.streams(); result = held.capture()
            self.assertEqual(result['information'], fixture.row)
            self.assertNotIn('apiEvents', result['nativeObservations'])
            self.assertEqual(result['nativeObservations']['accessTimeSuppressionEvent']['api'], 'SetFileTime:access-suppression')
            held.close(); held.close()
            self.assertEqual(held.port.closes, 1)

    def test_suppression_failure_retains_primary_and_uncertain_close_once(self):
        fixture = Fixture(); fixture.suppress_ok = False; fixture.close_fails = True
        with self.environment(fixture):
            with self.assertRaises(capture.CaptureRefused) as caught:
                subject.open_source(Path('C:/owned/payload'), 'file', time.monotonic() + 30)
            value = caught.exception.observations
            self.assertEqual(value['original']['type'], 'OSError')
            self.assertFalse(value['accessTimeSuppression']['result'])
            self.assertTrue(value['unresolvedHandle'])
            self.assertEqual(fixture.ports[0].closes, 1)
            self.assertEqual(fixture.baseline_closed, 1)
            self.assertNotIn('ReadFile', fixture.calls)

    def test_directory_sweeps_restart_and_preserve_complete_pages_and_eof(self):
        fixture = Fixture('directory')
        with self.environment(fixture):
            held = subject.open_source(Path('C:/owned/dir'), 'directory', time.monotonic() + 30)
            for _ in range(2):
                self.assertEqual(held.list_names(max_entries=4, max_pages=2), ['child', 'résumé.txt'])
            self.assertEqual([x[1] for x in fixture.calls if isinstance(x, tuple) and x[0] == 'query'], [11, 10, 11, 10])
            self.assertTrue(all(x['complete'] for x in held.evidence['directorySweeps']))
            self.assertTrue(all(x['rawEncoding'] == 'zlib-base64' and x['rawBytes'] == subject.PAGE_BYTES
                                for x in held.evidence['ioEvents']))
            held.streams(); held.capture(); held.close()
            self.assertEqual(held.port.closes, 1)

    def test_general_parser_refuses_malformed_names_offsets_case_aliases_and_entry_bounds(self):
        good = directory_page(['a.txt', '日本語.txt'])
        self.assertEqual([r['name'] for r in subject.parse_directory_page(good, set(), 2)], ['a.txt', '日本語.txt'])
        bad_offset = bytearray(good); struct.pack_into('<I', bad_offset, 0, 105)
        bad_utf = bytearray(directory_page(['a'])); bad_utf[104:106] = b'\x00\xd8'
        for raw in (bytes(bad_offset), bytes(bad_utf), directory_page(['a.txt', 'A.TXT']), directory_page(['bad/name'])):
            with self.subTest(raw=raw[:8]):
                with self.assertRaises((capture.CaptureRefused, UnicodeDecodeError)):
                    subject.parse_directory_page(raw, set(), 5)
        with self.assertRaises(capture.CaptureRefused): subject.parse_directory_page(good, set(), 1)

    def test_full_metadata_and_original_handle_authority_remain_strict(self):
        fixture = Fixture()
        with self.environment(fixture):
            held = subject.open_source(Path('C:/owned/payload'), 'file', time.monotonic() + 30)
            list(held.read_chunks(1024)); held.streams()
            fixture.row['access100ns'] += 1
            with self.assertRaises(capture.CaptureRefused) as caught: held.capture()
            self.assertIn('apiEvents', caught.exception.observations)
            held.handle = 99
            with self.assertRaises(capture.CaptureRefused): held.close()
            self.assertIn(('close', 11), fixture.calls)
            self.assertNotIn(('close', 99), fixture.calls)
            self.assertEqual(held.port.closes, 1)

    def test_failed_or_abandoned_io_and_capacity_refuse_without_readmission(self):
        fixture = Fixture()
        with self.environment(fixture):
            held = subject.open_source(Path('C:/owned/payload'), 'file', time.monotonic() + 30)
            held._io_bytes = subject.MAX_IO_EVIDENCE
            with self.assertRaises(capture.CaptureRefused): list(held.read_chunks(1024))
            self.assertNotIn('ReadFile', fixture.calls)
            with self.assertRaises(capture.CaptureRefused): list(held.read_chunks(1024))
            with self.assertRaises(capture.CaptureRefused): held.capture()
            held.close()
        fixture = Fixture('directory'); fixture.query_fails = True
        with self.environment(fixture):
            held = subject.open_source(Path('C:/owned/dir'), 'directory', time.monotonic() + 30)
            with self.assertRaises(capture.CaptureRefused) as caught: held.list_names(max_entries=4, max_pages=2)
            event = caught.exception.observations['ioEvents'][0]
            self.assertEqual(event['lastError'], 5)
            self.assertEqual(event['rawEncoding'], 'zlib-base64')
            self.assertEqual(event['rawBytes'], subject.PAGE_BYTES)
            self.assertFalse(held.evidence['directorySweeps'][0]['complete'])
            held.close()


class AcquisitionTransitionTests(unittest.TestCase):
    """Only the new initial acquisition boundary; old suites remain separately closed."""
    def test_unchanged_and_current_forward_access_keep_full_evidence(self):
        before = info()
        security = base64.b64encode(SECURITY).decode('ascii')
        unchanged = subject.acquisition_transition(before, copy.deepcopy(before), security, security, 1000, 1100)
        self.assertFalse(unchanged['accessTimeChanged'])
        for current in (1000, 1050, 1100):
            with self.subTest(current=current):
                after = copy.deepcopy(before); after['access100ns'] = current
                value = subject.acquisition_transition(before, after, security, security, 1000, 1100)
                self.assertTrue(value['accessTimeChanged'])
                self.assertEqual(value['before'], {'informationRef': 'acquisitionBaseline.before',
                    'ownerGroupDaclRef': 'acquisitionBaseline.ownerGroupDaclBeforeBase64', 'access100ns': 200})
                self.assertEqual(value['after'], {'informationRef': 'openedInformation',
                    'ownerGroupDaclRef': 'suppressionSecurityBase64', 'access100ns': current})
                self.assertFalse(value['contentIoStarted'])
                self.assertEqual(before['access100ns'], 200)
                after['access100ns'] += 1
                self.assertEqual(value['after']['access100ns'], current)

    def test_backward_stale_future_nonaccess_security_and_bad_window_refuse(self):
        before = info(); security = base64.b64encode(SECURITY).decode('ascii')
        for current in (100, 999, 1101):
            with self.subTest(current=current):
                after = copy.deepcopy(before); after['access100ns'] = current
                with self.assertRaisesRegex(capture.CaptureRefused, 'acquisition-access-time-outside-window'):
                    subject.acquisition_transition(before, after, security, security, 1000, 1100)
        for field in ('fileIndex64', 'size', 'allocationBytes', 'creation100ns', 'write100ns', 'change100ns', 'attributes'):
            with self.subTest(field=field):
                after = copy.deepcopy(before); after['access100ns'] = 1050; after[field] += 1
                with self.assertRaisesRegex(capture.CaptureRefused, 'acquisition-changed-nonaccess-state'):
                    subject.acquisition_transition(before, after, security, security, 1000, 1100)
        with self.assertRaisesRegex(capture.CaptureRefused, 'acquisition-changed-nonaccess-state'):
            subject.acquisition_transition(before, before, security, 'changed-security', 1000, 1100)
        for start, end in ((1100, 1000), (-1, 1100), (True, 1100)):
            with self.subTest(window=(start, end)):
                with self.assertRaisesRegex(capture.CaptureRefused, 'acquisition-clock-window-invalid'):
                    subject.acquisition_transition(before, before, security, security, start, end)

    def test_settled_same_handle_baseline_precedes_io_and_later_change_still_refuses(self):
        class AgedFixture(Fixture):
            def port_type(self):
                fixture = self
                class Port(super().port_type()):
                    def open(self, *args):
                        handle = super().open(*args)
                        fixture.row['access100ns'] = 1050
                        return handle
                return Port
        fixture = AgedFixture()
        with NeutralIOTests().environment(fixture):
            held = subject.open_source(Path('C:/owned/aged-payload'), 'file', time.monotonic() + 30)
            self.assertNotIn('ReadFile', fixture.calls)
            self.assertEqual(held.evidence['acquisitionBaseline']['before']['access100ns'], 200)
            self.assertEqual(held.evidence['acquisitionTransition']['before']['access100ns'], 200)
            self.assertEqual(held.evidence['acquisitionBaseline']['ownerGroupDaclBeforeBase64'],
                             held.evidence['suppressionSecurityBase64'])
            self.assertEqual(held._baseline['information']['access100ns'], 1050)
            self.assertEqual(held._baseline['information'], held.evidence['openedInformation'])
            self.assertEqual(held.evidence['acquisitionWindow100ns'], {
                'started': 1000, 'ended': 1100})
            self.assertEqual([event['api'] for event in held.port.events],
                ['GetSystemTimeAsFileTime', 'CreateFileW', 'SetFileTime:access-suppression', 'GetSystemTimeAsFileTime'])
            for key, expected in (('beforeOpen', 1000), ('afterInformation', 1100)):
                clock = held.evidence['acquisitionClock'][key]
                self.assertEqual(clock['value100ns'], expected)
                self.assertIsNone(clock['apiEvent']['result'])
                self.assertEqual(clock['apiEvent']['raw']['bytes'], 8)
                self.assertEqual(struct.unpack('<Q', base64.b64decode(clock['apiEvent']['raw']['base64']))[0], expected)
            self.assertEqual(fixture.calls[1:3], [('open', 0x20181, 1, 0x02200000),
                ('suppress', 11, None, 0xffffffff, 0xffffffff, None)])
            list(held.read_chunks(1024)); held.streams(); result = held.capture()
            self.assertEqual(result['information'], fixture.row)
            fixture.row['access100ns'] += 1
            with self.assertRaises(capture.CaptureRefused):
                held.capture()
            with self.assertRaises(capture.CaptureRefused):
                held.close()
            self.assertEqual(fixture.ports[0].closes, 1)
            self.assertEqual(fixture.baseline_closed, 2)

    def test_system_filetime_clock_preserves_high_word_raw_evidence_and_rejects_zero(self):
        fixture = Fixture(); value = (31 << 32) + 197
        fixture.clock_values = [value, 0]
        port = fixture.port_type()()
        row = subject.acquisition_clock(port)
        self.assertEqual(row['value100ns'], value)
        self.assertEqual(struct.unpack('<II', base64.b64decode(row['apiEvent']['raw']['base64'])), (197, 31))
        self.assertIsNone(row['apiEvent']['result'])
        self.assertEqual(row['apiEvent']['arguments'], {'bytes': 8})
        with self.assertRaisesRegex(capture.CaptureRefused, 'acquisition-system-clock-invalid'):
            subject.acquisition_clock(port)
        self.assertEqual(port.events[-1]['raw']['base64'], base64.b64encode(bytes(8)).decode('ascii'))


if __name__ == '__main__':
    unittest.main()
