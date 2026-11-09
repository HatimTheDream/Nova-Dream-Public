"""Current operator quality only; retained application release CI is separate."""
import argparse,importlib.util,json,pathlib,re
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('maintained_ci_producer',HERE/'release-delivery-ci.py')
D=importlib.util.module_from_spec(spec);spec.loader.exec_module(D)
def collect(request):
 D.need(set(request)=={'format','source','runId','tools'} and request['format']==1,'operator-ci-request-invalid')
 source=request['source'];run_id=request['runId']
 D.need(source['repository'] in ('HatimTheDream/Nova-Dream','HatimTheDream/Nova-Dream-Public') and source['branch'] in ('codex/operator-continuation-31','operator/prejournal-c494-r1','operator/prejournal-c494-r2')
  and re.fullmatch('[a-f0-9]{40}',source['commit']) and type(run_id) is int and run_id>0,'operator-ci-source-invalid')
 token=D.credential(request['tools']);prefix='/repos/'+source['repository']
 status,run=D.C.api(prefix+'/actions/runs/'+str(run_id),token);D.need(status==200,'operator-ci-run-unavailable')
 D.need(run.get('id')==run_id and run.get('head_sha')==source['commit'] and run.get('head_branch')==source['branch']
  and run.get('event')=='push' and run.get('path')=='.github/workflows/operator-continuation-quality.yml'
  and type(run.get('run_attempt')) is int and run['run_attempt']>0 and run.get('name')=='Operator continuation quality' and run.get('status')=='completed' and run.get('conclusion')=='success','operator-ci-exact-success-required')
 status,jobs=D.C.api(prefix+'/actions/runs/'+str(run_id)+'/attempts/'+str(run['run_attempt'])+'/jobs?per_page=100',token)
 D.need(status==200 and jobs.get('total_count')==1 and len(jobs.get('jobs',[]))==1,'operator-ci-jobs-unavailable')
 return {'run':run,'jobs':jobs,'requestedAttempt':run['run_attempt']}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--request',required=True);p.add_argument('--request-sha256',required=True);a=p.parse_args()
 request=json.loads(D.read_ref({'path':a.request,'sha256':a.request_sha256},65536))
 print(json.dumps(collect(request)))
