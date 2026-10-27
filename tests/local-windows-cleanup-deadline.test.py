"""Only two new cleanup-clock boundaries; synthetic native ports, no native I/O."""
import ast
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('cleanup_aged_fixtures',
    Path(__file__).with_name('local-windows-metadata-preservation.test.py'))
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
base=fixtures.fixtures;capture=fixtures.capture;subject=fixtures.subject


class CleanupFixture(fixtures.AgedFixture):
    def __init__(self,clock,*,constructor_abort=False):
        super().__init__();self.clock=clock;self.constructor_abort=constructor_abort;self.metadata_deadlines=[]

    def baseline_type(self):
        fixture=self
        class Baseline(super().baseline_type()):
            def __init__(self,path,kind,deadline,*,expected_links=1):
                assert expected_links==1
                capture._check(deadline);self.deadline=deadline
                fixture.metadata_deadlines.append(deadline)
                super().__init__(path,kind,deadline)
            def streams(self):
                capture._check(self.deadline);return super().streams()
            def capture(self):
                capture._check(self.deadline);return super().capture()
            def close(self):
                first=fixture.baseline_closed==0;super().close()
                if first and fixture.constructor_abort:
                    fixture.clock[0]=200
                    raise OSError('synthetic constructor failure after work expiry')
        return Baseline


class CleanupDeadlineTests(unittest.TestCase):
    def environment(self,fixture):return base.NeutralIOTests().environment(fixture)

    def budget(self):
        return capture.CaptureCleanupBudget(110,maximum_seconds=900,
            effective_worker_seconds=1010,admitted_work_seconds=100,finalization_seconds=10)

    def test_expired_work_settles_only_internal_metadata_including_constructor_abort(self):
        for constructor_abort in (False,True):
            with self.subTest(constructor_abort=constructor_abort):
                clock=[100];fixture=CleanupFixture(clock,constructor_abort=constructor_abort)
                original=copy.deepcopy(fixture.row)
                with patch.object(capture.time,'monotonic',lambda:clock[0]),self.environment(fixture):
                    budget=self.budget()
                    if constructor_abort:
                        with self.assertRaisesRegex(capture.CaptureRefused,'neutral-source-open-refused') as caught:
                            subject.open_source(Path('C:/owned/aged.py'),'file',110,cleanup_budget=budget)
                        evidence=caught.exception.observations
                        self.assertIn('synthetic constructor failure',evidence['closeErrors'][0]['error']['message'])
                    else:
                        held=subject.open_source(Path('C:/owned/aged.py'),'file',110,cleanup_budget=budget)
                        held._cleanup_active=True
                        for action in (held.streams,held.capture,lambda:list(held.read_chunks(1024)),
                                       lambda:held.list_names(max_entries=100,max_pages=2)):
                            with self.assertRaises(capture.CaptureRefused) as refused:
                                action()
                            detail=refused.exception.observations.get('original',{}).get('message',str(refused.exception))
                            self.assertEqual(detail,'public-source-io-during-cleanup-refused')
                        held._cleanup_active=False;clock[0]=200
                        with self.assertRaises(capture.CaptureRefused) as expired:
                            held.streams()
                        self.assertEqual(expired.exception.observations['original']['message'],'capture-deadline-expired')
                        held.close();evidence=held.evidence
                        self.assertEqual(held.deadline,110)
                    self.assertEqual(fixture.row,original)
                    self.assertEqual(fixture.set_count,1)
                    self.assertEqual(fixture.ports[0].closes,1)
                    self.assertEqual(fixture.metadata_deadlines,[110,1100])
                    self.assertFalse(evidence['abortedObservation']['contentIoComplete'])
                    self.assertTrue(evidence['abortedObservation']['metadataRestorationProven'])
                    self.assertEqual(budget.receipt()['originalWorkDeadline'],110)
                    self.assertEqual(budget.started,200);self.assertEqual(budget.deadline,1100)
                    self.assertNotIn('ReadFile',fixture.calls)
                    self.assertFalse(any(isinstance(call,tuple) and call[0]=='query' for call in fixture.calls))

    def test_shared_cleanup_exhaustion_never_restarts_and_still_closes_all_owners(self):
        # Execute only the newly added pure admission functions from the staged
        # maintained entry; do not import its native/process execution surface.
        entry_path=Path(__file__).parents[1]/'scripts/local-native-retained-qualification.py'
        parsed=ast.parse(entry_path.read_text(encoding='utf-8'))
        names={'need','qualification_representation','capture_cleanup_configuration','new_capture_cleanup'}
        selected=ast.Module(body=[node for node in parsed.body if isinstance(node,ast.FunctionDef) and node.name in names],type_ignores=[])
        namespace={'capture':capture};exec(compile(selected,str(entry_path),'exec'),namespace)
        config={'totalTimeoutMs':6300000,'captureRepresentation':'physical-graph-v3',
            'limits':{'maxReportBytes':capture.MAX_REPORT_BYTES},'captureCleanup':{
                'maximumSeconds':900,'maximumCaptures':4,'finalizationSeconds':120,'effectiveWorkerTimeoutSeconds':11220}}
        self.assertEqual(namespace['capture_cleanup_configuration'](config),config['captureCleanup'])
        invalid=copy.deepcopy(config);invalid['captureCleanup']['effectiveWorkerTimeoutSeconds']=11219
        with self.assertRaisesRegex(RuntimeError,'Finite worker budget'):
            namespace['capture_cleanup_configuration'](invalid)
        clock=[100];first=CleanupFixture(clock);second=CleanupFixture(clock)
        with patch.object(capture.time,'monotonic',lambda:clock[0]):
            with self.assertRaisesRegex(capture.CaptureRefused,'cleanup-worker-timeout-not-admitted'):
                capture.CaptureCleanupBudget(110,maximum_seconds=900,effective_worker_seconds=999,
                    admitted_work_seconds=100,finalization_seconds=10)
            with self.assertRaisesRegex(capture.CaptureRefused,'cleanup-admitted-work-does-not-bound-deadline'):
                capture.CaptureCleanupBudget(110,maximum_seconds=900,effective_worker_seconds=1010,
                    admitted_work_seconds=5,finalization_seconds=10)
            budget=self.budget();budget.claim(110)
            with self.environment(first):
                one=subject.open_source(Path('C:/owned/one.py'),'file',110,cleanup_budget=budget)
            with self.environment(second):
                two=subject.open_source(Path('C:/owned/two.py'),'file',110,cleanup_budget=budget)
            clock[0]=200
            with self.environment(first):one.close()
            clock[0]=1101
            with self.environment(second):
                with self.assertRaisesRegex(capture.CaptureRefused,'source-close-preservation-refused') as caught:
                    two.close()
                two.close()
            self.assertEqual(caught.exception.observations['settlementError']['message'],'capture-deadline-expired')
            self.assertFalse(caught.exception.observations['unresolvedHandle'])
            self.assertEqual(first.set_count,1);self.assertEqual(second.set_count,0)
            self.assertEqual(first.ports[0].closes,1);self.assertEqual(second.ports[0].closes,1)
            self.assertEqual(budget.begin(),1100);self.assertEqual(budget.started,200)
            self.assertFalse(two.evidence['abortedObservation']['metadataRestorationProven'])
            with self.assertRaisesRegex(capture.CaptureRefused,'fresh-per-capture-cleanup-budget-required'):
                budget.claim(110)


if __name__=='__main__':unittest.main()
