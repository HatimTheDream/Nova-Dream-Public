"""Disposable recovery admission fixtures; no host/service or saved user data."""
import copy
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'deploy/update-runner'))
import recovery


def layout(device=1):
    return {'device': device, 'unitBytes': 4096, 'directoryCount': 2, 'directoryObservedBytes': 8192,
            'directoryCopyBytes': 16384, 'symlinkCount': 1, 'symlinkObservedBytes': 0,
            'symlinkCopyBytes': 4096, 'fileInodeCount': 1}


def records():
    entry = {'kind': 'file', 'size': 64 * 1024 ** 2, 'sha256': 'a' * 64, 'mode': 0o600,
             'uid': 1, 'gid': 1, 'mtime_ns': 1, 'xattrs': {}, 'hardlink_group': 'first'}
    source = {'first': entry, 'second': dict(entry)}
    inodes = {name: {'device': 1, 'inode': 10, 'allocated': 4096, 'sparse': True} for name in source}
    old = {name: {**value, 'sha256': 'b' * 64} for name, value in source.items()}
    old_inodes = {name: {**value, 'inode': 20} for name, value in inodes.items()}
    return source, inodes, old, old_inodes


class AllocationTests(unittest.TestCase):
    def test_exact_fit_counts_unique_sparse_files_layout_manifest_and_each_protected_copy(self):
        source, inodes, old, old_inodes = records()
        allocation = layout()
        plan = recovery.capacity(source, inodes, old, old_inodes, 10 ** 12,
                                 allocation=allocation, protected_sizes=(1, 4097))
        self.assertEqual(plan['snapshotCopyBytes'], 4096)
        self.assertEqual(plan['independentRestoreBytes'], 4096)
        self.assertEqual(plan['closedAllocatedBytes'], 4096)
        self.assertEqual(plan['protectedCopyBytes'], 3 * 4096)
        manifest_bytes = len(json.dumps(source, sort_keys=True, separators=(',', ':')).encode())
        self.assertEqual(plan['snapshotManifestBytes'], recovery.rounded_allocation(manifest_bytes, 4096))
        self.assertEqual(plan['metadataOverheadBytes'], 2 * (16384 + 4096) + 4096 + 3 * 4096 + 4 * 4096)
        self.assertEqual(plan['requiredFreeBytes'], sum(plan[key] for key in
                         ('candidateBytes', 'snapshotCopyBytes', 'independentRestoreBytes', 'metadataOverheadBytes', 'reserveBytes', 'allowanceBytes')))
        self.assertEqual(plan['allowanceBytes'], 2 * recovery.ALLOWANCE)
        required = plan['requiredFreeBytes']
        self.assertEqual(recovery.capacity(source, inodes, old, old_inodes, required,
                         allocation=allocation, protected_sizes=(1, 4097))['requiredFreeBytes'], required)
        with self.assertRaises(recovery.InsufficientStorage):
            recovery.capacity(source, inodes, old, old_inodes, required - 1,
                              allocation=allocation, protected_sizes=(1, 4097))

    def test_unchanged_file_generation_still_needs_new_directories_and_independent_files(self):
        source, inodes, _, old_inodes = records()
        plan = recovery.capacity(source, inodes, source, old_inodes, 10 ** 12, allocation=layout())
        self.assertEqual(plan['snapshotCopyBytes'], 0)
        self.assertGreater(plan['metadataOverheadBytes'], 2 * layout()['directoryCopyBytes'])
        self.assertEqual(plan['independentTotalBytes'], 4096 + 16384 + 4096)
        self.assertTrue(plan['metadataOverheadMeasured'] and plan['snapshotDeltaMeasured'])

    def test_missing_allocation_never_claims_measured_layout_or_discards_protected_files(self):
        plan = recovery.capacity(*records(), 10 ** 12)
        self.assertFalse(plan['metadataOverheadMeasured'])
        self.assertFalse(plan['snapshotDeltaMeasured'])
        with self.assertRaisesRegex(RuntimeError, 'Protected copies'):
            recovery.capacity(*records(), 10 ** 12, protected_sizes=(1,))

    def test_hardlink_topology_and_live_baseline_inode_sharing_still_fail(self):
        source, inodes, old, old_inodes = records()
        with self.assertRaisesRegex(RuntimeError, 'share recovery inodes'):
            recovery.capacity(source, inodes, old, inodes, 10 ** 12, allocation=layout())
        old = copy.deepcopy(source)
        old['first'].pop('hardlink_group')
        with self.assertRaisesRegex(RuntimeError, 'hardlink topology'):
            recovery.capacity(source, inodes, old, old_inodes, 10 ** 12, allocation=layout())
        inodes['second']['allocated'] += 4096
        with self.assertRaisesRegex(RuntimeError, 'Hardlink allocation changed'):
            recovery.unique_allocated(inodes)

    def test_manifest_measurement_uses_actual_ascii_json_encoding(self):
        value = {'café': {'target': '☀/文件', 'nested': [1, True, None]}}
        self.assertEqual(recovery.json_size(value), len(json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf8')))

    def test_future_verification_record_growth_is_budgeted_in_actual_filesystem_units(self):
        plan = recovery.capacity(*records(), 10 ** 12, allocation=layout())
        before = dict(plan)
        plan['additionalAdmissionEvidence'] = 'x' * 8192
        recovery.budget_verification_record(plan)
        delta = plan['recoveryRecordBytes'] - before['recoveryRecordBytes']
        self.assertGreaterEqual(delta, 8192)
        self.assertEqual(delta % 4096, 0)
        self.assertEqual(plan['requiredFreeBytes'] - before['requiredFreeBytes'], delta)
        self.assertEqual(plan['metadataOverheadBytes'] - before['metadataOverheadBytes'], delta)

    def test_sparse_allocation_limit_remains_one_block_per_large_file(self):
        source, inodes, _, _ = records()
        copied = copy.deepcopy(inodes)
        copied['first']['allocated'] += 8192
        with self.assertRaisesRegex(RuntimeError, 'sparse file lost'):
            recovery.retained_sparse_allocation(source, inodes, copied)


class SnapshotAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nova-allocation-test-')
        self.root = pathlib.Path(self.temp.name)
        self.data, self.baseline = self.root / 'live', self.root / 'old'
        self.data.mkdir(); self.baseline.mkdir()
        self.destination = self.root / 'new-generation' / 'workspace'
        self.source, self.inodes, self.old, self.old_inodes = records()
        self.calls, self.output, self.stops = [], {}, []
        self.free = 10 ** 12
        self.mutation = None
        self.copy_started = False
        self.patches = [patch.object(recovery, 'inventory', side_effect=self.inventory),
                        patch.object(recovery, 'allocation_unit', return_value=4096),
                        patch.object(recovery.shutil, 'disk_usage', side_effect=lambda _: types.SimpleNamespace(free=self.free)),
                        patch.object(recovery, 'run_copy', side_effect=self.copy),
                        patch.object(recovery, 'flush_tree'),
                        patch.object(recovery, 'write_json', side_effect=lambda path, value: self.output.update({path.name: value})),
                        patch.object(recovery, 'digest', return_value='a' * 64)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def stopped(self):
        self.stops.append(True)

    def inventory(self, path, *, allocation=None):
        self.calls.append(path)
        if allocation is not None:
            allocation.update(layout(self.root.stat().st_dev))
        entries, inodes = (self.old, self.old_inodes) if path == self.baseline else (self.source, self.inodes)
        entries, inodes = copy.deepcopy(entries), copy.deepcopy(inodes)
        if path == self.destination:
            for info in inodes.values():
                info['inode'] = 30 if self.mutation != 'shared' else 10
        if self.mutation == 'refusal' and path == self.data and self.calls.count(path) > 1:
            entries['first']['sha256'] = 'changed'
        if self.copy_started and self.mutation == 'source' and path == self.data:
            entries['first']['sha256'] = 'changed'
        if self.copy_started and self.mutation == 'baseline' and path == self.baseline:
            entries['first']['sha256'] = 'changed'
        return entries, inodes

    def copy(self, *_args):
        self.copy_started = True

    def begin(self, plan):
        self.assertTrue(plan['metadataOverheadMeasured'])
        self.output['closed-capacity.json'] = plan
        self.destination.parent.mkdir()

    def run_snapshot(self, **kwargs):
        return recovery.snapshot_closed(self.data, self.destination, self.baseline, self.stopped,
                                        begin_copy=self.begin, capacity_volume=self.root, **kwargs)

    def test_single_fresh_admission_inventory_pair_then_all_postcopy_checks(self):
        admission = []
        def admit(plan, source, inodes):
            admission.append((source, inodes))
            self.assertFalse(self.destination.parent.exists())
            return {**plan, 'startupGrowthAllowanceBytes': 100, 'requiredFreeBytes': plan['requiredFreeBytes'] + 100}
        self.assertEqual(self.run_snapshot(admit_plan=admit), self.source)
        self.assertEqual(len(admission), 1)
        self.assertEqual(self.calls, [self.data, self.baseline, self.destination, self.data, self.baseline])
        self.assertEqual(self.output['snapshot-manifest.json'], self.source)
        self.assertIn('sourceReverification', self.output['snapshot-verified.json']['timingsMilliseconds'])
        self.assertGreaterEqual(len(self.stops), 3)

    def test_base_capacity_refusal_still_supplies_closed_allocation_then_proves_unchanged(self):
        self.free = 0
        admission = []
        def admit(plan, source, inodes):
            admission.append(plan['closedAllocatedBytes'])
            return plan
        with self.assertRaises(recovery.InsufficientStorage):
            self.run_snapshot(admit_plan=admit)
        self.assertEqual(admission, [4096])
        self.assertEqual(self.calls, [self.data, self.baseline, self.data])
        self.assertFalse(self.destination.parent.exists())
        self.assertFalse(self.copy_started or self.output)

    def test_caller_extra_budget_refusal_also_reverifies_before_any_write(self):
        def admit(*_args):
            raise recovery.InsufficientStorage('Additional startup does not fit.')
        with self.assertRaises(recovery.InsufficientStorage):
            self.run_snapshot(admit_plan=admit)
        self.assertEqual(self.calls, [self.data, self.baseline, self.data])
        self.assertFalse(self.destination.parent.exists())

    def test_safe_refusal_releases_large_inventory_and_finished_callback_traceback_locals(self):
        def admit(plan, source, source_inodes):
            self.assertEqual(source, self.source)
            raise recovery.InsufficientStorage('Additional startup does not fit.')
        try:
            self.run_snapshot(admit_plan=admit)
        except recovery.InsufficientStorage as failure:
            trace = failure.__traceback__
            checked = set()
            while trace:
                name = trace.tb_frame.f_code.co_name
                if name in ('snapshot_closed', 'admit'):
                    checked.add(name)
                    self.assertFalse({'source', 'source_inodes', 'old', 'old_inodes', 'allocation'} & set(trace.tb_frame.f_locals))
                trace = trace.tb_next
            self.assertEqual(checked, {'snapshot_closed', 'admit'})
        else:
            self.fail('Synthetic startup budget must refuse.')

    def test_mutation_during_refusal_is_not_safe_unchanged(self):
        self.free, self.mutation = 0, 'refusal'
        with self.assertRaisesRegex(RuntimeError, 'unchanged closed original changed') as failure:
            self.run_snapshot()
        self.assertNotIsInstance(failure.exception, recovery.InsufficientStorage)
        self.assertFalse(self.destination.parent.exists())

    def test_callback_cannot_remove_metadata_or_weaken_required_capacity(self):
        for field in ('requiredFreeBytes', 'metadataOverheadBytes', 'allowanceBytes'):
            with self.subTest(field=field):
                with self.assertRaisesRegex(RuntimeError, 'cannot weaken'):
                    self.run_snapshot(admit_plan=lambda plan, *_: {**plan, field: 0})
                self.assertFalse(self.destination.parent.exists())

    def test_cross_filesystem_baseline_refuses_before_admission_or_destination_write(self):
        original = pathlib.Path.lstat
        def metadata(path):
            info = original(path)
            return types.SimpleNamespace(st_dev=info.st_dev + 1) if path == self.baseline else info
        with patch.object(pathlib.Path, 'lstat', metadata):
            with self.assertRaisesRegex(RuntimeError, 'Deduplication baseline') as failure:
                self.run_snapshot(admit_plan=lambda *_: self.fail('Cross-volume baseline cannot be admitted.'))
        self.assertNotIsInstance(failure.exception, recovery.InsufficientStorage)
        self.assertFalse(self.destination.parent.exists())
        self.assertFalse(self.copy_started or self.output)

    def test_copy_still_rejects_live_mutation_baseline_mutation_and_shared_inodes(self):
        for mutation, reason in [('source', 'Closed live state changed'), ('baseline', 'prior closed recovery changed'),
                                 ('shared', 'must not share live')]:
            with self.subTest(mutation=mutation):
                self.mutation = mutation
                self.copy_started = False
                with self.assertRaisesRegex(RuntimeError, reason):
                    self.run_snapshot()
                self.assertNotIn('snapshot-verified.json', self.output)
                self.destination.rmdir(); self.destination.parent.rmdir()
                self.calls.clear(); self.output.clear()


@unittest.skipUnless(sys.platform == 'linux' and pathlib.Path('/usr/bin/rsync').exists(), 'Requires Linux metadata/rsync; only disposable fixtures.')
class LinuxAllocationTests(unittest.TestCase):
    def test_real_walk_preserves_manifest_and_measures_allocations_then_independent_copy(self):
        with tempfile.TemporaryDirectory(prefix='nova-layout-fixture-') as temporary:
            root = pathlib.Path(temporary)
            data, baseline, generation = root / 'live', root / 'baseline', root / 'generation'
            (data / 'nested' / 'empty').mkdir(parents=True)
            (data / 'nested' / 'saved').write_bytes(b'exact saved content')
            os.link(data / 'nested' / 'saved', data / 'hardlink')
            (data / 'link').symlink_to('nested/saved')
            with (data / 'sparse').open('wb') as output:
                output.write(b'first'); output.seek(8 * 1024 ** 2); output.write(b'last')
            os.setxattr(data / 'nested' / 'saved', 'user.nova-allocation-fixture', b'saved-xattr')
            subprocess.run(['/usr/bin/cp', '-a', '--', str(data), str(baseline)], check=True)
            before = recovery.inventory(data)
            allocation = {}
            self.assertEqual(recovery.inventory(data, allocation=allocation), before)
            with self.assertRaisesRegex(RuntimeError, 'must be fresh'):
                recovery.inventory(data, allocation=allocation)
            self.assertEqual(allocation['directoryCount'], 3)
            self.assertEqual(allocation['symlinkCount'], 1)
            self.assertEqual(allocation['fileInodeCount'], 2)
            self.assertGreater(allocation['directoryCopyBytes'], allocation['directoryObservedBytes'])
            generation.mkdir()
            captured = []
            snapshot = generation / 'workspace'
            recovery.snapshot_closed(data, snapshot, baseline, lambda: None, begin_copy=lambda plan: captured.append(plan), protected_sizes=(1,))
            restored = root / 'restored'
            recovery.prepare_independent(snapshot, restored, data, lambda: None)
            self.assertEqual(recovery.inventory(restored)[0], before[0])
            self.assertTrue(recovery.inode_ids(recovery.inventory(restored)[1]).isdisjoint(recovery.inode_ids(before[1])))
            self.assertEqual(captured[0]['closedAllocatedBytes'], recovery.unique_allocated(before[1]))
            self.assertEqual(captured[0]['snapshotCopyBytes'], 0)
            self.assertEqual(captured[0]['snapshotManifestBytes'], recovery.rounded_allocation((generation / 'snapshot-manifest.json').stat().st_size, allocation['unitBytes']))


if __name__ == '__main__':
    unittest.main()
