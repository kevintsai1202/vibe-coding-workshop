/*
 * tool.js — 貼上工具的邏輯
 *
 * 整份檔案：載入範本、整理 AI 回覆（去掉 ``` 框線與說明）、偵測不完整、沙箱預覽、下載
 * （功能插槽模式已於 2026-10 移除：下午的三個功能改由 Codex 直接在資料夾裡做）
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
    const def = { fileName: 'timer.html', whole: '', wholeSource: '' };   // 舊版存過的 tab／slots 欄位會一併被忽略
    try {
      const raw = JSON.parse(localStorage.getItem(TOOL_KEY));
      // 只取整份檔案需要的欄位；舊版存的 tab、slots 等欄位直接丟掉
      return raw ? { fileName: raw.fileName || def.fileName, whole: raw.whole || '', wholeSource: raw.wholeSource || '' } : def;
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
   * 主題
   * ============================================================ */

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

  /** 進入點：網址可帶 ?load=範本檔名、?embed=1 */
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
    const params = new URLSearchParams(location.search);
    if (params.get('load')) await autoLoad(params.get('load'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
