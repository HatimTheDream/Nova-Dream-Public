import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/service/http';

test('isolated development origins accept only explicit loopback development servers',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'nova-development-origin-'));
 try {
  for(const developmentOrigin of ['https://foreign.example','http://localhost:4398','http://127.0.0.1:80','http://127.0.0.1:70000','http://127.0.0.1:4398/path'])await assert.rejects(startServer({directory,port:0,development:true,developmentOrigin}));
  await assert.rejects(startServer({directory,port:0,developmentOrigin:'http://127.0.0.1:4398'}));
  const service=await startServer({directory,port:0,development:true,developmentOrigin:'http://127.0.0.1:4398'});
  try {
   assert.notEqual((await fetch(service.origin+'/api/health',{headers:{Origin:'http://127.0.0.1:4398'}})).status,403);
   assert.equal((await fetch(service.origin+'/api/health',{headers:{Origin:'http://127.0.0.1:4384'}})).status,403);
  }finally{await service.close();}
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('bundled GLBs download as binary while script and remote connection boundaries stay closed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-lynx-http-'));
  const client = join(directory, 'client'); mkdirSync(client);
  const binary = Buffer.from('676c54460200000014000000000000004a534f4e', 'hex');
  writeFileSync(join(client, 'character.glb'), binary);
  writeFileSync(join(client, 'private.blend'), 'not a web asset');
  const service = await startServer({ directory: join(directory, 'data'), clientDirectory: client, port: 0 });
  try {
    const response = await fetch(service.origin + '/character.glb');
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'model/gltf-binary');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), binary);
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /connect-src 'self' blob:;/); assert.match(policy, /script-src 'self';/);
    assert.equal((await fetch(service.origin + '/private.blend')).status, 404);
    assert.equal((await fetch(service.origin + '/character.glb', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
