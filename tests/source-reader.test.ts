import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Store } from '../apps/service/store';
import { SourceReader } from '../apps/service/source-reader';
import { sourcePdf } from './fixtures/source-files';
function fixture(t: import('node:test').TestContext) {
  const root=mkdtempSync(join(tmpdir(),'e3-source-reader-')),store=new Store(root),reader=new SourceReader(store);
  t.after(async()=>{await reader.close();store.close();rmSync(root,{recursive:true,force:true});});
  const upload=(name:string,bytes:Buffer)=>({file:store.upload('owner',randomUUID(),store.epoch,name,bytes.toString('base64')),origins:['Captured Project']});
  return {store,reader,upload};
}
test('PDF readings expose only the requested real page, and rendering supplies its actual pixels',async t=>{
  const {reader,upload}=fixture(t),source=upload('source.pdf',sourcePdf());
  const first=await reader.read(source,1,'text');assert.equal(first.pages,2);assert.match(first.text!,/ORCHID 27/);assert(!first.text!.includes('SABLE'));assert(!first.truncated);
  const second=await reader.read(source,2,'text');assert.match(second.text!,/SABLE 73/);assert(!second.text!.includes('ORCHID'));
  const rendered=await reader.read(source,2,'image');assert.equal(rendered.page,2);assert.equal(rendered.view,'image');assert(rendered.image);
  const {data,info}=await sharp(Buffer.from(rendered.image.data,'base64')).raw().toBuffer({resolveWithObject:true});
  const offset=(Math.floor(info.height*0.7)*info.width+Math.floor(info.width*0.7))*info.channels;
  assert(data[offset]<30 && data[offset+1]>150 && data[offset+2]>200,'The page contains the original cyan rectangle');
  await assert.rejects(reader.read(source,3,'text'),/could not be read/);
});
test('image sources return bounded pixels while retaining exact original attachment bytes',async t=>{
  const {store,reader,upload}=fixture(t),bytes=await sharp({create:{width:2000,height:1000,channels:3,background:'#176ce1'}}).png().toBuffer(),source=upload('source.png',bytes);
  const result=await reader.read(source,1,'text');assert.equal(result.view,'image');assert.equal(result.image?.width,1400);assert.equal(result.image?.height,700);assert.deepEqual(store.download(source.file.id).bytes,bytes);
  await assert.rejects(reader.read(source,2,'image'));
});
test('changed identities, malformed PDFs and unsupported formats cannot turn into readable evidence',async t=>{
  const {reader,upload}=fixture(t),source=upload('source.pdf',sourcePdf());
  await assert.rejects(reader.read({...source,file:{...source.file,sha256:'a'.repeat(64)}},1,'text'),/captured/);
  await assert.rejects(reader.read(upload('broken.pdf',Buffer.from('%PDF-1.7 invalid')),1,'text'),/could not be read/);
  await assert.rejects(reader.read(upload('archive.zip',Buffer.from('archive')),1,'text'),/Choose a PDF/);
  assert.match((await reader.read(source,1,'text')).text!,/ORCHID/);
});
test('long text is labeled as incomplete and service shutdown interrupts a source read',async t=>{
  const {reader,upload}=fixture(t),source=upload('long.txt',Buffer.from('x'.repeat(30000)));
  const result=await reader.read(source,1,'text');assert(result.truncated);assert.equal(result.text?.length,24000);assert.match(result.notes.join(' '),/incomplete/);
  const running=reader.read(upload('source.pdf',sourcePdf()),1,'image');const rejection=assert.rejects(running,/stopped|limits/);await reader.close();await rejection;
});
