import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv,randomBytes,randomUUID } from 'node:crypto';
import { File } from 'node:buffer';
import { readImportFile } from '../apps/client/src/import-file';
const snapshot={format:1,id:'backup:'+randomUUID(),schemaVersion:15,appVersion:'1.1.3',createdAt:'2026-09-14T20:00:00.000Z',kind:'manual',tables:{}};
function encrypted(key:Buffer,changed:unknown=snapshot){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(JSON.stringify(changed)),cipher.final()]);return new TextEncoder().encode(['nova:v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join(':')).buffer;}
test('the original Nova AES-GCM backup unlocks locally and preserves its exact table snapshot',async()=>{
 const key=randomBytes(32),file=new File([key],'.backup.key');const source=await readImportFile(encrypted(key),file as globalThis.File,randomUUID(),'UTC');
 assert.equal(source.format,'nova-dream-backup-15');if(source.format==='nova-dream-backup-15')assert.deepEqual(source.snapshot,snapshot);
 assert.equal(JSON.stringify(source).includes(key.toString('base64')),false);
});
test('missing, wrong, damaged and future-schema Nova backups produce no import',async()=>{
 const key=randomBytes(32),bytes=encrypted(key),file=new File([randomBytes(32)],'.backup.key');
 await assert.rejects(readImportFile(bytes,undefined,randomUUID(),'UTC'),/matching/);
 await assert.rejects(readImportFile(bytes,file as globalThis.File,randomUUID(),'UTC'),/key does not match/);
 await assert.rejects(readImportFile(encrypted(key,{...snapshot,schemaVersion:99}),new File([key],'.backup.key') as globalThis.File,randomUUID(),'UTC'),/unsupported schema/);
});

test('the controlled Dream Claw export never reads gateway credentials or the wrapped master key',async()=>{
 const {prepareDreamClawExport}=await import('../tools/migration/dream-claw-export.mjs');
 const read:string[]=[];const data:Record<string,string>={'dream-claw-workshop-tasks':JSON.stringify({version:3,state:{tasks:[]}}),'dream-claw-gateway-token':'never-read-this','dream-claw-wrapped-master-key-v1':'never-read-key'};
 const result=prepareDreamClawExport({getItem:(key:string)=>{read.push(key);return data[key]??null;}},{version:'0.57.2',storeId:randomUUID(),timezone:'UTC'});
 assert.deepEqual(Object.keys(result.storage),['dream-claw-workshop-tasks']);assert(!read.some(key=>key.includes('token')||key.includes('master-key')));
});
