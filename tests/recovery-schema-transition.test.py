"""Synthetic phase/lineage refusals; no hosted qualification or native calls."""
import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/update-runner'))
import recovery as r
import hosted_retained_configuration as hosted

# The tested methods are pure admission/comparison methods. Windows has no
# fcntl; no lock or host action is exercised by this portable test module.
if os.name == 'nt':
    with patch.dict(sys.modules, {'fcntl': types.ModuleType('fcntl')}):
        import install
else:
    import install

SPEC = {'format': 1, 'kind': 'schema-55-to-60-same-runtime', 'fromSchemaVersion': 55,
        'toSchemaVersion': 60, 'apiVersion': 1, 'fromAgentVersion': '2026.9.8', 'toAgentVersion': '2026.9.8'}
EPOCH = 'a28e1d43-16dd-44b6-ac06-24e9d503b946'


@contextlib.contextmanager
def connection(path):
    with contextlib.closing(sqlite3.connect(path)) as db:
        with db:
            yield db


class SchemaTransitionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nova-schema-transition-', dir=os.getenv('NOVA_TEST_TEMP'))
        self.root = Path(self.temporary.name).resolve()
        self.before, self.after, self.scratch = (self.root / name for name in ('before', 'after', 'scratch'))
        for path in (self.before, self.after, self.scratch):
            path.mkdir()
        self.scratch_token = r._VERIFICATION_SCRATCH.set(self.scratch)

    def tearDown(self):
        r._VERIFICATION_SCRATCH.reset(self.scratch_token)
        self.temporary.cleanup()

    def database(self, root, schema, relative='workspace.sqlite'):
        file = root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        (file.parent / 'edition3.identity').write_bytes(b'private.novadream.edition3.preview\n')
        with connection(file) as db:
            db.executescript('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);'
                'CREATE TABLE service_records(id TEXT PRIMARY KEY,revision INTEGER,payload BLOB);')
            db.execute('INSERT INTO meta VALUES(?,?)', ('epoch', EPOCH))
            db.execute('INSERT INTO service_records VALUES(?,?,?)', ('account:retained', 1, b'unchanged-authenticated-ciphertext'))
            for name in ('entities', 'history', 'blobs', 'blob_refs', 'receipts'):
                db.execute('CREATE TABLE ' + name + '(id TEXT PRIMARY KEY,payload BLOB)')
                db.execute('INSERT INTO ' + name + ' VALUES(?,?)', ('retained', b'exact saved bytes'))
            db.execute('PRAGMA user_version=' + str(schema))
        return file

    def prepare(self, before=55, after=60):
        self.database(self.before, before)
        self.database(self.after, after)

    def compare(self, restored=False):
        with r.hosted_application_transition(SPEC, self.before, self.after, restored=restored):
            return r.saved_state(self.before, self.after, restored=restored)

    def test_only_selected_schema_changes_and_old_same_schema_is_unchanged(self):
        self.prepare()
        for root in (self.before, self.after):
            self.database(root, 53, 'archive/workspace.sqlite')
        self.assertEqual(self.compare(), [{'beforeSchema': 53, 'afterSchema': 53}, {'beforeSchema': 55, 'afterSchema': 60}])
        with self.assertRaisesRegex(RuntimeError, 'unqualified saved database schema'):
            r.saved_state(self.before, self.after)
        with connection(self.after / 'workspace.sqlite') as db:
            db.execute('PRAGMA user_version=55')
        self.assertEqual(self.compare(restored=True)[-1], {'beforeSchema': 55, 'afterSchema': 55})
        self.assertEqual(r.saved_state(self.before, self.after)[-1], {'beforeSchema': 55, 'afterSchema': 55})

    def test_migrated_target_is_never_a_pristine_rollback(self):
        self.prepare()
        with self.assertRaisesRegex(RuntimeError, 'selected workspace schema'):
            self.compare(restored=True)

    def test_each_saved_family_and_account_record_remains_exact(self):
        self.prepare()
        for table in ('entities', 'history', 'blobs', 'blob_refs', 'receipts', 'service_records'):
            with self.subTest(table=table):
                with connection(self.after / 'workspace.sqlite') as db:
                    old = db.execute('SELECT payload FROM ' + table).fetchone()[0]
                    db.execute('UPDATE ' + table + ' SET payload=?', (b'changed',))
                with self.assertRaises(RuntimeError):
                    self.compare()
                with connection(self.after / 'workspace.sqlite') as db:
                    db.execute('UPDATE ' + table + ' SET payload=?', (old,))

    def test_unselected_schema_sql_definition_and_epoch_changes_refuse(self):
        self.prepare()
        for root in (self.before, self.after):
            self.database(root, 55, 'archive/workspace.sqlite')
        with connection(self.after / 'archive/workspace.sqlite') as db:
            db.execute('PRAGMA user_version=60')
        with self.assertRaisesRegex(RuntimeError, 'unqualified saved database schema'):
            self.compare()
        with connection(self.after / 'archive/workspace.sqlite') as db:
            db.execute('PRAGMA user_version=55')
        with connection(self.after / 'workspace.sqlite') as db:
            db.execute('CREATE TABLE unexpected(value TEXT)')
        with self.assertRaisesRegex(RuntimeError, 'SQL definitions'):
            self.compare()
        with connection(self.after / 'workspace.sqlite') as db:
            db.execute('DROP TABLE unexpected')
            db.execute("UPDATE meta SET value='e291cad0-1547-4f0d-93b8-6eaafc44f363' WHERE key='epoch'")
        with self.assertRaisesRegex(RuntimeError, 'authenticated acceptance'):
            self.compare()

    def test_phase_scope_is_detached_non_nested_and_restored_after_failure(self):
        self.prepare()
        with r.hosted_application_transition(SPEC, self.before, self.after):
            observed = r.current_application_transition()
            observed['transition']['toSchemaVersion'] = 61
            self.assertEqual(r.current_application_transition()['transition'], SPEC)
            self.assertEqual((r.application_schema(self.before), r.application_schema(self.after)), (55, 60))
            with self.assertRaises(RuntimeError):
                r.application_schema(self.root)
            with self.assertRaises(RuntimeError):
                with r.hosted_application_transition(SPEC, self.before, self.after):
                    pass
            with self.assertRaisesRegex(RuntimeError, 'bound phase'):
                r.saved_state(self.before, self.after, restored=True)
        self.assertIsNone(r.current_application_transition())
        for changed in ({**SPEC, 'toSchemaVersion': 61}, {**SPEC, 'format': True}, {**SPEC, 'waiver': True}):
            with self.assertRaises(RuntimeError):
                with r.hosted_application_transition(changed, self.before, self.after):
                    pass

    def test_existing_local_schema60_equality_is_not_broadened(self):
        self.prepare(60, 60)
        local = types.SimpleNamespace(image_path=lambda path: Path(path),
            glob=lambda root, pattern: Path(root).rglob(pattern))
        token = r._LOCAL_WINDOWS.set(local)
        try:
            self.assertEqual(r.saved_state(self.before, self.after), [{'beforeSchema': 60, 'afterSchema': 60}])
            with connection(self.after / 'workspace.sqlite') as db:
                db.execute('PRAGMA user_version=61')
            with self.assertRaises(RuntimeError):
                r.saved_state(self.before, self.after)
        finally:
            r._LOCAL_WINDOWS.reset(token)


class QualificationBindingTests(unittest.TestCase):
    def fixture(self):
        helpers = {'install.py': 'c' * 64, 'recovery.py': 'd' * 64}
        binding = {'format': 1, 'kind': 'same-runtime-startup-candidate-binding',
            'applicationTransition': dict(SPEC), 'workspaceEpoch': EPOCH,
            'prior': {'candidateId': 'a' * 64}, 'targets': {'private': {'candidateId': 'b' * 64, 'packageLockSha256': '7' * 64},
                'public': {'candidateId': '6' * 64, 'packageLockSha256': '7' * 64}},
            'dependencyGraphSha256': '8' * 64,
            'runtime': {'agentVersion': '2026.9.8'}, 'helpers': helpers}
        pair = {'applicationTransition': dict(SPEC), 'startupQualification': {'binding': binding,
            'projection': {'path': 'startup-qualification.json', 'sha256': 'e' * 64}},
            'applicationDependencies': {'dependencyGraphSha256': '8' * 64, 'packageLockSha256': '7' * 64}}
        proof = {'format': 1, 'kind': 'actual-retained-startup-qualification-observation',
            'scope': 'retained-same-runtime-startup-restart-restoration', 'readOnly': True,
            'hostEffects': False, 'productionAdmission': False, 'qualificationBinding': copy.deepcopy(binding),
            'scenarios': [], 'references': {}}
        for key in ('actualSettledQualification', 'independentOriginalRestored',
            'completeMaintainedSavedAndNativeState', 'heldBootstrapVerified', 'workerClosed',
            'freshFullRehearsalStillRequired', 'liveAcceptanceStillRequired'):
            proof[key] = True
        for index, name in enumerate(('target-first-start', 'target-restart', 'pristine-prior-restoration')):
            ref = {'path': '/synthetic-fixture/attempt-' + str(index + 1) + '/preservation.json', 'sha256': 'f' * 64}
            proof['scenarios'].append({'scenario': name, 'candidateId': ('a' if index == 2 else 'b') * 64,
                'startedAtSeconds': 100 + index * 20, 'closedAtSeconds': 110 + index * 20, 'preservation': ref})
            proof['references'][name + '/preservation'] = {**ref, 'bytes': 123}
        return pair, proof, helpers

    def validate(self, pair, proof, helpers):
        return r.validate_application_qualification(pair, proof, prior_id='a' * 64,
            target_id='b' * 64, workspace_epoch=EPOCH, helper_hashes=helpers)

    def test_collector_projection_two_field_and_sized_refs_match(self):
        pair, proof, helpers = self.fixture()
        self.assertEqual(self.validate(pair, proof, helpers), SPEC)
        for scenario in proof['scenarios']:
            scenario['preservation']['bytes'] = 123
        self.assertEqual(self.validate(pair, proof, helpers), SPEC)

    def test_missing_closure_restoration_or_original_binding_refuses(self):
        pair, proof, helpers = self.fixture()
        for key in ('actualSettledQualification', 'independentOriginalRestored', 'workerClosed',
                    'completeMaintainedSavedAndNativeState', 'heldBootstrapVerified'):
            changed = copy.deepcopy(proof)
            changed[key] = False
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate(pair, changed, helpers)
        for key in ('workspaceEpoch', 'prior', 'targets', 'helpers', 'applicationTransition'):
            changed = copy.deepcopy(proof)
            changed['qualificationBinding'][key] = None
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.validate(pair, changed, helpers)

    def test_wrong_order_candidate_reference_and_unbundled_proof_refuse(self):
        pair, proof, helpers = self.fixture()
        changes = [lambda v: v['scenarios'].reverse(),
            lambda v: v['scenarios'][2].update(candidateId='b' * 64),
            lambda v: v['references']['target-restart/preservation'].update(sha256='0' * 64),
            lambda v: v['scenarios'][1].update(startedAtSeconds=99)]
        for change in changes:
            changed = copy.deepcopy(proof)
            change(changed)
            with self.assertRaises(RuntimeError):
                self.validate(pair, changed, helpers)
        pair['startupQualification']['projection']['path'] = '/unrelated/proof.json'
        with self.assertRaises(RuntimeError):
            self.validate(pair, proof, helpers)

    def test_dependency_graph_lock_and_current_full_description_remain_bound(self):
        pair, proof, helpers = self.fixture()
        for key in ('dependencyGraphSha256', 'packageLockSha256'):
            changed = copy.deepcopy(pair)
            changed['applicationDependencies'][key] = '9' * 64
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'dependencies differ'):
                self.validate(changed, proof, helpers)
        pair['startupQualification']['binding']['applicationDependencies'] = copy.deepcopy(pair['applicationDependencies'])
        proof['qualificationBinding']['applicationDependencies'] = copy.deepcopy(pair['applicationDependencies'])
        self.assertEqual(self.validate(pair, proof, helpers), SPEC)
        pair['applicationDependencies']['archiveSha256'] = '4' * 64
        with self.assertRaisesRegex(RuntimeError, 'dependencies differ'):
            self.validate(pair, proof, helpers)

    def test_real_driver_reads_only_fixed_proof_and_hash_bound_complete_helpers(self):
        pair, proof, _ = self.fixture()
        with tempfile.TemporaryDirectory(prefix='nova-schema-driver-', dir=os.getenv('NOVA_TEST_TEMP')) as temporary:
            root = Path(temporary)
            names = sorted(r.APPLICATION_TRANSITION_HELPERS)
            for name in names:
                (root / name).write_bytes(('synthetic helper: ' + name).encode())
            helpers = {name: r.digest(root / name) for name in names}
            node = root / 'node'
            node.write_bytes(b'synthetic platform executable')
            runtime = {'agent': str(root / 'agent'), 'agentNode': str(node),
                'agentNodeSha256': r.digest(node), 'agentVersion': '2026.9.8',
                'node': str(node), 'nodeSha256': r.digest(node), 'root': str(root)}
            pair['startupQualification']['binding']['helpers'] = helpers
            proof['qualificationBinding']['helpers'] = helpers
            pair['startupQualification']['binding']['runtime'] = runtime
            proof['qualificationBinding']['runtime'] = runtime
            raw = json.dumps(proof).encode()
            (root / 'startup-qualification.json').write_bytes(raw)
            pair['startupQualification']['projection']['sha256'] = hashlib.sha256(raw).hexdigest()
            driver = install.Driver(root / 'request.json')
            driver.bundle, driver.pair = root, pair
            driver.node = driver.prior_agent_node = node
            driver.runtime_root, driver.prior_agent = root, root / 'agent'
            driver.from_schema, driver.to_schema = 55, 60
            driver.from_engine = driver.to_engine = '2026.9.8'
            driver.prior_id, driver.target_id = 'a' * 64, 'b' * 64
            driver.expected_prior = {'candidateId': driver.prior_id, 'workspaceEpoch': EPOCH}
            # Native root ownership is qualified only by the real Linux route.
            with patch.object(install, 'protected', lambda path, **kwargs: path):
                driver.verify_application_qualification()
                self.assertEqual(driver.application_transition, SPEC)
                self.assertEqual((driver.schema_for(driver.prior_id), driver.schema_for(driver.target_id)), (55, 60))
                with self.assertRaises(RuntimeError):
                    driver.schema_for('f' * 64)
                node.write_bytes(b'another platform executable')
                with self.assertRaisesRegex(RuntimeError, 'runtime or platform binary'):
                    driver.verify_application_qualification()
                self.assertIsNone(driver.application_transition)
                node.write_bytes(b'synthetic platform executable')
                (root / 'recovery.py').write_bytes(b'changed helper')
                with self.assertRaisesRegex(RuntimeError, 'helper changed'):
                    driver.verify_application_qualification()
                self.assertIsNone(driver.application_transition)
                self.assertFalse((root / 'driver-attempt.json').exists())


class HostedConfigurationInputsTests(unittest.TestCase):
    def test_closed_authority_needs_original_candidate_epoch_hash_and_window(self):
        refs = {name: {'path': name, 'bytes': 10, 'sha256': name} for name in ('started', 'ready', 'closed')}
        authority = {'format': 1, 'kind': 'hosted-closed-configuration-authority',
            'candidateId': 'a' * 64, 'workspaceEpoch': EPOCH, **refs,
            'dependencyRoot': '/synthetic', 'dependencyFiles': {}, 'nodeSha256': 'b' * 64}
        documents = {'started': {'candidateId': 'a' * 64, 'epoch': EPOCH, 'startedAtSeconds': 100},
            'ready': {'candidateId': 'a' * 64, 'epoch': EPOCH, 'startedSha256': 'started', 'readyAtSeconds': 101},
            'closed': {'readySha256': 'ready', 'owningServiceFullyStopped': True, 'closedAtSeconds': 102}}
        with patch.object(hosted, 'document', lambda ref: documents[ref['path']]):
            hosted.closed_authority(authority, candidate_id='a' * 64, epoch=EPOCH, window=(100, 102))
            for name, key, value in (('closed', 'owningServiceFullyStopped', False),
                ('closed', 'readySha256', 'different'), ('ready', 'candidateId', 'c' * 64),
                ('ready', 'epoch', 'other'), ('started', 'startedAtSeconds', 99)):
                previous = documents[name][key]
                documents[name][key] = value
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    hosted.closed_authority(authority, candidate_id='a' * 64, epoch=EPOCH, window=(100, 102))
                documents[name][key] = previous

    def test_complete_compiled_and_zod_closure_rejects_missing_or_changed_transitive_file(self):
        with tempfile.TemporaryDirectory(prefix='nova-hosted-closure-', dir=os.getenv('NOVA_TEST_TEMP')) as temporary:
            release = Path(temporary).resolve()
            service = release / 'dist/service'
            dependency = release / 'node_modules'
            service.mkdir(parents=True)
            (dependency / 'zod/sub').mkdir(parents=True)
            (service / 'entry.js').write_bytes(b'export const value=1;')
            (dependency / 'zod/sub/imported.js').write_bytes(b'export const value=2;')
            manifest = {'artifacts': [{'path': 'dist/service/entry.js', 'sha256': r.digest(service / 'entry.js')}]}
            deps = {'zod/sub/imported.js': {'size': (dependency / 'zod/sub/imported.js').stat().st_size,
                                         'sha256': r.digest(dependency / 'zod/sub/imported.js')}}
            self.assertEqual(len(hosted.attest_builder_closure(release, manifest, dependency, deps)), 2)
            (service / 'unlisted.js').write_bytes(b'unlisted')
            with self.assertRaisesRegex(RuntimeError, 'closure changed'):
                hosted.attest_builder_closure(release, manifest, dependency, deps)
            (service / 'unlisted.js').unlink()
            (dependency / 'zod/sub/imported.js').write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'closure changed'):
                hosted.attest_builder_closure(release, manifest, dependency, deps)



class HostedRuntimeEntryTests(unittest.TestCase):
    """Exercise actual filenames, published-byte checks and two spellings."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='nova-entry-', dir=os.getenv('NOVA_TEST_TEMP'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve() / 'runtime'
        self.physical = self.root / 'managed-updates' / 'openclaw-package'
        self.physical.mkdir(parents=True)
        self.selector = self.root / 'openclaw'
        self.host = self.root.parent / 'config.json'
        self.metadata = self.physical / 'package.json'
        self.entry = self.physical / 'openclaw.mjs'
        self.metadata.write_text(json.dumps({'name': 'openclaw', 'version': '2026.9.8'}))
        self.entry.write_text('fixture entry')
        self.pins = {p.name: (p.stat().st_size, hashlib.sha256(p.read_bytes()).hexdigest())
                     for p in (self.entry, self.metadata)}
        stack = self.enterContext(contextlib.ExitStack())
        stack.enter_context(patch.dict(sys.modules, {'install': install}))
        stack.enter_context(patch.object(hosted, '_RUNTIME_ROOT', self.root))
        stack.enter_context(patch.object(hosted, '_HOSTED_CONFIG', self.host))
        stack.enter_context(patch.object(hosted, '_OPENCLAW_FILES', self.pins))
        # The Linux host qualification owns UID0 checks. Use same-volume real
        # files in this portable test, including a real directory selector.
        stack.enter_context(patch.object(install, 'protected', lambda p, directory=False: self.assertEqual(p.resolve(strict=True), p)))
        stack.enter_context(patch.object(install, 'protected_selector',
                                       lambda p, root, directory: p.resolve(strict=True)))
        if os.name == 'nt':
            # Windows may report different change times for fstat and lstat on
            # the same file. These Linux-only service checks use the real ctime
            # in Linux; keep the other eight identity fields in portable tests.
            identity = hosted._authority_identity
            stack.enter_context(patch.object(hosted, '_authority_identity', lambda info: identity(info)[:-1]))
        if not hasattr(os, 'O_NOFOLLOW'):
            stack.enter_context(patch.object(os, 'O_NOFOLLOW', 0, create=True))
        self.alias(self.selector)

    def alias(self, path):
        if os.name == 'nt':
            import _winapi
            _winapi.CreateJunction(str(self.physical), str(path))
        else:
            path.symlink_to(self.physical, target_is_directory=True)

    def configured(self, path):
        self.host.write_text(json.dumps({'runtimeDirectory': str(self.root), 'agentDirectory': str(path)}))
        return str(path / 'openclaw.mjs')

    @staticmethod
    def before(name):
        return {'plugins': {'entries': {'edition3-accounts': {'config': {'runtimeEntry': name}}}}}

    def test_canonical_spelling_preserved_and_same_file(self):
        name = self.configured(self.selector)
        self.assertTrue(Path(name).samefile(self.entry))
        observed = hosted.retained_runtime_entry(self.before(name), self.physical)
        self.assertEqual(observed[0], name)
        self.assertEqual(observed, hosted.retained_runtime_entry(self.before(name), self.physical))

    def test_physical_and_truly_absent_account_supported(self):
        name = self.configured(self.physical)
        for before in (self.before(name), {'plugins': {'entries': {'openai': {}, 'codex': {}}}}):
            self.assertEqual(hosted.retained_runtime_entry(before, self.physical)[0], name)

    def test_different_alias_to_identical_inode_refused(self):
        other = self.root / 'different'
        self.alias(other)
        name = self.configured(other)
        self.assertTrue(Path(name).samefile(self.entry))
        with self.assertRaisesRegex(RuntimeError, 'configured runtime selector'):
            hosted.retained_runtime_entry(self.before(name), self.physical)

    def test_missing_or_wrong_retained_entry_refused(self):
        name = self.configured(self.selector)
        for before in ({}, self.before(str(self.entry)), self.before(name + '-different'),
                       {'plugins': {'entries': {'edition3-accounts': None}}}):
            with self.subTest(before=before), self.assertRaises(RuntimeError):
                hosted.retained_runtime_entry(before, self.physical)
        self.configured(self.physical)
        for row in (None, {}, {'config': {}}, {'config': {'runtimeEntry': name}}):
            with self.subTest(row=row), self.assertRaises(RuntimeError):
                hosted.retained_runtime_entry({'plugins': {'entries': {'edition3-accounts': row}}}, self.physical)

    def test_changed_entry_and_wrong_package_version_refused(self):
        name = self.configured(self.selector)
        self.entry.write_text('changed entry')
        with self.assertRaises(RuntimeError):
            hosted.retained_runtime_entry(self.before(name), self.physical)
        self.entry.write_text('fixture entry')
        self.metadata.write_text(json.dumps({'name': 'openclaw', 'version': '2026.9.7'}))
        self.pins['package.json'] = (self.metadata.stat().st_size, hashlib.sha256(self.metadata.read_bytes()).hexdigest())
        with self.assertRaisesRegex(RuntimeError, 'package or runtime version'):
            hosted.retained_runtime_entry(self.before(name), self.physical)

    def test_changed_host_authority_changes_the_postcheck(self):
        name = self.configured(self.selector)
        first = hosted.retained_runtime_entry(self.before(name), self.physical)
        self.host.write_text(self.host.read_text() + ' ')
        self.assertNotEqual(first, hosted.retained_runtime_entry(self.before(name), self.physical))


if __name__ == '__main__':
    unittest.main()
