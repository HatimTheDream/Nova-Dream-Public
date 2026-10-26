"""Focused pure release-binding cases; no native startup or capture."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

source=Path(__file__).resolve().parents[1]/'scripts/local-native-retained-qualification.py'
spec=importlib.util.spec_from_file_location('before_release_entry',source)
entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)


def fixture():
    release=Path('C:/owned/release'); root=release/'.launcher/candidates'/('c'*64)
    current_path=str(release/'dist/candidate.json'); prior_path=str(root/'dist/candidate.json')
    evidence=str(Path('C:/owned/evidence/auth.json'))
    manifest={'version':'2.28.10','buildVersion':'1.0.383','schemaVersion':60,'apiVersion':1,'appId':'synthetic',
              'artifacts':[{'path':'dist/client/index.html','sha256':'1'*64},
                           {'path':'dist/service/apps/service/main.js','sha256':'2'*64}]}
    refs=[{'path':current_path,'sha256':'a'*64,'bytes':100},
          {'path':str(release/'package.json'),'sha256':'d'*64,'bytes':20},
          {'path':evidence,'sha256':'b'*64,'bytes':1000},
          {'path':str(release/'scripts/candidate.mjs'),'sha256':'e'*64,'bytes':50}]
    files=[]
    for name,digest,size in [('package.json','d'*64,20),('dist/candidate.json','a'*64,100),
                             ('dist/client/index.html','1'*64,10),('dist/service/apps/service/main.js','2'*64,15)]:
        ref={'path':str(root/Path(name)),'sha256':digest,'bytes':size};refs.append(ref)
        files.append({**ref,'relativePath':name})
    auth={'format':1,'kind':'retained-launcher-candidate-authentication','qualified':True,
          'noUndeclaredFiles':True,'allDeclaredArtifactHashesPassed':True,'packageAndManifestExactlyCurrent':True,
          'root':str(root),'manifest':refs[5],'currentManifest':refs[0],
          'priorCandidateId':'c'*64,'currentCandidateId':'c'*64,'verifier':refs[3],
          'packageSha256':'d'*64,'artifacts':files,'completeFilesCount':4,'declaredArtifactCount':2,
          'totalBytes':145,**{key:manifest[key] for key in ('version','buildVersion','schemaVersion','apiVersion','appId')}}
    value={'releaseRoot':str(release),'appManifest':current_path,'sourceRefs':refs,
           'beforeAppRelease':{'root':str(root),'manifest':prior_path,'authentication':evidence}}
    def read(path,*args,**kwargs):
        if path==evidence:return copy.deepcopy(auth),'b'*64
        if path in (current_path,prior_path):return copy.deepcopy(manifest),'a'*64
        raise AssertionError('Unexpected input '+str(path))
    return value,auth,manifest,read


class BeforeReleaseBindings(unittest.TestCase):
    def test_absent_before_binding_preserves_current_current_default(self):
        value,auth,manifest,read=fixture();del value['beforeAppRelease']
        with patch.object(entry,'json_read',side_effect=read) as observed:
            result=entry.app_release_bindings(value)
        self.assertEqual(result,[(value['releaseRoot'],manifest)]*2)
        self.assertEqual(observed.call_count,1)

    def test_authenticated_prior_root_is_first_and_current_root_stays_second(self):
        value,auth,manifest,read=fixture();original=copy.deepcopy(value)
        with patch.object(entry,'json_read',side_effect=read):
            result=entry.app_release_bindings(value)
        self.assertEqual(result,[(value['beforeAppRelease']['root'],manifest),(value['releaseRoot'],manifest)])
        self.assertNotEqual(result[0][0],result[1][0]);self.assertEqual(value,original)

    def test_missing_mismatched_or_redirected_prior_authority_is_refused(self):
        def remove_artifact(value,auth):value['sourceRefs'].pop()
        def wrong_hash(value,auth):value['sourceRefs'][-1]['sha256']='f'*64
        def wrong_root(value,auth):value['beforeAppRelease']['root']=str(Path('C:/elsewhere'))
        def wrong_manifest(value,auth):value['beforeAppRelease']['manifest']=value['appManifest']
        def wrong_candidate(value,auth):auth['currentCandidateId']='f'*64
        def incomplete_auth(value,auth):auth['allDeclaredArtifactHashesPassed']=False
        def unbound_verifier(value,auth):value['sourceRefs'].pop(3)
        def extra_artifact(value,auth):auth['artifacts'].append(copy.deepcopy(auth['artifacts'][-1]))
        for mutate in (remove_artifact,wrong_hash,wrong_root,wrong_manifest,wrong_candidate,incomplete_auth,unbound_verifier,extra_artifact):
            value,auth,manifest,read=fixture();mutate(value,auth)
            with self.subTest(case=mutate.__name__),patch.object(entry,'json_read',side_effect=read),self.assertRaises(RuntimeError):
                entry.app_release_bindings(value)


if __name__=='__main__':unittest.main()
