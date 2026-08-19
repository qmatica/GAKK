// ==UserScript==
// @name         GAKK update probe
// @namespace    local.gakk.probe
// @version      1.0.0
// @author       Arsen Gogeshvili
// @description     Throwaway. Tests GitHub install and auto-update only. Delete when done.
// @description:ru  Временный. Проверка установки и обновления через GitHub. Удалить после проверки.
// @match        *://catalog.krasarh.ru/l/private/ask*
// @match        *://catalog.krasarh.ru./l/private/ask*
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/qmatica/GAKK/main/gakk_update_probe.user.js
// @downloadURL  https://raw.githubusercontent.com/qmatica/GAKK/main/gakk_update_probe.user.js
// ==/UserScript==

/* Shows its own version in the corner and nothing else. It shares no @name or @namespace
   with any real tool, so installing, updating and deleting it cannot affect them. */

(function () {
  'use strict';
  const VERSION = '1.0.0';   // must match @version above

  function mount() {
    if (!document.body || document.getElementById('gakk-probe')) return;
    const d = document.createElement('div');
    d.id = 'gakk-probe';
    d.textContent = 'probe v' + VERSION;
    d.style.cssText = 'position:fixed;z-index:2147483647;bottom:12px;right:12px;' +
      'font:600 13px system-ui;color:#fff;background:#6b3fa0;padding:7px 11px;border-radius:8px;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.35)';
    document.body.appendChild(d);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  new MutationObserver(() => mount()).observe(document.documentElement, { childList: true, subtree: true });
})();
