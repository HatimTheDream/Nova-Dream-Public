import {lazy,Suspense,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {canonical,type Snapshot} from '../../../packages/domain/contracts';
import type {Content} from '../../../packages/domain/workspace-records';
import {builtinContentTemplates,libraryItemSchema,type ContentLibraryItem,type ContentLibraryReceipt} from '../../../packages/domain/content-workspace';
import {useContentLibrary} from './useContentWorkspace';
import {useContentLibrarySave} from './useContentLibrarySave';
import {ContentLibraryDrafts,type LibraryDraft} from './content-library-recovery';
import {ContentTagsInput} from './ContentTagsInput';
import {ContentRecoveryPanel} from './ContentRecoveryPanel';
import {retainedWindowId} from './useWorkspace';
import {registerRecordDraftNavigation} from './record-draft-navigation';
import {draftBrowserStorage} from './draft-browser-storage';
import './content-workspace.css';
const ContentPreview=lazy(()=>import('./ContentPreview'));
const empty=(type:ContentLibraryItem['type']):ContentLibraryItem=>({id:'library:'+crypto.randomUUID(),type,name:'',revision:0,archived:false,guidance:'',brief:'',body:'',format:'markdown',platform:'Document',collection:'',tags:[],brandId:null});
const asRow=(item:ContentLibraryItem):LibraryDraft=>({item,rawTags:item.tags.join(', ')});

export function ContentLibrary({snapshot,close,useTemplate,seed,initialSection='all',backLabel='Back To Draft',leaveRef}:{
 snapshot:Snapshot;close:()=>void;useTemplate?:(item:ContentLibraryItem)=>void;seed?:Content;initialSection?:'all'|'templates'|'brands';backLabel?:string;leaveRef?:{current:(()=>boolean)|null};
}){
 const library=useContentLibrary(),journal=useMemo(()=>new ContentLibraryDrafts(draftBrowserStorage,{...snapshot,windowId:retainedWindowId}),[snapshot.deviceId,snapshot.epoch]);
 const [editing,setEditing]=useState<LibraryDraft|undefined>(()=>{
  if(seed){const row=asRow({...empty('template'),name:`${seed.title} template`.slice(0,100),brief:seed.brief,body:seed.body,format:seed.format,assets:seed.assets,platform:seed.platform,collection:seed.collection??'',tags:seed.tags??[],brandId:seed.brandId??null});journal.put(row);return row;}
  return journal.value.rows.find(r=>r.item.id===journal.value.selected);
 });
 const originalScope=useRef(journal),sameScope=originalScope.current===journal;
 const current=useRef(editing);current.current=editing;
 const [localError,setLocalError]=useState(journal.error),[showArchived,setShowArchived]=useState(false),[section,setSection]=useState(initialSection);
 const [preview,setPreview]=useState<ContentLibraryItem>(),[previewReturn,setPreviewReturn]=useState<string>(),[,render]=useState(0);
 const previewHeading=useRef<HTMLHeadingElement>(null),templateList=useRef<HTMLDivElement>(null);
 const item=editing?.item,saved=library.items.find(i=>i.id===item?.id);
 const normalized=item&&libraryItemSchema.safeParse({...item,revision:Math.max(1,item.revision)});
 const dirty=!!item&&(!saved||!normalized?.success||canonical(normalized.data)!==canonical(saved));
 const stale=!!item&&!!saved&&saved.revision!==item.revision;
 const retain=(row=current.current)=>{if(!sameScope){setLocalError('This window belongs to an earlier workspace. Copy its complete writing before reloading.');return false;}if(!row)return true;if(!journal.put(row)){setLocalError(journal.error);return false;}setLocalError('');return true;};
 const change=(patch:Partial<ContentLibraryItem>,rawTags?:string)=>{
  const prior=current.current;if(!prior)return;
  const row={item:{...prior.item,...patch},rawTags:rawTags??prior.rawTags};current.current=row;setEditing(row);retain(row);
 };
 const open=(next:ContentLibraryItem)=>{
  if(!retain())return;
  const row=journal.value.rows.find(r=>r.item.id===next.id)??asRow(next);
  if(!journal.put(row)){setLocalError(journal.error);return;}
  current.current=row;setEditing(row);setPreview(undefined);
 };
 const leave=()=>{if(!retain()||!journal.select(null)){setLocalError(journal.error);return;}current.current=undefined;setEditing(undefined);};
 const confirm=(receipt:ContentLibraryReceipt)=>{
  if(!sameScope||receipt.state!=='saved')return;
  const prior=current.current?.item.id===receipt.item.id?current.current:journal.value.rows.find(r=>r.item.id===receipt.item.id);
  if(!prior||prior.item.revision!==receipt.command.expectedRevision)return;
  const row={...prior,item:{...prior.item,revision:receipt.item.revision,archived:receipt.item.archived}};
  if(!journal.keep({...journal.value,rows:journal.value.rows.map(r=>r.item.id===row.item.id?row:r)})){setLocalError(journal.error);return;}
  if(current.current?.item.id===row.item.id){current.current=row;setEditing(row);}
  render(n=>n+1);
 };
 const command=useContentLibrarySave(snapshot,library.load,confirm);
 const blocked=!sameScope||command.busy||!!command.pending||command.invalid||journal.invalid;
 const closeKept=()=>{if(retain())close();};
 const navigation=useRef(retain);navigation.current=retain;
 useEffect(()=>registerRecordDraftNavigation(()=>navigation.current()),[]);
 useEffect(()=>{if(!leaveRef)return;leaveRef.current=()=>navigation.current();return()=>{leaveRef.current=null;};},[leaveRef]);
 useEffect(()=>{const guard=(event:BeforeUnloadEvent)=>{if(current.current&&!originalScope.current.put(current.current)){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[]);
 useLayoutEffect(()=>{
  if(preview)previewHeading.current?.focus({preventScroll:true});
  else if(previewReturn){Array.from(templateList.current?.querySelectorAll<HTMLButtonElement>('button[data-template-preview]')??[]).find(button=>button.dataset.templatePreview===previewReturn)?.focus({preventScroll:true});setPreviewReturn(undefined);}
 },[preview,previewReturn]);
 const save=async()=>{
  const row=current.current;if(!row||blocked||!retain())return;
  const parsed=libraryItemSchema.safeParse({...row.item,revision:Math.max(1,row.item.revision)});
  if(!parsed.success){setLocalError('Check the name, platform and tags. Your complete writing is kept.');return;}
  await command.run({expectedRevision:row.item.revision,item:parsed.data});
 };
 const customize=(source:ContentLibraryItem)=>open({...source,id:empty('template').id,revision:0,archived:false,name:(source.name+' copy').slice(0,100)});
 const field=(label:string,prop:'name'|'guidance'|'brief'|'body'|'platform'|'collection',rows?:number)=><label>{label}{rows
  ?<textarea rows={rows} maxLength={prop==='body'?100000:10000} value={item?.[prop]??''} onChange={e=>change({[prop]:e.target.value})}/>
  :<input required={prop==='name'||prop==='platform'} maxLength={100} value={item?.[prop]??''} onChange={e=>change({[prop]:e.target.value})}/>}</label>;
 return <ContentRecoveryPanel title={item?`${saved?'Edit':'New'} ${item.type==='brand'?'Brand':'Template'}`:preview?'Template Preview':section==='templates'?'Templates':section==='brands'?'Brands':'Content Library'}
  tools breakpoint={800} backLabel={backLabel} close={closeKept} fallbackFocus={()=>document.querySelector<HTMLElement>('.content-studio textarea,.records-page-content button')}>
  <div className="content-library content-tools">
   {library.error&&<p role="alert">{library.error}</p>}{(localError||command.error)&&<p role="alert">{localError||command.error}</p>}
   {command.pending&&<div className="content-library-save-status"><p>Original Library Save Unconfirmed. Continue writing; saving another change waits for this request.</p>
    <button disabled={command.busy} onClick={()=>void command.check()}>Check Original Library Save</button>
    <button disabled={command.busy} onClick={()=>void command.retry()}>Retry Original Library Save</button></div>}
   {(localError||command.error||journal.invalid)&&<details><summary>Copy Recovery And Current Writing</summary><textarea readOnly rows={12} value={JSON.stringify({current:current.current,drafts:journal.copy(),request:command.copy()},null,2)}/></details>}
   {item?<form onSubmit={e=>{e.preventDefault();void save();}}>
    <p className="metadata">{dirty?'Changes Kept On This Device':`Saved Version ${item.revision}`}</p>
    <fieldset disabled={journal.invalid}>{field('Name','name')}{item.type==='brand'?<>
     {field('Voice, Audience And Guidelines','guidance',9)}<p className="metadata">Saved guidance is shared. Earlier drafts and captured agent runs keep their original writing and captured guidance.</p>
    </>:<>
     {field('Platform Or Content Type','platform')}{field('Default Collection','collection')}
     <label>Default Tags<ContentTagsInput value={item.tags} rawValue={editing!.rawTags} onChange={tags=>change({tags})} onRawChange={(rawTags,tags)=>change({tags},rawTags)}/></label>
     <label>Format<select value={item.format??'markdown'} onChange={e=>change({format:e.target.value as 'markdown'|'text'})}><option value="markdown">Markdown</option><option value="text">Plain Text</option></select></label>
     <label>Brand<select value={item.brandId??''} onChange={e=>change({brandId:e.target.value||null})}><option value="">No Brand</option>{library.items.filter(i=>i.type==='brand'&&(!i.archived||i.id===item.brandId)).map(i=><option key={i.id} value={i.id}>{i.name}{i.archived?' · Archived':''}</option>)}</select></label>
     {field('Brief Structure','brief',5)}{field('Draft Structure','body',12)}
     {!!item.assets?.length&&<section><h4>Included Files</h4><p className="metadata">These original file references are copied into each new draft. Removing one here does not delete its file.</p>{item.assets.map(file=><div className="compact-actions" key={file.id}><span>{file.name}</span><button type="button" onClick={()=>change({assets:current.current?.item.assets?.filter(f=>f.id!==file.id)})}>Remove <span className="preserve-case">{file.name}</span></button></div>)}</section>}
    </>}</fieldset>
    {stale&&saved&&<section><h3>Newer Saved Version {saved.revision}</h3><p className="preserve-case">{saved.name}</p><pre className="preserve-case">{saved.type==='brand'?saved.guidance:saved.body}</pre>
     {([false,true] as const).map(useSaved=><button type="button" key={String(useSaved)} disabled={blocked} onClick={()=>{if(!current.current)return;if(!journal.prepare(current.current,saved,useSaved)){setLocalError(journal.error);return;}const row=journal.value.rows.find(r=>r.item.id===saved.id)!;current.current=row;setEditing(row);setLocalError('');}}>{useSaved?'Prepare The Saved Version':'Prepare My Kept Version'}</button>)}
     <p>Both complete versions are kept before preparing this choice. Review the fields, then save explicitly.</p></section>}
    <div className="compact-actions">
     <button type="button" onClick={leave}>Back To Library</button>
     <button type="button" disabled={blocked} onClick={()=>{if(!current.current)return;if(!journal.discard(current.current.item.id)){setLocalError(journal.error);return;}current.current=undefined;setEditing(undefined);}}>Discard Changes &amp; Back</button>
     <button className="primary" disabled={blocked||stale}>Save {item.type==='brand'?'Brand':'Template'}</button>
     {saved&&<button type="button" disabled={blocked||dirty} onClick={()=>{if(blocked||dirty||!retain())return;void command.run({expectedRevision:saved.revision,item:{...saved,archived:!saved.archived}});}}>{saved.archived?'Restore':'Archive'}</button>}
    </div>
   </form>:preview?<section className="content-template-preview">
    <h3 className="preserve-case" ref={previewHeading} tabIndex={-1}>{preview.name}</h3><p className="metadata">{preview.platform} · {preview.id.startsWith('template:')?'Starter':`Version ${preview.revision}`} · {preview.format==='text'?'Plain Text':'Markdown'}</p>
    <dl><dt>Collection</dt><dd className="preserve-case">{preview.collection||'None'}</dd><dt>Tags</dt><dd className="preserve-case">{preview.tags.join(', ')||'None'}</dd><dt>Brand</dt><dd className="preserve-case">{library.items.find(i=>i.id===preview.brandId)?.name??(preview.brandId?'Unavailable Brand':'None')}</dd></dl>
    <h4>Brief Structure</h4><pre className="preserve-case">{preview.brief||'No brief supplied.'}</pre><h4>Draft Preview</h4>
    <Suspense fallback={<p>Loading Preview</p>}><ContentPreview value={{body:preview.body,format:preview.format??'markdown',assets:preview.assets??[]}}/></Suspense>
    <details><summary>Complete Draft Source</summary><pre className="preserve-case">{preview.body||'This template starts with an empty draft.'}</pre></details>
    {!!preview.assets?.length&&<><h4>Included Files</h4><ul>{preview.assets.map(file=><li key={file.id}>{file.name}</li>)}</ul></>}
    <div className="compact-actions"><button onClick={()=>{setPreviewReturn(preview.id);setPreview(undefined);}}>Back To Templates</button>
     {useTemplate&&!preview.archived&&<button className="primary" onClick={()=>{if(retain())useTemplate(preview);}}>Use Template</button>}
     <button onClick={()=>customize(preview)}>Customize Copy</button>{!preview.id.startsWith('template:')&&<button onClick={()=>open(preview)}>Edit Template</button>}</div>
   </section>:<>
    <nav className="compact-actions" aria-label="Content Library Sections"><button aria-pressed={section==='templates'} onClick={()=>setSection('templates')}>Templates</button><button aria-pressed={section==='brands'} onClick={()=>setSection('brands')}>Brands</button></nav>
    {!!journal.value.rows.length&&<section><h3>Kept Edits</h3><div className="content-library-list">{journal.value.rows.map(row=><button key={row.item.id} className="preserve-case" onClick={()=>open(row.item)}>{row.item.name||`Unnamed ${row.item.type}`}</button>)}</div></section>}
    <div className="compact-actions">{section!=='brands'&&<button onClick={()=>open(empty('template'))}>New Template</button>}{section!=='templates'&&<button onClick={()=>open(empty('brand'))}>New Brand</button>}</div>
    {section!=='brands'&&<><h3 className={section==='templates'?'sr-only':undefined}>Templates</h3><div className="content-library-list" ref={templateList}>{[...builtinContentTemplates,...library.items.filter(i=>i.type==='template'&&i.archived===showArchived)].map(template=><article key={template.id}><div><strong className="preserve-case">{template.name}</strong><small>{template.platform}{template.id.startsWith('template:')?' · Starter':` · Version ${template.revision}`}</small></div><div className="compact-actions"><button data-template-preview={template.id} onClick={()=>setPreview(template)}>Preview</button><button onClick={()=>template.id.startsWith('template:')?customize(template):open(template)}>{template.id.startsWith('template:')?'Customize Copy':'Edit'}</button></div></article>)}</div></>}
    {section!=='templates'&&<><h3 className={section==='brands'?'sr-only':undefined}>Brand Guidance</h3><div className="content-library-list">{library.items.filter(i=>i.type==='brand'&&i.archived===showArchived).map(brand=><article key={brand.id}><div><strong className="preserve-case">{brand.name}</strong><small>Version {brand.revision}</small></div><button onClick={()=>open(brand)}>Edit</button></article>)}</div>{!library.items.some(i=>i.type==='brand'&&!i.archived)&&<p>Keep a shared voice, audience and guidelines for future drafts and agent runs.</p>}</>}
    <label className="check-row"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>Show Archived Library Items</label>
   </>}
  </div>
 </ContentRecoveryPanel>;
}
