// ==UserScript==
// @name         DM3 预览批量评审台（零侵入版）
// @namespace    http://tampermonkey.net/
// @version      4.4.0
// @description  零侵入iframe；紧凑单行顶栏（评分+分页合并）；三档评分+规则浮层+toast
// @author       You
// @match        https://dm3.noematrix.cn/dq/studio/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (/\/episode\/\d+/.test(location.pathname)) return;

    /* ============================================================
     * 配置
     * ============================================================ */
    const TARGET_SELECTORS = [null, null];
    const SCORE_LABELS = ['物体摆放', '初始姿态']; // 顶栏短标签，规则浮层内有全称
    const LINK_TEXT = '打开预览';
    const SCORES = [30, 60, 90];
    const PER_PAGE = 2;

    /* ============================================================
     * 样式
     * ============================================================ */
    const CSS = `
    :root {
      --dz-bg:#14141f; --dz-panel:#1e1e2e; --dz-panel2:#262637;
      --dz-fg:#e8e8f2; --dz-muted:#9a9ab2; --dz-accent:#4c9aff;
      --dz-good:#7ee2a8; --dz-danger:#ff7875; --dz-border:#33334a;
      --dz-radius:8px; --dz-gap:8px;
      --dz-font:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    }
    #dz-launcher {
      position:fixed; right:20px; bottom:20px; z-index:2147483000;
      background:var(--dz-panel); color:var(--dz-fg);
      font-family:var(--dz-font); font-size:13px;
      padding:12px 16px; border-radius:var(--dz-radius);
      box-shadow:0 8px 24px rgba(0,0,0,.35);
      display:flex; align-items:center; gap:10px; user-select:none;
    }
    #dz-launcher .dz-cnt { color:var(--dz-muted); font-variant-numeric:tabular-nums; }
    #dz-launcher b { color:var(--dz-fg); }
    #dz-launcher button {
      appearance:none; border:0; border-radius:6px; padding:8px 14px;
      font-family:inherit; font-size:13px; font-weight:600;
      background:var(--dz-accent); color:#fff; cursor:pointer;
    }
    #dz-launcher button:hover { filter:brightness(1.12); }
    #dz-launcher button:disabled { filter:grayscale(.7) brightness(.7); cursor:not-allowed; }

    /* 遮罩：顶栏一行 + 视口，仅两层 */
    #dz-overlay {
      position:fixed; inset:0; z-index:2147483001;
      background:rgba(10,10,18,.97);
      display:grid; grid-template-rows:auto 1fr;
      font-family:var(--dz-font); color:var(--dz-fg);
    }

    /* 顶栏：标题+任务名+评分+分页+规则+关闭，全部一行（小屏换行） */
    .dz-topbar {
      display:flex; align-items:center; gap:var(--dz-gap);
      padding:6px 10px; background:var(--dz-panel);
      border-bottom:1px solid var(--dz-border); flex-wrap:wrap;
    }
    .dz-heading {
      font-weight:700; font-size:13px;
      display:flex; align-items:center; gap:6px;
    }
    .dz-task-name {
      font-weight:400; font-size:11px; color:var(--dz-accent);
      background:var(--dz-panel2); padding:2px 6px; border-radius:4px;
      max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }
    .dz-score-card {
      background:var(--dz-panel2); border-radius:5px;
      padding:3px 8px; display:flex; align-items:center; gap:6px;
    }
    .dz-score-card label { font-size:11px; color:var(--dz-muted); white-space:nowrap; }
    .dz-score-btns { display:flex; gap:3px; }
    .dz-score-btns button {
      appearance:none; border:1px solid var(--dz-border); border-radius:4px;
      background:var(--dz-bg); color:var(--dz-fg);
      padding:2px 8px; font-family:inherit; font-size:12px; font-weight:600;
      cursor:pointer; min-width:34px; text-align:center;
    }
    .dz-score-btns button:hover { border-color:var(--dz-accent); color:var(--dz-accent); }
    .dz-score-btns button.dz-active {
      background:var(--dz-accent); color:#fff; border-color:var(--dz-accent);
    }
    /* 分页内联到顶栏 */
    .dz-pager {
      display:flex; align-items:center; gap:6px;
      margin-left:auto;
    }
    .dz-pager button {
      appearance:none; border:1px solid var(--dz-border); border-radius:5px;
      background:var(--dz-panel2); color:var(--dz-fg);
      padding:4px 10px; font-family:inherit; font-size:13px; cursor:pointer;
      line-height:1.2;
    }
    .dz-pager button:hover:not(:disabled) { border-color:var(--dz-accent); }
    .dz-pager button:disabled { opacity:.3; cursor:not-allowed; }
    .dz-pager .dz-pageinfo {
      color:var(--dz-muted); font-size:11px; font-variant-numeric:tabular-nums;
      white-space:nowrap;
    }
    .dz-rule-btn {
      background:transparent; color:var(--dz-muted);
      border:1px solid var(--dz-border); border-radius:5px;
      padding:4px 10px; font-family:inherit; font-size:12px; cursor:pointer;
    }
    .dz-rule-btn:hover { color:var(--dz-fg); border-color:var(--dz-muted); }
    .dz-close-btn {
      background:var(--dz-danger); color:#2b0a0a; border:0; border-radius:5px;
      padding:5px 12px; font-family:inherit; font-size:12px; font-weight:700; cursor:pointer;
    }

    /* 视口：吃掉剩余全部高度 */
    .dz-viewport {
      display:grid; grid-template-columns:1fr 1fr; gap:var(--dz-gap);
      padding:var(--dz-gap); min-height:0;
    }
    .dz-cell {
      position:relative; overflow:hidden; min-height:0;
      background:#111; border:1px solid var(--dz-border);
      border-radius:var(--dz-radius);
    }
    .dz-cell-tag {
      position:absolute; top:6px; left:6px; z-index:3;
      background:rgba(20,20,31,.85); color:var(--dz-fg);
      font-size:11px; padding:2px 7px; border-radius:4px;
      border:1px solid var(--dz-border); pointer-events:none;
    }
    .dz-loading {
      position:absolute; inset:0; z-index:2;
      display:flex; align-items:center; justify-content:center;
      color:var(--dz-muted); font-size:13px; background:var(--dz-panel);
      transition:opacity .4s;
    }
    .dz-cell.dz-ready .dz-loading { opacity:0; pointer-events:none; }
    .dz-cell iframe {
      display:block; border:0; background:#000;
      width: calc(100% / var(--dz-scale, 0.5));
      height: calc(100% / var(--dz-scale, 0.5));
      transform: scale(var(--dz-scale, 0.5));
      transform-origin: 0 0;
      pointer-events: auto;
    }

    /* toast：浮动于视口顶部中央，3秒自动消失，不占布局 */
    #dz-toast {
      position:fixed; top:64px; left:50%; transform:translateX(-50%);
      z-index:2147483003;
      background:var(--dz-panel); color:var(--dz-fg);
      border:1px solid var(--dz-border); border-radius:6px;
      padding:6px 14px; font-family:var(--dz-font); font-size:12px;
      box-shadow:0 4px 16px rgba(0,0,0,.4);
      opacity:0; transition:opacity .2s ease; pointer-events:none;
    }
    #dz-toast.dz-show { opacity:1; }
    #dz-toast .dz-ok  { color:var(--dz-good); }
    #dz-toast .dz-bad { color:var(--dz-danger); }

    /* 规则浮层（不变，覆盖式） */
    .dz-rules-overlay {
      position:fixed;
      left:50%; bottom:20px;
      transform:translateX(-50%) translateY(30px);
      width:min(1100px, 94vw);
      background:var(--dz-panel); border:1px solid var(--dz-border);
      border-radius:var(--dz-radius); box-shadow:0 8px 24px rgba(0,0,0,.4);
      transition:transform .22s ease, opacity .22s ease;
      opacity:0; pointer-events:none;
      z-index:2147483002;
    }
    .dz-rules-overlay.dz-open { transform:translateX(-50%) translateY(0); opacity:1; pointer-events:auto; }
    .dz-rules-overlay .dz-rules-handle {
      display:flex; align-items:center; justify-content:space-between;
      padding:5px 12px; background:var(--dz-panel2);
      border-bottom:1px solid var(--dz-border);
      border-radius:var(--dz-radius) var(--dz-radius) 0 0;
      font-size:12px; color:var(--dz-muted); user-select:none;
    }
    .dz-rules-overlay .dz-rules-handle strong { color:var(--dz-accent); }
    .dz-rules-overlay .dz-rules-close {
      background:transparent; border:0; color:var(--dz-muted);
      font-size:14px; cursor:pointer; padding:0 4px;
    }
    .dz-rules-overlay .dz-rules-body {
      padding:10px 14px; max-height:55vh; overflow-y:auto;
      display:grid; grid-template-columns:1fr 1fr; gap:14px;
      font-size:11.5px; line-height:1.6; color:var(--dz-muted);
    }
    .dz-rules-overlay h4 { margin:0 0 4px; font-size:12px; color:var(--dz-accent); font-weight:600; }
    .dz-rules-overlay table { border-collapse:collapse; width:100%; margin:3px 0; }
    .dz-rules-overlay th, .dz-rules-overlay td {
      border:1px solid var(--dz-border); padding:2px 6px;
      text-align:left; vertical-align:top; font-weight:400;
    }
    .dz-rules-overlay th { background:var(--dz-panel2); font-weight:600; font-size:11px; }
    .dz-rules-overlay .dz-rule-note {
      color:var(--dz-accent); font-style:italic; margin:2px 0 4px;
      padding-left:8px; border-left:2px solid var(--dz-accent);
    }
    .dz-rules-overlay .dz-score-table td:first-child { font-weight:700; color:var(--dz-fg); }

    /* 小屏（<1280px）：进一步收紧 */
    @media (max-width: 1279px) {
      .dz-topbar { padding:4px 8px; gap:6px; }
      .dz-heading { font-size:12px; }
      .dz-task-name { max-width:120px; }
      .dz-score-card { padding:2px 6px; }
      .dz-score-btns button { padding:2px 6px; min-width:30px; font-size:11px; }
      .dz-pager button { padding:3px 8px; }
    }
    `;
    document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));

    /* ============================================================
     * toast
     * ============================================================ */
    let toastTimer = null;
    function toast(html) {
        let el = document.getElementById('dz-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dz-toast';
            document.body.appendChild(el);
        }
        el.innerHTML = html;
        el.classList.add('dz-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('dz-show'), 3000);
    }

    /* ============================================================
     * 抓取
     * ============================================================ */
    function collectPreviewLinks() {
        const out = []; const seen = new Set();
        document.querySelectorAll('a[target="_blank"]').forEach((a) => {
            if (a.textContent.trim() !== LINK_TEXT) return;
            const abs = a.href;
            if (!abs || seen.has(abs)) return;
            seen.add(abs);
            const label = (abs.match(/episode\/(\d+)/) || [])[1];
            out.push({ abs, label: label != null ? `#${label}` : '预览' });
        });
        return out;
    }
    function getTaskName() {
        const el = document.querySelector('.studio-toolbar-task-info__name');
        return el ? el.textContent.trim() : '';
    }

    /* ============================================================
     * 评分回写
     * ============================================================ */
    function findByLabelHeuristic(labelText) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (!node.textContent.includes(labelText)) continue;
            let el = node.parentElement;
            for (let up = 0; el && up < 6; up++, el = el.parentElement) {
                for (const inp of el.querySelectorAll('input, textarea')) {
                    if (inp.closest('#dz-overlay')) continue;
                    const rect = inp.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) return inp;
                }
            }
        }
        return null;
    }
    // 回写用完整标签名（原页面上的文本），顶栏只显示短名
    const FULL_LABELS = ['初始物体摆放多样性', '初始姿态多样性'];
    function findScoreInput(idx) {
        if (TARGET_SELECTORS[idx]) {
            const el = document.querySelector(TARGET_SELECTORS[idx]);
            if (el) return el;
        }
        return findByLabelHeuristic(FULL_LABELS[idx]);
    }
    function setNativeValue(el, value) {
        const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /* ============================================================
     * 规则内容
     * ============================================================ */
    const RULES_HTML = `
    <div>
      <h4>初始物体摆放多样性</h4>
      <table>
        <tr><th>多样性低</th><th>多样性高</th></tr>
        <tr><td>轻微移动或角度变化</td><td>主要杂物从一个区域换到另一个区域</td></tr>
        <tr><td>只调整一个不起眼的小物体</td><td>物体关系明显变化（并排→分散、堆叠→平铺）</td></tr>
        <tr><td>仅有光线变化</td><td>杂物种类、数量或状态明显变化</td></tr>
        <tr><td>目标物因完成任务自然变化</td><td>遮挡关系或整体布局明显变化</td></tr>
      </table>
      <div class="dz-rule-note">挪了一点 = 一种方案；一眼不同 = 不同方案</div>
      <table class="dz-score-table">
        <tr><td>30分</td><td>1～2种</td><td>大部分基本相同</td></tr>
        <tr><td>60分</td><td>3种</td><td>有一定差异</td></tr>
        <tr><td>90分</td><td>4～5种</td><td>大部分明显不同</td></tr>
      </table>
    </div>
    <div>
      <h4>初始姿态多样性</h4>
      <table>
        <tr><th>多样性低</th><th>多样性高</th></tr>
        <tr><td>初始姿态相同，仅操作误差</td><td>初始位置或姿态明显不同</td></tr>
        <tr><td>速度、幅度或轨迹轻微差别</td><td>接近方向明显不同（上/侧/正面）</td></tr>
      </table>
      <div class="dz-rule-note">同一句话描述动作 = 一种方案；方式或方向明显不同 = 不同方案</div>
      <table class="dz-score-table">
        <tr><td>30分</td><td>1～2种</td><td>大部分基本相同</td></tr>
        <tr><td>60分</td><td>3种</td><td>有一定差异</td></tr>
        <tr><td>90分</td><td>4～5种</td><td>大部分明显不同</td></tr>
      </table>
    </div>
    `;

    /* ============================================================
     * 遮罩
     * ============================================================ */
    const OVERLAY_ID = 'dz-overlay';

    function openOverlay(links) {
        closeOverlay();
        if (!links.length) return;

        const taskName = getTaskName();
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;

        /* 顶栏：标题 | 评分×2 | 分页 | 规则 | 关闭 —— 全部一行 */
        const topbar = document.createElement('div');
        topbar.className = 'dz-topbar';

        const heading = document.createElement('span');
        heading.className = 'dz-heading';
        heading.textContent = `${links.length}条`;
        if (taskName) {
            const tag = document.createElement('span');
            tag.className = 'dz-task-name';
            tag.title = taskName;
            tag.textContent = taskName;
            heading.appendChild(tag);
        }
        topbar.appendChild(heading);

        SCORE_LABELS.forEach((name, i) => {
            const card = document.createElement('div');
            card.className = 'dz-score-card';
            card.title = FULL_LABELS[i];
            card.innerHTML = `<label>${name}</label>`;
            const btns = document.createElement('div');
            btns.className = 'dz-score-btns';
            SCORES.forEach((v) => {
                const btn = document.createElement('button');
                btn.textContent = v;
                btn.addEventListener('click', () => {
                    if (btn.classList.contains('dz-active')) {
                        btn.classList.remove('dz-active');
                        toast(`已取消「${FULL_LABELS[i]}」评分`);
                    } else {
                        btns.querySelectorAll('button').forEach((b) => b.classList.remove('dz-active'));
                        btn.classList.add('dz-active');
                        writeBack(i, String(v));
                    }
                });
                btns.appendChild(btn);
            });
            card.appendChild(btns);
            topbar.appendChild(card);
        });

        /* 分页（内联顶栏右侧） */
        const totalPages = Math.ceil(links.length / PER_PAGE);
        let page = 0;
        const pager = document.createElement('div');
        pager.className = 'dz-pager';
        pager.innerHTML = `
          <button class="dz-prev" title="上一页 (←)">←</button>
          <span class="dz-pageinfo">1/${totalPages}</span>
          <button class="dz-next" title="下一页 (→)">→</button>
        `;
        topbar.appendChild(pager);
        const $prev = pager.querySelector('.dz-prev');
        const $next = pager.querySelector('.dz-next');
        const $info = pager.querySelector('.dz-pageinfo');

        /* 规则按钮 */
        const ruleBtn = document.createElement('button');
        ruleBtn.className = 'dz-rule-btn';
        ruleBtn.textContent = '📖';
        ruleBtn.title = '评分规则';
        topbar.appendChild(ruleBtn);

        /* 关闭按钮 */
        const closeBtn = document.createElement('button');
        closeBtn.className = 'dz-close-btn';
        closeBtn.textContent = '✕';
        closeBtn.title = '关闭 (Esc)';
        topbar.appendChild(closeBtn);

        overlay.appendChild(topbar);

        /* 视口 */
        const viewport = document.createElement('div');
        viewport.className = 'dz-viewport';
        const cells = links.map((lk) => {
            const cell = document.createElement('div');
            cell.className = 'dz-cell';
            cell.style.display = 'none';
            cell.innerHTML = `<span class="dz-cell-tag">EP ${lk.label}</span>
                              <div class="dz-loading">加载中…</div>`;
            const iframe = document.createElement('iframe');
            iframe.src = lk.abs;
            iframe.allow = 'autoplay';
            iframe.addEventListener('load', () => cell.classList.add('dz-ready'), { once: true });
            cell.appendChild(iframe);
            viewport.appendChild(cell);
            return cell;
        });
        overlay.appendChild(viewport);
        document.body.appendChild(overlay);

        function showPage(p) {
            page = Math.max(0, Math.min(totalPages - 1, p));
            cells.forEach((c, i) => {
                c.style.display = (i >= page * PER_PAGE && i < (page + 1) * PER_PAGE) ? '' : 'none';
            });
            $prev.disabled = page === 0;
            $next.disabled = page === totalPages - 1;
            $info.textContent = `${page + 1}/${totalPages}`;
        }
        $prev.addEventListener('click', () => showPage(page - 1));
        $next.addEventListener('click', () => showPage(page + 1));

        /* 规则浮层 */
        const rules = document.createElement('div');
        rules.className = 'dz-rules-overlay';
        rules.innerHTML = `
          <div class="dz-rules-handle">
            <span><strong>📖 评分规则</strong></span>
            <button class="dz-rules-close">✕</button>
          </div>
          <div class="dz-rules-body">${RULES_HTML}</div>
        `;
        document.body.appendChild(rules);
        ruleBtn.addEventListener('click', () => rules.classList.toggle('dz-open'));
        rules.querySelector('.dz-rules-handle').addEventListener('click', (e) => {
            if (e.target.classList.contains('dz-rules-close')) rules.classList.remove('dz-open');
        });

        /* 关闭 */
        const doClose = () => {
            overlay.remove(); rules.remove();
            document.removeEventListener('keydown', onKey);
        };
        const onKey = (e) => {
            if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
                if (e.key === 'Escape') doClose();
                return;
            }
            if (e.key === 'Escape') doClose();
            if (e.key === 'ArrowLeft')  showPage(page - 1);
            if (e.key === 'ArrowRight') showPage(page + 1);
        };
        closeBtn.addEventListener('click', doClose);
        document.addEventListener('keydown', onKey);

        showPage(0);
    }

    function writeBack(idx, value) {
        const target = findScoreInput(idx);
        if (!target) {
            toast(`<span class="dz-bad">未找到「${FULL_LABELS[idx]}」输入框，请填 TARGET_SELECTORS[${idx}]</span>`);
            return;
        }
        try {
            setNativeValue(target, value);
            toast(`<span class="dz-ok">✓</span> ${FULL_LABELS[idx]} = ${value}`);
        } catch (err) {
            toast(`<span class="dz-bad">写入失败：${err.message}</span>`);
        }
    }

    function closeOverlay() {
        document.getElementById(OVERLAY_ID)?.remove();
        document.querySelector('.dz-rules-overlay')?.remove();
    }

    /* ============================================================
     * 启动器
     * ============================================================ */
    const LAUNCHER_ID = 'dz-launcher';
    function buildLauncher() {
        document.getElementById(LAUNCHER_ID)?.remove();
        const bar = document.createElement('div');
        bar.id = LAUNCHER_ID;
        bar.innerHTML = `
          <span class="dz-cnt">预览：<b class="dz-n">0</b></span>
          <button class="dz-open">开始评审</button>
        `;
        document.body.appendChild(bar);
        const $n = bar.querySelector('.dz-n');
        const $btn = bar.querySelector('.dz-open');
        const refresh = () => {
            const n = collectPreviewLinks().length;
            $n.textContent = n; $btn.disabled = n === 0;
        };
        $btn.addEventListener('click', () => openOverlay(collectPreviewLinks()));
        let scheduled = false;
        const obs = new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                obs.disconnect(); refresh();
                obs.observe(document.body, { childList: true, subtree: true });
            });
        });
        obs.observe(document.body, { childList: true, subtree: true });
        refresh();
    }

    function boot() { if (!document.getElementById(LAUNCHER_ID)) buildLauncher(); }
    boot();
    let lastHref = location.href;
    setInterval(() => {
        if (location.href !== lastHref) {
            lastHref = location.href;
            closeOverlay(); boot();
        }
    }, 1000);
})();
