"""New capture seams only: owned files and fake native/Node ports, never Win32.

No old D2 suite, runtime, process signalling, gateway, database or provider runs.
The current-host runner admits this file separately before any actual capture.
"""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/update-runner'))
import local_windows_capture as subject


def stream_page(name='::$DATA', following=0, length=7):
    encoded = name.encode('utf-16-le')
    result = bytearray(subject.STREAM_BUFFER)
    struct.pack_into('<IIqq', result, 0, following, len(encoded), length, 4096)
    result[24:24 + len(encoded)] = encoded
    return bytes(result)


def fake_info(path, kind):
    s = path.lstat()
    birth = getattr(s, 'st_birthtime_ns', s.st_ctime_ns)
    return {'volumeSerial32': s.st_dev & 0xffffffff, 'fileIndex64': s.st_ino,
        'volumeSerial64': s.st_dev, 'fileId128Hex': s.st_ino.to_bytes(16, 'little').hex(),
        'attributes': 16 if kind == 'directory' else 32, 'reparseTag': 0, 'links': s.st_nlink,
        'directory': kind == 'directory', 'deletePending': False, 'size': s.st_size,
        'allocationBytes': s.st_size, 'creation100ns': birth // 100 + 116444736000000000,
        'access100ns': s.st_atime_ns // 100 + 116444736000000000,
        'write100ns': s.st_mtime_ns // 100 + 116444736000000000,
        'change100ns': s.st_ctime_ns // 100 + 116444736000000000}


class FakeHeld:
    instances = []
    close_failure = None
    def __init__(self, path, kind, deadline):
        self.path, self.kind, self.closed = path, kind, False
        self.port = types.SimpleNamespace(events=[])
        self.evidence = {'openedInformation': fake_info(path, kind)}
        self.closes = 0
        self.instances.append(self)

    def streams(self):
        self.evidence['streams'] = [] if self.kind == 'directory' else [
            {'name': '::$DATA', 'bytes': self.path.stat().st_size, 'allocationBytes': self.path.stat().st_size}]
        return self.evidence['streams']

    def capture(self):
        info = fake_info(self.path, self.kind)
        return {'information': info, 'security': {'ownerGroupDaclBase64': base64.b64encode(b'x' * 20).decode(),
            'saclNotRequested': True}, 'streams': self.evidence['streams'],
            'sameHandleStable': True, 'nativeObservations': self.evidence}

    def close(self):
        if not self.closed:
            self.closed = True
            self.closes += 1
            if self.close_failure == self.path:
                raise OSError('synthetic close failure')
            self.evidence['handleClosed'] = True


def fake_node(node, paths, deadline):
    result = {}
    for value in paths:
        path = Path(value)
        s = path.stat()
        info = fake_info(path, 'directory' if path.is_dir() else 'file')
        result[str(path)] = {'dev': str(info['volumeSerial32']), 'ino': str(s.st_ino),
            'mode': str(s.st_mode), 'size': str(s.st_size), 'mtimeNs': str((info['write100ns'] - 116444736000000000) * 100),
            'ctimeNs': str(s.st_ctime_ns), 'birthtimeNs': str((info['creation100ns'] - 116444736000000000) * 100)}
    return result


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nova-capture-unit-')
        self.base = Path(self.temp.name)
        self.root, self.vendor, self.destination = [self.base / name for name in ('source', 'vendor', 'snapshot')]
        self.root.mkdir()
        self.vendor.mkdir()
        (self.root / 'nested').mkdir()
        (self.root / 'nested' / 'owned.txt').write_bytes(b'owned fixture bytes')
        self.deadline = time.monotonic() + 30
        self.limits = {'node': str(self.base / 'unused-node'), 'maxEntries': 30, 'maxBytes': 1024 * 1024,
                      'maxFileBytes': 1024, 'maxDepth': 8, 'maxAliases': 3, 'maxReportBytes': 1024 * 1024}
        FakeHeld.instances, FakeHeld.close_failure = [], None
        self.patches = [patch.object(subject, '_windows_required'), patch.object(subject, '_Held', FakeHeld),
                        patch.object(subject, 'node_identities', side_effect=fake_node),
                        patch.object(subject.ctypes, 'WinDLL', side_effect=AssertionError('real Win32 forbidden'), create=True)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def capture(self):
        return subject.capture_closed_tree(self.root, self.destination, vendor_root=self.vendor,
                                           limits=self.limits, deadline=self.deadline)

    def test_owned_full_capture_and_content_drift_refusal(self):
        result = self.capture()
        self.assertTrue(result['complete'])
        self.assertTrue(result['allHandlesClosed'])
        self.assertEqual(set(result['entries']), {'.', 'nested', 'nested/owned.txt'})
        self.assertEqual(result['entries']['nested/owned.txt']['sha256'], hashlib.sha256(b'owned fixture bytes').hexdigest())
        self.assertTrue(all(p.closes == 1 for p in FakeHeld.instances))
        self.assertTrue(result['entries']['.']['security']['saclNotRequested'])
        self.assertTrue(subject.verify_capture_content(result, self.deadline))
        (self.destination / 'nested' / 'owned.txt').write_bytes(b'changed fixture')
        with self.assertRaisesRegex(subject.CaptureRefused, 'snapshot-content-changed|snapshot-size-changed'):
            subject.verify_capture_content(result, self.deadline)

    def test_roster_byte_deadline_and_fresh_destination_boundaries(self):
        for key, value, message in [('maxEntries', 1, 'tree-roster-budget'), ('maxBytes', 1, 'expanded-copy-budget'),
                                     ('maxFileBytes', 1, 'file-size-budget')]:
            with self.subTest(limit=key):
                limits = dict(self.limits, **{key: value})
                with self.assertRaises(subject.CaptureRefused) as raised:
                    subject.capture_closed_tree(self.root, self.destination, vendor_root=self.vendor,
                                                limits=limits, deadline=self.deadline)
                self.assertIn(message, raised.exception.observations['originalError']['message'])
                self.assertFalse(self.destination.exists())
                self.assertTrue(all(p.closes == 1 for p in FakeHeld.instances))
        with self.assertRaisesRegex(subject.CaptureRefused, 'deadline'):
            subject.capture_closed_tree(self.root, self.destination, vendor_root=self.vendor,
                                        limits=self.limits, deadline=time.monotonic() - 1)
        self.destination.mkdir()
        with self.assertRaises(subject.CaptureRefused) as raised:
            self.capture()
        self.assertIn('fresh-destination', raised.exception.observations['originalError']['message'])

    def test_node_drift_and_simultaneous_copy_close_failure_preserved(self):
        calls = []
        def drift(node, paths, deadline):
            value = fake_node(node, paths, deadline)
            calls.append(value)
            if len(calls) == 2:
                value[str(self.root / 'nested' / 'owned.txt')]['ino'] = '99999'
            return value
        with patch.object(subject, 'node_identities', side_effect=drift):
            with self.assertRaises(subject.CaptureRefused) as raised:
                self.capture()
        self.assertFalse(raised.exception.observations['complete'])
        self.assertIn('node-source-identity-changed', raised.exception.observations['originalError']['message'])
        self.destination = self.base / 'second-snapshot'
        FakeHeld.close_failure = self.root / 'nested' / 'owned.txt'
        primary = OSError('synthetic original read failure')
        with patch.object(subject, '_copy_default', side_effect=primary):
            with self.assertRaises(subject.CaptureRefused) as raised:
                self.capture()
        detail = raised.exception.observations['failureObservations']
        self.assertEqual(detail['original']['message'], str(primary))
        self.assertEqual(detail['closeError']['message'], 'synthetic close failure')
        self.assertFalse(raised.exception.observations['allHandlesClosed'])
        self.assertTrue(all(p.closes == 1 for p in FakeHeld.instances))

    def test_snapshot_foreign_member_and_path_escape_refused(self):
        result = self.capture()
        (self.destination / 'foreign.txt').write_bytes(b'foreign')
        with self.assertRaisesRegex(subject.CaptureRefused, 'roster'):
            subject.verify_capture_content(result, self.deadline)
        for key in ('../outside', '/absolute', 'C:/outside', 'a//b', 'a\\b'):
            with self.subTest(key=key), self.assertRaises(subject.CaptureRefused):
                subject._relative(key)

    def test_snapshot_holds_cover_alias_cache_and_final_hash_verification(self):
        original_verify = subject.verify_capture_content
        observed = []
        def verify(capture, deadline):
            owned = [port for port in FakeHeld.instances if port.path == self.destination
                     or self.destination in port.path.parents]
            self.assertEqual({port.path for port in owned},
                {self.destination, self.destination / 'nested', self.destination / 'nested' / 'owned.txt'})
            self.assertTrue(all(not port.closed for port in owned))
            observed.append(True)
            return original_verify(capture, deadline)
        with patch.object(subject, 'verify_capture_content', side_effect=verify):
            result = self.capture()
        self.assertEqual(observed, [True])
        self.assertTrue(result['allHandlesClosed'])
        self.assertTrue(all(port.closed and port.closes == 1 for port in FakeHeld.instances))
        self.destination = self.base / 'allocation-refusal'
        original_streams = FakeHeld.streams
        def mismatched_stream(port):
            rows = original_streams(port)
            if port.kind == 'file':
                rows[0]['allocationBytes'] += 1
            return rows
        with patch.object(FakeHeld, 'streams', mismatched_stream):
            with self.assertRaises(subject.CaptureRefused) as raised:
                self.capture()
        original = raised.exception.observations['failureObservations']['original']['message']
        self.assertIn('copied-default-stream-size-or-allocation-changed', original)
        self.assertFalse(raised.exception.observations['complete'])

    def test_junction_cycle_and_unknown_tag_refuse_before_snapshot(self):
        alias = self.root / 'alias'
        alias.mkdir()
        original_lstat = Path.lstat
        tag = subject.MOUNT_POINT
        def synthetic_link(path, *args, **kwargs):
            row = original_lstat(path, *args, **kwargs)
            if path != alias:
                return row
            values = {name: getattr(row, name) for name in dir(row) if name.startswith('st_')}
            values.update(st_file_attributes=0x410, st_reparse_tag=tag)
            return types.SimpleNamespace(**values)
        with patch.object(Path, 'lstat', synthetic_link), patch.object(subject.os, 'readlink', return_value=str(self.root)), \
                patch.object(subject, '_junction_target', return_value=(str(self.root), 'root')):
            with self.assertRaises(subject.CaptureRefused) as raised:
                self.capture()
            self.assertIn('junction-cycle-refused', raised.exception.observations['originalError']['message'])
            self.assertFalse(self.destination.exists())
            tag = 0xA000000C
            with self.assertRaises(subject.CaptureRefused) as raised:
                self.capture()
            self.assertIn('unknown-reparse-kind', raised.exception.observations['originalError']['message'])
            self.assertFalse(self.destination.exists())


class PureBoundaryTests(unittest.TestCase):
    def test_failed_constructor_close_prevents_aggregate_closure(self):
        def info(handle):
            raise OSError('synthetic original native information failure')
        def close(handle):
            raise OSError('synthetic constructor CloseHandle failure')
        port = types.SimpleNamespace(events=[], info=info, close=close,
            call=lambda name, *args: 3 if name == 'GetDriveTypeW' else 7,
            require=lambda ok, phase: subject.require(ok, phase),
            k=types.SimpleNamespace(GetDriveTypeW=None, CreateFileW=None))
        native = types.SimpleNamespace(Win32=lambda: port, canonical_path=lambda path: path)
        with patch.object(subject, '_primitive', return_value=native):
            with self.assertRaises(subject.CaptureRefused) as raised:
                subject._Held(Path('C:/owned-file'), 'file', time.monotonic() + 1)
        error = raised.exception
        self.assertTrue(error.unresolved_handle)
        self.assertIn('original native information failure', error.observations['original']['message'])
        self.assertIn('constructor CloseHandle failure', error.observations['closeError']['message'])
        with tempfile.TemporaryDirectory(prefix='nova-constructor-unit-') as directory:
            base = Path(directory)
            (base / 'source').mkdir()
            (base / 'vendor').mkdir()
            limits = dict(node='unused', maxEntries=10, maxBytes=1024, maxFileBytes=1024,
                          maxDepth=8, maxAliases=1, maxReportBytes=1024 * 1024)
            with patch.object(subject, '_windows_required'), patch.object(subject, '_Held', side_effect=error):
                with self.assertRaises(subject.CaptureRefused) as outer:
                    subject.capture_closed_tree(base / 'source', base / 'snapshot', vendor_root=base / 'vendor',
                                                limits=limits, deadline=time.monotonic() + 1)
            self.assertFalse(outer.exception.observations['allHandlesClosed'])
            self.assertFalse(outer.exception.observations['complete'])

    def test_directory_stream_data_refuses_with_complete_original_buffer(self):
        held = object.__new__(subject._Held)
        held.path, held.kind, held.deadline, held.handle = Path('C:/synthetic-directory'), 'directory', time.monotonic() + 1, 7
        held.evidence = {}
        raw = stream_page(length=7)
        calls = []
        def call(name, function, arguments, description):
            calls.append(name)
            subject.ctypes.memmove(arguments[2], raw, len(raw))
            return 1
        held.port = types.SimpleNamespace(last_error=0, call=call,
            require=lambda ok, phase: subject.require(ok, phase),
            k=types.SimpleNamespace(GetFileInformationByHandleEx=None))
        with self.assertRaises(subject.CaptureRefused) as raised:
            held.streams()
        self.assertIn('directory-data-stream-refused', raised.exception.observations['original']['message'])
        self.assertEqual(base64.b64decode(raised.exception.observations['rawStreamBufferBase64']), raw)
        self.assertEqual(len(calls), 1)

    def test_absolute_api_and_node_environment_whitelist(self):
        with self.assertRaisesRegex(subject.CaptureRefused, 'absolute-path-required'):
            subject._absolute('cwd-relative')
        with tempfile.TemporaryDirectory(prefix='nova-node-observer-unit-') as directory:
            node = Path(directory) / 'inert-node'
            node.write_bytes(b'not executable; subprocess is mocked')
            env = {'SYSTEMROOT': 'C:\\Windows', 'WINDIR': 'C:\\Windows', 'TEMP': directory,
                   'TMP': directory, 'NODE_OPTIONS': 'unsafe', 'OPENAI_API_KEY': 'synthetic'}
            completed = types.SimpleNamespace(returncode=0, stdout=b'[]', stderr=b'')
            with patch.dict(subject.os.environ, env, clear=True), patch.object(subject.subprocess, 'run', return_value=completed) as run:
                self.assertEqual(subject._node(node, subject.NODE_RETIRE_SCRIPT, [], time.monotonic() + 1), [])
            self.assertEqual(run.call_args.kwargs['env'], {k: env[k] for k in ('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP')})

    def test_stream_complete_default_and_unknown_malformed_refusals(self):
        rows = subject.parse_streams(stream_page())
        self.assertEqual([(r['name'], r['bytes']) for r in rows], [('::$DATA', 7)])
        for raw in (stream_page(':Zone.Identifier:$DATA'), stream_page(following=4),
                    stream_page(length=-1), stream_page()[:-1]):
            with self.subTest(raw=raw[:24]), self.assertRaises(subject.CaptureRefused):
                subject.parse_streams(raw)
        malformed = bytearray(stream_page())
        struct.pack_into('<I', malformed, 4, 4098)
        with self.assertRaises(subject.CaptureRefused):
            subject.parse_streams(bytes(malformed))

    def test_junction_only_declared_roots_and_absolute_plain_targets(self):
        root, vendor = r'C:\owned\workspace', r'C:\vendor\openclaw'
        self.assertEqual(subject._junction_target(r'\\?\C:\owned\workspace\state', root, vendor),
                         (r'C:\owned\workspace\state', 'root'))
        self.assertEqual(subject._junction_target(r'C:\vendor\openclaw\dist', root, vendor)[1], 'vendor')
        for raw in (r'C:\owned\workspace-other', r'C:\elsewhere', r'..\relative',
                    r'\\server\share\folder', r'C:\owned\workspace\..\escape'):
            with self.subTest(raw=raw), self.assertRaises(subject.CaptureRefused):
                subject._junction_target(raw, root, vendor)

    def test_decimal_node_identity_is_actual_and_order_bound(self):
        path = str(Path.cwd() / 'owned-not-read')
        identity = dict(dev='1', ino='2', mode=str(stat.S_IFREG | 0o600), size='3',
                        mtimeNs='4', ctimeNs='5', birthtimeNs='6')
        good = [{'path': path, 'identity': identity}]
        with patch.object(subject, '_node', return_value=good):
            self.assertEqual(subject.node_identities('unused', [path], time.monotonic() + 1), {path: identity})
        for key, invalid in [('ino', 2), ('ino', '2.0'), ('dev', '-1'), ('mode', str(stat.S_IFLNK)), ('size', '03')]:
            with self.subTest(key=key, invalid=invalid):
                rows = copy.deepcopy(good)
                rows[0]['identity'][key] = invalid
                with patch.object(subject, '_node', return_value=rows), self.assertRaises(subject.CaptureRefused):
                    subject.node_identities('unused', [path], time.monotonic() + 1)

    def test_retirement_requires_only_exact_esrch_never_denied_alive_unknown(self):
        deadline = time.monotonic() + 1
        with patch.object(subject, '_node', return_value=[{'pid': 123, 'retired': True, 'code': 'ESRCH'}]):
            self.assertTrue(subject.assert_processes_retired('unused', [123], deadline)['allRetired'])
        for row in ({'pid': 123, 'retired': False, 'code': 'ALIVE'},
                    {'pid': 123, 'retired': False, 'code': 'EPERM'},
                    {'pid': 123, 'retired': True, 'code': 'UNKNOWN'},
                    {'pid': 124, 'retired': True, 'code': 'ESRCH'}):
            with self.subTest(row=row), patch.object(subject, '_node', return_value=[row]), self.assertRaises(subject.CaptureRefused):
                subject.assert_processes_retired('unused', [123], deadline)
        with self.assertRaises(subject.CaptureRefused):
            subject.assert_processes_retired('unused', [True], deadline)


if __name__ == '__main__':
    unittest.main()
