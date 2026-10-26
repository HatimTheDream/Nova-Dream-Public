"""Finite shared evidence caller lifecycle; no native handles, runtime or user data."""
import copy
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('failure_lifecycle_entry',HERE.parent/'scripts/local-native-retained-qualification.py')
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)


class FakeScope:
    def __init__(self,ledger,name):self.ledger,self.name=ledger,name
    def finish(self,failed=False):
        self.ledger.activeScopes=0
        self.ledger.committed+=101
        self.ledger.failed |= failed


class FakeLedger:
    constructed=[]
    validations=[]
    @staticmethod
    def validate_configuration(root,maximum_bytes,*,must_be_absent=True):
        FakeLedger.validations.append((str(root),maximum_bytes,must_be_absent))
    def __init__(self,root,maximum_bytes):
        self.root,self.maximum=str(root),maximum_bytes
        self.committed=0;self.reserved=0;self.activeScopes=0;self.activePorts=0
        self.failed=False;self.names=[];self.fail_receipt=False
        self.constructed.append(self)
    def require_idle(self):
        if self.activeScopes or self.activePorts or self.reserved:raise RuntimeError('active failure-evidence custody')
    def new_scope(self,name):
        self.require_idle()
        if name in self.names:raise RuntimeError('duplicate evidence scope')
        self.names.append(name);self.activeScopes=1
        return FakeScope(self,name)
    def receipt(self):
        if self.fail_receipt:raise OSError('final evidence receipt failed')
        return {'kind':'test-shared-ledger','root':self.root,'maximumBytes':self.maximum,
                'committedBytes':self.committed,'chargedBytes':self.committed,'uncertainBytes':0,
                'reservedBytes':self.reserved,'remainingBytes':self.maximum-self.committed-self.reserved,
                'activeScopes':self.activeScopes,'activePorts':self.activePorts,'failed':self.failed,
                'scopes':[{'name':name} for name in self.names]}


def plan(root):
    return {'operationId':'a079a41a-bae1-419f-80ce-90d83e0eb9c9',
            'sourceRoot':str(root/'source'),'workingRoot':str(root/'working'),
            'parkedRoot':str(root/'parked'),'preservedRoot':str(root/'preserved'),
            'captureRoot':str(root/'images'),'evidenceRoot':str(root/'evidence'),
            'releaseRoot':str(root/'release'),'vendorRoot':str(root/'vendor'),'node':'unused-node',
            'retiredPids':[19],'readyTimeoutMs':300000,'totalTimeoutMs':3600000,
            'limits':{'maxEntries':100000,'maxBytes':3*1024**3,'maxFileBytes':384*1024**2,
                      'maxAliases':128,'maxReportBytes':entry.capture.MAX_REPORT_BYTES},
            'failureEvidence':{'root':str(root/'failure-evidence'),
                'maximumBytes':entry.failure_evidence.MAX_FAILURE_EVIDENCE_BYTES,
                'segmentBytes':entry.failure_evidence.SEGMENT_BYTES,
                'primaryRecordBytes':entry.failure_evidence.PRIMARY_RECORD_BYTES,
                'emergencyBytes':entry.failure_evidence.EMERGENCY_BYTES,
                'portErrorReserveBytes':entry.failure_evidence.PORT_ERROR_RESERVE_BYTES},
            'captureRepresentation':'physical-graph-v3','sourceRefs':[]}


def commit_observation():
    maximum=entry.capture.MAX_REPORT_BYTES;base=entry.capture.required_report_commit_bytes(maximum)
    return {'admissionRequired':True,'source':'GetPerformanceInfo','maxReportBytes':maximum,
            'requiredCommitBytes':base,'availableCommitBytes':base+268435456,'observedEpochMs':123}


class FailureEvidenceLifecycleTests(unittest.TestCase):
    def setUp(self):FakeLedger.constructed=[];FakeLedger.validations=[]

    def test_exact_shared_configuration_and_cumulative_allocation(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(entry.failure_evidence,'FailureEvidenceLedger',FakeLedger):
            value=plan(Path(directory))
            ledger=entry.prepare_failure_evidence(value)
            self.assertEqual(len(FakeLedger.constructed),1)
            ledger.committed=12345
            self.assertIs(entry.prepare_failure_evidence(value,ledger),ledger)
            self.assertEqual(entry.failure_evidence_configuration(value,ledger),ledger.maximum-12345)
            self.assertFalse(FakeLedger.validations[-1][2])
            for field in ('maximumBytes','segmentBytes','primaryRecordBytes','emergencyBytes','portErrorReserveBytes'):
                changed=copy.deepcopy(value);changed['failureEvidence'][field]+=1
                with self.subTest(field=field),self.assertRaises(RuntimeError):entry.failure_evidence_configuration(changed,ledger)
            for field in ('sourceRoot','workingRoot','parkedRoot','preservedRoot','captureRoot','releaseRoot','vendorRoot'):
                changed=copy.deepcopy(value);changed['failureEvidence']['root']=str(Path(value[field])/'evidence')
                with self.subTest(overlap=field),self.assertRaises(RuntimeError):entry.failure_evidence_configuration(changed,ledger)
            changed=copy.deepcopy(value);changed['failureEvidence']['root']=str(Path(directory)/'different-ledger')
            with self.assertRaises(RuntimeError):entry.failure_evidence_configuration(changed,ledger)
            with self.assertRaises(RuntimeError):entry.failure_evidence_configuration(value,object())
            for field in ('activeScopes','activePorts','reserved'):
                setattr(ledger,field,1)
                with self.subTest(active=field),self.assertRaises(RuntimeError):entry.prepare_failure_evidence(value,ledger)
                setattr(ledger,field,0)
            self.assertEqual(len(FakeLedger.constructed),1)

    def test_primary_serialization_reserve_uses_one_fresh_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            value=plan(Path(directory));observed=commit_observation()
            with patch.object(entry.capture,'admit_report_commit_capacity',return_value=observed) as native:
                result=entry.admit_failure_evidence_commit_capacity(value)
                native.assert_called_once_with(entry.capture.MAX_REPORT_BYTES)
            self.assertEqual(result['requiredCommitBytes'],17716740096)
            self.assertEqual(result['reportRequiredCommitBytes'],17448304640)
            self.assertEqual(result['primarySerializationReserveBytes'],268435456)
            self.assertEqual(result['observedEpochMs'],123)
            self.assertEqual(observed['requiredCommitBytes'],17448304640)
            observed['availableCommitBytes']-=1
            with patch.object(entry.capture,'admit_report_commit_capacity',return_value=observed),self.assertRaises(RuntimeError):
                entry.admit_failure_evidence_commit_capacity(value)
            changed=copy.deepcopy(value);changed['limits']['maxReportBytes']=256*1024**2
            with patch.object(entry.capture,'admit_report_commit_capacity') as native,self.assertRaises(RuntimeError):
                entry.admit_failure_evidence_commit_capacity(changed)
            native.assert_not_called()

    def exercise(self,*,capture_fails,receipt_fails):
        with tempfile.TemporaryDirectory() as directory,patch.object(entry.failure_evidence,'FailureEvidenceLedger',FakeLedger):
            value=plan(Path(directory));ledger=entry.prepare_failure_evidence(value);ledger.committed=707
            reports={};calls=[];renames=[]
            def save(path,row):reports[Path(path).name]=copy.deepcopy(row)
            def tree(source,destination,**kwargs):
                scope=kwargs['failure_evidence'];calls.append((Path(destination).name,scope))
                self.assertIs(scope.ledger,ledger)
                self.assertEqual(kwargs['representation'],'physical-graph-v3')
                failed=capture_fails and Path(destination).name=='after-startup'
                scope.finish(failed)
                if failed:raise RuntimeError('primary capture writer failure')
                if Path(destination).name=='restored-original' and receipt_fails:ledger.fail_receipt=True
                return {'kind':'synthetic-complete-capture','information':{'id':17}}
            def rename(source,target,info,deadline,*,phase,state,**kwargs):
                renames.append(phase);state[phase]='confirmed';return {'phase':phase}
            def host(plan,evidence,deadline,closure_deadline,ownership):
                ownership.update(dispatchAttempted=True,closed=True)
                return {'passed':True,'observedNativePids':[91],'startedEpochMs':1,'endedEpochMs':2},{'allRetired':True}
            fake_clone=SimpleNamespace(prepare_working_copy=lambda *a,**k:{'rootInformation':{'id':18}},
                                       finalize_renamed_root=lambda *a,**k:None)
            with patch.object(entry,'admit',return_value=(value,time.monotonic()+3600)) as admit, \
                 patch.object(entry,'os',SimpleNamespace(name='nt',path=os.path)), \
                 patch.object(entry,'save',side_effect=save), \
                 patch.object(entry.capture,'admit_report_commit_capacity',return_value=commit_observation()), \
                 patch.object(entry.capture,'assert_processes_retired',return_value={'allRetired':True}), \
                 patch.object(entry.capture,'capture_closed_tree',side_effect=tree), \
                 patch.object(entry.capture,'source_root_entry',return_value={'information':{'id':17}}), \
                 patch.object(entry,'rename_role',side_effect=rename), \
                 patch.object(entry,'run_host',side_effect=host), \
                 patch.object(entry.recovery,'digest',return_value='synthetic'), \
                 patch.object(entry,'assert_working_baseline',return_value={'passed':True}), \
                 patch.object(entry,'assert_restored',return_value={'passed':True}), \
                 patch.object(entry,'assert_native_return_chain',return_value={'passed':True}), \
                 patch.object(entry,'app_release_bindings',return_value=[]), \
                 patch.object(entry.recovery,'local_windows_native_saved_state',return_value={'passed':True}), \
                 patch.dict(sys.modules,{'local_windows_clone':fake_clone}):
                code=entry.execute('synthetic-plan','synthetic-intent',failure_evidence_ledger=ledger)
            self.assertIs(admit.call_args.kwargs['failure_evidence_ledger'],ledger)
            self.assertEqual(len(FakeLedger.constructed),1)
            self.assertEqual([name for name,_ in calls],['before-original','before-startup','after-startup','restored-original'])
            self.assertEqual(len({id(scope) for _,scope in calls}),4)
            self.assertEqual(len(set(ledger.names)),4)
            self.assertEqual(ledger.committed,707+4*101)
            self.assertEqual(renames,['park-pristine','activate-working','preserve-working','return-pristine'])
            result=reports['RESULT.json']
            self.assertTrue(result['restored']);self.assertTrue(result['originalOwnerClosed'])
            return code,result,ledger

    def test_failure_keeps_primary_and_restores_with_same_cumulative_ledger(self):
        code,result,ledger=self.exercise(capture_fails=True,receipt_fails=False)
        self.assertEqual(code,1);self.assertFalse(result['qualified'])
        self.assertEqual(result['primaryError']['message'],'primary capture writer failure')
        self.assertEqual(result['failureEvidence'],ledger.receipt())
        self.assertEqual(result['failureEvidence']['activePorts'],0)

    def test_receipt_failure_follows_restoration_and_does_not_replace_primary(self):
        code,result,_=self.exercise(capture_fails=True,receipt_fails=True)
        self.assertEqual(code,1);self.assertFalse(result['qualified'])
        self.assertEqual(result['primaryError']['message'],'primary capture writer failure')
        self.assertEqual(result['failureEvidenceError']['message'],'final evidence receipt failed')

    def test_success_reuses_one_ledger_without_resetting_prior_allocation(self):
        code,result,ledger=self.exercise(capture_fails=False,receipt_fails=False)
        self.assertEqual(code,0);self.assertTrue(result['qualified'])
        self.assertEqual(result['failureEvidence'],ledger.receipt())

    @unittest.skipUnless(os.environ.get('NOVA_FAILURE_EVIDENCE_CUSTODY_SOURCE'),
                         'Private custody adapter is only supplied for its focused qualification')
    def test_outer_capacity_counts_shared_allocation_once_and_retains_holds(self):
        path=Path(os.environ['NOVA_FAILURE_EVIDENCE_CUSTODY_SOURCE']).resolve()
        spec=importlib.util.spec_from_file_location('failure_lifecycle_custody',path)
        custody=importlib.util.module_from_spec(spec);spec.loader.exec_module(custody)
        with tempfile.TemporaryDirectory() as directory,patch.object(entry.failure_evidence,'FailureEvidenceLedger',FakeLedger):
            inner=plan(Path(directory));ledger=entry.prepare_failure_evidence(inner)
            outer={'vendorRoot':inner['vendorRoot'],'failureEvidence':inner['failureEvidence'],
                   'limits':inner['limits'],'capacityBudget':{'diskBytesByRole':{
                       'imagesAndClones':8*inner['limits']['maxBytes'],
                       'reports':8*inner['limits']['maxReportBytes'],'scratchAndLogs':6*1024**3,
                       'allocationOverhead':8*inner['limits']['maxEntries']*8192,
                       'recoveryReserve':2*1024**3,'failureEvidence':ledger.maximum},
                       'minimumAvailableCommitBytes':38*entry.capture.MAX_REPORT_BYTES+2*1024**3+268435456}}
            base=sum(outer['capacityBudget']['diskBytesByRole'].values())
            with patch.object(custody.shutil,'disk_usage',return_value=SimpleNamespace(free=base)), \
                 patch.object(entry.capture,'admit_report_commit_capacity',return_value=commit_observation()):
                first=custody.capacity(outer,entry,inner,failure_evidence_ledger=ledger)
                self.assertEqual(first['diskRequiredBytes'],base)
                ledger.committed=1234567
                later=custody.capacity(outer,entry,inner,failure_evidence_ledger=ledger)
                self.assertEqual(later['diskRequiredBytes'],base-ledger.committed)
                self.assertEqual(later['failureEvidenceUncommittedBytes'],ledger.maximum-ledger.committed)
                ledger.reserved=1
                with self.assertRaises(RuntimeError):custody.capacity(outer,entry,inner,failure_evidence_ledger=ledger)
                ledger.reserved=0
                bad=copy.deepcopy(outer);bad['capacityBudget']['diskBytesByRole']['failureEvidence']*=2
                with self.assertRaises(RuntimeError):custody.capacity(bad,entry,inner,failure_evidence_ledger=ledger)


if __name__=='__main__':unittest.main()
