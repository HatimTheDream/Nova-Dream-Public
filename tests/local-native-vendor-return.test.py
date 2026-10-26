"""Pure vendor startup/return-chain boundaries; no native execution or file probe."""
import copy
import importlib.util
from pathlib import Path
import unittest


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module);return module


HERE=Path(__file__).resolve().parent
fixture=load('vendor_return_graph_fixture',HERE/'local-windows-physical-graph.test.py')
entry=load('vendor_return_entry',HERE.parent/'scripts/local-native-retained-qualification.py')


def change_access(value,role,key,timestamp):
    row=value['physicalEntries'][role][key];row['information']['access100ns']=timestamp
    for name in ('before','after','openedInformation'):row['nativeObservations'][name]=copy.deepcopy(row['information'])


def case():
    baseline=fixture.graph();before=copy.deepcopy(baseline);after=copy.deepcopy(baseline);returned=copy.deepcopy(baseline)
    for value,(start,end) in zip((baseline,before,after,returned),((1000,1100),(1200,1300),(3100,3200),(3300,3400))):
        value.update(startedEpochMs=start,endedEpochMs=end)
    for value in (after,returned):change_access(value,'vendor','pkg/payload.js',fixture.EPOCH+2500*10000)
    host={'format':1,'kind':'local-native-retained-host-result','operationId':'owned-op',
        'workspaceRoot':baseline['sourceRoot'],'ready':True,'passed':True,'closed':True,'providerRequestSubmitted':False,
        'startedEpochMs':2000,'endedEpochMs':3000,'observedNativePids':[30],'observer':{'pid':20},
        'nativeIdentity':{'pid':30,'epoch':'owned-epoch','generation':'owned-generation','version':'2026.9.8','startedAt':2100}}
    for value in (baseline,before,after,returned):fixture.recount(value)
    return baseline,before,after,returned,host


class VendorReturnTests(unittest.TestCase):
    def check(self,values):return entry.assert_native_return_chain(*values,operation_id='owned-op')

    def test_exact_workspace_return_and_bounded_vendor_transition_are_explicit(self):
        values=case();result=self.check(values)
        self.assertTrue(result['completeWorkspaceReturn']);self.assertTrue(result['vendorBeforeStartupExact'])
        self.assertTrue(result['vendorAfterStartupToReturnExact'])
        transition=result['vendorAccessTransition']
        self.assertFalse(transition['readerIdentityAttributed']);self.assertEqual(transition['changedCount'],1)
        self.assertEqual(transition['changes'],[{'relativePath':'pkg/payload.js','kind':'file',
            'beforeAccess100ns':fixture.EPOCH+20000,'afterAccess100ns':fixture.EPOCH+2500*10000}])
        self.assertNotIn('completePhysicalReturn',result)
        with self.assertRaises(RuntimeError):entry.assert_restored(values[0],values[3])
        same=case()
        for value in (same[2],same[3]):
            change_access(value,'vendor','pkg/payload.js',fixture.EPOCH+20000);fixture.recount(value)
        self.assertEqual(self.check(same)['vendorAccessTransition']['changedCount'],0)

    def test_wrong_host_window_identity_and_prestart_or_return_drift_refuse(self):
        for mutation in ('early','late','backward','wrong-op','wrong-workspace','failed','unclosed','pid',
                         'observer','chronology','vendor-prestart','vendor-return','root-return'):
            with self.subTest(mutation=mutation):
                values=case();baseline,before,after,returned,host=values
                if mutation in ('early','late','backward'):
                    timestamp={'early':fixture.EPOCH+1999*10000,'late':fixture.EPOCH+3001*10000,
                               'backward':fixture.EPOCH+1}[mutation]
                    for value in (after,returned):change_access(value,'vendor','pkg/payload.js',timestamp)
                elif mutation=='wrong-op':host['operationId']='other-op'
                elif mutation=='wrong-workspace':host['workspaceRoot']='C:/other'
                elif mutation=='failed':host['passed']=False
                elif mutation=='unclosed':host['closed']=False
                elif mutation=='pid':host['nativeIdentity']['pid']=99
                elif mutation=='observer':host['observer']['pid']=0
                elif mutation=='chronology':before['endedEpochMs']=2001
                elif mutation=='vendor-prestart':change_access(before,'vendor','pkg/payload.js',fixture.EPOCH+1500*10000)
                elif mutation=='vendor-return':change_access(returned,'vendor','pkg/payload.js',fixture.EPOCH+2800*10000)
                else:change_access(returned,'root','local/saved.sqlite',fixture.EPOCH+2500*10000)
                for value in values[:4]:fixture.recount(value)
                with self.assertRaises(RuntimeError):self.check(values)

    def test_vendor_content_members_and_nonaccess_metadata_are_never_exempt(self):
        for mutation in ('content','member','metadata'):
            with self.subTest(mutation=mutation):
                values=case();baseline,before,after,returned,host=values
                for value in (after,returned):
                    if mutation=='content':value['physicalEntries']['vendor']['pkg/payload.js']['sha256']='a'*64
                    elif mutation=='member':
                        value['physicalEntries']['vendor']['pkg/new.txt']=fixture.source_row('vendor','pkg/new.txt','file',500,payload=b'new')
                        value['physicalEntries']['vendor']['pkg']['members'].append('new.txt')
                        value['physicalEntries']['vendor']['pkg']['members'].sort()
                        value['limits']['maxEntries']=11
                    else:
                        row=value['physicalEntries']['vendor']['pkg/payload.js'];row['information']['attributes']|=2
                        for key in ('before','after','openedInformation'):row['nativeObservations'][key]=copy.deepcopy(row['information'])
                    fixture.recount(value)
                with self.assertRaises(RuntimeError):self.check(values)


if __name__=='__main__':unittest.main()
