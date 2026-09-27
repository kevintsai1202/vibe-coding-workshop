/*
 * tool.js — 貼上工具的邏輯
 *
 * 整份檔案：載入範本、整理 AI 回覆（去掉 ``` 框線與說明）、偵測不完整、沙箱預覽、下載
 * 功能插槽：讀 signin_基本版.html 的插槽標記，把學員貼上的函式換進去，組合成 signin.html
 * 範本清單來自 course-data.js 的 materials（type 為 HTML、有 saveAs 的項目）
 * 狀態存在 localStorage（vibe-tn-tool-v1）；主題沿用教學網站（vibe-tn-20261021-v1）
 */
(function () {
  'use strict';

  /** 課程資料 */
  const C = window.COURSE;
  /** 工具狀態的 localStorage key */
  const TOOL_KEY = 'vibe-tn-tool-v1';
  /** 教學網站狀態的 key（只用來讀寫主題） */
  const SITE_KEY = 'vibe-tn-20261021-v1';
  /** 素材路徑 */
  const MATERIAL_BASE = 'course-package/materials/';
  /** 功能插槽用的基本版與完成版 */
  const SLOT_BASE_FILE = 'signin_基本版.html';
  const SLOT_COMPLETE_FILE = 'signin_完成版.html';
  /** 插槽標記（與 scripts/build-templates.mjs 相同） */
  const SLOT_RE = /(\/\/ ===== 功能插槽 (\d)：(.+?) (\w+)（開始）=====\n)([\s\S]*?)(\/\/ ===== 功能插槽 \2：\3 \4（結束）=====)/g;
  /** AI 偷懶省略程式時常見的字句 */
  const LAZY_RE = /其餘(的)?(程式|程式碼|部分|內容|功能)?(維持|保持)?(不變|相同|省略)|(以下|中間)省略|\/\/\s*\.\.\.|<!--\s*\.\.\.|\.\.\.\s*(existing|rest of)/i;

  /** 是否被嵌在教學頁的彈窗裡（tool.html?embed=1） */
  const EMBED = new URLSearchParams(location.search).get('embed') === '1';

  /** 範本清單：[{ file, name, saveAs }] */
  const TEMPLATES = (C && C.materials || []).filter(m => m.type === 'HTML' && m.saveAs);

  /* ============================================================
   * 狀態
   * ============================================================ */

  /** 讀取工具狀態 */
  function loadState() {
    // wholeSource：輸入框內容的來源，'template:檔名' 表示剛載入的範本、'user' 表示學員貼上或修改過
    const def = { tab: 'whole', fileName: 'timer.html', whole: '', wholeSource: '', slots: { 1: '', 2: '', 3: '' } };
    try {
      const raw = JSON.parse(localStorage.getItem(TOOL_KEY));
      return raw ? Object.assign(def, raw, { slots: Object.assign(def.slots, raw.slots || {}) }) : def;
    } catch (e) {
      return def;
    }
  }
  /** 目前狀態 */
  const state = loadState();
  /** 寫入工具狀態 */
  function saveState() {
    try { localStorage.setItem(TOOL_KEY, JSON.stringify(state)); } catch (e) { /* 寫不進去就略過 */ }
  }

  /* ============================================================
   * 小工具
   * ============================================================ */

  const $ = id => document.getElementById(id);

  /** 建立元素 */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    children.flat(Infinity).forEach(c => { if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c))); });
    return node;
  }

  /** 顯示短暫提示 */
  function toast(msg) {
    const wrap = $('toastWrap');
    const t = el('div', { class: 'toast' }, msg);
    wrap.append(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1800);
  }

  /** 複製文字；Clipboard API 不能用時改用 textarea 備援 */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = el('textarea', { class: 'sr-only' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  /** 讀取素材檔 */
  async function fetchMaterial(file) {
    const res = await fetch(MATERIAL_BASE + encodeURIComponent(file));
    if (!res.ok) throw new Error(`讀不到 ${file}（${res.status}）`);
    return res.text();
  }

  /** 讓瀏覽器下載文字檔（UTF-8） */
  function downloadText(fileName, text) {
    const type = /\.html?$/i.test(fileName) ? 'text/html;charset=utf-8'
      : /\.md$/i.test(fileName) ? 'text/markdown;charset=utf-8'
      : /\.csv$/i.test(fileName) ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8';
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已下載 ${fileName}，請移到 AI實作 資料夾`);
  }

  /** 把 HTML 特殊字元轉成文字（用在 Markdown 純文字預覽） */
  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  /**
   * 整理 AI 的回覆：有 ``` 框線就取出框內程式（多個框時取最長的），去掉前後說明
   * @param {string} text 貼上的內容
   * @param {'html'|'js'} kind 期望的內容種類
   */
  function extractCode(text, kind) {
    const src = String(text).replace(/\r\n?/g, '\n');
    const blocks = [...src.matchAll(/```[\w-]*[ \t]*\n([\s\S]*?)```/g)].map(m => m[1]);
    // 沒有框線：原樣保留（只統一換行），範本檔載入後才能與原檔一字不差
    if (!blocks.length) return kind === 'js' ? src.trim() : src;
    const pick = kind === 'html' ? (blocks.find(b => /<html[\s>]/i.test(b)) || blocks.sort((a, b) => b.length - a.length)[0])
      : blocks.sort((a, b) => b.length - a.length)[0];
    return pick.trim();
  }

  /* ============================================================
   * 整份檔案
   * ============================================================ */

  /** 檢查整份 HTML 是否可能不完整，回傳提醒文字陣列 */
  function checkWhole(text, fileName) {
    const warns = [];
    if (!/\.html?$/i.test(fileName)) return warns;
    if (!/<\/html>\s*$/i.test(text)) warns.push('程式結尾沒有 </html>，AI 回傳的程式可能不完整。請要求它「回傳完整的程式，不要省略」。');
    if (LAZY_RE.test(text)) warns.push('程式裡有「其餘不變／省略」之類的字句，AI 可能省略了部分程式。請要求它回傳完整程式。');
    if (!/<meta[^>]+charset/i.test(text)) warns.push('缺少 <meta charset="utf-8">，打開檔案時中文可能變亂碼。');
    return warns;
  }

  /** 顯示或隱藏提醒 */
  function showWarn(box, warns) {
    box.replaceChildren(...warns.map(w => el('div', {}, '⚠ ' + w)));
    box.hidden = warns.length === 0;
  }

  /** 整理輸入框內容（去掉 ``` 框線）並寫回 */
  function tidyWhole() {
    const kind = /\.html?$/i.test($('fileName').value) ? 'html' : 'text';
    const cleaned = extractCode($('wholeText').value, kind);
    if (cleaned !== $('wholeText').value) $('wholeText').value = cleaned;
    state.whole = cleaned;
    state.fileName = $('fileName').value.trim() || 'timer.html';
    saveState();
    return cleaned;
  }

  /** 預覽整份檔案：HTML 直接執行（沙箱），其他檔案顯示純文字 */
  function previewWhole() {
    const text = tidyWhole();
    showWarn($('wholeWarn'), checkWhole(text, state.fileName));
    const frame = $('wholePreview');
    frame.setAttribute('srcdoc', /\.html?$/i.test(state.fileName) ? text
      : `<!doctype html><meta charset="utf-8"><pre style="white-space:pre-wrap;font:15px/1.6 system-ui,'Microsoft JhengHei',sans-serif;padding:12px">${escHtml(text)}</pre>`);
  }

  /** 載入選到的範本 */
  async function loadTemplate(file) {
    const tpl = TEMPLATES.find(t => t.file === file);
    if (!tpl) return;
    try {
      $('wholeText').value = await fetchMaterial(tpl.file);
      $('fileName').value = tpl.saveAs;
      $('tplSelect').value = tpl.file;
      tidyWhole();
      state.wholeSource = 'template:' + tpl.file;
      saveState();
      previewWhole();
      toast(`已載入 ${tpl.name}`);
    } catch (e) {
      toast(e.message);
    }
  }

  /** 綁定整份檔案分頁 */
  function setupWhole() {
    $('tplSelect').append(...TEMPLATES.map(t => el('option', { value: t.file }, `${t.name}（存成 ${t.saveAs}）`)));
    $('wholeText').value = state.whole;
    $('fileName').value = state.fileName;
    $('btnLoadTpl').addEventListener('click', () => loadTemplate($('tplSelect').value));
    $('btnCopyWhole').addEventListener('click', async () => {
      toast(await copyText($('wholeText').value) ? '已複製，貼到 ChatGPT 聊天' : '複製失敗，請手動選取');
    });
    $('btnPreviewWhole').addEventListener('click', previewWhole);
    $('btnDownloadWhole').addEventListener('click', () => {
      const text = tidyWhole();
      showWarn($('wholeWarn'), checkWhole(text, state.fileName));
      if (!text) { toast('內容是空的'); return; }
      downloadText(state.fileName, text);
    });
    $('btnClearWhole').addEventListener('click', () => {
      $('wholeText').value = '';
      tidyWhole();
      $('wholePreview').removeAttribute('srcdoc');
      showWarn($('wholeWarn'), []);
    });
    $('wholeText').addEventListener('input', () => { state.whole = $('wholeText').value; state.wholeSource = 'user'; saveState(); });
    $('fileName').addEventListener('change', () => { state.fileName = $('fileName').value.trim(); saveState(); });
  }

  /* ============================================================
   * 功能插槽
   * ============================================================ */

  /** 基本版內容與插槽定義 */
  let baseText = '';
  let slots = [];          // [{ n, title, fn }]
  let protectedFns = [];   // 基本版裡插槽以外的函式名稱（不可被重新定義）
  let completeSlots = {};  // 完成版各插槽的程式（救援用）

  /** 解析範本裡的插槽 */
  function parseSlots(text) {
    return [...text.matchAll(SLOT_RE)].map(m => ({ n: m[2], title: m[3], fn: m[4], body: m[5] }));
  }

  /** 取出某個功能卡提示詞（course-data.js 裡的 p-slot-N） */
  function slotPrompt(n) {
    for (const u of C.units) for (const s of u.sections) for (const b of s.blocks) if (b.type === 'prompt' && b.id === 'p-slot-' + n) return b.text;
    return '';
  }

  /**
   * 整理並檢查一個插槽的內容
   * @returns {{ code: string, warns: string[], ok: boolean }}
   */
  function cleanSlot(slot, raw) {
    let code = extractCode(raw || '', 'js');
    // 學員可能連標記一起貼上：只取標記之間
    const inner = new RegExp(`（開始）=====\\n([\\s\\S]*?)\\/\\/ ===== 功能插槽 ${slot.n}：`).exec(code);
    if (inner) code = inner[1].trim();
    // 去掉多包的 <script> 標籤
    code = code.replace(/^<script[^>]*>\s*/i, '').replace(/\s*<\/script>\s*$/i, '').trim();
    const warns = [];
    if (!code) return { code, warns, ok: false };
    if (!new RegExp(`function\\s+${slot.fn}\\s*\\(`).test(code)) warns.push(`找不到 function ${slot.fn}(…)，請確認 AI 寫的函式名稱是 ${slot.fn}。`);
    if (/<\/?script/i.test(code)) warns.push('程式裡有 <script> 或 </script>，貼進去會讓網頁壞掉，請請 AI 只回傳 JavaScript 函式。');
    const redefined = protectedFns.filter(f => new RegExp(`function\\s+${f}\\s*\\(`).test(code));
    if (redefined.length) warns.push(`程式重新定義了基本版已有的函式 ${redefined.map(f => f + '()').join('、')}，會蓋掉原本的功能，請刪掉那一段或請 AI 只回傳 ${slot.fn}。`);
    return { code, warns, ok: warns.length === 0 };
  }

  /** 組合：把通過檢查的插槽換進基本版；回傳組合結果 */
  function combine() {
    let allWarns = [];
    const out = baseText.replace(SLOT_RE, (all, start, n, title, fn, body, end) => {
      const slot = slots.find(s => s.n === n);
      const card = document.querySelector(`.slot-card[data-n="${n}"]`);
      const res = cleanSlot(slot, state.slots[n]);
      paintSlot(card, res);
      if (res.warns.length) allWarns = allWarns.concat(res.warns.map(w => `插槽 ${n}（${title}）：${w}`));
      return res.ok ? start + res.code + '\n' + end : all;
    });
    showWarn($('slotWarn'), allWarns);
    return out;
  }

  /** 更新插槽卡片的狀態文字與提醒 */
  function paintSlot(card, res) {
    if (!card) return;
    const status = card.querySelector('.slot-status');
    const warn = card.querySelector('.slot-warn');
    status.textContent = !res.code ? '尚未填寫（組合時使用空函式）' : res.ok ? '已填，組合時會放進去' : '有問題，這個插槽不會放進去';
    status.className = 'slot-status ' + (!res.code ? 'st-none' : res.ok ? 'st-ok' : 'st-no');
    warn.replaceChildren(...res.warns.map(w => el('div', {}, '⚠ ' + w)));
    warn.hidden = res.warns.length === 0;
  }

  /** 建立插槽卡片 */
  function renderSlots() {
    const list = $('slotList');
    list.replaceChildren(...slots.map(s => {
      const ta = el('textarea', { class: 'tool-text short', spellcheck: 'false', placeholder: `把 AI 寫的 function ${s.fn}(…) 貼在這裡` });
      ta.value = state.slots[s.n] || '';
      ta.addEventListener('input', () => { state.slots[s.n] = ta.value; saveState(); });
      const copyBtn = el('button', { class: 'btn btn-soft', type: 'button', 'data-copy-prompt': '' }, '複製功能卡提示詞');
      copyBtn.addEventListener('click', async () => {
        toast(await copyText(slotPrompt(s.n)) ? `已複製功能卡 ${s.n}，貼到 ChatGPT 聊天` : '複製失敗');
      });
      const fillBtn = el('button', { class: 'btn btn-ghost', type: 'button', 'data-fill-complete': '' }, '填入完成版（救援）');
      fillBtn.addEventListener('click', () => {
        ta.value = completeSlots[s.n] || '';
        state.slots[s.n] = ta.value;
        saveState();
        paintSlot(card, cleanSlot(s, ta.value));
      });
      const clearBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '清空');
      clearBtn.addEventListener('click', () => { ta.value = ''; state.slots[s.n] = ''; saveState(); paintSlot(card, cleanSlot(s, '')); });
      const card = el('div', { class: 'slot-card', 'data-n': s.n, 'data-fn': s.fn },
        el('div', { class: 'slot-head' },
          el('span', { class: 'slot-badge' }, '功能插槽 ' + s.n),
          el('span', { class: 'slot-title' }, s.title),
          el('code', {}, `function ${s.fn}(…)`)),
        el('div', { class: 'slot-status st-none' }, ''),
        ta,
        el('div', { class: 'slot-warn note note-warn', hidden: true }),
        el('div', { class: 'tool-actions' }, copyBtn, fillBtn, clearBtn));
      paintSlot(card, cleanSlot(s, ta.value));
      return card;
    }));
  }

  /** 載入基本版與完成版，建立插槽 */
  async function setupSlots() {
    $('btnCombine').addEventListener('click', () => { $('slotPreview').setAttribute('srcdoc', combine()); });
    $('btnDownloadSlots').addEventListener('click', () => downloadText('signin.html', combine()));
    $('btnClearSlots').addEventListener('click', () => {
      state.slots = { 1: '', 2: '', 3: '' };
      saveState();
      renderSlots();
      $('slotPreview').removeAttribute('srcdoc');
      showWarn($('slotWarn'), []);
    });
    try {
      baseText = (await fetchMaterial(SLOT_BASE_FILE)).replace(/\r\n?/g, '\n');
      const complete = (await fetchMaterial(SLOT_COMPLETE_FILE)).replace(/\r\n?/g, '\n');
      slots = parseSlots(baseText);
      parseSlots(complete).forEach(s => { completeSlots[s.n] = s.body; });
      const slotFns = slots.map(s => s.fn);
      protectedFns = [...baseText.matchAll(/^function (\w+)\s*\(/gm)].map(m => m[1]).filter(f => !slotFns.includes(f));
      renderSlots();
    } catch (e) {
      $('slotList').replaceChildren(el('p', {}, '讀不到報名簽到表範本：' + e.message + '（請用 npm run serve 或正式網址開啟本工具）'));
    }
  }

  /* ============================================================
   * 分頁與主題
   * ============================================================ */

  /** 切換分頁 */
  function showTab(tab) {
    state.tab = tab === 'slots' ? 'slots' : 'whole';
    saveState();
    document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === state.tab ? 'true' : 'false'));
    $('tab-whole').hidden = state.tab !== 'whole';
    $('tab-slots').hidden = state.tab !== 'slots';
  }

  /** 主題切換（寫回教學網站的狀態，兩邊一致） */
  function setupTheme() {
    const btn = $('themeToggle');
    const paint = () => { btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙'; };
    btn.addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') !== 'dark';
      if (dark) document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
      try {
        const s = JSON.parse(localStorage.getItem(SITE_KEY) || '{}');
        s.theme = dark ? 'dark' : 'light';
        localStorage.setItem(SITE_KEY, JSON.stringify(s));
      } catch (e) { /* 略過 */ }
      paint();
    });
    paint();
  }

  /**
   * 網址帶 ?load= 時載入範本；但輸入框已有學員貼上的內容就不覆蓋，只預先選好範本
   * （從教學頁再點一次同一個連結，不會把 AI 改好的程式蓋掉）
   */
  async function autoLoad(file) {
    const current = $('wholeText').value.trim();
    const fromTemplate = (state.wholeSource || '').startsWith('template:');
    if (!current || fromTemplate) {
      await loadTemplate(file);
      return;
    }
    $('tplSelect').value = file;
    toast('已保留你上次貼上的內容；要換回範本請按「載入範本」');
  }

  /** 進入點：網址可帶 ?load=範本檔名、?tab=slots、?embed=1 */
  async function init() {
    if (EMBED) {
      document.documentElement.classList.add('embed');
      // 在彈窗裡按 ESC：通知教學頁關閉彈窗
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') window.parent.postMessage({ type: 'vibe-tool-close' }, location.origin);
      });
    }
    setupTheme();
    setupWhole();
    document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    const params = new URLSearchParams(location.search);
    showTab(params.get('tab') || (params.get('load') ? 'whole' : state.tab));
    await setupSlots();
    if (params.get('load')) await autoLoad(params.get('load'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
