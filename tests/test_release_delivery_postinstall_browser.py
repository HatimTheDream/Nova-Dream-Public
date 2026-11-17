import ast
import base64
import importlib.util
import json
import os
import pathlib
import re
import tempfile
import types
import unittest
import warnings
from unittest.mock import patch

class PostinstallSourceTests(unittest.TestCase):
    def test_embedded_host_worker_compiles_without_warnings(self):
        source = pathlib.Path(__file__).parents[1] / 'scripts' / 'release-delivery-postinstall-browser.py'
        with warnings.catch_warnings():
            warnings.simplefilter('error')
            compile(source.read_text(encoding='utf-8'), str(source), 'exec', dont_inherit=True)
    def test_worker_name_pattern_retains_exact_value_and_matching(self):
        source = pathlib.Path(__file__).parents[1] / 'scripts' / 'release-delivery-postinstall-browser.py'
        values = [node.args[0].value for node in ast.walk(ast.parse(source.read_text(encoding='utf-8')))
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'fullmatch'
                  and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)
                  and node.args[0].value.startswith('release-delivery-')]
        self.assertEqual(values, [r'release-delivery-[a-z-]+\.mjs'])
        for name in ('release-delivery-postinstall-browser-worker.mjs', 'release-delivery-browser-worker.mjs'):
            self.assertIsNotNone(re.fullmatch(values[0], name))
        for name in ('release-delivery-browser-workerXmjs', '../release-delivery-browser-worker.mjs'):
            self.assertIsNone(re.fullmatch(values[0], name))

browser = None
if os.name == 'posix':
    spec = importlib.util.spec_from_file_location('postinstall_browser', pathlib.Path(__file__).parents[1] / 'scripts' / 'release-delivery-postinstall-browser.py')
    browser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(browser)

@unittest.skipUnless(os.name == 'posix', 'The maintained host worker is POSIX only; canonical Linux CI exercises it.')
class PostinstallProfileTests(unittest.TestCase):
    def test_inventory_preserves_exact_source_and_ignores_only_named_singleton_targets(self):
        with tempfile.TemporaryDirectory() as root:
            p = pathlib.Path(root);(p/'Default').mkdir();(p/'Default'/'Cookies').write_bytes(b'closed source bytes')
            (p/'SingletonLock').symlink_to('/never/read/foreign/target')
            before = {str(f): (f.lstat().st_atime_ns, browser.meta(f.lstat())) for f in [p,p/'Default',p/'Default'/'Cookies',p/'SingletonLock']}
            first=browser.inventory(p,os.getuid());second=browser.inventory(p,os.getuid())
            self.assertEqual(first,second);self.assertEqual(first['entryCount'],3)
            self.assertEqual(first['rows'][-1]['kind'],'singleton-link')
            for f in [p,p/'Default',p/'Default'/'Cookies',p/'SingletonLock']:
                self.assertEqual((f.lstat().st_atime_ns,browser.meta(f.lstat())),before[str(f)])
    def test_unrecognized_link_hardlink_oversize_and_wrong_owner_are_refused(self):
        with tempfile.TemporaryDirectory() as root:
            p=pathlib.Path(root);(p/'outside').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(RuntimeError,'symlink-refused'):browser.inventory(p,os.getuid())
            (p/'outside').unlink();(p/'a').write_bytes(b'a');os.link(p/'a',p/'b')
            with self.assertRaisesRegex(RuntimeError,'file-boundary'):browser.inventory(p,os.getuid())
            (p/'b').unlink()
            with (p/'a').open('wb') as f:f.truncate(536870913)
            with self.assertRaisesRegex(RuntimeError,'file-boundary'):browser.inventory(p,os.getuid())
            with self.assertRaisesRegex(RuntimeError,'profile-boundary'):browser.inventory(p,os.getuid()+1)
    def test_directory_symlink_and_content_change_cannot_reuse_inventory(self):
        with tempfile.TemporaryDirectory() as root:
            p=pathlib.Path(root);source=p/'profile';source.mkdir();(source/'file').write_bytes(b'a')
            original=browser.inventory(source,os.getuid())['inventorySha256'];(source/'file').write_bytes(b'b')
            self.assertNotEqual(browser.inventory(source,os.getuid())['inventorySha256'],original)
            alias=p/'alias';alias.symlink_to(source,target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError,'profile-boundary'):browser.inventory(alias,os.getuid())

@unittest.skipUnless(os.name == 'posix', 'POSIX host plan')
class PostinstallCapacityTests(unittest.TestCase):
    def make_data(self,p):
        old='00000000-0000-4000-8000-000000000001';new='00000000-0000-4000-8000-000000000002';profile=p/old/'profile';profile.mkdir(parents=True);(profile/'file').write_bytes(b'fixture')
        tool=p/'pinned-tool';tool.write_bytes(b'verified bytes');ref={'path':str(tool),'sha256':browser.sha(tool.read_bytes())}
        closure=browser.enc({'format':1,'entry':str(tool),'files':[ref]*11})
        options={'directoryRoot':str(p),'user':'fixture','node':ref,'executable':ref,'playwright':{'sha256':browser.sha(closure)}}
        return {'legacy':{'original':{'binding':{'sessionId':old,'options':options}},'closure':base64.b64encode(closure).decode()},'sessionId':new,'input':{'operationId':old},'requestSha256':'a'*64,'capacity':{'diskReserveBytes':2147483648,'workingAllowanceBytes':536870912}}
    def run_plan(self,data,available=4294967296,free=40*1024**3,inodes=10000):
        original=pathlib.Path.read_text
        def read_text(p,*args,**kwargs):
            return 'MemAvailable: '+str(available//1024)+' kB\n' if str(p)=='/proc/meminfo' else original(p,*args,**kwargs)
        v=types.SimpleNamespace(f_bavail=free//4096,f_frsize=4096,f_favail=inodes)
        with patch.object(browser,'old_status',return_value={}),patch.object(browser,'live',return_value={}),patch.object(browser.pwd,'getpwnam',return_value=types.SimpleNamespace(pw_uid=os.getuid())),patch.object(browser,'unit_status',return_value={'unitState':'ActiveState=inactive\nMainPID=0\n','ownedPids':[]}),patch.object(browser.os,'statvfs',return_value=v),patch.object(pathlib.Path,'read_text',read_text),patch.object(browser.subprocess,'run',side_effect=AssertionError('read-only plan must not launch')):
            return browser.plan(data)
    def test_capacity_keeps_two_gib_host_reserve_and_lifecycle_disk_margin(self):
        with tempfile.TemporaryDirectory() as root:
            data=self.make_data(pathlib.Path(root));proof=self.run_plan(data)
            self.assertEqual(proof['resources']['browserMaxBytes'],2147483648);self.assertEqual(proof['resources']['hostReserveBytes'],2147483648);self.assertFalse(proof['hostWrites'])
            for args in [{'available':4294966272},{'free':2147483648+536870912},{'inodes':1}]:
                with self.assertRaisesRegex(RuntimeError,'capacity-insufficient'):self.run_plan(data,**args)
    def test_existing_recovery_directory_or_changed_tool_is_not_a_new_launch(self):
        with tempfile.TemporaryDirectory() as root:
            p=pathlib.Path(root);data=self.make_data(p);(p/('current-'+data['sessionId'])).mkdir()
            with self.assertRaisesRegex(RuntimeError,'already-reserved'):self.run_plan(data)
            (p/'pinned-tool').write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError,'reference-changed'):self.run_plan(data)

@unittest.skipUnless(os.name == 'posix', 'POSIX selected workspace host reader')
class PostinstallSelectedWorkspaceTests(unittest.TestCase):
    epoch='30950a0f-ba4d-4f6b-91f2-7de29fdb82d0'
    recovery_id='740cee9f-b41f-4eb0-9ebd-e0b64b7822b8'
    def database(self,directory,digest='a',epoch=None,schema=60):
        directory.mkdir(parents=True,exist_ok=True)
        (directory/'edition3.identity').write_bytes(b'private.novadream.edition3.preview\n')
        with browser.sqlite3.connect(directory/'workspace.sqlite') as db:
            db.execute('PRAGMA user_version='+str(schema));db.execute('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)')
            db.execute('INSERT INTO meta VALUES (?,?)',('epoch',epoch or self.epoch))
            db.execute('CREATE TABLE sessions(digest TEXT,device_id TEXT,expires INTEGER)')
            db.execute('INSERT INTO sessions VALUES (?,?,?)',(digest*64,self.recovery_id,4102444800000))
    def fixture(self,root,selected=True):
        self.database(root,'a',schema=53 if selected else 60)
        if not selected:return root
        directory=root/'recovered-workspaces'/self.recovery_id;self.database(directory,'b')
        (root/'workspace-selection.json').write_text(json.dumps({'format':1,'recoveryId':self.recovery_id}))
        (directory/'recovery-complete.json').write_text(json.dumps({'jobId':self.recovery_id,'sourceHash':'c'*64}))
        return directory
    def sessions(self,root,**kwargs):return browser.selected_sessions(root,{'schemaVersion':60,'epoch':self.epoch},**kwargs)
    def test_no_selection_reads_only_canonical_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary);self.fixture(root,False);rows,proof=self.sessions(root)
            self.assertEqual(rows[0]['digest'],'a'*64);self.assertIsNone(proof['workspace']['selection'])
            self.assertIsNone(proof['workspace']['recoveryProof']);self.assertEqual(proof['path'],str(root/'workspace.sqlite'))
            self.assertTrue(proof['readOnly'] and proof['queryOnly']);self.assertEqual(proof['schemaVersion'],60);self.assertEqual(proof['epoch'],self.epoch)
    def test_selected_recovery_reads_selected_sessions_and_preserves_authority(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary);selected=self.fixture(root)
            files=[root/'workspace-selection.json',selected/'recovery-complete.json',selected/'edition3.identity']
            before={p:(p.read_bytes(),browser.meta(p.lstat())) for p in files}
            rows,proof=self.sessions(root)
            self.assertEqual([r['digest'] for r in rows],['b'*64]);self.assertEqual(proof['path'],str(selected/'workspace.sqlite'))
            self.assertEqual(proof['workspace']['selection']['sha256'],browser.sha(before[files[0]][0]))
            self.assertEqual(proof['workspace']['recoveryProof']['sha256'],browser.sha(before[files[1]][0]))
            self.assertEqual(before,{p:(p.read_bytes(),browser.meta(p.lstat())) for p in files})
    def test_wrong_schema_or_epoch_refuses_selected_database_without_root_fallback(self):
        for column,value in [('schema',53),('epoch','050080cf-e1e9-4d23-8300-f56349fb02dd')]:
            with self.subTest(column=column),tempfile.TemporaryDirectory() as temporary:
                root=pathlib.Path(temporary);selected=self.fixture(root)
                with browser.sqlite3.connect(selected/'workspace.sqlite') as db:
                    if column=='schema':db.execute('PRAGMA user_version='+str(value))
                    else:db.execute("UPDATE meta SET value=? WHERE key='epoch'",(value,))
                with self.assertRaisesRegex(RuntimeError,'workspace-identity-changed'):self.sessions(root)
    def test_malformed_extra_boolean_or_escape_selection_is_refused(self):
        for value in [[],{'format':1,'recoveryId':self.recovery_id,'extra':True},{'format':True,'recoveryId':self.recovery_id},
                      {'format':1,'recoveryId':'../../escape'},{'format':1,'recoveryId':'BAD'}]:
            with self.subTest(value=value),tempfile.TemporaryDirectory() as temporary:
                root=pathlib.Path(temporary);self.fixture(root);(root/'workspace-selection.json').write_text(json.dumps(value))
                with self.assertRaises((RuntimeError,ValueError)):self.sessions(root)
    def test_wrong_recovery_proof_or_identity_is_refused(self):
        for name,value in [('recovery-complete.json',json.dumps({'jobId':self.epoch,'sourceHash':'c'*64}).encode()),
                           ('recovery-complete.json',json.dumps({'jobId':self.recovery_id,'sourceHash':'bad'}).encode()),
                           ('edition3.identity',b'wrong workspace\n')]:
            with self.subTest(name=name,value=value),tempfile.TemporaryDirectory() as temporary:
                root=pathlib.Path(temporary);selected=self.fixture(root);(selected/name).write_bytes(value)
                with self.assertRaisesRegex(RuntimeError,'recovery-proof-invalid|identity-invalid'):self.sessions(root)
    def test_selection_or_marker_change_during_read_is_refused(self):
        for name in ['selection','marker','identity','new-selection']:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temporary:
                root=pathlib.Path(temporary);selected=self.fixture(root,name!='new-selection')
                def change():
                    if name=='selection':(root/'workspace-selection.json').unlink()
                    elif name=='marker':(selected/'recovery-complete.json').write_text(json.dumps({'jobId':self.recovery_id,'sourceHash':'d'*64}))
                    elif name=='identity':(selected/'edition3.identity').write_bytes(b'changed')
                    else:(root/'workspace-selection.json').write_text(json.dumps({'format':1,'recoveryId':self.recovery_id}))
                with self.assertRaisesRegex(RuntimeError,'workspace-selection-changed|workspace-authority-changed'):
                    self.sessions(root,after_read=change)
    def test_selection_directory_marker_database_redirects_are_refused(self):
        for kind in ['selection','directory','marker','database']:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temporary:
                root=pathlib.Path(temporary);selected=self.fixture(root)
                if kind=='directory':
                    destination=selected.with_name('other');selected.rename(destination);selected.symlink_to(destination,target_is_directory=True)
                else:
                    target={'selection':root/'workspace-selection.json','marker':selected/'recovery-complete.json','database':selected/'workspace.sqlite'}[kind]
                    destination=target.with_name(target.name+'.original');target.rename(destination);target.symlink_to(destination)
                with self.assertRaisesRegex(RuntimeError,'authority-file|selection-redirected|database-path'):self.sessions(root)

if __name__ == '__main__':
    unittest.main()
