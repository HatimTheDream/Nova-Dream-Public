import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {pathToFileURL} from 'node:url';
import policy from '../apps/desktop/companion-access.cjs';
const require=createRequire(import.meta.url),source=fs.readFileSync(new URL('../apps/desktop/companion-main.cjs',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));

async function harness(t, initial) {
  const dir=fs.mkdtempSync(join(tmpdir(),'nova-desktop-native-')), profile=join(dir,'NovaDream-Companion-QA-fixture');
  fs.mkdirSync(profile);fs.mkdirSync(join(dir,'.local/bin'),{recursive:true});fs.writeFileSync(join(dir,'.local/bin/cua-driver'),'fixture, never executed');
  const connection={deviceId:'fixture-device',epoch:'fixture-epoch'}, origin='https://nova.example';
  fs.writeFileSync(join(profile,'connection.enc'),JSON.stringify({connection,origin,...initial}));
  const app=new EventEmitter(),handlers=new Map(),intervals=[],children=[],windows=[],dialogs=[];let admitted=true, readyResolve,delayReady=false;
  const paths={appData:dir};Object.assign(app,{setName(){},setAppUserModelId(){},setPath:(name,path)=>paths[name]=path,getPath:name=>paths[name],requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit:()=>app.emit('before-quit',{preventDefault(){}}),dock:{setIcon(){}}});
  class Window extends EventEmitter {
    constructor(){super();this.url='';this.webContents=new EventEmitter();this.webContents.mainFrame={};Object.assign(this.webContents,{setWindowOpenHandler(){},getURL:()=>this.url});windows.push(this);}
    async loadFile(path){this.url=pathToFileURL(path).href;} async loadURL(url){this.url=url;} show(){} focus(){} hide(){} isDestroyed(){return false;}
  }
  class Child extends EventEmitter {exitCode=null;signalCode=null;kill(){this.exitCode=0;queueMicrotask(()=>this.emit('exit',0));} }
  class Client {
    constructor(options){this.options=options;this.busy=false;this.stopped=false;}
    async tick(){await this.options.request({});} async disconnect(){this.stopped=true;}
  }
  class Mcp {constructor(){this.child=new Child();children.push(this.child);} async ready(){if(delayReady)await new Promise(r=>readyResolve=r);return {tools:policy.tools.map(name=>({name,inputSchema:{}}))};}close(){} }
  const browser={setPermissionRequestHandler(){},setPermissionCheckHandler(){},fetch:async()=>({ok:admitted,status:admitted?200:403,text:async()=>'{}'})};
  const electron={app,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{showMessageBox:async()=>({response:dialogs.shift()??0}),showErrorBox:(_,message)=>{throw Error(message);}},session:{fromPartition:()=>browser},safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},nativeImage:{createFromPath:()=>({resize:()=>({})})},Tray:class{setTitle(){}setToolTip(){}setContextMenu(){}},Menu:{buildFromTemplate:v=>v}};
  const wrappedFs={...fs,mkdtempSync:()=>fs.mkdtempSync(join(dir,'helper-')),
    // This VM simulates macOS. Windows requires writable handles for fsync,
    // so retain real disk flushing while adapting its newly written fixtures.
    openSync:(path,flags,...args)=>fs.openSync(path,process.platform==='win32'&&flags==='r'?'r+':flags,...args),
  };
  const mocks={electron,'node:fs':wrappedFs,'node:os':{homedir:()=>dir,hostname:()=>'fixture-host'},'node:child_process':{spawn:(_bin,args)=>{const child=new Child();children.push(child);fs.writeFileSync(args[args.indexOf('--socket')+1],'fixture');return child;},execFileSync(){throw Error('Unexpected app lookup');}},'./companion-client.cjs':{CompanionClient:Client},'./companion-mcp.cjs':{CompanionMcp:Mcp},'./companion-access.cjs':policy};
  runInNewContext(source,{require:name=>mocks[name]??require(name),__dirname:'/fixture-app',process:{env:{NOVA_COMPANION_QA_PROFILE:'fixture'},platform:'darwin'},Buffer,URL,AbortSignal,setTimeout,clearTimeout,setInterval:fn=>{intervals.push(fn);return fn;},clearInterval(){},console});
  await settle();await settle();
  const controls=windows[0],event={sender:controls.webContents,senderFrame:controls.webContents.mainFrame};
  const call=(name,...args)=>handlers.get('companion:'+name)(event,...args);
  t.after(async()=>{app.quit();await settle();await settle();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,profile,children,dialogs,connection,origin,app,call,failMarker:()=>{wrappedFs.writeFileSync=(path,...args)=>{if(path.endsWith('computer-access-stopped'))throw Error('Disk write failed');return fs.writeFileSync(path,...args);};},tick:async()=>{intervals[0]();await settle();await settle();},deny:()=>admitted=false,delay:()=>delayReady=true,release:()=>readyResolve?.(),read:()=>JSON.parse(fs.readFileSync(join(profile,'connection.enc'),'utf8'))};
}

test('native full-desktop access is opt-in, persists only after confirmation, and Stop removes restart authority',async t=>{
  const h=await harness(t);await h.tick();assert.equal(h.children.length,0);
  await h.call('enable',{scope:'desktop',duration:'persistent'});assert.equal(h.children.length,0);
  h.dialogs.push(1);await h.call('enable',{scope:'desktop',duration:'persistent'});
  assert.equal((await h.call('status')).enabledUntil,null);assert.equal(h.read().access.duration,'persistent');
  await h.call('stop');assert.equal((await h.call('status')).enabledUntil,0);assert.equal(h.read().access,undefined);
  assert.ok(fs.existsSync(join(h.profile,'computer-access-stopped')));assert.ok(h.children.every(c=>c.exitCode===0));
  const count=h.children.length;await h.tick();assert.equal(h.children.length,count);
});

test('remembered access resumes after authenticated reconnect, while remote revocation clears it',async t=>{
  const access={scope:'desktop',duration:'persistent',apps:[],origin:'https://nova.example',deviceId:'fixture-device',epoch:'fixture-epoch'};
  const h=await harness(t,{access});assert.equal(h.children.length,0);await h.tick();
  assert.equal((await h.call('status')).enabledUntil,null);assert.equal(h.children.length,2);
  h.deny();await h.tick();assert.equal((await h.call('status')).enabledUntil,0);assert.equal(h.read().access,undefined);
  assert.ok(h.children.every(c=>c.exitCode===0));
});

test('quitting stops the helper but retains only an explicitly remembered grant',async t=>{
  const h=await harness(t);h.dialogs.push(1);await h.call('enable',{scope:'desktop',duration:'persistent'});
  h.app.quit();await settle();await settle();assert.equal(h.read().access.duration,'persistent');assert.ok(h.children.every(c=>c.exitCode===0));
});

test('Stop during helper startup cannot be undone by a late ready response',async t=>{
  const h=await harness(t);h.delay();h.dialogs.push(1);const enabling=h.call('enable',{scope:'desktop',duration:'persistent'});
  await settle();await h.call('stop');h.release();await enabling;
  assert.equal((await h.call('status')).enabledUntil,0);assert.equal(h.read().access,undefined);assert.ok(h.children.every(c=>c.exitCode===0));
});

test('Stop still terminates the helper and clears the encrypted grant if its marker write fails',async t=>{
  const h=await harness(t);h.dialogs.push(1);await h.call('enable',{scope:'desktop',duration:'persistent'});
  h.failMarker();await h.call('stop');assert.equal((await h.call('status')).enabledUntil,0);
  assert.equal(h.read().access,undefined);assert.ok(h.children.every(c=>c.exitCode===0));
});
