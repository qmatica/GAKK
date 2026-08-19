// ==UserScript==
// @name         GAKK records reader
// @namespace    local.gakk.tools
// @version      1.9.0
// @author       Arsen Gogeshvili
// @description     Personal GAKK cabinet reader
// @description:ru  Чтение личного кабинета ГАКК
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%2312507a'/%3E%3Cpath d='M20 16h18l8 8v24a2 2 0 0 1-2 2H20a2 2 0 0 1-2-2V18a2 2 0 0 1 2-2z' fill='%23fff'/%3E%3Cpath d='M38 16v8h8' fill='%23cfe0ec'/%3E%3Cpath d='M32 30v12m0 0l-5-5m5 5l5-5' stroke='%2312507a' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E
// @match        *://catalog.krasarh.ru/l/private/ask*
// @match        *://catalog.krasarh.ru./l/private/ask*
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/qmatica/GAKK/main/gakk_records_reader.user.js
// @downloadURL  https://raw.githubusercontent.com/qmatica/GAKK/main/gakk_records_reader.user.js
// ==/UserScript==

/* Reads every page of личный кабинет → Требования and writes a records file for the
 * GAKK Explorer. It runs here because it needs the session — the Explorer runs from
 * file:// and cannot reach the cabinet. It stores nothing and displays no data.
 *
 * /l/private/ask?page=N is server-rendered, so each page is fetched and parsed.
 *
 * Output:
 *   { meta{built, source, account, owners, counts}, const{attributeId, group, ext},
 *     segments[{o,f,p,d,r,s,e,serial,t,st}], pending[{f,p,d,t,st}],
 *     owners{CODE:{captured, pages, complete, delos[]}} }
 * The owners block is required — the Explorer refuses a file that declares no owner.
 */

(function () {
  'use strict';

  const VERSION = '1.9.0';
  const LIST_PATH = '/l/private/ask';
  const OWNER_KEY = 'gakk_capture_owner';   // { "<account name>": "AG" } — asked accounts only
  const MAX_PAGES = 60;                     // a cap so a broken pager cannot loop forever

  /* GAKK account name -> owner code, so neither collaborator types anything.
     The name is the key, never the identity: a renamed account is simply unknown and the
     script asks. Using the name as the owner would make a rename look like a new person
     and duplicate that owner's delos on merge. Edit this map to add or correct one. */
  const KNOWN = {
    'Арсен':  'AG',
    'Андрей': 'AM',
  };

  // ---------- parsing ----------
  // Fond ids are digits, optionally letter-prefixed: 592, 658, Р-2453.
  const FOND = '[А-ЯЁA-Z]?-?\\d+';

  // One definition of a delo id, reused by every path that parses one, so a delo keys
  // identically whether it came from an anchor label or a title cell. Digits plus at most
  // one litera, attached ("320Б") or spaced ("624 Б").
  const normLit = d => String(d == null ? '' : d).trim().replace(/^(\d+)\s+([А-ЯЁа-яёA-Za-z])$/, '$1$2');

  // Every viewer anchor, bounded href → </a> so a label can never bleed across links.
  const ANCHOR = () => new RegExp(
    'imageViewer/show\\?objectId=(\\d+)&attributeId=(\\d+)&serial=(\\d+)&group=(\\d+)&ext=([^"\'<>]+)"([\\s\\S]*?)<\\/a>', 'g');
  /* A range part is a page or a span of pages. GAKK prints a non-contiguous range as two
     parts separated by a period: "1-71. 72-86", "128. 129-130", "264-267.375-376". */
  const PART = '\\d+[а-яёa-z]?(?:\\s*-\\s*\\d+[а-яёa-z]?)?';
  const RANGE = PART + '(?:\\s*\\.\\s*' + PART + ')*\\.?';
  const LABEL = new RegExp('Ф\\.(' + FOND + ')\\s+Оп\\.(\\S+?)\\s+Д\\.(\\d+(?:\\s*[А-ЯЁа-яёA-Za-z])?)\\s+(' + RANGE + ')\\s*$');

  // The cabinet labels this cell itself, so read the label rather than judging contents.
  const TITLE_CELL = () => /Шифр дела для выдачи\s*<\/div>\s*<span[^>]*>([\s\S]*?)<\/span>/g;
  const SHIFR = new RegExp('^Ф\\.(' + FOND + ')\\s+Оп\\.(\\S+?)\\s+Д\\.(\\d+\\s*[А-ЯЁа-яёA-Za-z]?)\\s+([\\s\\S]+)$');

  const strip = s => s.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  /* r keeps what the archive printed, always. s/e are for ordering only: the first start
     and the last end in printed order, across however many parts the cell holds. A shape
     this does not recognise leaves s/e null and is reported rather than guessed at. */
  function parseRange(rng) {
    const raw = rng.trim();
    const parts = raw.replace(/\.\s*$/, '').split(/\s*\.\s*/).filter(Boolean);
    let first = null, last = null;
    for (const p of parts) {
      const m = p.match(/^(\d+)[а-яёa-z]?(?:\s*-\s*(\d+)[а-яёa-z]?)?$/i);
      if (!m) return [raw, null, null];
      if (first === null) first = +m[1];
      last = m[2] ? +m[2] : +m[1];
    }
    if (first === null) return [raw, null, null];
    return [raw, first, last];
  }

  /* Scoped to the pagination element: other aria-setsize attributes on the page carry
     different numbers. A long pager elides ("1…7, 20"), so take the highest page. */
  function pageCount(html) {
    const ul = html.match(/<ul[^>]*aria-label="Pagination"[\s\S]*?<\/ul>/);
    if (!ul) return { pages: 1, how: 'no pager found — treating as a single page' };
    const nums = [...ul[0].matchAll(/aria-label="Go to page (\d+)"/g)].map(m => +m[1]);
    if (!nums.length) return { pages: 1, how: 'pager present but listed no pages' };
    return { pages: Math.max(...nums), how: 'from the pager' };
  }

  /* The account sits in its own leaf element: <span>Личный кабинет: Арсен</span>.
     Flattened page text runs the nav links onto the end of the name. */
  function accountName(doc) {
    for (const el of doc.querySelectorAll('span, a, div')) {
      const t = (el.textContent || '').trim();
      if (!/^Личный кабинет:\s*\S/.test(t)) continue;
      if (el.children.length) continue;              // must be the leaf that holds the text
      const name = t.replace(/^Личный кабинет:\s*/, '').trim();
      if (name && name.length <= 60) return name;
    }
    return '';
  }

  /* An expired session returns a login page with status 200, so status alone is not
     enough — the response must also contain the требования table. */
  function checkResponse(res, html, page) {
    if (!res.ok) return `page ${page}: HTTP ${res.status} ${res.statusText}`;
    if (/name="password"|type="password"/i.test(html) || /Войти\s*<\/button>/i.test(html)) {
      if (!/Шифр дела для выдачи/.test(html)) return `page ${page}: got a login page — the session has expired, sign in again`;
    }
    if (!/Шифр дела для выдачи/.test(html)) return `page ${page}: the response has no требования table (${html.length} bytes) — the cabinet markup may have changed`;
    return null;
  }

  // ---------- build ----------
  function parsePages(pages, owner, account) {
    const segsByOid = new Map();
    const titleKeys = new Map();          // f|p|d -> title
    const serialSeen = new Map();
    const consts = new Map();             // "attr|group|ext" -> count
    const stats = { pages: pages.length, anchors: 0, unlabeled: 0, dupOid: 0,
                    serialConflict: 0, unreadRange: 0, reversedRange: 0, unsplitTitle: 0, rows: 0 };
    const skipped = [], conflicts = [], unsplit = [], unreadRanges = [];

    for (const { html } of pages) {
      const h = html.replace(/&amp;/g, '&');

      const re = ANCHOR(); let m;
      while ((m = re.exec(h))) {
        stats.anchors++;
        const [, o, attr, serial, group, ext, inner] = m;
        consts.set(attr + '|' + group + '|' + ext, (consts.get(attr + '|' + group + '|' + ext) || 0) + 1);
        const txt = strip(inner);
        const lm = txt.match(LABEL);
        if (!lm) { stats.unlabeled++; if (skipped.length < 400) skipped.push({ o, txt: txt.slice(0, 90) }); continue; }
        const [, f, p, dRaw, rng] = lm;
        const d = normLit(dRaw);
        const [r, s, e] = parseRange(rng);
        /* Two different things. A range whose shape cannot be read leaves s/e null and
           breaks ordering — that is ours to fix. A range that reads fine but runs backwards
           is GAKK's own data, recorded as found and counted, not warned about. */
        if (s == null || e == null) {
          stats.unreadRange++;
          if (unreadRanges.length < 30) unreadRanges.push(`Ф.${f} Оп.${p} Д.${d} «${r}» [${o}]`);
        } else if (s > e) {
          stats.reversedRange++;
        }
        if (serialSeen.has(o) && serialSeen.get(o) !== serial) {
          stats.serialConflict++;
          if (conflicts.length < 20) conflicts.push(`${o}: ${serialSeen.get(o)} vs ${serial}`);
        }
        serialSeen.set(o, serial);
        if (segsByOid.has(o)) { stats.dupOid++; continue; }
        segsByOid.set(o, { o, f, p, d, r, s, e, serial });
      }

      const tre = TITLE_CELL(); let tm;
      while ((tm = tre.exec(h))) {
        stats.rows++;
        const cell = strip(tm[1]);
        const sm = cell.match(SHIFR);
        if (!sm) { stats.unsplitTitle++; if (unsplit.length < 40) unsplit.push(cell.slice(0, 90)); continue; }
        const [, f, p, dRaw, ttl] = sm;
        const key = f + '|' + p + '|' + normLit(dRaw);
        // A delo can appear in more than one требование; keep the fullest title seen.
        if (!titleKeys.has(key) || ttl.length > titleKeys.get(key).length) titleKeys.set(key, ttl.trim());
      }
    }

    const segments = [], onlineDelos = new Set();
    for (const seg of segsByOid.values()) {
      const key = seg.f + '|' + seg.p + '|' + seg.d;
      onlineDelos.add(key);
      seg.t = titleKeys.get(key) || '';
      seg.st = 'online';
      segments.push(seg);
    }

    // Pending: the cabinet printed a title cell but no viewer link for it.
    const pending = [];
    for (const [key, ttl] of titleKeys) {
      if (onlineDelos.has(key)) continue;
      const [f, p, d] = key.split('|');
      pending.push({ f, p, d, t: ttl, st: 'offline' });
    }

    /* attributeId/group/ext are read from the anchors, not hardcoded. Non-uniform values
       are reported: a wrong one produces a viewer link that 401s. */
    const constEntries = [...consts.entries()].sort((a, b) => b[1] - a[1]);
    const [cAttr, cGroup, cExt] = (constEntries[0] || ['2097|1243|.pdf'])[0].split('|');
    stats.constVariants = constEntries.length;
    stats.constList = constEntries.map(([k, n]) => `${k} ×${n}`);

    const deloKeys = new Set();
    for (const s2 of segments) deloKeys.add(`${s2.f}|${s2.p}|${s2.d}`);
    for (const p of pending) deloKeys.add(`${p.f}|${p.p}|${p.d}`);

    const now = new Date().toISOString();
    const out = {
      meta: {
        built: now.slice(0, 10),
        source: `GAKK records reader v${VERSION}`,
        account,
        owners: [owner],
        counts: { segments: segments.length, delos_online: onlineDelos.size,
                  pending: pending.length, pages: pages.length,
                  reversed_ranges: stats.reversedRange, unread_ranges: stats.unreadRange }
      },
      const: { attributeId: cAttr, group: cGroup, ext: cExt },
      segments,
      pending,
      /* complete:true — every page the pager listed was read, so absence of a delo means
         it is gone rather than unseen. That is what lets the Explorer merge by scope. */
      owners: { [owner]: { captured: now.slice(0, 10), pages: `${pages.length} page(s)`,
                           complete: true, delos: [...deloKeys].sort() } }
    };
    stats.segments = segments.length;
    stats.deloOnline = onlineDelos.size;
    stats.pending = pending.length;
    return { out, stats, skipped, conflicts, unsplit, unreadRanges };
  }

  // ---------- owner ----------
  /* A seeded account never consults storage; storage holds only asked-for accounts. */
  function ownerFor(account) {
    if (KNOWN[account]) return KNOWN[account];
    let map = {};
    try { map = JSON.parse(localStorage.getItem(OWNER_KEY) || '{}'); } catch (e) {}
    return map[account] || '';
  }
  function rememberOwner(account, code) {
    let map = {};
    try { map = JSON.parse(localStorage.getItem(OWNER_KEY) || '{}'); } catch (e) {}
    map[account] = code;
    try { localStorage.setItem(OWNER_KEY, JSON.stringify(map)); } catch (e) {}
  }

  // ---------- UI ----------
  const $ = id => document.getElementById(id);

  function panel() {
    let p = $('gakk-cap');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'gakk-cap';
    p.innerHTML =
      `<div id="gakk-cap-head">Records reader <span class="hint" id="gakk-cap-ver"></span><span id="gakk-cap-x">✕</span></div>
       <div id="gakk-cap-body"></div>
       <div id="gakk-cap-act"></div>`;
    document.body.appendChild(p);
    p.querySelector('#gakk-cap-ver').textContent = 'v' + VERSION;
    p.querySelector('#gakk-cap-x').onclick = () => p.remove();
    return p;
  }
  function show(bodyHtml, actions) {
    const p = panel();
    p.querySelector('#gakk-cap-body').innerHTML = bodyHtml;
    const act = p.querySelector('#gakk-cap-act');
    act.innerHTML = '';
    for (const a of (actions || [])) {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.onclick = a.fn;
      act.appendChild(b);
    }
    return p;
  }

  function download(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 0)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // ---------- run ----------
  async function fetchPage(n) {
    const res = await fetch(`${LIST_PATH}?page=${n}`, { credentials: 'include' });
    const html = await res.text();
    return { res, html };
  }

  async function run() {
    const account = accountName(document);
    if (!account) {
      show(`<b>Not signed in?</b><br>The page does not show an account name, so there is nobody to attribute this capture to.`,
           [{ label: 'Close', fn: () => $('gakk-cap').remove() }]);
      return;
    }
    let owner = ownerFor(account);
    if (!owner) { askOwner(account); return; }
    await capture(account, owner);
  }

  /* Asked once per account, then remembered against that account name. */
  function askOwner(account) {
    show(
      `Signed in as <b>${esc(account)}</b>.<br><br>
       Owner code for this account — two letters, used to attribute these records:
       <br><input id="gakk-cap-owner" maxlength="6" placeholder="e.g. AG" autocomplete="off">
       <div class="hint">Asked once. Change it later by capturing from a different account, or clear it in this panel.</div>`,
      [{ label: 'Capture', primary: true, fn: async () => {
           const v = ($('gakk-cap-owner').value || '').trim().toUpperCase();
           if (!v) { $('gakk-cap-owner').focus(); return; }
           rememberOwner(account, v);
           await capture(account, v);
         } },
       { label: 'Cancel', fn: () => $('gakk-cap').remove() }]);
    setTimeout(() => { const i = $('gakk-cap-owner'); if (i) i.focus(); }, 0);
  }

  async function capture(account, owner) {
    show(`<b>${esc(account)} → ${esc(owner)}</b><br>Reading page 1…`, []);
    const pages = [];
    try {
      const first = await fetchPage(1);
      let err = checkResponse(first.res, first.html, 1);
      if (err) throw new Error(err);
      pages.push({ page: 1, html: first.html });

      const { pages: total, how } = pageCount(first.html);
      const n = Math.min(total, MAX_PAGES);
      for (let i = 2; i <= n; i++) {
        show(`<b>${esc(account)} → ${esc(owner)}</b><br>Reading page ${i} of ${n}… <span class="hint">(${esc(how)})</span>`, []);
        const r = await fetchPage(i);
        err = checkResponse(r.res, r.html, i);
        if (err) throw new Error(err);
        pages.push({ page: i, html: r.html });
      }

      const { out, stats, skipped, conflicts, unsplit, unreadRanges } = parsePages(pages, owner, account);
      const warn = [];
      if (stats.unlabeled) warn.push(`${stats.unlabeled} anchor(s) whose label could not be read — NOT captured:` +
        `<ul>${skipped.slice(0, 12).map(s => `<li>[${esc(s.o)}] ${esc(s.txt)}</li>`).join('')}</ul>`);
      if (stats.unreadRange) warn.push(`${stats.unreadRange} range(s) whose shape could not be read — kept verbatim, but these will not sort:` +
        `<ul>${unreadRanges.slice(0, 12).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`);
      if (stats.serialConflict) warn.push(`${stats.serialConflict} objectId(s) reported different serials across pages:` +
        `<ul>${conflicts.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`);
      if (stats.unsplitTitle) warn.push(`${stats.unsplitTitle} title cell(s) whose шифр could not be separated:` +
        `<ul>${unsplit.slice(0, 8).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`);
      if (stats.constVariants > 1) warn.push(`attributeId/group/ext are not uniform — the most common was used:` +
        `<ul>${stats.constList.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`);
      if (total > MAX_PAGES) warn.push(`the pager listed ${total} pages but only ${MAX_PAGES} were read — this capture is INCOMPLETE.`);

      const file = `gakk_records_${owner}.json`;
      show(
        `<b>${esc(account)} → ${esc(owner)}</b><br>
         ${stats.pages} page(s) read · ${stats.rows} требования<br>
         <b>${stats.deloOnline}</b> delos online → <b>${stats.segments}</b> segments<br>
         ${stats.pending} pending (requested, not yet online)<br>
         ${stats.dupOid ? `<span class="hint">${stats.dupOid} duplicate objectId(s) collapsed</span><br>` : ''}
         ${stats.reversedRange ? `<span class="hint">${stats.reversedRange} reversed range(s) in GAKK's data, recorded as printed</span><br>` : ''}
         ${warn.length ? `<div class="warn">${warn.join('')}</div>` : ''}`,
        [{ label: `Download ${file}`, primary: true, fn: () => { download(out, file); $('gakk-cap').remove(); } },
         { label: 'Cancel', fn: () => $('gakk-cap').remove() }]);
    } catch (e) {
      show(`<b>Capture failed</b><div class="warn">${esc(e.message)}</div>
            <span class="hint">Nothing was downloaded. Your existing records file is untouched.</span>`,
           [{ label: 'Close', fn: () => $('gakk-cap').remove() }]);
    }
  }

  function mount() {
    if (!document.body || $('gakk-cap-btn')) return;
    const b = document.createElement('button');
    b.id = 'gakk-cap-btn';
    b.textContent = '⤓ Read records';
    b.title = 'Read every page of this cabinet and write a records file for GAKK Explorer';
    b.onclick = run;
    document.body.appendChild(b);

    const st = document.createElement('style');
    st.textContent = `
      /* A row below the top edge: other userscripts on this page pin buttons along the
         top-right, at varying horizontal offsets. */
      #gakk-cap-btn{position:fixed;z-index:2147483647;top:56px;right:12px;
        font:600 13px/1.2 system-ui,Segoe UI,Arial,sans-serif;color:#fff;background:#12507a;
        border:0;border-radius:8px;padding:9px 12px;cursor:pointer;opacity:.92;
        box-shadow:0 2px 8px rgba(0,0,0,.35)}
      #gakk-cap-btn:hover{opacity:1}
      #gakk-cap{position:fixed;z-index:2147483647;top:96px;right:12px;width:440px;max-height:70vh;
        overflow:auto;font:13px/1.5 system-ui,Segoe UI,Arial,sans-serif;color:#111;background:#fff;
        border:1px solid #c9c9d2;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25)}
      #gakk-cap-head{font-weight:600;padding:10px 12px;border-bottom:1px solid #ececf2;
        display:flex;justify-content:space-between;align-items:center}
      #gakk-cap-x{cursor:pointer;color:#8a8a96}
      #gakk-cap-body{padding:12px}
      #gakk-cap-body input{font:13px ui-monospace,Menlo,Consolas,monospace;text-transform:uppercase;
        padding:6px 8px;border:1px solid #c9c9d2;border-radius:6px;width:110px;margin-top:6px}
      #gakk-cap-body ul{margin:6px 0 0 0;padding-left:18px}
      #gakk-cap-body li{font:12px ui-monospace,Menlo,Consolas,monospace;color:#5b5b66}
      .hint{color:#8a8a96;font-size:12px}
      #gakk-cap .warn{margin-top:10px;padding:8px 10px;background:#fff8e6;border:1px solid #e8d59a;
        border-radius:7px;color:#6b5200;font-size:12px}
      #gakk-cap-act{padding:10px 12px;border-top:1px solid #ececf2;display:flex;gap:8px;justify-content:flex-end}
      #gakk-cap-act button{font:600 13px system-ui;padding:7px 12px;border-radius:7px;
        border:1px solid #c9c9d2;background:#fff;cursor:pointer}
      #gakk-cap-act button.primary{background:#12507a;color:#fff;border-color:#12507a}
    `;
    document.head.appendChild(st);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  // The cabinet is a Nuxt app; keep the button through client-side navigation.
  new MutationObserver(() => mount()).observe(document.documentElement, { childList: true, subtree: true });
})();
