"""Closed installer admission through the real snapshot orchestration.

Portable inventory/copy/fsync boundaries use disposable ordinary directories;
Linux recovery suites separately verify production metadata and rsync behavior.
No service, sockets, native runtime or live workspace is used.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
if sys.platform != 'linux':
    sys.modules.setdefault('fcntl', types.SimpleNamespace())
spec = importlib.util.spec_from_file_location('snapshot_admission_driver', ROOT / 'deploy/update-runner/install.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
import recovery


def exclusive_json(path, value):
    with path.open('x', encoding='utf8') as output:
        json.dump(value, output, sort_keys=True)


class SnapshotAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-snapshot-admission-', dir=os.environ.get('QA_PROTECTED_PARENT'))
        self.root = pathlib.Path(self.temporary.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.temporary.cleanup)
        self.addCleanup(self.stack.close)
        instance = self.instance = driver.Driver(self.root/'request.json')
        instance.output = self.root/'receipts'; instance.output.mkdir()
        instance.recovery_root = self.root/'recovery'; instance.recovery_root.mkdir()
        instance.recovery = instance.recovery_root/'new'
        instance.data = self.root/'live'; instance.data.mkdir()
        (instance.data/'record').write_bytes(b'preserved saved work')
        instance.baseline = instance.recovery_root/'old'; instance.baseline.mkdir()
        shutil.copytree(instance.data, instance.baseline/'workspace')
        config = self.root/'protected.conf'; config.write_bytes(b'private-config')
        instance.config_files = [config]
        instance.migration_storage_required = 16384
        self.events = []
        instance.require_stopped = lambda: self.events.append(('stopped', None))
        self.free = 10**12
        for module in (driver, recovery):
            self.stack.enter_context(patch.object(module, 'write_json', exclusive_json))
        self.stack.enter_context(patch.object(driver, 'sync_dir', lambda path: None))
        self.stack.enter_context(patch.object(recovery, 'flush_tree', lambda *args: None))
        self.stack.enter_context(patch.object(recovery, 'allocation_unit', lambda root: 4096))
        self.stack.enter_context(patch.object(recovery, 'inventory', self.inventory))
        self.stack.enter_context(patch.object(recovery, 'run_copy', self.copy))
        self.stack.enter_context(patch.object(recovery.shutil, 'disk_usage', lambda root: types.SimpleNamespace(free=self.free)))

    def inventory(self, root, *, allocation=None):
        self.events.append(('inventory', root))
        entries, inodes = {}, {}
        for path in [root, *sorted(root.rglob('*'))]:
            name = path.relative_to(root).as_posix()
            info = path.stat()
            if path.is_dir():
                entries[name] = {'kind':'directory'}
            else:
                entries[name] = {'kind':'file', 'size':info.st_size,
                                 'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
                inodes[name] = {'device':info.st_dev, 'inode':info.st_ino, 'allocated':4096, 'sparse':False}
        if allocation is not None:
            allocation.update(device=root.stat().st_dev, unitBytes=4096, directoryCopyBytes=8192,
                              symlinkCopyBytes=0, directoryObservedBytes=4096, symlinkObservedBytes=0)
        return entries, inodes

    def copy(self, arguments, log_path, volume, minimum_free):
        self.events.append(('copy', None))
        source, target = map(pathlib.Path, arguments[-2:])
        self.assertTrue((self.instance.output/'closed-capacity.json').exists())
        self.assertTrue(self.instance.recovery.exists())
        shutil.copytree(source, target, dirs_exist_ok=True)

    def test_single_fresh_admission_pair_retains_all_postcopy_rechecks(self):
        self.stack.enter_context(patch.object(driver, 'inventory', side_effect=AssertionError('duplicate caller inventory')))
        self.instance.snapshot_recovery()
        copy_index = self.events.index(('copy', None))
        initial = [path for kind, path in self.events[:copy_index] if kind == 'inventory']
        self.assertEqual(initial, [self.instance.data, self.instance.baseline/'workspace'])
        following = [path for kind, path in self.events[copy_index:] if kind == 'inventory']
        self.assertEqual(following, [self.instance.recovery/'workspace', self.instance.data, self.instance.baseline/'workspace'])
        receipt = json.loads((self.instance.output/'closed-capacity.json').read_text())
        self.assertEqual(receipt['nativeMigrationBytes'], 16384)
        self.assertGreaterEqual(receipt['protectedCopyBytes'], 4096)
        expected = sum(receipt[name] for name in ('candidateBytes', 'snapshotCopyBytes', 'independentRestoreBytes',
            'metadataOverheadBytes', 'reserveBytes', 'allowanceBytes', 'nativeMigrationBytes'))
        self.assertEqual(receipt['requiredFreeBytes'], expected)
        self.assertNotEqual((self.instance.data/'record').stat().st_ino,
                            (self.instance.recovery/'workspace/record').stat().st_ino)
        self.assertEqual((self.instance.data/'record').read_bytes(), b'preserved saved work')

    def test_migration_refusal_rechecks_original_without_creating_recovery_or_receipt(self):
        self.instance.migration_storage_required = self.free
        with self.assertRaises(recovery.InsufficientStorage):
            self.instance.snapshot_recovery()
        self.assertFalse(self.instance.recovery.exists())
        self.assertFalse((self.instance.output/'closed-capacity.json').exists())
        self.assertNotIn(('copy', None), self.events)
        inventories = [path for kind, path in self.events if kind == 'inventory']
        self.assertEqual(inventories, [self.instance.data, self.instance.baseline/'workspace', self.instance.data])

    def test_companion_estimate_refuses_before_snapshot_creation(self):
        self.instance.managed_companion_capacity = driver.managed_companion_capacity(
            {'archiveSha256': driver.MANAGED_COMPANION_98['runtimeArchiveSha256']}, '2026.9.8')
        self.free = self.instance.managed_companion_capacity['managedCompanionBytes']
        with self.assertRaises(recovery.InsufficientStorage):
            self.instance.snapshot_recovery()
        self.assertFalse(self.instance.recovery.exists())
        self.assertFalse((self.instance.output/'closed-capacity.json').exists())
        self.assertFalse(any(kind == 'copy' for kind, _ in self.events))

    def test_companion_estimate_is_named_and_preserves_existing_components(self):
        profile = driver.managed_companion_capacity(
            {'archiveSha256': driver.MANAGED_COMPANION_98['runtimeArchiveSha256']}, '2026.9.8')
        self.instance.managed_companion_capacity = profile
        self.instance.snapshot_recovery()
        receipt = json.loads((self.instance.output/'closed-capacity.json').read_text())
        self.assertEqual(receipt['managedCompanionBytes'], 2 * 1024 ** 3)
        self.assertTrue(receipt['managedCompanionEstimate']['estimateOnly'])
        expected = sum(receipt[name] for name in ('candidateBytes', 'snapshotCopyBytes', 'independentRestoreBytes',
            'metadataOverheadBytes', 'reserveBytes', 'allowanceBytes', 'nativeMigrationBytes', 'managedCompanionBytes'))
        self.assertEqual(receipt['requiredFreeBytes'], expected)

    def test_companion_provenance_and_unchanged_runtime_behavior(self):
        self.assertEqual(driver.managed_companion_capacity(None, '2026.9.8'), {'managedCompanionBytes': 0})
        self.assertEqual(driver.managed_companion_capacity({'archiveSha256': 'a'*64}, '2026.9.6'), {'managedCompanionBytes': 0})
        with self.assertRaisesRegex(RuntimeError, 'reviewed exact 9.8 runtime'):
            driver.managed_companion_capacity({'archiveSha256': 'a'*64}, '2026.9.8')

    def test_companion_missing_paths_use_existing_ancestor(self):
        driver.require_capacity_filesystem((self.root/'home'/'.npm', self.root/'state'/'npm'/'projects'), self.root)

    def test_companion_redirected_cache_filesystem_is_refused(self):
        cache = self.root/'cache'; cache.mkdir()
        original_stat = pathlib.Path.stat
        def redirected_stat(path, *args, **kwargs):
            info = original_stat(path, *args, **kwargs)
            if path == cache:
                return types.SimpleNamespace(st_dev=info.st_dev + 1)
            return info
        with patch.object(pathlib.Path, 'stat', redirected_stat):
            with self.assertRaisesRegex(RuntimeError, 'reviewed capacity filesystem'):
                driver.require_capacity_filesystem((cache,), self.root)

    def test_changed_original_during_refused_admission_is_not_safe_capacity_refusal(self):
        real = recovery.snapshot_closed
        def mutate_before_capacity(*args, **kwargs):
            admit = kwargs['admit_plan']
            def changed(*values):
                plan = admit(*values)
                (self.instance.data/'record').write_bytes(b'uncertain changed data')
                return plan
            kwargs['admit_plan'] = changed
            return real(*args, **kwargs)
        self.instance.migration_storage_required = self.free
        self.stack.enter_context(patch.object(driver, 'snapshot_closed', mutate_before_capacity))
        with self.assertRaisesRegex(RuntimeError, 'closed original changed') as raised:
            self.instance.snapshot_recovery()
        self.assertNotIsInstance(raised.exception, recovery.InsufficientStorage)
        self.assertFalse(self.instance.recovery.exists())
        self.assertEqual((self.instance.data/'record').read_bytes(), b'uncertain changed data')

    def test_changed_original_during_copy_keeps_evidence_and_refuses_verified_receipt(self):
        original_copy = self.copy
        def mutate(*args):
            original_copy(*args)
            (self.instance.data/'record').write_bytes(b'post-admission mutation')
        self.stack.enter_context(patch.object(recovery, 'run_copy', mutate))
        with self.assertRaisesRegex(RuntimeError, 'Closed live state changed'):
            self.instance.snapshot_recovery()
        self.assertTrue((self.instance.recovery/'workspace/record').exists())
        self.assertFalse((self.instance.recovery/'snapshot-verified.json').exists())


if __name__ == '__main__':
    unittest.main()
