import assert from 'node:assert/strict';
import test from 'node:test';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkSourceInspection } from '../apps/client/src/LibraryWorkSources.js';
import type { WorkSourceCheck, WorkSourceSelection } from '../packages/domain/work-sources.js';

const selected={kind:'note' as const,id:'note:one',revision:1}, latest={...selected,revision:2};
const check:WorkSourceCheck = {reference:selected,current:latest,status:'changed',canUseSelected:true,ready:false,
  message:'Choose which version to supply.', selected:{title:'Earlier note',representation:'saved-text',sha256:'a'.repeat(64),text:'Original bytes',omissions:[]},
  latest:{title:'Current note',representation:'saved-text',sha256:'b'.repeat(64),text:'Current bytes',omissions:[]}};
function control(tree:ReactNode, match:(props:{children?:ReactNode;type?:string})=>boolean): ((event?:unknown)=>void)|undefined {
  let found:((event?:unknown)=>void)|undefined;
  Children.forEach(tree,node=>{
    if (found || !isValidElement<{children?:ReactNode;onClick?:()=>void;onChange?:(event:unknown)=>void;type?:string}>(node)) return;
    if (match(node.props)) found=node.props.onClick ?? node.props.onChange;
    if (!found) found=control(node.props.children,match);
  });
  return found;
}
test('Source check displays both exact texts and preserves the explicit selected-versus-latest choice',()=>{
  let choice:WorkSourceSelection={reference:selected};
  const props={selection:choice,check,locked:false,change:(next:WorkSourceSelection)=>{choice=next;},remove(){},replace(){}};
  const html=renderToStaticMarkup(createElement(WorkSourceInspection,props));
  assert.match(html,/Original bytes/); assert.match(html,/Current bytes/);
  const tree=WorkSourceInspection(props);
  control(tree,p=>p.children==='Use Selected Version')!();
  assert.deepEqual(choice,{reference:selected,confirmedAgainst:latest});
  control(tree,p=>p.children==='Use Latest Version')!();
  assert.deepEqual(choice,{reference:latest});
});
test('Unavailable historical text and denied material cannot be chosen or displayed',()=>{
  const props={selection:{reference:selected},check:{...check,selected:undefined,canUseSelected:false},locked:false,change(){},remove(){},replace(){}};
  const html=renderToStaticMarkup(createElement(WorkSourceInspection,props));
  assert.doesNotMatch(html,/Original bytes|Use Selected Version/); assert.match(html,/Use Latest Version/);
  const denied={...check,selected:undefined,latest:undefined,current:null,status:'denied' as const,canUseSelected:false,message:'Access unavailable.'};
  const deniedHtml=renderToStaticMarkup(createElement(WorkSourceInspection,{...props,check:denied}));
  assert.doesNotMatch(deniedHtml,/Original bytes|Current bytes|Use Latest Version|Use Selected Version/);
  assert.match(deniedHtml,/Replace Source/); assert.match(deniedHtml,/Remove Source/);
});
test('A reference-only check shows its actual omissions and requires an explicit acknowledgment',()=>{
  let choice:WorkSourceSelection={reference:selected};
  const props={selection:choice,check:{...check,status:'reference-only' as const,current:selected,latest:undefined,
    selected:{title:'Saved link',representation:'reference-only' as const,url:'https://example.test',sha256:'c'.repeat(64),omissions:['Page contents are not included.']}},
    locked:false,change:(next:WorkSourceSelection)=>{choice=next;},remove(){},replace(){}};
  assert.match(renderToStaticMarkup(createElement(WorkSourceInspection,props)),/Page contents are not included/);
  control(WorkSourceInspection(props),p=>p.type==='checkbox')!({target:{checked:true}});
  assert.deepEqual(choice,{reference:selected,allowReferenceOnly:true});
});
