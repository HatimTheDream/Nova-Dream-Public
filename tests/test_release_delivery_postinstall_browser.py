import base64
import importlib.util
import json
import os
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

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

if __name__ == '__main__':
    unittest.main()
