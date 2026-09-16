import {isMailBase64} from '../../packages/domain/mail-file-bytes.js';
import {Parser} from 'htmlparser2';
import { createHash } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { MailDeliveryMessage } from '../../packages/domain/mail-delivery.js';
import { Fault } from './store.js';
import type { DraftAddress, MailDraftEnvelope } from './provider-mail-open.js';

export type MailReplySource = { messageId:string; threadId:string; subject:string; from:string; fingerprint:string; internetMessageId?:string; references?:string[]; text?:string };
export function mailAttachmentBytes(message: MailDeliveryMessage) {
  return message.attachments.map(file => {
    if (!isMailBase64(file.base64)) throw new Fault(400,'mail_attachment_invalid','An attachment has invalid bytes. Choose it again.');
    const bytes=Buffer.from(file.base64,'base64');
    if(bytes.length!==file.bytes || createHash('sha256').update(bytes).digest('hex')!==file.sha256) throw new Fault(400,'mail_attachment_changed','An attachment changed before review. Choose it again.');
    return {...file,buffer:bytes};
  });
}
const escape = (value:string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function withMailQuote(message:MailDeliveryMessage,source?:MailReplySource):MailDeliveryMessage {
  if(!message.reply?.quote || !source) return message;
  if(!source.text) throw new Fault(409,'mail_quote_unavailable','This reply source has no verified plain-text quote. Review it before sending without a quote.');
  const heading=`${source.from} wrote:`;
  return {...message,bodyText:message.bodyText+'\n\n'+heading+'\n'+source.text.split('\n').map(line=>'> '+line).join('\n'),
    ...(message.bodyHtml ? {bodyHtml:message.bodyHtml+'<br><br><p>'+escape(heading)+'</p><blockquote style="white-space:pre-wrap">'+escape(source.text)+'</blockquote>'}:{})};
}
export function retainedMailAddresses(values:string[],original:DraftAddress[]=[]):DraftAddress[] {
  return values.map(address=>({address,...(original.find(item=>item.address.toLowerCase()===address.toLowerCase())?.name?{name:original.find(item=>item.address.toLowerCase()===address.toLowerCase())!.name}:{})}));
}
export async function buildMailMime(message:MailDeliveryMessage,operationId:string,date:string,source?:MailReplySource,envelope?:MailDraftEnvelope) {
  if(message.reply && !source?.internetMessageId) throw new Fault(409,'mail_reply_header_missing','The original message has no verified Message-ID. Review the reply source.');
  const compiler=new MailComposer({from:retainedMailAddresses([message.from],envelope?[envelope.from]:[])[0],to:retainedMailAddresses(message.to,envelope?.to),cc:retainedMailAddresses(message.cc,envelope?.cc),bcc:retainedMailAddresses(message.bcc,envelope?.bcc),subject:message.subject,text:message.bodyText,html:message.bodyHtml,
    messageId:`<${operationId}@edition3.invalid>`,date:new Date(date),headers:{'X-Edition3-Operation':operationId},
    ...(source?{inReplyTo:source.internetMessageId,references:[...(source.references??[]),source.internetMessageId!]}:envelope?{inReplyTo:envelope.inReplyTo,references:envelope.references}:{}),
    ...(envelope?{replyTo:envelope.replyTo,priority:envelope.priority}:{}),
    attachments:mailAttachmentBytes(message).map(file=>({filename:file.name,contentType:file.mimeType,content:file.buffer,cid:file.cid,contentDisposition:file.disposition})),
    disableFileAccess:true,disableUrlAccess:true, newline:'\r\n',textEncoding:'base64',baseBoundary:operationId,
  }).compile();
  compiler.keepBcc=true; // Gmail's API derives Bcc delivery recipients from raw MIME.
  return compiler.build();
}

/** Remove selected inline images without reserializing the retained HTML. The
 * parser resolves attribute entities and quoting; untouched source stays exact. */
export function removeDraftInlineImages(html:string|undefined,removed:readonly string[]):string|undefined {
  if(!html||!removed.length)return html;
  const ids=new Set(removed.map(value=>value.replace(/^<|>$/g,''))),ranges:{start:number;end:number}[]=[];
  const parser=new Parser({onopentag(name,attributes){if(name==='img'&&attributes.src?.toLowerCase().startsWith('cid:')&&ids.has(attributes.src.slice(4).replace(/^<|>$/g,'')))ranges.push({start:parser.startIndex,end:parser.endIndex+1});}},{decodeEntities:true});
  parser.end(html);let result=html;for(const range of ranges.reverse())result=result.slice(0,range.start)+result.slice(range.end);return result;
}
