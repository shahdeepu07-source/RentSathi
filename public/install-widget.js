/* SajiloRent install widget: floating button + download modal, self-contained. */
(function () {
  if (window.__sajiloInstallWidget) return;
  window.__sajiloInstallWidget = true;

  var CONFIG = {
    version: "1.0",
    apk: "/downloads/SajiloRent-v1.0.apk",
    exe: "https://github.com/shahdeepu07-source/SajiloRent/releases/download/v1.0.0/SajiloRent-windows-v1.0.0.exe",
    androidNote: "APK for Android phones & tablets",
    windowsNote: "Windows app (loads the live site, no install needed)",
    iosNote: "No iOS app yet - open in Safari, tap Share, then \u201cAdd to Home Screen\u201d"
  };

  var ua = navigator.userAgent;
  var platform =
    /iPhone|iPad|iPod/i.test(ua) ? "ios"
    : /Android/i.test(ua) ? "android"
    : /Windows|Win64|Win32/i.test(ua) ? "windows"
    : "web";

  var deferredPrompt = null;

  var css = [
    ".sajilo-install-fab{position:fixed;z-index:9999;bottom:24px;right:20px;display:flex;align-items:center;gap:8px;padding:10px 16px;border:none;border-radius:999px;background:var(--accent,#2563eb);color:#fff;font-size:.85rem;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}",
    ".sajilo-install-fab svg{width:17px;height:17px}",
    ".sajilo-install-fab:hover{filter:brightness(1.1)}",
    "@media(min-width:768px){.sajilo-install-fab span{display:inline}}",
    ".sajilo-install-overlay{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;padding:16px}",
    ".sajilo-install-overlay.open{display:flex}",
    ".sajilo-install-modal{width:100%;max-width:380px;max-height:90vh;overflow:auto;background:#111827;color:#e5e7eb;border:1px solid rgba(148,163,184,.25);border-radius:14px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.5)}",
    ".sajilo-install-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}",
    ".sajilo-install-head h3{margin:0;font-size:1.05rem}",
    ".sajilo-install-close{background:none;border:none;color:#9ca3af;font-size:1.3rem;cursor:pointer;line-height:1}",
    ".sajilo-install-close:hover{color:#fff}",
    ".sajilo-install-opt{display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:10px;border-radius:10px;background:rgba(37,99,235,.12);border:1px solid rgba(37,99,235,.45);color:#fff;cursor:pointer;text-decoration:none;box-sizing:border-box}",
    ".sajilo-install-opt:hover{background:rgba(37,99,235,.22)}",
    ".sajilo-install-opt b{display:block;font-size:.92rem;margin-bottom:2px}",
    ".sajilo-install-opt small{display:block;color:#9ca3af;font-size:.75rem}",
    ".sajilo-install-opt.best{border-color:#22c55e;background:rgba(34,197,94,.12)}",
    ".sajilo-install-opt.best::after{content:\u201c\u2022 Recommended\u201d;float:right;color:#22c55e;font-size:.7rem;font-weight:600;margin-top:4px}",
    ".sajilo-install-foot{margin-top:12px;color:#6b7280;font-size:.72rem;text-align:center}",
    ".sajilo-install-foot button{background:none;border:none;color:var(--accent,#60a5fa);cursor:pointer;font-size:.72rem;text-decoration:underline;padding:0}"
  ].join("");

  function el(html) {
    var d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild;
  }

  function build() {
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    var fab = el(
      '<button class="sajilo-install-fab" title="Install SajiloRent app"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>App</span></button>'
    );

    var overlay = el(
      '<div class="sajilo-install-overlay" id="sajiloInstallOverlay"><div class="sajilo-install-modal" role="dialog" aria-label="Install SajiloRent"><div class="sajilo-install-head"><h3>Install SajiloRent</h3><button class="sajilo-install-close" aria-label="Close">\u00d7</button></div><div class="sajilo-install-body"></div><div class="sajilo-install-foot">Your data stays synced on the live site.<br><span class="sajilo-install-ver">v' + CONFIG.version + '</span></div></div></div>'
    );

    document.body.appendChild(fab);
    document.body.appendChild(overlay);
    return { fab: fab, overlay: overlay, body: overlay.querySelector(".sajilo-install-body") };
  }

  function openModal(ui) {
    var body = ui.body;
    var opts = [];

    if (platform === "android" || platform === "web") {
      opts.push(
        '<a class="sajilo-install-opt' + (platform === "android" ? " best" : "") + '" href="' + CONFIG.apk + '" download><b>Android \u2014 Download APK</b><small>' + CONFIG.androidNote + "</small></a>"
      );
    }
    if (platform === "windows" || platform === "web") {
      opts.push(
        '<a class="sajilo-install-opt' + (platform === "windows" ? " best" : "") + '" href="' + CONFIG.exe + '" download><b>Windows \u2014 Download .exe</b><small>' + CONFIG.windowsNote + "</small></a>"
      );
    }
    if (platform === "ios") {
      opts.push(
        '<div class="sajilo-install-opt"><b>iOS</b><small>' + CONFIG.iosNote + "</small></div>"
      );
    }
    if (deferredPrompt) {
      opts.push(
        '<button class="sajilo-install-opt" id="sajiloInstallPwa"><b>Install in browser</b><small>Adds SajiloRent as a desktop/mobile app (Chrome, Edge)</small></button>'
      );
    }

    body.innerHTML = opts.join("");
    var pwa = body.querySelector("#sajiloInstallPwa");
    if (pwa) {
      pwa.addEventListener("click", function (e) {
        e.preventDefault();
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () { deferredPrompt = null; });
        ui.overlay.classList.remove("open");
      });
    }
    ui.overlay.classList.add("open");
  }

  function init() {
    var ui = build();
    ui.fab.addEventListener("click", function () { openModal(ui); });
    ui.overlay.addEventListener("click", function (e) {
      if (e.target === ui.overlay || e.target.classList.contains("sajilo-install-close")) {
        ui.overlay.classList.remove("open");
      }
    });

    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferredPrompt = e;
    });
    window.addEventListener("appinstalled", function () { deferredPrompt = null; });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
