/* Records replayable user actions independently of screenshot capture. */
(() => {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const editable = el => el?.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=hidden]):not([type=range]):not([type=color]), textarea, [contenteditable]:not([contenteditable=false])');
  const pending = new Set();
  let values = new WeakMap();
  let timer;
  let enabled = false;
  let sessionId = null;
  let lastKeyboardActivation = null;
  const inFlight = new Set();
  const send = action => {
    if (!enabled) return;
    try {
      const request = chrome.runtime.sendMessage({ type: 'RECORD_ACTION', action: { ...action, url: location.href, timestamp: Date.now(), sessionId } }).catch(() => {});
      inFlight.add(request);
      request.finally(() => inFlight.delete(request));
    } catch (_) {}
  };
  function roots(root = document) {
    const result = [root];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) result.push(...roots(el.shadowRoot));
    return result;
  }
  function all(selector) { return roots().flatMap(root => [...root.querySelectorAll(selector)]); }
  function label(el) { return normalize(el.labels?.[0]?.textContent); }
  function name(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) return normalize(labelledBy.split(/\s+/).map(id => el.getRootNode().getElementById(id)?.textContent || '').join(' '));
    return normalize(el.getAttribute('aria-label') || el.innerText || el.textContent);
  }
  function role(el) {
    return el.getAttribute('role') || ({button:'button', a: el.hasAttribute('href') ? 'link' : '', textarea:'textbox', select: el.multiple ? 'listbox' : 'combobox'}[el.localName]) ||
      (el.localName === 'input' ? ({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',reset:'button',number:'spinbutton'}[el.type] || (el.type !== 'password' ? 'textbox' : '')) : '');
  }
  function cssPath(el) {
    const parts = [];
    let current = el;
    while (current instanceof Element) {
      const parent = current.parentElement;
      const siblings = parent ? [...parent.children].filter(node => node.localName === current.localName) : [];
      parts.unshift(current.localName + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''));
      if (!parent) {
        const host = current.getRootNode().host;
        if (host) return cssPath(host) + ' ' + parts.join(' > ');
        break;
      }
      current = parent;
    }
    return parts.join(' > ');
  }
  function locator(el) {
    const unique = selector => all(selector).length === 1;
    for (const attr of ['data-testid','data-test','data-cy','data-qa']) {
      const value = el.getAttribute(attr);
      const selector = value && `[${attr}="${CSS.escape(value)}"]`;
      if (selector && unique(selector)) return {kind:'css', value:selector};
    }
    const text = label(el);
    if (text && all('input,textarea,select,button').filter(node => label(node) === text).length === 1) return {kind:'label',value:text};
    const r = role(el), n = name(el);
    if (r && n && n.length <= 160 && all('*').filter(node => role(node) === r && name(node) === n).length === 1) return {kind:'role',role:r,value:n};
    for (const attr of ['id','name','aria-label','placeholder']) {
      const value = el.getAttribute(attr);
      if (!value || (attr === 'id' && /\d{4,}|[a-f0-9]{8}-|^:r/i.test(value))) continue;
      const selector = `${el.localName}[${attr}="${CSS.escape(value)}"]`;
      if (unique(selector)) return {kind:'css',value:selector};
    }
    return {kind:'css',value:cssPath(el), fragile:true};
  }
  function target(event) {
    const raw = event.composedPath()[0];
    return raw instanceof Element ? raw : null;
  }
  function secret(el) {
    return el.type === 'password' || /password|passwd|secret|token|one-time-code|cc-number|cc-csc/i.test([el.name,el.id,el.autocomplete,el.getAttribute('aria-label')].join(' '));
  }
  function snapshot(el, force = false) {
    if (!enabled || !editable(el) || el.disabled || el.readOnly) return;
    const value = el.isContentEditable ? el.innerText : el.value;
    if (values.get(el) === value || (!force && value === undefined)) return;
    values.set(el, value);
    const loc = locator(el);
    if (secret(el) && value) {
      const key = normalize(el.name || el.id || label(el) || 'PASSWORD').toUpperCase().replace(/[^A-Z0-9]+/g,'_').slice(0,60);
      send({type:'fill',locator:loc, secretKey:`BTE_${key || 'PASSWORD'}`});
    } else send({type:'fill',locator:loc,value:String(value ?? '')});
  }
  function flush() {
    clearTimeout(timer);
    for (const el of pending) snapshot(el);
    pending.clear();
  }
  function formValues(form) {
    if (!form) return;
    for (const el of form.elements) if (editable(el) && (el.value || values.has(el))) snapshot(el);
  }
  document.addEventListener('input', event => {
    if (!event.isTrusted || !enabled) return;
    const el = target(event);
    if (!editable(el)) return;
    pending.add(el); clearTimeout(timer); timer = setTimeout(flush, 250);
  }, true);
  document.addEventListener('change', event => {
    if (!event.isTrusted || !enabled) return;
    const el = target(event); if (!el) return;
    flush();
    if (editable(el)) snapshot(el);
    else if (el.matches('select')) send({type:'select',locator:locator(el),values:[...el.selectedOptions].map(option => option.value)});
    else if (el.matches('input[type=checkbox],input[type=radio]')) send({type:'check',locator:locator(el),checked:el.checked});
    else if (el.matches('input[type=file]')) send({type:'upload',locator:locator(el),files:[...el.files].map(file => file.name)});
    else send({type:'unsupported',description:`Change ${el.localName} (${el.type || 'custom control'})`});
  }, true);
  document.addEventListener('click', event => {
    if (!event.isTrusted || !enabled) return;
    flush();
    let el = target(event); if (!el) return;
    el = el.closest('button,a,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[contenteditable]') || el;
    if (el.localName === 'label' && el.control) return;
    if (el.matches('input[type=checkbox],input[type=radio],input[type=file],select,option') || editable(el)) return;
    if (event.detail === 0 && lastKeyboardActivation && Date.now() - lastKeyboardActivation < 500) return;
    formValues(el.form);
    if (event.detail === 2) { send({type:'doubleClick',locator:locator(el)}); return; }
    send({type:'click',locator:locator(el),modifiers:['Alt','Control','Meta','Shift'].filter(key => event[(key === 'Control' ? 'ctrl' : key.toLowerCase()) + 'Key'])});
  }, true);
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || !enabled || event.isComposing) return;
    const el = target(event); if (!el) return;
    if ((event.key === 'Enter' && editable(el) && el.localName !== 'textarea' && !el.isContentEditable) ||
        (['Tab','Escape','ArrowDown','ArrowUp'].includes(event.key) && (editable(el) || el.hasAttribute('role')))) {
      flush(); formValues(el.form);
      if (event.key === 'Enter') lastKeyboardActivation = Date.now();
      const prefix = ['Alt','Control','Meta','Shift'].filter(key => event[(key === 'Control' ? 'ctrl' : key.toLowerCase()) + 'Key']).join('+');
      send({type:'press',locator:locator(el),key:(prefix ? prefix + '+' : '') + event.key});
    }
  }, true);
  document.addEventListener('submit', event => { if (event.isTrusted) { flush(); formValues(event.target); } }, true);
  window.addEventListener('pagehide', flush);
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === 'FLUSH_ACTIONS') {
      flush(); Promise.allSettled([...inFlight]).then(() => reply({ok:true})); return true;
    }
  });
  function update(result) {
    const next = result.session?.id || null;
    if (next !== sessionId || result.recording === false || !enabled) { pending.clear(); clearTimeout(timer); values = new WeakMap(); }
    sessionId = next;
    enabled = result.recording !== false && Boolean(sessionId);
  }
  chrome.storage.local.get({recording:true,session:null}).then(update);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.recording || changes.session)) chrome.storage.local.get({recording:true,session:null}).then(update);
  });
})();
