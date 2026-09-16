import type {MailAttachment,MailFile} from '../../packages/domain/mail-delivery.js';
import {mailFileUploadSchema,mailFileReadSchema} from '../../packages/domain/mail-delivery.js';
import {Store,Fault} from './store.js';
import {mailAttachmentBytes} from './mail-mime.js';
import {imagePreviewType} from './image-preview.js';

type Head=Omit<MailFile,'file'>&{device:string;file:Omit<MailAttachment,'base64'>};
const headKey=(id:string)=>`mail:file:head:${id}`,contentKey=(id:string)=>`mail:file:content:${id}`;
/** Selected local files are encrypted once. Browser journals keep only identities;
 * immutable mail reviews copy the verified bytes before any provider mutation. */
export class MailFiles {
  constructor(private store:Store) {}
  upload(device:string,raw:unknown):MailFile {
    const input=mailFileUploadSchema.parse(raw);
    const [{buffer}]=mailAttachmentBytes({attachments:[input.file]} as any);
    const {base64,...metadata}=input.file,previewMimeType=imagePreviewType(buffer) as MailFile['previewMimeType'];
    const result=this.store.admit(device,input,{type:'mail-file-upload',epoch:input.epoch,requestId:input.requestId,file:metadata},()=>{
      const total=this.store.internalList<Head>('mail:file:head:').filter(file=>file.epoch===input.epoch).reduce((sum,item)=>sum+item.file.bytes,0);
      if(total+metadata.bytes>256*1024*1024)throw new Fault(507,'mail_file_quota','Mail file storage is full. Existing messages and files are kept.');
      const head:Head={id:input.requestId,epoch:input.epoch,device,file:metadata,...(previewMimeType?{previewMimeType}:{})};
      this.store.internalWrite(headKey(head.id),head);this.store.internalWrite(contentKey(head.id),{base64});return {id:head.id};
    });
    return this.read(device,{epoch:input.epoch,id:result.value.id,sha256:metadata.sha256});
  }
  read(device:string,raw:unknown):MailFile {
    const input=mailFileReadSchema.parse(raw);
    if(input.epoch!==this.store.epoch)throw new Fault(409,'epoch_changed','Reopen this file after workspace recovery.');
    const head=this.store.internalRead<Head>(headKey(input.id));
    if(!head||head.device!==device||head.epoch!==input.epoch)throw new Fault(404,'mail_file_missing','This file has not been received for this workspace. Check again or select the same file.');
    if(input.sha256&&input.sha256!==head.file.sha256)throw new Fault(409,'mail_file_changed','This is a different file. Keep the original selection or remove it before choosing another.');
    const {device:_owner,...view}=head;
    if(!input.bytes)return view;
    const content=this.store.internalRead<{base64:string}>(contentKey(head.id));
    if(!content)throw new Fault(409,'mail_file_missing','The retained file bytes are unavailable. Your message is kept.');
    const file={...head.file,base64:content.base64};mailAttachmentBytes({attachments:[file]} as any);
    return {...view,file};
  }
  attachment(device:string,epoch:string,id:string,sha256:string):MailAttachment {
    return this.read(device,{epoch,id,sha256,bytes:true}).file as MailAttachment;
  }
}
