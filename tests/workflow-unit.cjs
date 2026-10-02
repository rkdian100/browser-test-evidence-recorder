const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const exporter=require('../playwright-export.js');
const listeners={};
const event=name=>({addListener:fn=>{listeners[name]=fn;}});
const data={session:{id:'session-one',testCaseId:'Integration',sequence:0},recording:true,captureMode:'manual',history:[]};
const sandbox={console,crypto:webcrypto,URL,Blob,setTimeout,TextEncoder,Uint8Array,DataView,atob,btoa,
 chrome:{
  storage:{local:{get:async defaults=>({...defaults,...data}),set:async values=>Object.assign(data,structuredClone(values))}},
  runtime:{onMessage:event('message'),onInstalled:event('installed'),sendMessage:async()=>{}},
  tabs:{onCreated:event('created'),onUpdated:event('updated'),onRemoved:event('removed'),query:async()=>[],sendMessage:async()=>{}},
  commands:{onCommand:event('command')},downloads:{download:async()=>1},
  webNavigation:{onCompleted:event('completed'),onCommitted:event('committed'),onHistoryStateUpdated:event('history'),onReferenceFragmentUpdated:event('fragment'),onCreatedNavigationTarget:event('popup'),getAllFrames:async()=>[{frameId:0,url:'https://app.test'},{frameId:2,parentFrameId:0,url:'https://frame.test'}]}
 }};
let context=vm.createContext(sandbox);
sandbox.importScripts=(...files)=>{for(const file of files) vm.runInContext(fs.readFileSync(file,'utf8'),context);};
vm.runInContext(fs.readFileSync('background.js','utf8'),context);
const sender={tab:{id:1,url:'https://app.test'},frameId:0};
const message=(message,s=sender)=>new Promise(resolve=>listeners.message(message,s,resolve));
const loc={kind:'label',value:'Name'};
const record=(action,s=sender)=>message({type:'RECORD_ACTION',action:{sessionId:data.session.id,url:'https://app.test',...action}},s);
(async()=>{
 await record({type:'fill',locator:loc,value:'a'});
 await record({type:'fill',locator:loc,value:'abc'});
 await record({type:'click',locator:{kind:'role',role:'button',value:'Submit'}});
 assert.equal(data.workflow.actions.length,2,'consecutive edits are consolidated');
 assert.equal(data.workflow.actions[0].value,'abc');
 assert.equal((await message({type:'GET_HISTORY'})).actionCount,2,'manual screenshot mode still records actions');
 data.recording=false;
 await record({type:'fill',locator:loc,value:'paused'});
 assert.equal(data.workflow.actions.length,2,'paused action ignored');
 data.recording=true;
 await record({type:'fill',locator:loc,secretKey:'BTE_PASSWORD',value:'must-not-persist'});
 assert.ok(!JSON.stringify(data.workflow).includes('must-not-persist'));
 await record({type:'fill',locator:loc,value:'in frame'},{tab:sender.tab,frameId:2});
 assert.deepEqual(data.workflow.actions.at(-1).frames,['https://frame.test']);
 listeners.committed({tabId:1,frameId:0,url:'https://app.test/home',transitionType:'form_submit'});
 await vm.runInContext('actionMessageQueue',context);
 assert.equal(data.workflow.actions.at(-1).navigation,'effect');
 const exportResult=await message({type:'EXPORT_PLAYWRIGHT'});
 assert.equal(exportResult.ok,true);
 // Action recording continues beyond the 100-screenshot retention limit.
 for(let i=0;i<110;i++) await record({type:'click',locator:loc});
 assert.ok(data.workflow.actions.length>100);
 // Restart the service worker against the persisted storage.
 const before=data.workflow.actions.length;
 context=vm.createContext({...sandbox});
 vm.runInContext(fs.readFileSync('background.js','utf8'),context);
 vm.runInContext('globalThis.persistedCount = WorkflowStore.snapshot("session-one").then(w => w.actions.length)',context);
 assert.equal(await context.persistedCount,before);
 const result=await message({type:'NEW_SESSION',testCaseId:'New'});
 assert.equal(result.ok,true);assert.equal(data.workflow.actions.length,0);
 await record({sessionId:'session-one',type:'click',locator:loc});
 assert.equal(data.workflow.actions.length,0,'old-page event must not enter a new session');
 await record({type:'click',locator:loc});
 assert.equal(data.workflow.actions.length,1);
 // Clear mocks for IndexedDB operations without requiring a browser in this test.
 vm.runInContext('EvidenceDB.clear = async () => true',context);
 assert.equal((await message({type:'CLEAR_HISTORY'})).ok,true);
 assert.equal(data.workflow.actions.length,0);
 assert.throws(()=>exporter.build({actions:[]},{}),/No recorded actions/);
 assert.throws(()=>exporter.build({actions:[],error:'incomplete'},{}),/incomplete/);
 const code=exporter.build({actions:[{type:'click',tabId:1,url:'https://app.test',locator:{kind:'css',value:'button[data-x="\\\\\'\\n"]'},sequence:1}]},{testCaseId:'*/\n malicious " title'});
 new vm.Script(code.replace(/^import .*;$/m,''));
 assert.ok(!code.includes('networkidle'));
 console.log('PASS: service-worker action handling, coalescing, pause, manual mode, secrets, frames, navigation, exports, session boundaries, clear and hostile strings.');
})().catch(error=>{console.error(error);process.exitCode=1;});
