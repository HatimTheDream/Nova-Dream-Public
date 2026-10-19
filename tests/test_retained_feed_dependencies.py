"""Synthetic local fixtures; no production candidate, journal or host access."""
import base64, copy, hashlib, importlib.util, io, json, os, pathlib, shutil, subprocess, sys, tarfile, tempfile, unittest
P = pathlib.Path
ROOT = P(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('feed_worker', ROOT / 'scripts/release-retained-feed-dependencies.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)

def ref(path):
    return {'path': str(path), 'sha256': worker.sha(path.read_bytes())}

def write_json(path, value):
    path.write_text(json.dumps(value), encoding='utf-8'); return ref(path)

class Fixture:
    def __init__(self, root, *, version='4.4.3', extra=None):
        self.root = root; self.base = root / 'candidate'; self.base.mkdir()
        package = {'name':'synthetic','version':'1.0.1','type':'module','dependencies':{'zod':version,'unrelated':'1.0.0'}}
        lock = {'lockfileVersion':3,'packages':{'':{'dependencies':package['dependencies']},
            'node_modules/zod':{'version':version},'node_modules/unrelated':{'version':'1.0.0'}}}
        write_json(self.base/'package.json',package); write_json(self.base/'package-lock.json',lock)
        sources = {'dist/client/index.html':b'<p>synthetic</p>', 'dist/service/apps/service/main.js':b'export {};',
            'dist/service/apps/service/update-feed.js':b'import {schema} from "../../packages/domain/software-update.js"; export const updateManifestSchema=schema; export const updateFeedLimits={maxBytes:131072}; export class UpdateFeed {}',
            'dist/service/packages/domain/software-update.js':b'import {z} from "zod"; export const schema=z.string();'}
        for name,raw in sources.items():
            path=self.base/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
        manifest={'version':'1.0.1','artifacts':[{'path':n,'sha256':worker.sha(b)} for n,b in sources.items()]}
        write_json(self.base/'dist/candidate.json',manifest)
        candidate=worker.sha((self.base/'package.json').read_bytes()+(self.base/'dist/candidate.json').read_bytes())
        self.work=root/('retained-feed-'+candidate);self.work.mkdir()
        (self.base/'node_modules').mkdir()
        self.entries={'package.json':(self.base/'package.json').read_bytes(),'package-lock.json':(self.base/'package-lock.json').read_bytes(),
            'node_modules':None,'node_modules/zod':None,
            'node_modules/zod/package.json':json.dumps({'name':'zod','version':version,'type':'module','exports':'./index.mjs'}).encode(),
            'node_modules/zod/index.mjs':b'export const z={string:()=>({parse:x=>{if(typeof x!=="string")throw Error("string");return x;}})};',
            'node_modules/unrelated':None,'node_modules/unrelated/package.json':b'{"name":"unrelated","version":"1.0.0"}',
            'node_modules/unrelated/private.txt':b'not materialized'}
        if extra:self.entries.update(extra)
        self.archive=root/'dependencies.tgz';self.repack()
        self.pair=root/'pair.json';write_json(self.pair,{'candidateId':candidate,'applicationDependencies':self.description})
        self.request={'format':1,'base':{'directory':str(self.base),'candidateId':candidate,'manifest':ref(self.base/'dist/candidate.json')},
            'pair':ref(self.pair),'archive':ref(self.archive),'metadata':ref(root/'metadata.json'),
            'helper':ref(ROOT/'deploy/update-runner/app_dependencies.py'),'workDirectory':str(self.work)}
    def repack(self):
        expanded=0
        with tarfile.open(self.archive,'w:gz',format=tarfile.USTAR_FORMAT) as archive:
            for name,data in self.entries.items():
                t=tarfile.TarInfo(name);t.mode=0o755 if data is None else 0o644
                if data is None:t.type=tarfile.DIRTYPE
                elif isinstance(data,tuple):t.type=tarfile.SYMTYPE;t.linkname=data[0];t.mode=0o777
                else:t.size=len(data);expanded+=len(data)
                archive.addfile(t,io.BytesIO(data) if isinstance(data,bytes) else None)
        parser=worker.load_parser(ref(ROOT/'deploy/update-runner/app_dependencies.py'))
        self.description={'format':1,'archiveBytes':self.archive.stat().st_size,'archiveSha256':worker.sha(self.archive.read_bytes()),
            'expandedBytes':expanded,'fileCount':len(self.entries),'packageLockSha256':worker.sha((self.base/'package-lock.json').read_bytes()),
            'dependencyGraphSha256':parser.dependency_graph_sha256(json.loads((self.base/'package-lock.json').read_text())),
            'platform':'linux','arch':'x64','nodeVersion':'22.23.2','nodeAbi':127}
        write_json(self.root/'metadata.json',self.description)

class MaterializationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='nova-feed-dependency-test-');self.root=P(self.temp.name).resolve()
    def tearDown(self):
        self.temp.cleanup()
    def test_only_complete_zod_and_candidate_unchanged(self):
        f=Fixture(self.root); before=worker.candidate_snapshot(f.request['base'])[0]
        result=worker.materialize(f.request)
        self.assertTrue(result['materialized']);self.assertEqual(result['files'],2)
        self.assertEqual(set(p.name for p in (f.base/'node_modules').iterdir()),{'zod'})
        self.assertEqual(before,worker.candidate_snapshot(f.request['base'])[0])
        self.assertEqual(worker.materialize(f.request),result)
    def test_normal_import_before_and_after(self):
        node=os.environ.get('NOVA_TEST_NODE') or shutil.which('node')
        if not node:self.skipTest('Node needed for normal import regression')
        f=Fixture(self.root);url=(f.base/'dist/service/apps/service/update-feed.js').as_uri()
        command=[node,'--input-type=module','-e',f'const m=await import({json.dumps(url)});if(m.updateManifestSchema.parse("ok")!=="ok"||m.updateFeedLimits.maxBytes!==131072)throw Error("contract");']
        self.assertNotEqual(subprocess.run(command,capture_output=True,timeout=15).returncode,0)
        worker.materialize(f.request)
        run=subprocess.run(command,capture_output=True,timeout=15);self.assertEqual(run.returncode,0,run.stderr.decode())
    def alias_request(self, f):
        alias=self.root/'relocated-parser.py';alias.write_bytes(P(f.request['helper']['path']).read_bytes())
        request=copy.deepcopy(f.request);request['helper']=ref(alias)
        return request
    def test_relocated_parser_reuses_only_complete_output_and_preserves_owner(self):
        f=Fixture(self.root);worker.materialize(f.request);request=self.alias_request(f)
        owner=(f.work/'owner.json').read_bytes();before=worker.candidate_snapshot(f.request['base'])[0]
        target=f.base/'node_modules/zod/index.mjs';original=(target.read_bytes(),target.stat().st_ino,target.stat().st_mtime_ns)
        result=worker.materialize(request)
        self.assertTrue(result['completedOutputReused']);self.assertEqual(result['retainedOwnerSha256'],worker.sha(owner))
        self.assertEqual((f.work/'owner.json').read_bytes(),owner)
        self.assertEqual((target.read_bytes(),target.stat().st_ino,target.stat().st_mtime_ns),original)
        self.assertEqual(worker.candidate_snapshot(f.request['base'])[0],before)
        self.assertEqual(worker.materialize(request),result)
    def test_relocated_parser_requires_unchanged_old_parser_and_pinned_new_parser(self):
        f=Fixture(self.root);old=self.root/'old-parser.py';old.write_bytes(P(f.request['helper']['path']).read_bytes())
        f.request['helper']=ref(old);worker.materialize(f.request);request=self.alias_request(f);owner=(f.work/'owner.json').read_bytes()
        old.write_bytes(old.read_bytes()+b'\n# changed\n')
        with self.assertRaisesRegex(RuntimeError,'reference-changed'):worker.materialize(request)
        old.write_bytes(P(request['helper']['path']).read_bytes())
        P(request['helper']['path']).write_bytes(old.read_bytes()+b'\n# changed\n');request['helper']=ref(P(request['helper']['path']))
        with self.assertRaisesRegex(RuntimeError,'maintained-parser-changed'):worker.materialize(request)
        self.assertEqual((f.work/'owner.json').read_bytes(),owner)
    def test_relocated_parser_refuses_other_owner_fields_partial_owner_and_staging(self):
        f=Fixture(self.root);worker.materialize(f.request);request=self.alias_request(f);marker=f.work/'owner.json';original=marker.read_bytes()
        for field in ('format','base','pair','archive','metadata','workDirectory'):
            with self.subTest(field=field):
                owner=copy.deepcopy(f.request);owner[field]='different';raw=worker.encode(owner);marker.write_bytes(raw)
                with self.assertRaisesRegex(RuntimeError,'operation-conflict'):worker.materialize(request)
                self.assertEqual(marker.read_bytes(),raw)
        marker.write_bytes(original[:-7])
        with self.assertRaisesRegex(RuntimeError,'operation-conflict'):worker.materialize(request)
        marker.write_bytes(original);(f.work/'zod-staging').mkdir()
        with self.assertRaisesRegex(RuntimeError,'reuse-staging-present'):worker.materialize(request)
        self.assertEqual(marker.read_bytes(),original)
    def test_relocated_parser_does_not_repair_changed_or_incomplete_output(self):
        f=Fixture(self.root);worker.materialize(f.request);request=self.alias_request(f);target=f.base/'node_modules/zod/index.mjs'
        target.write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError,'output-corrupt'):worker.materialize(request)
        self.assertEqual(target.read_bytes(),b'corrupt');target.unlink()
        with self.assertRaisesRegex(RuntimeError,'output-incomplete'):worker.materialize(request)
        self.assertFalse(target.exists())
    def test_relocated_parser_refuses_concurrent_writer_and_candidate_mutation(self):
        f=Fixture(self.root);worker.materialize(f.request);request=self.alias_request(f)
        with worker.owned_lock(f.work):
            with self.assertRaises(OSError):worker.materialize(request)
        def change(phase):
            if phase=='completed-output-verified':(f.base/'dist/client/index.html').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError,'candidate-artifact-changed'):worker.materialize(request,checkpoint=change)
    def test_relocated_parser_refuses_linked_helper_and_late_staging(self):
        f=Fixture(self.root);worker.materialize(f.request);request=self.alias_request(f)
        alias=P(request['helper']['path']);link=self.root/'second-link.py';os.link(alias,link)
        with self.assertRaisesRegex(RuntimeError,'file-not-independent'):worker.materialize(request)
        link.unlink()
        def change(phase):
            if phase=='completed-output-verified':(f.work/'zod-staging').mkdir()
        with self.assertRaisesRegex(RuntimeError,'reuse-staging-present'):worker.materialize(request,checkpoint=change)
        (f.work/'zod-staging').rmdir()
        def add_sibling(phase):
            if phase=='completed-output-verified':(f.base/'node_modules/extra').mkdir()
        with self.assertRaisesRegex(RuntimeError,'other-modules-present'):worker.materialize(request,checkpoint=add_sibling)
    def test_relocated_parser_plan_verifies_complete_output_without_writes(self):
        f=Fixture(self.root);worker.materialize(f.request);request=self.alias_request(f);raw=worker.encode(request)
        before={p.relative_to(self.root):(p.read_bytes(),p.stat().st_mtime_ns) for p in self.root.rglob('*') if p.is_file()}
        command=[sys.executable,'-I','-B',str(ROOT/'scripts/release-retained-feed-dependencies.py'),
            '--request-base64',base64.b64encode(raw).decode(),'--request-sha',worker.sha(raw),'--plan']
        result=subprocess.run(command,capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(json.loads(result.stdout)['readOnly'])
        self.assertEqual(before,{p.relative_to(self.root):(p.read_bytes(),p.stat().st_mtime_ns) for p in self.root.rglob('*') if p.is_file()})
        (f.base/'node_modules/zod/index.mjs').write_bytes(b'bad')
        failed=subprocess.run(command,capture_output=True,text=True,timeout=20)
        self.assertNotEqual(failed.returncode,0);self.assertIn('output-corrupt',failed.stderr)
    def test_wrong_version_refused(self):
        f=Fixture(self.root,version='9.9.9')
        with self.assertRaisesRegex(RuntimeError,'version-unsupported'):worker.materialize(f.request)
    def test_archive_tamper_refused(self):
        f=Fixture(self.root);f.archive.write_bytes(f.archive.read_bytes()+b'tamper')
        with self.assertRaisesRegex(RuntimeError,'reference-changed'):worker.materialize(f.request)
    def test_source_identity_refused(self):
        f=Fixture(self.root);f.request['base']['candidateId']='0'*64
        with self.assertRaises(RuntimeError):worker.materialize(f.request)
    def test_pair_identity_refused(self):
        f=Fixture(self.root);p=json.loads(f.pair.read_text());p['candidateId']='0'*64;f.request['pair']=write_json(f.pair,p)
        with self.assertRaisesRegex(RuntimeError,'accepted-pair-changed'):worker.materialize(f.request)
    def test_traversal_refused_before_files(self):
        f=Fixture(self.root,extra={'node_modules/zod/../../escape':b'bad'})
        with self.assertRaises(RuntimeError):worker.materialize(f.request)
        self.assertFalse((self.root/'escape').exists());self.assertFalse((f.work/'zod-staging').exists())
    def test_symlink_refused(self):
        f=Fixture(self.root,extra={'node_modules/zod/link.mjs':('index.mjs',)})
        with self.assertRaisesRegex(RuntimeError,'link-forbidden'):worker.materialize(f.request)
    def test_partial_file_and_lost_response_resume(self):
        f=Fixture(self.root)
        def stop(phase):
            if phase=='file-written':raise RuntimeError('simulated-interruption')
        with self.assertRaisesRegex(RuntimeError,'simulated-interruption'):worker.materialize(f.request,checkpoint=stop)
        partial=next((f.work/'zod-staging').rglob('*.part'));partial.write_bytes(partial.read_bytes()[:9])
        result=worker.materialize(f.request);self.assertTrue(result['materialized'])
        self.assertEqual(result,worker.materialize(f.request))
    def test_post_promotion_response_loss_reconciles(self):
        f=Fixture(self.root)
        def stop(phase):
            if phase=='after-promote':raise RuntimeError('response-lost')
        with self.assertRaisesRegex(RuntimeError,'response-lost'):worker.materialize(f.request,checkpoint=stop)
        self.assertTrue((f.base/'node_modules/zod').is_dir());self.assertTrue(worker.materialize(f.request)['materialized'])
    def test_corrupt_partial_not_repaired(self):
        f=Fixture(self.root)
        def stop(phase):
            if phase=='file-written':raise RuntimeError('stop')
        with self.assertRaises(RuntimeError):worker.materialize(f.request,checkpoint=stop)
        part=next((f.work/'zod-staging').rglob('*.part'));part.write_bytes(b'bad-prefix')
        with self.assertRaisesRegex(RuntimeError,'output-corrupt'):worker.materialize(f.request)
        self.assertEqual(part.read_bytes(),b'bad-prefix')
    def test_conflicting_owner_and_output_refused(self):
        f=Fixture(self.root);worker.materialize(f.request)
        target=f.base/'node_modules/zod/index.mjs';target.write_bytes(b'tamper')
        with self.assertRaisesRegex(RuntimeError,'output-corrupt'):worker.materialize(f.request)
        self.assertEqual(target.read_bytes(),b'tamper')
    def test_active_writer_refused(self):
        f=Fixture(self.root)
        with worker.owned_lock(f.work):
            with self.assertRaises(OSError):worker.materialize(f.request)
    def test_empty_lock_interruption_resumes(self):
        f=Fixture(self.root);(f.work/'writer.lock').write_bytes(b'')
        self.assertTrue(worker.materialize(f.request)['materialized'])
    def test_partial_owner_interruption_resumes(self):
        f=Fixture(self.root);(f.work/'owner.json').write_bytes(worker.encode(f.request)[:31])
        self.assertTrue(worker.materialize(f.request)['materialized'])
        self.assertEqual((f.work/'owner.json').read_bytes(),worker.encode(f.request))
    def test_conflicting_owner_refused(self):
        f=Fixture(self.root);(f.work/'owner.json').write_bytes(b'{"not":"this-request"}')
        with self.assertRaisesRegex(RuntimeError,'operation-conflict'):worker.materialize(f.request)
    def test_worker_isolated_from_hostile_pythonpath_and_cwd(self):
        f=Fixture(self.root);hostile=self.root/'hostile';hostile.mkdir();marker=hostile/'executed'
        (hostile/'json.py').write_text('from pathlib import Path\nPath('+repr(str(marker))+').write_text("executed")\nraise RuntimeError("hostile-import")\n')
        raw=worker.encode(f.request)
        result=subprocess.run([sys.executable,'-I','-B',str(ROOT/'scripts/release-retained-feed-dependencies.py'),
            '--request-base64',base64.b64encode(raw).decode(),'--request-sha',worker.sha(raw),'--plan'],
            cwd=hostile,env={**os.environ,'PYTHONPATH':str(hostile)},capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stderr);self.assertFalse(marker.exists())
    def test_changed_candidate_during_write_refused(self):
        f=Fixture(self.root)
        def change(phase):
            if phase=='file-written':(f.base/'dist/client/index.html').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError,'candidate-artifact-changed'):worker.materialize(f.request,checkpoint=change)
        self.assertFalse((f.base/'node_modules/zod').exists())

if __name__=='__main__':unittest.main()
