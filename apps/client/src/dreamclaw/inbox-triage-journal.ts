import { createStore } from 'zustand/vanilla';
import type { z } from 'zod';
import type { MailTriagePlan, mailDisplayedSchema, mailTriagePrepareSchema, mailTriageConfirmSchema } from '../../../../packages/domain/mail-triage';
import { ApiError, readLocal, request, saveLocal } from '../api';

type Prepare=z.infer<typeof mailTriagePrepareSchema>;
type Confirm=z.infer<typeof mailTriageConfirmSchema>;
type Displayed=z.infer<typeof mailDisplayedSchema>;
type ReviewRecord={prepare:Prepare;displayed?:Displayed;plan?:MailTriagePlan;confirmation?:Confirm;pending?:'prepare'|'confirm';error?:string};
type Kept={records:Record<string,ReviewRecord>;openId?:string};
type Transport=(action:'prepare'|'confirm'|'read'|'reconcile',input:unknown)=>Promise<MailTriagePlan>;
type Disk={read(key:string):Kept|undefined;write(key:string,value:Kept):boolean};
const transport:Transport=(action,input)=>request(`mail/triage/${action}`,input,undefined,35000);
export function createInboxTriageJournal(scope:{epoch:string;deviceId:string;windowId:string;previousWindowId?:string},send:Transport=transport,disk:Disk={read:readLocal,write:saveLocal},sendDisplayed:(input:Displayed)=>Promise<{plan?:MailTriagePlan}>=input=>request('mail/triage/displayed',input,undefined,35000)) {
  const keyFor=(id:string)=>`e3:inbox-triage:${scope.epoch}:${scope.deviceId}:${id}`,key=keyFor(scope.windowId);
  const initial=structuredClone(disk.read(key)??(scope.previousWindowId?disk.read(keyFor(scope.previousWindowId)):undefined)??{records:{}});
  const store=createStore<Kept&{storageError:boolean;busy:boolean}>(()=>({...initial,storageError:false,busy:false}));
  let job:Promise<MailTriagePlan>|undefined;
  function keep(patch:Partial<Kept>,required=false) {
    const next={records:store.getState().records,openId:store.getState().openId,...patch},saved=disk.write(key,next);store.setState({...next,storageError:!saved});
    if(required&&!saved)throw new Error('This mail review could not be saved on this device. Free browser storage before changing mail.');
  }
  function update(id:string,record:ReviewRecord,required=false){keep({records:{...store.getState().records,[id]:structuredClone(record)}},required);}
  function find(planId:string){const entry=Object.entries(store.getState().records).find(([,record])=>record.plan?.id===planId);if(!entry)throw new Error('Open the saved review before continuing.');return entry;}
  function track(run:()=>Promise<MailTriagePlan>):Promise<MailTriagePlan> {
    if(job)return job;store.setState({busy:true});job=run().finally(()=>{job=undefined;store.setState({busy:false});});return job;
  }
  async function dispatch(id:string,action:Parameters<Transport>[0],payload:unknown) {
    const record=store.getState().records[id];
    try {
      const plan=await send(action,payload);
      if(plan.epoch!==scope.epoch||plan.writerId!==record.prepare.writerId||(record.plan&&(plan.id!==record.plan.id||plan.digest!==record.plan.digest||plan.revision<record.plan.revision)))throw new Error('The returned review does not match the saved action. Keep the original review and check again.');
      update(id,{...record,plan,pending:undefined,error:undefined});return plan;
    }catch(error) {
      const definitive=error instanceof ApiError&&(error.status??0)>=400&&(error.status??0)<500&&error.status!==408&&error.status!==429;
      update(id,{...record,...(definitive?{pending:undefined}:{}),error:error instanceof Error?error.message:'This mail result is not confirmed. Check its saved review.'});throw error;
    }
  }
  async function dispatchDisplayed(id:string) {
    const record=store.getState().records[id];
    try {
      const {plan}=await sendDisplayed(record.displayed!);
      if(plan&&(plan.epoch!==scope.epoch||plan.action!=='mark-read'||plan.outcomes.some(outcome=>outcome.accountId!==record.displayed!.target.accountId||!record.displayed!.messageIds.includes(outcome.messageId))))throw new Error('Read status did not match the opened message. Check its saved result.');
      update(id,{...record,prepare:{...record.prepare,writerId:plan?.writerId??record.prepare.writerId},plan,pending:undefined,error:undefined});
      return {plan};
    }catch(error){
      const definitive=error instanceof ApiError&&(error.status??0)>=400&&(error.status??0)<500&&error.status!==408&&error.status!==429;
      update(id,{...record,...(definitive?{pending:undefined}:{}),error:error instanceof Error?error.message:'Read status was not confirmed. Check its saved result.'});throw error;
    }
  }
  const journal={store,
    open(planId?:string){keep({openId:planId});},
    async displayed(input:Omit<Displayed,'epoch'|'requestId'>) {
      if(store.getState().busy||Object.values(store.getState().records).some(record=>record.pending))throw new Error('Check the pending mail action before updating read status.');
      const id=crypto.randomUUID(),displayed={...input,epoch:scope.epoch,requestId:crypto.randomUUID()};
      update(id,{displayed,prepare:{epoch:scope.epoch,requestId:displayed.requestId,writerId:crypto.randomUUID(),action:'mark-read',targets:[input.target]},pending:'prepare'},true);
      store.setState({busy:true});try{return await dispatchDisplayed(id);}finally{store.setState({busy:false});}
    },
    async prepare(input:Omit<Prepare,'requestId'|'writerId'|'epoch'>) {
      if(store.getState().busy)throw new Error('Wait for the current mail review.');
      if(Object.values(store.getState().records).some(record=>record.pending))throw new Error('A mail review has an unconfirmed response. Check that saved review first.');
      const id=crypto.randomUUID(),prepare={...input,epoch:scope.epoch,requestId:crypto.randomUUID(),writerId:crypto.randomUUID()};
      update(id,{prepare,pending:'prepare'},true);
      return track(async()=>{const plan=await dispatch(id,'prepare',prepare);keep({openId:plan.id});return plan;});
    },
    async act(planId:string,decision:Confirm['decision'],digest:string) {
      if(store.getState().busy)throw new Error('Wait for the current mail review.');
      const [id,record]=find(planId),plan=record.plan!;
      if(record.pending)throw new Error('Check the unconfirmed result before choosing another action.');
      const confirmation:Confirm={epoch:scope.epoch,requestId:crypto.randomUUID(),planId,expectedRevision:plan.revision,digest,decision};
      update(id,{...record,confirmation,pending:'confirm',error:undefined},true);
      return track(()=>dispatch(id,'confirm',confirmation));
    },
    async check(recordId:string) {
      const record=store.getState().records[recordId];if(!record)throw new Error('This saved review is unavailable.');
      return track(async()=>{
        if(record.pending)update(recordId,record,true);
        if(record.pending==='prepare'){
          const plan=record.displayed?(await dispatchDisplayed(recordId)).plan:await dispatch(recordId,'prepare',record.prepare);
          if(!plan)throw new Error('This conversation was already read. Refresh Inbox for its current status.');
          keep({openId:plan.id});return plan;
        }
        if(record.pending==='confirm'&&record.confirmation) {
          try{return await dispatch(recordId,'confirm',record.confirmation);}catch(error){if(!(error instanceof ApiError&&error.status===409))throw error;}
        }
        if(!record.plan)throw new Error(record.error??'This review could not be prepared. Select the messages again.');
        return dispatch(recordId,'reconcile',{epoch:scope.epoch,planId:record.plan.id});
      });
    },
    checkPlan(planId:string){return journal.check(find(planId)[0]);},
  };
  return journal;
}
export type InboxTriageJournal=ReturnType<typeof createInboxTriageJournal>;
