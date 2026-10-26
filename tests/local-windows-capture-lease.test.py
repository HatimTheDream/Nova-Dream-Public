"""Focused synthetic Windows process-lease classifier cases; no native calls."""
import copy
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/update-runner'))
from local_retained_context import LocalRetainedContext
import recovery

EPOCH = 116444736000000000
PREFIX = 'openclaw-runtime/state/tmp/plugin-captures'
NAMES = ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
PRODUCERS = {
    'dist/sqlite-staging-token-CcxeaYVw.mjs': (4495, '640abcf7ec6e84134f752e94c9c49b8d4d1eea55d0416b4f0102e722ff89702f'),
    'dist/plugin-source-capture-directory-CsjPVlzr.mjs': (20448, 'bb59fd7c7b721a67fce0201e8f6bd250a66c84bc055d06d0ce645ecf18b25f79'),
    'dist/plugin-source-capture-path-L0n-8p-6.mjs': (1011, '2b5c87c781d8299882aa5ca90d66f8f20eda194a84cd3b73224f2fdd8163d7cf'),
}


def row(kind, number, size=0, created=10):
    info = {'volumeSerial32': 1, 'volumeSerial64': 1, 'fileIndex64': number,
            'fileId128Hex': number.to_bytes(16, 'little').hex(), 'attributes': 16 if kind == 'directory' else 32,
            'reparseTag': 0, 'links': 1, 'deletePending': False, 'directory': kind == 'directory',
            'size': size, 'allocationBytes': size, 'creation100ns': EPOCH + created * 10000}
    security = {'ownerGroupDaclBase64': 'synthetic-directory' if kind == 'directory' else 'synthetic-file',
                'saclNotRequested': True}
    return {'kind': kind, 'sameHandleStable': True, 'information': info, 'security': security,
            'streams': [] if kind == 'directory' else [{'name': '::$DATA', 'bytes': size}],
            'nativeObservations': {'before': copy.deepcopy(info), 'after': copy.deepcopy(info),
                                  'handleClosed': True, 'ownerGroupDaclBeforeBase64': security['ownerGroupDaclBase64'],
                                  'ownerGroupDaclAfterBase64': security['ownerGroupDaclBase64']},
            'members': [], 'bytes': size, 'sha256': hashlib.sha256(b'').hexdigest()}


class WindowsCaptureLeaseTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='nova-lease-pure-')
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        context = LocalRetainedContext.__new__(LocalRetainedContext)
        # This tests the new classifier only. Complete graph/content validation
        # belongs to the constructor and is independently preserved unchanged.
        context.source_root = base / 'source'
        context.catalog_runtime_root = base / 'vendor'
        context.startup_window = (1000, 2000)
        context.images = tuple(base / str(i) / 'root' for i in range(2))
        host = {'kind': 'local-native-retained-host-result', 'operationId': '33333333-3333-4333-8333-333333333333',
                'workspaceRoot': str(context.source_root), 'startedEpochMs': 1000, 'endedEpochMs': 2000,
                'ready': True, 'passed': True, 'closed': True, 'originalOwnerRetained': False,
                'observer': {'pid': 100}, 'observedNativePids': [101],
                'nativeIdentity': {'pid': 101, 'version': '2026.9.8', 'startedAt': 1100,
                                   'epoch': '44444444-4444-4444-8444-444444444444',
                                   'generation': '55555555-5555-4555-8555-555555555555'}}
        context.derivation = {'kind': 'maintained-local-configuration', 'hostResult': host}
        captures = []
        for index, image in enumerate(context.images):
            roots = {}
            for number, name in enumerate(('.', 'openclaw-runtime', 'openclaw-runtime/state',
                                          'openclaw-runtime/state/tmp', PREFIX), 1):
                roots[name] = row('directory', number)
            roots[PREFIX]['members'] = [NAMES[index]]
            directory = PREFIX + '/' + NAMES[index]
            roots[directory] = row('directory', 10 + index * 10, created=10 if index == 0 else 1200)
            roots[directory]['members'] = ['owner.sqlite', 'owner.sqlite-journal']
            payload = bytearray(512)
            payload[12:16] = (123 + index).to_bytes(4, 'big')
            payload[20:24] = (512).to_bytes(4, 'big')
            payload[24:28] = (4096).to_bytes(4, 'big')
            for suffix, content, number in (('', b'', 11), ('-journal', bytes(payload), 12)):
                key = directory + '/owner.sqlite' + suffix
                roots[key] = row('file', number + index * 10, len(content), 10 if index == 0 else 1200)
                roots[key]['sha256'] = hashlib.sha256(content).hexdigest()
                path = image / key
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            vendor = {}
            for number, (name, (size, digest)) in enumerate(PRODUCERS.items(), 100):
                vendor[name] = row('file', number, size)
                vendor[name]['sha256'] = digest
            captures.append({'format': 2, 'complete': True, 'allHandlesClosed': True,
                             'destinationRoot': str(image), 'vendorRoot': str(context.catalog_runtime_root),
                             'physicalEntries': {'root': roots, 'vendor': vendor}})
        context.captures = tuple(captures)
        return context

    def classify(self, context):
        token = recovery._LOCAL_WINDOWS.set(context)
        try:
            return [recovery.native_capture_owner_paths(image, Path('.'), '2026.9.8') for image in context.images]
        finally:
            recovery._LOCAL_WINDOWS.reset(token)

    def test_closed_captured_rotation_classifies_only_direct_owner(self):
        context = self.fixture()
        for value in context.captures:
            value['physicalEntries']['root'][PREFIX + '/nested/fixture/owner.sqlite'] = row('file', 99)
        self.assertEqual(self.classify(context), [{Path(PREFIX) / name / 'owner.sqlite'} for name in NAMES])

    def test_journal_payload_nonempty_owner_and_other_sidecars_refused(self):
        for case in ('payload', 'owner', 'wal', 'shm', 'unknown-family'):
            with self.subTest(case=case):
                context = self.fixture()
                rows = context.captures[1]['physicalEntries']['root']
                directory = PREFIX + '/' + NAMES[1]
                owner = directory + '/owner.sqlite'
                if case == 'payload':
                    path = context.images[1] / (owner + '-journal')
                    payload = bytearray(path.read_bytes()); payload[100] = 1; path.write_bytes(payload)
                    rows[owner + '-journal']['sha256'] = hashlib.sha256(payload).hexdigest()
                elif case == 'owner':
                    rows[owner]['sha256'] = 'a' * 64
                else:
                    rows[directory]['members'].append('owner.sqlite-' + case)
                with self.assertRaises(RuntimeError):
                    self.classify(context)

    def test_host_source_and_handle_closure_refused(self):
        for case in ('closed', 'owner', 'pid', 'window', 'workspace', 'producer', 'capture', 'handle'):
            with self.subTest(case=case):
                context = self.fixture(); host = context.derivation['hostResult']
                owner = context.captures[1]['physicalEntries']['root'][PREFIX + '/' + NAMES[1] + '/owner.sqlite']
                if case == 'closed': host['closed'] = False
                elif case == 'owner': host['originalOwnerRetained'] = True
                elif case == 'pid': host['observedNativePids'] = [999]
                elif case == 'window': host['endedEpochMs'] = 2001
                elif case == 'workspace': host['workspaceRoot'] += '-other'
                elif case == 'producer': context.captures[1]['physicalEntries']['vendor'][next(iter(PRODUCERS))]['sha256'] = 'a' * 64
                elif case == 'capture': context.captures[0]['allHandlesClosed'] = False
                else: owner['nativeObservations']['handleClosed'] = False
                with self.assertRaises(RuntimeError): self.classify(context)

    def test_native_identity_security_reparse_and_generation_window_refused(self):
        for case in ('links', 'reparse', 'identity', 'security', 'created', 'boundary', 'ancestry'):
            with self.subTest(case=case):
                context = self.fixture(); rows = context.captures[1]['physicalEntries']['root']
                owner = rows[PREFIX + '/' + NAMES[1] + '/owner.sqlite']
                if case == 'links': owner['information']['links'] = 2
                elif case == 'reparse': owner['information']['reparseTag'] = 1
                elif case == 'identity':
                    prior = context.captures[0]['physicalEntries']['root'][PREFIX + '/' + NAMES[0] + '/owner.sqlite']
                    for name in ('fileIndex64', 'fileId128Hex'): owner['information'][name] = prior['information'][name]
                elif case == 'security': owner['security']['ownerGroupDaclBase64'] = 'different'
                elif case == 'created': owner['information']['creation100ns'] = EPOCH + 900 * 10000
                elif case == 'boundary': owner['information']['creation100ns'] = EPOCH + 2000 * 10000 + 1
                else: rows[PREFIX]['information']['fileIndex64'] += 100
                # Preserve same-handle equality so the specific changed native
                # invariant is examined independently of the capture validator.
                for value in rows.values():
                    value['nativeObservations']['before'] = copy.deepcopy(value['information'])
                    value['nativeObservations']['after'] = copy.deepcopy(value['information'])
                with self.assertRaises(RuntimeError): self.classify(context)

    def test_unqualified_version_path_and_generation_are_not_exempt(self):
        context = self.fixture()
        self.assertEqual(context.native_capture_owner_paths(context.images[0], Path('.'), '2026.9.6'), set())
        self.assertEqual(context.native_capture_owner_paths(context.images[0], Path('other'), '2026.9.8'), set())
        context.captures[1]['physicalEntries']['root'][PREFIX]['members'] = []
        with self.assertRaises(RuntimeError): self.classify(context)


if __name__ == '__main__':
    unittest.main()
