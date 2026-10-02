const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const exporter = require('../playwright-export.js');
let playwrightPath;
try { playwrightPath = require.resolve('playwright'); }
catch (_) { playwrightPath = require.resolve(path.resolve(path.dirname(process.execPath),'../node_modules/playwright')); }
const {chromium} = require(playwrightPath);
const playwrightRoot = path.dirname(playwrightPath);
const artifactDir = path.resolve('tests/artifacts');
fs.mkdirSync(artifactDir,{recursive:true});
const fixture = String.raw`<!doctype html><title>Workflow fixture</title>
<div id="app"><form id="login"><label>Email <input name="email"></label><label>Password <input name="password" type="password"></label><button type="submit"><span>Sign in</span></button></form></div>
<script>
const app=document.querySelector('#app');
function dashboard() {
 app.innerHTML = '<h1>Dashboard</h1><label>Project name <input name="project"></label><label>Notes <textarea name="notes"></textarea></label><label>Region <select name="region"><option value="us">US</option><option value="in">India</option></select></label><label>Tags <select name="tags" multiple><option value="a">Alpha</option><option value="b">Beta</option></select></label><label><input type="checkbox" name="enabled"> Enabled</label><label><input type="radio" name="plan" value="pro"> Pro plan</label><div contenteditable="true" role="textbox" aria-label="Rich notes"></div><label>Upload <input type="file" name="attachment"></label><div><button onclick="this.textContent=\'Wrong\'">Edit</button><button onclick="document.querySelector(\'#result\').textContent=\'Second edit\'">Edit</button></div><button id="save">Save project</button><div id="result"></div><a href="/popup" target="_blank">Open help</a><iframe src="/frame" title="Settings"></iframe><div id="shadow"></div>';
 const shadow=document.querySelector('#shadow').attachShadow({mode:'open'}); shadow.innerHTML='<button data-testid="shadow-save">Shadow save</button><span></span>'; shadow.querySelector('button').onclick=()=>shadow.querySelector('span').textContent='Shadow saved';
 document.querySelector('#save').onclick=()=>{document.querySelector('#result').textContent='Saved: '+document.querySelector('[name=project]').value; history.pushState({},'', '/saved');};
}
if (location.pathname==='/dashboard' || location.pathname==='/saved') dashboard();
else document.querySelector('#login').onsubmit=e=>{e.preventDefault();if(e.target.email.value==='qa@example.test' && e.target.password.value==='fixture-password'){ sessionStorage.setItem('authenticated','yes'); history.pushState({},'', '/dashboard'); dashboard(); }else app.insertAdjacentHTML('beforeend','<p>Login failed</p>');};
</script>`;
const frame = '<!doctype html><label>Frame field <input name="frameField"></label><button onclick="document.querySelector(\'#done\').textContent=\'Frame saved\'">Save frame</button><p id="done"></p>';
const popup = '<!doctype html><h1>Help</h1><label>Search help <input name="search"></label><button onclick="document.querySelector(\'#answer\').textContent=\'Answer\'">Search</button><div id="answer"></div>';
const nativeLogin = '<!doctype html><form method="post" action="/authenticate"><label>Username <input name="username"></label><label>Password <input type="password" name="password"></label><button><span>Log in</span></button></form>';
const nativeHome = `<h1>Signed in</h1><button data-testid="double" ondblclick="this.textContent='Opened'">Open item</button><a href="/native-next">Continue</a>`;
const server=http.createServer((req,res)=>{
 if(req.url==='/authenticate') {
  let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{
   const values=new URLSearchParams(body);
   if(values.get('username')==='native-user' && values.get('password')==='fixture-password') {res.writeHead(302,{'Location':'/native-home','Set-Cookie':'signedIn=yes; Path=/'});res.end();}
   else {res.writeHead(403);res.end('Login failed');}
  });return;
 }
 res.setHeader('Content-Type','text/html');
 if(req.url==='/native-login') return res.end(nativeLogin);
 if(req.url==='/native-home') return res.end(req.headers.cookie?.includes('signedIn=yes')?nativeHome:'Not authenticated');
 if(req.url==='/native-next') return res.end('<h1>Finished</h1>');
 res.end(req.url==='/frame'?frame:req.url==='/popup'?popup:fixture);
});
let browser;
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const launch = {headless:true};
 if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) launch.executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
 else if (!fs.existsSync(chromium.executablePath())) launch.channel='chrome';
 browser=await chromium.launch(launch);
 const context=await browser.newContext();
 const data={recording:true,session:{id:'e2e',testCaseId:'Login and project workflow'}};
 const storeContext=vm.createContext({console,chrome:{storage:{local:{get:async defaults=>({...defaults,...data}),set:async values=>Object.assign(data,values)}}}});
 vm.runInContext(fs.readFileSync('workflow-store.js','utf8'),storeContext);
 const store=vm.runInContext('WorkflowStore',storeContext);
 const navigationKinds=new Map();
 const ids=new Map(); let next=1; let tasks=Promise.resolve();
 const tabId=page=>{if(!ids.has(page))ids.set(page,next++);return ids.get(page);};
 const append=action=>{tasks=tasks.then(()=>store.append(action,'e2e'));return tasks;};
 function watch(page){
   tabId(page);
   page.on('pageerror',error=>console.error('PAGE ERROR:',error.message));
   page.on('popup', child=>append({type:'popup',tabId:tabId(child),openerTabId:tabId(page),timestamp:Date.now()}));
   page.on('framenavigated', frame=>{if(frame===page.mainFrame() && /^http/.test(frame.url())) append({type:'navigate',tabId:tabId(page),url:frame.url(),topUrl:frame.url(),navigation:navigationKinds.get(page) || 'effect',timestamp:Date.now()}); navigationKinds.delete(page);});
 }
 context.on('page',watch);
 await context.exposeBinding('recordMessage',async ({page,frame}, message)=>{
   if(message.type!=='RECORD_ACTION') return {ok:true};
   const frames=[];
   let cursor=frame;
   while(cursor && cursor!==page.mainFrame()){frames.unshift(cursor.url());cursor=cursor.parentFrame();}
   await append({...message.action,frames,tabId:tabId(page),topUrl:page.url()});
   return {ok:true};
 });
 await context.addInitScript(()=>{
   const handlers=[];
   window.chrome={runtime:{sendMessage:message=>window.recordMessage(message),onMessage:{addListener:fn=>handlers.push(fn)}},storage:{local:{get:async()=>({recording:true,session:{id:'e2e'}})},onChanged:{addListener(){}}}};
   window.flushRecorder=()=>Promise.all(handlers.map(fn=>new Promise(resolve=>fn({type:'FLUSH_ACTIONS'},null,resolve))));
 });
 await context.addInitScript({path:path.resolve('action-recorder.js')});
 const page=await context.newPage();
 await page.goto(base+'/login');
 await page.getByLabel('Email').fill('qa@example.test');
 await page.getByLabel('Password').fill('fixture-password');
 await page.getByLabel('Password').press('Enter');
 await page.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:5000});
 await page.getByLabel('Project name').fill(`O'Brien "launch" \\ test`);
 await page.getByLabel('Notes',{exact:true}).fill('Line one\nLine two');
 await page.getByLabel('Region').focus();
 await page.getByLabel('Region').press('ArrowDown');
 await page.getByLabel('Region').press('Tab');
 await page.getByLabel('Tags').locator('option').nth(0).click();
 await page.getByLabel('Tags').locator('option').nth(1).click({modifiers:['Control']});
 await page.getByLabel('Enabled').check();
 await page.getByLabel('Enabled').uncheck();
 await page.getByLabel('Pro plan').check();
 await page.getByRole('textbox',{name:'Rich notes'}).fill('Rich content');
 const uploadPath=path.join(artifactDir,'upload.txt');fs.writeFileSync(uploadPath,'fixture file');
 await page.getByLabel('Upload').setInputFiles(uploadPath);
 await page.getByRole('button',{name:'Edit',exact:true}).nth(1).click({modifiers:['Control']});
 await page.getByTestId('shadow-save').click();
 await page.frameLocator('iframe').getByLabel('Frame field').fill('Frame value');
 await page.frameLocator('iframe').getByRole('button',{name:'Save frame'}).click();
 await page.getByRole('button',{name:'Save project'}).click();
 const popupPromise=page.waitForEvent('popup');
 await page.getByRole('link',{name:'Open help'}).click();
 const child=await popupPromise;
 await child.getByLabel('Search help').fill('Login');
 await child.getByRole('button',{name:'Search',exact:true}).click();
 await child.evaluate(()=>window.flushRecorder());
 const nativePage=await context.newPage();
 await nativePage.goto(base+'/native-login');
 await nativePage.getByLabel('Username').fill('native-user');
 await nativePage.getByLabel('Password').fill('fixture-password');
 await nativePage.getByRole('button',{name:'Log in'}).click();
 await nativePage.getByRole('heading',{name:'Signed in'}).waitFor();
 await nativePage.getByTestId('double').dblclick();
 await nativePage.getByRole('button',{name:'Opened'}).waitFor();
 navigationKinds.set(nativePage,'reload');
 await nativePage.reload();
 await nativePage.getByRole('link',{name:'Continue'}).click();
 await nativePage.getByRole('heading',{name:'Finished'}).waitFor();
 navigationKinds.set(nativePage,'history');
 await nativePage.goBack();
 await nativePage.getByRole('heading',{name:'Signed in'}).waitFor();
 navigationKinds.set(nativePage,'history');
 await nativePage.goForward();
 await nativePage.getByRole('heading',{name:'Finished'}).waitFor();
 await page.evaluate(()=>window.flushRecorder());
 await tasks;
 const workflow=await store.snapshot('e2e');
 assert.ok(workflow.actions.some(a=>a.type==='fill'&&a.secretKey));
 assert.ok(!JSON.stringify(workflow).includes('fixture-password'),'password must not be persisted');
 assert.ok(workflow.actions.some(a=>a.frames?.length),'frame action recorded');
 assert.ok(workflow.actions.some(a=>a.type==='popup'),'popup recorded');
 assert.ok(workflow.actions.some(a=>a.modifiers?.includes('Control')), 'Control modifier retained');
 const generated=exporter.build(workflow,data.session);
 assert.ok(!generated.includes('networkidle'));
 assert.ok(!generated.includes('fixture-password'));
 fs.writeFileSync(path.join(artifactDir,'recording.json'),JSON.stringify(workflow,null,2));
 fs.writeFileSync(path.join(artifactDir,'workflow.spec.js'),generated);
 // Use the installed Playwright runner for the exported script, changing only module resolution.
 const runnable=generated.replace("'@playwright/test'",JSON.stringify(pathToFileURL(path.join(playwrightRoot,'test.mjs')).href));
 const assertions=`
  await expect(page.getByRole('heading', {name:'Dashboard'})).toBeVisible();
  await expect(page.getByLabel('Project name')).toHaveValue(${JSON.stringify(`O'Brien "launch" \\ test`)});
  await expect(page.getByLabel('Region')).toHaveValue('in');
  await expect(page.getByLabel('Tags')).toHaveValues(['a','b']);
  await expect(page.getByLabel('Enabled')).not.toBeChecked();
  await expect(page.getByLabel('Pro plan')).toBeChecked();
  await expect(page.getByRole('textbox',{name:'Rich notes'})).toHaveText('Rich content');
  await expect(page.frameLocator('iframe').locator('#done')).toHaveText('Frame saved');
  await expect(page.locator('#shadow span')).toHaveText('Shadow saved');
  await expect(page2.locator('#answer')).toHaveText('Answer');
  await expect(page3.getByRole('heading',{name:'Finished'})).toBeVisible();
  expect(await page.evaluate(()=>sessionStorage.getItem('authenticated'))).toBe('yes');
`;
 const last=runnable.lastIndexOf('});');
 fs.writeFileSync(path.join(artifactDir,'replay.spec.mjs'),runnable.slice(0,last)+assertions+runnable.slice(last));
 fs.writeFileSync(path.join(artifactDir,'playwright.config.cjs'),'module.exports='+JSON.stringify({testDir:artifactDir,testMatch:'replay.spec.mjs',workers:1,retries:0,reporter:'list',outputDir:path.join(artifactDir,'results'),use:{launchOptions:launch,trace:'retain-on-failure'}}));
 const env={...process.env};
 for(const action of workflow.actions){if(action.secretKey)env[`${action.secretKey}_${action.sequence}`]='fixture-password';if(action.type==='upload')env[`BTE_UPLOAD_${action.sequence}`]=JSON.stringify([uploadPath]);}
 await context.close();
 const code=await new Promise(resolve=>{const runner=spawn(process.execPath,[path.join(playwrightRoot,'cli.js'),'test','--config',path.join(artifactDir,'playwright.config.cjs')],{stdio:'inherit',env});runner.on('exit',resolve);});
 assert.equal(code,0,'exported script must replay successfully');
 console.log(`PASS: recorded ${workflow.actions.length} actions and replayed the exported test in a fresh browser context.`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.close();});
