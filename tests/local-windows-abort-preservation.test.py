"""New abort paths only. Native APIs are synthetic; old tests are not executed."""
import copy
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('abort_preservation_fixtures',HERE/'local-windows-metadata-preservation.test.py')
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
base=fixtures.fixtures;capture=fixtures.capture;subject=fixtures.subject
graph_spec=importlib.util.spec_from_file_location('abort_graph_fixtures',HERE/'local-windows-capture.test.py')
graph=importlib.util.module_from_spec(graph_spec);graph_spec.loader.exec_module(graph)


class AbortFixture(fixtures.AgedFixture):
    def __init__(self):
        super().__init__();self.constructor_baseline_close_fails=False

    def baseline_type(self):
        fixture=self
        class Baseline(super().baseline_type()):
            def __init__(self,path,kind,deadline,*,expected_links=1):
                if expected_links!=1:raise AssertionError('This synthetic abort fixture is single-link')
                super().__init__(path,kind,deadline)
            def close(self):
                before=fixture.baseline_closed;super().close()
                if fixture.constructor_baseline_close_fails and before==0:
                    raise OSError('synthetic constructor baseline-close failure')
        return Baseline


class AbortPreservationTests(unittest.TestCase):
    def environment(self,fixture):return base.NeutralIOTests().environment(fixture)

    def opened(self,fixture,path=Path('C:/owned/abort.py')):
        return subject.open_source(path,fixture.kind,time.monotonic()+30)

    def test_abort_before_capture_and_partial_read_preserves_without_complete_claim(self):
        for mode in ('unstarted-file','partial-file','unstarted-directory','unchanged-access'):
            with self.subTest(mode=mode):
                fixture=AbortFixture()
                if mode=='unstarted-directory':
                    fixture.kind='directory';fixture.payload=b'';fixture.row=base.info('directory',0)
                if mode=='unchanged-access':fixture.acquired=fixture.row['access100ns']
                original=copy.deepcopy(fixture.row)
                with self.environment(fixture),patch.object(subject,'CHUNK_BYTES',4):
                    held=self.opened(fixture);reader=None
                    if mode=='partial-file':
                        reader=held.read_chunks(1024);self.assertEqual(next(reader),b'fixt')
                        self.assertFalse(held.evidence['readResult']['complete'])
                    held.close();held.close()
                    self.assertEqual(fixture.row,original)
                    self.assertEqual(fixture.ports[0].closes,1)
                    abort=held.evidence['abortedObservation']
                    self.assertFalse(abort['contentIoComplete']);self.assertFalse(abort['captureComplete'])
                    self.assertTrue(abort['synchronousIoSettled']);self.assertTrue(abort['ioStopped'])
                    self.assertTrue(abort['metadataRestorationProven'])
                    self.assertFalse(held._capture_completed)
                    if mode=='unchanged-access':
                        self.assertEqual(fixture.set_count,0)
                        self.assertNotIn('metadataPreservation',held.evidence)
                        post=abort['postCloseObservation']
                    else:
                        self.assertEqual(fixture.set_count,1)
                        record=held.evidence['metadataPreservation']
                        self.assertEqual(record['kind'],'same-handle-aborted-access-preservation')
                        self.assertFalse(record['intent']['contentIoComplete'])
                        self.assertTrue(record['intent']['synchronousIoSettled'])
                        self.assertEqual(record['intent']['abortedObservationRef'],'abortedObservation')
                        post=record['postCloseObservation']
                    self.assertEqual(capture.unpack_metadata_observation(post)['information'],original)
                    if reader is not None:
                        with self.assertRaises(capture.CaptureRefused):next(reader)

    def test_constructor_failure_only_preserves_authenticated_acquisition(self):
        fixture=AbortFixture();fixture.constructor_baseline_close_fails=True
        original=copy.deepcopy(fixture.row)
        with self.environment(fixture):
            with self.assertRaises(capture.CaptureRefused) as failure:self.opened(fixture)
            observation=failure.exception.observations
            self.assertTrue(observation['abortedObservation']['metadataRestorationProven'])
            self.assertEqual(fixture.row,original);self.assertEqual(fixture.set_count,1)
            self.assertEqual(fixture.ports[0].closes,1)
            self.assertTrue(observation['handleClosed'])
        fixture=AbortFixture();fixture.suppress_ok=False
        with self.environment(fixture):
            with self.assertRaises(capture.CaptureRefused) as failure:self.opened(fixture)
            observation=failure.exception.observations
            self.assertFalse(observation['abortedObservation']['metadataRestorationProven'])
            self.assertNotIn('metadataPreservation',observation)
            self.assertEqual(fixture.set_count,0);self.assertEqual(fixture.ports[0].closes,1)

    def test_abort_drift_unsettled_io_and_expired_deadline_refuse_write_but_close(self):
        for case in ('identity','allocation','security','streams','in-flight','deadline'):
            with self.subTest(case=case):
                fixture=AbortFixture()
                with self.environment(fixture):
                    held=self.opened(fixture)
                    if case=='identity':fixture.row['fileIndex64']+=1
                    elif case=='allocation':fixture.row['allocationBytes']+=4096
                    elif case=='security':fixture.late_security=True
                    elif case=='streams':fixture.payload+=b'x'
                    elif case=='in-flight':held._active_io={'api':'ReadFile'};held._io_native_returned=False
                    elif case=='deadline':held.deadline=time.monotonic()-1
                    deadline=held.deadline
                    with self.assertRaises(capture.CaptureRefused):held.close()
                    held.close()
                    self.assertEqual(fixture.set_count,0);self.assertEqual(fixture.ports[0].closes,1)
                    self.assertEqual(held.deadline,deadline)
                    self.assertFalse(held.evidence['abortedObservation']['metadataRestorationProven'])
                    self.assertNotIn('metadataPreservation',held.evidence)

    def test_uncertain_abort_write_is_never_retried_and_postclose_failure_is_kept(self):
        fixture=AbortFixture();fixture.setter_fail=True
        with self.environment(fixture):
            held=self.opened(fixture)
            with self.assertRaises(capture.CaptureRefused):held.close()
            held.close()
            self.assertEqual(fixture.set_count,1);self.assertEqual(fixture.ports[0].closes,1)
            record=held.evidence['metadataPreservation']
            self.assertTrue(record['attempted']);self.assertFalse(record['completed'])
            self.assertFalse(record['intent']['contentIoComplete'])
            self.assertIn('postCloseError',record)
            self.assertFalse(held.evidence['abortedObservation']['metadataRestorationProven'])
        for stage in ('constructor','close'):
            with self.subTest(postCloseUnresolved=stage):
                fixture=AbortFixture()
                with self.environment(fixture):
                    held=self.opened(fixture);baseline=fixture.baseline_type()
                    class Unresolved(baseline):
                        def __init__(self,*args,**kwargs):
                            if stage=='constructor':
                                raise capture.CaptureRefused('synthetic-unresolved-open',{'unresolvedHandle':True})
                            super().__init__(*args,**kwargs)
                        def close(self):
                            raise OSError('synthetic-unresolved-observer-close')
                    with patch.object(capture,'_Held',Unresolved):
                        with self.assertRaises(capture.CaptureRefused) as failure:held.close()
                    self.assertTrue(failure.exception.unresolved_handle)
                    self.assertTrue(held.evidence['metadataPreservation']['unresolvedHandle'])
                    self.assertFalse(held.evidence['abortedObservation']['metadataRestorationProven'])
                    held.close();self.assertEqual(fixture.set_count,1)
                    self.assertEqual(fixture.ports[0].closes,1)

    def test_graph_inventory_abort_retains_every_uncaptured_owner_after_cleanup(self):
        # Scratch paths only; every native port is replaced by fixture objects.
        with tempfile.TemporaryDirectory(prefix='nova-abort-contract-') as directory:
            scratch=Path(directory)
            self.assertNotIn('onedrive',str(scratch).lower())
            root=scratch/'source';vendor=scratch/'vendor';destination=scratch/'image'
            root.mkdir();vendor.mkdir();(root/'a-owned.py').write_bytes(b'fixture');(root/'z-refuse.py').write_bytes(b'refuse')
            fixture=AbortFixture();original=copy.deepcopy(fixture.row)
            with self.environment(fixture):
                held=self.opened(fixture,root/'a-owned.py')
                baseline=fixture.baseline_type()
                class Directory(graph.FakeHeld):
                    def list_names(self,*,max_entries,max_pages):return sorted(p.name for p in self.path.iterdir())
                def metadata(path,kind,deadline,**options):
                    if Path(path)==held.path:return baseline(path,kind,deadline,**options)
                    return Directory(Path(path),kind,deadline)
                def opened(path,kind,deadline,**options):
                    if Path(path)==held.path:return held
                    if kind=='file':raise capture.CaptureRefused('synthetic-inventory-open-refusal')
                    return Directory(Path(path),kind,deadline)
                limits={'node':'C:/unused-node.exe','maxEntries':20,'maxBytes':1024,'maxFileBytes':256,
                        'maxDepth':8,'maxAliases':3,'maxReportBytes':1024*1024}
                with patch.object(capture,'_Held',metadata),patch.object(subject,'open_source',opened),\
                     patch.object(capture,'_windows_required'),patch.object(capture,'_identity_join'):
                    with self.assertRaises(capture.CaptureRefused) as failure:
                        capture.capture_closed_tree(root,destination,vendor_root=vendor,limits=limits,
                            deadline=time.monotonic()+30,representation='physical-graph-v3')
                report=failure.exception.observations
                self.assertFalse(report['complete']);self.assertTrue(report['allHandlesClosed'])
                self.assertEqual(report['physicalEntries'],{'root':{},'vendor':{}})
                proof=report['abortedSourcePreservation'];self.assertEqual(proof['ownerCount'],1)
                self.assertTrue(proof['allListedOwnersClosed']);self.assertTrue(proof['allListedOwnersMetadataProven'])
                self.assertFalse(proof['failedConstructorCoveredByOwnerList'])
                self.assertIs(proof['owners'][0]['nativeObservations'],held.evidence)
                self.assertLess(len(json.dumps(report).encode()),limits['maxReportBytes'])
                self.assertFalse(destination.exists());self.assertEqual(fixture.row,original)
                self.assertEqual(fixture.set_count,1);self.assertEqual(fixture.ports[0].closes,1)


if __name__=='__main__':unittest.main()
