/*
 * demos.js — 概念動畫示範元件（window.DEMOS）
 *
 * 教學網站的 `demo` 區塊由 app.js 呼叫 DEMOS.build(cfg, helpers) 產生。
 * 台詞、步驟、數字全部放在 course-data.js 的 COURSE.demos，這支只負責畫面與播放邏輯。
 *
 * 兩大類：
 *   線性示範 cycle／interview／dataflow／prompt-compare／slot-puzzle／test-review：
 *     畫面是「步數 → 畫面」的純函式 paint(step)，上一步、下一步、重播、自動播放都只是改步數。
 *   互動示範 enroll-sim／context-meter：
 *     自己保存畫面狀態，控制列只有「重設」。
 * 動畫全部交給 style.css 切換 class 與 transition；這裡不量像素（.content 有 CSS zoom，量測會失準）。
 * 安全原則：所有文字都用 textContent／DOM API 建構，不用 innerHTML。
 */
(function () {
  'use strict';

  /** 對外物件：autoScale 是自動播放速度倍率（測試會調小，正常為 1）；build 產生示範元素 */
  const DEMOS = { autoScale: 1, build };
  window.DEMOS = DEMOS;

  /** 預設的自動播放間隔（毫秒），設定檔可用 autoMs 覆蓋 */
  const DEFAULT_AUTO_MS = 2000;
  /** 目前正在自動播放的示範控制物件（同一時間只允許一個） */
  let playingApi = null;
  /** 示範根元素 → 控制物件，離開視窗時用來找到要暫停的示範 */
  const apiByRoot = new WeakMap();
  /** 共用的「離開視窗就暫停」觀察器（第一次建立示範時才建立） */
  let visibilityObserver = null;
  /** 分頁隱藏事件是否已綁定 */
  let visibilityBound = false;

  /* ============================================================
   * 共用：外殼、播放控制
   * ============================================================ */

  /**
   * 重新觸發某個 class 的 CSS 動畫（先移除、強制重排、再加回）
   * @param {HTMLElement} node 目標元素
   * @param {string} cls 動畫用的 class
   */
  function restartAnim(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  /**
   * 註冊「離開視窗／分頁隱藏就暫停自動播放」
   * @param {HTMLElement} root 示範根元素
   * @param {object} api 該示範的控制物件
   */
  function watchVisibility(root, api) {
    apiByRoot.set(root, api);
    if (!visibilityBound) {
      visibilityBound = true;
      document.addEventListener('visibilitychange', () => { if (document.hidden && playingApi) playingApi.pause(); });
    }
    if (!('IntersectionObserver' in window)) return;
    if (!visibilityObserver) {
      visibilityObserver = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) return;
          const api2 = apiByRoot.get(e.target);
          if (api2) api2.pause();
        });
      }, { threshold: 0 });
    }
    visibilityObserver.observe(root);
  }

  /**
   * 建立示範外殼（標題列、舞台、說明與控制列、操作提示）並接上播放控制
   * @param {object} cfg 示範設定（course-data.js 的 demos 其中一筆）
   * @param {{el: Function, inlineMarkdown: Function, reducedMotion?: Function}} h app.js 提供的工具
   * @param {{stage: HTMLElement, total?: Function, paint?: Function, reset?: Function}} o
   *   stage：舞台元素；total：回傳目前總步數（有這個就是線性示範）；
   *   paint(step)：依步數重畫並回傳說明文字（線性示範）；reset()：互動示範的重設
   * @returns {{root: HTMLElement, api: object}} root 是整個示範；api 提供 go/next/prev/replay/play/pause/setCaption
   */
  function makeShell(cfg, h, o) {
    const { el, inlineMarkdown } = h;
    const linear = typeof o.total === 'function';
    const reduce = typeof h.reducedMotion === 'function' && h.reducedMotion();
    /** 目前步數（從 0 起算） */
    let step = 0;
    /** 自動播放的計時器 */
    let timer = null;
    /** 是否正在自動播放 */
    let isPlaying = false;
    const total = () => (linear ? o.total() : 0);

    const count = linear ? el('span', { class: 'demo-count', 'aria-hidden': 'true' }) : null;
    const caption = el('div', { class: 'demo-caption', 'aria-live': 'polite' });
    const stage = el('div', { class: 'demo-stage' }, o.stage);
    const mkBtn = (act, label, cls, tip) => el('button', { class: 'demo-btn' + (cls ? ' ' + cls : ''), type: 'button', 'data-act': act, title: tip }, label);
    const prevBtn = linear ? mkBtn('prev', '◀ 上一步', '', '上一步（示範取得焦點時可按鍵盤 ←）') : null;
    const nextBtn = linear ? mkBtn('next', '下一步 ▶', 'demo-btn-primary', '下一步（示範取得焦點時可按鍵盤 →）') : null;
    const playBtn = linear && !reduce ? el('button', { class: 'demo-btn', type: 'button', 'data-act': 'play', 'aria-pressed': 'false' }, '▶ 自動播放') : null;
    const replayBtn = linear ? mkBtn('replay', '↻ 重播') : null;
    const resetBtn = linear ? null : mkBtn('reset', '↻ 重設');
    const controls = el('div', { class: 'demo-controls' }, prevBtn, nextBtn, playBtn, replayBtn, resetBtn);

    const root = el('div', {
      class: 'demo demo-' + cfg.kind, id: cfg.id, 'data-demo-kind': cfg.kind,
      role: 'group', tabindex: '0', 'aria-label': '動畫示範：' + cfg.title
    },
      el('div', { class: 'demo-head' },
        el('span', { class: 'demo-badge' }, '動畫示範'),
        el('span', { class: 'demo-title' }, cfg.title),
        count),
      stage,
      // 說明與控制列包成 dock：示範比視窗高時黏在視窗底部，講師不必捲動就能按「下一步」
      el('div', { class: 'demo-dock' }, caption, controls),
      el('p', { class: 'demo-hint' }, el('strong', {}, '操作提示：'), cfg.hint));

    /** 設定說明文字（支援行內 Markdown） */
    function setCaption(text) {
      caption.replaceChildren(inlineMarkdown(text == null ? '' : text));
    }

    /** 把步數與播放狀態反映到按鈕與 data 屬性 */
    function sync() {
      if (!linear) return;
      root.dataset.step = String(step);
      root.dataset.steps = String(total());
      count.textContent = `${step + 1} / ${total()}`;
      prevBtn.disabled = step <= 0;
      nextBtn.disabled = step >= total() - 1;
      if (playBtn) {
        playBtn.setAttribute('aria-pressed', String(isPlaying));
        playBtn.textContent = isPlaying ? '⏸ 暫停' : '▶ 自動播放';
      }
    }

    /** 跳到指定步數（會夾在 0～最後一步之間）並重畫 */
    function go(n) {
      if (!linear) return;
      step = Math.max(0, Math.min(total() - 1, n));
      setCaption(o.paint(step));
      sync();
    }

    /** 暫停自動播放 */
    function pause() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!isPlaying) return;
      isPlaying = false;
      if (playingApi === api) playingApi = null;
      sync();
    }

    /** 排下一次自動前進；走到最後一步就自動停止 */
    function schedule() {
      const delay = (cfg.autoMs || DEFAULT_AUTO_MS) * DEMOS.autoScale;
      timer = setTimeout(() => {
        timer = null;
        if (!isPlaying) return;
        go(step + 1);
        if (step >= total() - 1) pause(); else schedule();
      }, delay);
    }

    /** 開始自動播放（若在最後一步就從頭開始；先停掉別的示範） */
    function play() {
      if (!linear || isPlaying) return;
      if (playingApi && playingApi !== api) playingApi.pause();
      if (step >= total() - 1) go(0);
      isPlaying = true;
      playingApi = api;
      sync();
      schedule();
    }

    const api = {
      go, setCaption, pause, play,
      next() { pause(); go(step + 1); },
      prev() { pause(); go(step - 1); },
      replay() { pause(); go(0); },
      get step() { return step; }
    };

    if (linear) {
      prevBtn.addEventListener('click', api.prev);
      nextBtn.addEventListener('click', api.next);
      replayBtn.addEventListener('click', api.replay);
      if (playBtn) playBtn.addEventListener('click', () => (isPlaying ? pause() : play()));
      // 方向鍵翻步；分頁標籤（role=tab）自己處理方向鍵
      root.addEventListener('keydown', e => {
        if (e.target.closest && e.target.closest('[role="tab"], input, textarea, select')) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); api.next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); api.prev(); }
      });
      go(0);
    } else {
      resetBtn.addEventListener('click', () => o.reset());
    }
    watchVisibility(root, api);
    return { root, api };
  }

  /* ============================================================
   * 1. cycle：Vibe Coding 迴圈（用計時器走兩圈）
   * ============================================================ */

  /** 建立四格循環：說清楚 → AI 做 → 你驗收 → （不對）再說 → AI 做 → 你驗收 ✓ */
  function buildCycle(cfg, h) {
    const { el } = h;
    const nodeEls = cfg.nodes.map(n => el('div', { class: 'cyc-node cyc-' + n.key, 'data-key': n.key },
      el('div', { class: 'cyc-icon', 'aria-hidden': 'true' }, n.icon),
      el('div', { class: 'cyc-label' }, n.label),
      el('div', { class: 'cyc-sub' }, n.sub),
      n.key === 'check' ? el('span', { class: 'cyc-mark', 'aria-hidden': 'true' }) : null));
    const arrow = () => el('div', { class: 'cyc-arrow', 'aria-hidden': 'true' }, '→');
    const lap = el('div', { class: 'cyc-lap' });
    const who = el('span', { class: 'cyc-who' });
    const text = el('span', { class: 'cyc-text' });
    const bubble = el('div', { class: 'cyc-bubble' }, who, text);
    const done = el('div', { class: 'cyc-done' }, '✓ ' + cfg.doneLabel);
    const board = el('div', { class: 'cyc-board' }, nodeEls[0], arrow(), nodeEls[1], arrow(), nodeEls[2], nodeEls[3]);
    const foot = el('div', { class: 'cyc-foot' }, bubble);
    const stage = el('div', { class: 'cyc-stage' }, lap, board, foot);
    const checkNode = nodeEls[2];
    const mark = checkNode.querySelector('.cyc-mark');

    /** 依步數重畫：點亮目前節點、標出走過的節點、換泡泡文字 */
    function paint(step) {
      const s = cfg.steps[step];
      const seen = cfg.steps.slice(0, step + 1);
      nodeEls.forEach((n, i) => {
        n.classList.toggle('is-active', i === s.node);
        n.classList.toggle('is-visited', seen.some(t => t.node === i));
      });
      lap.textContent = `第 ${s.lap} 圈`;
      who.textContent = s.who;
      text.textContent = s.text;
      bubble.dataset.who = s.who === 'AI' ? 'ai' : 'you';
      restartAnim(bubble, 'is-new');
      // 驗收節點上的 ✗／✓：取最近一次「你驗收」的結果
      const lastCheck = seen.filter(t => t.node === 2).pop();
      mark.textContent = lastCheck ? (lastCheck.verdict === 'pass' ? '✓' : '✗') : '';
      mark.className = 'cyc-mark' + (lastCheck ? (lastCheck.verdict === 'pass' ? ' is-pass' : ' is-fail') : '');
      if (s.done) foot.append(done); else done.remove();
      return s.caption;
    }
    return makeShell(cfg, h, { stage, total: () => cfg.steps.length, paint });
  }

  /* ============================================================
   * 2. interview：AI 先發問，spec.md 八節一格格被填滿
   * ============================================================ */

  /** 建立對話重播（左）與 spec.md 八節進度（右） */
  function buildInterview(cfg, h) {
    const { el } = h;
    const chat = el('div', { class: 'iv-chat', role: 'log' });
    const secEls = cfg.sections.map((name, i) => el('li', { class: 'iv-sec' },
      el('span', { class: 'iv-no' }, String(i + 1)),
      el('span', { class: 'iv-name' }, name),
      el('span', { class: 'iv-mark', 'aria-hidden': 'true' })));
    const progress = el('div', { class: 'iv-progress' });
    const spec = el('div', { class: 'iv-spec' },
      el('div', { class: 'iv-spec-head' }, el('code', {}, 'spec.md'), progress),
      el('ul', { class: 'iv-secs' }, secEls));
    const stage = el('div', { class: 'iv-board' },
      el('div', { class: 'iv-chat-wrap' }, el('div', { class: 'iv-chat-title' }, '和 AI 的對話'), chat),
      spec);

    /** 依步數重畫：顯示前 step+1 則訊息，規格書各節依累積狀態換顏色 */
    function paint(step) {
      const shown = cfg.messages.slice(0, step + 1);
      const state = {};
      shown.forEach(m => Object.assign(state, m.sets || {}));
      chat.replaceChildren(...shown.map((m, i) => el('div', { class: 'iv-msg ' + (m.who === 'ai' ? 'is-ai' : 'is-you') + (i === step ? ' is-new' : '') },
        el('div', { class: 'iv-who' }, m.who === 'ai' ? 'AI' : '你'),
        el('div', { class: 'iv-lines' }, m.lines.map(l => el('div', {}, l))))));
      chat.scrollTop = chat.scrollHeight;
      let filled = 0;
      secEls.forEach((li, i) => {
        li.classList.toggle('is-ask', state[i] === 'ask');
        li.classList.toggle('is-done', state[i] === 'done');
        li.querySelector('.iv-mark').textContent = state[i] === 'done' ? '✓' : state[i] === 'ask' ? '？' : '';
        if (state[i] === 'done') filled++;
      });
      progress.textContent = `${filled} / ${cfg.sections.length} 節已填`;
      return cfg.messages[step].caption;
    }
    return makeShell(cfg, h, { stage, total: () => cfg.messages.length, paint });
  }

  /* ============================================================
   * 3. enroll-sim：報名寫入資料表（R1 額滿、R2 重複即時判斷）
   * ============================================================ */

  /** 建立兩張資料表、可按的報名情境、結果與 SQL 記錄 */
  function buildEnrollSim(cfg, h) {
    const { el } = h;
    /** 目前的報名資料 */
    let rows;
    /** 下一個報名編號 */
    let nextId;
    /** SQL 記錄（最新在前，最多 3 筆） */
    let log;
    /** 最近一次結果：{ ok, kind: 'ok'|'full'|'dup', text }，尚未操作為 null */
    let result;
    /** 初始化（載入與重設共用） */
    function init() {
      rows = cfg.seed.map((s, i) => Object.assign({ id: i + 1, isNew: false }, s));
      nextId = rows.length + 1;
      log = [];
      result = null;
    }
    init();

    /** 課程列只建立一次，之後只更新人數與進度條，寬度變化才會有過渡動畫 */
    const courseRows = cfg.courses.map(c => {
      const count = el('span', { class: 'es-count' });
      const bar = el('i');
      const tr = el('tr', { class: 'es-course-row' },
        el('td', {}, el('span', { class: 'es-cid cid-' + c.id }, String(c.id))),
        el('td', {}, c.title),
        el('td', {}, count, el('span', { class: 'es-bar', 'aria-hidden': 'true' }, bar)));
      return { c, tr, count, bar };
    });
    const courseBody = el('tbody', {}, courseRows.map(r => r.tr));
    const enrollBody = el('tbody');
    /** 報名資料表的捲動容器：新增一列後捲到底，才看得到剛加進去的那一列 */
    const scrollBox = el('div', { class: 'es-scroll' }, el('table', { class: 'es-table' },
      el('thead', {}, el('tr', {}, ['id', 'course_id', 'emp_no', 'name', 'dept'].map(c => el('th', {}, c)))),
      enrollBody));
    const resultEl = el('div', { class: 'es-result is-idle', role: 'status' });
    const logEl = el('div', { class: 'es-log' });
    const actionBtns = cfg.actions.map((a, i) => el('button', { class: 'es-action', type: 'button', 'data-i': String(i), onclick: () => apply(a) }, a.label));
    const stage = el('div', { class: 'es-stage' },
      el('div', { class: 'es-tables' },
        el('div', { class: 'es-card' },
          el('div', { class: 'es-card-head' }, el('code', {}, 'courses'), ' 課程'),
          el('table', { class: 'es-table' },
            el('thead', {}, el('tr', {}, el('th', {}, 'id'), el('th', {}, 'title'), el('th', {}, '報名 / 名額'))),
            courseBody)),
        el('div', { class: 'es-card' },
          el('div', { class: 'es-card-head' }, el('code', {}, 'enrollments'), ' 報名'),
          scrollBox)),
      el('div', { class: 'es-rules' }, cfg.rules.map(r => el('span', { class: 'es-rule' }, r))),
      el('div', { class: 'es-actions-label' }, '按一個情境，看資料表和 SQL 怎麼動：'),
      el('div', { class: 'es-actions' }, actionBtns),
      resultEl, logEl);

    /** 依目前資料重畫兩張表、結果與記錄 */
    function paint() {
      courseRows.forEach(({ c, tr, count, bar }) => {
        const n = rows.filter(r => r.course_id === c.id).length;
        const text = `${n} / ${c.capacity}`;
        if (count.textContent && count.textContent !== text) restartAnim(count, 'is-bump');
        count.textContent = text;
        bar.style.width = Math.min(100, Math.round(n / c.capacity * 100)) + '%';
        tr.classList.toggle('is-full', n >= c.capacity);
      });
      enrollBody.replaceChildren(...rows.map(r => el('tr', { class: 'es-enroll-row' + (r.isNew ? ' is-new' : '') },
        el('td', {}, String(r.id)),
        el('td', {}, el('span', { class: 'es-cid cid-' + r.course_id }, String(r.course_id))),
        el('td', {}, r.emp_no), el('td', {}, r.name), el('td', {}, r.dept))));
      scrollBox.scrollTop = rows.some(r => r.isNew) ? scrollBox.scrollHeight : 0;
      resultEl.className = 'es-result ' + (result ? (result.ok ? 'is-ok' : 'is-error') : 'is-idle');
      resultEl.textContent = result ? (result.ok ? '✓ ' : '✗ ') + result.text : cfg.captions.idle;
      if (result) restartAnim(resultEl, 'is-new');
      logEl.replaceChildren(...(log.length
        ? log.map(entry => el('div', { class: 'es-log-entry' },
          el('div', { class: 'es-log-title' }, entry.title),
          entry.sql.map(q => el('div', { class: 'es-sql' }, el('code', {}, q.text), el('span', { class: 'es-note' }, q.note)))))
        : [el('div', { class: 'es-log-empty' }, 'SQL 記錄會出現在這裡（最新的在最上面）')]));
      shell.api.setCaption(result ? cfg.captions[result.kind] : cfg.captions.idle);
    }

    /** 套用一個報名情境：先查人數（R1），再查重複（R2），都通過才 INSERT */
    function apply(a) {
      const course = cfg.courses.find(c => c.id === a.course_id);
      rows.forEach(r => { r.isNew = false; });
      const entry = { title: `${a.name}（${a.emp_no}）報名「${course.title}」`, sql: [] };
      const n = rows.filter(r => r.course_id === course.id).length;
      entry.sql.push({ text: 'SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', note: `[${course.id}] → n = ${n}` });
      if (n >= course.capacity) {
        result = { ok: false, kind: 'full', text: '名額已滿，無法報名' };
      } else {
        const dup = rows.filter(r => r.course_id === course.id && r.emp_no === a.emp_no);
        entry.sql.push({ text: 'SELECT id FROM enrollments WHERE course_id = ? AND emp_no = ?', note: `[${course.id}, '${a.emp_no}'] → ${dup.length} 筆` });
        if (dup.length) {
          result = { ok: false, kind: 'dup', text: `${a.emp_no} 已報名過這堂課` };
        } else {
          entry.sql.push({ text: 'INSERT INTO enrollments (course_id, emp_no, name, dept, enrolled_at) VALUES (?, ?, ?, ?, ?)', note: `[${course.id}, '${a.emp_no}', '${a.name}', '${a.dept}', nowText()]` });
          rows.push({ id: nextId++, course_id: course.id, emp_no: a.emp_no, name: a.name, dept: a.dept, isNew: true });
          result = { ok: true, kind: 'ok', text: `${a.name} 已報名「${course.title}」` };
        }
      }
      log.unshift(entry);
      log = log.slice(0, 3);
      paint();
    }

    /** 重設回初始資料 */
    function reset() {
      init();
      paint();
    }

    const shell = makeShell(cfg, h, { stage, reset });
    paint();
    return shell;
  }

  /* ============================================================
   * 4. dataflow：按鈕到畫面的資料流（櫃檯、廚房、倉庫）
   * ============================================================ */

  /** 建立三站流程與沿途移動的點餐單，兩種劇本用分頁切換 */
  function buildDataflow(cfg, h) {
    const { el } = h;
    /** 目前劇本的索引 */
    let sIdx = 0;
    const scenario = () => cfg.scenarios[sIdx];
    const nodeEls = cfg.nodes.map(n => el('div', { class: 'df-node' },
      el('div', { class: 'df-icon', 'aria-hidden': 'true' }, n.icon),
      el('div', { class: 'df-label' }, n.label),
      el('div', { class: 'df-sub' }, n.sub)));
    const packet = el('div', { class: 'df-packet', 'aria-hidden': 'true' }, cfg.packet || '🧾');
    const detailText = el('div', { class: 'df-detail-text' });
    const code = el('pre', { class: 'df-code' });
    const resultText = el('div', { class: 'df-result-text' });
    const formalText = el('div', { class: 'df-formal' });
    const result = el('div', { class: 'df-result', hidden: true }, resultText, formalText);
    const tabs = cfg.scenarios.map((s, i) => el('button', {
      class: 'df-tab', type: 'button', role: 'tab', 'aria-selected': i === 0 ? 'true' : 'false', tabindex: i === 0 ? '0' : '-1',
      onclick: () => select(i)
    }, s.label));
    tabs.forEach((t, i) => t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const to = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      select(to);
      tabs[to].focus();
    }));
    const stage = el('div', { class: 'df-stage' },
      el('div', { class: 'df-tabs', role: 'tablist', 'aria-label': '選一種情境' }, tabs),
      el('div', { class: 'df-track' },
        el('div', { class: 'df-lane', 'aria-hidden': 'true' }),
        el('div', { class: 'df-nodes' }, nodeEls),
        packet),
      el('div', { class: 'df-detail' }, detailText, code),
      result);
    /** shell 建好之後才有值 */
    let shell = null;

    /** 切換劇本：分頁狀態更新、回到第 0 步 */
    function select(i) {
      sIdx = i;
      tabs.forEach((t, k) => { t.setAttribute('aria-selected', String(k === i)); t.tabIndex = k === i ? 0 : -1; });
      shell.api.replay();
    }

    /** 依步數重畫：小圓點移到該站、該站點亮、換說明與程式碼；最後一步顯示結果 */
    function paint(step) {
      const sc = scenario();
      const st = sc.steps[step];
      // 第一次 paint 發生在 makeShell 內部，此時 shell 還沒回傳，改由舞台往上找到示範根元素
      stage.closest('.demo').dataset.outcome = sc.outcome;
      packet.dataset.at = String(st.at);
      packet.dataset.tone = st.tone || '';
      packet.style.setProperty('--at', String(st.at));
      nodeEls.forEach((n, i) => {
        n.classList.toggle('is-active', i === st.at);
        n.dataset.tone = i === st.at ? (st.tone || '') : '';
      });
      detailText.textContent = st.text;
      code.textContent = st.code || '';
      code.hidden = !st.code;
      const last = step === sc.steps.length - 1;
      result.hidden = !last;
      result.className = 'df-result ' + (sc.outcome === 'ok' ? 'is-ok' : 'is-error');
      resultText.textContent = (sc.outcome === 'ok' ? '✓ ' : '✗ ') + sc.result;
      formalText.textContent = sc.formal;
      if (last) restartAnim(result, 'is-new');
      return st.title;
    }
    shell = makeShell(cfg, h, { stage, total: () => scenario().steps.length, paint });
    return shell;
  }

  /* ============================================================
   * 5. prompt-compare：模糊 vs 精準提示詞
   * ============================================================ */

  /** 建立左右對照：模糊指令旁的猜測項目永遠不變；精準指令逐段加入並劃掉猜測 */
  function buildPromptCompare(cfg, h) {
    const { el } = h;
    const guessList = () => cfg.guesses.map(g => el('li', { class: 'pc-guess', 'data-id': g.id }, el('span', { class: 'pc-guess-mark', 'aria-hidden': 'true' }, '？'), g.text));
    const vagueGuesses = guessList();
    const preciseGuesses = guessList();
    const preciseCount = el('span', { class: 'pc-count', 'data-side': 'precise' });
    const precisePrompt = el('div', { class: 'pc-prompt' });
    const stage = el('div', { class: 'pc-cols' },
      el('div', { class: 'pc-col pc-vague' },
        el('h4', { class: 'pc-col-title' }, '模糊的指令'),
        el('div', { class: 'pc-prompt' }, cfg.vague),
        el('div', { class: 'pc-guess-title' }, 'AI 得自己猜的地方'),
        el('ul', { class: 'pc-guesses' }, vagueGuesses),
        el('div', { class: 'pc-meter' }, '要猜的地方：', el('span', { class: 'pc-count', 'data-side': 'vague' }, String(cfg.guesses.length)), ' 個')),
      el('div', { class: 'pc-col pc-precise' },
        el('h4', { class: 'pc-col-title' }, '精準的指令（四段式）'),
        precisePrompt,
        el('div', { class: 'pc-guess-title' }, 'AI 得自己猜的地方'),
        el('ul', { class: 'pc-guesses' }, preciseGuesses),
        el('div', { class: 'pc-meter' }, '要猜的地方：', preciseCount, ' 個')));

    /** 依步數重畫：前 step 段精準指令、被這些段落劃掉的猜測項目 */
    function paint(step) {
      const shown = cfg.parts.slice(0, step);
      precisePrompt.replaceChildren(...(shown.length
        ? shown.map((p, i) => el('span', { class: `pc-part pc-part-${p.key}` + (i === step - 1 ? ' is-new' : '') }, el('b', { class: 'pc-tag' }, p.label), p.text))
        : [el('span', { class: 'pc-empty' }, cfg.emptyHint)]));
      const killed = new Set(shown.flatMap(p => p.kills));
      preciseGuesses.forEach(li => {
        const k = killed.has(li.dataset.id);
        li.classList.toggle('is-killed', k);
        li.querySelector('.pc-guess-mark').textContent = k ? '✓' : '？';
      });
      preciseCount.textContent = String(cfg.guesses.length - killed.size);
      return cfg.captions[step];
    }
    return makeShell(cfg, h, { stage, total: () => cfg.parts.length + 1, paint });
  }

  /* ============================================================
   * 6. context-meter：對話水位條
   * ============================================================ */

  /** 建立水位條：聊一輪／貼文件會加高，滿了最舊的先被擠掉，交接摘要開新對話 */
  function buildContextMeter(cfg, h) {
    const { el } = h;
    /** 每種區塊在水位條上的短標籤與說明 */
    const KIND_LABEL = { rules: ['規矩', cfg.rules.label], chat: ['聊', '一輪對話'], doc: ['文件', '貼上的長文件'], summary: ['摘要', cfg.summary.label] };
    /** 目前是第幾個對話 */
    let chatNo;
    /** 水位條裡的區塊：{ kind, cost, dropped } */
    let blocks;
    /** 初始化（載入與重設共用） */
    function init() {
      chatNo = 1;
      blocks = [{ kind: 'rules', cost: cfg.rules.cost, dropped: false }];
    }
    init();
    const used = () => blocks.filter(b => !b.dropped).reduce((s, b) => s + b.cost, 0);

    const chatNoEl = el('div', { class: 'cm-chat-no' });
    const bandEl = el('div', { class: 'cm-band' });
    const percentEl = el('div', { class: 'cm-percent' });
    const fill = el('div', { class: 'cm-fill' });
    const ghosts = el('div', { class: 'cm-ghosts' });
    const ghostBox = el('div', { class: 'cm-ghost-box' }, el('div', { class: 'cm-ghost-title' }, '被擠出去的（AI 已經讀不到）'), ghosts);
    const warning = el('div', { class: 'cm-warning', role: 'alert', hidden: true }, '⚠ ' + cfg.overflowNote);
    const actionBtns = cfg.actions.map(a => el('button', { class: 'demo-btn cm-act', type: 'button', 'data-act': a.key, onclick: () => add(a.key, a.cost) }, `＋ ${a.label}`));
    const summaryBtn = el('button', { class: 'demo-btn cm-act', type: 'button', 'data-act': 'summary', onclick: newChat }, '📝 ' + cfg.summary.button);
    const track = el('div', { class: 'cm-track', role: 'img', 'aria-label': '對話水位條（示意，不是真實 token 數）' }, fill);
    const stage = el('div', { class: 'cm-stage' },
      el('div', { class: 'cm-top' }, chatNoEl, bandEl, percentEl),
      ghostBox,
      track,
      el('div', { class: 'cm-legend' }, ['rules', 'chat', 'doc', 'summary'].map(k => el('span', { class: 'cm-key' }, el('i', { class: 'cm-swatch is-' + k }), KIND_LABEL[k][1]))),
      warning,
      el('div', { class: 'cm-actions' }, actionBtns, summaryBtn),
      el('div', { class: 'cm-note' }, '水位是示意，不是真實的 token 數。'));

    /** 產生一個區塊元素（flex-grow 依花費決定寬度） */
    function blockEl(b) {
      const [short, full] = KIND_LABEL[b.kind];
      return el('div', { class: `cm-block is-${b.kind}` + (b.dropped ? ' is-dropped' : '') + (b.fresh ? ' is-new' : ''), style: `flex-grow:${b.cost}`, title: full }, el('span', {}, short));
    }

    /** 依目前區塊重畫水位、分段顏色、被擠出的區塊、警告 */
    function paint() {
      const level = used();
      const pct = Math.round(level / cfg.capacity * 100);
      const band = cfg.bands.find(b => pct <= b.upTo) || cfg.bands[cfg.bands.length - 1];
      fill.dataset.level = String(level);
      fill.style.setProperty('--level', String(level));
      fill.style.width = pct + '%';
      fill.replaceChildren(...blocks.filter(b => !b.dropped).map(blockEl));
      const dropped = blocks.filter(b => b.dropped);
      ghosts.replaceChildren(...dropped.map(blockEl));
      ghostBox.hidden = dropped.length === 0;
      bandEl.dataset.tone = band.tone;
      track.dataset.tone = band.tone;
      bandEl.textContent = band.label;
      percentEl.textContent = pct + '%';
      chatNoEl.textContent = `第 ${chatNo} 個對話`;
      const rulesGone = blocks.some(b => b.kind === 'rules' && b.dropped);
      warning.hidden = !rulesGone;
      shell.api.setCaption(band.label + (rulesGone ? '　' + cfg.overflowNote : ''));
    }

    /** 加一個區塊；超過容量就把最舊的區塊擠出去 */
    function add(kind, cost) {
      blocks.forEach(b => { b.fresh = false; });
      blocks.push({ kind, cost, dropped: false, fresh: true });
      while (used() > cfg.capacity) {
        const oldest = blocks.find(b => !b.dropped);
        oldest.dropped = true;
      }
      paint();
    }

    /** 請 AI 寫交接摘要，開新對話：只帶規矩和摘要 */
    function newChat() {
      chatNo += 1;
      blocks = [{ kind: 'rules', cost: cfg.rules.cost, dropped: false }, { kind: 'summary', cost: cfg.summary.cost, dropped: false }];
      paint();
    }

    /** 重設回第 1 個對話 */
    function reset() {
      init();
      paint();
    }

    const shell = makeShell(cfg, h, { stage, reset });
    paint();
    return shell;
  }

  /* ============================================================
   * 7. slot-puzzle：三個功能插槽拼成完成版
   * ============================================================ */

  /** 建立 signin.html 的三個插槽（左）與預覽畫面的三個功能按鈕（右） */
  function buildSlotPuzzle(cfg, h) {
    const { el } = h;
    const slotEls = cfg.slots.map(s => el('div', { class: 'sp-slot', 'data-n': String(s.n) },
      el('div', { class: 'sp-slot-head' },
        el('span', { class: 'sp-slot-no' }, `插槽 ${s.n}`),
        el('span', { class: 'sp-slot-label' }, s.label),
        el('code', {}, s.fn)),
      el('div', { class: 'sp-empty' }, '空的：AI 還沒寫這個函式'),
      el('ul', { class: 'sp-code' }, s.lines.map(l => el('li', {}, l)))));
    const featureEls = cfg.slots.map(s => el('div', { class: 'sp-feature', 'data-n': String(s.n) },
      el('span', { class: 'sp-feature-name' }, s.label),
      el('span', { class: 'sp-feature-state' })));
    const done = el('div', { class: 'sp-done' }, '✓ ' + cfg.doneLabel);
    const preview = el('div', { class: 'sp-preview' },
      el('div', { class: 'sp-preview-head' }, '預覽畫面'),
      el('ul', { class: 'sp-base' }, cfg.base.map(b => el('li', {}, '✓ ' + b))),
      featureEls);
    const stage = el('div', { class: 'sp-cols' },
      el('div', { class: 'sp-file' },
        el('div', { class: 'sp-file-head' }, el('code', {}, 'signin.html'), ' 基本版'),
        slotEls),
      preview);

    /** 依步數重畫：前 step 個插槽已填、對應的功能按鈕可用；第 3 步顯示完成版 */
    function paint(step) {
      slotEls.forEach((s, i) => {
        s.classList.toggle('is-filled', i < step);
        s.classList.toggle('is-new', i === step - 1);
      });
      featureEls.forEach((f, i) => {
        const ready = i < step;
        f.classList.toggle('is-ready', ready);
        f.querySelector('.sp-feature-state').textContent = ready ? '可以用' : '還沒做';
      });
      if (step >= cfg.slots.length) preview.append(done); else done.remove();
      return cfg.captions[step];
    }
    return makeShell(cfg, h, { stage, total: () => cfg.slots.length + 1, paint });
  }

  /* ============================================================
   * 8. test-review：測試燈號、Code Review、修正
   * ============================================================ */

  /** 建立測試燈號清單、Code Review 問題表與 diff */
  function buildTestReview(cfg, h) {
    const { el } = h;
    const testEls = cfg.tests.map((t, i) => el('li', { class: 'tr-test is-pending', 'data-id': t.id, style: `--i:${i}` },
      el('span', { class: 'tr-light', 'aria-hidden': 'true' }),
      el('span', { class: 'tr-id' }, t.id),
      el('span', { class: 'tr-label' }, t.label),
      el('span', { class: 'tr-expect' }, '→ ' + t.expect)));
    const tally = el('div', { class: 'tr-tally' });
    const review = el('div', { class: 'tr-review', hidden: true },
      el('div', { class: 'tr-panel-title' }, 'Code Review 回報（只讀不改）'),
      cfg.review.map(r => el('div', { class: 'tr-finding', 'data-level': r.level },
        el('span', { class: 'tr-level' }, r.level),
        el('div', { class: 'tr-finding-body' },
          el('div', {}, el('code', {}, r.where), '　', r.issue),
          el('div', { class: 'tr-fix' }, '建議：' + r.fix)))));
    const lineEl = (cls, sign, t) => el('div', { class: 'tr-line ' + cls }, el('span', { class: 'tr-sign' }, sign), t);
    const diff = el('div', { class: 'tr-diff', hidden: true },
      el('div', { class: 'tr-panel-title' }, el('code', {}, cfg.diff.fn), ' 修正前後'),
      el('div', { class: 'tr-code' },
        cfg.diff.removed.map(t => lineEl('is-removed', '−', t)),
        cfg.diff.added.map(t => lineEl('is-added', '＋', t))),
      el('div', { class: 'tr-applied' }, '✓ 已套用，重新跑同一項測試'));
    const stage = el('div', { class: 'tr-stage' },
      el('div', { class: 'tr-tests-head' }, el('span', {}, '成品驗收清單（節錄）'), tally),
      el('ul', { class: 'tr-tests' }, testEls),
      review, diff);

    /** 依步數重畫：0 待測、1 跑完（一項失敗）、2 Code Review、3 看 diff、4 修好重跑全綠 */
    function paint(step) {
      const total = cfg.tests.length;
      let passed = 0;
      testEls.forEach((li, i) => {
        const t = cfg.tests[i];
        const state = step === 0 ? 'pending' : (t.fail && step < 4 ? 'fail' : 'pass');
        li.classList.toggle('is-pending', state === 'pending');
        li.classList.toggle('is-pass', state === 'pass');
        li.classList.toggle('is-fail', state === 'fail');
        if (state === 'pass') passed++;
      });
      tally.textContent = step === 0 ? `尚未測試（共 ${total} 項）` : `${passed} / ${total} 通過`;
      tally.dataset.state = step === 0 ? 'idle' : (passed === total ? 'ok' : 'bad');
      stage.classList.toggle('is-compact', step >= 2);
      review.classList.toggle('is-focus', step >= 3);
      review.hidden = step < 2;
      diff.hidden = step < 3;
      diff.classList.toggle('is-applied', step >= 4);
      if (step === 2) restartAnim(review, 'is-new');
      if (step === 3) restartAnim(diff, 'is-new');
      return cfg.captions[step];
    }
    return makeShell(cfg, h, { stage, total: () => 5, paint });
  }

  /* ============================================================
   * 對外：依 kind 建立示範
   * ============================================================ */

  /** kind → 建構函式 */
  const BUILDERS = {
    cycle: buildCycle,
    interview: buildInterview,
    'enroll-sim': buildEnrollSim,
    dataflow: buildDataflow,
    'prompt-compare': buildPromptCompare,
    'context-meter': buildContextMeter,
    'slot-puzzle': buildSlotPuzzle,
    'test-review': buildTestReview
  };

  /**
   * 依設定建立示範元素
   * @param {object} cfg course-data.js 的 demos 其中一筆
   * @param {{el: Function, inlineMarkdown: Function, reducedMotion?: Function}} helpers app.js 提供的工具
   * @returns {HTMLElement|null} 不支援的 kind 回傳 null
   */
  function build(cfg, helpers) {
    const builder = BUILDERS[cfg.kind];
    return builder ? builder(cfg, helpers).root : null;
  }
})();
