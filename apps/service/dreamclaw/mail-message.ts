/** Original Outlook recipient/body mappings, extracted from fixed Dream Claw
 * electron/microsoftMail.ts. E3 validates complete input instead of truncating it. */
import type { MailDeliveryMessage } from '../../../packages/domain/mail-delivery.js';
import type { DraftAddress, MailDraftEnvelope } from '../provider-mail-open.js';
export function toGraphRecipients(addresses: string[]): Array<{emailAddress:{address:string}}> {
  return addresses.map(address => String(address || '').trim()).filter(Boolean).map(address => ({emailAddress:{address}}));
}
export function originalMicrosoftMessageBody(message: MailDeliveryMessage, envelope?:MailDraftEnvelope) {
  const recipients=(values:string[],original:DraftAddress[]=[])=>toGraphRecipients(values).map(value=>{
    const name=original.find(item=>item.address.toLowerCase()===value.emailAddress.address.toLowerCase())?.name;
    return {emailAddress:{...value.emailAddress,...(name?{name}:{})}};
  });
  return {
    subject: message.subject,
    body: { contentType: message.bodyHtml ? 'html' : 'text', content: message.bodyHtml || message.bodyText },
    toRecipients: recipients(message.to,envelope?.to), ccRecipients: recipients(message.cc,envelope?.cc), bccRecipients: recipients(message.bcc,envelope?.bcc),
  };
}
