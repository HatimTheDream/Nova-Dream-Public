"""Inert comparison-only regression; no capture, process or filesystem mutation."""
import copy
import importlib.util
from pathlib import Path
import unittest

path=Path(__file__).resolve().parents[1]/'scripts/local-native-retained-qualification.py'
spec=importlib.util.spec_from_file_location('local_retained_entry_test',path)
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)


def fixture():
    info={'allNativeFields':'synthetic-exact-info'}
    security={'ownerGroupDaclBase64':'synthetic-exact-descriptor','saclNotRequested':True}
    observations={'handleClosed':True,'before':info,'after':info,
        'ownerGroupDaclBeforeBase64':security['ownerGroupDaclBase64'],
        'ownerGroupDaclAfterBase64':security['ownerGroupDaclBase64']}
    row={'kind':'file','physicalPath':'C:/owned/a','bytes':3,'sha256':'a'*64,
        'information':info,'security':security,'streams':['synthetic-default-stream'],
        'nodeIdentity':{'allFields':'original-source'},'nodeIdentityBefore':{'allFields':'original-source'},
        'sameHandleStable':True,'nativeObservations':observations}
    link={**row,'path':'link','physicalPath':'C:/owned/link','rawTarget':'C:/owned/target',
          'canonicalTarget':'C:/owned/target','targetRole':'root'}
    return {'format':1,'kind':'local-windows-closed-tree','complete':True,'allHandlesClosed':True,
        'primitiveSha256':entry.capture.PRIMITIVE_SHA256,'saclNotRequested':True,
        'sourceRoot':'C:/owned','canonicalSourceRoot':'C:/owned','entries':{'a':row},'junctions':[link]}


class RestorationCompare(unittest.TestCase):
    def test_full_physical_return_refuses_each_changed_authority(self):
        before=fixture()
        self.assertTrue(entry.assert_restored(before,copy.deepcopy(before))['completePhysicalReturn'])
        mutations=[lambda x:x['entries']['a'].__setitem__('sha256','b'*64),
                   lambda x:x['entries']['a']['nodeIdentity'].__setitem__('allFields','copy-id'),
                   lambda x:x['entries']['a']['information'].__setitem__('allNativeFields','changed-attribute'),
                   lambda x:x['junctions'][0].__setitem__('rawTarget','C:/other'),
                   lambda x:x['junctions'][0]['security'].__setitem__('ownerGroupDaclBase64','changed-DACL'),
                   lambda x:x['junctions'][0]['nativeObservations'].__setitem__('handleClosed',False)]
        for mutate in mutations:
            after=copy.deepcopy(before);mutate(after)
            with self.subTest(mutate=mutate),self.assertRaises(RuntimeError):
                entry.assert_restored(before,after)
        self.assertEqual(before,fixture(),'Comparison does not change preserved BEFORE evidence')


if __name__=='__main__':
    unittest.main()
