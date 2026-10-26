"""New physical-graph seams only; every source observation below is synthetic.

No Win32 call, junction creation, Node subprocess, runtime or protected read.
The execution owner reviews and runs this file separately; old suites stay closed.
"""
import base64
import copy
import hashlib
from pathlib import Path
import stat
import struct
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/update-runner'))
import local_windows_capture as subject
from local_retained_context import LocalRetainedContext
import local_windows_clone as clone

EPOCH = 116444736000000000
SECURITY = base64.b64encode(b'synthetic-descriptor').decode('ascii')
ROOT = Path('C:/synthetic-graph-source')
VENDOR = Path('C:/synthetic-graph-vendor')
STORAGE = Path('C:/synthetic-graph-image')


def information(number, kind, size=0):
    return {'volumeSerial32': 23, 'volumeSerial64': 23,
            'fileIndex64': number, 'fileId128Hex': number.to_bytes(16, 'little').hex(),
            'attributes': 0x410 if kind == 'junction' else 16 if kind == 'directory' else 32,
            'reparseTag': subject.MOUNT_POINT if kind == 'junction' else 0,
            'links': 1, 'directory': kind != 'file', 'deletePending': False,
            'size': size, 'allocationBytes': size, 'creation100ns': EPOCH + 10000,
            'access100ns': EPOCH + 20000, 'write100ns': EPOCH + 30000,
            'change100ns': EPOCH + 40000}


def node_identity(info):
    return {'dev': str(info['volumeSerial32']), 'ino': str(info['fileIndex64']),
            'mode': str((stat.S_IFDIR if info['directory'] else stat.S_IFREG) | 0o600),
            'size': str(info['size']), 'mtimeNs': str((info['write100ns'] - EPOCH) * 100),
            'ctimeNs': str((info['change100ns'] - EPOCH) * 100),
            'birthtimeNs': str((info['creation100ns'] - EPOCH) * 100)}


def source_row(role, key, kind, number, *, members=None, payload=b''):
    info = information(number, kind, len(payload))
    row = {'kind': kind, 'physicalPath': str((ROOT if role == 'root' else VENDOR) / key),
           'imageRelativePath': (Path(role) / key).as_posix(),
           'information': info, 'security': {'ownerGroupDaclBase64': SECURITY, 'saclNotRequested': True},
           'sameHandleStable': True, 'streams': [],
           'nativeObservations': {'before': copy.deepcopy(info), 'after': copy.deepcopy(info),
               'openedInformation': copy.deepcopy(info),
               'ownerGroupDaclBeforeBase64': SECURITY, 'ownerGroupDaclAfterBase64': SECURITY,
               'handleClosed': True,
               'accessTimeSuppression': {'kind': 'per-handle-last-access-suppression', 'access': 0x20181,
                   'creation': None, 'write': None, 'accessLow': 0xffffffff, 'accessHigh': 0xffffffff,
                   'immediateAfterOpen': True, 'result': True, 'lastError': 0, 'sameHandle': True}}}
    if kind == 'junction':
        row['nativeObservations'].pop('accessTimeSuppression')
        row['nativeObservations']['sourceObservationMode'] = 'metadata-only-junction'
    if kind != 'junction':
        row['nodeIdentity'] = node_identity(info)
        row['nodeIdentityBefore'] = copy.deepcopy(row['nodeIdentity'])
    if kind == 'directory':
        row['members'] = sorted(members or [])
    elif kind == 'file':
        name = '::$DATA'.encode('utf-16-le')
        raw = struct.pack('<IIqq', 0, len(name), len(payload), len(payload)) + name
        row['bytes'], row['sha256'] = len(payload), hashlib.sha256(payload).hexdigest()
        row['streams'] = [{'name': '::$DATA', 'bytes': len(payload), 'allocationBytes': len(payload),
                           'rawBase64': base64.b64encode(raw).decode('ascii')}]
    return row


def recount(value):
    value['counts'] = dict(subject.graph_counts(value), reportBytes=0)
    value['counts']['reportBytes'] = subject.graph_report_bytes(value)
    return value


def graph():
    root = {
        '.': source_row('root', '.', 'directory', 1, members=['again', 'captured', 'local', 'vendor-copy']),
        'local': source_row('root', 'local', 'directory', 2, members=['saved.sqlite']),
        'local/saved.sqlite': source_row('root', 'local/saved.sqlite', 'file', 3, payload=b'local retained db'),
        'again': source_row('root', 'again', 'junction', 4),
        'captured': source_row('root', 'captured', 'junction', 5),
        'vendor-copy': source_row('root', 'vendor-copy', 'junction', 6),
    }
    vendor = {
        '.': source_row('vendor', '.', 'directory', 7, members=['pkg']),
        'pkg': source_row('vendor', 'pkg', 'directory', 8, members=['fixture.sqlite', 'payload.js']),
        'pkg/fixture.sqlite': source_row('vendor', 'pkg/fixture.sqlite', 'file', 9, payload=b'vendor fixture'),
        'pkg/payload.js': source_row('vendor', 'pkg/payload.js', 'file', 10, payload=b'export default 1;'),
    }
    value = {'format': 2, 'kind': 'local-windows-closed-tree',
             'sourceRoot': str(ROOT), 'canonicalSourceRoot': str(ROOT),
             'vendorRoot': str(VENDOR), 'canonicalVendorRoot': str(VENDOR),
             'canonicalRootObservations': {'root': {'before': str(ROOT), 'after': str(ROOT)},
                                           'vendor': {'before': str(VENDOR), 'after': str(VENDOR)}},
             'storageRoot': str(STORAGE), 'destinationRoot': str(STORAGE / 'root'),
             'vendorDestinationRoot': str(STORAGE / 'vendor'),
             'startedEpochMs': 1000, 'endedEpochMs': 1100,
             'physicalEntries': {'root': root, 'vendor': vendor}, 'junctions': [], 'counts': {},
             'limits': {'node': 'C:/synthetic-unused-node.exe', 'maxEntries': 10, 'maxBytes': 1024,
                        'maxFileBytes': 256, 'maxDepth': 8, 'maxAliases': 3, 'maxReportBytes': 1024 * 1024},
             'primitiveSha256': subject.PRIMITIVE_SHA256, 'saclNotRequested': True,
             'complete': True, 'allHandlesClosed': True}
    for key, role, target in [('again', 'root', 'local'), ('captured', 'vendor', 'pkg'), ('vendor-copy', 'vendor', 'pkg')]:
        source = (ROOT if role == 'root' else VENDOR) / target
        image = STORAGE / role / target
        identity = value['physicalEntries'][role][target]['nodeIdentity']
        value['junctions'].append({'sourceRole': 'root', 'path': key, 'rawTarget': '\\\\?\\' + str(source),
            'canonicalTarget': str(source), 'targetRole': role, 'targetPath': target,
            'targetNodeIdentityBefore': copy.deepcopy(identity), 'targetNodeIdentityAfter': copy.deepcopy(identity),
            'imagePath': str(STORAGE / 'root' / key), 'imageRawTarget': '\\\\?\\' + str(image),
            'imageCanonicalTarget': str(image), 'imageInformation': information(100 + len(value['junctions']), 'junction'),
            'imageHandleClosed': True})
    return recount(value)


class PhysicalGraphTests(unittest.TestCase):
    def test_windows_directory_size_projection_preserves_file_and_native_bounds(self):
        directory = information(200, 'directory', 4096)
        node = node_identity(directory)
        node['size'] = '0'
        subject._node_join(node, directory)
        self.assertEqual((directory['size'], directory['allocationBytes']), (4096, 4096))
        with self.assertRaisesRegex(subject.CaptureRefused, 'node-native-identity-mismatch'):
            subject._node_join(dict(node, size='4096'), directory)
        file_info = information(201, 'file', 19)
        subject._node_join(node_identity(file_info), file_info)
        with self.assertRaisesRegex(subject.CaptureRefused, 'node-native-identity-mismatch'):
            subject._node_join(dict(node_identity(file_info), size='0'), file_info)

    def setUp(self):
        self.guard = patch.object(subject.ctypes, 'WinDLL', side_effect=AssertionError('native API forbidden'), create=True)
        self.guard.start()

    def tearDown(self):
        self.guard.stop()

    def reject(self, value, pattern):
        # Recompute the report size so refusal must concern the mutated authority,
        # not a conveniently stale serialized-size field.
        value['counts']['reportBytes'] = subject.graph_report_bytes(value)
        with self.assertRaisesRegex((subject.CaptureRefused, RuntimeError), pattern):
            subject.validate_physical_graph(value)

    def test_repeated_aliases_preserve_logical_closure_with_physical_budget(self):
        value = graph()
        self.assertTrue(subject.validate_physical_graph(value))
        self.assertEqual(value['counts']['physicalEntries'], 10)
        self.assertEqual(value['counts']['physicalFiles'], 3)
        self.assertEqual(value['counts']['physicalAliases'], 3)
        self.assertEqual(value['counts']['logicalEntries'], 11)
        self.assertEqual(value['counts']['logicalFiles'], 6)
        rows = list(subject.graph_logical_rows(value, deadline=time.monotonic() + 5))
        self.assertEqual(len(rows), 11)
        sqlite = {name: (role, key) for name, role, key, row in rows if name.endswith('.sqlite')}
        self.assertEqual(sqlite, {'local/saved.sqlite': ('root', 'local/saved.sqlite'),
            'again/saved.sqlite': ('root', 'local/saved.sqlite'),
            'captured/fixture.sqlite': ('vendor', 'pkg/fixture.sqlite'),
            'vendor-copy/fixture.sqlite': ('vendor', 'pkg/fixture.sqlite')})
        self.assertIs(subject.graph_resolve(value, 'root', 'captured/payload.js')[2],
                      subject.graph_resolve(value, 'root', 'vendor-copy/payload.js')[2])
        self.assertEqual(value['counts']['physicalBytes'], sum(r['bytes'] for role in value['physicalEntries'].values()
                                                               for r in role.values() if r['kind'] == 'file'))
        self.assertGreater(value['counts']['logicalBytes'], value['counts']['physicalBytes'])
        # Physical Node observations remain physical; alias descendants resolve
        # to them and are never manufactured as separate direct observations.
        self.assertNotIn('captured/payload.js', value['physicalEntries']['root'])

    def test_missing_members_edges_and_cycles_refuse(self):
        value = graph()
        del value['physicalEntries']['vendor']['pkg/payload.js']
        self.reject(value, 'physical-member-missing')
        value = graph()
        value['junctions'].pop()
        self.reject(value, 'physical-junction-edge-missing')
        value = graph()
        value['junctions'].append(copy.deepcopy(value['junctions'][0]))
        value['limits']['maxAliases'] = 4
        self.reject(value, 'duplicate-physical-alias')
        value = graph()
        edge = value['junctions'][0]
        edge.update(targetPath='.', canonicalTarget=str(ROOT), rawTarget='\\\\?\\' + str(ROOT),
                    imageCanonicalTarget=str(STORAGE / 'root'), imageRawTarget='\\\\?\\' + str(STORAGE / 'root'),
                    targetNodeIdentityBefore=copy.deepcopy(value['physicalEntries']['root']['.']['nodeIdentity']),
                    targetNodeIdentityAfter=copy.deepcopy(value['physicalEntries']['root']['.']['nodeIdentity']))
        self.reject(value, 'physical-alias-graph-cycle')

    def test_source_and_image_alias_authority_cannot_escape_or_drift(self):
        for field, replacement, reason in [
            ('rawTarget', 'C:\\foreign\\payload', 'junction-escape-refused'),
            ('imageRawTarget', '\\\\?\\C:\\foreign\\image', 'image-alias-escaped-capture'),
            ('imageCanonicalTarget', str(VENDOR / 'pkg'), 'image-alias-escaped-capture'),
            ('imagePath', str(STORAGE / 'outside'), 'image-alias-escaped-capture'),
            ('imageHandleClosed', False, 'image-alias-handle-not-closed')]:
            with self.subTest(field=field):
                value = graph()
                value['junctions'][1][field] = replacement
                self.reject(value, reason)
        value = graph()
        value['junctions'][1]['targetNodeIdentityAfter']['ino'] = '999'
        self.reject(value, 'alias-root-target-identity-changed')

    def test_full_physical_evidence_type_stream_and_closure_refusals(self):
        for field in ('access100ns', 'attributes', 'fileIndex64'):
            with self.subTest(native=field):
                value = graph()
                value['physicalEntries']['root']['local/saved.sqlite']['nativeObservations']['after'][field] += 1
                self.reject(value, 'physical-observation-not-stable')
        for change, reason in [
            ('security', 'physical-observation-not-stable'), ('node', 'node-native-identity-mismatch'),
            ('type', 'physical-node-regular-type'), ('stream', 'stream'), ('closed', 'physical-observation-not-stable'),
            ('suppression', 'same-source-handle-suppression-evidence-required'),
            ('opened', 'source-observer-changed-full-metadata')]:
            with self.subTest(change=change):
                value = graph()
                row = value['physicalEntries']['root']['local/saved.sqlite']
                if change == 'security':
                    row['nativeObservations']['ownerGroupDaclAfterBase64'] = base64.b64encode(b'other-descriptor-xxx').decode('ascii')
                elif change == 'node':
                    row['nodeIdentity']['ino'] = row['nodeIdentityBefore']['ino'] = '999'
                elif change == 'type':
                    row['nodeIdentity']['mode'] = row['nodeIdentityBefore']['mode'] = str(stat.S_IFIFO | 0o600)
                elif change == 'stream':
                    row['streams'][0]['name'] = ':foreign:$DATA'
                elif change == 'suppression':
                    row['nativeObservations']['accessTimeSuppression']['sameHandle'] = False
                elif change == 'opened':
                    row['nativeObservations']['openedInformation']['access100ns'] += 1
                else:
                    row['nativeObservations']['handleClosed'] = False
                self.reject(value, reason)

    def test_closed_schema_and_independent_capacity_accounting(self):
        for field, maximum, reason in [('maxEntries', 9, 'physical-closure-budget'),
                                       ('maxBytes', 1, 'physical-closure-budget'),
                                       ('maxAliases', 2, 'physical-alias-budget'),
                                       ('maxReportBytes', 1, 'physical-evidence-budget')]:
            with self.subTest(limit=field):
                value = graph()
                value['limits'][field] = maximum
                self.reject(value, reason)
        value = graph()
        value['unexpectedAuthority'] = True
        self.reject(value, 'closed-physical-graph-required')
        value = graph()
        value['junctions'][0]['uncheckedTarget'] = str(ROOT)
        self.reject(value, 'closed-alias-edge-required')
        value = graph()
        value['counts']['logicalFiles'] -= 1
        self.reject(value, 'physical-logical-count-mismatch')
        value = graph()
        value['canonicalRootObservations']['vendor']['after'] = str(ROOT)
        self.reject(value, 'canonical-physical-root-changed')
        value = graph()
        value['endedEpochMs'] = value['startedEpochMs'] - 1
        self.reject(value, 'physical-capture-clock-shape')
        value = graph()
        value['counts']['reportBytes'] += 1
        with self.assertRaisesRegex(subject.CaptureRefused, 'physical-evidence-budget'):
            subject.validate_physical_graph(value)

    def test_logical_consumer_paths_and_clone_plan_keep_distinct_roles(self):
        value = graph()
        subject.validate_physical_graph(value)
        # Exercise the actual pure accessors, not constructor admission or a
        # made-up before/after startup result. No snapshot filesystem exists.
        context = LocalRetainedContext.__new__(LocalRetainedContext)
        context.captures = (value, value)
        context.images = (STORAGE / 'root', STORAGE / 'root')
        context.source_root = ROOT
        context.deadline = time.monotonic() + 5
        context.node, context.app_releases, context.catalog_runtime_root = None, None, None
        self.assertEqual({p.relative_to(ROOT).as_posix() for p in context.glob(ROOT, '*.sqlite*')},
                         {'local/saved.sqlite', 'again/saved.sqlite',
                          'captured/fixture.sqlite', 'vendor-copy/fixture.sqlite'})
        self.assertEqual(context.image_path(ROOT / 'captured/payload.js'), STORAGE / 'vendor/pkg/payload.js')
        self.assertEqual(context.image_path(STORAGE / 'root/vendor-copy/payload.js'), STORAGE / 'vendor/pkg/payload.js')
        self.assertEqual(context.node_identity(ROOT / 'captured/payload.js'),
                         value['physicalEntries']['vendor']['pkg/payload.js']['nodeIdentity'])
        self.assertEqual(context.image_path(ROOT / 'missing.txt'), STORAGE / 'root/missing.txt')
        with self.assertRaisesRegex(RuntimeError, 'identity is absent'):
            context.entry(ROOT / 'missing.txt')
        limits = {k: v for k, v in value['limits'].items() if k not in ('node', 'maxDepth')}
        limits['maxReportBytes'] = 4 * 1024 * 1024
        plan = clone.physical_plan(value, ROOT.with_name('synthetic-graph-working'), limits=limits)
        self.assertEqual({r['key'] for r in plan['rows']}, {'.', 'local', 'local/saved.sqlite'})
        self.assertEqual({r['key'] for r in plan['junctions']}, {'again', 'captured', 'vendor-copy'})
        self.assertEqual(plan['bytes'], value['physicalEntries']['root']['local/saved.sqlite']['bytes'])
        self.assertEqual({r['expected']['rawTarget'] for r in plan['junctions']},
                         {e['rawTarget'] for e in value['junctions']})
        self.assertTrue(all('vendor/' not in r['key'] for r in plan['rows']))


if __name__ == '__main__':
    unittest.main()
