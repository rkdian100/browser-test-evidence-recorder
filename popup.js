/* Popup UI controller */

const state = {
  history: [],
  actionCount: 0,
  recording: true,
  captureMode: "automatic",
  session: null
};

const els = {};
let toastTimer = null;

function cacheElements() {
  els.actionCount = document.getElementById("actionCount");
  els.captureMode = document.getElementById("captureMode");
  els.screenshotCount = document.getElementById("screenshotCount");
  els.recordingStatus = document.getElementById("recordingStatus");
  els.statusDot = document.getElementById("statusDot");
  els.toggleButton = document.getElementById("toggleButton");
  els.toggleIcon = document.getElementById("toggleIcon");
  els.toggleText = document.getElementById("toggleText");
  els.sessionId = document.getElementById("sessionId");
  els.testCaseId = document.getElementById("testCaseId");
  els.newSessionButton = document.getElementById("newSessionButton");
  els.saveTestCaseButton = document.getElementById("saveTestCaseButton");
  els.clearButton = document.getElementById("clearButton");
  els.exportButton = document.getElementById("exportButton");
  els.wordReportButton = document.getElementById("wordReportButton");
  els.playwrightButton = document.getElementById("playwrightButton");
  els.historyCountLabel = document.getElementById("historyCountLabel");
  els.historyList = document.getElementById("historyList");
  els.emptyState = document.getElementById("emptyState");
  els.toast = document.getElementById("toast");
  els.viewerModal = document.getElementById("viewerModal");
  els.viewerImage = document.getElementById("viewerImage");
  els.viewerReason = document.getElementById("viewerReason");
  els.viewerEvidence = document.getElementById("viewerEvidence");
  els.viewerTimestamp = document.getElementById("viewerTimestamp");
  els.viewerUrl = document.getElementById("viewerUrl");
  els.viewerElement = document.getElementById("viewerElement");
  els.viewerFile = document.getElementById("viewerFile");
  els.closeViewer = document.getElementById("closeViewer");
}

function showToast(message, type = "info") {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast visible ${type}`;
  toastTimer = setTimeout(() => { els.toast.className = "toast"; }, 3200);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function formatTimestamp(iso) {
  if (!iso) return "Unknown time";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit"
    }).format(new Date(iso));
  } catch (_) { return iso; }
}

function truncateUrl(url, maxLength = 55) {
  if (!url) return "URL unavailable";
  if (url.length <= maxLength) return url;
  return `${url.slice(0, maxLength - 1)}…`;
}

function reasonLabel(reason) {
  const labels = {
    click: "CLICK",
    navigation: "NAVIGATION",
    new_tab: "NEW TAB",
    tab_updated: "TAB UPDATED",
    manual: "MANUAL"
  };
  return labels[reason] || String(reason || "CAPTURE").toUpperCase();
}

function elementSummary(info) {
  if (!info) return "Manual browser capture";

  const selectorParts = [];
  if (info.tag) selectorParts.push(info.tag);
  if (info.id) selectorParts.push(`#${info.id}`);

  let selector = selectorParts.join("");
  if (info.className) selector += `.${info.className.split(/\s+/).slice(0, 2).join(".")}`;
  if (selector.length > 65) selector = `${selector.slice(0, 64)}…`;
  return selector || info.text || "Clicked element";
}

function safeText(value) {
  return String(value ?? "");
}

function evidenceNumber(entry) {
  return String(entry.sequence || 0).padStart(3, "0");
}

async function loadThumbnail(entry, img) {
  try {
    const response = await sendMessage({ type: "GET_SCREENSHOT", id: entry.id });
    if (!response?.ok || !response.screenshot) throw new Error("Screenshot unavailable");
    img.src = response.screenshot;
    img.classList.add("loaded");
  } catch (error) {
    img.classList.add("missing");
    img.alt = "Screenshot unavailable";
  }
}

function render() {
  const history = state.history;
  const count = history.length;

  els.captureMode.value = state.captureMode;
  els.actionCount.textContent = state.actionCount;
  els.sessionId.textContent = state.session?.id || "—";
  if (document.activeElement !== els.testCaseId) els.testCaseId.value = state.session?.testCaseId || "";
  els.screenshotCount.textContent = count;
  els.historyCountLabel.textContent = count;
  els.recordingStatus.textContent = state.recording ? "Recording" : "Paused";
  els.statusDot.className = `status-dot ${state.recording ? "recording" : "paused"}`;
  els.statusDot.title = state.recording ? "Recording" : "Paused";
  els.toggleText.textContent = state.recording ? "Pause" : "Resume";
  els.toggleIcon.textContent = state.recording ? "Ⅱ" : "▶";
  els.toggleButton.classList.toggle("paused", !state.recording);
  els.clearButton.disabled = count === 0 && state.actionCount === 0;
  els.exportButton.disabled = count === 0;
  const currentSessionCount = history.filter((entry) => entry.sessionId === state.session?.id).length;
  els.wordReportButton.disabled = currentSessionCount === 0;
  if (els.playwrightButton) els.playwrightButton.disabled = state.actionCount === 0;

  els.historyList.innerHTML = "";
  els.emptyState.hidden = count !== 0;
  if (!count) return;

  const fragment = document.createDocumentFragment();

  for (const entry of history) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
    item.title = "View screenshot here";

    const thumbnailWrap = document.createElement("div");
    thumbnailWrap.className = "thumbnail-wrap";
    const img = document.createElement("img");
    img.className = "thumbnail loading";
    img.alt = "Loading screenshot";
    thumbnailWrap.appendChild(img);

    const content = document.createElement("div");
    content.className = "history-content";

    const topline = document.createElement("div");
    topline.className = "history-topline";
    const number = document.createElement("span");
    number.className = "evidence-number";
    number.textContent = `#${evidenceNumber(entry)}`;
    const badge = document.createElement("span");
    badge.className = `reason-badge reason-${entry.reason}`;
    badge.textContent = reasonLabel(entry.reason);
    const timestamp = document.createElement("span");
    timestamp.className = "timestamp";
    timestamp.textContent = formatTimestamp(entry.timestamp);
    topline.append(number, badge, timestamp);

    const info = document.createElement("div");
    info.className = "element-info";
    info.textContent = entry.elementInfo
      ? `${elementSummary(entry.elementInfo)}${entry.elementInfo.text ? ` · “${safeText(entry.elementInfo.text).slice(0, 70)}”` : ""}`
      : (entry.pageName || "Manual browser capture");

    const url = document.createElement("div");
    url.className = "url";
    url.title = entry.url || "";
    url.textContent = truncateUrl(entry.url);

    content.append(topline, info, url);

    const icon = document.createElement("span");
    icon.className = "open-icon";
    icon.textContent = "⌕";

    item.append(thumbnailWrap, content, icon);
    item.addEventListener("click", () => openViewer(entry));
    fragment.appendChild(item);

    loadThumbnail(entry, img);
  }

  els.historyList.appendChild(fragment);
}

async function loadState() {
  try {
    const response = await sendMessage({ type: "GET_HISTORY" });
    if (!response?.ok) throw new Error(response?.error || "Could not load evidence history.");
    state.history = Array.isArray(response.history) ? response.history : [];
    state.recording = response.recording !== false;
    state.session = response.session || null;
    state.captureMode = response.captureMode || "automatic";
    state.actionCount = response.actionCount || 0;
    if (response.workflowError) showToast(response.workflowError, "error");
    render();
  } catch (error) {
    console.error("[Evidence Recorder] Failed to load state:", error);
    showToast("Could not load recorder history.", "error");
  }
}

async function openViewer(entry) {
  els.viewerModal.hidden = false;
  document.body.classList.add("modal-open");
  els.viewerReason.textContent = reasonLabel(entry.reason);
  els.viewerEvidence.textContent = entry.evidenceLabel || `${entry.sessionId || "BTE"} #${evidenceNumber(entry)}`;
  els.viewerTimestamp.textContent = formatTimestamp(entry.timestamp);
  els.viewerUrl.textContent = entry.url || "URL unavailable";
  els.viewerElement.textContent = elementSummary(entry.elementInfo);
  els.viewerFile.textContent = entry.filename || "Stored in extension evidence database";
  els.viewerImage.removeAttribute("src");
  els.viewerImage.alt = "Loading full screenshot";

  try {
    const response = await sendMessage({ type: "GET_SCREENSHOT", id: entry.id });
    if (!response?.ok || !response.screenshot) throw new Error("Screenshot unavailable");
    els.viewerImage.src = response.screenshot;
    els.viewerImage.alt = `Screenshot captured ${formatTimestamp(entry.timestamp)}`;
  } catch (error) {
    els.viewerImage.alt = "Screenshot unavailable";
    showToast("Could not load the full screenshot.", "error");
  }
}

function closeViewer() {
  els.viewerModal.hidden = true;
  document.body.classList.remove("modal-open");
  els.viewerImage.removeAttribute("src");
}

async function createNewSession() {
  const currentTestCase = els.testCaseId.value.trim();
  if (!confirm("Start a new session? Export the current Playwright workflow first if needed. Screenshot history and downloaded files are kept.")) return;
  els.newSessionButton.disabled = true;
  try {
    const response = await sendMessage({ type: "NEW_SESSION", testCaseId: currentTestCase });
    if (!response?.ok) throw new Error(response?.error || "Could not create session.");
    state.session = response.session;
    state.actionCount = 0;
    render();
    showToast(`New session started: ${state.session.id}`, "success");
  } catch (error) {
    console.error(error);
    showToast("Could not start a new session.", "error");
  } finally { els.newSessionButton.disabled = false; }
}

async function saveTestCase() {
  els.saveTestCaseButton.disabled = true;
  try {
    const response = await sendMessage({ type: "UPDATE_TEST_CASE", testCaseId: els.testCaseId.value.trim() });
    if (!response?.ok) throw new Error(response?.error || "Could not save test case ID.");
    state.session = response.session;
    render();
    showToast(state.session.testCaseId ? `Test Case ID saved: ${state.session.testCaseId}` : "Test Case ID cleared.", "success");
  } catch (error) {
    console.error(error);
    showToast("Could not save Test Case ID.", "error");
  } finally { els.saveTestCaseButton.disabled = false; }
}

async function toggleRecording() {
  els.toggleButton.disabled = true;
  try {
    const response = await sendMessage({ type: "TOGGLE_RECORDING" });
    if (!response?.ok) throw new Error(response?.error || "Toggle failed.");
    state.recording = response.recording;
    render();
    showToast(state.recording ? "Recording resumed." : "Recording paused.", state.recording ? "success" : "warning");
  } catch (error) {
    console.error("[Evidence Recorder] Toggle failed:", error);
    showToast("Could not change recording state.", "error");
  } finally {
    els.toggleButton.disabled = false;
  }
}

async function clearHistory() {
  if (!state.history.length && !state.actionCount) return;
  if (!confirm("Clear screenshots and recorded Playwright actions from this extension? Downloaded files will be kept.")) return;

  els.clearButton.disabled = true;
  try {
    const response = await sendMessage({ type: "CLEAR_HISTORY" });
    if (!response?.ok) throw new Error(response?.error || "Clear failed.");
    state.history = [];
    state.actionCount = 0;
    render();
    showToast("Evidence history cleared. Existing downloaded image files are kept.", "success");
  } catch (error) {
    console.error("[Evidence Recorder] Clear failed:", error);
    showToast("Could not clear history.", "error");
    render();
  }
}

async function generateWordReport() {
  const sessionId = state.session?.id;
  if (!sessionId) return;
  const currentSessionCount = state.history.filter((entry) => entry.sessionId === sessionId).length;
  if (!currentSessionCount) {
    showToast("No evidence exists in the current session.", "warning");
    return;
  }

  els.wordReportButton.disabled = true;
  showToast("Building Word report…", "info");
  try {
    const response = await sendMessage({ type: "GENERATE_WORD_REPORT" });
    if (!response?.ok) throw new Error(response?.error || "Word report generation failed.");
    showToast(`Word report saved: ${response.filename || "Test Evidence Report.docx"}`, "success");
  } catch (error) {
    console.error("[Evidence Recorder] Word report failed:", error);
    showToast(error.message || "Could not generate Word report.", "error");
  } finally {
    render();
  }
}

async function exportData() {
  if (!state.history.length) return;
  els.exportButton.disabled = true;
  try {
    const response = await sendMessage({ type: "EXPORT_DATA" });
    if (!response?.ok) throw new Error(response?.error || "Export failed.");
    showToast("JSON export saved automatically to Downloads.", "success");
  } catch (error) {
    console.error("[Evidence Recorder] Export failed:", error);
    showToast("Could not export evidence.", "error");
  } finally {
    els.exportButton.disabled = false;
  }
}

async function exportPlaywright() {
  const sessionId = state.session?.id;
  if (!sessionId) {
    showToast("No active session.", "warning");
    return;
  }

  els.playwrightButton.disabled = true;
  showToast("Generating Playwright test...", "info");

  try {
    const response = await sendMessage({ type: "EXPORT_PLAYWRIGHT" });
    if (!response?.ok) throw new Error(response?.error || "Playwright export failed.");
    showToast(`Playwright test saved: ${response.filename || "test.spec.js"}`, "success");
  } catch (error) {
    console.error("[Evidence Recorder] Playwright export failed:", error);
    showToast(error.message || "Could not export Playwright test.", "error");
  } finally {
    els.playwrightButton.disabled = false;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "ACTIONS_UPDATED") { loadState(); return; }
  if (message?.type !== "NEW_SCREENSHOT" || !message.entry) return;
  loadState().then(() => {
    const path = message.entry.filename ? message.entry.filename.replace(/^Browser Test Evidence Recorder\//, "") : "Downloads";
    showToast(`Screenshot saved automatically: ${path}`, "success");
  });
});

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  els.captureMode.addEventListener("change", async () => {
    els.captureMode.disabled = true;
    try {
      const result = await sendMessage({ type: "SET_CAPTURE_MODE", captureMode: els.captureMode.value });
      if (!result?.ok) throw new Error(result?.error || "Could not change capture mode.");
      state.captureMode = result.captureMode;
      showToast(state.captureMode === "manual" ? "Manual mode: hold S and click, or press Alt+S." : "Automatic capture enabled.", "success");
    } catch (error) { showToast(error.message, "error"); }
    finally { els.captureMode.disabled = false; render(); }
  });
  els.toggleButton.addEventListener("click", toggleRecording);
  els.newSessionButton.addEventListener("click", createNewSession);
  els.saveTestCaseButton.addEventListener("click", saveTestCase);
  els.clearButton.addEventListener("click", clearHistory);
  els.exportButton.addEventListener("click", exportData);
  els.wordReportButton.addEventListener("click", generateWordReport);
  els.playwrightButton.addEventListener("click", exportPlaywright);
  els.closeViewer.addEventListener("click", closeViewer);
  els.viewerModal.addEventListener("click", (event) => {
    if (event.target === els.viewerModal) closeViewer();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.viewerModal.hidden) closeViewer();
  });
  loadState();
});
