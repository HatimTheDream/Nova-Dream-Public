/** Dream Claw's latest external-message preference, excluding unsent drafts. */
export function inboxReplySource<T extends {from:string;labelIds?:string[];isDraft?:boolean}>(messages:readonly T[],ownEmails:ReadonlySet<string>,addressOf:(from:string)=>string):T|null {
  const delivered=messages.filter(message=>!message.isDraft&&!message.labelIds?.includes('DRAFT'));
  for(let index=delivered.length-1;index>=0;index--)if(!ownEmails.has(addressOf(delivered[index].from)))return delivered[index];
  return delivered[delivered.length-1]??null;
}
