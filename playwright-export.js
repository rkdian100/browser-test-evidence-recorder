/* Standalone Playwright Test source generator. All recorded text is JSON-quoted. */
const PlaywrightExport = (() => {
  const q = value => JSON.stringify(value);
  function locator(root, loc) {
    if (!loc?.value) throw new Error('Recorded action has no locator. Record this workflow again.');
    if (loc.kind === 'label') return `${root}.getByLabel(${q(loc.value)}, { exact: true })`;
    if (loc.kind === 'role') return `${root}.getByRole(${q(loc.role)}, { name: ${q(loc.value)}, exact: true })`;
    return `${root}.locator(${q(loc.value)})`;
  }
  function build(workflow, session) {
    if (workflow.error) throw new Error(workflow.error);
    const actions = workflow.actions || [];
    if (!actions.length) throw new Error('No recorded actions. Reload your webpages and record a new workflow before exporting Playwright.');
    const popups = new Map(), triggers = new Map();
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (['click','doubleClick','press'].includes(action.type)) triggers.set(action.tabId, i);
      if (action.type === 'popup') {
        const index = triggers.get(action.openerTabId);
        if (index !== undefined) {
          const list = popups.get(index) || [];
          list.push(action); popups.set(index,list); triggers.delete(action.openerTabId);
        }
      }
    }
    const lines = [
      "import { test, expect } from '@playwright/test';",
      '',
      '// Set the required BTE_* environment variables before running this test.',
      '// Optional: BTE_STORAGE_STATE points to an existing Playwright authentication state file.',
      "test.use({ storageState: process.env.BTE_STORAGE_STATE || undefined });",
      '',
      'function requiredEnv(name) {',
      '  const value = process.env[name];',
      "  if (!value) throw new Error('Set environment variable ' + name + ' before running this test.');",
      '  return value;',
      '}',
      '',
      'async function recordedFrame(page, path) {',
      '  let parent = page.mainFrame();',
      '  for (const url of path) {',
      '    let matches;',
      '    await expect.poll(() => {',
      '      matches = parent.childFrames().filter(frame => frame.url() === url);',
      '      return matches.length;',
      '    }, { message: "Find one frame at " + url }).toBe(1);',
      '    parent = matches[0];',
      '  }',
      '  return parent;',
      '}',
      '',
      `test(${q(session.testCaseId || 'Recorded workflow')}, async ({ page, context }, testInfo) => {`,
      `  test.setTimeout(${Math.max(60000,actions.length * 5000)});`,
      '  page.setDefaultTimeout(15000);',
      '  context.setDefaultTimeout(15000);'
    ];
    const envs = new Map();
    actions.forEach((action,index) => {
      if (action.secretKey) envs.set(index, `${action.secretKey}_${action.sequence || index + 1}`);
      if (action.type === 'upload') envs.set(index, `BTE_UPLOAD_${action.sequence || index + 1}`);
    });
    for (const key of envs.values()) lines.push(`  requiredEnv(${q(key)});`);
    const pages = new Map();
    let pageCount = 0;
    const add = text => lines.push('  ' + text);
    function pageState(id) {
      if (!pages.has(id)) {
        const variable = pageCount++ === 0 ? 'page' : `page${pageCount}`;
        if (variable !== 'page') add(`const ${variable} = await context.newPage();`);
        pages.set(id,{variable,initialized:false,url:null,history:[],historyIndex:-1});
      }
      return pages.get(id);
    }
    function initialize(state, url) {
      if (!state.initialized && /^https?:\/\//.test(url || '')) {
        add(`await ${state.variable}.goto(${q(url)}, { waitUntil: 'domcontentloaded' });`);
        state.initialized = true; state.url = url; state.history = [url]; state.historyIndex = 0;
      }
    }
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.type === 'popup') {
        if (!pages.has(action.tabId)) add(`throw new Error(${q('A new tab could not be linked to its opening action. Re-record the popup step.')});`);
        continue;
      }
      if (action.type === 'close') {
        if (pages.has(action.tabId)) { add(`await ${pages.get(action.tabId).variable}.close();`); pages.delete(action.tabId); }
        continue;
      }
      const state = pageState(action.tabId), p = state.variable;
      const topUrl = action.topUrl || action.url;
      const wasInitialized = state.initialized;
      initialize(state, topUrl);
      if (action.type === 'navigate') {
        if (wasInitialized) {
          if (action.navigation === 'reload') add(`await ${p}.reload({ waitUntil: 'domcontentloaded' });`);
          else if (action.navigation === 'direct') add(`await ${p}.goto(${q(action.url)}, { waitUntil: 'domcontentloaded' });`);
          else if (action.navigation === 'history') {
            const index = state.history.lastIndexOf(action.url);
            if (index < 0 || index === state.historyIndex) add(`throw new Error(${q('Browser history target was not recorded. Start recording before navigating to this page.')});`);
            else {
              const method = index < state.historyIndex ? 'goBack' : 'goForward';
              for (let n = 0; n < Math.abs(index - state.historyIndex); n++) add(`await ${p}.${method}({ waitUntil: 'domcontentloaded' });`);
              state.historyIndex = index;
            }
          }
          add(`await expect(${p}).toHaveURL(${q(action.url)});`);
        }
        if (action.navigation !== 'history' && action.navigation !== 'reload' && action.url !== state.history[state.historyIndex]) {
          state.history = state.history.slice(0,state.historyIndex + 1);
          state.history.push(action.url); state.historyIndex++;
        }
        state.url = action.url;
        continue;
      }
      if (topUrl && topUrl !== state.url) {
        add(`await expect(${p}).toHaveURL(${q(topUrl)});`);
        state.url = topUrl;
      }
      if (action.type === 'unsupported') {
        add(`throw new Error(${q('Recorder needs a manual step: ' + action.description)});`);
        continue;
      }
      const attachedPopups = popups.get(i) || [];
      if (attachedPopups.length > 1) throw new Error('One action opened multiple tabs. Split this step into explicit popup handling before replay.');
      for (const child of attachedPopups) add(`const popup${child.sequence}Promise = ${p}.waitForEvent('popup');`);
      const root = action.frames?.length ? `(await recordedFrame(${p}, ${q(action.frames)}))` : p;
      const loc = locator(root, action.locator);
      if (action.locator.fragile) add('// Structural locator: consider adding a test ID to this element.');
      const stepName = `${action.sequence || i + 1}. ${action.type} ${action.locator.value}`;
      add(`await test.step(${q(stepName)}, async () => {`);
      const push = text => add('  ' + text);
      switch (action.type) {
        case 'fill': {
          const value = envs.has(i) ? `requiredEnv(${q(envs.get(i))})` : q(action.value ?? '');
          push(`await ${loc}.fill(${value});`);
          break;
        }
        case 'click': push(`await ${loc}.click(${action.modifiers?.length ? q({modifiers:action.modifiers}) : ''});`); break;
        case 'doubleClick': push(`await ${loc}.dblclick();`); break;
        case 'check': push(`await ${loc}.setChecked(${Boolean(action.checked)});`); break;
        case 'select': push(`await ${loc}.selectOption(${q(action.values)});`); break;
        case 'press': push(`await ${loc}.press(${q(action.key)});`); break;
        case 'upload':
          push('// Supply a JSON array of absolute file paths in this environment variable.');
          push(`await ${loc}.setInputFiles(JSON.parse(requiredEnv(${q(envs.get(i))})));`);
          break;
        default: throw new Error('Unsupported recorded action: ' + action.type);
      }
      add('});');

      for (const child of attachedPopups) {
        const variable = `page${++pageCount}`;
        add(`const ${variable} = await popup${child.sequence}Promise;`);
        pages.set(child.tabId,{variable,initialized:true,url:null,history:[],historyIndex:-1});
      }
    }
    for (const state of pages.values()) {
      if (state.url) add(`await expect(${state.variable}).toHaveURL(${q(state.url)});`);
      add(`await testInfo.attach(${q('Final state - ' + state.variable)}, { body: await ${state.variable}.screenshot(), contentType: 'image/png' });`);
    }
    lines.push('});','');
    return lines.join('\n');
  }
  return {build};
})();
if (typeof module !== 'undefined') module.exports = PlaywrightExport;
