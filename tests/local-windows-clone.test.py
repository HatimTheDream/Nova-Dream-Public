"""New clone boundaries with inert ports and owned ordinary text files only."""
import base64
import copy
import hashlib
import importlib.util
import pathlib
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
import local_windows_clone as clone

# Reuse only the synthetic capture builder; loading definitions runs no suite.
spec = importlib.util.spec_from_file_location('_synthetic_semantic_fixture',
    pathlib.Path(__file__).with_name('local-native-retained-semantic.test.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)

LIMITS = {'maxEntries': 50, 'maxBytes': 1024**2, 'maxFileBytes': 1024**2,
          'maxAliases': 4, 'maxReportBytes': 16 * 1024**2}


class InertAncestor:
    def __init__(self, path, kind, deadline):
        self.path, self.port = path, SimpleNamespace(events=[])
        row = path.lstat()
        self.evidence = {'openedInformation': {'volumeSerial64': row.st_dev,
            'fileId128Hex': row.st_ino.to_bytes(16, 'little').hex(), 'directory': True}}

    def close(self):
        self.evidence['handleClosed'] = True


class InertTarget:
    instances, events, expected, base = [], [], {}, None
    fail_security, fail_close, root_delta, bulk_bytes = False, False, None, 0

    def __init__(self, path, kind, deadline, *, root_finalization=False):
        self.path, self.kind, self.closed = path, kind, False
        self.port, self.evidence = SimpleNamespace(events=[]), {'path': str(path)}
        if self.bulk_bytes:
            self.evidence['syntheticBoundedObservation'] = 'x' * self.bulk_bytes
        key = '.' if root_finalization else path.relative_to(self.base).as_posix()
        self.expected_row = copy.deepcopy(self.expected[key])
        self.info = copy.deepcopy(self.expected_row['information'])
        if root_finalization:
            self.info.update(self.root_delta or {'change100ns': self.info['change100ns'] + 123})
        else:
            self.info['fileIndex64'] += 10000
            self.info['fileId128Hex'] = format(self.info['fileIndex64'], '032x')
        self.instances.append(self)
        self.events.append(('open', str(path), root_finalization))

    def set_security(self, row):
        self.events.append(('security', str(self.path)))
        self.security = copy.deepcopy(row['security'])

    def set_junction(self, payload, raw_target):
        assert ('security', str(self.path)) in self.events
        self.events.append(('junction', str(self.path), raw_target))
        self.kind = 'junction'

    def set_metadata(self, expected):
        self.events.append(('metadata', str(self.path)))
        identity = {k: self.info[k] for k in clone.IDENTITY_FIELDS}
        self.info = {**copy.deepcopy(expected), **identity}

    def observe(self):
        security = copy.deepcopy(getattr(self, 'security', self.expected_row['security']))
        if self.fail_security:
            security['ownerGroupDaclBase64'] = base64.b64encode(b'x' * 20).decode('ascii')
        return {'information': copy.deepcopy(self.info), 'security': security,
                'streams': copy.deepcopy(self.expected_row['streams'])}

    def close(self):
        if not self.closed:
            self.closed = True
            self.events.append(('close', str(self.path)))
            if self.fail_close:
                raise OSError('synthetic close refusal')
            self.evidence['handleClosed'] = True


class CloneTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='nova-clone-inert-')
        self.addCleanup(self.directory.cleanup)
        self.base = pathlib.Path(self.directory.name).resolve()
        self.source = self.base / 'original'; self.source.mkdir()
        self.image = self.base / 'image'; self.image.mkdir()
        (self.image / 'data').mkdir()
        (self.image / 'data' / 'saved.txt').write_bytes(b'synthetic complete saved bytes\x00\xff')
        self.destination = self.base / 'working'
        self.capture = fixtures.synthetic_capture(self.image, self.source)
        InertTarget.instances, InertTarget.events = [], []
        InertTarget.fail_security, InertTarget.fail_close, InertTarget.root_delta, InertTarget.bulk_bytes = False, False, None, 0
        InertTarget.expected, InertTarget.base = self.capture['entries'], self.destination

    def test_physical_plan_omits_expanded_alias_and_refuses_unsupported_authority(self):
        # A foreign vendor alias is comparison content, not a physical copy.
        (self.image / 'vendor-link').mkdir()
        (self.image / 'vendor-link' / 'foreign.txt').write_bytes(b'expanded vendor content')
        value = fixtures.synthetic_capture(self.image, self.source)
        row = copy.deepcopy(value['entries']['vendor-link'])
        row.update(path='vendor-link', rawTarget='\\\\?\\C:\\synthetic-vendor',
                   canonicalTarget='C:\\synthetic-vendor', targetRole='vendor',
                   physicalPath=str(self.source / 'vendor-link'))
        row['information'].update(attributes=0x410, reparseTag=clone.MOUNT_POINT)
        for part in ('openedInformation', 'before', 'after'):
            row['nativeObservations'][part] = copy.deepcopy(row['information'])
        value['junctions'] = [row]
        plan = clone.physical_plan(value, self.destination, limits=LIMITS)
        self.assertEqual({r['key'] for r in plan['rows']}, {'.', 'data', 'data/saved.txt'})
        self.assertEqual([r['key'] for r in plan['junctions']], ['vendor-link'])
        self.assertEqual(plan['bytes'], len((self.image / 'data' / 'saved.txt').read_bytes()))
        for mode in ('attribute', 'physical-path', 'parent', 'budget'):
            with self.subTest(mode=mode):
                bad, limits = copy.deepcopy(self.capture), dict(LIMITS)
                if mode == 'attribute':
                    bad['entries']['data/saved.txt']['information']['attributes'] |= 0x200
                elif mode == 'physical-path':
                    bad['entries']['data/saved.txt']['physicalPath'] = str(self.base / 'unrelated')
                elif mode == 'parent':
                    del bad['entries']['data']
                else:
                    limits['maxReportBytes'] = 1
                with self.assertRaises((RuntimeError, ValueError)):
                    clone.physical_plan(bad, self.destination, limits=limits)

    def test_owned_copy_reads_image_bytes_and_finishes_metadata_before_handle_release(self):
        original = (self.image / 'data' / 'saved.txt').read_bytes()
        with patch.object(clone, 'Win32Target', InertTarget), patch.object(clone.capture, '_Held', InertAncestor):
            result = clone.prepare_working_copy(self.capture, self.destination, node=None,
                limits=LIMITS, deadline=time.monotonic() + 20)
        self.assertTrue(result['complete'] and result['allHandlesClosed'])
        self.assertFalse(result['sourceChildrenWritten'] or result['renamesPerformed'])
        self.assertEqual((self.destination / 'data' / 'saved.txt').read_bytes(), original)
        self.assertEqual(list(self.source.iterdir()), [])
        self.assertEqual((self.image / 'data' / 'saved.txt').read_bytes(), original)
        self.assertEqual(result['entries']['data/saved.txt']['sha256'], hashlib.sha256(original).hexdigest())
        events = InertTarget.events
        first_close = next(i for i, event in enumerate(events) if event[0] == 'close')
        self.assertTrue(all(i < first_close for i, event in enumerate(events) if event[0] == 'metadata'))
        self.assertEqual([p for op, p, *rest in events if op == 'metadata'][-1], str(self.destination))
        self.assertTrue(all(p.closed for p in InertTarget.instances))

    def test_copy_refusal_preserves_primary_and_close_failure_and_partial_generation(self):
        InertTarget.fail_security = InertTarget.fail_close = True
        with patch.object(clone, 'Win32Target', InertTarget), patch.object(clone.capture, '_Held', InertAncestor):
            with self.assertRaises(clone.CloneRefused) as found:
                clone.prepare_working_copy(self.capture, self.destination, node=None,
                    limits=LIMITS, deadline=time.monotonic() + 20)
        evidence = found.exception.observations
        self.assertEqual(evidence['originalError']['message'], 'copy-owner-group-dacl-mismatch')
        self.assertTrue(evidence['closeErrors'])
        self.assertFalse(evidence['complete'] or evidence['allHandlesClosed'])
        self.assertTrue(self.destination.is_dir())
        self.assertEqual(list(self.source.iterdir()), [])
        self.assertTrue(all(p.closed for p in InertTarget.instances))

    def test_unreturned_handle_and_actual_evidence_limit_never_admit_partial_copy(self):
        failure = clone.CloneRefused('synthetic constructor and close refusal', {'unresolvedHandle': True})
        with patch.object(clone, 'Win32Target', side_effect=failure), patch.object(clone.capture, '_Held', InertAncestor):
            with self.assertRaises(clone.CloneRefused) as found:
                clone.prepare_working_copy(self.capture, self.destination, node=None,
                    limits=LIMITS, deadline=time.monotonic() + 20)
        self.assertFalse(found.exception.observations['allHandlesClosed'])
        self.assertTrue(found.exception.unresolved_handle)
        with patch.object(clone, 'Win32Target', side_effect=failure):
            with self.assertRaises(clone.CloneRefused) as root_failure:
                clone.finalize_renamed_root(self.capture, self.source, deadline=time.monotonic() + 20)
        self.assertTrue(root_failure.exception.unresolved_handle)
        # A distinct owned destination tests exact incremental accounting. The
        # partial clone remains preserved and can never be activated as complete.
        second = self.base / 'bounded-working'
        InertTarget.base, InertTarget.bulk_bytes = second, 1024**2
        bounds = {**LIMITS, 'maxReportBytes': 4 * 1024**2}
        with patch.object(clone, 'Win32Target', InertTarget), patch.object(clone.capture, '_Held', InertAncestor):
            with self.assertRaises(clone.CloneRefused) as bounded:
                clone.prepare_working_copy(self.capture, second, node=None,
                    limits=bounds, deadline=time.monotonic() + 20)
        self.assertFalse(bounded.exception.observations['complete'])
        self.assertEqual(bounded.exception.observations['originalError']['message'], 'clone-evidence-reserve-unavailable')
        self.assertTrue(bounded.exception.observations['allHandlesClosed'])
        self.assertFalse((second / 'data' / 'saved.txt').exists())
        self.assertEqual(list(self.source.iterdir()), [])

    def test_root_finalization_requires_exact_identity_security_and_only_rename_change(self):
        InertTarget.base = self.source
        with patch.object(clone, 'Win32Target', InertTarget):
            result = clone.finalize_renamed_root(self.capture, self.source, deadline=time.monotonic() + 20)
        self.assertEqual(result['after']['information'], self.capture['entries']['.']['information'])
        self.assertFalse(result['childrenAccessed'])
        self.assertTrue(result['allHandlesClosed'])
        for mode in ('identity', 'write-time', 'security'):
            with self.subTest(mode=mode):
                InertTarget.events, InertTarget.instances = [], []
                InertTarget.fail_security = mode == 'security'
                InertTarget.root_delta = ({'fileIndex64': 999} if mode == 'identity'
                    else {'write100ns': self.capture['entries']['.']['information']['write100ns'] + 1}
                    if mode == 'write-time' else None)
                with patch.object(clone, 'Win32Target', InertTarget):
                    with self.assertRaisesRegex(clone.CloneRefused, 'root-finalization-refused'):
                        clone.finalize_renamed_root(self.capture, self.source, deadline=time.monotonic() + 20)
                self.assertFalse(any(event[0] == 'metadata' for event in InertTarget.events))
                self.assertTrue(all(p.closed for p in InertTarget.instances))
        # These actual method guards must refuse before any native call.
        port = object.__new__(clone.Win32Target)
        port.root_finalization, port.kind = True, 'directory'
        with self.assertRaises(clone.CloneRefused):
            port.set_security(self.capture['entries']['.'])
        with self.assertRaises(clone.CloneRefused):
            port.set_junction(b'', '\\\\?\\C:\\synthetic')


if __name__ == '__main__':
    unittest.main()
