"""Real SQLite regressions for closed recovery readers on synthetic Linux trees.

No service, native process, provider or production workspace is used. The WAL
families are copied while fixture writers are open, then all comparisons run
against two independent, closed trees.
"""
import contextlib
import hashlib
import importlib.util
import os
import pathlib
import shutil
import sqlite3
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    'closed_reader_fixture_helpers', ROOT / 'tests' / 'update-runner.test.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
recovery = fixtures.recovery


def tree_identity(root):
    """Include bytes and retained metadata; access time changes on ordinary reads."""
    result = {}
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        metadata = (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
                    info.st_gid, info.st_nlink, info.st_size,
                    info.st_mtime_ns, info.st_ctime_ns, info.st_blocks)
        attributes = tuple((name, os.getxattr(path, name))
                           for name in sorted(os.listxattr(path)))
        content = hashlib.sha256(path.read_bytes()).hexdigest() if stat.S_ISREG(info.st_mode) else None
        result[path.relative_to(root).as_posix()] = (metadata, attributes, content)
    return result


@unittest.skipUnless(sys.platform == 'linux', 'Requires real Linux SQLite/SHM metadata behavior')
class ClosedReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-closed-readers-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.scratch = self.root / 'verification-scratch'
        self.scratch.mkdir(mode=0o700)

    def frozen_pair(self):
        writer_root = self.root / 'fixture-writers'
        embedded = fixtures.fixture_embedded_databases(writer_root)
        fixtures.fixture_database(writer_root / 'dormant' / 'workspace.sqlite', 53)
        self.snapshot, self.restored = self.root / 'snapshot', self.root / 'restored'
        self.native = pathlib.Path('openclaw-runtime/state/agents/main/agent/openclaw-agent.sqlite')
        self.embedded = embedded['state_5.sqlite']
        writes = [
            (pathlib.Path('workspace.sqlite'),
             "insert into entities values('wal-draft',2,x'77616c')"),
            (pathlib.Path('dormant/workspace.sqlite'),
             "insert into entities values('dormant-wal-draft',2,x'77616c')"),
            (self.native,
             "insert into session_nodes values('wal-message','{\"text\":\"retained only in WAL\"}')"),
            (self.embedded,
             "insert into threads(id,title,first_user_message) values('wal-thread','WAL title','Retained WAL writing')"),
        ]
        self.wal_families = [relative for relative, _ in writes]
        with contextlib.ExitStack() as stack:
            for relative, statement in writes:
                writer = stack.enter_context(contextlib.closing(sqlite3.connect(writer_root / relative)))
                self.assertEqual(writer.execute('pragma journal_mode=WAL').fetchone()[0], 'wal')
                writer.execute('pragma wal_autocheckpoint=0')
                writer.execute(statement)
                writer.commit()
            shutil.copytree(writer_root, self.snapshot)
            shutil.copytree(writer_root, self.restored)
        for root in (self.snapshot, self.restored):
            for path in root.rglob('*'):
                if path.is_file():
                    # A previous mtime makes SQLite's SHM bookkeeping visible
                    # without sleeps or assumptions about clock granularity.
                    os.utime(path, ns=(1_000_000_000_000_000_000,) * 2)
            for relative in self.wal_families:
                self.assertGreater(pathlib.Path(str(root / relative) + '-wal').stat().st_size, 0)
        return self.snapshot, self.restored

    def test_direct_read_only_sqlite_changes_closed_shared_memory_metadata(self):
        _, restored = self.frozen_pair()
        database = restored / 'workspace.sqlite'
        shared_memory = pathlib.Path(str(database) + '-shm')
        before = shared_memory.stat().st_mtime_ns
        with contextlib.closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as reader:
            reader.execute('pragma query_only=ON')
            self.assertEqual(reader.execute("select payload from entities where id='wal-draft'").fetchone(), (b'wal',))
        self.assertNotEqual(shared_memory.stat().st_mtime_ns, before)

    def test_saved_and_native_comparison_keeps_both_closed_trees_exact(self):
        snapshot, restored = self.frozen_pair()
        expected = {root: tree_identity(root) for root in (snapshot, restored)}
        # Prove the regression cannot pass by silently ignoring committed WAL.
        main_only = self.root / 'database-without-wal.sqlite'
        shutil.copyfile(snapshot / 'workspace.sqlite', main_only)
        with contextlib.closing(sqlite3.connect(main_only)) as reader:
            self.assertIsNone(reader.execute("select payload from entities where id='wal-draft'").fetchone())
        with recovery.verification_scratch(self.scratch):
            reports = recovery.saved_state(snapshot, restored, restored=True)
            self.assertEqual(sorted(item['beforeSchema'] for item in reports), [53, 55])
            recovery.native_saved_state(snapshot, restored)
            for root in (snapshot, restored):
                for relative, statement, value in (
                    (pathlib.Path('workspace.sqlite'), "select payload from entities where id='wal-draft'", (b'wal',)),
                    (self.native, "select entry_json from session_nodes where id='wal-message'", ('{"text":"retained only in WAL"}',)),
                    (self.embedded, "select first_user_message from threads where id='wal-thread'", ('Retained WAL writing',)),
                ):
                    with contextlib.closing(recovery.database(root / relative, True)) as reader:
                        self.assertEqual(reader.execute(statement).fetchone(), value)
        for root, before in expected.items():
            with self.subTest(tree=root.name):
                self.assertEqual(tree_identity(root), before)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_closed_native_preflight_does_not_touch_either_retained_tree(self):
        snapshot, restored = self.frozen_pair()
        for root in (snapshot, restored):
            expected = tree_identity(root)
            with self.subTest(tree=root.name), recovery.verification_scratch(self.scratch):
                selected, epoch, paths = recovery.native_preflight(root, closed=True)
                self.assertEqual(selected, pathlib.Path('.'))
                self.assertEqual(epoch, '96b84a4e-172a-4481-8038-74663d28a6fc')
                self.assertIn(self.native, paths)
            self.assertEqual(tree_identity(root), expected)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_explicit_scratch_uses_qualified_filesystem_instead_of_full_default_temp(self):
        snapshot, _ = self.frozen_pair()
        database = snapshot / 'workspace.sqlite'
        expected = tree_identity(snapshot)
        checked = []

        def disk_usage(path):
            resolved = pathlib.Path(path).resolve()
            checked.append(resolved)
            return types.SimpleNamespace(free=10 ** 12 if resolved.is_relative_to(self.scratch) else 0)

        with patch.object(recovery.shutil, 'disk_usage', side_effect=disk_usage):
            with recovery.verification_scratch(self.scratch):
                with contextlib.closing(recovery.database(database, True)) as reader:
                    self.assertTrue(reader.database_path.is_relative_to(self.scratch))
                    self.assertEqual(reader.execute("select payload from entities where id='wal-draft'").fetchone(), (b'wal',))
                    copy_directory = reader.database_path.parent
            self.assertTrue(checked)
            self.assertTrue(all(path.is_relative_to(self.scratch) for path in checked))
        self.assertFalse(copy_directory.exists())
        self.assertEqual(list(self.scratch.iterdir()), [])
        self.assertEqual(tree_identity(snapshot), expected)

    def test_insufficient_scratch_retains_reserve_and_cleans_failed_private_copy(self):
        snapshot, _ = self.frozen_pair()
        expected = tree_identity(snapshot)
        with patch.object(recovery.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=0)):
            with self.assertRaises(RuntimeError):
                with recovery.verification_scratch(self.scratch):
                    with contextlib.closing(recovery.database(snapshot / 'workspace.sqlite', True)):
                        self.fail('An exhausted scratch filesystem must refuse before opening SQLite.')
        self.assertEqual(list(self.scratch.iterdir()), [])
        self.assertEqual(tree_identity(snapshot), expected)


if __name__ == '__main__':
    unittest.main()
