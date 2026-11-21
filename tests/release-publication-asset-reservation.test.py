"""One original asset reservation, with explicit authenticated absence and exclusive dispatch."""
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE=Path(__file__).resolve().parents[1]/'scripts'/'release-publication-asset-reservation.py'
spec=importlib.util.spec_from_file_location('reserved_asset',SOURCE)
gate=importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Reservation(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base=Path(temp.name).resolve()
        self.ledger=self.base/'ledger'
        self.ledger.mkdir(mode=0o700)
        self.request={'operationId':'op','key':'key','inputSha256':'d'*64,'spec':{'role':'app','name':'example-app.tgz'},
                      'releaseIds':{'private':11,'public':12},'sourceCommits':{'private':'a'*40,'public':'b'*40},
                      'outputDirectory':str(self.base/'native-app'),'ledgerDirectory':str(self.ledger)}
        self.args={k:{'path':str(self.base/k),'sha256':'1'*64} for k in ['request','reservation','binding','noPostPlan']}
        self.args.update(projectedSha256='c'*64,expiresAtMs=100)
        self.paired={
            name:{'repositoryId':rid, 'release':{'id':r,'tag_name':'tag','target_commitish':commit,'assets':[]}}
            for name,rid,r,commit in [('Nova-Dream',1,11,'a'*40),('Nova-Dream-Public',2,12,'b'*40)]}
        self.client=SimpleNamespace(token='fixture',releases=lambda:self.paired)

    def test_authenticated_complete_remote_membership_and_binding(self):
        with patch.object(gate.A.G,'api',return_value=(200,[])) as api:
            observed=gate.release_observation(self.request,self.client)
            api.assert_called_once_with('/repos/HatimTheDream/Nova-Dream/releases/11/assets?per_page=100&page=1','fixture')
            self.assertEqual(observed['private']['sourceCommit'],'a'*40)
        for status,assets in [(403,[]),(200,[{'id':1,'name':'unmatched'}]),(200,[{'id':1,'name':'a'}]*100)]:
            with self.subTest(status=status,count=len(assets)),patch.object(gate.A.G,'api',return_value=(status,assets)),self.assertRaises(RuntimeError):
                gate.release_observation(self.request,self.client)
        present=[{'id':123,'name':self.request['spec']['name']}]
        with patch.dict(self.paired['Nova-Dream']['release'],assets=present),patch.object(gate.A.G,'api',return_value=(200,present)),self.assertRaises(RuntimeError):
            gate.release_observation(self.request,self.client)
        with patch.dict(self.paired['Nova-Dream-Public']['release'],target_commitish='z'*40),self.assertRaises(RuntimeError):
            gate.release_observation(self.request,self.client)

    def test_issue_once_and_never_replay_a_lost_child_call(self):
        observed={'readOnly':True}
        with patch.object(gate,'read_reference',return_value=observed),patch.object(gate,'observe',return_value=observed), \
             patch.object(gate.A,'produce',side_effect=OSError('uncertain child')) as produce:
            with self.assertRaises(OSError):gate.execute_original(self.request,self.args,now=lambda:20)
            with self.assertRaises(RuntimeError):gate.execute_original(self.request,self.args,now=lambda:21)
            produce.assert_called_once_with('execute',self.request)
        self.assertTrue(gate.locations(self.request)[2].is_file())

    def test_local_or_remote_history_or_expiry_blocks_first_effect(self):
        observed={'readOnly':True}
        with patch.object(gate,'read_reference',return_value=observed),patch.object(gate,'observe',return_value=observed), \
             patch.object(gate.A,'produce') as produce:
            for path in gate.locations(self.request):
                with self.subTest(path=path.name):
                    path.touch()
                    with self.assertRaises(RuntimeError):gate.execute_original(self.request,self.args,now=lambda:1)
                    path.unlink()
            for ticks in [(100,), (1,100), (1,2,100)]:
                with self.subTest(ticks=ticks),self.assertRaises(RuntimeError):
                    clock=iter(ticks)
                    gate.execute_original(self.request,self.args,now=lambda:next(clock))
            self.assertFalse(produce.called)
        with patch.object(gate,'read_reference',return_value=observed),patch.object(gate,'observe',return_value={'readOnly':False}), \
             patch.object(gate.A,'produce') as produce,self.assertRaises(RuntimeError):
            gate.execute_original(self.request,self.args,now=lambda:1)
        self.assertFalse(produce.called)


if __name__=='__main__':unittest.main()
