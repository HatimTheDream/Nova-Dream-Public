import copy
import importlib.util
import unittest
from pathlib import Path

source = Path(__file__).resolve().parents[1] / 'scripts/release-startup-retained-proof.py'
spec = importlib.util.spec_from_file_location('deferred_reader',source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
digest = module.capture_native_digest


class ClosedWriter(unittest.TestCase):
    def setUp(self):
        self.history = {'epoch':'test-epoch','sourceRolesSha256':digest(['a','b'])}
        self.owner = ['lease','candidate',1]
        self.started = {'leaseId':'lease','candidateId':'candidate','attempt':1,'epoch':'test-epoch',
                        'startedAtSeconds':100,'namespaces':{'pid':'p','mnt':'m','net':'n'}}
        self.ready = {'readyAtSeconds':102,'process':{'pid':2,'startTicks':4,'uid':900},
                      'nativeProcess':{'pid':3,'startTicks':5,'uid':900,'nodeSha256':'a'*64}}
        self.proc = {'pid':3,'appPid':2,'appStartTicks':4,'startTicks':5,'uid':900,'nodeSha256':'a'*64,
                     'namespace':{'pid':'p','mnt':'m'},'cgroup':'0::/test-unit\n'}
        self.token = {'status':'stage','directory':[2,17,0o40700,900,900,2,0,104,104],
                      'owner':[2,18,0o100600,900,900,1,0,104,104],
                      'journal':[2,19,0o100600,900,900,1,512,104,104],'journalSha256':'b'*64}
        row = {k:self.token[k] for k in ('owner','journal','journalSha256')}
        row.update(captureDirectory=self.token['directory'][:5],
                   lock={'type':'POSIX','access':'WRITE','pid':3,'device':2,'inode':18,'first':0x40000001,'last':0x40000001})
        self.writer = {'format':1,'kind':'native-capture-writer','owner':self.owner,'epoch':'test-epoch',
                       'observedAtNs':104*10**9,'roles':{'c':row},'process':self.proc}
        old={'a':{'status':'retired'},'b':{'status':'retired'}}
        self.common={'format':1,'jobId':'lease','candidateId':'candidate','attempt':1,'epoch':'test-epoch',
                     'physicalRoots':[[1,12,0o40700,900,900],[2,14,0o40700,900,900]]}
        self.before={**self.common,'observedAtNs':99*10**9,'deferredBefore':{
            'baseline':old,'live':old,'history':self.history,'predecessor':None}}
        self.refs={key:{'sha256':digest(key)} for key in ('before','closed','writer')}
        self.outcome={'format':1,'kind':'closed-native-deferred-capture','owner':self.owner,'epoch':'test-epoch',
            'window':[100,106],'baseline':old,'before':old,'after':{'a':old['a'],'c':self.token},'added':['c'],
            'removed':['b'],'writerSha256':digest(self.writer),'predecessor':None,'historySha256':digest(self.history),
            'partitionSha256':'e'*64,'admissionsSha256':'f'*64,'closedCatalogSha256':digest({'original':1})}
        self.closed={**self.common,'deferredCatalog':{'original':1},'closedWindow':[100,106],
                     'beforeSha256':self.refs['before']['sha256'],'deferredCapture':self.outcome}

    def verify(self):
        return module.capture_closed_summary(self.before,self.writer,self.closed,self.refs,self.history,
                                             self.started,self.ready,[100,106],'/test-unit')

    def test_initial_original_writer_and_closed_catalog(self):
        self.assertEqual(self.verify()['closedCatalogSha256'],digest(self.closed['deferredCatalog']))

    def test_missing_writer_or_unattested_swap_fails(self):
        original=self.writer
        self.writer=None
        with self.assertRaises(RuntimeError): self.verify()
        self.writer=original
        self.outcome['added']=[]
        with self.assertRaises(RuntimeError): self.verify()

    def test_authenticated_kernel_and_process_cross_links(self):
        for field,value in [('pid',8),('appStartTicks',17),('uid',901),('nodeSha256','3'*64),
                            ('namespace',{'pid':'wrong','mnt':'m'}),('cgroup','0::/different\n')]:
            with self.subTest(field=field):
                self.setUp()
                self.writer['process'][field]=value
                self.outcome['writerSha256']=digest(self.writer)
                with self.assertRaises(RuntimeError): self.verify()
        self.setUp()
        self.writer['roles']['c']['lock']['first']+=1
        self.outcome['writerSha256']=digest(self.writer)
        with self.assertRaises(RuntimeError): self.verify()

    def test_catalog_and_history_are_independently_bound(self):
        self.closed['deferredCatalog']={'original':2}
        with self.assertRaises(RuntimeError): self.verify()
        self.setUp()
        self.history['sourceRolesSha256']=digest(['a','unseen'])
        self.outcome['historySha256']=digest(self.history)
        with self.assertRaises(RuntimeError): self.verify()


class CompleteProjection(unittest.TestCase):
    def setUp(self):
        self.case = ClosedWriter()
        self.case.setUp()
        self.case.outcome['disposition'] = 'staging-present'

    def derive(self):
        c = self.case
        return module.capture_closed_summary(c.before,c.writer,c.closed,c.refs,c.history,c.started,c.ready,
                                             [100,106],'/test-unit', complete=True)

    def retired(self):
        c = self.case
        c.token.update(status='retired',journal=None,journalSha256=None,
                       ownerSha256='f9b7a02201bbcec6133d5d043ba09d189aec76517b4db7e337696cd16d40db9b')
        c.token['owner'][-3:] = [4096,104*10**9,104*10**9]
        c.outcome.update(disposition='all-retired',writerSha256=None)
        c.writer=None

    def released(self):
        c=self.case
        c.token.update(status='released',journal=None,journalSha256=None)
        c.outcome['disposition']='released-present'

    def test_authenticated_running_writer_staged_or_released(self):
        self.assertEqual(self.derive()['addedStageCount'],1)
        self.released()
        actual=self.derive()
        self.assertEqual((actual['addedReleasedCount'],actual['closedDisposition']),(1,'released-present'))
        self.case.writer=None
        with self.assertRaises(RuntimeError):
            self.derive()

    def test_released_cannot_substitute_a_different_inode(self):
        self.released()
        self.case.token['owner']=copy.deepcopy(self.case.token['owner'])
        self.case.token['owner'][1]+=1
        with self.assertRaises(RuntimeError):
            self.derive()

    def test_actual_retired_marker_and_startup_bounds(self):
        self.retired()
        self.assertEqual((self.derive()['addedRetiredCount'],self.derive()['closedDisposition']),(1,'all-retired'))
        original=self.case.token['ownerSha256']
        self.case.token['ownerSha256']='0'*64
        with self.assertRaises(RuntimeError):
            self.derive()

        self.case.token['ownerSha256']=original
        self.case.token['owner'][-1]=107*10**9
        with self.assertRaises(RuntimeError):
            self.derive()

    def test_retired_residual_build_roots_need_original_positive_writer(self):
        c=self.case
        writer=copy.deepcopy(c.writer)
        self.retired()
        c.writer=writer
        directory=[2,22,0o40700,900,900,3,0,104*10**9,104*10**9]
        build=[2,23,0o40700,900,900,2,0,104*10**9,104*10**9]
        measured={'captures':directory,'captures/openclaw-plugin-build-abcdef':build}
        writer['roles']['c']['buildDirectories']=copy.deepcopy(measured)
        c.outcome['writerSha256']=module.capture_native_digest(writer)
        c.token['buildDirectories']=measured
        self.assertEqual(self.derive()['addedBuildRoleCount'],1)
        measured['captures'][1]+=1
        with self.assertRaises(RuntimeError):
            self.derive()

    def test_carry_of_mixed_state_requires_genuine_native_ancestry(self):
        c=self.case
        before=copy.deepcopy(c.outcome['after'])
        c.before['deferredBefore']['live']=before
        c.outcome.update(before=before,after={'a':before['a']},added=[],removed=['c'],
                         disposition='all-retired',writerSha256=None)
        c.writer=None
        self.assertEqual(self.derive()['beforeDisposition'],'staging-present')
        c.outcome['before']={'a':before['a']}
        with self.assertRaises(RuntimeError):
            self.derive()


if __name__=='__main__':
    unittest.main()
