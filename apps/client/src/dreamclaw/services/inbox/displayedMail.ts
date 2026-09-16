/** One read update per actual opening. Preparation and index prefetching never
 * create an opening. Keeping it after dispatch preserves deliberate Mark unread. */
export function createDisplayedMailOpening() {
  let key='',attempted=false;
  return {
    select(next:string){if(next!==key){key=next;attempted=false;}},
    isCurrent(next:string){return next===key;},
    suppress(){attempted=true;},
    take(next:string,ready:boolean,visible:boolean,unread:boolean,canModify:boolean){
      if(next!==key||!next||attempted||!ready||!visible||!unread||!canModify)return false;
      attempted=true;return true;
    },
  };
}

type ReadDisplayThread={accountKey:string;id:string;sourceMessageId?:string;messageCount?:number;date?:string;labels:string[]};
export const mailReadDisplayKey=(scope:string,thread:ReadDisplayThread)=>JSON.stringify([scope,thread.accountKey,thread.id,thread.sourceMessageId,thread.messageCount,thread.date]);
export const mailAppearsUnread=(scope:string,thread:ReadDisplayThread,pending:Record<string,string>)=>thread.labels.includes('UNREAD')&&!pending[mailReadDisplayKey(scope,thread)];
