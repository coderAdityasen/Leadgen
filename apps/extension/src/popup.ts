import { isLoopbackOrigin, originPattern, parseServerOrigin } from "./serverOrigin.js";

function updateUI() {
  chrome.runtime.sendMessage({ channel: "leaddesk", type: "leaddesk.popup.status" }, (res) => {
    if (!res) return;

    const unpairedView = document.getElementById("unpaired-view")!;
    const pairedView = document.getElementById("paired-view")!;
    const badge = document.getElementById("role-badge")!;

    if (res.paired) {
      unpairedView.style.display = "none";
      pairedView.style.display = "block";

      document.getElementById("paired-label")!.textContent = res.deviceLabel || "Connected";
      document.getElementById("paired-server")!.textContent = res.serverUrl || "";
      document.getElementById("paired-tab")!.textContent = res.senderTabId ? `Tab #${res.senderTabId}` : (res.hasEligibleTab ? "Eligible" : "None");

      badge.textContent = res.role || "Standby";
      badge.className = `badge badge-${res.role || "standby"}`;
    } else {
      unpairedView.style.display = "block";
      pairedView.style.display = "none";

      badge.textContent = "Unpaired";
      badge.className = "badge badge-unpaired";
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  updateUI();

  const pairBtn = document.getElementById("pair-btn")!;
  const errorDiv = document.getElementById("pair-error")!;

  pairBtn.addEventListener("click", () => {
    errorDiv.style.display = "none";
    const parsed = parseServerOrigin((document.getElementById("server-url") as HTMLInputElement).value);
    if ("error" in parsed) {
      errorDiv.textContent = parsed.error;
      errorDiv.style.display = "block";
      return;
    }
    const serverUrl = parsed.origin;
    const label = (document.getElementById("device-label") as HTMLInputElement).value.trim();
    const pairingCode = (document.getElementById("pairing-code") as HTMLInputElement).value.trim();

    if (!pairingCode || pairingCode.length !== 8) {
      errorDiv.textContent = "Please enter an 8-character pairing code.";
      errorDiv.style.display = "block";
      return;
    }

    pairBtn.setAttribute("disabled", "true");
    pairBtn.textContent = "Pairing...";

    const sendPair = () => chrome.runtime.sendMessage(
      {
        channel: "leaddesk",
        type: "leaddesk.popup.pair",
        payload: { serverUrl, pairingCode, label },
      },
      (res) => {
        pairBtn.removeAttribute("disabled");
        pairBtn.textContent = "Pair Extension";

        if (res && res.ok) {
          updateUI();
        } else {
          errorDiv.textContent = res?.error || "Pairing failed.";
          errorDiv.style.display = "block";
        }
      }
    );

    if (isLoopbackOrigin(serverUrl)) {
      sendPair();
      return;
    }
    // A remote (VPS) server: ask the browser for access to that one site. This must run
    // directly inside the click handler (a user gesture), before any other await.
    chrome.permissions.request({ origins: [originPattern(serverUrl)] }, (granted) => {
      if (!granted) {
        pairBtn.removeAttribute("disabled");
        pairBtn.textContent = "Pair Extension";
        errorDiv.textContent = `Access to ${serverUrl} was not granted, so the extension cannot reach it.`;
        errorDiv.style.display = "block";
        return;
      }
      sendPair();
    });
  });

  const unpairBtn = document.getElementById("unpair-btn")!;
  unpairBtn.addEventListener("click", () => {
    if (confirm("Disconnect this extension from Lead Desk?")) {
      chrome.runtime.sendMessage({ channel: "leaddesk", type: "leaddesk.popup.forget" }, () => {
        updateUI();
      });
    }
  });
});
