"""New metadata-preservation boundaries only; all native ports are synthetic."""
import base64
import copy
import ctypes
import importlib.util
from pathlib import Path
import time
import unittest

spec=importlib.util.spec_from_file_location('neutral_preservation_fixture',Path(__file__).with_name('local-windows-neutral-io.test.py'))
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
capture,subject=fixtures.capture,fixtures.subject


class AgedFixture(fixtures.Fixture):
    def __init__(self):
        super().__init__();self.setter_fail=False;self.late_security=False;self.set_count=0;self.acquired=1050
    def port_type(self):
        fixture=self
        class Port(super().port_type()):
            def open(self,*args):
                handle=super().open(*args);fixture.row['access100ns']=fixture.acquired;return handle
            def security(self,handle):
                return b'y'*20 if fixture.late_security else super().security(handle)
            def set_basic(self,*args):
                fixture.set_count+=1
                if fixture.setter_fail:
                    fixture.error=5;return 0
                return super().set_basic(*args)
        return Port


class MetadataPreservationTests(unittest.TestCase):
    def environment(self,fixture):return fixtures.NeutralIOTests().environment(fixture)
    def opened(self,fixture):return subject.open_source(Path('C:/owned/aged.py'),'file',time.monotonic()+30)
    def complete_io(self,held):list(held.read_chunks(1024));held.streams()

    def test_exact_same_handle_preservation_and_real_postclose_evidence(self):
        fixture=AgedFixture();original=copy.deepcopy(fixture.row)
        with self.environment(fixture):
            held=self.opened(fixture);self.complete_io(held);result=held.capture()
            self.assertEqual(result['information'],original)
            self.assertEqual(held.evidence['openedInformation']['access100ns'],1050)
            record=held.evidence['metadataPreservation']
            self.assertTrue(record['completed']);self.assertEqual(fixture.set_count,1)
            event=record['apiEvent']
            self.assertEqual(event['arguments']['class'],0)
            self.assertEqual(event['arguments']['handle'],held._owner_handle)
            self.assertEqual(event['raw']['bytes'],ctypes.sizeof(fixtures.native.BasicInfo))
            self.assertEqual(event['arguments']['information'],{key:original[key] for key in capture.PRESERVED_BASIC_FIELDS})
            pre=capture.unpack_metadata_observation(record['preWriteObservation'])
            self.assertEqual(pre['information'],held.evidence['openedInformation'])
            self.assertEqual(pre['streams'],result['streams'])
            capture.validate_source_preservation(held.evidence,result['information'],
                result['security']['ownerGroupDaclBase64'],result['streams'],require_closed=False)
            for action in (lambda:list(held.read_chunks(1024)),held.streams,held.capture):
                with self.assertRaises(capture.CaptureRefused):action()
            held.close();held.close()
            post=capture.unpack_metadata_observation(record['postCloseObservation'])
            self.assertEqual(post['information'],original)
            self.assertTrue(post['observations']['handleClosed'])
            self.assertEqual(fixture.ports[0].closes,1)
            self.assertEqual(fixture.baseline_closed,2)
            capture.validate_source_preservation(held.evidence,result['information'],
                result['security']['ownerGroupDaclBase64'],result['streams'],require_closed=True)

    def test_incomplete_or_changed_state_refuses_before_any_metadata_write(self):
        for change in ('incomplete','identity','allocation','security','streams'):
            with self.subTest(change=change):
                fixture=AgedFixture()
                with self.environment(fixture):
                    held=self.opened(fixture)
                    if change!='incomplete':self.complete_io(held)
                    if change=='identity':fixture.row['fileIndex64']+=1
                    if change=='allocation':fixture.row['allocationBytes']+=4096
                    if change=='security':fixture.late_security=True
                    if change=='streams':fixture.payload+=b'x'
                    with self.assertRaises(capture.CaptureRefused):held.capture()
                    self.assertEqual(fixture.set_count,0)
                    self.assertNotIn('metadataPreservation',held.evidence)
                    held.close()
        fixture=fixtures.Fixture()
        with self.environment(fixture):
            held=self.opened(fixture);self.complete_io(held);held.capture();held.close()
            self.assertNotIn('metadataPreservation',held.evidence)
            self.assertFalse(any(isinstance(call,tuple) and call[0]=='set-basic' for call in fixture.calls))

    def test_failed_setter_never_retries_and_postclose_failure_stays_explicit(self):
        fixture=AgedFixture();fixture.setter_fail=True
        with self.environment(fixture):
            held=self.opened(fixture);self.complete_io(held)
            with self.assertRaises(capture.CaptureRefused) as primary:held.capture()
            self.assertEqual(primary.exception.observations['original']['type'],'OSError')
            with self.assertRaises(capture.CaptureRefused):held.capture()
            with self.assertRaises(capture.CaptureRefused):held.close()
            held.close()
            self.assertEqual(fixture.set_count,1)
            self.assertEqual(fixture.ports[0].closes,1)
            record=held.evidence['metadataPreservation']
            self.assertFalse(record['completed']);self.assertEqual(record['apiEvent']['result'],0)
            self.assertIn('postCloseError',record)

    def test_preservation_chain_and_lossless_postclose_record_reject_tampering(self):
        fixture=AgedFixture()
        with self.environment(fixture):
            held=self.opened(fixture);self.complete_io(held);result=held.capture();held.close()
            evidence=copy.deepcopy(held.evidence)
        def validate(value):
            capture.validate_source_preservation(value,result['information'],
                result['security']['ownerGroupDaclBase64'],result['streams'],require_closed=True)
        validate(evidence)
        for mutation in ('raw-write','intent','transition-kind','transition-io','prewrite-security','postclose-metadata','postclose-closure','encoded-tail'):
            with self.subTest(mutation=mutation):
                changed=copy.deepcopy(evidence);record=changed['metadataPreservation']
                if mutation=='raw-write':
                    raw=bytearray(base64.b64decode(record['apiEvent']['raw']['base64']));raw[8]^=1
                    record['apiEvent']['raw']['base64']=base64.b64encode(raw).decode('ascii')
                elif mutation=='intent':record['intent']['originalBasicInfo']['change100ns']+=1
                elif mutation=='transition-kind':changed['acquisitionTransition']['kind']='unqualified-transition'
                elif mutation=='transition-io':changed['acquisitionTransition']['contentIoStarted']=True
                elif mutation=='prewrite-security':
                    value=capture.unpack_metadata_observation(record['preWriteObservation'])
                    value['security']['ownerGroupDaclBase64']=base64.b64encode(b'z'*20).decode('ascii')
                    record['preWriteObservation']=capture.pack_metadata_observation(value)
                elif mutation in ('postclose-metadata','postclose-closure'):
                    value=capture.unpack_metadata_observation(record['postCloseObservation'])
                    if mutation=='postclose-metadata':value['information']['access100ns']+=1
                    else:value['observations']['handleClosed']=False
                    record['postCloseObservation']=capture.pack_metadata_observation(value)
                else:
                    value=record['postCloseObservation'];raw=base64.b64decode(value['data'])+b'trailing'
                    value['data']=base64.b64encode(raw).decode('ascii')
                with self.assertRaises(capture.CaptureRefused):validate(changed)

    def test_complete_physical_graph_requires_preservation_postclose_chain(self):
        graph_spec=importlib.util.spec_from_file_location('preserved_graph_fixture',
            Path(__file__).with_name('local-windows-physical-graph.test.py'))
        graph_fixture=importlib.util.module_from_spec(graph_spec);graph_spec.loader.exec_module(graph_fixture)
        graph=graph_fixture.graph();row=graph['physicalEntries']['root']['local/saved.sqlite']
        fixture=AgedFixture();fixture.payload=b'local retained db';fixture.row=copy.deepcopy(row['information'])
        fixture.row['allocationBytes']=4096;fixture.acquired=graph_fixture.EPOCH+25000
        fixture.clock_values=[graph_fixture.EPOCH+24000,graph_fixture.EPOCH+26000]
        with self.environment(fixture):
            held=self.opened(fixture);self.complete_io(held);result=held.capture();held.close()
            row.update(information=result['information'],security=result['security'],streams=result['streams'],
                       nativeObservations=copy.deepcopy(held.evidence))
        graph_fixture.recount(graph)
        self.assertTrue(capture.validate_physical_graph(graph))
        del row['nativeObservations']['metadataPreservation']['postCloseObservation']
        graph_fixture.recount(graph)
        self.assertTrue(capture.validate_physical_graph(graph,require_closed=False))
        with self.assertRaisesRegex(capture.CaptureRefused,'complete-source-preservation-required'):
            capture.validate_physical_graph(graph)


if __name__=='__main__':unittest.main()
