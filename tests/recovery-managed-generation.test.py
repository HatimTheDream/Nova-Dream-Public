"""Exercise retained-plugin verification against actual official 9.8 path shape."""
import copy,json,pathlib,sqlite3,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'deploy/update-runner'))
import recovery

class ManagedGenerationTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='nova-managed-generation-')
  self.root=pathlib.Path(self.temp.name).resolve()
  self.runtime=self.root/'runtime';self.node=self.runtime/'node/bin/node';self.node.parent.mkdir(parents=True);self.node.write_bytes(b'fixture')
  package=self.runtime/'node_modules/openclaw/package.json';package.parent.mkdir(parents=True);package.write_text(json.dumps({'version':'2026.9.8'}))
  package=self.runtime/'companions/codex/node_modules/@openclaw/codex/package.json';package.parent.mkdir(parents=True);package.write_text(json.dumps({'version':'2026.9.8'}))
  self.integrity='sha512-'+'A'*86+'=='
  (self.runtime/'companions/codex/package-lock.json').write_text(json.dumps({'packages':{'node_modules/@openclaw/codex':{'version':'2026.9.8','integrity':self.integrity}}}))
  self.state=self.root/'workspace/openclaw-runtime/state'
  self.base='openclaw-codex-8902d781d4'
  self.generation=self.base+'__openclaw-generation__g-8b0d230c729a2812'
  self.installed=self.state/'npm/projects'/self.generation/'node_modules/@openclaw/codex'
  self.installed.mkdir(parents=True);(self.installed/'package.json').write_text(json.dumps({'name':'@openclaw/codex','version':'2026.9.8'}))
  self.old={'revision':100,'index':{'version':1,'warning':'Generated catalog','hostContractVersion':'2026.9.6','compatRegistryVersion':'a'*64,'migrationVersion':1,'policyHash':'b'*64,'generatedAtMs':99,'workspaceDir':'retained-workspace','installRecords':{'codex':{'source':'npm','version':'2026.9.6','installPath':str(self.state/'npm/projects'/self.base/'node_modules/@openclaw/codex')},'other':{'retained':True}},'plugins':[],'diagnostics':[]}}
  self.new=copy.deepcopy(self.old);self.new['revision']=200;self.new['index'].update(hostContractVersion='2026.9.8',generatedAtMs=199)
  self.new['index']['installRecords']['codex']={'source':'npm','spec':'@openclaw/codex@2026.9.8','installPath':str(self.installed),'version':'2026.9.8','installedAt':'2026-10-04T23:29:17.991Z','resolvedName':'@openclaw/codex','resolvedVersion':'2026.9.8','resolvedSpec':'@openclaw/codex@2026.9.8','integrity':self.integrity,'shasum':'a'*40,'resolvedAt':'2026-10-04T23:29:02.973Z'}
 def tearDown(self):self.temp.cleanup()
 def verify(self,value=None,from_version='2026.9.6',to_version='2026.9.8'):
  before=sqlite3.connect(':memory:');after=sqlite3.connect(':memory:')
  try:
   for connection,index in ((before,self.old),(after,value or self.new)):
    connection.execute('create table config_machine_state(state_key text,value_json text,updated_at_ms integer)')
    connection.execute('insert into config_machine_state values(?,?,?)',('plugins.installedIndex',json.dumps(index),index['revision']))
   recovery.retained_plugin_index(before,after,self.node,self.state/'state/openclaw.sqlite',from_version,to_version)
  finally:before.close();after.close()
 def test_actual_official_generation_is_retained(self):self.verify()
 def test_legacy_project_is_still_valid_for_98(self):
  path=self.state/'npm/projects'/self.base/'node_modules/@openclaw/codex';path.mkdir(parents=True)
  (path/'package.json').write_text(json.dumps({'name':'@openclaw/codex','version':'2026.9.8'}))
  value=copy.deepcopy(self.new);value['index']['installRecords']['codex']['installPath']=str(path);self.verify(value)
 def test_96_transition_does_not_inherit_generation_permission(self):
  self.old['index']['hostContractVersion']='2026.9.2';self.old['index']['installRecords']['codex']['version']='2026.9.2'
  self.new=json.loads(json.dumps(self.new).replace('2026.9.8','2026.9.6'))
  for path in (self.runtime/'node_modules/openclaw/package.json',self.runtime/'companions/codex/node_modules/@openclaw/codex/package.json',self.runtime/'companions/codex/package-lock.json',self.installed/'package.json'):
   path.write_text(path.read_text().replace('2026.9.8','2026.9.6'))
  with self.assertRaisesRegex(RuntimeError,'official Codex npm store changed'):self.verify(from_version='2026.9.2',to_version='2026.9.6')
 def test_wrong_namespace_and_generation_shapes_are_refused(self):
  paths=[self.root/'other/npm/projects'/self.generation/'node_modules/@openclaw/codex']
  for name in (self.base+'__openclaw-generation__g-123',self.base+'__openclaw-generation__g-'+'A'*16,'openclaw-codex-0000000000__openclaw-generation__g-'+'a'*16):
   paths.append(self.state/'npm/projects'/name/'node_modules/@openclaw/codex')
  for path in paths:
   with self.subTest(path=path),self.assertRaisesRegex(RuntimeError,'official Codex npm store changed'):
    value=copy.deepcopy(self.new);value['index']['installRecords']['codex']['installPath']=str(path);self.verify(value)
 def test_integrity_and_unrelated_record_changes_are_refused(self):
  for change in ('integrity','other'):
   value=copy.deepcopy(self.new)
   if change=='integrity':value['index']['installRecords']['codex']['integrity']='sha512-'+'B'*86+'=='
   else:value['index']['installRecords']['other']['retained']=False
   with self.subTest(change=change),self.assertRaises(RuntimeError):self.verify(value)
 def test_retained_package_version_and_redirection_are_refused(self):
  (self.installed/'package.json').write_text(json.dumps({'name':'@openclaw/codex','version':'2026.9.6'}))
  with self.assertRaisesRegex(RuntimeError,'official Codex npm payload changed'):self.verify()
  original=pathlib.Path.resolve
  def redirected(path,*args,**kwargs):return self.root/'redirected' if path==self.installed else original(path,*args,**kwargs)
  with patch.object(pathlib.Path,'resolve',redirected),self.assertRaisesRegex(RuntimeError,'official Codex npm payload changed'):self.verify()

if __name__=='__main__':unittest.main()
