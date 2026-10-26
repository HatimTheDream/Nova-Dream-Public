"""Only inert entry-boundary cases; never dispatches or mutates a filesystem."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

path=Path(__file__).resolve().parents[1]/'scripts/local-native-retained-qualification.py'
spec=importlib.util.spec_from_file_location('local_entry_boundaries',path)
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)


def captured(index=10):
    epoch=116444736000000000
    info={'fileIndex64':index,'fileId128Hex':index.to_bytes(16,'little').hex(),
          'volumeSerial32':1,'volumeSerial64':1,'directory':False,'size':3,
          'creation100ns':epoch,'write100ns':epoch,'access100ns':epoch,'change100ns':epoch,
          'attributes':32,'reparseTag':0,'links':1,'deletePending':False,'allocationBytes':4096}
    sec={'ownerGroupDaclBase64':'synthetic-descriptor','saclNotRequested':True}
    node={k:str(v) for k,v in {'dev':1,'ino':index,'mode':0o100666,'size':3,
                              'mtimeNs':0,'ctimeNs':0,'birthtimeNs':0}.items()}
    row={'kind':'file','physicalPath':str(Path('C:/owned/a')),'bytes':3,'sha256':'a'*64,
         'information':info,'security':sec,'streams':[{'name':'::$DATA','bytes':3,'allocationBytes':4096}],
         'nodeIdentity':node,'nodeIdentityBefore':node,'sameHandleStable':True,
         'nativeObservations':{'before':info,'after':info,'handleClosed':True,
             'ownerGroupDaclBeforeBase64':sec['ownerGroupDaclBase64'],
             'ownerGroupDaclAfterBase64':sec['ownerGroupDaclBase64']}}
    link=copy.deepcopy(row);link.update(path='link',physicalPath=str(Path('C:/owned/link')),
        rawTarget='C:/owned/a',canonicalTarget='C:/owned/a',targetRole='root')
    return {'format':1,'kind':'local-windows-closed-tree','complete':True,'allHandlesClosed':True,
            'primitiveSha256':entry.capture.PRIMITIVE_SHA256,'saclNotRequested':True,
            'sourceRoot':str(Path('C:/owned')),'canonicalSourceRoot':str(Path('C:/owned')),
            'entries':{'a':row},'junctions':[link]}


class EntryBoundaries(unittest.TestCase):
    def test_prestart_complete_equality_only_allows_new_physical_ids(self):
        before,working=captured(10),captured(20)
        self.assertTrue(entry.assert_working_baseline(before,working)['completePreStartEquality'])
        changes=[lambda c:c['entries'].clear(),lambda c:c['entries']['a'].__setitem__('sha256','b'*64),
                 lambda c:c['entries']['a']['information'].__setitem__('access100ns',1),
                 lambda c:c['entries']['a']['security'].__setitem__('ownerGroupDaclBase64','changed'),
                 lambda c:c['junctions'][0].__setitem__('rawTarget','C:/other'),
                 lambda c:c['entries']['a']['nodeIdentity'].__setitem__('mode',str(0o100444)),
                 lambda c:c['entries']['a']['nativeObservations'].__setitem__('handleClosed',False)]
        for change in changes:
            changed=copy.deepcopy(working);change(changed)
            with self.subTest(change=change),self.assertRaises(RuntimeError):
                entry.assert_working_baseline(before,changed)
        with self.assertRaises(RuntimeError):entry.assert_working_baseline(before,copy.deepcopy(before))
        self.assertEqual(before,captured(10))

    def test_failure_before_dispatch_and_uncertain_dispatch_are_distinct(self):
        plan={'readyTimeoutMs':1000,'operationId':'test','sourceRoot':'C:/owned','releaseRoot':'C:/release',
              'vendorRoot':'C:/vendor','node':'C:/node.exe','candidate':{'version':'2.28.10','buildVersion':'1.0.383'}}
        state={'dispatchAttempted':False,'closed':False}
        with (patch.object(entry.time,'monotonic',return_value=0),patch.object(entry,'save',side_effect=OSError('save')),
              patch.object(entry.subprocess,'Popen') as popen):
            with self.assertRaises(OSError):entry.run_host(plan,Path('C:/evidence'),100,200,state)
            popen.assert_not_called();self.assertFalse(state['dispatchAttempted'])
        with (patch.object(entry.time,'monotonic',return_value=0),patch.object(entry,'save'),
              patch.object(Path,'open',return_value=MagicMock()),patch.object(entry.subprocess,'Popen',side_effect=OSError('dispatch'))):
            with self.assertRaises(OSError):entry.run_host(plan,Path('C:/evidence'),100,200,state)
            self.assertTrue(state['dispatchAttempted']);self.assertFalse(state['closed'])

    def test_late_close_retains_original_failure(self):
        original={'operationId':'op','observer':{'pid':123,'node':'C:/node.exe'},'closed':False,'passed':False}
        close={'operationId':'op','closed':True,'observedAt':'2026-10-26T00:00:00Z'}
        with (patch.object(entry,'json_read',side_effect=[(original,'a'*64),(close,'b'*64)]),
              patch.object(entry.os.path,'lexists',return_value=True)):
            result,refs=entry.reconcile_host_close(Path('C:/result.json'),'op',123,'C:/node.exe')
            self.assertIs(result,original);self.assertFalse(result['passed']);self.assertFalse(result['closed']);self.assertEqual(len(refs),2)
        with (patch.object(entry,'json_read',side_effect=[(original,'a'*64),({'operationId':'other','closed':True},'b'*64)]),
              patch.object(entry.os.path,'lexists',return_value=True)):
            with self.assertRaises(RuntimeError):entry.reconcile_host_close(Path('C:/result.json'),'op',123,'C:/node.exe')

    def test_rename_binds_capture_identity_and_preserves_intent_on_failure(self):
        source,target=Path('C:/owned'),Path('C:/parked')
        info={'volumeSerial64':7,'fileId128Hex':(12).to_bytes(16,'little').hex()}
        row=SimpleNamespace(st_dev=7,st_ino=12,st_mode=0o40755,st_file_attributes=16)
        state={};saved=[]
        with (patch.object(entry.capture,'_check'),patch.object(Path,'lstat',return_value=row),
             patch.object(entry.os.path,'lexists',return_value=False),
             patch.object(entry,'save',side_effect=lambda p,v:saved.append((str(p),v))),
             patch.object(entry.os,'rename',side_effect=OSError('rename'))):
            with self.assertRaises(OSError):entry.rename_role(source,target,info,100,operation_id='op',phase='park',evidence=Path('C:/evidence'),state=state)
        self.assertEqual(state,{'park':'attempted'});self.assertEqual(len(saved),1)
        self.assertEqual(saved[0][1]['expectedInformation'],info)
        with (patch.object(entry.capture,'_check'),patch.object(Path,'lstat',return_value=row),
              patch.object(entry.os.path,'lexists',return_value=False),patch.object(entry.os,'rename') as rename):
            with self.assertRaises(RuntimeError):entry.rename_role(source,target,{**info,'volumeSerial64':8},100,
                operation_id='op',phase='park',evidence=Path('C:/evidence'),state={})
            rename.assert_not_called()


if __name__=='__main__':unittest.main()
