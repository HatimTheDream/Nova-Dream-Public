"""Only independent-directory construction boundaries; no native operations."""
import copy
import importlib.util
from pathlib import Path
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module);return module


HERE=Path(__file__).resolve().parent
graph_fixture=load('directory_storage_graph_fixture',HERE/'local-windows-physical-graph.test.py')
entry=load('directory_storage_entry',HERE.parent/'scripts/local-native-retained-qualification.py')
clone=graph_fixture.clone


def set_information(row,**changes):
    row['information'].update(changes)
    for key in ('before','after','openedInformation'):
        row['nativeObservations'][key]=copy.deepcopy(row['information'])
    if row['kind']!='junction':
        row['nodeIdentity']=graph_fixture.node_identity(row['information'])
        if row['kind']=='directory':row['nodeIdentity']['size']='0'
        row['nodeIdentityBefore']=copy.deepcopy(row['nodeIdentity'])


def case():
    before=graph_fixture.graph();set_information(before['physicalEntries']['root']['local'],size=65536,allocationBytes=65536)
    working=copy.deepcopy(before)
    for row in working['physicalEntries']['root'].values():
        index=row['information']['fileIndex64']+1000
        set_information(row,fileIndex64=index,fileId128Hex=index.to_bytes(16,'little').hex())
    set_information(working['physicalEntries']['root']['local'],size=81920,allocationBytes=81920)
    for edge in working['junctions']:
        identity=working['physicalEntries'][edge['targetRole']][edge['targetPath']]['nodeIdentity']
        edge['targetNodeIdentityBefore']=copy.deepcopy(identity);edge['targetNodeIdentityAfter']=copy.deepcopy(identity)
    target=Path('C:/synthetic-graph-working')
    authority={'kind':'local-windows-working-copy','complete':True,'allHandlesClosed':True,
        'sourceChildrenWritten':False,'renamesPerformed':False,'sourceRoot':before['sourceRoot'],
        'destinationRoot':str(target),'independentIdsOnly':False,'directoryStorageDerived':True,'entries':{},'handles':[]}
    for key,row in working['physicalEntries']['root'].items():
        if row['kind']=='junction':continue
        actual={field:copy.deepcopy(row[field]) for field in ('kind','information','security','streams')}
        if row['kind']=='directory':
            old=before['physicalEntries']['root'][key]
            actual['directoryStorageDerivation']={'kind':'independent-directory-index-storage',
                'sourcePath':old['physicalPath'],'sourceInformation':copy.deepcopy(old['information']),
                'sourceMembers':copy.deepcopy(old['members']),'targetInformationRef':'information','membersExactlyCreated':True}
        authority['entries'][key]=actual
        observed=copy.deepcopy(row['nativeObservations']);observed.update(path=str(target/entry.capture._relative(key)),
            kind=row['kind'],streams=copy.deepcopy(row['streams']))
        authority['handles'].append(observed)
    for field in ('Information','Security','Streams'):authority['root'+field]=copy.deepcopy(authority['entries']['.'][field.lower()])
    graph_fixture.recount(before);graph_fixture.recount(working)
    return before,working,authority


class DirectoryStorageTests(unittest.TestCase):
    def test_only_new_ordinary_directory_storage_can_be_derived(self):
        before,working,_=case();old=before['physicalEntries']['root']['local']['information'];new=working['physicalEntries']['root']['local']['information']
        clone._same_metadata(old,new,True,derive_directory_storage=True)
        for independent,derive in ((True,False),(False,True),(False,False)):
            with self.subTest(independent=independent,derive=derive),self.assertRaises(clone.CloneRefused):
                clone._same_metadata(old,new,independent,derive_directory_storage=derive)
        for kind in ('file','junction'):
            left=graph_fixture.information(200,kind,65536);right=copy.deepcopy(left)
            right.update(fileIndex64=201,fileId128Hex=(201).to_bytes(16,'little').hex(),size=81920,allocationBytes=81920)
            with self.subTest(kind=kind),self.assertRaises(clone.CloneRefused):
                clone._same_metadata(left,right,True,derive_directory_storage=True)
        changed=copy.deepcopy(new);changed['access100ns']+=1
        with self.assertRaises(clone.CloneRefused):clone._same_metadata(old,changed,True,derive_directory_storage=True)

    def test_prestart_binds_exact_completed_directory_authority_and_return_stays_strict(self):
        before,working,authority=case()
        result=entry.assert_working_baseline(before,working,clone_authority=authority)
        self.assertTrue(result['completePreStartEquality']);self.assertTrue(result['copiedDirectoryStorageBound'])
        self.assertFalse(result['onlyCopiedPhysicalIdsDiffer'])
        self.assertEqual(result['directoryStorageDerivation'],{'boundCount':2,'changedCount':1,
            'fields':['size','allocationBytes'],'exactTargetTupleMatched':True})
        with self.assertRaises(RuntimeError):entry.assert_working_baseline(before,working)
        with self.assertRaises(RuntimeError):entry.compare_graph_captures(before,working,independent=False,clone_authority=authority)
        for mutation in ('size','identity','members','source-tuple','unclosed','vendor'):
            with self.subTest(mutation=mutation):
                changed=copy.deepcopy(working);proof=copy.deepcopy(authority)
                if mutation=='size':set_information(changed['physicalEntries']['root']['local'],size=86016,allocationBytes=86016)
                elif mutation=='identity':
                    set_information(changed['physicalEntries']['root']['local'],fileIndex64=5555,fileId128Hex=(5555).to_bytes(16,'little').hex())
                    for edge in changed['junctions']:
                        if edge['targetRole']=='root' and edge['targetPath']=='local':
                            edge['targetNodeIdentityBefore']=copy.deepcopy(changed['physicalEntries']['root']['local']['nodeIdentity'])
                            edge['targetNodeIdentityAfter']=copy.deepcopy(edge['targetNodeIdentityBefore'])
                elif mutation=='members':proof['entries']['local']['directoryStorageDerivation']['sourceMembers']=[]
                elif mutation=='source-tuple':proof['entries']['local']['directoryStorageDerivation']['sourceInformation']['size']+=4096
                elif mutation=='unclosed':proof['allHandlesClosed']=False
                else:set_information(changed['physicalEntries']['vendor']['pkg'],size=4096,allocationBytes=4096)
                graph_fixture.recount(changed)
                with self.assertRaises(RuntimeError):entry.assert_working_baseline(before,changed,clone_authority=proof)
        restored=copy.deepcopy(before);set_information(restored['physicalEntries']['root']['local'],size=81920,allocationBytes=81920)
        graph_fixture.recount(restored)
        with self.assertRaises(RuntimeError):entry.compare_graph_captures(before,restored,independent=False)

    def test_complete_created_member_roster_is_observed_before_derivation(self):
        class Scan:
            def __init__(self,names):self.names=names
            def __enter__(self):return iter(SimpleNamespace(name=name) for name in self.names)
            def __exit__(self,*args):return False
        with patch.object(clone.os,'scandir',return_value=Scan(['b','a'])):
            self.assertEqual(clone.copied_directory_members(Path('C:/owned'),['a','b'],time.monotonic()+30),['a','b'])
        for names in (['a'],['a','b','extra'],['a','wrong']):
            with self.subTest(names=names),patch.object(clone.os,'scandir',return_value=Scan(names)),self.assertRaises(clone.CloneRefused):
                clone.copied_directory_members(Path('C:/owned'),['a','b'],time.monotonic()+30)


if __name__=='__main__':unittest.main()
