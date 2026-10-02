/* Optional full-page evidence viewer. Popup V1.1 now uses an inline viewer. */

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function formatTimestamp(iso) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit"
    }).format(new Date(iso));
  } catch (_) { return iso || "Unknown time"; }
}

function reasonLabel(reason) {
  const labels = { click: "CLICK", navigation: "NAVIGATION", new_tab: "NEW TAB", tab_updated: "TAB UPDATED", manual: "MANUAL" };
  return labels[reason] || String(reason || "CAPTURE").toUpperCase();
}

function elementSummary(info) {
  if (!info) return "Manual browser capture";
  const selectorParts = [];
  if (info.tag) selectorParts.push(info.tag);
  if (info.id) selectorParts.push(`#${info.id}`);
  let selector = selectorParts.join("");
  if (info.className) selector += `.${info.className.split(/\s+/).slice(0, 2).join(".")}`;
  return [selector, info.text ? `“${info.text}”` : ""].filter(Boolean).join(" · ") || "Clicked element";
}

async function loadEntry() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) throw new Error("No evidence ID was supplied.");

  const historyResult = await sendMessage({ type: "GET_HISTORY" });
  if (!historyResult?.ok) throw new Error("Could not load evidence history.");
  const entry = historyResult.history.find((item) => item.id === id);
  if (!entry) throw new Error("Evidence record not found.");

  document.title = `${reasonLabel(entry.reason)} · Browser Test Evidence Recorder`;
  document.getElementById("pageTitle").textContent = entry.title || "Screenshot Evidence";
  document.getElementById("reason").textContent = reasonLabel(entry.reason);
  document.getElementById("timestamp").textContent = formatTimestamp(entry.timestamp);
  document.getElementById("url").textContent = entry.url || "URL unavailable";
  document.getElementById("element").textContent = elementSummary(entry.elementInfo);

  const sourceLink = document.getElementById("sourceLink");
  if (entry.url && /^https?:\/\//i.test(entry.url)) {
    sourceLink.href = entry.url;
    sourceLink.hidden = false;
  } else sourceLink.hidden = true;

  const image = document.getElementById("fullScreenshot");
  const imageResult = await sendMessage({ type: "GET_SCREENSHOT", id });
  if (!imageResult?.ok || !imageResult.screenshot) throw new Error("Screenshot unavailable.");
  image.src = imageResult.screenshot;
}

loadEntry().catch((error) => {
  console.error("[Evidence Recorder] Viewer failed:", error);
  document.getElementById("errorState").hidden = false;
  document.getElementById("fullScreenshot").hidden = true;
  document.getElementById("sourceLink").hidden = true;
});
