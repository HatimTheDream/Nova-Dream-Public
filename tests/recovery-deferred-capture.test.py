"""Focused regression coverage for deferred native SQLite plugin captures."""
import copy
import pathlib
import stat
import sys
import tempfile
import time
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

    def test_additional_physical_namespace_group_has_its_own_full_partition(self):
        base, first = self.source_tree()
        role='selected/plugin-captures/'+self.a+'/owner.sqlite'
        original_path='/work/selected/plugin-captures/'+self.a+'/'
        data, files, catalog, sources = {'native':base['native']}, {}, {}, {}
        for i,(name,source_hash,physical_id) in enumerate((
                ('111111','a'*64,473),('222222','b'*64,474),
                ('333333','a'*64,473),('444444','b'*64,474))):
            prefix='native/admission-'+name
            tree={k.replace(self.prefix,prefix):copy.deepcopy(row) for k,row in base.items() if k!='native'}
            tree[prefix+'/content/addon.node']['sha256']=source_hash
            data.update(tree)
            files[prefix+'/content/addon.node']=[100,physical_id]
            if i<2:
                ns=copy.deepcopy(first);member=ns['members']['addon.node']
                member['source']=self.source+str(i)
                member['sourceIdentity']=member['capturedIdentity']=member['sourceIdentity'].replace('473',str(physical_id))
                member['contentHash']=source_hash
                sources[member['source']]=[100,physical_id]
                catalog[original_path+prefix]={'original':ns,'current':original_path+prefix}
        origin={'kind':'held-prior-capture-origin','selectedRole':role,'windows':{role:[9,12]}}
        family={'directory':[0]*7+[10*10**9,0],'owner':[0]*7+[10*10**9,0],'captures':None}
        def verify(rows,physical,windows):
            return recovery.verify_deferred_partition(self.live,self.live,{role:[rows,physical,family]},
                sources,catalog,origin,self.runtime,historical_names={role},group_windows=windows)
        proof=verify(data,files,origin['windows'])
        self.assertEqual(len(proof[role]),4)
        copies=copy.deepcopy(files)
        for i,key in enumerate(k for k in files if '333333' in k or '444444' in k):
            copies[key]=[100,700+i,stat.S_IFREG|0o600,999,986,1,12,10*10**9,10*10**9]
        self.assertEqual(verify(data,copies,origin['windows']),proof)
        linked_copy=copy.deepcopy(copies)
        linked_copy['native/admission-333333/content/addon.node'][5]=2
        with self.assertRaises(RuntimeError):
            verify(data,linked_copy,origin['windows'])
        for failure in ('partial','extra','hash','foreign-inode','window'):
            rows=copy.deepcopy(data); ids=copy.deepcopy(files); windows=origin['windows']
            if failure=='partial':
                rows={k:v for k,v in rows.items() if not k.startswith('native/admission-333333')}
            if failure=='extra':rows['another-file']={'kind':'file'}
            if failure=='hash':rows['native/admission-333333/content/addon.node']['sha256']='f'*64
            if failure=='foreign-inode':ids['native/admission-333333/content/addon.node']=[100,9000]
            if failure=='window':windows={role:[1,2]}
            with self.subTest(failure=failure), self.assertRaises(RuntimeError):verify(rows,ids,windows)

    def test_held_origin_binds_the_actual_source_writer_and_stopped_registry(self):
        owner=(self.a,'d'*64,0)
        source=pathlib.Path('snapshot')
        role=pathlib.Path('selected')/'plugin-captures'/self.c/'owner.sqlite'
        sibling=pathlib.Path('selected')/'plugin-captures'/self.b/'owner.sqlite'
        writer=copy.deepcopy(self.witness)
        writer['owner']=list(owner)
        writer['roles'][str(role)]=writer['roles'].pop(self.role)
        staged={**self.staged,'status':'stage','ownerSha256':recovery.hashlib.sha256(b'').hexdigest(),
                'captures':None,'coverage':'a'*64}
        other=copy.deepcopy(staged)
        other.update(status='retired',journal=None,journalSha256=None,ownerSha256=recovery.CAPTURE_OWNER_RETIRED_SHA256)
        other['owner'][6]=4096
        roles={str(role):staged,str(sibling):other}
        registry={'pluginId':'codex','rootDir':'synthetic','sourceAdmissions':{'source':{'nativeNamespaces':{}}}}
        windows={str(sibling):[10,15],str(role):[100,104]}
        held={'format':1,'kind':'held-prior-native-capture','owner':list(owner),'epoch':self.epoch,
              'selectedRelative':str(self.selected),'selectedRole':str(role),'physicalRoot':[100,19,0o40700,999,986],
              'writer':writer,'processStartedAtSeconds':100,'windows':windows,
              'priorEvidence':{'selectedCatalogSha256':recovery.deferred_digest(registry)}}
        def bind(document,roster=roles):
            def read_roster(root,selected,runtime,details=None):
                if details is not None:
                    details.update({name:[] for name in roster})
                return roster
            with patch.object(recovery,'held_capture_document',return_value=document), \
                 patch.object(recovery,'capture_physical_root',return_value=tuple(held['physicalRoot'])), \
                 patch.object(recovery,'selected_capture_registry',return_value=(role,registry)), \
                 patch.object(recovery,'deferred_capture_roster',side_effect=read_roster), \
                 patch.object(recovery,'deferred_source_links',return_value={}), \
                 patch.object(recovery,'verify_deferred_partition'), \
                 patch.object(recovery,'require_closed_deferred_tokens'):
                return recovery.bind_held_capture_origin(source,self.live,self.selected,self.runtime,owner=owner,
                    epoch=self.epoch,source_manifest_sha256='a'*64,held_ref=(pathlib.Path('held.json'),'b'*64),windows=windows)
        for status in ('stage','retired','released'):
            roster=copy.deepcopy(roles)
            token=roster[str(role)]
            if status!='stage':
                token.update(status=status,journal=None,journalSha256=None)
                if status=='retired':
                    token['owner'][6]=4096
                    token['ownerSha256']=recovery.CAPTURE_OWNER_RETIRED_SHA256
            self.assertEqual(bind(held,roster)['sourceStatus'],status)
        for changed in ('catalog','root','windows','role','inode','clock','job'):
            doc=copy.deepcopy(held)
            if changed=='catalog':doc['priorEvidence']['selectedCatalogSha256']='1'*64
            if changed=='root':doc['physicalRoot'][1]+=1
            if changed=='windows':doc['windows']={}
            if changed=='role':doc['selectedRole']=str(sibling)
            if changed=='inode':doc['writer']['roles'][str(role)]['owner'][1]+=1
            if changed=='clock':doc['processStartedAtSeconds']=104
            if changed=='job':doc['owner'][0]=self.b
            with self.subTest(changed=changed),self.assertRaises(RuntimeError):bind(doc)

    @unittest.skipUnless(sys.platform=='linux','requires Linux noatime directory descriptors')
    def test_live_build_observation_keeps_directory_inodes_without_following_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            family=pathlib.Path(tmp)
            started_ns = int(time.time()) * 10**9
            captured=family/'captures'
            build=captured/'openclaw-plugin-build-yw2e8B'
            package=build/'package-2'
            modules=package/'node_modules'
            for path in (captured,build,package,modules):
                path.mkdir(mode=0o700)
            (package/'package.json').write_bytes(b'{"name":"fixture"}')
            untouched=family/'outside'
            untouched.mkdir(mode=0o700)
            (modules/'@openai').symlink_to(untouched,target_is_directory=True)
            (captured/'openclaw-plugin-build-q971Ks').symlink_to(untouched,target_is_directory=True)
            result=recovery.observe_capture_builds(family)
            expected={p.relative_to(family).as_posix():list(recovery.capture_object(p))
                      for p in (captured,build,package,modules)}
            self.assertEqual(result,expected)
            (modules/'@openai').unlink()
            (captured/'openclaw-plugin-build-q971Ks').unlink()
            (package/'package.json').unlink()
            witnessed = recovery.observe_capture_builds(family)
            observed_ns = time.time_ns()
            closed = recovery.observe_capture_builds(family)
            closed_ns = time.time_ns()
            owner = family/'owner.sqlite'
            owner.touch()
            recovery.verify_closed_capture_builds(
                {'owner': recovery.capture_object(owner), 'buildDirectories': closed},
                {'buildDirectories': witnessed},
                (started_ns // 10**9, (closed_ns + 10**9 - 1) // 10**9),
                held_interval=(started_ns, observed_ns, closed_ns),
            )

    def test_closed_builds_require_only_witnessed_empty_official_directories(self):
        root='captures/openclaw-plugin-build-r3x9sE'
        paths=['captures',root,root+'/package-2',root+'/package-2/node_modules']
        mode=stat.S_IFDIR|0o700
        row={'kind':'directory','mode':0o700,'xattrs':{},'uid':999,'gid':986,'mtime_ns':10*10**9}
        rows={key:copy.deepcopy(row) for key in paths}
        ids={key:[100,800+i,mode,999,986,3 if i<len(paths)-1 else 2,4096,10*10**9,10*10**9]
             for i,key in enumerate(paths)}
        self.assertEqual(set(recovery.closed_build_rows(rows,row)),set(paths[1:]))
        state={'owner':[100,701,stat.S_IFREG|0o600,999,986],'buildDirectories':ids}
        observed={'buildDirectories':ids}
        recovery.verify_closed_capture_builds(state,observed,(9,12))
        held = (9 * 10**9, 11 * 10**9, 12 * 10**9)
        recovery.verify_closed_capture_builds(state, observed, (9, 12), held_interval=held)
        changed = copy.deepcopy(state)
        changed['buildDirectories'][paths[-1]][-1] = held[1] + 1
        recovery.verify_closed_capture_builds(changed, observed, (9, 12), held_interval=held)
        for invalid_time in (held[0] - 1, held[1] - 1, held[2] + 1):
            with self.subTest(invalid_held_directory_time=invalid_time):
                changed['buildDirectories'][paths[-1]][-1] = invalid_time
                with self.assertRaises(RuntimeError):
                    recovery.verify_closed_capture_builds(changed, observed, (9, 12), held_interval=held)
        for corruption in ('foreign-name','file','symlink','extra','mode','uid','xattr'):
            bad=copy.deepcopy(rows)
            if corruption=='foreign-name':bad['captures/never-generated']=row
            if corruption=='extra':bad[root+'/notes']=row
            if corruption in ('file','symlink'):bad[paths[-1]]['kind']=corruption
            if corruption=='mode':bad[paths[-1]]['mode']=0o755
            if corruption=='uid':bad[paths[-1]]['uid']=1
            if corruption=='xattr':bad[paths[-1]]['xattrs']={'user.test':'0'}
            with self.subTest(corruption=corruption),self.assertRaises(RuntimeError):
                recovery.closed_build_rows(bad,row)
        for corruption in ('missing','inode','outside','wrong-links','late'):
            changed=copy.deepcopy(ids)
            if corruption=='missing':changed.pop(root)
            if corruption=='inode':changed[root][1]+=1
            if corruption=='outside':changed[root][0]+=1
            if corruption=='wrong-links':changed[root][5]+=1
            if corruption=='late':changed[root][8]=14*10**9
            if corruption in ('late','wrong-links'):
                state2={**state,'buildDirectories':changed}
                observed2=observed
            else:
                state2=state
                observed2={'buildDirectories':changed}
            with self.subTest(corruption=corruption),self.assertRaises(RuntimeError):
                recovery.verify_closed_capture_builds(state2,observed2,(9,12))

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
        def run(before,after,previous_catalog=None,previous=None,unchanged=False,extra_static=False,
                missing_writer=False,selected=None,writer_role=None,original=None,source_selected=None,history=None,
                missing_original_stage=False):
            baseline=initial if original is None else original
            prepared={'baseline':baseline,'live':before,'predecessor':previous,'history':history or {'windows':self.history},
                      'beforeDetails':details(before),'beforeSources':{self.source:source_id}}
            writer=copy.deepcopy(witness)
            if writer_role:
                writer['roles'][writer_role]=writer['roles'].pop(c)
                observed=writer['roles'][writer_role]
                for value in (observed['owner'],observed['journal'],observed['captureDirectory']):
                    value[1]+=100
                observed['lock']['inode']+=100
            closure={'start':{**self.proof,'deferredBefore':prepared,'previousCatalog':previous_catalog},
                     'writerWitness':None if missing_writer else writer}
            catalog=recovery.DeferredCaptureAdmissions()
            if unchanged:
                catalog.unchangedIndex=True
            else:
                current=role_name(selected or c)
                catalog[role_name(source_selected or a)]={'original':namespace,'current':current}
                catalog.current[current]={'original':namespace,'current':current}
            before_static={pathlib.Path('unrelated.sqlite'):('file',7,'2'*64)}
            after_static=dict(before_static)
            for role,token in baseline.items():
                if token['status']=='stage' and not missing_original_stage:
                    before_static[pathlib.Path(role)]=('file',0,token['ownerSha256'])
                    before_static[pathlib.Path(role).with_name('owner.sqlite-journal')]=('file',512,token['journalSha256'])
            for role,token in after.items():
                if token['status']=='stage':
                    after_static[pathlib.Path(role)]=('file',0,token['ownerSha256'])
                    after_static[pathlib.Path(role).with_name('owner.sqlite-journal')]=('file',512,token['journalSha256'])
            if extra_static:after_static[pathlib.Path('other.sqlite')]=('file',5,'1'*64)
            def roster(root,selected,runtime,inventory):
                value=baseline if root==source else after
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

        # Either outcome can come first. An existing authenticated namespace can
        # move out of the catalog only with its own physically unchanged members.
        later=prefix+'44444444-4444-4444-8444-444444444444/owner.sqlite'
        committed=copy.deepcopy(result[c])
        committed.update(status='retired',ownerSha256=recovery.CAPTURE_OWNER_RETIRED_SHA256,
                         journal=None,journalSha256=None)
        committed['owner'][6]=4096
        ordinary={a:initial[a],c:committed}
        released=copy.deepcopy(result[c])
        released.update(status='released',journal=None,journalSha256=None)
        release_end={a:initial[a],c:released}
        first_retired=run(initial,ordinary)
        first_released=run(initial,release_end)
        self.assertEqual(first_retired['deferredCapture']['disposition'],'all-retired')
        self.assertEqual(first_released['deferredCapture']['disposition'],'released-present')
        self.assertIsNone(first_retired['deferredCapture']['writerSha256'])
        with self.assertRaises(RuntimeError):
            run(initial,release_end,missing_writer=True)
        choices=((result[c],'staging-present'),(committed,'all-retired'),(released,'released-present'))
        for start,previous in ((ordinary,first_retired),(result,first),(release_end,first_released)):
            for example,disposition in choices:
                with self.subTest(start=start[c]['status'],disposition=disposition):
                    # An earlier retired C can survive with a new selected
                    # namespace. A preceding staged C is genuinely reaped.
                    keep=c if start[c]['status']=='retired' else a
                    new=copy.deepcopy(example)
                    for value in (new['owner'],new['directory'],new['journal']):
                        if value is not None:value[1]+=100
                    end={keep:start[keep],later:new}
                    successor=run(start,end,previous['deferredCatalog'],{'sha256':'a'*64},
                                  selected=later,writer_role=later)
                    self.assertEqual(successor['deferredCapture']['added'],[later])
                    self.assertEqual(successor['deferredCapture']['disposition'],disposition)
                    self.assertEqual(successor['deferredCapture']['writerSha256'] is not None,disposition!='all-retired')
                    if disposition!='all-retired':
                        with self.assertRaises(RuntimeError):
                            run(start,end,previous['deferredCatalog'],{'sha256':'a'*64},
                                selected=later,writer_role=later,missing_writer=True)
                    wrong=copy.deepcopy(end)
                    wrong[later]['owner'][7] = 0
                    with self.assertRaises(RuntimeError):
                        run(start,wrong,previous['deferredCatalog'],{'sha256':'a'*64},
                            selected=later,writer_role=later)
        with self.assertRaises(RuntimeError):
            run(initial,ordinary,selected=a,missing_writer=True)

        # Live .39 may leave its selected writer staged in the stopped source.
        # A target can create an independent selected stage without admitting
        # any unrelated database bytes or the unexplained removal of a sibling.
        mixed={a:initial[a],b:copy.deepcopy(result[c])}
        dynamic={'kind':'held-prior-capture-origin','selectedRole':b,'windows':{}}
        for shape,_ in choices:
            kwargs={'original':mixed,'source_selected':b,'history':dynamic}
            actual=run(mixed,{a:initial[a],c:shape},**kwargs)
            self.assertEqual(actual['deferredCapture']['removed'],[b])
            for bad in ({'missing_original_stage':True},{'extra_static':True}):
                with self.assertRaises(RuntimeError):
                    run(mixed,{a:initial[a],c:shape},**kwargs,**bad)
        with self.assertRaisesRegex(RuntimeError,'creation window'):
            run(mixed,{b:mixed[b],c:committed},original=mixed,source_selected=b,history=dynamic)
        documented={**dynamic,'windows':{a:self.history['target-first-start']}}
        passed=run(mixed,{b:mixed[b],c:committed},original=mixed,source_selected=b,history=documented)
        self.assertEqual(passed['deferredCapture']['removed'],[a])

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
