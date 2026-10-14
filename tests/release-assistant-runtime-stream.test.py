"""Focused local streaming fixtures; no host, provider or Assistant requests."""
import hashlib,importlib.util,os,pathlib,stat,tempfile,types,unittest
from unittest.mock import patch
P=pathlib.Path
spec=importlib.util.spec_from_file_location('transport',P(__file__).parent.parent/'scripts/release-assistant-transport.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class RuntimeStream(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='nova-runtime-stream-');self.addCleanup(self.temp.cleanup);self.root=P(self.temp.name).resolve();self.path=self.root/'binary.fixture';self.path.write_bytes(b'A'*2*1024**2)
        self.real_fstat=os.fstat;self.real_read=os.read
        def portable(info):
            # Windows fixtures have no Linux owner/executable semantics. Model
            # those fields while retaining real inode, size and change times.
            keys=('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode','st_nlink','st_uid','st_gid');v={k:getattr(info,k) for k in keys};v['st_mode']|=0o111
            # Windows Path.stat and fstat expose different ctime meanings.
            # Normalize only this platform fixture; production checks all fields.
            if os.name=='nt':v['st_ctime_ns']=v['st_mtime_ns']
            return types.SimpleNamespace(**v)
        self.portable=portable
        def local_protected(path,*args,**kwargs):
            p=P(path);m.need(p.is_absolute() and p.resolve(strict=True)==p and not p.is_symlink(),'fixture-path-redirected');info=p.lstat();m.need(stat.S_ISREG(info.st_mode) and info.st_nlink==1,'fixture-file-changed');return portable(info)
        self.local_protected=local_protected
        self.patches=[patch.object(m,'protected',local_protected),patch.object(m.os,'fstat',lambda fd:portable(self.real_fstat(fd))),patch.object(m.os,'O_NOFOLLOW',getattr(os,'O_NOFOLLOW',0),create=True)]
        for p in self.patches:p.start();self.addCleanup(p.stop)
    def digest(self):
        h=hashlib.sha256()
        with self.path.open('rb') as f:
            while b:=f.read(1024**2):h.update(b)
        return h.hexdigest()
    def test_actual_stream_larger_than_old_256mib_limit(self):
        size=257*1024**2+17
        with self.path.open('wb') as f:f.truncate(size)
        expected=self.digest();sizes=[]
        def reading(fd,n):sizes.append(n);return self.real_read(fd,n)
        with patch.object(m.os,'read',side_effect=reading):actual=m.verified_runtime_binary(self.path,size,expected)
        self.assertEqual(actual.st_size,size);self.assertLessEqual(max(sizes),1024**2);self.assertEqual(sizes[-1],1);self.assertGreater(len(sizes),256)
    def test_corrupt_hash_refused(self):
        with self.assertRaisesRegex(RuntimeError,'binary-changed$'):m.verified_runtime_binary(self.path,self.path.stat().st_size,'0'*64)
    def test_inventory_size_and_finite_ceiling_refused_before_open(self):
        for size in (0,-1,True,1.5,m.RUNTIME_BINARY_MAXIMUM+1,self.path.stat().st_size+1):
            with patch.object(m.os,'open') as opened:
                with self.assertRaises(RuntimeError):m.verified_runtime_binary(self.path,size,self.digest())
                opened.assert_not_called()
    def test_growth_during_read_refused(self):
        size=self.path.stat().st_size;expected=self.digest();changed=False
        def reading(fd,n):
            nonlocal changed
            out=self.real_read(fd,n)
            if not changed:
                changed=True
                with self.path.open('ab') as f:f.write(b'new')
            return out
        with patch.object(m.os,'read',side_effect=reading):
            with self.assertRaisesRegex(RuntimeError,'binary-grew'):m.verified_runtime_binary(self.path,size,expected)
    def test_shrink_during_read_refused(self):
        size=self.path.stat().st_size;expected=self.digest();changed=False
        def reading(fd,n):
            nonlocal changed
            out=self.real_read(fd,n)
            if not changed:
                changed=True
                with self.path.open('r+b') as f:f.truncate(1024**2)
            return out
        with patch.object(m.os,'read',side_effect=reading):
            with self.assertRaisesRegex(RuntimeError,'binary-truncated'):m.verified_runtime_binary(self.path,size,expected)
    def test_fd_replacement_refused(self):
        expected=self.digest();wrong=self.portable(self.path.stat());wrong.st_ino+=1
        with patch.object(m.os,'fstat',return_value=wrong):
            with self.assertRaisesRegex(RuntimeError,'binary-replaced'):m.verified_runtime_binary(self.path,self.path.stat().st_size,expected)
    def test_after_read_identity_change_refused(self):
        original=self.local_protected;calls=[]
        def changed(path):
            value=original(path);calls.append(path)
            if len(calls)>1:value.st_ino+=1
            return value
        with patch.object(m,'protected',side_effect=changed):
            with self.assertRaisesRegex(RuntimeError,'changed-during-read'):m.verified_runtime_binary(self.path,self.path.stat().st_size,self.digest())
    def test_maintained_protection_rejects_symlink_before_open(self):
        # Exercise the real authority function with a root-owned symlink model;
        # actual symlink creation on Windows would require unrelated privileges.
        original={};source=(P(__file__).parent.parent/'scripts/release-assistant-transport.py').read_bytes();exec(compile(source,'reviewed-transport','exec'),original)
        class Link:
            parents=()
            def is_absolute(self):return True
            def resolve(self,strict=True):return self
            def lstat(self):return types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFLNK|0o777)
        with patch.dict(original,{'P':lambda p:Link()}):
            with self.assertRaisesRegex(RuntimeError,'protected-authority-changed'):original['protected']('/synthetic-link')
        with patch.object(m,'protected',side_effect=RuntimeError('assistant-protected-authority-changed')),patch.object(m.os,'open') as opened:
            with self.assertRaisesRegex(RuntimeError,'protected-authority-changed'):m.verified_runtime_binary(self.path,1,'a'*64)
            opened.assert_not_called()
if __name__=='__main__':unittest.main()
