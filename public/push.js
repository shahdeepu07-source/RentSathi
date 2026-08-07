(function () {
  'use strict';

  var KEY = 'sajiloPush';
  var PREF_KEY = 'sajiloPushPref';
  var STYLE_ID = 'sajilo-push-style';

  function getToken() {
    try { return localStorage.getItem('token'); } catch (e) { return null; }
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch (e) { return null; }
  }

  function isCapacitor() {
    return typeof window !== 'undefined' && !!(window.Capacitor || window.capacitor);
  }

  function isElectron() {
    return typeof navigator !== 'undefined' &&
      (navigator.userAgent.indexOf('Electron') !== -1 || navigator.userAgent.indexOf('sajilorent') !== -1);
  }

  function registerWebPush(token, user) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return Promise.resolve(false);
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (existing) {
        return fetch('/api/push/vapid-key', {
          headers: { Authorization: 'Bearer ' + token }
        }).then(function (r) { return r.json(); }).then(function (vapid) {
          if (!vapid.publicKey) return false;
          var subPromise = existing || reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapid.publicKey)
          });
          return subPromise.then(function (sub) {
            return fetch('/api/push/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
              body: JSON.stringify({
                platform: 'web',
                subscription: {
                  endpoint: sub.endpoint,
                  keys: { p256dh: btoaArrayBuffer(sub.getKey('p256dh')), auth: btoaArrayBuffer(sub.getKey('auth')) }
                },
                deviceName: navigator.userAgent.indexOf('Electron') !== -1 ? 'Windows app' : 'Web browser'
              })
            }).then(function (r) {
              if (r.ok && user) localStorage.setItem(KEY, JSON.stringify({ userId: user.id, platform: 'web' }));
              return r.ok;
            });
          });
        });
      });
    }).catch(function () { return false; });
  }

  function registerAndroidPush(token, user) {
    if (!isCapacitor() || !window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.PushNotifications) {
      return Promise.resolve(false);
    }
    var push = window.Capacitor.Plugins.PushNotifications;
    push.addListener('registration', function (data) {
      window.__sajiloFcmToken = data.value;
      window.__sajiloDoAndroidRegister(token, user);
    });
    push.addListener('registrationError', function () {});
    return push.requestPermissions().then(function () {
      return push.register().then(function () {
        if (window.__sajiloFcmToken) {
          return window.__sajiloDoAndroidRegister(token, user);
        }
        return false;
      });
    }).catch(function () { return false; });
  }

  function buildAndroidPayload() {
    return {
      platform: 'android',
      subscription: { token: window.__sajiloFcmToken },
      deviceName: 'Android app'
    };
  }

  window.__sajiloDoAndroidRegister = function (token, user) {
    if (!token || !window.__sajiloFcmToken) return Promise.resolve(false);
    return fetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(buildAndroidPayload())
    }).then(function (r) {
      if (r.ok && user) localStorage.setItem(KEY, JSON.stringify({ userId: user.id, platform: 'android' }));
      return r.ok;
    }).catch(function () { return false; });
  };

  window.__sajiloSetFcmToken = function (tokenValue) {
    window.__sajiloFcmToken = tokenValue;
  };

  function unregisterPush(token, key) {
    if (!token || !key) return;
    fetch('/api/push/unregister', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ platform: 'web', key: key })
    }).catch(function () {});
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function btoaArrayBuffer(buffer) {
    var binary = '';
    var bytes = new Uint8Array(buffer);
    for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
  }

  function hasPref() {
    try { return localStorage.getItem(PREF_KEY) !== null; } catch (e) { return false; }
  }

  function showPrompt() {
    var box = document.getElementById('sajilo-push-box');
    if (box) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#sajilo-push-box{position:fixed;z-index:99999;right:14px;bottom:14px;max-width:320px;width:calc(100% - 28px);' +
      'background:var(--card-bg,#0f172a);border:1px solid var(--border,#1e293b);border-radius:14px;padding:16px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:inherit;color:var(--text,#e2e8f0)}' +
      '#sajilo-push-box h4{margin:0 0 6px;font-size:15px}' +
      '#sajilo-push-box p{margin:0 0 12px;font-size:13px;line-height:1.45;color:#94a3b8}' +
      '#sajilo-push-box .sajilo-push-btns{display:flex;gap:8px}' +
      '#sajilo-push-box button{border:none;border-radius:9px;padding:8px 12px;font-size:13px;cursor:pointer}' +
      '#sajilo-push-box .sp-allow{background:#2563eb;color:#fff;flex:1}' +
      '#sajilo-push-box .sp-no{background:transparent;color:#94a3b8}';
    document.head.appendChild(style);
    box = document.createElement('div');
    box.id = 'sajilo-push-box';
    box.innerHTML =
      '<h4>🔔 Enable notifications?</h4>' +
      '<p>Get alerts for new bills, notices and billing-day reminders — even when the app is closed.</p>' +
      '<div class="sajilo-push-btns">' +
      '<button class="sp-allow" id="sajilo-push-yes">Yes, notify me</button>' +
      '<button class="sp-no" id="sajilo-push-no">Not now</button>' +
      '</div>';
    document.body.appendChild(box);
    box.querySelector('#sajilo-push-yes').addEventListener('click', function () {
      box.remove();
      enable();
    });
    box.querySelector('#sajilo-push-no').addEventListener('click', function () {
      box.remove();
      try { localStorage.setItem(PREF_KEY, 'later'); } catch (e) {}
    });
  }

  function init() {
    var token = getToken();
    if (!token) return;
    var user = getUser();
    if (isCapacitor()) {
      registerAndroidPush(token, user);
      return;
    }
    if (hasPref()) {
      var pref = null;
      try { pref = localStorage.getItem(PREF_KEY); } catch (e) {}
      if (pref === 'yes') { registerWebPush(token, user); return; }
      if (pref === 'later') return;
    }
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      registerWebPush(token, user).then(function (ok) {
        if (ok) { try { localStorage.setItem(PREF_KEY, 'yes'); } catch (e) {} }
      });
      return;
    }
    if (Notification.permission === 'denied') return;
    var shown = false;
    try { shown = localStorage.getItem('sajiloPushPromptShown') === '1'; } catch (e) {}
    if (shown) return;
    try { localStorage.setItem('sajiloPushPromptShown', '1'); } catch (e) {}
    window.setTimeout(showPrompt, 2500);
  }

  function enable() {
    var token = getToken();
    if (!token) return;
    var user = getUser();
    registerWebPush(token, user).then(function (ok) {
      try { localStorage.setItem(PREF_KEY, ok ? 'yes' : 'later'); } catch (e) {}
      if (ok) {
        var saved = document.createElement('div');
        saved.style.cssText = 'position:fixed;z-index:99999;right:14px;bottom:14px;background:#14532d;color:#bbf7d0;border:1px solid #166534;border-radius:12px;padding:12px 16px;font-size:13px';
        saved.textContent = '✓ Notifications enabled';
        document.body.appendChild(saved);
        window.setTimeout(function () { saved.remove(); }, 3500);
      }
    });
  }

  window.SajiloPush = { init: init, enable: enable };

  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
  boot();
})();
