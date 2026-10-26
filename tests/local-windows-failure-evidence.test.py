"""Only new bounded evidence/admission paths. No real Windows APIs are used."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'deploy'/'update-runner'))
import local_windows_failure_evidence as evidence
spec=importlib.util.spec_from_file_location('failure_evidence_fixtures',HERE/'local-windows-abort-preservation.test.py')
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
capture=fixtures.capture;neutral=fixtures.subject


class FailureEvidenceTests(unittest.TestCase):
    def environment(self,fixture):return fixtures.AbortPreservationTests().environment(fixture)

    def baseline(self,fixture):
        return {'information':copy.deepcopy(fixture.row),
            'security':{'ownerGroupDaclBase64':base64.b64encode(fixtures.base.SECURITY).decode(),'saclNotRequested':True},
            'streams':[{'name':'::$DATA','bytes':len(fixture.payload),'allocationBytes':4096,
                'rawBase64':base64.b64encode(fixtures.base.stream_bytes(fixture.payload)[:40]).decode()}]}

    def records(self,manifest):
        rows=[]
        for ref in manifest['segments']:
            evidence.verify_reference(ref,ref['maximumBytes'])
            raw=Path(ref['path']).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(),ref['sha256'])
            rows.extend(json.loads(line) for line in raw.splitlines())
        return rows

    def test_exact_baseline_path_and_negative_metadata_have_finite_reservation(self):
        fixture=fixtures.AbortFixture();path=Path('C:/owned/'+'\u03bb'*1800+'.py')
        baseline=self.baseline(fixture)
        expected=32*len(evidence.encoded({'path':str(path),**baseline}))+640*1024
        self.assertEqual(evidence.owner_reservation_bytes(path,baseline),expected)
        with tempfile.TemporaryDirectory(prefix='nova-failure-budget-') as temp:
            ledger=evidence.FailureEvidenceLedger(Path(temp)/'evidence')
            scope=ledger.new_scope('negative')
            with self.environment(fixture):
                held=neutral.open_source(path,'file',time.monotonic()+30,failure_evidence=scope)
                # A full-size unexpected security descriptor must fit even when
                # the original admitted descriptor was tiny.
                held.port.security=lambda _handle:b'z'*65536
                with self.assertRaises(capture.CaptureRefused):held.close()
                self.assertEqual(fixture.ports[0].closes,1)
                self.assertFalse(held.evidence['abortedObservation']['metadataRestorationProven'])
                self.assertTrue(scope.owner(held))
            manifest=scope.finish();self.assertTrue(manifest['complete'],manifest);ledger.require_idle()
            owner=self.records(manifest)[0]
            self.assertEqual(len(base64.b64decode(owner['nativeObservations']['ownerGroupDaclBeforeBase64'])),65536)
            self.assertEqual(ledger.receipt()['reservedBytes'],0)

    def test_second_owner_and_io_admission_refuse_before_native_dispatch(self):
        for mode in ('second-owner','read'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(prefix='nova-failure-admit-') as temp:
                fixture=fixtures.AbortFixture();original=copy.deepcopy(fixture.row)
                # Admit one authentic owner, then retain no spare room for a
                # second owner or the first ReadFile event reservation.
                ledger=evidence.FailureEvidenceLedger(Path(temp)/'evidence')
                scope=ledger.new_scope('admission')
                with self.environment(fixture):
                    first=neutral.open_source(Path('C:/owned/first.py'),'file',time.monotonic()+30,failure_evidence=scope)
                    ledger.maximum_bytes=ledger.reserved_bytes
                    if mode=='second-owner':
                        with self.assertRaises(capture.CaptureRefused) as failure:
                            neutral.open_source(Path('C:/owned/second.py'),'file',time.monotonic()+30,failure_evidence=scope)
                        self.assertEqual(sum(isinstance(call,tuple) and call[0]=='open' for call in fixture.calls),1)
                    else:
                        with self.assertRaises(capture.CaptureRefused) as failure:list(first.read_chunks(1024))
                        self.assertNotIn('ReadFile',fixture.calls)
                    first.close();self.assertEqual(fixture.row,original)
                    self.assertTrue(scope.owner(first))
                    self.assertTrue(scope.primary(capture._error(failure.exception),failure.exception.observations))
                manifest=scope.finish();self.assertTrue(manifest['complete']);ledger.require_idle()
                self.assertEqual(ledger.receipt()['committedBytes'],sum(r['bytes'] for r in manifest['segments']))
                self.assertEqual(ledger.receipt()['uncertainBytes'],0)
                rows=self.records(manifest);self.assertEqual(sum(r['kind']=='aborted-source-owner' for r in rows),1)

    def test_complete_record_segments_oversize_primary_and_cumulative_readback(self):
        with tempfile.TemporaryDirectory(prefix='nova-failure-segments-') as temp,patch.object(evidence,'SEGMENT_BYTES',2048):
            ledger=evidence.FailureEvidenceLedger(Path(temp)/'evidence')
            scope=ledger.new_scope('first')
            baseline=self.baseline(fixtures.AbortFixture())
            for index in range(3):
                owner=types.SimpleNamespace(path=Path('C:/owned/'+str(index)),kind='file',evidence={'payload':'x'*1100})
                scope.admit_owner(owner,baseline);self.assertTrue(scope.owner(owner),scope.errors)
            self.assertTrue(scope.primary({'type':'Synthetic'}, {'payload':'p'*5000}))
            manifest=scope.finish();self.assertTrue(manifest['complete']);ledger.require_idle()
            self.assertEqual(len(self.records(manifest)),4)
            primary=[r for r in manifest['segments'] if r['role']=='primary']
            self.assertEqual(len(primary),1);self.assertGreater(primary[0]['bytes'],2048)
            self.assertEqual(primary[0]['maximumBytes'],evidence.PRIMARY_RECORD_BYTES)
            before=ledger.receipt()['committedBytes']
            second=ledger.new_scope('second');second.finish();ledger.require_idle()
            self.assertEqual(ledger.receipt()['committedBytes'],before)
            self.assertEqual(ledger.receipt()['remainingBytes'],ledger.maximum_bytes-before)

    def test_readback_mismatch_keeps_partial_record_and_never_returns_durable_reference(self):
        with tempfile.TemporaryDirectory(prefix='nova-failure-readback-') as temp:
            ledger=evidence.FailureEvidenceLedger(Path(temp)/'evidence');scope=ledger.new_scope('readback')
            owner=types.SimpleNamespace(path=Path('C:/owned/a'),kind='file',evidence={'payload':'fixture'})
            scope.admit_owner(owner,self.baseline(fixtures.AbortFixture()));scope.owner(owner)
            close=evidence.Transcript.close
            def changed(writer):
                close(writer)
                with writer.path.open('ab') as stream:stream.write(b'changed')
            with patch.object(evidence.Transcript,'close',changed):manifest=scope.finish()
            self.assertFalse(manifest['complete']);self.assertEqual(manifest['segments'],[])
            self.assertEqual(len(manifest['failedSegments']),1)
            self.assertTrue(Path(manifest['failedSegments'][0]['path']).exists())
            self.assertGreater(ledger.receipt()['uncertainBytes'],0);ledger.require_idle()

    def test_readback_windows_cross_api_ctime_keeps_same_api_change_and_birthtime_guards(self):
        with tempfile.TemporaryDirectory(prefix='nova-failure-ctime-') as temp:
            path=Path(temp)/'owned';payload=b'owned identity fixture';path.write_bytes(payload)
            actual=path.lstat()
            original={key:getattr(actual,key) for key in ('st_dev','st_ino','st_size','st_mode','st_nlink','st_mtime_ns')}
            original.update(st_birthtime_ns=100,st_ctime_ns=200)
            reference={'path':str(path),'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}
            for change in ('stable-cross-api','fd-change-time','path-ctime','fd-birthtime','path-birthtime','fd-identity','missing-birthtime','non-windows-ctime'):
                with self.subTest(change=change):
                    path_before=types.SimpleNamespace(**original);path_after=types.SimpleNamespace(**original)
                    fd_before=types.SimpleNamespace(**{**original,'st_ctime_ns':300})
                    fd_after=types.SimpleNamespace(**{**original,'st_ctime_ns':300})
                    if change=='fd-change-time':fd_after.st_ctime_ns+=1
                    elif change=='path-ctime':path_after.st_ctime_ns+=1
                    elif change=='fd-birthtime':fd_before.st_birthtime_ns+=1;fd_after.st_birthtime_ns+=1
                    elif change=='path-birthtime':path_after.st_birthtime_ns+=1
                    elif change=='fd-identity':fd_before.st_ino+=1;fd_after.st_ino+=1
                    elif change=='missing-birthtime':del path_before.st_birthtime_ns
                    proxy=types.SimpleNamespace(name='posix' if change=='non-windows-ctime' else 'nt',
                        fstat=unittest.mock.Mock(side_effect=[fd_before,fd_after]))
                    with patch.object(evidence,'ordinary',return_value=path),patch.object(evidence,'os',proxy),\
                         patch.object(Path,'lstat',side_effect=[path_before,path_after]):
                        if change=='stable-cross-api':self.assertEqual(evidence.verify_reference(reference,1024),reference)
                        else:
                            with self.assertRaises(RuntimeError):evidence.verify_reference(reference,1024)

    def test_constructor_cleanup_metadata_close_and_uninserted_owner_coverage(self):
        with tempfile.TemporaryDirectory(prefix='nova-failure-boundaries-') as temp:
            root=Path(temp)
            # A post-open initialization failure must close its exact output
            # stream without claiming a durable result or an unresolved close.
            with patch.object(evidence.hashlib,'sha256',side_effect=MemoryError('synthetic initialization')):
                with self.assertRaises(RuntimeError) as failure:evidence.Transcript(root/'constructor.jsonl',4096)
            self.assertFalse(failure.exception.unresolved_handle)
            self.assertTrue(failure.exception.observations['closed'])
            ledger=evidence.FailureEvidenceLedger(root/'evidence');scope=ledger.new_scope('metadata')
            port=types.SimpleNamespace(path=Path('C:/owned/metadata'),kind='directory')
            token=scope.admit_port(port.path,port.kind);token.owner=port
            before=scope.emergency_remaining
            self.assertTrue(scope.close_error(port,{'type':'OSError','message':'metadata close refusal'}))
            self.assertLess(token.amount,evidence.PORT_ERROR_RESERVE_BYTES)
            self.assertEqual(scope.emergency_remaining,before)
            manifest=scope.finish();self.assertTrue(manifest['complete']);ledger.require_idle()
            self.assertEqual(self.records(manifest)[0]['kind'],'port-close-failure')
            # capture() may complete before a subsequent node-join/row-budget
            # refusal. Only an actual retained row is evidence of representation.
            completed=types.SimpleNamespace(_capture_completed=True)
            retained=types.SimpleNamespace(_capture_completed=True)
            family=types.SimpleNamespace(_capture_completed=True)
            report={'physicalEntries':{'root':{'retained':{}},'vendor':{}},
                'hardlinkFamilies':{'family':{'owner':None}}}
            ports={('root','uninserted'):completed,('root','retained'):retained}
            missing=capture._unrepresented_source_owners(report,ports,{'family':family})
            self.assertEqual([id(port) for port in missing],[id(completed),id(family)])
            report['physicalEntries']['root']['uninserted']={};report['hardlinkFamilies']['family']['owner']={}
            self.assertEqual(capture._unrepresented_source_owners(report,ports,{'family':family}),[])
            final_scope=ledger.new_scope('final-validation')
            retained_report={'physicalEntries':{'root':{'owned':{'nativeProof':'complete'}}},'complete':True}
            def final_refusal(*args,**kwargs):
                kwargs['failure_evidence'].capture_report=retained_report
                raise capture.CaptureRefused('synthetic-post-close-validation-refusal',retained_report)
            with patch.object(capture,'capture_physical_graph',final_refusal):
                with self.assertRaises(capture.CaptureRefused) as final:
                    capture.capture_closed_tree(root,root/'unused',vendor_root=root/'unused-vendor',
                        limits={},deadline=time.monotonic()+30,representation='physical-graph-v3',failure_evidence=final_scope)
            primary=self.records(final.exception.observations['failureEvidence'])[0]
            self.assertEqual(primary['observations']['captureReport'],retained_report)
            self.assertEqual(primary['observations']['failureObservationsRef'],'captureReport')
            self.assertNotIn('failureObservations',primary['observations'])
            self.assertIsNone(final_scope.capture_report);ledger.require_idle()

    def test_graph_abort_has_small_references_and_writer_failure_cannot_interrupt_close(self):
        for failed_writer in (False,True):
            with self.subTest(failed_writer=failed_writer),tempfile.TemporaryDirectory(prefix='nova-failure-graph-') as temp:
                scratch=Path(temp);root=scratch/'source';vendor=scratch/'vendor';root.mkdir();vendor.mkdir()
                for name in ('a-owned.py','b-owned.py','z-refuse.py'):(root/name).write_bytes(b'fixture')
                ledger=evidence.FailureEvidenceLedger(scratch/'evidence');scope=ledger.new_scope('graph')
                fixture=fixtures.AbortFixture();fixture.clock_values=[1000,1100,1100,1200]
                original=copy.deepcopy(fixture.row);opened=[]
                with self.environment(fixture):
                    baseline=fixture.baseline_type()
                    class Directory(fixtures.graph.FakeHeld):
                        def list_names(self,*,max_entries,max_pages):return sorted(p.name for p in self.path.iterdir())
                    def metadata(path,kind,deadline,**options):
                        if Path(path).name in ('a-owned.py','b-owned.py'):return baseline(path,kind,deadline,**options)
                        return Directory(Path(path),kind,deadline)
                    def source(path,kind,deadline,**options):
                        if kind!='file':return Directory(Path(path),kind,deadline)
                        if Path(path).name=='z-refuse.py':raise capture.CaptureRefused('synthetic-inventory-open-refusal')
                        port=neutral.NeutralHeld(path,kind,deadline,**options);opened.append(port);return port
                    limits={'node':'C:/unused-node.exe','maxEntries':20,'maxBytes':4096,'maxFileBytes':256,
                        'maxDepth':8,'maxAliases':3,'maxReportBytes':16*1024**2}
                    def refuse_write(_writer,_value):raise OSError('synthetic segment write refusal')
                    writer=patch.object(evidence.Transcript,'write',refuse_write) if failed_writer else patch.object(evidence,'SEGMENT_BYTES',evidence.SEGMENT_BYTES)
                    with patch.object(capture,'_Held',metadata),patch.object(neutral,'open_source',source),\
                         patch.object(capture,'_windows_required'),patch.object(capture,'_identity_join'),writer:
                        with self.assertRaises(capture.CaptureRefused) as failure:
                            capture.capture_closed_tree(root,scratch/'image',vendor_root=vendor,limits=limits,
                                deadline=time.monotonic()+30,representation='physical-graph-v3',failure_evidence=scope)
                    report=failure.exception.observations
                    self.assertTrue(report['allHandlesClosed']);self.assertEqual(len(opened),2,report)
                    self.assertTrue(all(port.closed for port in opened));self.assertTrue(all(p.closes==1 for p in fixture.ports))
                    self.assertEqual(fixture.row,original);self.assertFalse((scratch/'image').exists())
                    self.assertLess(len(evidence.encoded(report)),limits['maxReportBytes'])
                    self.assertNotIn('failureObservations',report);self.assertNotIn('physicalEntries',report)
                    self.assertEqual(report['failureEvidence']['complete'],not failed_writer)
                    if not failed_writer:
                        rows=self.records(report['failureEvidence'])
                        self.assertEqual(sum(row['kind']=='aborted-source-owner' for row in rows),2)
                        self.assertEqual(sum(row['kind']=='primary-capture-failure' for row in rows),1)
                    else:self.assertGreater(ledger.receipt()['uncertainBytes'],0)
                    ledger.require_idle()


if __name__=='__main__':unittest.main()
