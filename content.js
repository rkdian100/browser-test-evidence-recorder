/*
 * Content script
 * - Detects user clicks and sends useful element metadata to the service worker.
 * - Debounces click captures by 500ms.
 * - Listens for Alt+S as an additional manual-capture path.
 */

const CLICK_DEBOUNCE_MS = 500;
let lastClickCaptureAt = 0;
let lastManualShortcutAt = 0;
let sHeld = false;
function isEditing(target) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}
document.addEventListener("keydown", event => {
  if (event.code === "KeyS" && !event.altKey && !event.ctrlKey && !event.metaKey && !isEditing(event.target)) sHeld = true;
}, true);
document.addEventListener("keyup", event => { if (event.code === "KeyS") sHeld = false; }, true);
window.addEventListener("blur", () => { sHeld = false; });
document.addEventListener("visibilitychange", () => { if (document.hidden) sHeld = false; });

function safeElementInfo(element) {
  if (!element || !(element instanceof Element)) return null;

  const tag = element.tagName?.toLowerCase() || "unknown";
  const id = element.id || "";
  const className = typeof element.className === "string"
    ? element.className.trim().replace(/\s+/g, " ").slice(0, 180)
    : "";
  const text = (element.innerText || element.textContent || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  const href = element instanceof HTMLAnchorElement ? element.href : "";

  return { tag, id, className, text, href };
}

function sendCapture(reason, elementInfo = null) {
  try {
    chrome.runtime.sendMessage({
      type: "CAPTURE_SCREENSHOT",
      reason,
      elementInfo
    }).catch(() => {
      // The page may be unloading or the extension context may be unavailable.
    });
  } catch (error) {
    console.debug("[Evidence Recorder] Could not send capture request:", error);
  }
}

document.addEventListener("click", (event) => {
  const now = Date.now();
  if (now - lastClickCaptureAt < CLICK_DEBOUNCE_MS) return;
  lastClickCaptureAt = now;

  const target = event.target instanceof Element
    ? event.target.closest("*")
    : null;

  if (!event.isTrusted) return;
  sendCapture(sHeld ? "manual" : "click", safeElementInfo(target));
}, true);

// Requested explicit Alt+S listener. The manifest command in background.js is
// also registered as a browser-level shortcut; the time guard prevents duplicates.
document.addEventListener("keydown", (event) => {
  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "s") {
    const now = Date.now();
    if (now - lastManualShortcutAt < 1000) return;
    lastManualShortcutAt = now;

    event.preventDefault();

    try {
      chrome.runtime.sendMessage({
        type: "MANUAL_CAPTURE",
        elementInfo: null
      }).catch(() => {
        // Ignore if the tab is unloading or the extension context is unavailable.
      });
    } catch (error) {
      console.debug("[Evidence Recorder] Manual shortcut failed:", error);
    }
  }
}, true);
