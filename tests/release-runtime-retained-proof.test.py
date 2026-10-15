import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
subject=load('runtime_retained',ROOT/'scripts/release-runtime-retained-proof.py')
fixture=load('runtime_fixture',ROOT/'support/runtime-retained-fixture.py').fixture

class Checks(unittest.TestCase):
    def consume(self,f):return subject.consume(f['request'],f['read'],f['runner'],f['materializer'])
    def test_complete_synthetic_proof_preserves_scope(self):
        result=self.consume(fixture())
        self.assertTrue(result['actualSettledQualification']);self.assertFalse(result['productionAdmission'])
        self.assertEqual(len(result['scenarios']),3)
        self.assertNotEqual(result['prior']['candidateId'],result['qualifiedTarget']['candidateId'])
        self.assertTrue(result['freshFullRehearsalStillRequired'])
        source=result['acceptedSource']['helpers']['directory']
        self.assertNotIn('copied-qualification-helpers',source)
    def test_unreviewed_producer_remains_closed(self):
        f=fixture()
        with self.assertRaisesRegex(RuntimeError,'producer-not-reviewed'):
            subject.consume(f['request'],f['read'],None,None)
        self.assertRegex(subject.QUALIFIED_RUNNER_SHA256, r'^[a-f0-9]{64}$')
        self.assertNotEqual(f['runner'], subject.QUALIFIED_RUNNER_SHA256)
        with self.assertRaisesRegex(RuntimeError, 'fixed-producer-required'):
            subject.consume(f['request'],f['read'],subject.QUALIFIED_RUNNER_SHA256,subject.QUALIFIED_MATERIALIZER_SHA256)
    def test_synthetic_only_or_incomplete_claims_refuse(self):
        for role,key,value in [('parent','passed',False),('child','freshActualSettledCopiedStartup',False),('parent','deliveryQualification',True),
             ('technical','callContractsReviewed',False),('child','completeMaintainedSavedAndNativeState',False),('parent','fromVersion','2026.9.8')]:
            with self.subTest(role=role,key=key),self.assertRaises(RuntimeError):
                self.consume(fixture({role:lambda x,k=key,v=value:x.update({k:v})}))
    def test_original_namespace_or_owned_process_refuses(self):
        for role,change in [('closure',lambda x:x.update(activeOwnedPids=[42])),
             ('child',lambda x:x.update(childNamespaces=x['parentNamespaces'])),
             ('target-first-start/process',lambda x:x.update(pid=1)),
             ('target-restart/ready',lambda x:x['nativeProcess'].update(nodeSha256='0'*64))]:
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.consume(fixture({role:change}))
    def test_changed_canonical_receipt_restoration_or_migration_refuses(self):
        for role,change in [('child',lambda x:x['scenarios'][0].update(path='/different/preservation.json')),
             ('restorationCompleted',lambda x:x.update(restoredInventory='0'*64)),
             ('nativeMigrationVerified',lambda x:x.update(savedWorkVerified=False)),
             ('migrationIntent',lambda x:x.update(runtimeArchiveSha256='0'*64))]:
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.consume(fixture({role:change}))
    def test_early_restart_or_unclosed_scenario_refuses(self):
        for role,change in [('target-restart/started',lambda x:x.update(startedAtSeconds=1)),
             ('target-first-start/closed',lambda x:x.update(owningServiceFullyStopped=False)),
             ('prior-rollback/preservation',lambda x:x.update(savedStoreCount=0)),
             ('target-first-start/ready',lambda x:x['heldReadiness']['health'].update(status='starting'))]:
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.consume(fixture({role:change}))
    def test_same_second_rounded_restart_remains_valid(self):
        self.consume(fixture({'target-first-start/closed':lambda x:x.update(closedAtSeconds=201)}))
    def test_changed_accepted_install_or_cache_refuses(self):
        for role,change in [('acceptedResult',lambda x:x.update(outcome='failed')),
             ('acceptedSource',lambda x:x['helpers']['sha256'].update({'install.py':'0'*64})),
             ('acceptedRequest',lambda x:x['expectedPrior'].update(workspaceEpoch='wrong')),
             ('acceptedRequest',lambda x:x['release']['applicationDependenciesBundle'].update(bytes=999)),
             ('parent',lambda x:x['transitionEvidence']['migrationIntent'].update(path='/different/migration-intent.json')),
             ('cacheReceipt',lambda x:x.update(verified=False)),('runtime',lambda x:x.update(toVersion='2026.9.9'))]:
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.consume(fixture({role:change}))
    def test_missing_or_changed_original_bytes_refuse(self):
        for role in ('producer','target-first-start/ready','restorationIntent','nativeMigrationLog','cacheManifest'):
            f=fixture();f['files'][f['roles'][role]['path']]=b'changed'
            with self.subTest(role=role),self.assertRaises(RuntimeError):self.consume(f)

if __name__=='__main__':unittest.main(verbosity=2)
