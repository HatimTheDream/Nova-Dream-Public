import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {InboxReaderFlag,InboxRowActions,InboxThreadMenu} from '../apps/client/src/dreamclaw/InboxThreadActions';
import {buildReplyRecipients} from '../apps/client/src/dreamclaw/pages/Inbox/inbox-address';

test('the visible reader flag preserves capability and busy guards and dispatches only its supplied action',()=>{
 let calls=0;const props={flagged:false,canModify:true,busy:false,onFlag:()=>{calls++;},className:'reader-action'};
 const enabled=InboxReaderFlag(props);assert.match(renderToStaticMarkup(enabled),/aria-label="Flag Thread"/);
 enabled.props.onClick();assert.equal(calls,1);
 assert.match(renderToStaticMarkup(InboxReaderFlag({...props,canModify:false})),/disabled=""/);
 assert.match(renderToStaticMarkup(InboxReaderFlag({...props,busy:true})),/disabled=""/);
 assert.match(renderToStaticMarkup(InboxReaderFlag({...props,flagged:true})),/aria-pressed="true"/);
 assert.match(renderToStaticMarkup(InboxReaderFlag({...props,flagged:true})),/Remove Flag/);
});
test('row flag pin and trash remain separate controls; local pin does not request provider write permission',()=>{
 const node=InboxRowActions({pinned:false,flagged:false,canModify:false,busy:false,inTrash:false,onPin(){},onFlag(){},onDelete(){}});
 const html=renderToStaticMarkup(node);assert.equal((html.match(/<button/g)??[]).length,3);
 assert.match(html,/Flag thread/);assert.match(html,/Pin thread/);assert.match(html,/Delete thread/);
 assert.equal((html.match(/disabled=""/g)??[]).length,2);
});
test('Reply and Reply All use the actual participants, exclude connected identities and deduplicate addresses',()=>{
 const own=new Set(['Me@Example.test','alias@example.test']),source={from:'Sender <sender@example.test>',to:'me@example.test, Person <person@example.test>',cc:'person@example.test, second@example.test, alias@example.test'};
 assert.deepEqual(buildReplyRecipients(source,own,false),{to:['sender@example.test'],cc:[]});
 assert.deepEqual(buildReplyRecipients(source,own,true),{to:['sender@example.test'],cc:['person@example.test','second@example.test']});
});
test('replying to your own sent message addresses its original recipients rather than yourself',()=>{
 const own=new Set(['me@example.test']),source={from:'Me <me@example.test>',to:'Client <client@example.test>, me@example.test',cc:'colleague@example.test'};
 assert.deepEqual(buildReplyRecipients(source,own,false),{to:['client@example.test'],cc:[]});
 assert.deepEqual(buildReplyRecipients(source,own,true),{to:['client@example.test'],cc:['colleague@example.test']});
});
test('display-name fragments and unavailable sources never invent a recipient',()=>{
 assert.deepEqual(buildReplyRecipients(null,new Set(),true),{to:[],cc:[]});
 assert.deepEqual(buildReplyRecipients({from:'sender@example.test',to:'"Doe, Jane" <jane@example.test>, Not An Address'},new Set(),true),{to:['sender@example.test'],cc:['jane@example.test']});
 assert.deepEqual(buildReplyRecipients({from:'Not An Address'},new Set(),false),{to:[],cc:[]});
});


test('Trash exposes an explicit original-folder Restore review while normal rows retain Delete',()=>{
 let restored=0,deleted=0;
 const props={pinned:false,flagged:false,canModify:true,busy:false,inTrash:true,onPin(){},onFlag(){},onDelete(){deleted++;},onRestore(){restored++;}};
 const row=InboxRowActions(props),controls=row.props.children;
 assert.equal(controls[2].props['aria-label'],'Restore Thread');assert.equal(controls[2].props.disabled,false);
 controls[2].props.onClick();assert.equal(restored,1);assert.equal(deleted,0);
 assert.equal(InboxRowActions({...props,busy:true}).props.children[2].props.disabled,true);
 assert.equal(InboxRowActions({...props,canModify:false}).props.children[2].props.disabled,true);
 assert.equal(InboxRowActions({...props,onRestore:undefined}).props.children[2].props.disabled,true);
 const normal=InboxRowActions({...props,inTrash:false});normal.props.children[2].props.onClick();assert.equal(deleted,1);assert.equal(restored,1);
 let closed=0;const menu=InboxThreadMenu({...props,canReply:true,onReplyAll(){},sender:{loading:false},onSender(){}});
 const content=menu.props.children(()=>{closed++;}),restore=content.props.children[3];
 assert.equal(restore.props.children[1].props.children,'Restore To Original Folder');restore.props.onClick();assert.equal(restored,2);assert.equal(closed,1);
});
