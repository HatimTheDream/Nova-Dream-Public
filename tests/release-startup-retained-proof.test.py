import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


subject = load('startup_retained', ROOT / 'scripts/release-startup-retained-proof.py')
fixture = load('startup_fixture', ROOT / 'support/startup-retained-fixture.py').fixture


class Checks(unittest.TestCase):
    def consume(self, f): return subject.consume(f['request'], f['read'], f['sources'])

    def test_complete_original_chain_keeps_qualification_separate_from_delivery(self):
        result = self.consume(fixture())
        self.assertEqual([v['scenario'] for v in result['scenarios']], list(subject.SCENARIOS))
        self.assertTrue(result['actualSettledQualification']); self.assertTrue(result['heldBootstrapVerified'])
        self.assertFalse(result['productionAdmission']); self.assertTrue(result['freshFullRehearsalStillRequired'])
        self.assertTrue(result['liveAcceptanceStillRequired']); self.assertEqual(len(result['references']), 54)
        self.assertEqual(len([k for k in result['references'] if k.startswith('homeCapture/')]), 15)


    def test_child_receipts_keep_the_producer_byte_count_and_canonical_namespace(self):
        f = fixture(); child = subject.parse(f['files'][f['roles']['child']['path']])
        result = self.consume(f)
        for index, scenario in enumerate(subject.SCENARIOS, 1):
            original = f['files'][f['roles'][scenario + '/preservation']['path']]
            self.assertEqual(child['scenarios'][index - 1], {
                'path': '/qualification/evidence/attempt-' + str(index) + '/preservation.json',
                'sha256': subject.sha(original), 'bytes': len(original)})
            self.assertEqual(result['references'][scenario + '/preservation']['bytes'], len(original))

    def test_rehashed_child_receipt_shape_or_content_disagreement_refuses(self):
        changes = [lambda ref: ref.pop('bytes'), lambda ref: ref.update(bytes=True),
                   lambda ref: ref.update(bytes=0), lambda ref: ref.update(bytes=-1),
                   lambda ref: ref.update(bytes=float(ref['bytes'])),
                   lambda ref: ref.update(bytes=ref['bytes'] + 1),
                   lambda ref: ref.update(unexpected=True),
                   lambda ref: ref.update(path=ref['path'].replace('/qualification/', '/other/')),
                   lambda ref: ref.update(sha256='0' * 64)]
        for index in range(3):
            for change in changes:
                with self.subTest(attempt=index + 1, change=change), self.assertRaisesRegex(
                        RuntimeError, 'startup-proof-child-canonical-receipt-changed'):
                    self.consume(fixture({'child': lambda value, i=index, edit=change: edit(value['scenarios'][i])}))

    def test_complete_capture_rejects_each_missing_control_or_metadata_reference(self):
        cases = [('review', lambda v: v.pop('homeCapture')),
                 ('review', lambda v: v['homeCapture'].pop('result')),
                 ('review', lambda v: v['homeCapture'].pop('closure')),
                 ('review', lambda v: v.pop('liveContext')),
                 ('review', lambda v: v.pop('effectiveUnit'))]
        cases += [('homeCapture/result', lambda v, k=k: v.pop(k))
                  for k in ('captureInput', 'capturePlan', 'captureIntent', 'seedPhysical', 'seedMetadata')]
        cases += [('homeCapture/result', lambda v, k=k: v['homeSeed'].pop(k)) for k in ('inventory', 'sourceCapture')]
        cases += [('homeCapture/sourceCapture', lambda v, k=k: v.pop(k))
                  for k in ('sourceBefore', 'sourceAfter', 'sourcePhysical', 'sourceFullMetadata')]
        for role, change in cases:
            with self.subTest(role=role), self.assertRaises((RuntimeError, KeyError)): self.consume(fixture({role: change}))

    def test_all_original_capture_references_are_hash_checked(self):
        roles = [role for role in fixture()['roles'] if role.startswith('homeCapture/')]
        self.assertEqual(len(roles), 15)
        for role in roles:
            f = fixture(); f['files'][f['roles'][role]['path']] += b' '
            with self.subTest(role=role), self.assertRaisesRegex(RuntimeError, 'original-reference-changed'):
                self.consume(f)

    def test_capture_metadata_origin_scope_and_worker_closure_are_not_summary_flags(self):
        cases = [('homeCapture/sourceMetadata', lambda v: v['.cache'].__setitem__(8, 99)),
                 ('homeCapture/sourceCapture', lambda v: v['sourceRootBefore'].__setitem__(1, 1000)),
                 ('homeCapture/sourceCapture', lambda v: v.update(sourceUnchangedScope='whole-qualification')),
                 ('homeCapture/liveContext', lambda v: v['health'].update(processIdentity='another-process')),
                 ('homeCapture/closure', lambda v: v['observation']['properties'].update(InvocationID='2' * 32)),
                 ('homeCapture/closure', lambda v: v['observation']['cgroup'].update(populated=True)),
                 ('homeCapture/result', lambda v: v.update(startupOperationId='4' * 36))]
        for role, change in cases:
            with self.subTest(role=role), self.assertRaises(RuntimeError): self.consume(fixture({role: change}))

    def test_missing_unreviewed_or_changed_sources_refuse(self):
        f = fixture()
        for sources in ({}, {**f['sources'], 'qualified-parent.py': None}, {**f['sources'], 'contracts.py': '0' * 64}):
            with self.subTest(sources=sources), self.assertRaises(RuntimeError):
                subject.consume(f['request'], f['read'], sources)
        f['files'][f['roles']['source/contracts.py']['path']] = b'changed'
        with self.assertRaisesRegex(RuntimeError, 'reference-changed'): self.consume(f)

    def test_tampered_plan_intent_or_binding_refuses_even_with_rehashed_receipts(self):
        cases = [('intent', lambda x: x.update(adapterSha256='0' * 64)),
                 ('plan', lambda x: x.update(requiredFreeBytes=300)),
                 ('technical', lambda x: x.update(heldBootstrapReviewed=False)),
                 ('technical', lambda x: x.pop('negativeVerifierEvidence')),
                 ('child', lambda x: x['qualificationBinding'].update(dependencyGraphSha256='0' * 64)),
                 ('binding', lambda x: x['runtime'].update(agentVersion='2026.9.9'))]
        for role, change in cases:
            with self.subTest(role=role), self.assertRaises(RuntimeError): self.consume(fixture({role: change}))

    def test_incomplete_retention_and_unknown_worker_never_qualify(self):
        for role, key, value in [('parent', 'passed', False), ('child', 'completeMaintainedSavedAndNativeState', False),
            ('closure', 'ownedProcessesAndNamespacesClosed', False), ('closure', 'activeOwnedPids', [99]),
            ('closure', 'activeNamespaceOwners', [101]), ('closure', 'activeFixtureOwners', [102]),
            ('parent', 'productionMutation', True), ('child', 'deliveryQualification', True),
            ('pristine-prior-restoration/preservation', 'fullMaintainedNativeVerifier', False)]:
            with self.subTest(role=role, key=key), self.assertRaises(RuntimeError):
                self.consume(fixture({role: lambda x, k=key, v=value: x.update({k: v})}))

    def test_no_external_network_and_exact_held_bootstrap_are_mandatory(self):
        changes = [lambda x: x.update(networkInterfaces=['lo', 'eth0']),
                   lambda x: x['acceptanceGuard'].update(nativeSuspended=False),
                   lambda x: x['acceptanceGuard'].update(blockers=['assignment-running']),
                   lambda x: x['controllerBefore']['lease'].update(id='wrong'),
                   lambda x: x['controllerBefore'].update(held=True),
                   lambda x: x['controllerBefore'].update(freshHeartbeat=True),
                   lambda x: x['controllerBeforeControl'].update(holdFor='wrong'),
                   lambda x: x['controllerBeforeProcessClosure'].update(onlyPrivateController=False),
                   lambda x: x['controllerAfter']['lease'].update(phase='released'),
                   lambda x: x['processAuthority'].update(updateSocket='/different.sock'),
                   lambda x: x['processAuthority'].update(startTicks=0)]
        for change in changes:
            with self.subTest(change=change), self.assertRaisesRegex(RuntimeError, 'bootstrap'):
                self.consume(fixture({'target-first-start/bootstrap': change}))

    def test_prior_rollback_requires_pristine_independent_home_and_workspace(self):
        for key, value in [('independentOriginalRestored', False), ('independentHomeRestored', False),
            ('workspaceInodesDisjoint', False), ('homeInodesDisjoint', False), ('fullPreStartSavedAndNativeEquality', False),
            ('restoredInventorySha256', '0' * 64), ('restoredHomeInventorySha256', '0' * 64),
            ('intentSha256', '0' * 64), ('sourceManifestSha256', '0' * 64), ('sourceHomeInventorySha256', '0' * 64)]:
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'pristine-restoration'):
                self.consume(fixture({'restorationCompleted': lambda x, k=key, v=value: x.update({k: v})}))

    def test_start_restart_and_rollback_cannot_reuse_wrong_process_or_window(self):
        for role, change in [('target-restart/started', lambda x: x.update(startedAtSeconds=1)),
            ('target-first-start/closed', lambda x: x.update(closedAtSeconds=4000)),
            ('target-restart/process', lambda x: x.update(pid=1)),
            ('pristine-prior-restoration/ready', lambda x: x.update(candidateId='b' * 64)),
            ('target-first-start/closed', lambda x: x.update(owningServiceFullyStopped=False)),
            ('target-restart/clock-attribution', lambda x: x.update(eventHistoryWindow=[100, 230])),
            ('pristine-prior-restoration/clock-attribution', lambda x: x.update(eventHistoryWindow=[100, 130])),
            ('target-first-start/clock-attribution', lambda x: x.update(windowWidened=True)),
            ('child', lambda x: x.update(childNamespaces=x['parentNamespaces']))]:
            with self.subTest(role=role), self.assertRaises(RuntimeError): self.consume(fixture({role: change}))

    def test_full_service_and_host_entrypoint_bytes_are_read_again(self):
        for role in ('dist/service/apps/service/main.js', 'host', 'package', 'lock', 'manifest'):
            f = fixture(); f['files'][f['roles'][role]['path']] += b'\nchanged'
            with self.subTest(role=role), self.assertRaises((RuntimeError, ValueError)): self.consume(f)

    def test_parser_rejects_duplicate_fields_and_nonfinite_numbers(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError): subject.parse(raw)

    def test_original_worker_pid_reuse_and_recursive_cgroup_closure(self):
        with tempfile.TemporaryDirectory(prefix='nova-startup-owner-') as folder:
            root = Path(folder); proc = root / 'proc'; cg = root / 'cgroup'; proc.mkdir(); cg.mkdir()
            worker = {'pid': 55, 'startTicks': 8888, 'controlGroup': '/system.slice/nova-qa-qualified-fixture.service'}
            group = cg / worker['controlGroup'].lstrip('/'); group.mkdir(parents=True); (group / 'cgroup.procs').write_bytes(b'')
            # Parent/child still present is a refusal even when a retained receipt says passed.
            process = proc / '55'; process.mkdir()
            fields = [b'0'] * 20; fields[19] = b'8888'
            (process / 'stat').write_bytes(b'55 (synthetic parent) ' + b' '.join(fields))
            with self.assertRaisesRegex(RuntimeError, 'still-running'): subject.worker_closed(worker, proc, cg)
            fields[19] = b'9999'; (process / 'stat').write_bytes(b'55 (reused pid) ' + b' '.join(fields))
            subject.worker_closed(worker, proc, cg)
            nested = group / 'child'; nested.mkdir(); (nested / 'cgroup.procs').write_bytes(b'99\n')
            with self.assertRaisesRegex(RuntimeError, 'cgroup-not-closed'): subject.worker_closed(worker, proc, cg)
            (nested / 'cgroup.procs').write_bytes(b''); subject.worker_closed(worker, proc, cg)

    @unittest.skipUnless(os.name == 'posix', 'Actual protected Linux file identities require POSIX; Windows semantic checks run separately.')
    def test_linux_protected_reader_ownership_links_race_and_closure(self):
        self.assertEqual(os.geteuid(), 0, 'The canonical workflow runs this bounded fixture as root.')
        with tempfile.TemporaryDirectory(prefix='nova-startup-proof-', dir='/run') as folder:
            root = Path(folder)
            self.assertEqual(root.resolve().parent, Path('/run'))
            self.assertTrue(root.name.startswith('nova-startup-proof-'))
            file = root / 'evidence.json'; file.write_bytes(b'{"kept":true}\n'); file.chmod(0o600)
            reader = subject.ProtectedReader(); self.assertEqual(reader(str(file)), file.read_bytes()); reader.unchanged()
            symlink = root / 'redirected'; symlink.symlink_to(file)
            with self.assertRaisesRegex(RuntimeError, 'redirected'): subject.ProtectedReader()(str(symlink))
            symlink.unlink()
            hardlink = root / 'alias'; os.link(file, hardlink)
            with self.assertRaisesRegex(RuntimeError, 'file-role'): subject.ProtectedReader()(str(file))
            hardlink.unlink()
            file.chmod(0o666)
            with self.assertRaisesRegex(RuntimeError, 'unprotected'): subject.ProtectedReader()(str(file))
            file.chmod(0o600); os.chown(file, 65534, -1)
            with self.assertRaisesRegex(RuntimeError, 'unprotected'): subject.ProtectedReader()(str(file))
            os.chown(file, 0, -1)
            with self.assertRaisesRegex(RuntimeError, 'file-role'): subject.ProtectedReader()(str(file), 1)
            real_fstat = os.fstat; calls = 0
            def mutate_after_read(fd):
                nonlocal calls
                calls += 1
                if calls == 2:
                    with file.open('ab') as output: output.write(b'changed while opened')
                return real_fstat(fd)
            with patch.object(subject.os, 'fstat', side_effect=mutate_after_read):
                with self.assertRaisesRegex(RuntimeError, 'read-changed'): subject.ProtectedReader()(str(file))
            reader = subject.ProtectedReader(); reader(str(file)); file.write_bytes(b'changed after read')
            with self.assertRaisesRegex(RuntimeError, 'closure-changed'): reader.unchanged()


if __name__ == '__main__': unittest.main(verbosity=2)
