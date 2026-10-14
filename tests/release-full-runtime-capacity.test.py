"""Portable projection checks against exact maintained allocation functions.

Synthetic paths/data only. No SQLite opens, runtime execution or host effects.
"""
import ast
import hashlib
import importlib.util
import pathlib
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT=pathlib.Path(__file__).resolve().parents[1]
source=ROOT/'deploy/update-runner/install.py'
raw=source.read_bytes()
assert hashlib.sha256(raw).hexdigest()=='d417d652163cb134583b1d766c650ad0a8597084bfa25ee876d7cf5155f013c4'
tree=ast.parse(raw)
names={'MANAGED_COMPANION_98','RUNTIME_MAXIMUM','RUNTIME_EXPANDED_MAXIMUM','RUNTIME_PROFILES'}
nodes=[n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in names for t in n.targets)]
nodes += [n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'managed_companion_capacity','require_capacity_filesystem'}]
driver=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Driver')
nodes += [n for n in driver.body if isinstance(n,ast.FunctionDef) and n.name in {'stage_app','runtime_storage_required'}]
def require(value,reason):
 if not value:raise RuntimeError(reason)
maintained={'require':require,'pathlib':pathlib,'shutil':shutil}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'exact-maintained-capacity-functions','exec'),maintained)
spec=importlib.util.spec_from_file_location('runtime_projection',ROOT/'scripts/full-host-primitives/online-capacity.py')
C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)

class CapacityTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='nova-runtime-capacity-');self.addCleanup(self.temp.cleanup)
  self.root=pathlib.Path(self.temp.name).resolve();self.workspace=self.root/'workspace';self.volume=self.root/'recovery'
  self.home=self.root/'home';self.runtime_root=self.root/'runtimes';self.transfer=self.root/'transfer'
  for p in (self.workspace,self.volume,self.home,self.home/'.npm',self.runtime_root,self.transfer,self.workspace/'openclaw-runtime',self.workspace/'openclaw-runtime/tmp',self.workspace/'openclaw-runtime/state/npm/projects'):
   p.mkdir(parents=True,exist_ok=True)
  self.runtime={'format':1,'fromVersion':'2026.9.6','toVersion':'2026.9.8','archiveBytes':393000000,
   'archiveSha256':maintained['MANAGED_COMPANION_98']['runtimeArchiveSha256'],'expandedBytes':800000000,'fileCount':40000,
   'nodeVersion':'24.21.0','nodeSha256':'a'*64,'companion':{'pluginVersion':'2026.9.8','codexVersion':'0.158.0','packageLockSha256':'b'*64,'binarySha256':'c'*64}}
  self.facts={'review':{'agentVersion':'2026.9.6'},'runnerPaths':{'serviceUser':'fixture'},'hostPaths':{'runtimeDirectory':str(self.runtime_root)}}
  self.live={'openclaw-runtime':{'kind':'directory'}}
  self.installer=types.SimpleNamespace(**{n:maintained[n] for n in names|{'managed_companion_capacity','require_capacity_filesystem'}},protected=lambda p,d:None)
  self.pwd=types.SimpleNamespace(getpwnam=lambda name:types.SimpleNamespace(pw_dir=str(self.home)))

 def add(self,name,size):
  p=self.workspace/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'x'*size)
  self.live[name]={'kind':'file','size':size}
  return pathlib.Path(name)

 def projection(self,runtime='default'):
  # Map the production transfer root into this test's owned filesystem. Keep
  # the maintained filesystem validator real, including its split-device case.
  def fixture_path(value):return self.transfer if value=='/var/tmp' else pathlib.Path(value)
  with patch.object(C,'P',fixture_path),patch.dict(sys.modules,{'pwd':self.pwd,'sqlite3':types.SimpleNamespace(connect=lambda *a,**k:self.fail('No SQLite opens permitted'))}):
   return C.runtime_allocation(self.runtime if runtime=='default' else runtime,self.facts,self.live,self.workspace,self.volume,4096,self.installer)

 def exact_migration(self,paths):
  class Captured(Exception):pass
  observed={}
  def save(path,value):observed.update(value);raise Captured()
  driver=types.SimpleNamespace(data=self.workspace,before={'epoch':'fixture'},from_engine='2026.9.6',to_engine='2026.9.8',runtime=self.runtime,
   recovery_root=self.volume,runtime_root=self.runtime_root,releases=self.root,settings={'serviceUser':'fixture'},baseline=self.volume,output=self.volume,
   archive_members=lambda:[],application_dependency_storage_required=lambda:0,runtime_target=self.runtime_root/'not-yet-staged')
  driver.runtime_storage_required=lambda:maintained['runtime_storage_required'](driver)
  bindings={'native_preflight':lambda *a:(pathlib.Path('.'),'fixture',paths),'inventory':lambda p:({},{}),
   'staging_capacity':lambda a,b,c,d,free,candidate:{'freeBytes':free,'candidateBytes':candidate},'write_json':save}
  with patch.dict(maintained,bindings),patch.dict(sys.modules,{'pwd':self.pwd}):
   with self.assertRaises(Captured):maintained['stage_app'](driver)
  return driver.migration_storage_required,observed

 def test_projection_never_below_maintained_selected_native_cases(self):
  shared=self.add('openclaw-runtime/state/state/openclaw.sqlite',8192)
  agent=self.add('openclaw-runtime/state/agents/a/agent/openclaw-agent.sqlite',12288)
  self.add(str(shared)+'-wal',4096);self.add(str(agent)+'-wal',2048)
  self.add('dormant/old.sqlite',16384);self.add('workspace.sqlite',8192)
  for exact in ({shared},{shared,agent},{agent},set()):
   with self.subTest(exact=sorted(map(str,exact))):
    actual,plan=self.exact_migration(exact);projected=self.projection()
    self.assertGreaterEqual(projected['nativeMigrationBytes'],actual)
    self.assertEqual(projected['nativeMigrationBytes'],2*sum(v.get('size',0) for v in self.live.values()))
    self.assertEqual(projected['managedCompanionBytes'],plan['managedCompanionBytes'])
  self.assertEqual(projected['managedCompanionBytes'],2*1024**3)
  self.assertFalse(projected['sourceSqliteOpened']);self.assertFalse(projected['runtimeAdmission']);self.assertFalse(projected['actualTargetStartupQualified'])

 def test_runtime_archive_and_expansion_charged_without_reuse_credit(self):
  value=self.projection()
  self.assertEqual(value['runtimeArchiveBytes'],2*((self.runtime['archiveBytes']+4095)//4096)*4096)
  self.assertEqual(value['runtimeExpansionBytes'],self.runtime['expandedBytes']+self.runtime['fileCount']*4096)
  self.assertEqual(value['runtimeReuseCreditBytes'],0)
  self.assertIn(str(self.home/'.npm'),value['capacityRoots'])
  self.assertIn(str(self.transfer),value['capacityRoots'])
  self.assertIn(str(self.workspace/'openclaw-runtime/state/npm/projects'),value['capacityRoots'])
  self.assertEqual(value['temporaryRoots'],[str(self.workspace/'openclaw-runtime/tmp')])

 def test_unchanged_runtime_has_no_projection_or_filesystem_effect(self):
  self.installer.require_capacity_filesystem=lambda *a:self.fail('Unchanged route must not inspect runtime roots')
  self.assertIsNone(self.projection(None))

 def test_wrong_runtime_unknown_dimensions_and_redirected_inventory_refuse(self):
  for update in ({'archiveSha256':'0'*64},{'fromVersion':'2026.9.2'},{'archiveBytes':513*1024**2},{'expandedBytes':3*1024**3},{'fileCount':True},{'fileCount':100001}):
   with self.subTest(update=update),self.assertRaises(RuntimeError):self.projection({**self.runtime,**update})
  self.live['malformed.sqlite']={'kind':'symlink','target':'elsewhere'}
  with self.assertRaisesRegex(RuntimeError,'database-size-unavailable'):self.projection()
  del self.live['malformed.sqlite'];self.live['../escape.sqlite']={'kind':'file','size':3}
  with self.assertRaisesRegex(RuntimeError,'inventory-path-invalid'):self.projection()

 def test_missing_and_split_capacity_roots_refuse(self):
  original=self.facts['hostPaths']['runtimeDirectory'];self.facts['hostPaths']['runtimeDirectory']=str(self.root/'missing-runtime')
  with self.assertRaises((RuntimeError,FileNotFoundError)):self.projection()
  self.facts['hostPaths']['runtimeDirectory']=original
  paths=(self.home,self.home/'.npm',self.runtime_root,self.transfer,self.workspace/'openclaw-runtime/tmp',self.workspace/'openclaw-runtime/state/npm/projects')
  native_stat=pathlib.Path.stat
  for split in paths:
   def changed(path,*args,**kwargs):
    value=native_stat(path,*args,**kwargs)
    if path==split:return types.SimpleNamespace(**{n:getattr(value,n) for n in dir(value) if n.startswith('st_') and n!='st_dev'},st_dev=value.st_dev+1)
    return value
   with self.subTest(split=str(split)),patch.object(pathlib.Path,'stat',changed),self.assertRaisesRegex(RuntimeError,'reviewed capacity filesystem'):self.projection()
  self.live.clear()
  with self.assertRaisesRegex(RuntimeError,'native-roots-missing'):self.projection()

if __name__=='__main__':unittest.main()
