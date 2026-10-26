"""New family copy/consumer contracts only. No native calls or source reads."""
import copy
import importlib.util
from pathlib import Path
import time
import unittest
from unittest.mock import patch


HERE=Path(__file__).resolve().parent


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


fixture=load('hardlink_copy_fixture',HERE/'local-windows-hardlink-family.test.py')
entry=load('hardlink_copy_entry',HERE.parent/'scripts/local-native-retained-qualification.py')
clone=fixture.base.clone
capture=fixture.capture
LocalRetainedContext=fixture.base.LocalRetainedContext


def set_identity(row,number):
    row['information'].update(fileIndex64=number,fileId128Hex=number.to_bytes(16,'little').hex())
    for field in ('before','after','openedInformation'):
        row['nativeObservations'][field]=copy.deepcopy(row['information'])
    if 'nodeIdentity' in row:
        row['nodeIdentity']=fixture.base.node_identity(row['information'])
        if row['kind']=='directory':row['nodeIdentity']['size']='0'
        row['nodeIdentityBefore']=copy.deepcopy(row['nodeIdentity'])


def case():
    before=fixture.family_graph()
    before['physicalEntries']['root']['local/other.txt']=fixture.base.source_row(
        'root','local/other.txt','file',21,payload=b'independent singleton')
    before['physicalEntries']['root']['local']['members'].append('other.txt')
    before['physicalEntries']['root']['local']['members'].sort()
    fixture.base.recount(before)
    working=copy.deepcopy(before)
    for row in working['physicalEntries']['root'].values():set_identity(row,row['information']['fileIndex64']+1000)
    for family in working['hardlinkFamilies'].values():
        if family['role']=='root':set_identity(family['owner'],family['owner']['information']['fileIndex64']+1000)
    for edge in working['junctions']:
        identity=working['physicalEntries'][edge['targetRole']][edge['targetPath']]['nodeIdentity']
        edge['targetNodeIdentityBefore']=copy.deepcopy(identity);edge['targetNodeIdentityAfter']=copy.deepcopy(identity)
    fixture.base.recount(working)
    target=Path('C:/synthetic-hardlink-working')
    authority={'kind':'local-windows-working-copy','complete':True,'allHandlesClosed':True,
        'sourceChildrenWritten':False,'renamesPerformed':False,'sourceRoot':before['sourceRoot'],
        'destinationRoot':str(target),'independentIdsOnly':True,'directoryStorageDerived':False,
        'entries':{},'handles':[],'hardlinkFamilies':{}}
    for key,row in working['physicalEntries']['root'].items():
        if row['kind']=='junction':continue
        actual={field:copy.deepcopy(row[field]) for field in ('kind','information','security','streams')}
        old=before['physicalEntries']['root'][key]
        if row['kind']=='directory':
            actual['directoryStorageDerivation']={'kind':'independent-directory-index-storage',
                'sourcePath':old['physicalPath'],'sourceInformation':copy.deepcopy(old['information']),
                'sourceMembers':copy.deepcopy(old['members']),'targetInformationRef':'information','membersExactlyCreated':True}
        else:actual.update(bytes=row['bytes'],sha256=row['sha256'])
        authority['entries'][key]=actual
        observed=copy.deepcopy(row['nativeObservations'])
        observed.update(path=str(target/capture._relative(key)),kind=row['kind'],streams=copy.deepcopy(row['streams']))
        authority['handles'].append(observed)
    for representative,members in capture.graph_family_map(before,'root').items():
        authority['hardlinkFamilies'][representative]={
            'kind':'independent-closed-hardlink-family','sourceRepresentative':representative,
            'sourceInformation':copy.deepcopy(before['physicalEntries']['root'][representative]['information']),
            'members':members,'targetInformationRef':{'entry':representative,'field':'information'},
            'memberHandlePaths':{name:str(target/capture._relative(name)) for name in members},
            'linkEvents':[{'sequence':0,'api':'CreateHardLinkW:owned-family','arguments':{
                'path':str(target/capture._relative(name)),
                'existingPath':str(target/capture._relative(representative)),'reserved':None},
                'result':1,'lastError':0} for name in members[1:]]}
    for field in ('Information','Security','Streams'):
        authority['root'+field]=copy.deepcopy(authority['entries']['.'][field.lower()])
    return before,working,authority


def change_authority_identity(authority,key,info):
    row=authority['entries'][key]
    for field in clone.IDENTITY_FIELDS:row['information'][field]=info[field]
    path=str(Path(authority['destinationRoot'])/capture._relative(key))
    observed=next(value for value in authority['handles'] if value['path']==path)
    for field in ('before','after','openedInformation'):observed[field]=copy.deepcopy(row['information'])


class HardlinkCopyContracts(unittest.TestCase):
    def setUp(self):
        self.guard=patch.object(capture.ctypes,'WinDLL',side_effect=AssertionError('native API forbidden'),create=True)
        self.guard.start()

    def tearDown(self):self.guard.stop()

    def test_family_plan_keeps_flat_images_and_binds_real_owner(self):
        before,_,_=case()
        limits={key:before['limits'][key] for key in ('maxEntries','maxBytes','maxFileBytes','maxAliases')}
        limits['maxReportBytes']=8*1024**2
        plan=clone.physical_plan(before,Path('C:/synthetic-hardlink-working'),limits=limits)
        self.assertEqual(plan['hardlinkFamilies'],{'local/saved-alias.sqlite':['local/saved-alias.sqlite','local/saved.sqlite']})
        files={row['key']:row for row in plan['rows'] if row['kind']=='file'}
        self.assertNotEqual(files['local/saved-alias.sqlite']['imagePath'],files['local/saved.sqlite']['imagePath'])
        self.assertEqual(files['local/saved.sqlite']['expected']['information']['links'],2)
        self.assertEqual(files['local/saved.sqlite']['expected']['nativeObservations']['sourceObservationMode'],
                         'metadata-only-hardlink-member')
        self.assertEqual(plan['bytes'],sum(row['expected']['bytes'] for row in files.values()))

    def test_prestart_binds_complete_target_family_and_original_return_remains_exact(self):
        before,working,authority=case()
        result=entry.assert_working_baseline(before,working,clone_authority=authority)
        self.assertTrue(result['completePreStartEquality']);self.assertEqual(result['copiedHardlinkFamiliesBound'],1)
        with self.assertRaises(RuntimeError):entry.assert_working_baseline(before,working)
        self.assertTrue(entry.assert_restored(before,copy.deepcopy(before))['completePhysicalReturn'])
        with self.assertRaises(RuntimeError):entry.assert_restored(before,working)
        changed=copy.deepcopy(working);family=next(iter(changed['hardlinkFamilies'].values()))
        for name in family['members']:set_identity(changed['physicalEntries']['root'][name],7000)
        set_identity(family['owner'],7000);fixture.base.recount(changed)
        with self.assertRaises(RuntimeError):entry.assert_working_baseline(before,changed,clone_authority=authority)

    def test_refuses_split_merge_source_reuse_and_incomplete_family_creation(self):
        for mutation in ('split','merge','source-reuse','missing-proof','source-tuple','members','link-failed','link-path','unclosed'):
            with self.subTest(mutation=mutation):
                before,_,authority=case();proof=authority['hardlinkFamilies']['local/saved-alias.sqlite']
                if mutation=='split':
                    changed=dict(authority['entries']['local/saved.sqlite']['information'],fileIndex64=8000,
                                 fileId128Hex=(8000).to_bytes(16,'little').hex())
                    change_authority_identity(authority,'local/saved.sqlite',changed)
                elif mutation=='merge':
                    change_authority_identity(authority,'local/other.txt',authority['entries']['local/saved.sqlite']['information'])
                elif mutation=='source-reuse':
                    info=before['physicalEntries']['vendor']['pkg/payload.js']['information']
                    for name in proof['members']:change_authority_identity(authority,name,info)
                elif mutation=='missing-proof':authority['hardlinkFamilies']={}
                elif mutation=='source-tuple':proof['sourceInformation']['access100ns']+=1
                elif mutation=='members':proof['members']=proof['members'][:1]
                elif mutation=='link-failed':proof['linkEvents'][0]['result']=0
                elif mutation=='link-path':proof['linkEvents'][0]['arguments']['existingPath']=before['sourceRoot']
                else:authority['handles'][-1]['handleClosed']=False
                with self.assertRaises(RuntimeError):entry.working_file_authority(before,authority)

    def test_explicit_format3_context_resolves_source_identity_without_live_fallback(self):
        before,after,_=case();after['startedEpochMs']=1400;after['endedEpochMs']=1500
        storage=Path('C:/synthetic-hardlink-after')
        after.update(storageRoot=str(storage),destinationRoot=str(storage/'root'),vendorDestinationRoot=str(storage/'vendor'))
        for edge in after['junctions']:
            edge['imagePath']=str(storage/edge['sourceRole']/edge['path'])
            target=storage/edge['targetRole']/edge['targetPath']
            edge['imageRawTarget']='\\\\?\\'+str(target);edge['imageCanonicalTarget']=str(target)
        fixture.base.recount(after)
        with patch.object(capture,'verify_capture_content',return_value=True):
            context=LocalRetainedContext(before,after,node=None,startup_window=(1200,1300),
                catalog_runtime_root=before['vendorRoot'],configuration_derivation={'kind':'no-managed-native-config'},
                deadline=time.monotonic()+30)
        first=Path(after['sourceRoot'])/'local/saved-alias.sqlite';second=Path(after['sourceRoot'])/'local/saved.sqlite'
        self.assertNotEqual(context.image_path(first),context.image_path(second))
        self.assertEqual(context.source_identity_tuple(first),context.source_identity_tuple(second))
        self.assertEqual(context.entry(first)['information']['links'],2)
        missing=Path(after['sourceRoot'])/'missing'
        self.assertEqual(context.image_path(missing),storage/'root/missing')
        self.assertEqual(entry.qualification_representation({}),'physical-graph-v2')
        self.assertEqual(entry.qualification_representation({'captureRepresentation':'physical-graph-v3'}),'physical-graph-v3')
        for value in ('expanded-v1','physical-graph-v4',None):
            with self.assertRaises(RuntimeError):entry.qualification_representation({'captureRepresentation':value})


if __name__=='__main__':unittest.main()
