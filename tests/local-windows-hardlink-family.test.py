"""Only new format3 contracts; synthetic evidence never represents live proof.

The separate real Windows capture/clone/return fixture proves native behavior.
Importing the older graph fixture does not execute any previously passed test.
"""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'deploy/update-runner'))
import local_windows_capture as capture

spec = importlib.util.spec_from_file_location('base_graph_fixture',HERE/'local-windows-physical-graph.test.py')
base = importlib.util.module_from_spec(spec);spec.loader.exec_module(base)


def family_graph():
    """Pure two-name family plus original independent singleton rows."""
    value=base.graph();value['format']=3;value['limits']['maxEntries']=20
    rows=value['physicalEntries']['root'];original=rows['local/saved.sqlite']
    original['information']['links']=2
    members=['local/saved-alias.sqlite','local/saved.sqlite'];family_key='root:'+members[0]
    rows[members[0]]=copy.deepcopy(original)
    rows['local']['members']=['saved-alias.sqlite','saved.sqlite']
    owner={k:copy.deepcopy(original[k]) for k in ('information','security','streams','sameHandleStable','nativeObservations')}
    owner['physicalPath']=str(Path(value['sourceRoot'])/members[0])
    obs=owner['nativeObservations']
    for name in ('before','after','openedInformation'):obs[name]=copy.deepcopy(owner['information'])
    obs.update(path=owner['physicalPath'],kind='file',expectedLinks=2,
               sourceObservationMode='neutral-hardlink-family-owner',
               readResult={'bytes':original['bytes'],'sha256':original['sha256'],'complete':True,'eof':True})
    for key in members:
        row=rows[key];row['familyKey']=family_key
        row['physicalPath']=str(Path(value['sourceRoot'])/key)
        row['imageRelativePath']=(Path('root')/key).as_posix()
        row['nativeObservations']={'path':row['physicalPath'],'kind':'file','expectedLinks':2,
            'sourceObservationMode':'metadata-only-hardlink-member',
            'openedInformation':copy.deepcopy(row['information']),
            'before':copy.deepcopy(row['information']),'after':copy.deepcopy(row['information']),
            'ownerGroupDaclBeforeBase64':row['security']['ownerGroupDaclBase64'],
            'ownerGroupDaclAfterBase64':row['security']['ownerGroupDaclBase64'],'handleClosed':True}
    value['hardlinkFamilies']={family_key:{'role':'root','representative':members[0],'members':members,
        'bytes':original['bytes'],'sha256':original['sha256'],'owner':owner}}
    return base.recount(value)


class HardlinkFamilyContracts(unittest.TestCase):
    def setUp(self):
        self.guard=patch.object(capture.ctypes,'WinDLL',side_effect=AssertionError('native API forbidden in synthetic contract'),create=True)
        self.guard.start()

    def tearDown(self):
        self.guard.stop()

    def test_complete_family_preserves_distinct_owner_and_name_evidence(self):
        value=family_graph();self.assertTrue(capture.validate_physical_graph(value))
        key='root:local/saved-alias.sqlite';family=value['hardlinkFamilies'][key]
        self.assertEqual(capture.graph_family_map(value,'root'),{'local/saved-alias.sqlite':family['members']})
        self.assertEqual(capture.graph_family_map(value,'vendor'),{})
        for member in family['members']:
            self.assertIs(capture.graph_row_evidence(value,'root',member),family['owner'])
            row=value['physicalEntries']['root'][member]
            self.assertNotIn('readResult',row['nativeObservations'])
            self.assertEqual(row['nativeObservations']['path'],row['physicalPath'])
            self.assertEqual(row['information']['links'],2)
        singleton=value['physicalEntries']['vendor']['pkg/payload.js']
        self.assertIs(capture.graph_row_evidence(value,'vendor','pkg/payload.js'),singleton)
        self.assertEqual(singleton['information']['links'],1)

    def test_refuses_incomplete_cross_role_or_fabricated_family_evidence(self):
        for case in ('missing-map','orphan','missing-member','duplicate-member','cross-role',
                     'owner-path','member-path','fake-member-read','owner-read','owner-not-closed',
                     'link-count','member-native-id','member-security','member-stream'):
            with self.subTest(case=case):
                value=family_graph();key='root:local/saved-alias.sqlite';family=value['hardlinkFamilies'][key]
                row=value['physicalEntries']['root']['local/saved.sqlite']
                if case=='missing-map':value['hardlinkFamilies']={}
                elif case=='orphan':del row['familyKey']
                elif case=='missing-member':family['members']=family['members'][:1]
                elif case=='duplicate-member':family['members'].append(family['members'][0])
                elif case=='cross-role':family['role']='vendor'
                elif case=='owner-path':family['owner']['physicalPath']=row['physicalPath']
                elif case=='member-path':row['nativeObservations']['path']=family['owner']['physicalPath']
                elif case=='fake-member-read':row['nativeObservations']=copy.deepcopy(family['owner']['nativeObservations'])
                elif case=='owner-read':family['owner']['nativeObservations']['readResult']['sha256']='0'*64
                elif case=='owner-not-closed':family['owner']['nativeObservations']['handleClosed']=False
                elif case=='link-count':row['information']['links']=3
                elif case=='member-native-id':row['information']['fileId128Hex']='9'*32
                elif case=='member-security':row['security']['ownerGroupDaclBase64']='eA=='
                elif case=='member-stream':row['streams'][0]['allocationBytes']+=4096
                base.recount(value)
                with self.assertRaises((capture.CaptureRefused,RuntimeError,ValueError)):
                    capture.validate_physical_graph(value)

    def test_family_validator_never_relaxes_default_single_file_primitive(self):
        info=copy.deepcopy(family_graph()['hardlinkFamilies']['root:local/saved-alias.sqlite']['owner']['information'])
        unchanged=copy.deepcopy(info)
        self.assertIs(capture._info_checked(info,'file',expected_links=2),info)
        self.assertEqual(info,unchanged)
        with self.assertRaises(ValueError):capture._info_checked(info,'file')
        with self.assertRaises(capture.CaptureRefused):capture._info_checked(info,'file',expected_links=3)
        with self.assertRaises(capture.CaptureRefused):capture._info_checked(info,'directory',expected_links=2)
        legacy=base.graph()
        self.assertEqual(capture.graph_family_map(legacy,'root'),{})
        legacy['hardlinkFamilies']={}
        with self.assertRaises(capture.CaptureRefused):capture.validate_physical_graph(legacy)


if __name__=='__main__':unittest.main()
