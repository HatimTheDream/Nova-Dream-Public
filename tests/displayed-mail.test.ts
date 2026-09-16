import test from 'node:test';
import assert from 'node:assert/strict';
import {createDisplayedMailOpening,mailReadDisplayKey,mailAppearsUnread} from '../apps/client/src/dreamclaw/services/inbox/displayedMail';
test('only a ready, visible, current opening can mark mail read; deliberate unread remains until reopening',()=>{
 const opening=createDisplayedMailOpening();opening.select('a');
 assert.equal(opening.take('a',false,true,true,true),false);
 assert.equal(opening.take('a',true,false,true,true),false);
 assert.equal(opening.take('a',true,true,true,false),false);
 assert.equal(opening.take('a',true,true,false,true),false);
 opening.select('b');assert.equal(opening.take('a',true,true,true,true),false);
 assert.equal(opening.take('b',true,true,true,true),true);assert.equal(opening.take('b',true,true,true,true),false);
 opening.select('c');opening.suppress();assert.equal(opening.take('c',true,true,true,true),false);
 opening.select('b');assert.equal(opening.take('b',true,true,true,true),true);
});

test('pending read appears instantly without changing provider labels, rolls back on failure and cannot hide a new arrival or other account',()=>{
 const thread={accountKey:'gmail:one',id:'t',sourceMessageId:'m1',messageCount:1,date:'today',labels:['INBOX','UNREAD']};
 const pending={[mailReadDisplayKey('scope',thread)]:'request'};
 assert.equal(mailAppearsUnread('scope',thread,pending),false);assert.ok(thread.labels.includes('UNREAD'));
 assert.equal(mailAppearsUnread('scope',thread,{}),true);
 assert.equal(mailAppearsUnread('scope',{...thread,labels:['INBOX']},{}),false);
 for(const next of [{...thread,sourceMessageId:'m2'},{...thread,messageCount:2},{...thread,accountKey:'gmail:two'}])assert.equal(mailAppearsUnread('scope',next,pending),true);
 assert.equal(mailAppearsUnread('new-scope',thread,pending),true);
});
