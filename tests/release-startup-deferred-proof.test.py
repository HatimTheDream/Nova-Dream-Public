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


if __name__=='__main__':
    unittest.main()
