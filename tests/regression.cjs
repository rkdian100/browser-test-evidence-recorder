const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
let data = { history: [], recording: true, captureMode: 'manual', session: {id: 'session', sequence: 0} };
let captures = 0;
let tab = { id: 1, windowId: 1, active: true, url: 'https://example.test', title: 'Account page' };
const listener = { addListener() {} };
const context = vm.createContext({
  console, crypto: webcrypto, setTimeout, TextEncoder, Uint8Array, DataView, URL,
  importScripts() {}, EvidenceDB: { put: async()=>{}, remove: async()=>{}, get: async()=>null },
  chrome: {
    storage: { local: {get: async defaults => ({...defaults, ...data}), set: async values => Object.assign(data, values)} },
    tabs: { get: async()=>({...tab}), captureVisibleTab: async()=>{ captures++; return 'data:image/png;base64,AA=='; }, onCreated: listener, onUpdated: listener, onRemoved: listener },
    downloads: {download: async()=>1}, webNavigation: {onCompleted: listener,onCommitted:listener,onHistoryStateUpdated:listener,onReferenceFragmentUpdated:listener,onCreatedNavigationTarget:listener},
    runtime: {onMessage: listener, onInstalled: listener, sendMessage: async()=>{}}, commands: {onCommand: listener}
  }
});
vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);
(async()=>{
  context.tab = tab;
  await vm.runInContext('captureForTab(tab, "click")', context);
  assert.equal(captures, 0, 'manual mode blocks automatic capture');
  await vm.runInContext('captureForTab(tab, "manual")', context);
  assert.equal(captures, 1, 'explicit manual capture works');
  data.recording = false;
  await vm.runInContext('captureForTab(tab, "manual")', context);
  assert.equal(captures, 1, 'pause blocks manual capture');
  data.recording = true; data.captureMode = 'automatic'; tab.active = false;
  await vm.runInContext('captureForTab(tab, "navigation")', context);
  assert.equal(captures, 1, 'background tabs are skipped');
  tab.active = true;
  await vm.runInContext('captureForTab(tab, "navigation")', context);
  assert.equal(captures, 2, 'automatic navigation capture works');
  const exporter = require('../playwright-export.js');
  const code = exporter.build({actions:[{type:'click',tabId:1,url:"https://example.test/it's",sequence:1,locator:{kind:'role',role:'button',value:'It\'s "ready"'}}]}, {id:'session',testCaseId:"User's test"});
  new vm.Script(code.replace(/^import .*;$/m, ''));
  vm.runInContext(fs.readFileSync('docx-report.js','utf8'), context);
  context.history = [{id:'one',sessionId:'session',sequence:1,title:'Account page',url:'https://example.test'}];
  const bytes = await vm.runInContext('DocxReport.build(history, {id:"session"})', context);
  const report = Buffer.from(bytes).toString('utf8');
  assert.ok(report.includes('Account page'));
  assert.ok(!report.includes('Total Steps'));
  assert.ok(!report.includes('Navigate to'));
  assert.ok(!report.includes('https://example.test'));
  assert.ok(report.includes('relationships/styles'));
  console.log('PASS: capture modes, pause, active tab guard, export syntax, simple report content.');
})().catch(error=>{ console.error(error);process.exitCode=1; });

// Verify the keyboard gesture independently of the browser worker.
const handlers = {};
const sent = [];
class Element {
  constructor(editing = false) { this.editing = editing; this.tagName = 'BUTTON'; this.textContent = 'Save'; }
  closest(selector) { return selector === '*' ? this : (this.editing ? this : null); }
}
const contentContext = vm.createContext({
  console, Element, HTMLAnchorElement: class extends Element {},
  document: { addEventListener: (name, fn) => { (handlers[name] ||= []).push(fn); } },
  window: {addEventListener() {}},
  chrome: {runtime: {sendMessage: async message => {sent.push(message);}}}
});
vm.runInContext(fs.readFileSync('content.js','utf8'), contentContext);
const target = new Element();
for (const fn of handlers.keydown) fn({code:'KeyS',key:'s',target});
for (const fn of handlers.click) fn({target,isTrusted:true});
assert.equal(sent[0].reason, 'manual', 'S plus click requests manual capture');
for (const fn of handlers.keyup) fn({code:'KeyS'});
assert.equal(vm.runInContext('sHeld', contentContext), false);
for (const fn of handlers.keydown) fn({code:'KeyS',key:'s',target:new Element(true)});
assert.equal(vm.runInContext('sHeld', contentContext), false, 'typing does not arm gesture');
console.log('PASS: S + click, key release, typing guard.');
