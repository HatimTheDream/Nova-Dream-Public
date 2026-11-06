"""Direct fixture checks on independent Linux tmpfs/filesystem replicas."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/update-runner'))
import recovery as r


@unittest.skipUnless(os.name == 'posix' and Path('/dev/shm').is_dir(), 'two independent Linux file systems required')
class ReplicaObservation(unittest.TestCase):
    def setUp(self):
        self.before_root = Path(self.enterContext(tempfile.TemporaryDirectory(dir='/tmp')))
        self.after_root = Path(self.enterContext(tempfile.TemporaryDirectory(dir='/dev/shm')))
        if self.before_root.stat().st_dev == self.after_root.stat().st_dev:
            self.skipTest('independent filesystem device numbers required')
        self.selected = Path('workspace')
        self.roots = (self.before_root, self.after_root)
        self.files, self.dbs, self.rows = [], [], []
        self.now = 1760000000
        for i, root in enumerate(self.roots):
            path = root / self.selected / 'openclaw-runtime/openclaw.json'
            path.parent.mkdir(parents=True)
            path.write_bytes((b'first', b'updated')[i]); path.chmod(0o600)
            info = path.stat()
            self.files.append(path)
            db = object.__new__(r.CopiedDatabase)
            db.source_path = path.parent / 'state/state/openclaw.sqlite'
            self.dbs.append(db)
            self.rows.append(dict(hash=r.digest(path), bytes=info.st_size, mtimeMs=info.st_mtime*1000,
                ctimeMs=info.st_ctime*1000, dev=str(info.st_dev), ino=str(info.st_ino), mode=0o600,
                nlink=info.st_nlink, uid=info.st_uid, gid=info.st_gid, hasMeta=True, gatewayMode='local',
                observedAt=datetime.fromtimestamp(self.now, timezone.utc).isoformat()))
        self.runtime = self.before_root / 'runtime'
        self.scope = {'selected':self.selected,'roots':self.roots,'runtime':self.runtime,'first':(self.now-5,self.now+5),
            'closed':(self.now+10,self.now+20),'report':{'sourceDevice':self.roots[0].stat().st_dev,
            'replicaDevice':self.roots[1].stat().st_dev,'observations':[]}}
        self.config = {'path':str(self.files[1]),'hashes':[r.digest(p) for p in self.files],
            'byteSizes':[p.stat().st_size for p in self.files]}
        self.enterContext(patch.object(r,'attest_native_writer_sources'))
        digest = r.digest
        self.enterContext(patch.object(r,'digest',side_effect=lambda p:
            'd2e734563bfb126d273beeb1e2cc5d4525b4d59efe00fdfec50a39b427524f56' if p==self.runtime/'package.json' else digest(p)))

    def compare(self, mutate=None, index=1):
        rows = [x.copy() for x in self.rows]
        if mutate: rows[index].update(mutate)
        return r.verify_replica_config_observation(self.scope,*self.dbs,self.config,*(json.dumps(x) for x in rows))

    def test_genuine_raw_distinct_devices_and_inodes(self):
        self.assertTrue(self.compare())
        self.assertEqual(self.scope['report']['observations'][0]['changedFields'],['dev'])
        with self.assertRaises(RuntimeError): self.compare()

    def test_forged_fs_identity_bytes_and_owner_refuse(self):
        for change in ({'dev':self.rows[0]['dev']},{'dev':'0'},{'ino':'1'},{'uid':False},
                       {'mode':0o644},{'gid':self.rows[1]['gid']+1},{'nlink':2},{'hash':'a'*64},{'bytes':99}):
            with self.subTest(change=change), self.assertRaises(RuntimeError): self.compare(change)
        with self.assertRaises(RuntimeError): self.compare({'dev':self.rows[1]['dev']},0)

    def test_refuse_other_fields_and_widened_clock(self):
        for change in ({'extra':True},{'hasMeta':False},{'gatewayMode':'remote'},
                       {'observedAt':datetime.fromtimestamp(self.now+7,timezone.utc).isoformat()}):
            with self.subTest(change=change), self.assertRaises(RuntimeError): self.compare(change)

    def test_same_filesystem_delegates_to_full_equality(self):
        self.scope['report']['replicaDevice']=self.scope['report']['sourceDevice']
        self.assertFalse(self.compare())
        self.assertEqual(self.scope['report']['observations'][0]['changedFields'],[])

    def test_wrong_file_or_database_role_refuses(self):
        self.dbs[1].source_path=self.dbs[0].source_path
        with self.assertRaises(RuntimeError): self.compare()

    def test_unchanged_observation_is_preserved_verbatim(self):
        raw=json.dumps(self.rows[0])
        self.assertFalse(r.verify_replica_config_observation(self.scope,*self.dbs,self.config,raw,raw))
        self.assertEqual(self.scope['report']['observations'][0]['mode'],'unchanged-original-record')

    def test_ordinary_process_cannot_enable_replica_exception(self):
        with self.assertRaises(RuntimeError):
            with r.qualified_replica_observation(*self.roots,self.selected,self.runtime,
                    self.before_root.stat().st_dev,self.after_root.stat().st_dev,self.scope['first'],self.scope['closed']): pass


if __name__ == '__main__': unittest.main()
