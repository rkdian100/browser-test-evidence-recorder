importScripts("evidence-db.js", "docx-report.js", "workflow-store.js", "playwright-export.js");

/*
 * Browser Test Evidence Recorder - Service Worker V1.3
 *
 * Full screenshots are automatically downloaded as real image files.
 * Metadata is kept in chrome.storage.local and full image data is kept in
 * IndexedDB so the extension does not fill chrome.storage.local with 100
 * large Base64 screenshots.
 */

const STORAGE_KEYS = {
  HISTORY: "history",
  RECORDING: "recording",
  MODE: "captureMode"
};

const MAX_HISTORY = 100;
const CAPTURE_DEBOUNCE_MS = 800;
const NAVIGATION_SETTLE_MS = 350;
const DOWNLOAD_ROOT = "Browser Test Evidence Recorder";
const SESSION_KEY = "session";

const recentCaptures = new Map();
let captureQueue = Promise.resolve();
let lastCaptureAt = 0;

async function getCaptureMode() {
  const result = await chrome.storage.local.get({ captureMode: "automatic" });
  return result.captureMode === "manual" ? "manual" : "automatic";
}

function log(...args) { console.log("[Evidence Recorder]", ...args); }
function warn(...args) { console.warn("[Evidence Recorder]", ...args); }

async function getRecordingState() {
  const result = await chrome.storage.local.get({ [STORAGE_KEYS.RECORDING]: true });
  return Boolean(result[STORAGE_KEYS.RECORDING]);
}

async function setRecordingState(recording) {
  await chrome.storage.local.set({ [STORAGE_KEYS.RECORDING]: Boolean(recording) });
}


async function getSession() {
  const result = await chrome.storage.local.get({ [SESSION_KEY]: null });
  return result[SESSION_KEY] || null;
}

function makeSessionId() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase();
  return `BTE-${date}-${time}-${suffix}`;
}

async function ensureSession() {
  let session = await getSession();
  if (!session?.id) {
    session = { id: makeSessionId(), startedAt: new Date().toISOString(), sequence: 0, testCaseId: "" };
    await chrome.storage.local.set({ [SESSION_KEY]: session });
  }
  return session;
}

async function newSession(testCaseId = "") {
  const session = { id: makeSessionId(), startedAt: new Date().toISOString(), sequence: 0, testCaseId: safeFilePart(testCaseId, "") };
  await chrome.storage.local.set({ [SESSION_KEY]: session });
  return session;
}

async function updateSession(fields = {}) {
  const session = await ensureSession();
  const updated = { ...session, ...fields };
  await chrome.storage.local.set({ [SESSION_KEY]: updated });
  return updated;
}

async function getHistory() {
  const result = await chrome.storage.local.get({ [STORAGE_KEYS.HISTORY]: [] });
  return Array.isArray(result[STORAGE_KEYS.HISTORY]) ? result[STORAGE_KEYS.HISTORY] : [];
}

async function saveHistory(history) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.HISTORY]: history.slice(0, MAX_HISTORY)
  });
}

function isCapturableUrl(url) {
  if (!url || typeof url !== "string") return false;
  const blockedSchemes = [
    "chrome://", "chrome-extension://", "devtools://", "view-source:",
    "about:", "edge://", "file:"
  ];
  return !blockedSchemes.some((scheme) => url.startsWith(scheme));
}

function makeCaptureKey(tabId, reason, url) {
  return `${tabId}|${reason}|${url || ""}`;
}

function isDuplicateCapture(tabId, reason, url) {
  const isLoadEvent = ["navigation", "new_tab", "tab_updated"].includes(reason);
  const key = isLoadEvent
    ? `${tabId}|load|${url || ""}`
    : makeCaptureKey(tabId, reason, url);

  const now = Date.now();
  const previous = recentCaptures.get(key);

  for (const [entryKey, timestamp] of recentCaptures.entries()) {
    if (now - timestamp > CAPTURE_DEBOUNCE_MS * 2) recentCaptures.delete(entryKey);
  }

  if (previous && now - previous < CAPTURE_DEBOUNCE_MS) return true;
  recentCaptures.set(key, now);
  return false;
}

function enqueueCapture(task) {
  captureQueue = captureQueue.then(task).catch((error) => warn("Capture queue error:", error));
  return captureQueue;
}

function safeFilePart(value, fallback = "capture") {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function downloadPath(timestamp, reason, id, session, sequence, pageName, elementInfo) {
  const date = new Date(timestamp);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const seq = String(sequence).padStart(3, "0");
  const reasonName = safeFilePart(reasonLabel(reason), "CAPTURE");
  const description = safeFilePart(elementInfo?.text || pageName || "Browser Capture", "Browser-Capture");
  const sessionId = safeFilePart(session?.id || "BTE-SESSION", "BTE-SESSION");
  const testCase = session?.testCaseId ? `${safeFilePart(session.testCaseId)}_` : "";
  const shortId = id.slice(0, 8).toUpperCase();
  const file = `${testCase}${sessionId}_${seq}_${reasonName}_${description}_${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}_${shortId}.png`;
  return `${DOWNLOAD_ROOT}/${yyyy}-${mm}-${dd}/${sessionId}/${file}`;
}

function reasonLabel(reason) {
  const labels = { click: "CLICK", navigation: "NAVIGATION", new_tab: "NEW-TAB", tab_updated: "TAB-UPDATED", manual: "MANUAL" };
  return labels[reason] || String(reason || "CAPTURE").toUpperCase();
}

async function downloadScreenshot(dataUrl, timestamp, reason, id, session, sequence, pageName, elementInfo) {
  const filename = downloadPath(timestamp, reason, id, session, sequence, pageName, elementInfo);

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
    conflictAction: "uniquify"
  });

  return { downloadId, filename };
}

async function captureForTab(tab, reason, elementInfo = null) {
  if (!tab?.id && tab?.id !== 0) {
    warn("Cannot capture: tab information is missing.", tab);
    return null;
  }

  if (tab.windowId === undefined || tab.windowId === null) {
    warn("Cannot capture: window information is missing.", tab);
    return null;
  }

  if (!(await getRecordingState())) {
    log("Recording is paused; ignoring capture request.");
    return null;
  }

  if (reason !== "manual" && await getCaptureMode() === "manual") return null;

  const delay = Math.max(0, 550 - (Date.now() - lastCaptureAt));
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  let currentTab = tab;
  try {
    const freshTab = await chrome.tabs.get(tab.id);
    if (freshTab) currentTab = freshTab;
  } catch (error) {
    warn("Could not refresh tab metadata:", error);
    return null;
  }

  if (!currentTab.active) return null;
  const url = currentTab.url || tab.url || "";
  if (!isCapturableUrl(url)) {
    warn("Skipping unsupported/non-capturable URL:", url);
    return null;
  }

  if (isDuplicateCapture(currentTab.id, reason, url)) {
    log("Duplicate capture suppressed:", reason, url);
    return null;
  }

  try {
    lastCaptureAt = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(currentTab.windowId, {
      format: "png"
    });

    const afterCapture = await chrome.tabs.get(currentTab.id);
    if (!afterCapture.active || afterCapture.url !== url) return null;
    if (!dataUrl) throw new Error("captureVisibleTab returned no image data.");

    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const session = await ensureSession();
    const sequence = Number(session.sequence || 0) + 1;
    const pageName = currentTab.title || "Browser Capture";
    session.sequence = sequence;

    // Save the real screenshot file first. If the browser download fails, we
    // do not pretend the evidence file was created.
    let download;
    try {
      download = await downloadScreenshot(dataUrl, timestamp, reason, id, session, sequence, pageName, elementInfo);
    } catch (downloadError) {
      warn("Automatic screenshot download failed:", downloadError);
      throw new Error(`Screenshot captured but could not be downloaded: ${downloadError.message}`);
    }

    // Full image lives in IndexedDB; chrome.storage.local contains lightweight
    // metadata only. This prevents the 100-entry history from exhausting the
    // normal extension storage quota.
    await EvidenceDB.put(id, dataUrl);

    const entry = {
      id,
      timestamp,
      url,
      title: pageName,
      reason,
      sequence,
      sessionId: session.id,
      sessionStartedAt: session.startedAt,
      testCaseId: session.testCaseId || "",
      pageName,
      evidenceLabel: `${session.id} #${String(sequence).padStart(3, "0")}`,
      elementInfo: elementInfo || null,
      filename: download.filename,
      downloadId: download.downloadId,
      format: "png"
    };

    await chrome.storage.local.set({ [SESSION_KEY]: session });

    let history = await getHistory();
    const previous = history.slice(0, MAX_HISTORY - 1);
    const removed = history.length >= MAX_HISTORY ? history[MAX_HISTORY - 1] : null;
    history = [entry, ...previous];

    try {
      await saveHistory(history);
    } catch (storageError) {
      // Keep metadata consistent. The image file remains a real downloaded
      // artifact even if metadata storage becomes unavailable.
      await EvidenceDB.remove(id).catch(() => { });
      throw storageError;
    }

    if (removed?.id) await EvidenceDB.remove(removed.id).catch(() => { });

    log("Screenshot downloaded:", download.filename);

    try {
      await chrome.runtime.sendMessage({ type: "NEW_SCREENSHOT", entry });
    } catch (_) {
      log("No popup listener currently open.");
    }

    return entry;
  } catch (error) {
    warn("Screenshot capture failed:", error);
    return null;
  }
}

async function captureActiveTab(reason, elementInfo = null, preferredTab = null) {
  try {
    const tab = preferredTab || (await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    }))[0];

    if (!tab) {
      warn("No active tab available for manual capture.");
      return null;
    }

    return await captureForTab(tab, reason, elementInfo);
  } catch (error) {
    warn("Active-tab capture failed:", error);
    return null;
  }
}

async function migrateLegacyScreenshots() {
  try {
    const history = await getHistory();
    let changed = false;

    for (const entry of history) {
      if (!entry?.id || !entry.screenshot) continue;

      // Preserve the old screenshot in the new durable image store.
      await EvidenceDB.put(entry.id, entry.screenshot);

      // V1 stored images in chrome.storage.local. V1.1 converts those images
      // into real downloaded PNG evidence files and removes the huge Base64
      // field from chrome.storage.local.
      if (!entry.filename) {
        try {
          const legacySession = { id: entry.sessionId || "BTE-LEGACY", testCaseId: entry.testCaseId || "" };
          const legacySequence = entry.sequence || 1;
          const download = await downloadScreenshot(
            entry.screenshot,
            entry.timestamp || new Date().toISOString(),
            entry.reason || "legacy",
            entry.id,
            legacySession,
            legacySequence,
            entry.pageName || entry.title || "Legacy Capture",
            entry.elementInfo || null
          );
          entry.filename = download.filename;
          entry.downloadId = download.downloadId;
          entry.format = "png";
          entry.migratedToFile = true;
        } catch (downloadError) {
          entry.legacyStorage = true;
          warn("Could not auto-download legacy screenshot:", entry.id, downloadError);
        }
      }

      delete entry.screenshot;
      changed = true;
    }

    if (changed) await saveHistory(history);
  } catch (error) {
    warn("Legacy screenshot migration failed:", error);
  }
}

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  enqueueCapture(async () => {
    await new Promise((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS));
    try {
      const tab = await chrome.tabs.get(details.tabId);
      await captureForTab(tab, "navigation");
    } catch (error) {
      warn("Navigation capture failed:", error);
    }
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  enqueueCapture(async () => {
    if (!tab.active) {
      log("New tab is not active; no visible screenshot available.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS));
    try {
      const freshTab = await chrome.tabs.get(tab.id);
      await captureForTab(freshTab, "new_tab");
    } catch (error) {
      warn("New-tab capture failed:", error);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.active) return;
  enqueueCapture(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const freshTab = await chrome.tabs.get(tabId);
      await captureForTab(freshTab, "tab_updated");
    } catch (error) {
      warn("Tab-updated capture failed:", error);
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return undefined;

  if (message.type === "RECORD_ACTION") {
    recordAction(message.action, sender).then(ok => sendResponse({ok})).catch(error => sendResponse({ok:false,error:error.message}));
    return true;
  }

  if (message.type === "CAPTURE_SCREENSHOT") {
    enqueueCapture(async () => {
      const entry = await captureForTab(
        sender.tab,
        message.reason || "click",
        message.elementInfo || null
      );
      try { sendResponse({ ok: Boolean(entry), entry }); } catch (_) { }
    });
    return true;
  }

  if (message.type === "MANUAL_CAPTURE") {
    enqueueCapture(async () => {
      const entry = await captureActiveTab("manual", message.elementInfo || null, sender.tab || null);
      try { sendResponse({ ok: Boolean(entry), entry }); } catch (_) { }
    });
    return true;
  }

  if (message.type === "NEW_SESSION") {
    enqueueCapture(async () => {
      try {
        const session = await newSession(message.testCaseId || "");
        await WorkflowStore.reset(session.id);
        sendResponse({ ok: true, session });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
    });
    return true;
  }

  if (message.type === "UPDATE_TEST_CASE") {
    enqueueCapture(async () => {
      try {
        const session = await updateSession({ testCaseId: safeFilePart(message.testCaseId || "", "") });
        sendResponse({ ok: true, session });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
    });
    return true;
  }

  if (message.type === "SET_CAPTURE_MODE") {
    enqueueCapture(async () => {
      try {
        const captureMode = message.captureMode === "manual" ? "manual" : "automatic";
        await chrome.storage.local.set({ captureMode });
        sendResponse({ ok: true, captureMode });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
    });
    return true;
  }

  if (message.type === "GET_HISTORY") {
    Promise.all([getHistory(), getRecordingState(), ensureSession(), getCaptureMode()])
      .then(async ([history, recording, session, captureMode]) => {
        const workflow = await WorkflowStore.snapshot(session.id);
        sendResponse({ ok: true, history, recording, session, captureMode, actionCount: workflow.actions.length, workflowError: workflow.error });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_SCREENSHOT") {
    EvidenceDB.get(message.id)
      .then((screenshot) => sendResponse({ ok: Boolean(screenshot), screenshot }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "TOGGLE_RECORDING") {
    (async () => {
      try {
        const recording = !await getRecordingState();
        if (!recording) await flushRecordedActions();
        await setRecordingState(recording);
        sendResponse({ ok: true, recording });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "CLEAR_HISTORY") {
    enqueueCapture(async () => {
      try {
        await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
        await EvidenceDB.clear();
        await WorkflowStore.reset((await ensureSession()).id);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    });
    return true;
  }

  if (message.type === "GENERATE_WORD_REPORT") {
    (async () => {
      try {
        const history = await getHistory();
        const session = await ensureSession();
        const sessionEntries = history.filter((entry) => entry?.sessionId === session.id);
        if (!sessionEntries.length) throw new Error("No evidence exists in the current session.");

        const docxBytes = await DocxReport.build(history, session);
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < docxBytes.length; i += chunkSize) {
          binary += String.fromCharCode(...docxBytes.subarray(i, Math.min(i + chunkSize, docxBytes.length)));
        }
        const dataUrl = `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${btoa(binary)}`;
        const filename = DocxReport.filenameForReport(session);
        const downloadId = await chrome.downloads.download({
          url: dataUrl,
          filename,
          saveAs: false,
          conflictAction: "uniquify"
        });
        sendResponse({ ok: true, downloadId, filename });
      } catch (error) {
        warn("GENERATE_WORD_REPORT failed:", error);
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "EXPORT_DATA") {
    (async () => {
      try {
        const history = await getHistory();
        const recording = await getRecordingState();
        const session = await ensureSession();
        const payload = {
          exportedAt: new Date().toISOString(),
          extension: "Browser Test Evidence Recorder",
          version: "1.3.0",
          session,
          recording,
          count: history.length,
          history
        };

        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        let url = null;
        let objectUrl = null;

        if (typeof URL.createObjectURL === "function") {
          objectUrl = URL.createObjectURL(blob);
          url = objectUrl;
        }
        if (!url) {
          url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
        }

        const filename = `${DOWNLOAD_ROOT}/browser-test-evidence-${new Date()
          .toISOString().replace(/[:.]/g, "-")}.json`;

        const downloadId = await chrome.downloads.download({
          url,
          filename,
          saveAs: false,
          conflictAction: "uniquify"
        });

        if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
        sendResponse({ ok: true, downloadId });
      } catch (error) {
        warn("EXPORT_DATA failed:", error);
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (message.type === "EXPORT_PLAYWRIGHT") {
    (async () => {
      try {
        await flushRecordedActions();
        const session = await ensureSession();
        const workflow = await WorkflowStore.snapshot(session.id);
        const playwrightCode = PlaywrightExport.build(workflow, session);

        // Create download
        const blob = new Blob([playwrightCode], { type: 'text/javascript' });
        let url = null;
        let objectUrl = null;

        if (typeof URL.createObjectURL === "function") {
          objectUrl = URL.createObjectURL(blob);
          url = objectUrl;
        }
        if (!url) {
          url = `data:text/javascript;charset=utf-8,${encodeURIComponent(playwrightCode)}`;
        }

        const testCaseId = session.testCaseId || "test";
        const filename = `${DOWNLOAD_ROOT}/playwright-tests/${testCaseId}-${session.id}.spec.js`;

        const downloadId = await chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: false,
          conflictAction: "uniquify"
        });

        if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
        sendResponse({ ok: true, downloadId, filename });
      } catch (error) {
        warn("EXPORT_PLAYWRIGHT failed:", error);
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  return undefined;
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.HISTORY,
      STORAGE_KEYS.RECORDING,
      SESSION_KEY
    ]);

    const updates = {};
    if (!Array.isArray(result[STORAGE_KEYS.HISTORY])) updates[STORAGE_KEYS.HISTORY] = [];
    if (typeof result[STORAGE_KEYS.RECORDING] !== "boolean") updates[STORAGE_KEYS.RECORDING] = true;
    if (!result[SESSION_KEY]?.id) updates[SESSION_KEY] = { id: makeSessionId(), startedAt: new Date().toISOString(), sequence: 0, testCaseId: "" };
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);

    await migrateLegacyScreenshots();
  } catch (error) {
    warn("Initialization failed:", error);
  }
});

// Also attempt migration when the service worker starts after an extension
// update, not only during installation.
migrateLegacyScreenshots();

chrome.commands.onCommand.addListener((command) => {
  if (command !== "manual_capture") return;
  enqueueCapture(async () => { await captureActiveTab("manual"); });
});

// Actions are serialized independently of slow image capture/downloads.
let actionMessageQueue = Promise.resolve();
function queueAction(task) {
  const result = actionMessageQueue.then(task);
  actionMessageQueue = result.catch(error => warn('Action recording failed:', error));
  return result;
}
async function recordAction(action, sender) {
  if (!sender.tab || !action || !['fill','click','doubleClick','press','check','select','upload','unsupported'].includes(action.type)) return false;
  return queueAction(async () => {
    const frames = [];
    let frameError = false;
    if (sender.frameId) {
      const all = await chrome.webNavigation.getAllFrames({tabId:sender.tab.id});
      let current = all?.find(frame => frame.frameId === sender.frameId);
      if (!current) frameError = true;
      const seen = new Set();
      while (current && current.frameId !== 0 && !seen.has(current.frameId)) {
        seen.add(current.frameId);
        frames.unshift(current.url);
        current = all.find(frame => frame.frameId === current.parentFrameId);
      }
      if (!current || current.frameId !== 0) frameError = true;
    }
    const entry = {
      ...action, tabId:sender.tab.id, frames,
      topUrl: sender.frameId ? sender.tab.url : action.url
    };
    delete entry.sessionId;
    // Never accept a plaintext value for a field marked sensitive.
    if (entry.secretKey) delete entry.value;
    if (frameError) { entry.type = 'unsupported'; entry.description = 'Frame disappeared before it could be identified. Re-record this step.'; }
    const result = await WorkflowStore.append(entry, action.sessionId);
    if (result) chrome.runtime.sendMessage({type:'ACTIONS_UPDATED'}).catch(() => {});
    return result;
  });
}
function recordNavigation(details) {
  if (details.frameId !== 0 || !/^https?:\/\//.test(details.url || '')) return;
  queueAction(async () => {
    const navigation = details.transitionQualifiers?.includes('forward_back') ? 'history' : details.transitionType === 'reload' ? 'reload' :
      ['typed','auto_bookmark','generated','keyword','keyword_generated'].includes(details.transitionType) ? 'direct' : 'effect';
    await WorkflowStore.append({type:'navigate',tabId:details.tabId,url:details.url,topUrl:details.url,navigation,timestamp:details.timeStamp});
    chrome.runtime.sendMessage({type:'ACTIONS_UPDATED'}).catch(() => {});
  });
}
chrome.webNavigation.onCommitted.addListener(recordNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(recordNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(recordNavigation);
chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
  queueAction(() => WorkflowStore.append({type:'popup',tabId:details.tabId,openerTabId:details.sourceTabId,url:details.url,timestamp:details.timeStamp}));
});
chrome.tabs.onRemoved.addListener(tabId => {
  queueAction(async () => {
    const session = await getSession();
    if (!session) return;
    const workflow = await WorkflowStore.snapshot(session.id);
    if (workflow.actions.some(action => action.tabId === tabId)) await WorkflowStore.append({type:'close',tabId,timestamp:Date.now()});
  });
});

async function flushRecordedActions() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(async tab => {
    const frames = await chrome.webNavigation.getAllFrames({tabId:tab.id});
    await Promise.allSettled((frames || [{frameId:0}]).map(frame =>
      chrome.tabs.sendMessage(tab.id, {type:'FLUSH_ACTIONS'}, {frameId:frame.frameId})));
  }));
  await actionMessageQueue;
}
