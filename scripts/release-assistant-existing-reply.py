# Loaded only by the maintained full transport's explicit existing-reply mode.
# The original effect-capable transport stays unchanged and is not called here.
def existing_reply_main(payload):
    need(sys.platform=='linux' and os.geteuid()==0,'assistant-transport-needs-linux-root');os.umask(0o077)
    binding=payload['binding'];common=payload['common'];original=common['original']
    need(payload['mode']=='existing-reply' and binding['input']['route']=='full','existing-reply-full-route-required')
    need(all(common[k]==binding[k] for k in ('operationId','parentKey','inputSha256','deadlineAtMs','input')) and uid(common['observationKey']),'existing-reply-call-binding-changed')
    old=original['accepted'];session=original['session'];need(original['request']==binding['input']['existingAssistantReply'],'existing-reply-original-input-changed')
    need(uid(old['key']) and uid(original['browser']['operationId']),'existing-reply-original-identity-invalid')
    previous=P('/var/lib/nova-update/release-coordinator')/original['browser']['operationId']/('assistant-'+old['key']);p=P(session['sessionReference']['path'])
    need(p.parent==previous and re.fullmatch('session-[a-f0-9-]{36}.json',p.name) and session['sessionSha256']==session['sessionReference']['sha256'],'existing-reply-original-session-path-changed')
    saved=json.loads(ref(session['sessionReference'],65536,True));anchor=json.loads(raw(previous/'anchor.json',8192,True))
    need(saved['bindingSha256']==anchor['bindingSha256'] and saved['deviceId']==session['deviceId'] and saved['cookies'],'existing-reply-original-session-changed')
    root=root_for(binding);result=root/('existing-reply-'+common['observationKey']+'.json');request=root/'existing-reply-request.json'
    expected={'bindingSha256':sha(enc(binding)),'observationKey':common['observationKey'],'originalSha256':sha(enc(original))}
    if result.exists():
        need(json.loads(raw(request,8192,True))==expected,'existing-reply-retained-request-changed')
        return json.loads(raw(result,2*1024**2,True))
    remaining=binding['deadlineAtMs']/1000-time.time();need(0<remaining<=300,'assistant-original-deadline-exhausted');signal.alarm(max(1,min(90,int(remaining))))
    installation(binding);root,_,deadline=checked_anchor(binding,not root.exists())
    import fcntl
    fd=os.open(root/'transport.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        protected(root/'transport.lock',private=True)
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if request.exists():need(json.loads(raw(request,8192,True))==expected,'existing-reply-retained-request-changed')
        else:save(request,expected)
        history_path='/api/assistant/history/'+old['conversationId']+'?messageId='+old['savedMessageId'];account_path='/api/assistant/account?refresh=1'
        need(uid(old['conversationId']) and uid(old['savedMessageId']),'existing-reply-history-id-invalid')
        allowed={'/api/health','/api/access/context','/api/software-update/acceptance','/api/assistant/service','/api/assistant/state',history_path,account_path}
        READS.update({history_path,account_path})
        class ReadOnlyApi(Api):
            def read(self,path,body=None,session=False):
                need(body is None and session is False and path in allowed,'existing-reply-get-only')
                return super().read(path)
        def original_projection(state,unused):
            operations=[]
            for item in state['operations']:
                if item.get('id')==old['operationId']:operations.append(item)
                elif item.get('state') in {'unknown','prepared','dispatching','accepted','running'}:operations.append({'id':item['id'],'state':item['state'],'conversationId':item.get('conversationId'),'actualStateSha256':sha(enc(item))})
            return {'connection':state['connection'],'operations':operations,'conversations':[c for c in state['conversations'] if c['id']==old['conversationId']]}
        globals()['project_state']=original_projection
        started=int(time.time()*1000);api=ReadOnlyApi(binding,deadline,saved['cookies']);cookies=api.cookies()
        before=ready(api,binding,True);check_ready(before,binding,initial=True)
        accounts=api.read(account_path);history=api.read(history_path)
        after=ready(api,binding,True);check_ready(after,binding,initial=True)
        finished=int(time.time()*1000);need(finished<binding['deadlineAtMs'] and time.monotonic()<deadline,'assistant-original-deadline-exhausted')
        need(api.cookies()==cookies,'existing-reply-session-cookie-changed')
        value={'format':1,'kind':'nova-existing-reply-observation','operationId':binding['operationId'],'parentKey':binding['parentKey'],'observationKey':common['observationKey'],'inputSha256':binding['inputSha256'],'deadlineAtMs':binding['deadlineAtMs'],'startedAtMs':started,'finishedAtMs':finished,'deviceId':saved['deviceId'],'sessionSha256':session['sessionSha256'],'httpMethods':['GET'],'sessionCreated':False,'inferenceDispatched':False,'before':before,'after':after,'accounts':accounts,'history':history}
        save(result,value);return value
    finally:signal.alarm(0);os.close(fd)
main=existing_reply_main
