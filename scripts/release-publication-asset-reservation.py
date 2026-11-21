"""Admit an original app publication whose Python child never reached dispatch."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('original_asset_producer', HERE/'release-delivery-full-publication.py')
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)
F = A.F
FIELDS = ('archive','execution','qualification','metadata')


def read_reference(ref):
    return json.loads(A.ref(ref, 2*1024*1024))


def sha_js(value):
    return hashlib.sha256((json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)+'\n').encode()).hexdigest()


def check_pending(request_ref, reservation_ref, binding, paths, projected_digest):
    request = read_reference(request_ref)
    original = request['spec']
    key = request['key']
    out = Path(request['outputDirectory'])
    journal = out.parent
    evidence = journal/'delivery-evidence'
    F.need(original['role']=='app' and out.name=='full-publication-'+key+'-app'
           and journal.name=='journal-'+request['operationId']
           and Path(request_ref['path'])==evidence/(key+'-full-asset-app-request.json')
           and Path(reservation_ref['path'])==evidence/(key+'-full-asset-app-dispatch.json'),
           'original-app-reservation-path-mismatch')
    reserve = read_reference(reservation_ref)
    F.need(reserve=={'format':1,'operationId':request['operationId'],'key':key,'role':'app',
                     'outputDirectory':str(out),'automaticReplayPermitted':False}, 'original-app-reservation-changed')
    verified = read_reference(binding)
    F.need(verified['kind']=='same-original-qualified-dependency-inputs' and verified['status']=='verified'
           and set(verified['rows'])=={'archive','execution','metadata'}
           and set(paths)==set(FIELDS),'reserved-local-input-paths-changed')
    for role in FIELDS:
        old = request['signed']['dependencies'][role]
        record = verified['rows']['execution' if role=='qualification' else role]
        F.need(old==record['originalDescriptorRef'] and record['independentSingleLink'] is True
               and record['actualWindowsInput']=={'path':paths[role],'sha256':old['sha256']},'reserved-local-input-changed')
        old['path']=paths[role]
    F.need(sha_js(request)==projected_digest,'reserved-projected-request-changed')
    checked, role = A.inspect(request)
    F.need(checked==out and role==original,'reserved-original-signed-app-required')
    return request


def release_observation(request, client):
    paired = client.releases()
    rows = {}
    for side in ('private','public'):
        name = 'Nova-Dream' + ('-Public' if side=='public' else '')
        row = paired[name]
        release = row['release']
        F.need(release['id']==request['releaseIds'][side] and release['target_commitish']==request['sourceCommits'][side],
               'reserved-release-source-changed')
        rows[side] = {'repositoryId':row['repositoryId'],'releaseId':release['id'],'sourceCommit':release['target_commitish'],'tag':release['tag_name']}
    name = request['spec']['name']
    release = paired['Nova-Dream']['release']
    status, assets = A.G.api('/repos/'+F.PRIVATE+'/releases/'+str(release['id'])+'/assets?per_page=100&page=1',client.token)
    # A full page cannot prove that an identically named asset is absent on a later page.
    F.need(status==200 and isinstance(assets,list) and len(assets)<100 and len(release['assets'])==len(assets)
           and all(type(item.get('id')) is int and item['id']>0 and isinstance(item.get('name'),str) for item in assets)
           and len({item['id'] for item in assets})==len(assets)
           and sorted((item['id'],item['name']) for item in assets)==sorted((a['id'],a['name']) for a in release['assets'])
           and not any(a['name']==name for a in assets),'reserved-original-release-asset-not-proven-absent')
    return rows


def locations(request):
    root = Path(request['outputDirectory'])
    ledger = F.ledger_directory(request['ledgerDirectory'])
    release = str(request['releaseIds']['private'])
    return root, ledger/(release+'-'+request['spec']['name']+'.intent.json'), root.with_suffix('.first-native-claim.json')


def unused(paths):
    F.need(all(not os.path.lexists(path) for path in paths),'original-asset-native-or-external-reservation-exists')


def observe(request, args):
    unused(locations(request))
    repositories = release_observation(request, A.Client(request))
    unused(locations(request))
    return {'format':1,'kind':'nova-reserved-publication-asset-plan','operationId':request['operationId'],'key':request['key'],
            'inputSha256':request['inputSha256'],'requestSha256':args['request']['sha256'],'reservationSha256':args['reservation']['sha256'],
            'bindingSha256':args['binding']['sha256'],'projectedRequestSha256':args['projectedSha256'],
            'releaseIds':request['releaseIds'],'repositories':repositories,'spec':request['spec'],'assetAbsent':True,'readOnly':True}


def grant_claim(args):
    return {key:args[key] for key in ('request','reservation','binding','projectedSha256','noPostPlan','expiresAtMs')}


def execute_original(request,args,now=lambda:int(time.time()*1000)):
    F.need(type(args['expiresAtMs']) is int and now()<args['expiresAtMs'],'reserved-app-grant-expired')
    expected = read_reference(args['noPostPlan'])
    F.need(expected==observe(request,args),'reserved-app-plan-changed')
    F.need(now()<args['expiresAtMs'],'reserved-app-grant-expired')
    root, external, claim = locations(request)
    unused((root,external,claim))
    # No retry, including a crash between this exclusive claim and the stock native dispatch.
    F.save(claim,(json.dumps(grant_claim(args),sort_keys=True,separators=(',', ':'),ensure_ascii=False)+'\n').encode())
    unused((root,external))
    F.need(now()<args['expiresAtMs'],'reserved-app-grant-expired')
    return A.produce('execute',request)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=['plan','issue'])
    parser.add_argument('--packet',required=True)
    opts=parser.parse_args()
    try:
        p=json.loads(base64.b64decode(opts.packet,validate=True))
        request=check_pending(p['request'],p['reservation'],p['binding'],p['paths'],p['projectedSha256'])
        result=observe(request,p) if opts.mode=='plan' else execute_original(request,p)
    except Exception as error:
        print(json.dumps({'state':'uncertain','reason':'original-reserved-app-response-unavailable',
                          'privateDiagnostic':{'type':type(error).__name__,'message':str(error)[:200]}}))
        return 2
    print(json.dumps(result))
    return 0 if opts.mode=='plan' or result['state']=='completed' else 2


if __name__=='__main__':
    raise SystemExit(main())
