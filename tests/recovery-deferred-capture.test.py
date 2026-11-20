"""Focused regression coverage for deferred native SQLite plugin captures."""
import copy
import pathlib
import stat
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'deploy/update-runner'))
import recovery


class DeferredCaptureTest(unittest.TestCase):
    runtime = pathlib.Path('runtime')
    live = pathlib.Path('/work')
    selected = pathlib.Path('selected')
    source = '/work/selected/package/addon.node'
    a = '11111111-1111-4111-8111-111111111111'
    b = '22222222-2222-4222-8222-222222222222'
    c = '33333333-3333-4333-8333-333333333333'
    prefix = 'native/admission-a1b2c3'
    epoch = '22222222-2222-4222-8222-222222222223'

    def setUp(self):
        self.window = [100, 105]
        self.history = {'target-first-start': [10, 15], 'target-restart': [20, 25]}
        self.owner = ['job', 'd'*64, 1]
        self.proof = {'owner':self.owner,'epoch':self.epoch}
        self.identity = [100,12,stat.S_IFREG|0o600,999,986,1,0,101*10**9,101*10**9]
        token = self.identity
        self.role = self.c+'/owner.sqlite'
        self.staged = {'owner':token,'journal':[100,13,stat.S_IFREG|0o600,999,986,1,512,101*10**9,101*10**9],
                       'journalSha256':'e'*64,'directory':[100,11,stat.S_IFDIR|0o700,999,986,2,0,101*10**9,101*10**9]}
        self.witness = {'format':1,'kind':'native-capture-writer','owner':self.owner,'epoch':self.epoch,'observedAtNs':102*10**9,
            'process':{'pid':99,'appPid':88,'startTicks':100,'appStartTicks':90,'uid':999,'nodeSha256':'8'*64,
                       'cgroup':'0::/test\n','namespace':{'pid':'pid:[123]','mnt':'mnt:[321]'}},
            'roles':{self.role:{'owner':token,'journal':self.staged['journal'],'journalSha256':'e'*64,
                'captureDirectory':self.staged['directory'][:5],
                'lock':{'pid':99,'device':100,'inode':12,'first':0x40000001,'last':0x40000001,'type':'POSIX','access':'WRITE'}}}}

    def test_verified_writer_requires_exact_reserved_lock_and_closed_token(self):
        validate = lambda receipt: recovery.verify_deferred_writer(receipt,self.proof,self.window,self.role,self.staged)
        validate(self.witness)
        for field,value in [('pid',100),('device',101),('inode',13),('type','FLOCK'),('access','READ'),('last',0x40000000)]:
            receipt=copy.deepcopy(self.witness)
            receipt['roles'][self.role]['lock'][field]=value
            with self.subTest(field=field), self.assertRaises(RuntimeError): validate(receipt)
        for change in ('nonce','window','candidate','journal-inode','uid'):
            receipt=copy.deepcopy(self.witness)
            if change=='nonce':receipt['roles'][self.role]['journalSha256']='a'*64
            if change=='window':receipt['observedAtNs']=120*10**9
            if change=='candidate':receipt['owner'][1]='f'*64
            if change=='journal-inode':receipt['roles'][self.role]['journal'][1]+=1
            if change=='uid':receipt['process']['uid']+=1
            with self.subTest(change=change), self.assertRaises(RuntimeError): validate(receipt)

    def source_tree(self):
        p = self.prefix
        row = lambda kind,mode,stamp: {'kind':kind,'mode':mode,'mtime_ns':stamp*10**9}
        rows = {key:row('directory',0o700,10) for key in ('native',p,p+'/node_modules',p+'/content')}
        rows[p+'/node_modules/openclaw']={**row('symlink',0o777,10),'target':str(self.runtime)}
        rows[p+'/content/addon.node']={**row('file',0o600,10),'size':12,'sha256':'a'*64}
        ns={'members':{'':{'sourceIdentity':f'100:202:{stat.S_IFDIR|0o700}:0:0:0',
                               'capturedIdentity':f'100:102:{stat.S_IFDIR|0o700}:0:{10*10**9}:0',
                               'boundaryChecked':False},
                       'addon.node':{'source':self.source,'sourceIdentity':f'100:473:{stat.S_IFREG|0o600}:12:{10*10**9}:0',
                             'capturedIdentity':f'100:473:{stat.S_IFREG|0o600}:12:{10*10**9}:0',
                             'boundaryChecked':False,'sizeBytes':12,'contentHash':'a'*64}}}
        return rows,ns

    def test_unselected_template_requires_complete_unique_source_and_history(self):
        rows,ns=self.source_tree()
        active='/work/selected/plugin-captures/'+self.a+'/'+self.prefix
        namespaces={active:ns}
        role=pathlib.Path('selected/plugin-captures')/self.b/'owner.sqlite'
        chosen = recovery.match_deferred_namespaces(role,rows,namespaces,self.history.values(),True,self.runtime)
        self.assertEqual(chosen,{'admission-a1b2c3':active})
        for change in ('extra','hash','timestamp','mode','link','missing','ambiguous'):
            changed=copy.deepcopy(rows)
            if change=='extra':changed['native/unproved']={'kind':'file','mode':0o600}
            if change=='missing':del changed[self.prefix+'/content/addon.node']
            if change=='hash':changed[self.prefix+'/content/addon.node']['sha256']='0'*64
            if change=='mode':changed[self.prefix+'/content/addon.node']['mode']=0o644
            if change=='timestamp':changed[self.prefix+'/content']['mtime_ns']=50*10**9
            if change=='link':changed[self.prefix+'/node_modules/openclaw']['target']='untrusted'
            windows=([self.history['target-first-start']]*2 if change=='ambiguous' else self.history.values())
            with self.subTest(change=change),self.assertRaises((RuntimeError,KeyError)):
                recovery.match_deferred_namespaces(role,changed,namespaces,windows,True,self.runtime)

    def test_hardlink_partition_binds_actual_previously_unselected_and_canonical_sources(self):
        rows,ns=self.source_tree()
        ns['members']['']['source']=self.source.rsplit('/',1)[0]
        srcid=[100,473,stat.S_IFREG|0o600,999,986,3,12,10*10**9,0]
        physical={self.prefix+'/content/addon.node':srcid}
        names={u:'selected/plugin-captures/'+u+'/owner.sqlite' for u in (self.a,self.b)}
        registered='/work/selected/plugin-captures/'+self.a+'/'+self.prefix
        catalog={registered:{'original':ns,'current':registered}}
        def verify(files):
            return recovery.verify_deferred_partition(self.live,self.live,files,{self.source:srcid},catalog,
                {'windows':self.history},self.runtime,historical_names={names[self.b]})
        family={'directory':[0]*7+[10*10**9,0],'owner':[0]*7+[10*10**9,0],'captures':None}
        details={v:[rows,physical,family] for v in names.values()}
        self.assertEqual(set(verify(details)),set(names.values()))
        bad=copy.deepcopy(details)
        bad[names[self.b]][1]={self.prefix+'/content/addon.node':[100,999,*srcid[2:]]}
        with self.assertRaisesRegex(RuntimeError,'hardlink partition'): verify(bad)

    def test_restored_prior_uses_the_independent_pristine_workspace(self):
        source = pathlib.Path('original')
        prior_id = 'e' * 64
        history = {'kind': 'signed-prior-capture-windows', 'priorCandidateId': prior_id,
                   'epoch': self.epoch, 'sourceManifestSha256': '1' * 64,
                   'sourceRolesSha256': '2' * 64, 'sourceEvidenceSha256': '3' * 64,
                   'windows': self.history}
        previous = {'candidate': 'd' * 64, 'epoch': self.epoch, 'attempt': 2, 'runtime': self.runtime,
                    'roots': (source, self.live), 'physical': ((1, 100), (1, 200)),
                    'deferredCapture': {'owner': ['job', 'd' * 64, 2]}}
        token = {**self.staged, 'status': 'retired', 'journal': None, 'ownerSha256': '4' * 64,
                 'journalSha256': None, 'coverage': '5' * 64, 'captures': None}
        original = {key: token for key in (self.a, self.b)}

        def start(candidate=prior_id, job='job', inode=301, current=original):
            with patch.object(recovery, 'capture_physical_root', side_effect=[(1, 100), (1, inode)]), \
                 patch.object(recovery, 'deferred_capture_roster', side_effect=[original, current]), \
                 patch.object(recovery, 'deferred_source_links', return_value={}):
                return recovery.begin_deferred_capture(source, self.live, self.selected, self.epoch,
                    self.runtime, (job, candidate, 3), previous, history)

        self.assertIsNone(start()['predecessor'])
        for invalid in ({'inode': 200}, {'candidate': 'b' * 64}, {'job': 'other-job'},
                        {'current': {self.a: token, self.c: token}}):
            with self.subTest(invalid=list(invalid)), self.assertRaises(RuntimeError):
                start(**invalid)

    def test_full_deferred_branch_and_actual_predecessor_reaping(self):
        rows, namespace = self.source_tree()
        namespace['members']['']['source']=self.source.rsplit('/',1)[0]
        source_id=[100,473,stat.S_IFREG|0o600,999,986,3,12,10*10**9,0]
        members={self.prefix+'/content/addon.node':source_id}
        prefix='selected/plugin-captures/'
        a,b,c=[prefix+uid+'/owner.sqlite' for uid in (self.a,self.b,self.c)]
        role_name=lambda role: '/work/'+role.rsplit('/',1)[0]+'/'+self.prefix
        def retired(inode):
            owner=[100,inode,stat.S_IFREG|0o600,999,986,1,4096,10*10**9,10*10**9]
            return {'status':'retired','directory':[100,inode+1,stat.S_IFDIR|0o700,999,986,4,4096,10*10**9,10*10**9],
                    'owner':owner,'journal':None,'ownerSha256':recovery.CAPTURE_OWNER_RETIRED_SHA256,
                    'journalSha256':None,'coverage':'a'*64,'captures':None,'physicalSha256':'b'*64}
        initial={a:retired(2001), b:retired(3001)}
        result={a:initial[a],c:{**self.staged,'status':'stage','coverage':'c'*64,'physicalSha256':'d'*64,
                                'captures':None,'ownerSha256':recovery.hashlib.sha256(b'').hexdigest()}}
        details=lambda roster:{key:[rows,members,value] for key,value in roster.items()}
        source=pathlib.Path('snapshot');native=pathlib.Path('runtime')
        witness=copy.deepcopy(self.witness)
        witness['roles'][c]=witness['roles'].pop(self.role)
        def run(before,after,previous_catalog=None,previous=None,unchanged=False,extra_static=False,missing_writer=False):
            prepared={'baseline':initial,'live':before,'predecessor':previous,'history':{'windows':self.history},
                      'beforeDetails':details(before),'beforeSources':{self.source:source_id}}
            closure={'start':{**self.proof,'deferredBefore':prepared,'previousCatalog':previous_catalog},
                     'writerWitness':None if missing_writer else witness}
            catalog=recovery.DeferredCaptureAdmissions()
            if unchanged:
                catalog.unchangedIndex=True
            else:
                catalog[role_name(a)]={'original':namespace,'current':role_name(c)}
                catalog.current[role_name(c)]={'original':namespace,'current':role_name(c)}
            before_static={pathlib.Path('unrelated.sqlite'):('file',7,'2'*64)}
            after_static=dict(before_static)
            if c in after:
                after_static[pathlib.Path(c)]=('file',0,result[c]['ownerSha256'])
                after_static[pathlib.Path(c).with_name('owner.sqlite-journal')]=('file',512,result[c]['journalSha256'])
            if extra_static:after_static[pathlib.Path('other.sqlite')]=('file',5,'1'*64)
            def roster(root,selected,runtime,inventory):
                value=initial if root==source else after
                inventory.update(details(value))
                return value
            with patch.object(recovery,'deferred_capture_roster',side_effect=roster), \
                    patch.object(recovery,'deferred_source_links',return_value={self.source:source_id}), \
                    patch.object(recovery,'require_closed_deferred_tokens'),patch.object(recovery,'attest_native_writer_sources'):
                recovery.verify_deferred_capture_map(source,self.live,self.selected,native,self.window,before_static,after_static,closure,catalog)
            return closure
        first=run(initial,result)
        self.assertEqual(first['deferredCapture']['added'],[c])
        self.assertEqual(first['deferredCapture']['removed'],[b])
        self.assertEqual(first['deferredCapture']['writerSha256'],recovery.deferred_digest(witness))
        for kwargs in ({'missing_writer':True},{'extra_static':True}):
            with self.assertRaises(RuntimeError):run(initial,result,**kwargs)
        closed=run(result,{a:initial[a]},first['deferredCatalog'],{'path':'closed','sha256':'f'*64},True)
        self.assertEqual(closed['deferredCapture']['removed'],[c])
        self.assertIsNone(closed['deferredCapture']['writerSha256'])
        with self.assertRaises(RuntimeError):run(result,{a:initial[a]},None,None,True)

    def test_stopped_probe_refuses_locked_or_malformed_kernel_record(self):
        from io import BytesIO
        import os
        if os.name!='posix':
            self.skipTest('Linux device decomposition')
        major,minor=os.major(100),os.minor(100)
        for body in [f'10: POSIX ADVISORY WRITE 212 {major:x}:{minor:x}:12 0 EOF\n'.encode(), b'unknown\n']:
            with patch('builtins.open',return_value=BytesIO(body)), self.assertRaises(RuntimeError):
                recovery.require_closed_deferred_tokens({self.role:self.staged})


if __name__ == '__main__':
    unittest.main()
