"""Same-schema60 scope/lineage contracts; synthetic saved data, no host/native actions."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

SOURCE = Path(__file__).with_name('recovery-schema-transition.test.py')
spec = importlib.util.spec_from_file_location('legacy_schema_transition_test_support', SOURCE)
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
r = legacy.r
EXPECTED_RECOVERY = Path(__file__).resolve().parents[1] / 'deploy' / 'update-runner' / 'recovery.py'
assert Path(r.__file__).resolve() == EXPECTED_RECOVERY, 'Focused test imported a different recovery module.'
SPEC = {'format': 1, 'kind': 'schema-60-same-runtime', 'schemaVersion': 60,
        'apiVersion': 1, 'agentVersion': '2026.9.8'}


class SameSchemaTests(legacy.SchemaTransitionTests):
    # Reuse the existing private SQLite fixture, not its migration cases.
    def compare(self, restored=False):
        with r.hosted_same_schema_qualification(SPEC, self.before, self.after, restored=restored):
            return r.saved_state(self.before, self.after, restored=restored)

    def test_schema60_selected_saved_state_and_pristine_restoration(self):
        self.prepare(60, 60)
        self.assertEqual(self.compare(), [{'beforeSchema': 60, 'afterSchema': 60}])
        self.assertEqual(self.compare(True), [{'beforeSchema': 60, 'afterSchema': 60}])
        with self.assertRaisesRegex(RuntimeError, 'unqualified saved database schema'):
            r.saved_state(self.before, self.after)
        self.assertEqual(r.application_schema(self.before), 55)

    def test_scope_is_detached_exact_and_resets_on_exception(self):
        self.prepare(60, 60)
        with self.assertRaisesRegex(ValueError, 'owned-test-error'):
            with r.hosted_same_schema_qualification(SPEC, self.before, self.after):
                observed = r.current_same_schema_qualification()
                observed['sameSchemaQualification']['schemaVersion'] = 61
                self.assertEqual(r.current_same_schema_qualification()['sameSchemaQualification'], SPEC)
                self.assertEqual((r.application_schema(self.before), r.application_schema(self.after)), (60, 60))
                self.assertIsNone(r.current_application_transition())
                with self.assertRaises(RuntimeError):
                    r.application_schema(self.root)
                with self.assertRaises(RuntimeError):
                    with r.hosted_application_transition(legacy.SPEC, self.before, self.after):
                        pass
                with self.assertRaises(RuntimeError):
                    with r.hosted_same_schema_qualification(SPEC, self.before, self.after):
                        pass
                with self.assertRaisesRegex(RuntimeError, 'bound phase'):
                    r.saved_state(self.before, self.after, restored=True)
                raise ValueError('owned-test-error')
        self.assertIsNone(r.current_same_schema_qualification())
        with r.hosted_application_transition(legacy.SPEC, self.before, self.after):
            with self.assertRaises(RuntimeError):
                with r.hosted_same_schema_qualification(SPEC, self.before, self.after):
                    pass

    def test_saved_accounts_history_and_unselected_databases_remain_exact(self):
        self.prepare(60, 60)
        for table in ('entities', 'history', 'blobs', 'blob_refs', 'receipts', 'service_records'):
            with self.subTest(table=table):
                with legacy.connection(self.after / 'workspace.sqlite') as db:
                    old = db.execute('SELECT payload FROM ' + table).fetchone()[0]
                    db.execute('UPDATE ' + table + ' SET payload=?', (b'changed',))
                with self.assertRaises(RuntimeError):
                    self.compare()
                with legacy.connection(self.after / 'workspace.sqlite') as db:
                    db.execute('UPDATE ' + table + ' SET payload=?', (old,))
        for root in (self.before, self.after):
            self.database(root, 55, 'archive/workspace.sqlite')
        with legacy.connection(self.after / 'archive/workspace.sqlite') as db:
            db.execute('PRAGMA user_version=60')
        with self.assertRaisesRegex(RuntimeError, 'unqualified saved database schema'):
            self.compare()

    def test_marker_is_exact_nonmigration_and_local_scope_cannot_mix(self):
        for changed in ({**SPEC, 'schemaVersion': 55}, {**SPEC, 'format': True},
                        {**SPEC, 'agentVersion': '2026.9.9'}, {**SPEC, 'waiver': True}, legacy.SPEC):
            with self.assertRaises(RuntimeError):
                r.validate_same_schema_qualification(changed)
        token = r._LOCAL_WINDOWS.set(object())
        try:
            with self.assertRaises(RuntimeError):
                with r.hosted_same_schema_qualification(SPEC, self.before, self.after):
                    pass
        finally:
            r._LOCAL_WINDOWS.reset(token)


# Explicit suite avoids inheriting/rerunning the unchanged legacy migration tests.
SAME_CASES = ('test_schema60_selected_saved_state_and_pristine_restoration',
              'test_scope_is_detached_exact_and_resets_on_exception',
              'test_saved_accounts_history_and_unselected_databases_remain_exact',
              'test_marker_is_exact_nonmigration_and_local_scope_cannot_mix')


class SameSchemaQualificationTests(unittest.TestCase):
    def fixture(self):
        pair, proof, helpers = legacy.QualificationBindingTests().fixture()
        del pair['applicationTransition']
        pair['sameSchemaQualification'] = dict(SPEC)
        binding = pair['startupQualification']['binding']
        del binding['applicationTransition']
        binding['sameSchemaQualification'] = dict(SPEC)
        proof['qualificationBinding'] = copy.deepcopy(binding)
        return pair, proof, helpers

    def validate(self, pair, proof, helpers):
        return r.validate_same_schema_application_qualification(pair, proof,
            prior_id='a' * 64, target_id='b' * 64, workspace_epoch=legacy.EPOCH, helper_hashes=helpers)

    def test_complete_projection_required_and_marker_alone_is_insufficient(self):
        pair, proof, helpers = self.fixture()
        self.assertEqual(self.validate(pair, proof, helpers), SPEC)
        for flag in ('actualSettledQualification', 'independentOriginalRestored',
                     'completeMaintainedSavedAndNativeState', 'heldBootstrapVerified', 'workerClosed'):
            changed = copy.deepcopy(proof); changed[flag] = False
            with self.assertRaises(RuntimeError):
                self.validate(pair, changed, helpers)
        with self.assertRaises(RuntimeError):
            self.validate({'sameSchemaQualification': SPEC}, {}, helpers)

    def test_migration_mixing_wrong_helpers_and_missing_restoration_refuse(self):
        pair, proof, helpers = self.fixture()
        mixed = copy.deepcopy(pair); mixed['applicationTransition'] = legacy.SPEC
        with self.assertRaises(RuntimeError):
            self.validate(mixed, proof, helpers)
        with self.assertRaises(RuntimeError):
            r.validate_application_qualification(pair, proof, prior_id='a' * 64,
                target_id='b' * 64, workspace_epoch=legacy.EPOCH, helper_hashes=helpers)
        with self.assertRaises(RuntimeError):
            self.validate(pair, proof, {**helpers, 'recovery.py': '9' * 64})
        missing = copy.deepcopy(proof); missing['scenarios'].pop()
        with self.assertRaises(RuntimeError):
            self.validate(pair, missing, helpers)


class SameSchemaDriverTests(unittest.TestCase):
    def fixture(self):
        return legacy.QualificationBindingTests()

    def convert(self, support, driver, proof):
        driver.from_schema = driver.to_schema = 60
        del driver.pair['applicationTransition']
        driver.pair['sameSchemaQualification'] = dict(SPEC)
        for binding in (driver.pair['startupQualification']['binding'], proof['qualificationBinding']):
            del binding['applicationTransition']; binding['sameSchemaQualification'] = dict(SPEC)
        support.write_driver_proof(driver, proof)

    def test_actual_driver_admits_exact60_and_invalidates_on_helper_change(self):
        support = self.fixture()
        with support.driver_fixture() as (driver, proof, _):
            self.convert(support, driver, proof)
            driver.verify_application_qualification()
            self.assertEqual(driver.same_schema_qualification, SPEC)
            self.assertIsNone(driver.application_transition)
            self.assertEqual((driver.schema_for(driver.prior_id), driver.schema_for(driver.target_id)), (60, 60))
            (driver.bundle / 'recovery.py').write_bytes(b'changed helper')
            with self.assertRaisesRegex(RuntimeError, 'helper changed'):
                driver.verify_application_qualification()
            self.assertIsNone(driver.same_schema_qualification)
            self.assertFalse((driver.bundle / 'driver-attempt.json').exists())

    def test_actual_driver_refuses_marker_mixing_and_missing_restoration(self):
        support = self.fixture()
        with support.driver_fixture() as (driver, proof, _):
            self.convert(support, driver, proof)
            driver.pair['applicationTransition'] = dict(legacy.SPEC)
            with self.assertRaisesRegex(RuntimeError, 'Mixed'):
                driver.verify_application_qualification()
            del driver.pair['applicationTransition']
            proof['independentOriginalRestored'] = False
            support.write_driver_proof(driver, proof)
            with self.assertRaisesRegex(RuntimeError, 'complete settled'):
                driver.verify_application_qualification()
            self.assertIsNone(driver.same_schema_qualification)

    def test_capture_observer_receives_exact_same_schema_scope_and_resets(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve(); snapshot=root/'snapshot'; snapshot.mkdir(); (snapshot/'workspace').mkdir(); live=root/'live';live.mkdir()
            for workspace in (snapshot/'workspace',live):
                (workspace/'edition3.identity').write_bytes(b'private.novadream.edition3.preview\n')
                with legacy.connection(workspace/'workspace.sqlite') as db:
                    db.execute('PRAGMA user_version=60');db.execute('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');db.execute('INSERT INTO meta VALUES(?,?)',('epoch',legacy.EPOCH))
            driver=legacy.install.Driver.__new__(legacy.install.Driver)
            driver.recovery=snapshot;driver.data=live;driver.from_engine=driver.active_engine='2026.9.8'
            driver.from_schema=driver.to_schema=60;driver.target_id='b'*64;driver.prior_id='a'*64
            driver.same_schema_qualification=dict(SPEC);driver.application_transition=None
            driver.before={'epoch':legacy.EPOCH};driver.prior_agent=root;driver.job_id='qualified-copy'
            seen=[]
            def observe(before,after,epoch,runtime,owner,previous,schemas):
                scope=r.current_same_schema_qualification()
                seen.append((r.application_schema(before),r.application_schema(after),scope['restored'],schemas))
                return r.begin_capture_retention(before,after,epoch,runtime,owner,previous,schemas)
            # Reuse the existing portable fixture's owned scratch ContextVar;
            # the Linux-only protected-parent admission is qualified separately.
            scratch=root/'scratch';scratch.mkdir();token=r._VERIFICATION_SCRATCH.set(scratch)
            try:
                with legacy.patch.object(legacy.install,'begin_capture_retention',side_effect=observe):
                    driver.capture_before_start(driver.target_id,1);driver.capture_before_start(driver.prior_id,2)
            finally:r._VERIFICATION_SCRATCH.reset(token)
            self.assertEqual(seen,[(60,60,False,(60,60)),(60,60,True,(60,))])
            self.assertIsNone(r.current_same_schema_qualification())
            with legacy.patch.object(legacy.install,'begin_capture_retention',side_effect=RuntimeError('capture-refused')):
                with self.assertRaisesRegex(RuntimeError,'capture-refused'):driver.capture_before_start(driver.target_id,3)
            self.assertIsNone(r.current_same_schema_qualification())

    def test_rehearsal_helper_marker_is_mutually_exclusive(self):
        # Reuse the already imported current installer only on Windows, where
        # the legacy fixture deliberately supplies its import-time fcntl shim.
        context = (legacy.patch.dict(sys.modules, {'install': legacy.install})
                   if legacy.os.name == 'nt' else legacy.contextlib.nullcontext())
        with context:
            import operator_rehearsal
        self.assertEqual(operator_rehearsal.helper_names({'sameSchemaQualification': SPEC}), r.APPLICATION_TRANSITION_HELPERS)
        with self.assertRaisesRegex(RuntimeError, 'Mixed'):
            operator_rehearsal.helper_names({'sameSchemaQualification': SPEC, 'applicationTransition': legacy.SPEC})
        with self.assertRaises(RuntimeError):
            operator_rehearsal.helper_names({'sameSchemaQualification': {**SPEC, 'schemaVersion': 55}})


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite(SameSchemaTests(name) for name in SAME_CASES)
    suite.addTests(loader.loadTestsFromTestCase(SameSchemaQualificationTests))
    suite.addTests(loader.loadTestsFromTestCase(SameSchemaDriverTests))
    return suite


if __name__ == '__main__':
    unittest.main()
