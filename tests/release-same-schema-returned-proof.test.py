"""Pure receipt fixtures for the same-schema supplemental returned-rehearsal reader."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]/'scripts'/'full-host-primitives'
reader = ModuleType('same_schema_reader')
for name in ('collect-returned-completion.py', 'collect-same-schema-returned-completion.py'):
    source = ROOT/name
    exec(compile(source.read_bytes(), str(source), 'exec'), vars(reader))

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def fixture():
    values = {'leaseId': 'example-lease', 'candidateId': 'example-candidate', 'workspaceEpoch': 'example-epoch'}
    docs, rows = {}, {}
    def add(role, document):
        name = f'startup-1-{role}.json'
        docs[name], rows[name] = document, {'bytes': len(json.dumps(document)), 'sha256': digest(document)}
        return rows[name]['sha256']
    shared = {'format': 1, 'attempt': 1, 'jobId': values['leaseId']}
    started = {**shared, 'candidateId':values['candidateId'], 'epoch':values['workspaceEpoch'],
               'agentVersion':reader.SAME_SCHEMA['agentVersion'], 'notBeforeTicks':4,
               'startedAtSeconds':16, 'service':'example.service'}
    handle = {'pid':37, 'startTicks':5}
    fork = {**shared, 'startedReceiptSha256':add('started', started), 'invocationId':'c'*32,
            'process':handle, 'observedAtSeconds':17}
    process = {**started, 'bindingReceiptSha256':add('fork-observed', fork), 'process':handle,
               'processBinding':{'invocationId':fork['invocationId'], 'process':handle}, 'processObservedAtSeconds':17}
    ready = {**process, 'processReceiptSha256':add('process', process), 'readyAtSeconds':18}
    add('closed', {**ready, 'readyReceiptSha256':add('ready', ready), 'closedAtSeconds':19, 'owningServiceFullyStopped':True})
    capacity = {'attempt':1,'allocation':100}
    return rows, docs, values, {**capacity, 'receiptSha256':add('capacity', capacity)}


class Settlement(unittest.TestCase):
    def test_settled_chain_and_damaged_role_contents(self):
        rows, docs, values, budget = fixture()
        self.assertEqual(reader.ordinary_attempt(1, rows, docs, values, budget), 'c'*32)
        for role, field, value in (
            ('started','jobId','another-lease'), ('started','attempt',True), ('started','candidateId','another-candidate'),
            ('started','epoch','another-epoch'), ('capacity','allocation',101), ('fork-observed','startedReceiptSha256','x'),
            ('process','bindingReceiptSha256','x'), ('process','processBinding',{}), ('ready','processReceiptSha256','x'),
            ('ready','readyAtSeconds',15), ('closed','readyReceiptSha256','x'), ('closed','owningServiceFullyStopped',False)):
            with self.subTest(role=role,field=field), patch.dict(docs[f'startup-1-{role}.json'],{field:value}), self.assertRaises(ValueError):
                reader.ordinary_attempt(1, rows, docs, values, budget)
        with patch.dict(budget,receiptSha256='bad'), self.assertRaises(ValueError):
            reader.ordinary_attempt(1, rows, docs, values, budget)


class SourcePath(PurePosixPath):
    def lstat(self):
        return SimpleNamespace(st_mode=stat.S_IFDIR, st_dev=2, st_ino=3)
    def resolve(self,strict=False):
        return self


class StoppedSource(unittest.TestCase):
    def setUp(self):
        self.output = SourcePath('/tmp/example')
        self.v = {'leaseId':'example','stage':'/test/stage','stateDirectory':'/test/state','workspaceEpoch':'epoch',
                  'candidateId':'candidate','stageResult':{'helperHashes':{}},'files':{'operator-review.json':'review'}}
        self.detail = {'reviewSha256':'review', 'snapshotManifestSha256':'manifest'}
        self.relative = 'recovered-workspaces/example/openclaw-runtime/openclaw.json'
        base = '/var/lib/nova-update-recovery/operator-rehearsal-example/workspace'
        self.review = {'leaseId':'example','candidateId':'candidate','workspaceEpoch':'epoch','novaVersion':'2.28.50',
                       'agentVersion':reader.SAME_SCHEMA['agentVersion'],'sameSchemaQualification':reader.SAME_SCHEMA,
                       'helperHashes':{}}
        self.prior = {'format':1, 'kind':'same-schema-closed-prior-source','workspaceEpoch':'epoch','candidateId':'candidate',
                      'sourceClosed':True,'sourceRoot':base,'sourceIdentity':[2,3], 'manifestSha256':'manifest',
                      'configuration':{'path':base+'/'+self.relative,'bytes':32,'sha256':'cfg'}}
        prefix = str(SourcePath(self.relative).parent/'state/tmp/plugin-captures')+'/'
        self.owner = prefix+'00000000-0000-0000-0000-111111111111/owner.sqlite'
        self.manifest = {self.relative:{'kind':'file','size':32,'sha256':'cfg'}, self.owner: {
            'kind':'file','size':4096,'sha256':reader.RETIRED_OWNER},
            self.owner.replace('111111111111','222222222222'): {
                'kind':'file','size':4096,'sha256':reader.RETIRED_OWNER}}
        docs = {'operator-review.json':('review',self.review),'same-schema-prior-source.json':('prior',self.prior),
                'snapshot-manifest.json':('manifest',self.manifest)}
        def read(path, bound):
            key,doc = docs[path.name]
            return {'bytes':10,'sha256':key},doc
        for p in (patch.object(reader,'Path',SourcePath), patch.object(reader,'RETAINED_CAPTURE_HELPERS',{},create=True),
                  patch.object(reader,'protected',create=True), patch.object(reader,'returned_file',side_effect=read),
                  patch.object(reader.os.path,'lexists',return_value=False)):
            p.start()
            self.addCleanup(p.stop)

    def check(self):
        return reader.ordinary_return_source(self.output,self.v,self.detail)

    def test_authentic_stopped_source_and_corruptions(self):
        self.assertEqual(self.check()['sha256'],'prior')
        for target, fields in [(self.review,{'sameSchemaQualification':{}}),(self.review,{'applicationTransition':{}}),
                               (self.review,{'novaVersion':'2.28.39'}),(self.prior,{'sourceClosed':False}),
                               (self.prior,{'sourceIdentity':[3,2]}),(self.prior,{'manifestSha256':'other'}),
                               (self.detail,{'nativeCaptureSourceSha256':'present'}),
                               (self.manifest[self.relative],{'sha256':'changed'}),
                               (self.manifest[self.owner],{'size':8192}),
                               (self.manifest[self.owner],{'sha256':'staged'}),
                               (self.manifest,{self.owner+'-wal':{'kind':'file'}})]:
            with self.subTest(fields=fields), patch.dict(target,fields), self.assertRaises(ValueError):
                self.check()
        with patch.dict(self.manifest):
            del self.manifest[self.owner]
            with self.assertRaises(ValueError):
                self.check()
        for sidecar in ['native-capture-source.json','returned-original-capture.json','held-prior-native-capture.json']:
            with patch.object(reader.os.path,'lexists',side_effect=lambda p:p.name==sidecar), self.assertRaises(ValueError):
                self.check()


if __name__ == '__main__':
    unittest.main()
