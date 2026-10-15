import hashlib,importlib.util,json,pathlib,types,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('preflight',ROOT/'scripts/full-host-primitives/preflight.py')
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
class Preflight(unittest.TestCase):
 def setUp(self):
  self.body=b'{}';self.value={'format':1,'stageParent':'/opt/nova-release-tools/fixture-stages','hostConfiguration':{'path':'/etc/nova-update/config.json','sha256':hashlib.sha256(self.body).hexdigest()}}
 def raw(self,path):return json.dumps({'recoveryDirectory':'/var/lib/nova-recovery'}).encode() if pathlib.Path(path).name=='runner.json' else self.body
 def protected(self,path,directory=False):return types.SimpleNamespace(st_dev=1,st_ino=2,st_mode=0o40700,st_uid=0,st_gid=0)
 def test_missing_stage_is_explicit_gap_not_uncertain_or_creation(self):
  def read(path,directory=False):
   if path.as_posix()==self.value['stageParent']:raise FileNotFoundError(str(path))
   return self.protected(path,directory)
  with patch.object(M,'protected',side_effect=read),patch.object(M,'raw',side_effect=self.raw):
   value=M.collect(self.value)
  self.assertFalse(value['passed']);self.assertEqual(value['gaps'],['full-host-stage-parent-missing']);self.assertTrue(value['noHostWrites'])
 def test_unsafe_path_is_explicit_gap(self):
  def read(path,directory=False):
   if path.as_posix()==self.value['stageParent']:raise RuntimeError('root-protected-ancestry')
   return self.protected(path,directory)
  with patch.object(M,'protected',side_effect=read),patch.object(M,'raw',side_effect=self.raw):self.assertEqual(M.collect(self.value)['gaps'],['full-host-stage-parent-unsafe'])
 def test_all_present_is_only_directory_readiness(self):
  with patch.object(M,'protected',side_effect=self.protected),patch.object(M,'raw',side_effect=self.raw):value=M.collect(self.value)
  self.assertTrue(value['passed']);self.assertFalse(value['capacityAdmitted']);self.assertFalse(value['recoveryAdmitted']);self.assertEqual(len(value['directories']),3)
 def test_changed_config_is_not_admitted(self):
  self.value['hostConfiguration']['sha256']='f'*64
  with patch.object(M,'protected',side_effect=self.protected),patch.object(M,'raw',side_effect=self.raw):self.assertIn('full-host-configuration-unavailable',M.collect(self.value)['gaps'])
 def test_stage_traversal_refused_before_filesystem(self):
  self.value['stageParent']='/opt/nova-release-tools/../elsewhere'
  with patch.object(M,'protected') as observed:
   with self.assertRaisesRegex(RuntimeError,'configured-stage-parent'):M.collect(self.value)
   observed.assert_not_called()
if __name__=='__main__':unittest.main()
