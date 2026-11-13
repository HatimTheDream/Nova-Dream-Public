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
fixture_module = load('startup_fixture', ROOT / 'support/startup-retained-fixture.py')
fixture = fixture_module.fixture


class Checks(unittest.TestCase):
    def test_capture_proof_binds_physical_owner_first_clock_and_independent_restoration(self):
        import copy
        path='selected/openclaw-runtime/state/tmp/plugin-captures/11111111-1111-4111-8111-111111111111/owner.sqlite'
        empty=subject.CAPTURE_EMPTY
        header='b'*64
        def identity(dev, ino, size, stamp):
            return [dev,ino,0o100600,999,986,1,size,stamp,stamp]
        def row(dev, ino, jino, size, stamp, journal):
            return {'parent':[dev,ino+100,0o40700,999,986,2,4096,stamp,stamp],
                    'owner':identity(dev,ino,size,stamp),
                    'journal':identity(dev,jino,512,stamp) if journal else None,
                    'hashes':[empty,header] if journal else [subject.CAPTURE_TOKEN,None],
                    'coverage':[{'uid':999,'gid':986,'mode':448,'xattrs':{}},{},'c'*64],'captures':None}
        snapshot=row(1,100,101,0,1,True)
        plan={'selectedRelative':'selected','baselineFamilies':{path:{'':[snapshot['owner'],empty],'-journal':[snapshot['journal'],header]}}}
        def evidence(attempt, carried=None):
            start=100*attempt; window=[start,start+10]; ino=20 if attempt==3 else 10
            prev=row(2,ino,ino+1,0,start*10**9,True)
            after=row(2,ino,0,4096,(start+2)*10**9,False)
            done={'source':snapshot,'after':after,'firstWindow':window}
            if carried is not None:
                done=carried
                prev=done['after']
            root={'format':1,'jobId':'lease'+str(attempt),'candidateId':'prior' if attempt==3 else 'target',
                  'attempt':attempt,'epoch':'test epoch','physicalRoots':[[1,3,16832,0,0],[2,4,16832,999,986]]}
            before={**root,'observedAtNs':start*10**9,'roles':{path:{'source':snapshot,'liveBefore':prev,'carry':carried}}}
            closed={**root,'beforeSha256':subject.capture_receipt_sha(before),'retired':{path:done},'closedWindow':window}
            return {'before':before,'closed':closed,'beforeSha256':subject.capture_receipt_sha(before),
                    'closedSha256':subject.capture_receipt_sha(closed)}
        def check(item,i,first=None):
            return subject.capture_retirement_summary(item,plan,'lease'+str(i),'prior' if i==3 else 'target',
                'test epoch',i,[100*i,100*i+10], first['roles'] if first else None)
        first=evidence(1); initial=check(first,1)
        second=evidence(2,first['closed']['retired'][path]); self.assertEqual(check(second,2,initial)['roles'],initial['roles'])
        third=evidence(3); self.assertNotEqual(check(third,3,initial)['roles'][0]['physicalOwner'],initial['roles'][0]['physicalOwner'])
        def reseal(x):
            x['beforeSha256']=subject.capture_receipt_sha(x['before'])
            x['closed']['beforeSha256']=x['beforeSha256']
            x['closedSha256']=subject.capture_receipt_sha(x['closed'])
        for kind in ('missing-role','changed-clock','changed-after','different-inode','wrong-source','changed-carry'):
            val=copy.deepcopy(second if kind=='changed-carry' else first)
            if kind=='missing-role': val['closed']['retired'].clear()
            elif kind=='changed-clock': val['closed']['closedWindow'][1]+=1
            elif kind=='changed-after': val['closed']['retired'][path]['after']['hashes'][0]='0'*64
            elif kind=='different-inode': val['before']['roles'][path]['liveBefore']['owner'][1]+=1
            elif kind=='wrong-source': val['closed']['retired'][path]['source']['hashes'][1]='0'*64
            else: val['before']['roles'][path]['carry']=None
            reseal(val)
            with self.subTest(kind=kind), self.assertRaisesRegex(RuntimeError, 'authentic-closed-capture'):
                check(val,2,initial) if kind=='changed-carry' else check(val,1)


    def consume(self, f): return subject.consume(f['request'], f['read'], f['sources'])

    def test_current_and_historical_producers_cannot_skip_capture_helper_or_baseline_admission(self):
        # Only the synthetic producer's source identity is substituted to select
        # the real registered family. Every receipt/content hash still passes
        # through the actual consumer; this is not qualification evidence.
        original_sha = fixture_module.sha
        for producer in (
            'f8de414f4822707675dbe0fca150ad0dd917202579bacd8432a6115c4a218a28',
            'f1004fc0fafec1669c5bd4822cf27925d64e861b0bb74301a033a431becccc10',
            '4404a1c0a7658c206b49d6daa64e4f7c1c0bf8ffa905ce19a4015312c823d599',
            '479a10e7303411aaf5e76a08d857747798cf6a65362fdd75a2808d7f2a585294',
        ):
            def synthetic_source_identity(raw):
                return producer if raw == b'# synthetic qualified-startup.py' else original_sha(raw)
            with self.subTest(producer=producer), patch.object(fixture_module, 'sha', synthetic_source_identity), patch.object(subject, 'sha', synthetic_source_identity):
                with self.assertRaisesRegex(RuntimeError, 'capture-lifecycle-helper-source-required'):
                    self.consume(fixture(schema_migration=True))
                def helpers(binding):
                    binding['helpers'].update({
                        'recovery.py': '23b7d18d415393a315a8140b674edee4a12cbc1b8f996b439843472208dcbd15',
                        'install.py': '522b78eeb6a6d986dde2ac353516c47a987d8283bb030d273b0b4122d08cbe24',
                    })
                with self.assertRaisesRegex(RuntimeError, 'original-capture-manifest-input-binding'):
                    self.consume(fixture({'binding': helpers, 'plan': lambda value: value.update(inputHashes={})}, schema_migration=True))

    def test_explicit_schema_migration_retains_pristine55_and_qualifies_two_actual60_starts(self):
        result=self.consume(fixture(schema_migration=True))
        self.assertEqual(result['qualificationBinding']['applicationTransition'],subject.APPLICATION_TRANSITION)
        self.assertEqual(len(result['qualificationBinding']['helpers']),11)
        self.assertTrue(result['independentOriginalRestored'])
        self.assertFalse(result['productionAdmission'])

    def test_rehashed_schema_migration_wrong_pristine_target_or_proof_refuses(self):
        cases=[('binding',lambda v:v['applicationTransition'].update(toSchemaVersion=61)),
               ('binding',lambda v:v['helpers'].pop('hosted_retained_catalog.py')),
               ('prior-package',lambda v:v['edition3'].update(schemaVersion=60)),
               ('manifest',lambda v:v.update(schemaVersion=55)),
               ('package',lambda v:v['edition3'].update(apiVersion=2)),
               ('target-restart/ready',lambda v:v['heldReadiness']['health'].update(schemaVersion=55)),
               ('pristine-prior-restoration/ready',lambda v:v['heldReadiness']['health'].update(schemaVersion=60))]
        for role,change in cases:
            with self.subTest(role=role),self.assertRaises(RuntimeError):
                self.consume(fixture({role:change},schema_migration=True))

    def test_fresh_application_dependency_description_binds_graph_locks_and_exact_linux_abi(self):
        def bind(value, change=lambda description: None):
            description={'format':1,'archiveBytes':64,'archiveSha256':'a'*64,
                'expandedBytes':128,'fileCount':2,
                'packageLockSha256':value['targets']['private']['packageLockSha256'],
                'dependencyGraphSha256':value['dependencyGraphSha256'],
                'platform':'linux','arch':'x64','nodeVersion':'22.23.2','nodeAbi':127}
            change(description);value['applicationDependencies']=description
        actual=self.consume(fixture({'binding':bind},schema_migration=True))
        self.assertEqual(actual['qualificationBinding']['applicationDependencies']['nodeAbi'],127)
        for change in (lambda v:v.update(nodeAbi=True),lambda v:v.update(nodeAbi=137),
                       lambda v:v.update(nodeVersion='24.21.0'),lambda v:v.update(platform='win32'),
                       lambda v:v.update(archiveBytes=512*1024**2+1),
                       lambda v:v.update(packageLockSha256='0'*64),
                       lambda v:v.update(dependencyGraphSha256='0'*64),lambda v:v.update(unreviewed=True)):
            with self.subTest(change=change),self.assertRaises(RuntimeError):
                self.consume(fixture({'binding':lambda v:bind(v,change)},schema_migration=True))
        with self.assertRaises(RuntimeError):
            self.consume(fixture({'binding':bind}))

    def replica_fixture(self, changes=None):
        changes = dict(changes or {})
        review_change = changes.get('review', lambda value: None)
        root = '/mnt/nova-data/qualified-startup-inputs-11111111-1111-4111-8111-111111111111'
        def add_replica_provenance(value):
            # Private producer fields remain opaque to this collector. Its
            # original capture and restoration authorities must still bind.
            value['fixtureStorage'] = {'externalRoot': root, 'anchor': '/mnt/nova-data'}
            value['seedReplicas'] = {'path': root + '/replica-verified.json', 'sha256': '7' * 64}
            review_change(value)
        changes['review'] = add_replica_provenance
        return fixture(changes, fixture_parent=root + '/fixtures')

    def test_external_fixture_provenance_retains_original_capture_and_restoration(self):
        f = self.replica_fixture(); result = self.consume(f)
        review = subject.parse(f['files'][f['roles']['review']['path']])
        self.assertTrue(result['references']['parent']['path'].startswith('/mnt/nova-data/'))
        self.assertTrue(result['references']['restorationCompleted']['path'].startswith('/mnt/nova-data/'))
        self.assertTrue(result['references']['homeCapture/result']['path'].startswith('/opt/nova-release-tools/'))
        self.assertTrue(review['homeSeed']['path'].startswith('/opt/nova-release-tools/'))
        self.assertEqual(review['baseline']['manifest']['path'], '/baseline/manifest.json')
        self.assertEqual([item['scenario'] for item in result['scenarios']], list(subject.SCENARIOS))
        self.assertTrue(result['independentOriginalRestored'])
        self.assertFalse(result['productionAdmission'])

    def test_rehashed_replica_home_cannot_replace_original_capture_role(self):
        replacement = '/mnt/nova-data/replicas/home'
        def replace_home(value): value['homeSeed']['path'] = replacement
        with self.assertRaisesRegex(RuntimeError, 'sealed-home-role-changed'):
            self.consume(self.replica_fixture({'review': replace_home, 'homeCapture/result': replace_home}))

    def test_rehashed_restore_pair_cannot_substitute_replica_authority(self):
        for field in ('sourceManifestSha256', 'sourceHomeInventorySha256'):
            change = lambda value, key=field: value.update({key: '8' * 64})
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'independent-pristine-restoration-required'):
                self.consume(self.replica_fixture({'restorationIntent': change, 'restorationCompleted': change}))

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


class CaptureLifecycleChecks(unittest.TestCase):
    def fixture(self):
        import copy
        path='selected/openclaw-runtime/state/tmp/plugin-captures/11111111-1111-4111-8111-111111111111/owner.sqlite'
        def row(dev,ino,size,stamp,staged=False):
            identity=[dev,ino,0o100600,999,986,1,size,stamp,stamp]
            journal=[dev,ino+1,0o100600,999,986,1,512,stamp,stamp] if staged else None
            return {'parent':[dev,ino+100,0o40700,999,986,3,4096,stamp,stamp],'owner':identity,'journal':journal,
                    'hashes':[subject.CAPTURE_EMPTY,'b'*64] if staged else [subject.CAPTURE_TOKEN,None],
                    'coverage':[{'uid':999,'gid':986,'mode':448,'xattrs':{}},{},'c'*64],'captures':None}
        source=row(1,100,0,1,True)
        plan={'selectedRelative':'selected','baselineRootIdentity':[1,3,16832,0,0],'baselineFamilies':{path:{'':[source['owner'],subject.CAPTURE_EMPTY],
                '-journal':[source['journal'],'b'*64]}}}
        manifest={path:{'kind':'file','mode':384,'uid':999,'gid':986,'size':0,'mtime_ns':1,'xattrs':{},'sha256':subject.CAPTURE_EMPTY},
                  path+'-journal':{'kind':'file','mode':384,'uid':999,'gid':986,'size':512,'mtime_ns':1,'xattrs':{},'sha256':'b'*64},
                  str(subject.PurePosixPath(path).parent):{'kind':'directory',**source['coverage'][0],'mtime_ns':1}}
        self.source_manifest,self.source_plan=manifest,plan
        def seal(before,closed):
            closed['beforeSha256']=subject.capture_receipt_sha(before)
            return {'before':before,'closed':closed,'beforeSha256':closed['beforeSha256'],
                    'closedSha256':subject.capture_receipt_sha(closed)}
        def make(attempt,carry=None,remaining=None):
            window=[100*attempt,100*attempt+10]
            common={'format':1,'jobId':'lease'+str(attempt),'candidateId':'prior' if attempt==3 else 'target',
                    'attempt':attempt,'epoch':'fixture epoch','physicalRoots':[[1,3,16832,0,0],[2,4,16832,999,986]]}
            after=row(2,20 if attempt==3 else 10,4096,(window[0]+2)*10**9)
            live=row(2,20 if attempt==3 else 10,0,window[0]*10**9,True)
            done={'source':source,'after':after,'firstWindow':window}
            if carry is not None:
                live=copy.deepcopy(carry['after'])
                done={'source':source,'after':copy.deepcopy(live) if remaining else None,'firstWindow':carry['firstWindow'],
                      'lastWindow':window,'remaining':remaining,'sourceAdmissionsSha256':'d'*64}
                if remaining:done['after']['coverage'][2]='e'*64
            pre={**common,'observedAtNs':window[0]*10**9,'roles':{path:{'source':source,'liveBefore':live,'carry':carry}}}
            return seal(pre,{**common,'closedWindow':window,'retired':{path:done}})
        def verify(item,i,first=None,reaping=True):
            return subject.capture_retirement_summary(item,plan,'lease'+str(i),'prior' if i==3 else 'target',
                'fixture epoch',i,[i*100,i*100+10],first['roles'] if first else None,reaping,manifest)
        first=make(1);summary=verify(first,1)
        return path,first,summary,make,verify,seal

    def test_reaped_and_partial_restart_bind_the_true_first_proof(self):
        path,first,summary,make,verify,_=self.fixture()
        for remaining in ([],['admission-Alpha1']):
            second=make(2,first['closed']['retired'][path],remaining)
            role=verify(second,2,summary)['roles'][0]
            self.assertEqual(role['predecessorProofSha256'],summary['roles'][0]['proofSha256'])
            self.assertEqual(role['remainingCount'],len(remaining))
            self.assertEqual(role['physicalOwner'],None if not remaining else ['2','10'])
            self.assertEqual(role['reaped'],not remaining)
            self.assertEqual(role['lastWindow'],[200,210])
        third=verify(make(3),3,summary)['roles'][0]
        self.assertEqual(third['state'],'retired')
        self.assertNotEqual(third['physicalOwner'],summary['roles'][0]['physicalOwner'])

    def test_rehashed_invalid_lifecycle_histories_are_refused(self):
        import copy
        path,first,summary,make,verify,seal=self.fixture()
        base=make(2,first['closed']['retired'][path],[])
        for fault in ('missing-carry','changed-carry','changed-before','window','first-window','unknown-field',
                      'duplicate-members','unordered-members','bad-member','nonempty-absent','owner-present',
                      'missing-source-hash','wrong-source','wrong-root'):
            item=copy.deepcopy(base);row=item['before']['roles'][path];done=item['closed']['retired'][path]
            if fault=='missing-carry':row['carry']=None
            elif fault=='changed-carry':row['carry']['firstWindow']=[100,109]
            elif fault=='changed-before':row['liveBefore']['owner'][1]=999
            elif fault=='window':done['lastWindow']=[100,110]
            elif fault=='first-window':done['firstWindow']=[101,110]
            elif fault=='unknown-field':done['waiver']=True
            elif fault=='duplicate-members':done['remaining']=['admission-Alpha1']*2
            elif fault=='unordered-members':done['remaining']=['admission-Zebra1','admission-Alpha1']
            elif fault=='bad-member':done['remaining']=['../saved']
            elif fault=='nonempty-absent':done['remaining']=['admission-Alpha1']
            elif fault=='owner-present':done['after']=copy.deepcopy(row['liveBefore'])
            elif fault=='missing-source-hash':done['sourceAdmissionsSha256']=None
            elif fault=='wrong-source':done['source']['hashes'][1]='f'*64
            elif fault=='wrong-root':
                item['closed']['physicalRoots']=copy.deepcopy(item['closed']['physicalRoots'])
                item['closed']['physicalRoots'][1][1]=55
            item=seal(item['before'],item['closed'])
            with self.subTest(fault=fault),self.assertRaises(RuntimeError):verify(item,2,summary)

    def test_legacy_profile_rejects_reaping_shape(self):
        path,first,summary,make,verify,_=self.fixture()
        item=make(2,first['closed']['retired'][path],[])
        with self.assertRaises((RuntimeError,TypeError)):verify(item,2,summary,False)

    def test_original_manifest_member_and_root_denials(self):
        import copy
        path,first,summary,make,verify,_=self.fixture()
        for fault in ('missing-manifest','missing-journal','mode','owner','bytes','hash','mtime','xattrs','parent','root'):
            manifest=copy.deepcopy(self.source_manifest);plan=copy.deepcopy(self.source_plan)
            if fault=='missing-manifest':manifest=None
            elif fault=='missing-journal':del manifest[path+'-journal']
            elif fault=='mode':manifest[path]['mode']=420
            elif fault=='owner':manifest[path]['uid']=998
            elif fault=='bytes':manifest[path+'-journal']['size']=513
            elif fault=='hash':manifest[path+'-journal']['sha256']='e'*64
            elif fault=='mtime':manifest[path]['mtime_ns']=2
            elif fault=='xattrs':manifest[path]['xattrs']={'user.saved':'eA=='}
            elif fault=='parent':manifest[str(subject.PurePosixPath(path).parent)]['mode']=493
            elif fault=='root':plan['baselineRootIdentity'][1]+=1
            with self.subTest(fault=fault),self.assertRaises(RuntimeError):
                subject.capture_retirement_summary(first,plan,'lease1','target','fixture epoch',1,[100,110],None,True,manifest)



if __name__ == '__main__': unittest.main(verbosity=2)
