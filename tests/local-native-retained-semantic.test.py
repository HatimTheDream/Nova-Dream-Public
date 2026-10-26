"""Pure local-Windows comparator regressions; every capture and row is synthetic.

These tests exercise copied SQLite only. They do not capture Windows metadata,
run a native process, derive a managed configuration, or qualify real startup.
"""
import base64
import contextlib
import copy
import hashlib
import pathlib
import shutil
import sqlite3
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
import recovery

EPOCH = '11111111-1111-4111-8111-111111111111'
SHARED = pathlib.Path('openclaw-runtime/state/state/openclaw.sqlite')
CONFIG = pathlib.Path('openclaw-runtime/openclaw.json')
START = 1700000000000
FILETIME = 116444736000000000 + START * 10000
SECURITY = base64.b64encode(bytes(20)).decode('ascii')


def create_workspace(root, schema):
    """Same small identity/SQLite layout used by recovery-native98 fixtures."""
    root.mkdir()
    (root / 'edition3.identity').write_bytes(b'private.novadream.edition3.preview\n')
    with contextlib.closing(sqlite3.connect(root / 'workspace.sqlite')) as db:
        db.executescript('pragma user_version=' + str(schema) + ';create table meta(key text,value text);')
        db.execute('insert into meta values(?,?)', ('epoch', EPOCH))
        db.commit()
    native = root / 'openclaw-runtime'
    native.mkdir()
    (native / 'edition3-runtime.identity').write_bytes(b'edition3-owned-gateway\n')
    (root / SHARED).parent.mkdir(parents=True)
    with contextlib.closing(sqlite3.connect(root / SHARED)) as db:
        db.executescript('pragma user_version=19;'
                         'create table projects(id text primary key, payload text, opaque_retained blob);')
        db.execute('insert into projects values(?,?,?)', ('saved', '{"nested":[true,null,"é"]}', b'full-row-content'))
        db.commit()


def synthetic_capture(destination, source, after=False):
    """Build declared inert observations, never infer source IDs from copy IDs."""
    entries = {}
    paths = [destination, *sorted(destination.rglob('*'))]
    for index, path in enumerate(paths, 1):
        key = path.relative_to(destination).as_posix()
        directory = path.is_dir()
        raw = b'' if directory else path.read_bytes()
        size = len(raw)
        information = {
            'volumeSerial32': 19, 'fileIndex64': index, 'volumeSerial64': 19,
            'fileId128Hex': format(index, '032x'), 'attributes': 0x10 if directory else 0x20,
            'reparseTag': 0, 'links': 1, 'directory': directory, 'deletePending': False,
            'size': size, 'allocationBytes': ((size + 4095) // 4096) * 4096,
            'creation100ns': FILETIME, 'access100ns': FILETIME,
            'write100ns': FILETIME, 'change100ns': FILETIME,
        }
        identity = {'dev': '19', 'ino': str(index),
                    'mode': str((stat.S_IFDIR if directory else stat.S_IFREG) | 0o600),
                    'size': str(size), 'mtimeNs': str(START * 1000000),
                    'ctimeNs': str(START * 1000000), 'birthtimeNs': str(START * 1000000)}
        row = {
            'kind': 'directory' if directory else 'file', 'physicalPath': str(source / key),
            'information': information,
            'security': {'ownerGroupDaclBase64': SECURITY, 'saclNotRequested': True},
            'streams': [] if directory else [{'name': '::$DATA', 'bytes': size,
                                              'allocationBytes': information['allocationBytes'], 'rawBase64': ''}],
            'sameHandleStable': True,
            'nativeObservations': {'openedInformation': copy.deepcopy(information),
                                   'before': copy.deepcopy(information), 'after': copy.deepcopy(information),
                                   'ownerGroupDaclBeforeBase64': SECURITY,
                                   'ownerGroupDaclAfterBase64': SECURITY, 'handleClosed': True},
            'nodeIdentity': identity, 'nodeIdentityBefore': copy.deepcopy(identity),
        }
        if not directory:
            row.update(bytes=size, sha256=hashlib.sha256(raw).hexdigest(), copyObservations={})
        entries[key] = row
    return {
        'format': 1, 'kind': 'local-windows-closed-tree', 'sourceRoot': str(source),
        'canonicalSourceRoot': str(source), 'destinationRoot': str(destination),
        'startedEpochMs': START + (5 if after else 0), 'endedEpochMs': START + (6 if after else 1),
        'entries': entries, 'junctions': [], 'complete': True, 'allHandlesClosed': True,
        'primitiveSha256': 'c7022c40ebdb88f3ee55b768e87a15b22fb724a16bfb07bfcc095e393d0c876e',
        'saclNotRequested': True,
        'expandedBytes': sum(row.get('bytes', 0) for row in entries.values()),
        'physicalFileReads': sum(row['kind'] == 'file' for row in entries.values()),
    }


@contextlib.contextmanager
def fixture(schema=60):
    with tempfile.TemporaryDirectory(prefix='nova-semantic-') as directory:
        base = pathlib.Path(directory).resolve()
        source = base / 'original'; source.mkdir()
        before = base / 'before'; create_workspace(before, schema)
        after = base / 'after'; shutil.copytree(before, after)
        yield source, before, after


def compare(before, after, source, *, captures=None, derivation=None):
    old, new = captures or (synthetic_capture(before, source), synthetic_capture(after, source, True))
    return recovery.local_windows_native_saved_state(
        old, new, node=None, app_releases=None, startup_window=(START + 2, START + 4),
        catalog_runtime_root=None,
        configuration_derivation=({'kind': 'no-managed-native-config'} if derivation is None else derivation))


class LocalNativeSemanticTests(unittest.TestCase):
    def setUp(self):
        # Any new process-dependent branch must refuse this pure fixture, never run it.
        for method in ('run', 'Popen'):
            guard = patch.object(recovery.subprocess, method,
                                 side_effect=AssertionError('pure semantic tests must not start a process'))
            guard.start()
            self.addCleanup(guard.stop)

    def test_schema60_same_state_and_complete_retained_row(self):
        with fixture() as (source, before, after):
            compare(before, after, source)
            with contextlib.closing(sqlite3.connect(after / SHARED)) as db:
                db.execute('update projects set opaque_retained=?', (b'changed-row-content',))
                db.commit()
            with self.assertRaisesRegex(RuntimeError, 'Retained native work, history, configuration or permissions changed'):
                compare(before, after, source)

    def test_missing_family_member_and_unknown_table_refuse(self):
        for mode in ('missing-database', 'missing-capture-member', 'unknown-table'):
            with self.subTest(mode=mode), fixture() as (source, before, after):
                captures = None
                if mode == 'missing-database':
                    (after / SHARED).unlink()
                elif mode == 'missing-capture-member':
                    # Inert companion bytes must still be in the complete capture.
                    # Refusal precedes any SQLite interpretation of this member.
                    companion = pathlib.Path(str(SHARED) + '-wal')
                    for root in (before, after):
                        (root / companion).write_bytes(b'')
                    captures = (synthetic_capture(before, source), synthetic_capture(after, source, True))
                    del captures[1]['entries'][companion.as_posix()]
                else:
                    for root in (before, after):
                        with contextlib.closing(sqlite3.connect(root / SHARED)) as db:
                            db.execute('create table unknown_durable_table(payload text)')
                            db.commit()
                with self.assertRaises(RuntimeError):
                    compare(before, after, source, captures=captures)

    def test_original_source_and_typed_node_identity_are_bound(self):
        for mode in ('source-root', 'canonical-source', 'node-inode', 'node-number-type'):
            with self.subTest(mode=mode), fixture() as (source, before, after):
                old, new = synthetic_capture(before, source), synthetic_capture(after, source, True)
                if mode == 'source-root':
                    new['sourceRoot'] = str(source.parent / 'different-original')
                elif mode == 'canonical-source':
                    new['canonicalSourceRoot'] = str(source.parent / 'different-original')
                elif mode == 'node-inode':
                    for field in ('nodeIdentity', 'nodeIdentityBefore'):
                        new['entries'][SHARED.as_posix()][field]['ino'] = '999'
                else:
                    for field in ('nodeIdentity', 'nodeIdentityBefore'):
                        new['entries'][SHARED.as_posix()][field]['size'] = 4096
                with self.assertRaises(RuntimeError):
                    compare(before, after, source, captures=(old, new))

    def test_no_config_declaration_cannot_authorize_config_or_an_expected_projection(self):
        with fixture() as (source, before, after):
            compare(before, after, source)
            for declaration in ({'kind': 'arbitrary-expected-config', 'expected': {}},
                                {'kind': 'no-managed-native-config', 'expected': {}}):
                with self.subTest(declaration=declaration), self.assertRaises(RuntimeError):
                    compare(before, after, source, derivation=declaration)
            (after / CONFIG).write_text('{"gateway":{"port":12345}}', encoding='utf-8')
            with self.assertRaises(RuntimeError):
                compare(before, after, source)

    def test_hosted_schema55_default_is_unchanged_and_local_scope_does_not_leak(self):
        with fixture(55) as (source, before, after):
            recovery.native_saved_state(before, after, from_version='2026.9.8', node=None)
            with self.assertRaises(RuntimeError):
                compare(before, after, source)
        with fixture(60) as (source, before, after):
            compare(before, after, source)
            with self.assertRaisesRegex(RuntimeError, 'selected workspace schema changed'):
                recovery.native_saved_state(before, after, from_version='2026.9.8', node=None)


if __name__ == '__main__':
    unittest.main()
