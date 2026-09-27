/*
 * app.js — 教學網站的渲染與互動
 *
 * 讀取 window.COURSE（course-data.js），渲染所有章節，並處理：
 *   任務勾選、課堂互動題、提示詞複製、素材預覽彈窗、側欄導覽與 scrollspy、
 *   深色模式、內容縮放、手機版側欄。狀態存在 localStorage。
 * 安全原則：課程內容與素材一律用 DOM API + textContent 建構，不用 innerHTML。
 */
(function () {
  'use strict';

  /** 課程資料（course-data.js 定義） */
  const C = window.COURSE;
  /** localStorage key；結構改版時遞增尾碼，不要沿用舊 key */
  const STORE_KEY = 'vibe-tn-20261021-v1';
  /** 素材檔案所在路徑（相對於 index.html） */
  const MATERIAL_BASE = 'course-package/materials/';
  /** 插圖所在路徑（muse-image 生成的 webp） */
  const ILLUSTRATION_BASE = 'assets/illustrations/';
  /** 手機版斷點 */
  const mql = window.matchMedia ? window.matchMedia('(max-width: 768px)') : { matches: false, addEventListener() {} };
  /** 縮放範圍 */
  const ZOOM_MIN = 0.9, ZOOM_MAX = 1.4, ZOOM_STEP = 0.1;
  /** 區塊種類的中文標籤 */
  const KIND_LABEL = { teach: '講授', lab: '實作', break: '休息', lunch: '午餐' };

  /* ============================================================
   * 狀態保存
   * ============================================================ */

  /** 預設狀態 */
  function defaultState() {
    return { tasks: {}, quiz: {}, theme: 'light', zoom: 1 };
  }

  /** localStorage 讀寫包裝；讀取失敗或資料毀損時回到預設狀態 */
  const store = {
    // 讀取狀態
    load() {
      try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY));
        return Object.assign(defaultState(), raw || {});
      } catch (e) {
        return defaultState();
      }
    },
    // 寫入狀態
    save(s) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* 私密模式等情況寫不進去就略過 */ }
    },
    // 清除狀態
    reset() {
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 略過 */ }
    }
  };

  /** 目前狀態（任務、互動題作答、主題、縮放） */
  let state = store.load();

  /* ============================================================
   * 索引：時段、互動題、素材、任務
   * ============================================================ */

  /** 時段 id → { unit, section } */
  const sectionIndex = {};
  /** 互動題 id → 題目 */
  const quizById = {};
  /** 素材名稱 → 素材 */
  const materialByName = {};
  /** 全部任務 */
  const allTasks = [];

  /** 建立各種查詢索引 */
  function buildIndexes() {
    C.units.forEach(u => {
      u.sections.forEach(s => { sectionIndex[s.id] = { unit: u, section: s }; });
      (u.tasks || []).forEach(t => allTasks.push(Object.assign({ unit: u.id }, t)));
    });
    (C.quiz || []).forEach(q => { quizById[q.id] = q; });
    (C.materials || []).forEach(m => { materialByName[m.name] = m; });
  }

  /* ============================================================
   * DOM 小工具
   * ============================================================ */

  /**
   * 建立元素：el('div', { class: 'x', onclick: fn }, 子節點或文字…)
   * 子元素可以是任意層數的巢狀陣列（例如 items.map(x => [dt, dd])），一律完全攤平
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /** 判斷連結網址是否安全（只允許 http(s)、站內錨點與相對路徑） */
  function safeHref(url) {
    const u = String(url).trim();
    if (/^https?:\/\//i.test(u) || u.startsWith('#')) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // 其他協定（javascript: 等）一律拒絕
    return u;
  }

  /** 建立連結元素；外部連結開新分頁 */
  function linkEl(text, url) {
    const href = safeHref(url);
    if (!href) return document.createTextNode(text);
    const newTab = /^https?:\/\//i.test(href) || href.startsWith('tool.html');
    return el('a', { href, target: newTab ? '_blank' : null, rel: newTab ? 'noopener' : null }, text);
  }

  /**
   * 行內 Markdown：**粗體**、`程式碼`、[文字](網址)、<網址>
   * 回傳 DocumentFragment，全部用 textContent，不會執行內容中的 HTML
   */
  function inlineMarkdown(str) {
    const frag = document.createDocumentFragment();
    const text = String(str == null ? '' : str);
    const re = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\[[^\]]+\]\([^)\s]+\))|(<https?:\/\/[^>\s]+>)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const tok = m[0];
      if (m[1]) frag.append(el('code', {}, tok.slice(1, -1)));
      else if (m[2]) frag.append(el('strong', {}, inlineMarkdown(tok.slice(2, -2))));
      else if (m[3]) {
        const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
        frag.append(linkEl(mm[1], mm[2]));
      } else if (m[4]) {
        const url = tok.slice(1, -1);
        frag.append(linkEl(url, url));
      }
      last = m.index + tok.length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  /** 去掉 UTF-8 BOM */
  function stripBom(text) {
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  }

  /** 把一列 Markdown 表格切成儲存格 */
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim());
  }

  /**
   * 區塊 Markdown 渲染（素材預覽用）
   * 支援：標題、段落、清單（含 [ ] 勾選框）、程式碼區塊、表格、引言、分隔線
   */
  function renderMarkdown(src) {
    const frag = document.createDocumentFragment();
    const lines = stripBom(String(src)).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const isListItem = l => /^\s*([-*]|\d+\.)\s+/.test(l);
    const isBlockStart = l => /^(#{1,6})\s/.test(l) || /^```/.test(l) || /^>\s?/.test(l) || isListItem(l) || /^\s*(-{3,}|\*{3,})\s*$/.test(l) || /^\s*\|/.test(l);

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // 程式碼區塊
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        frag.append(el('pre', { class: 'code-block' }, el('code', {}, buf.join('\n'))));
        continue;
      }
      // 標題
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        frag.append(el('h' + h[1].length, {}, inlineMarkdown(h[2])));
        i++;
        continue;
      }
      // 分隔線
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { frag.append(el('hr')); i++; continue; }
      // 表格
      if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        frag.append(tableEl(head, rows));
        continue;
      }
      // 引言
      if (/^>\s?/.test(line)) {
        const bq = el('blockquote');
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          const t = lines[i].replace(/^>\s?/, '');
          if (t.trim()) bq.append(el('p', {}, inlineMarkdown(t)));
          i++;
        }
        frag.append(bq);
        continue;
      }
      // 清單
      if (isListItem(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length && isListItem(lines[i])) {
          const indent = /^(\s*)/.exec(lines[i])[1].length;
          let t = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
          const li = el('li', { class: indent >= 2 ? 'nested' : null });
          const cb = /^\[( |x|X)\]\s+/.exec(t);
          if (cb) {
            li.classList.add('check-item');
            li.append(el('span', { class: 'check-box', 'aria-hidden': 'true' }, cb[1] === ' ' ? '☐' : '☑'));
            t = t.slice(cb[0].length);
          }
          li.append(inlineMarkdown(t));
          list.append(li);
          i++;
        }
        frag.append(list);
        continue;
      }
      // 段落：連續非空白行，行與行之間保留換行
      const p = el('p');
      let first = true;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        if (!first) p.append(el('br'));
        p.append(inlineMarkdown(lines[i].trim()));
        first = false;
        i++;
      }
      if (first) { // 防呆：無法歸類的行直接當段落，避免無窮迴圈
        p.append(inlineMarkdown(lines[i].trim()));
        i++;
      }
      frag.append(p);
    }
    return frag;
  }

  /** 解析 CSV（支援雙引號與跳脫），回傳二維陣列 */
  function parseCsv(src) {
    const text = stripBom(String(src)).replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c !== ''));
  }

  /** 建立表格元素（外層包一層可橫向捲動的容器） */
  function tableEl(head, rows) {
    const table = el('table', { class: 't' });
    if (head && head.length) table.append(el('thead', {}, el('tr', {}, head.map(hc => el('th', {}, inlineMarkdown(hc))))));
    table.append(el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => el('td', {}, inlineMarkdown(c)))))));
    return el('div', { class: 'table-wrap' }, table);
  }

  /** 顯示短暫提示訊息 */
  function showToast(msg) {
    const wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    const t = el('div', { class: 'toast' }, msg);
    wrap.append(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1800);
  }

  /** 複製文字到剪貼簿；不支援 Clipboard API 時改用 textarea 備援 */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = el('textarea', { class: 'sr-only', readonly: true });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  /** 素材檔案網址（檔名含中文，需編碼） */
  function materialUrl(m) {
    return MATERIAL_BASE + encodeURIComponent(m.file);
  }

  /**
   * 插圖：figure + img（延遲載入）＋ 圖說
   * 圖片載入失敗時隱藏整個 figure，不留破圖
   * @param {{name: string, alt?: string, caption?: string}} img
   * @param {string} cls 額外樣式（hero / diagram / cover）
   */
  function renderFigure(img, cls) {
    if (!img || !img.name) return null;
    const pic = el('img', {
      src: ILLUSTRATION_BASE + encodeURIComponent(img.name),
      alt: img.alt || '', loading: cls === 'cover' ? 'eager' : 'lazy', decoding: 'async',
      width: '1600', height: '914'
    });
    const fig = el('figure', { class: 'figure figure-' + (cls || 'diagram') }, pic,
      img.caption ? el('figcaption', {}, inlineMarkdown(img.caption)) : null);
    pic.addEventListener('error', () => { fig.hidden = true; });
    return fig;
  }

  /** 取出單元中已完成（ready）的 hero 插圖 */
  function unitHeroImage(u) {
    return (u.illustrations || []).find(i => i.kind === 'hero' && i.status === 'ready') || null;
  }

  /* ============================================================
   * 章節渲染
   * ============================================================ */

  /** 章節外框：帶 scrollspy 標記 */
  function chapter(id, eyebrow, title, ...children) {
    return el('section', { class: 'chapter', id, 'data-spy': id },
      eyebrow ? el('div', { class: 'eyebrow' }, eyebrow) : null,
      title ? el('h2', { class: 'chapter-title' }, title) : null,
      children);
  }

  /** 課程總覽：課名、基本資訊、課程目標、今天帶走的成果 */
  function renderOverview() {
    const m = C.meta;
    const info = [
      ['日期', m.date],
      ['時間', m.time],
      ['地點', m.location],
      ['講師', m.instructor],
      ['實作工具', m.tool],
      ['適合對象', m.audience],
      ['受訓證明', m.completion]
    ];
    const kv = el('dl', { class: 'info-grid' }, info.map(([k, v]) => [
      el('dt', {}, k),
      el('dd', {}, inlineMarkdown(v), k === '地點' && m.mapUrl ? [' ', linkEl('地圖 ↗', m.mapUrl)] : null)
    ]));
    const deliver = el('div', { class: 'deliver-grid' }, m.deliverables.map(([when, what, why], idx) =>
      el('div', { class: 'deliver-card' },
        el('div', { class: 'deliver-step' }, String(idx + 1).padStart(2, '0')),
        el('div', { class: 'deliver-when' }, when),
        el('div', { class: 'deliver-what' }, inlineMarkdown(what)),
        el('div', { class: 'deliver-why' }, why))));
    return el('section', { class: 'chapter hero-chapter', id: 'overview', 'data-spy': 'overview' },
      el('div', { class: 'course-hero' },
        renderFigure(m.cover, 'cover'),
        el('div', { class: 'eyebrow' }, m.organizer),
        el('h1', {}, m.title),
        el('p', { class: 'lead' }, m.subtitle),
        kv),
      el('h3', { class: 'sub-title' }, '今天會帶走的三樣成果'),
      deliver,
      el('h3', { class: 'sub-title' }, '課程目標'),
      el('ul', { class: 'goal-list' }, m.objectives.map(o => el('li', {}, inlineMarkdown(o)))),
      el('div', { class: 'instructor-card' },
        el('div', { class: 'instructor-name' }, '講師 ' + m.instructor),
        el('div', { class: 'instructor-bio' }, m.instructorBio)));
  }

  /** 全天時程：比例時間軸 + 時程表 */
  function renderSchedule() {
    const bar = el('div', { class: 'timeline', 'aria-hidden': 'true' }, C.schedule.map(r =>
      el('div', { class: 'tl-seg tl-' + r.kind, style: 'flex-grow:' + r.minutes, title: r.time + ' ' + r.label },
        r.minutes >= 20 ? el('span', {}, r.time.split('–')[0]) : null)));
    const legend = el('div', { class: 'tl-legend' }, ['teach', 'lab', 'break', 'lunch'].map(k =>
      el('span', { class: 'tl-key' }, el('i', { class: 'tl-dot tl-' + k }), KIND_LABEL[k])));
    const rows = C.schedule.map(r => {
      const label = r.ref ? el('a', { href: '#' + r.ref }, r.label) : r.label;
      return el('tr', { class: 'row-' + r.kind },
        el('td', { class: 'nowrap' }, r.time),
        el('td', { class: 'num' }, r.minutes + ' 分'),
        el('td', {}, label),
        el('td', {}, el('span', { class: 'kind-badge kind-' + r.kind }, KIND_LABEL[r.kind])));
    });
    const teachMinutes = C.schedule.filter(r => r.kind !== 'lunch').reduce((s, r) => s + r.minutes, 0);
    const labMinutes = C.schedule.filter(r => r.kind === 'lab').reduce((s, r) => s + r.minutes, 0);
    const table = el('div', { class: 'table-wrap' }, el('table', { class: 't schedule-table' },
      el('thead', {}, el('tr', {}, el('th', {}, '時間'), el('th', {}, '時長'), el('th', {}, '內容'), el('th', {}, '類型'))),
      el('tbody', {}, rows)));
    return chapter('schedule', '全天時程', '10/21（三）09:30～16:30',
      el('p', { class: 'lead' }, `上課 ${teachMinutes} 分鐘（含休息），其中動手實作 ${labMinutes} 分鐘；12:00～13:00 午餐。`),
      bar, legend, table);
  }

  /** 共用案例：情境、人物、要做的東西、資料表、規則 */
  function renderSharedCase() {
    const sc = C.sharedCase;
    const tables = el('div', { class: 'schema-grid' }, sc.tables.map(t =>
      el('div', { class: 'schema-card' },
        el('div', { class: 'schema-name' }, el('code', {}, t.name), ' ', t.label),
        el('table', { class: 't compact' },
          el('thead', {}, el('tr', {}, el('th', {}, '欄位'), el('th', {}, '中文'), el('th', {}, '範例'))),
          el('tbody', {}, t.columns.map(([f, l, e]) => el('tr', {}, el('td', {}, el('code', {}, f)), el('td', {}, l), el('td', {}, e))))))));
    return chapter('case', '共用案例', sc.title,
      el('p', { class: 'lead' }, inlineMarkdown(sc.intro)),
      renderFigure(sc.image, 'hero'),
      el('h3', { class: 'sub-title' }, '現在的麻煩'),
      el('ul', { class: 'plain-list' }, sc.painPoints.map(p => el('li', {}, p))),
      el('h3', { class: 'sub-title' }, '人物'),
      tableEl(['人物', '角色', '在課程中的用途'], sc.people),
      el('h3', { class: 'sub-title' }, '今天要做出的 signin.html'),
      el('ul', { class: 'goal-list' }, sc.features.map(f => el('li', {}, f))),
      el('h3', { class: 'sub-title' }, '兩張資料表'),
      tables,
      el('h3', { class: 'sub-title' }, '業務規則（實作演練 2 的測試重點）'),
      tableEl(['編號', '規則'], sc.rules),
      el('div', { class: 'note' }, el('strong', {}, '這次不做：'), sc.notDoing));
  }

  /** 課前準備：準備項目、資料安全、當天的資料夾結構 */
  function renderPrep() {
    const p = C.prep;
    return chapter('prep', '課前準備', '上課前請先完成',
      el('dl', { class: 'info-grid' }, p.items.map(([k, v]) => [el('dt', {}, k), el('dd', {}, inlineMarkdown(v))])),
      el('div', { class: 'note note-warn' }, el('strong', {}, '資料安全：'), p.safety),
      el('h3', { class: 'sub-title' }, '當天會建立的資料夾'),
      el('pre', { class: 'code-block' }, el('code', {}, p.folderTree)));
  }

  /** 單元：大數字標題、簡章大綱、學習目標，接著各時段 */
  function renderUnit(u) {
    const tasks = u.tasks || [];
    const hero = el('div', { class: 'unit-hero' },
      el('div', { class: 'unit-numeral', 'aria-hidden': 'true' }, String(u.n).padStart(2, '0')),
      el('div', { class: 'unit-hero-meta' },
        el('div', { class: 'eyebrow' }, `${u.time} · ${u.minutes} 分${u.note ? '（' + u.note + '）' : ''}`),
        el('h2', { class: 'chapter-title' }, u.title),
        tasks.length ? el('span', { class: 'progress-pill', 'data-unit-pill': u.id }, '') : null));
    const brochure = el('div', { class: 'brochure-box' },
      el('div', { class: 'box-label' }, '簡章大綱'),
      el('ul', { class: 'dot-list' }, u.brochure.map(b => el('li', {}, b))));
    const goals = el('div', { class: 'goals-box' },
      el('div', { class: 'box-label' }, '學完這個單元，你能夠'),
      el('ul', { class: 'goal-list' }, u.goals.map(g => el('li', {}, inlineMarkdown(g)))));
    const heroImg = unitHeroImage(u);
    const root = el('section', { class: 'chapter unit-chapter', id: u.id, 'data-spy': u.id },
      hero, heroImg ? renderFigure(heroImg, 'hero') : null, el('div', { class: 'unit-intro' }, brochure, goals));
    u.sections.forEach(s => root.append(renderSection(u, s)));
    return root;
  }

  /** 時段：標頭（時間、類型、時長）、內容區塊、該時段的任務 */
  function renderSection(u, s) {
    const head = el('header', { class: 'seg-head' },
      el('div', { class: 'seg-meta' },
        el('span', { class: 'time-chip' }, s.time),
        el('span', { class: 'kind-badge kind-' + s.kind }, KIND_LABEL[s.kind]),
        el('span', { class: 'seg-min' }, s.minutes + ' 分')),
      el('h3', { class: 'seg-title' }, s.title));
    const body = el('div', { class: 'seg-body' }, s.blocks.map(b => renderBlock(b)));
    const tasks = (u.tasks || []).filter(t => t.section === s.id);
    if (tasks.length) {
      body.append(el('div', { class: 'task-box' },
        el('div', { class: 'box-label' }, '任務清單（點一下打勾，進度會記住）'),
        renderTaskList(tasks)));
    }
    return el('article', { class: 'seg seg-' + s.kind, id: s.id, 'data-spy': s.id }, head, body);
  }

  /** 依型別渲染一個內容區塊 */
  function renderBlock(b) {
    switch (b.type) {
      case 'text': return el('p', {}, inlineMarkdown(b.body));
      case 'heading': return el('h4', { class: 'block-heading' }, b.text);
      case 'list': {
        if (b.check) return el('ul', { class: 'check-list' }, b.items.map(it => el('li', {}, el('span', { class: 'check-box', 'aria-hidden': 'true' }, '☐'), inlineMarkdown(it))));
        return el(b.ordered ? 'ol' : 'ul', { class: b.ordered ? 'num-list' : 'dot-list' }, b.items.map(it => el('li', {}, inlineMarkdown(it))));
      }
      case 'table': return tableEl(b.head, b.rows);
      case 'code': return el('pre', { class: 'code-block' }, el('code', {}, b.text));
      case 'prompt': return renderPrompt(b);
      case 'note': return el('div', { class: 'note' + (b.tone ? ' note-' + b.tone : '') }, inlineMarkdown(b.body));
      case 'quiz': return renderQuizItem(quizById[b.id]);
      case 'materials': return renderMaterialRows(b.names.map(n => materialByName[n]).filter(Boolean));
      case 'image': return renderFigure(b, 'diagram');
      default: return el('p', { class: 'muted' }, '（不支援的區塊：' + b.type + '）');
    }
  }

  /** 提示詞卡片：標題、說明、內容與複製按鈕 */
  function renderPrompt(p) {
    const btn = el('button', { class: 'prompt-copy-btn', type: 'button', 'aria-label': '複製提示詞：' + p.title }, '複製');
    btn.addEventListener('click', async () => {
      const ok = await copyText(p.text);
      if (ok) {
        btn.classList.add('ok');
        btn.textContent = '已複製';
        showToast('已複製「' + p.title + '」，貼到 ChatGPT 桌面版');
        setTimeout(() => { btn.classList.remove('ok'); btn.textContent = '複製'; }, 1800);
      } else {
        showToast('複製失敗，請手動選取文字複製');
      }
    });
    return el('div', { class: 'prompt-card', id: p.id },
      el('div', { class: 'prompt-card-head' },
        el('div', {},
          el('span', { class: 'prompt-badge' }, 'PROMPT'),
          el('span', { class: 'prompt-card-title' }, p.title),
          p.note ? el('div', { class: 'prompt-card-note' }, p.note) : null),
        btn),
      el('pre', { class: 'prompt-text' }, p.text));
  }

  /** 任務清單：點一下切換完成狀態 */
  function renderTaskList(tasks) {
    return el('ul', { class: 'task-list' }, tasks.map(t => {
      const done = !!state.tasks[t.id];
      const li = el('li', {
        class: 'task-item' + (done ? ' done' : ''), 'data-task-id': t.id,
        role: 'checkbox', 'aria-checked': done ? 'true' : 'false', tabindex: '0'
      },
        el('span', { class: 'task-checkbox', 'aria-hidden': 'true' }, '✓'),
        el('span', { class: 'task-label' }, inlineMarkdown(t.label)));
      li.addEventListener('click', () => toggleTask(t.id));
      li.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleTask(t.id); } });
      return li;
    }));
  }

  /** 素材列：類型標籤、名稱、說明、預覽與下載按鈕 */
  function renderMaterialRows(items) {
    return el('div', { class: 'materials' }, items.map(m => {
      const url = materialUrl(m);
      const isTemplate = m.type === 'HTML';
      const preview = el('button', { class: 'btn btn-soft', type: 'button' }, isTemplate ? '在貼上工具開啟' : '預覽');
      // HTML 範本要執行才看得到效果，交給貼上工具（沙箱預覽）；其他素材用彈窗格式化顯示
      preview.addEventListener('click', () => isTemplate
        ? openTool('load=' + encodeURIComponent(m.file))
        : openMaterial(m));
      return el('div', { class: 'material-row' },
        el('span', { class: 'material-tag' }, m.type),
        el('div', { class: 'material-main' },
          el('div', { class: 'material-name' }, m.name),
          m.desc ? el('div', { class: 'material-desc' }, m.desc) : null),
        el('div', { class: 'material-actions' },
          preview,
          el('a', { class: 'btn', href: url, download: m.downloadAs || m.saveAs || m.file }, '下載')));
    }));
  }

  /** 課堂互動題：選項、作答後的回饋與解說 */
  function renderQuizItem(q) {
    if (!q) return null;
    const idx = C.quiz.indexOf(q) + 1;
    const box = el('div', { class: 'quiz-card', id: 'quiz-' + q.id, 'data-quiz-id': q.id });
    box.append(el('div', { class: 'quiz-head' },
      el('span', { class: 'quiz-badge' }, '課堂互動題 ' + idx),
      q.answer === null ? el('span', { class: 'quiz-type' }, '調查題・沒有標準答案') : null));
    box.append(el('div', { class: 'quiz-q' }, inlineMarkdown(q.q)));
    const opts = el('div', { class: 'quiz-options', role: 'group', 'aria-label': '選項' });
    q.options.forEach((o, i) => {
      const b = el('button', { class: 'quiz-opt', type: 'button', 'data-index': String(i) },
        el('span', { class: 'quiz-letter' }, String.fromCharCode(65 + i)), el('span', {}, inlineMarkdown(o)));
      b.addEventListener('click', () => answerQuiz(q.id, i));
      opts.append(b);
    });
    box.append(opts);
    box.append(el('div', { class: 'quiz-feedback', 'aria-live': 'polite' }));
    paintQuiz(box, q);
    return box;
  }

  /** 依作答狀態更新互動題外觀 */
  function paintQuiz(box, q) {
    const chosen = state.quiz[q.id];
    const answered = chosen !== undefined && chosen !== null;
    box.classList.toggle('answered', answered);
    box.querySelectorAll('.quiz-opt').forEach(b => {
      const i = Number(b.dataset.index);
      b.disabled = answered;
      b.classList.toggle('chosen', answered && i === chosen);
      b.classList.toggle('correct', answered && q.answer !== null && i === q.answer);
      b.classList.toggle('wrong', answered && q.answer !== null && i === chosen && i !== q.answer);
    });
    const fb = box.querySelector('.quiz-feedback');
    fb.replaceChildren();
    if (!answered) return;
    let verdict, cls;
    if (q.answer === null) { verdict = '已記錄你的選擇'; cls = 'fb-survey'; }
    else if (chosen === q.answer) { verdict = '答對了！'; cls = 'fb-ok'; }
    else { verdict = '再想想，正確答案是 ' + String.fromCharCode(65 + q.answer); cls = 'fb-no'; }
    const retry = el('button', { class: 'btn btn-ghost', type: 'button' }, '重新作答');
    retry.addEventListener('click', () => answerQuiz(q.id, null));
    fb.className = 'quiz-feedback ' + cls;
    fb.append(el('div', { class: 'fb-verdict' }, verdict), el('div', { class: 'fb-explain' }, inlineMarkdown(q.explain)), retry);
  }

  /** 課堂素材總覽 */
  function renderMaterialsChapter() {
    return chapter('materials', '課堂素材', '全部素材一次下載',
      el('p', { class: 'lead' }, '每個素材都可以先預覽再下載。下載後放進自己的 AI實作 資料夾，再讓 AI 讀取。'),
      renderMaterialRows(C.materials));
  }

  /** 互動題回顧：每題的作答狀態與回到該段的連結 */
  function renderQuizReview() {
    const list = el('ol', { class: 'review-list', id: 'reviewList' });
    const resetBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '互動題全部重新作答');
    resetBtn.addEventListener('click', () => {
      state.quiz = {};
      store.save(state);
      document.querySelectorAll('.quiz-card').forEach(box => paintQuiz(box, quizById[box.dataset.quizId]));
      updateProgress();
      showToast('互動題已清除');
    });
    return chapter('quiz-review', '互動題回顧', '課堂互動題（不計分）',
      el('p', { class: 'lead' }, '課堂上講完一段就作答一題，點選後立刻看到解說。答錯沒關係，點「回到該段」再讀一次。作答只存在你自己的瀏覽器。'),
      list, resetBtn);
  }

  /** 更新互動題回顧清單 */
  function paintQuizReview() {
    const list = document.getElementById('reviewList');
    if (!list) return;
    list.replaceChildren(...C.quiz.map(q => {
      const chosen = state.quiz[q.id];
      const answered = chosen !== undefined && chosen !== null;
      let status = '未作答', cls = 'st-none';
      if (answered && q.answer === null) { status = '已作答'; cls = 'st-survey'; }
      else if (answered && chosen === q.answer) { status = '答對'; cls = 'st-ok'; }
      else if (answered) { status = '再想想'; cls = 'st-no'; }
      const where = sectionIndex[q.section];
      return el('li', { class: 'review-item' },
        el('span', { class: 'review-status ' + cls }, status),
        el('span', { class: 'review-q' }, inlineMarkdown(q.q)),
        el('a', { class: 'review-link', href: '#quiz-' + q.id }, where ? '回到該段 →' : '前往 →'));
    }));
  }

  /** 常見狀況 */
  function renderFaq() {
    return chapter('faq', '常見狀況', '卡住時先看這裡',
      tableEl(['狀況', '怎麼辦'], C.faq));
  }

  /* ============================================================
   * 側欄與進度
   * ============================================================ */

  /** 側欄導覽：固定章節 + 三單元的各時段 */
  function renderSidebar() {
    document.getElementById('brandMeta').textContent = '10/21（三）09:30～16:30';
    const nav = document.getElementById('nav');
    const link = (target, label, cls, extra) => el('a', { class: 'nav-link ' + (cls || ''), href: '#' + target, 'data-target': target }, label, extra || null);
    const items = [
      link('overview', '課程總覽'),
      link('schedule', '全天時程'),
      link('case', '共用案例'),
      link('prep', '課前準備'),
      el('a', { class: 'nav-link nav-tool', href: 'tool.html', target: '_blank', rel: 'noopener' }, '🛠 貼上工具')
    ];
    C.units.forEach(u => {
      items.push(el('div', { class: 'nav-group' },
        link(u.id, u.short, 'nav-unit', el('span', { class: 'nav-pill', 'data-nav-pill': u.id })),
        el('div', { class: 'nav-sub' }, u.sections.map(s =>
          link(s.id, [el('span', { class: 'nav-time' }, s.time.split('–')[0]), el('span', { class: 'nav-sub-title' }, s.title)], 'nav-seg' + (s.kind === 'lab' ? ' is-lab' : ''))))));
    });
    items.push(link('materials', '課堂素材'), link('quiz-review', '互動題回顧'), link('faq', '常見狀況'));
    nav.replaceChildren(...items);
    nav.addEventListener('click', e => {
      if (e.target.closest('a') && mql.matches) closeSidebar();
    });
  }

  /** 更新側欄進度、單元進度膠囊、互動題回顧 */
  function updateProgress() {
    const doneCount = allTasks.filter(t => state.tasks[t.id]).length;
    const quizCount = C.quiz.filter(q => state.quiz[q.id] !== undefined && state.quiz[q.id] !== null).length;
    const pct = allTasks.length ? Math.round(doneCount / allTasks.length * 100) : 0;
    const wrap = document.getElementById('navProgress');
    const reset = el('button', { class: 'link-btn', type: 'button' }, '清除我的進度');
    reset.addEventListener('click', () => {
      if (!window.confirm('要清除所有任務勾選與互動題作答嗎？')) return;
      state.tasks = {};
      state.quiz = {};
      store.save(state);
      document.querySelectorAll('.task-item').forEach(li => { li.classList.remove('done'); li.setAttribute('aria-checked', 'false'); });
      document.querySelectorAll('.quiz-card').forEach(box => paintQuiz(box, quizById[box.dataset.quizId]));
      updateProgress();
      showToast('進度已清除');
    });
    wrap.replaceChildren(
      el('div', { class: 'np-row' }, el('span', {}, '任務'), el('span', { class: 'np-num' }, `${doneCount} / ${allTasks.length}`)),
      el('div', { class: 'np-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': '任務完成度' },
        el('div', { class: 'np-fill', style: 'width:' + pct + '%' })),
      el('div', { class: 'np-row' }, el('span', {}, '互動題'), el('span', { class: 'np-num' }, `${quizCount} / ${C.quiz.length}`)),
      reset);
    C.units.forEach(u => {
      const ts = u.tasks || [];
      const d = ts.filter(t => state.tasks[t.id]).length;
      const text = `任務 ${d} / ${ts.length}`;
      document.querySelectorAll(`[data-unit-pill="${u.id}"]`).forEach(p => { p.textContent = text; p.classList.toggle('complete', d === ts.length && ts.length > 0); });
      document.querySelectorAll(`[data-nav-pill="${u.id}"]`).forEach(p => { p.textContent = `${d}/${ts.length}`; p.classList.toggle('complete', d === ts.length && ts.length > 0); });
    });
    paintQuizReview();
  }

  /* ============================================================
   * 互動行為
   * ============================================================ */

  /** 切換任務完成狀態 */
  function toggleTask(id) {
    if (state.tasks[id]) delete state.tasks[id];
    else state.tasks[id] = true;
    store.save(state);
    document.querySelectorAll(`[data-task-id="${id}"]`).forEach(li => {
      li.classList.toggle('done', !!state.tasks[id]);
      li.setAttribute('aria-checked', state.tasks[id] ? 'true' : 'false');
    });
    updateProgress();
  }

  /** 作答互動題；index 為 null 表示清除重答 */
  function answerQuiz(id, index) {
    if (index === null) delete state.quiz[id];
    else state.quiz[id] = index;
    store.save(state);
    const q = quizById[id];
    document.querySelectorAll(`.quiz-card[data-quiz-id="${id}"]`).forEach(box => paintQuiz(box, q));
    updateProgress();
  }

  /** 目前彈窗素材的原始文字（「複製全文」用） */
  let modalRawText = '';

  /** 開啟素材預覽彈窗：md 格式化、csv 轉表格 */
  async function openMaterial(m) {
    modalRawText = '';
    const bd = document.getElementById('modalBackdrop');
    const content = document.getElementById('modalContent');
    const dl = document.getElementById('modalDownload');
    document.getElementById('modalTitle').textContent = m.name;
    dl.href = materialUrl(m);
    dl.setAttribute('download', m.downloadAs || m.saveAs || m.file);
    content.replaceChildren(el('p', { class: 'muted' }, '載入中…'));
    bd.hidden = false;
    document.body.classList.add('modal-open');
    document.getElementById('modalClose').focus();
    try {
      const res = await fetch(materialUrl(m));
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      modalRawText = text;
      if (m.type === 'CSV') {
        const rows = parseCsv(text);
        content.replaceChildren(el('p', { class: 'muted' }, `共 ${rows.length - 1} 筆資料（第一列是表頭）`), tableEl(rows[0], rows.slice(1)));
      } else {
        content.replaceChildren(renderMarkdown(text));
      }
      document.getElementById('modalBody').scrollTop = 0;
    } catch (e) {
      content.replaceChildren(el('p', {}, '素材載入失敗，請改用「下載」按鈕。'),
        el('p', { class: 'muted' }, '若是直接雙擊 index.html 開啟，請改用 npm run serve 啟動本機網站。'));
    }
  }

  /** 工具彈窗目前載入的網址；相同就不重新載入，學員貼上的內容才不會不見 */
  let toolSrc = '';

  /**
   * 開啟貼上工具彈窗
   * @param {string} query 傳給工具的參數，例如 'load=timer_基本版.html' 或 'tab=slots'
   */
  function openTool(query) {
    const src = 'tool.html?embed=1' + (query ? '&' + query : '');
    const frame = document.getElementById('toolFrame');
    if (src !== toolSrc) {
      frame.setAttribute('src', src);
      toolSrc = src;
    }
    document.getElementById('toolNewTab').setAttribute('href', 'tool.html' + (query ? '?' + query : ''));
    document.getElementById('toolBackdrop').hidden = false;
    document.body.classList.add('modal-open');
    syncToolTheme();
    document.getElementById('toolClose').focus();
  }

  /** 關閉貼上工具彈窗（iframe 保留，下次打開還是同一份內容） */
  function closeTool() {
    const bd = document.getElementById('toolBackdrop');
    if (bd.hidden) return;
    bd.hidden = true;
    if (document.getElementById('modalBackdrop').hidden) document.body.classList.remove('modal-open');
  }

  /** 讓工具彈窗跟著教學頁的深色／淺色 */
  function syncToolTheme() {
    try {
      const root = document.getElementById('toolFrame').contentDocument?.documentElement;
      if (!root) return;
      if (state.theme === 'dark') root.setAttribute('data-theme', 'dark');
      else root.removeAttribute('data-theme');
    } catch (e) { /* iframe 還沒載入就略過，工具頁載入時會自己讀主題 */ }
  }

  /** 關閉素材彈窗 */
  function closeModal() {
    const bd = document.getElementById('modalBackdrop');
    if (bd.hidden) return;
    bd.hidden = true;
    if (document.getElementById('toolBackdrop').hidden) document.body.classList.remove('modal-open');
  }

  /** 套用主題並記住 */
  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    document.getElementById('themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    state.theme = theme;
    store.save(state);
    syncToolTheme();
  }

  /** 套用內容縮放（手機版不縮放，交給版面自己處理） */
  function applyZoom(value) {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 10) / 10));
    state.zoom = z;
    store.save(state);
    if (mql.matches) document.documentElement.style.removeProperty('--content-zoom');
    else document.documentElement.style.setProperty('--content-zoom', String(z));
    document.getElementById('zoomLabel').textContent = Math.round(z * 100) + '%';
  }

  /** 開啟手機版側欄 */
  function openSidebar() {
    document.getElementById('app').classList.add('sidebar-open');
    document.getElementById('sidebarBackdrop').classList.add('show');
  }

  /** 關閉手機版側欄 */
  function closeSidebar() {
    document.getElementById('app').classList.remove('sidebar-open');
    document.getElementById('sidebarBackdrop').classList.remove('show');
  }

  /** 側欄開關：桌面版收合、手機版覆蓋 */
  function toggleSidebar() {
    const app = document.getElementById('app');
    if (mql.matches) {
      if (app.classList.contains('sidebar-open')) closeSidebar(); else openSidebar();
    } else {
      app.classList.toggle('sidebar-closed');
    }
  }

  /** 捲動時標示目前所在章節，並更新頂部路徑 */
  function setupScrollSpy() {
    if (!('IntersectionObserver' in window)) return;
    const trail = document.getElementById('topbarTrail');
    const labelOf = id => {
      const hit = sectionIndex[id];
      if (hit) return hit.unit.short + ' › ' + hit.section.title;
      const u = C.units.find(x => x.id === id);
      if (u) return u.short;
      const a = document.querySelector(`.nav-link[data-target="${id}"]`);
      return a ? a.textContent : '';
    };
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const id = entry.target.dataset.spy;
        document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.target === id));
        const hit = sectionIndex[id];
        if (hit) document.querySelectorAll('.nav-unit').forEach(a => a.classList.toggle('active-parent', a.dataset.target === hit.unit.id));
        else document.querySelectorAll('.nav-unit').forEach(a => a.classList.remove('active-parent'));
        trail.textContent = labelOf(id);
      });
    }, { rootMargin: '-25% 0px -65% 0px', threshold: 0 });
    document.querySelectorAll('[data-spy]').forEach(s => observer.observe(s));
  }

  /** 綁定工具列、彈窗、鍵盤與視窗寬度變化 */
  function bindUi() {
    document.getElementById('menuToggle').addEventListener('click', toggleSidebar);
    document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);
    document.getElementById('themeToggle').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
    document.getElementById('zoomIn').addEventListener('click', () => applyZoom(state.zoom + ZOOM_STEP));
    document.getElementById('zoomOut').addEventListener('click', () => applyZoom(state.zoom - ZOOM_STEP));
    document.getElementById('modalClose').addEventListener('click', closeModal);
    document.getElementById('modalCopy').addEventListener('click', async () => {
      if (!modalRawText) { showToast('素材還沒載入完成'); return; }
      showToast(await copyText(modalRawText) ? '已複製全文，貼到 ChatGPT 聊天' : '複製失敗，請改用下載');
    });
    document.getElementById('modalBackdrop').addEventListener('click', e => { if (e.target.id === 'modalBackdrop') closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      closeModal();
      closeTool();
      if (mql.matches) closeSidebar();
    });
    // 所有 tool.html 連結改開工具彈窗；Ctrl／Shift／⌘＋點仍照瀏覽器預設另開分頁
    document.addEventListener('click', e => {
      const link = e.target.closest && e.target.closest('a[href^="tool.html"]');
      if (!link || e.defaultPrevented || link.closest('#toolBackdrop')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      openTool(link.getAttribute('href').split('?')[1] || '');
      if (mql.matches) closeSidebar();
    });
    document.getElementById('toolClose').addEventListener('click', closeTool);
    document.getElementById('toolBackdrop').addEventListener('click', e => { if (e.target.id === 'toolBackdrop') closeTool(); });
    // 工具頁（iframe）裡按 ESC 會送訊息過來；只接受同一個網站的訊息
    window.addEventListener('message', e => {
      if (e.origin !== location.origin) return;
      if (e.data && e.data.type === 'vibe-tool-close') closeTool();
    });
    mql.addEventListener('change', () => {
      document.getElementById('app').classList.remove('sidebar-open', 'sidebar-closed');
      document.getElementById('sidebarBackdrop').classList.remove('show');
      applyZoom(state.zoom);
    });
  }

  /* ============================================================
   * 進入點
   * ============================================================ */

  /** 初始化：建索引、渲染所有章節、綁定互動 */
  function init() {
    if (!C) {
      document.getElementById('content').textContent = '找不到課程資料 course-data.js。';
      return;
    }
    buildIndexes();
    const content = document.getElementById('content');
    content.append(
      renderOverview(),
      renderSchedule(),
      renderSharedCase(),
      renderPrep(),
      ...C.units.map(renderUnit),
      renderMaterialsChapter(),
      renderQuizReview(),
      renderFaq());
    renderSidebar();
    bindUi();
    applyTheme(state.theme);
    applyZoom(state.zoom || 1);
    updateProgress();
    setupScrollSpy();
    // 網址帶錨點時，渲染完成後再捲過去
    if (location.hash) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) target.scrollIntoView();
    }
  }

  // 給驗證腳本使用的純函式（不影響頁面行為）
  window.SiteApp = { inlineMarkdown, renderMarkdown, parseCsv, safeHref, STORE_KEY };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
