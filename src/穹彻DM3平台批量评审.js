// ==UserScript==
// @name         穹彻DM3平台批量评审
// @namespace    https://dm3.noematrix.cn/
// @version      4.9.1
// @description  3×2 六宫格；inspect 页自动开；123/456 打分；Enter 提交；空格循环前N秒；进度条可见
// @author       You
// @match        https://dm3.noematrix.cn/dq/studio/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

// 副作用：
// - 读 DOM：a[target="_blank"][href*="/episode/"] / .dq-scoring-form__dimension input / .studio-toolbar-task-info__name
// - 写 DOM（顶层）：注入 #dz-launcher / #dz-overlay / #dz-toast / .dz-rules-overlay 及一段 <style>
// - 写 DOM（同源 iframe 内，跨 document）：
//     · 隐藏 .dq-studio-toolbar-card / .episode-player-fallback__alert
//     · 注入 #dz-iframe-fill <style> 让 canvas 撑满、进度条留在底部
//     · 在子文档挂 pointerdown 监听（把键盘焦点拉回顶层）
//     · 模拟进度条/播放按钮点击（pointerdown/mousedown/mouseup/click）以实现 "循环前 N 秒"
// - 焦点操作：打开 overlay 时 window.focus() + overlay.focus()；点击 iframe 后重新聚焦顶层
// - 内嵌 iframe：每个预览链接一个 iframe 至 dm3.noematrix.cn/dq/studio/*/episode*
// - 会点击顶层「提交质检」按钮（Enter 或 overlay 按钮）
// - 无自建网络请求；不读写 GM_setValue / localStorage
// - 仅在顶层帧运行（@noframes + 运行时双保险）
// - 调试命名空间：window.__dzReview_debug__（可 delete 清理）
// - 卸载入口：window.__dzReview_teardown__()
// - 未使用 unsafeWindow；无 eval

// 控制台定位本脚本问题：
// 1. F12 → Console → 过滤框输入 [dz-review]
// 2. 展开红色 error 行堆栈，点击跳到 Sources 对应行
// 3. 在 openOverlay / collectPreviewLinks / pickScore / submitAll 处下断点
// 4. 检查内部状态：Console 输入 __dzReview_debug__.state

(function () {
    'use strict';
    const TAG = '[dz-review]';

    if (window.top !== window.self) return;

    const debug = (window.__dzReview_debug__ = {
        state: {
            links: 0, route: location.href, scores: [null, null],
            stripStats: {}, autoOpened: false, focusCount: 0,
            loopSec: 5, isLooping: false, loopingIframes: 0,
        },
        log: (...a) => console.debug(TAG, ...a),
        warn: (...a) => console.warn(TAG, ...a),
        error: (...a) => console.error(TAG, ...a),
    });
    if (window.__dzReview_loaded__) { debug.warn('already loaded, skip'); return; }
    window.__dzReview_loaded__ = true;

    if (/\/episode(\/\d+)?\/?$/.test(location.pathname)) return;

    /* ============================================================
     * 配置
     * ============================================================ */
    const DEFAULT_SCORES = [30, 30];
    const SCORE_LABELS   = ['物体摆放', '初始姿态'];
    const FULL_LABELS    = ['初始物体摆放多样性', '初始姿态多样性'];
    const SCORES         = [30, 60, 100];
    const LINK_TEXT      = '打开预览';
    const COLS = 3, ROWS = 2, SLOTS = COLS * ROWS;

    const DEFAULT_LOOP_SEC = 5;
    const LOOP_SEC_MIN = 1;
    const LOOP_SEC_MAX = 60;

    /* iframe 内要隐藏的 "无关组件"（不含进度条本身） */
    const IFRAME_HIDE_SELECTORS = [
        '.dq-studio-toolbar-card',                 // 视频页自己的顶栏卡
        '.episode-player-fallback__alert',         // "已自动降级为 RRD" 的 banner
    ];
    const IFRAME_FILL = true;
    /* [失效条件] 若站点换 class 前缀（Noematrix-*），这些选择器要同步改 */
        const IFRAME_FILL_CSS = `
    html,body,#root{height:100% !important;overflow:hidden !important;background:#000 !important;}
    .dq-episode-viewer-root{padding:0 !important;}
    .dq-episode-viewer-body,
    .dq-episode-viewer-playback-wrap,
    .episode-player-fallback,
    .episode-player-fallback__player,
    .Noematrix-studio-body,
    .Noematrix-studio-body__spin,
    .Noematrix-studio-body__spin > .ant-spin-container,
    .Noematrix-rerun-io-content{
      height:100% !important;
      min-height:0 !important;
      max-height:100% !important;
      padding:0 !important;
      margin:0 !important;
    }
    .Noematrix-rerun-io-content{
      display:flex !important;
      flex-direction:column !important;
    }
    .Noematrix-rerun-io-content-canvas{
      flex:1 1 auto !important;
      min-height:0 !important;
      overflow:hidden !important;
    }
    .Noematrix-rerun-io-content-canvas > div{
      height:100% !important;
    }
    /* 关键：进度条整条钉死 44px，内部一切 overflow 裁掉，消除默认留白 */
    .Noematrix-time-controller.Noematrix-time-controller--player{
      flex:0 0 44px !important;
      height:44px !important;
      max-height:44px !important;
      min-height:0 !important;
      padding:0 !important;
      margin:0 !important;
      overflow:hidden !important;
      background:#000 !important;
    }
    .Noematrix-time-controller.Noematrix-time-controller--player > *,
    .NmProgressPlayer,
    .NmProgressPlayer__shell{
      height:44px !important;
      max-height:44px !important;
      min-height:0 !important;
      padding:0 !important;
      margin:0 !important;
      box-sizing:border-box !important;
    }
    .NmProgressPlayer__shell{
      display:flex !important;
      align-items:center !important;
      width:100% !important;
    }
    .NmProgressPlayer__card{
      width:100% !important;
      height:44px !important;
      max-height:44px !important;
      display:flex !important;
      align-items:center !important;
      gap:8px !important;
      padding:0 10px !important;
      margin:0 !important;
      box-sizing:border-box !important;
    }
    .NmProgressPlayer__card > *{margin:0 !important;}
    .NmProgressPlayer__trackWrap{flex:1 1 auto !important;}
    /* 兜底：消任何伪元素空白 */
    .Noematrix-time-controller--player *::before,
    .Noematrix-time-controller--player *::after{display:none !important;}
    `;

    const AUTO_OPEN_PATH  = /^\/dq\/studio\/\d+\/?$/;
    const AUTO_OPEN_PARAM = 'inspect';

    /* ============================================================
     * 样式
     * ============================================================ */
    const CSS = `
    :root{
      --dz-bg:#14141f;--dz-panel:#1e1e2e;--dz-panel2:#262637;
      --dz-fg:#e8e8f2;--dz-muted:#9a9ab2;--dz-accent:#4c9aff;
      --dz-good:#7ee2a8;--dz-danger:#ff7875;--dz-warn:#ffb347;--dz-border:#33334a;
      --dz-radius:8px;--dz-gap:6px;
      --dz-font:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    }
    #dz-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;
      background:var(--dz-panel);color:var(--dz-fg);font-family:var(--dz-font);font-size:13px;
      padding:12px 16px;border-radius:var(--dz-radius);box-shadow:0 8px 24px rgba(0,0,0,.35);
      display:flex;align-items:center;gap:10px;user-select:none}
    #dz-launcher .dz-cnt{color:var(--dz-muted);font-variant-numeric:tabular-nums}
    #dz-launcher b{color:var(--dz-fg)}
    #dz-launcher button{appearance:none;border:0;border-radius:6px;padding:8px 14px;
      font-family:inherit;font-size:13px;font-weight:600;background:var(--dz-accent);color:#fff;cursor:pointer}
    #dz-launcher button:hover{filter:brightness(1.12)}
    #dz-launcher button:disabled{filter:grayscale(.7) brightness(.7);cursor:not-allowed}

    #dz-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(10,10,18,.97);
      display:grid;grid-template-rows:auto 1fr;font-family:var(--dz-font);color:var(--dz-fg);outline:none}
    #dz-overlay:focus{outline:none}

    .dz-topbar{display:flex;align-items:center;gap:var(--dz-gap);padding:6px 10px;
      background:var(--dz-panel);border-bottom:1px solid var(--dz-border);flex-wrap:wrap}
    .dz-heading{font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px}
    .dz-task-name{font-weight:400;font-size:11px;color:var(--dz-accent);background:var(--dz-panel2);
      padding:2px 6px;border-radius:4px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    .dz-score-card{background:var(--dz-panel2);border-radius:5px;padding:3px 8px;
      display:flex;align-items:center;gap:6px}
    .dz-score-card label{font-size:11px;color:var(--dz-muted);white-space:nowrap}
    .dz-score-btns{display:flex;gap:3px}
    .dz-score-btns button{appearance:none;border:1px solid var(--dz-border);border-radius:4px;
      background:var(--dz-bg);color:var(--dz-fg);padding:2px 8px;font-family:inherit;font-size:12px;
      font-weight:600;cursor:pointer;min-width:38px;text-align:center}
    .dz-score-btns button:hover{border-color:var(--dz-accent);color:var(--dz-accent)}
    .dz-score-btns button.dz-active{background:var(--dz-accent);color:#fff;border-color:var(--dz-accent)}
    .dz-kbd{font-size:10px;color:var(--dz-muted);margin-left:2px}

    .dz-loop-card{background:var(--dz-panel2);border-radius:5px;padding:3px 8px;
      display:flex;align-items:center;gap:4px}
    .dz-loop-card label{font-size:11px;color:var(--dz-muted);white-space:nowrap}
    .dz-loop-card input{width:40px;background:var(--dz-bg);color:var(--dz-fg);
      border:1px solid var(--dz-border);border-radius:4px;padding:1px 4px;font:inherit;font-size:12px;
      text-align:center;appearance:textfield;-moz-appearance:textfield}
    .dz-loop-card input::-webkit-outer-spin-button,
    .dz-loop-card input::-webkit-inner-spin-button{appearance:none;margin:0}
    .dz-loop-card .dz-loop-toggle{appearance:none;border:1px solid var(--dz-border);border-radius:4px;
      background:var(--dz-bg);color:var(--dz-fg);padding:2px 8px;font:inherit;font-size:12px;
      font-weight:600;cursor:pointer;white-space:nowrap}
    .dz-loop-card .dz-loop-toggle:hover{border-color:var(--dz-accent);color:var(--dz-accent)}
    .dz-loop-card .dz-loop-toggle.dz-active{background:var(--dz-good);color:#102418;border-color:var(--dz-good)}

    .dz-action-btn{background:var(--dz-accent);color:#fff;border:0;border-radius:5px;
      padding:5px 14px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;margin-left:auto}
    .dz-action-btn:hover{filter:brightness(1.12)}
    .dz-rule-btn{background:transparent;color:var(--dz-muted);border:1px solid var(--dz-border);
      border-radius:5px;padding:4px 10px;font-family:inherit;font-size:12px;cursor:pointer}
    .dz-rule-btn:hover{color:var(--dz-fg);border-color:var(--dz-muted)}
    .dz-close-btn{background:var(--dz-danger);color:#2b0a0a;border:0;border-radius:5px;
      padding:5px 12px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer}

    .dz-viewport{display:grid;grid-template-columns:repeat(${COLS},1fr);grid-template-rows:repeat(${ROWS},1fr);
      gap:var(--dz-gap);padding:var(--dz-gap);min-height:0}
    .dz-cell{position:relative;overflow:hidden;min-height:0;background:#0b0b12;
      border:1px solid var(--dz-border);border-radius:var(--dz-radius)}
    .dz-cell-tag{position:absolute;top:4px;left:4px;z-index:3;background:rgba(20,20,31,.85);
      color:var(--dz-fg);font-size:10px;padding:1px 6px;border-radius:4px;
      border:1px solid var(--dz-border);pointer-events:none}
    .dz-cell-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      color:#3a3a4a;font-size:12px}
    .dz-loading{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;
      color:var(--dz-muted);font-size:12px;background:var(--dz-panel);transition:opacity .4s}
    .dz-cell.dz-ready .dz-loading{opacity:0;pointer-events:none}
    .dz-cell iframe{display:block;border:0;background:#000;
      width:calc(100% / var(--dz-scale,.5));height:calc(100% / var(--dz-scale,.5));
      transform:scale(var(--dz-scale,.5));transform-origin:0 0;pointer-events:auto}

    #dz-toast{position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:2147483003;
      background:var(--dz-panel);color:var(--dz-fg);border:1px solid var(--dz-border);border-radius:6px;
      padding:6px 14px;font-family:var(--dz-font);font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.4);
      opacity:0;transition:opacity .2s ease;pointer-events:none}
    #dz-toast.dz-show{opacity:1}
    #dz-toast .dz-ok{color:var(--dz-good)} #dz-toast .dz-bad{color:var(--dz-danger)}

    .dz-rules-overlay{position:fixed;left:50%;bottom:20px;transform:translateX(-50%) translateY(30px);
      width:min(1100px,94vw);background:var(--dz-panel);border:1px solid var(--dz-border);
      border-radius:var(--dz-radius);box-shadow:0 8px 24px rgba(0,0,0,.4);
      transition:transform .22s ease,opacity .22s ease;opacity:0;pointer-events:none;z-index:2147483002}
    .dz-rules-overlay.dz-open{transform:translateX(-50%) translateY(0);opacity:1;pointer-events:auto}
    .dz-rules-overlay .dz-rules-handle{display:flex;align-items:center;justify-content:space-between;
      padding:5px 12px;background:var(--dz-panel2);border-bottom:1px solid var(--dz-border);
      border-radius:var(--dz-radius) var(--dz-radius) 0 0;font-size:12px;color:var(--dz-muted);user-select:none}
    .dz-rules-overlay .dz-rules-handle strong{color:var(--dz-accent)}
    .dz-rules-overlay .dz-rules-close{background:transparent;border:0;color:var(--dz-muted);
      font-size:14px;cursor:pointer;padding:0 4px}
    .dz-rules-overlay .dz-rules-body{padding:10px 14px;max-height:55vh;overflow-y:auto;
      display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:11.5px;line-height:1.6;color:var(--dz-muted)}
    .dz-rules-overlay h4{margin:0 0 4px;font-size:12px;color:var(--dz-accent);font-weight:600}
    .dz-rules-overlay table{border-collapse:collapse;width:100%;margin:3px 0}
    .dz-rules-overlay th,.dz-rules-overlay td{border:1px solid var(--dz-border);
      padding:2px 6px;text-align:left;vertical-align:top;font-weight:400}
    .dz-rules-overlay th{background:var(--dz-panel2);font-weight:600;font-size:11px}
    .dz-rules-overlay .dz-rule-note{color:var(--dz-accent);font-style:italic;margin:2px 0 4px;
      padding-left:8px;border-left:2px solid var(--dz-accent)}
    .dz-rules-overlay .dz-score-table td:first-child{font-weight:700;color:var(--dz-fg)}
    `;
    document.head.appendChild(Object.assign(document.createElement('style'), { id: 'dz-style', textContent: CSS }));

    /* ============================================================
     * 工具
     * ============================================================ */
    let toastTimer = null;
    function toast(html) {
        let el = document.getElementById('dz-toast');
        if (!el) { el = document.createElement('div'); el.id = 'dz-toast'; document.body.appendChild(el); }
        el.innerHTML = html;
        el.classList.add('dz-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('dz-show'), 3000);
    }
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function focusOverlay(overlay) {
        if (!overlay || !overlay.isConnected) return;
        try { window.focus(); } catch (err) { debug.warn('window.focus failed', err); }
        const ae = document.activeElement;
        if (ae && ae.tagName === 'IFRAME') {
            try { ae.blur(); } catch (err) { debug.warn('iframe blur failed', err); }
        }
        try { overlay.focus({ preventScroll: true }); } catch (err) { debug.warn('overlay.focus failed', err); }
        debug.state.focusCount++;
    }

    function waitInDoc(doc, selector, timeout = 8000) {
        return new Promise((resolve) => {
            const hit = doc.querySelector(selector);
            if (hit) return resolve(hit);
            let done = false;
            const ob = new MutationObserver(() => {
                const el = doc.querySelector(selector);
                if (el && !done) { done = true; ob.disconnect(); clearTimeout(timer); resolve(el); }
            });
            try { ob.observe(doc.documentElement || doc, { childList: true, subtree: true }); }
            catch (err) { debug.warn('waitInDoc observe failed', err); }
            const timer = setTimeout(() => {
                if (done) return;
                done = true; ob.disconnect();
                debug.warn('waitInDoc timeout', selector);
                resolve(null);
            }, timeout);
        });
    }

    /* ============================================================
     * 顶层抓取
     * ============================================================ */
    function collectPreviewLinks() {
        const out = []; const seen = new Set();
        document.querySelectorAll('a[target="_blank"][href*="/episode/"]').forEach((a) => {
            if (a.textContent.trim() !== LINK_TEXT) return;
            const abs = a.href;
            if (!abs || seen.has(abs)) return;
            seen.add(abs);
            const label = (abs.match(/episode\/(\d+)/) || [])[1];
            out.push({ abs, label: label != null ? label : '?' });
        });
        debug.log('collectPreviewLinks →', out.length);
        return out;
    }
    function getTaskName() {
        const el = document.querySelector('.studio-toolbar-task-info__name');
        return el ? el.textContent.trim() : '';
    }

    /* ============================================================
     * 评分回写
     * ============================================================ */
    const FORM_SELECTOR = '.dq-scoring-form__dimension input.ant-input-number-input';

    function findScoreInput(idx) {
        const list = document.querySelectorAll(FORM_SELECTOR);
        const el = list[idx];
        if (!el) { debug.warn('findScoreInput miss', idx, 'total:', list.length); return null; }
        return el;
    }
    function setNativeValue(el, value) {
        const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (!desc || !desc.set) throw new Error('native value setter not found');
        desc.set.call(el, value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function writeBack(idx, value) {
        const target = findScoreInput(idx);
        if (!target) {
            toast(`<span class="dz-bad">未找到「${escapeHtml(FULL_LABELS[idx])}」输入框</span>`);
            return;
        }
        try {
            setNativeValue(target, value);
            toast(`<span class="dz-ok">✓</span> ${escapeHtml(FULL_LABELS[idx])} = ${escapeHtml(value)}`);
        } catch (err) {
            debug.error('writeBack failed', err);
            toast(`<span class="dz-bad">写入失败：${escapeHtml(err && err.message || String(err))}</span>`);
        }
    }

    function findSubmitButton() {
        const tb = document.querySelector('.dq-studio-toolbar-actions button.ant-btn-primary');
        if (tb && tb.textContent.includes('提交质检')) return tb;
        for (const b of document.querySelectorAll('button')) {
            if (b.textContent.trim() === '提交质检') return b;
        }
        debug.warn('submit button not found');
        return null;
    }

    /* ============================================================
     * iframe 内：播放器控制（canvas RRD 播放器）
     * ============================================================ */
    const PLAY_BTN_SEL = '.NmProgressPlayer__play button';
    const TRACK_SEL    = '.NmProgressPlayer__trackWrap';

    function clickPlayBtn(doc) {
        const btn = doc.querySelector(PLAY_BTN_SEL);
        if (!btn) { debug.warn('play button missing'); return false; }
        btn.click();
        return true;
    }

    /* 在 slider 上按 ratio（0~1）位置模拟点击，覆盖 pointer/mouse 两套事件 */
    function clickTrackAtRatio(doc, ratio) {
        const track = doc.querySelector(TRACK_SEL);
        if (!track) { debug.warn('track missing'); return false; }
        const rect = track.getBoundingClientRect();
        if (rect.width === 0) { debug.warn('track rect width=0'); return false; }
        const x = Math.round(rect.left + Math.max(2, rect.width * ratio));
        const y = Math.round(rect.top + rect.height / 2);
        const win = doc.defaultView;
        const opts = { bubbles: true, cancelable: true, composed: true,
            clientX: x, clientY: y, screenX: x, screenY: y,
            button: 0, buttons: 1, view: win };
        const pOpts = { ...opts, pointerType: 'mouse', pointerId: 1, isPrimary: true };
        try { track.dispatchEvent(new PointerEvent('pointerdown', pOpts)); } catch (err) { debug.warn('pd', err); }
        try { track.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (err) { debug.warn('md', err); }
        try { track.dispatchEvent(new PointerEvent('pointerup', pOpts)); } catch (err) { debug.warn('pu', err); }
        try { track.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (err) { debug.warn('mu', err); }
        try { track.dispatchEvent(new MouseEvent('click', opts)); } catch (err) { debug.warn('clk', err); }
        return true;
    }

    /* 对单个 iframe 启动"循环前 N 秒"：先回起点→等一点点→播放→setInterval */
    function startLoopOne(iframe, loopSec) {
        const doc = (() => { try { return iframe.contentDocument; } catch (_) { return null; } })();
        if (!doc) return false;
        if (iframe.__dzLoopTimer) { clearInterval(iframe.__dzLoopTimer); iframe.__dzLoopTimer = null; }
        clickTrackAtRatio(doc, 0);
        setTimeout(() => clickPlayBtn(doc), 60);
        iframe.__dzLoopTimer = setInterval(() => {
            try {
                const d = iframe.contentDocument;
                if (!d) return;
                clickTrackAtRatio(d, 0);
                /* 保险：若 slider 跳 0 导致播放器自动暂停，再点一次播放
                   [失效条件] 若 slider 跳 0 不触发暂停，这里的 click 会把它暂停 → 需关掉下一行 */
                // setTimeout(() => clickPlayBtn(d), 60);
            } catch (err) { debug.warn('loop tick failed', err); }
        }, Math.max(1, loopSec) * 1000);
        return true;
    }
    function stopLoopOne(iframe) {
        if (iframe.__dzLoopTimer) {
            clearInterval(iframe.__dzLoopTimer);
            iframe.__dzLoopTimer = null;
        }
        const doc = (() => { try { return iframe.contentDocument; } catch (_) { return null; } })();
        if (!doc) return;
        /* 用户要求"再按一次直接到起点"——只回起点，不动播放状态 */
        clickTrackAtRatio(doc, 0);
    }
    function stopLoopAll() {
        document.querySelectorAll('#dz-overlay iframe').forEach((f) => stopLoopOne(f));
        debug.state.isLooping = false;
        debug.state.loopingIframes = 0;
    }
    function startLoopAll(loopSec) {
        let n = 0;
        document.querySelectorAll('#dz-overlay iframe').forEach((f) => {
            if (startLoopOne(f, loopSec)) n++;
        });
        debug.state.isLooping = n > 0;
        debug.state.loopingIframes = n;
        debug.state.loopSec = loopSec;
        return n;
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
        <tr><td>100分</td><td>4～5种</td><td>大部分明显不同</td></tr>
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
        <tr><td>100分</td><td>4～5种</td><td>大部分明显不同</td></tr>
      </table>
    </div>
    `;

    /* ============================================================
     * iframe 内清理 + 焦点回夺
     * ============================================================ */
    function injectIframeFillCss(doc) {
        if (!IFRAME_FILL) return;
        const ID = 'dz-iframe-fill';
        if (doc.getElementById(ID)) return;
        try {
            const st = doc.createElement('style');
            st.id = ID;
            st.textContent = IFRAME_FILL_CSS;
            (doc.head || doc.documentElement).appendChild(st);
        } catch (err) {
            debug.warn('injectIframeFillCss failed', err);
        }
    }

    async function stripIframeNoise(iframe, getOverlay) {
        let doc = null;
        try { doc = iframe.contentDocument; }
        catch (err) { debug.error('contentDocument access denied', iframe.src, err); return; }
        if (!doc) { debug.warn('contentDocument null', iframe.src); return; }

        await waitInDoc(doc, 'body', 8000);

        const stats = {};
        const hideAll = () => {
            for (const sel of IFRAME_HIDE_SELECTORS) {
                let list;
                try { list = doc.querySelectorAll(sel); }
                catch (err) { debug.warn('bad selector in iframe', sel, err); continue; }
                list.forEach((el) => {
                    if (el.style.display !== 'none') {
                        el.style.display = 'none';
                        stats[sel] = (stats[sel] || 0) + 1;
                    }
                });
            }
        };

        hideAll();
        injectIframeFillCss(doc);

        const obs = new MutationObserver(() => { hideAll(); });
        try { obs.observe(doc.documentElement || doc, { childList: true, subtree: true }); }
        catch (err) { debug.warn('observe iframe doc failed', err); }
        setTimeout(() => { obs.disconnect(); }, 30000);

        const onIframePointerDown = () => {
            const overlay = getOverlay();
            if (!overlay) return;
            setTimeout(() => focusOverlay(overlay), 0);
        };
        try { doc.addEventListener('pointerdown', onIframePointerDown, true); }
        catch (err) { debug.warn('attach iframe pointerdown failed', err); }
        iframe.__dzCleanup = () => {
            try { doc.removeEventListener('pointerdown', onIframePointerDown, true); }
            catch (err) { debug.warn('remove iframe pointerdown failed', err); }
            if (iframe.__dzLoopTimer) { clearInterval(iframe.__dzLoopTimer); iframe.__dzLoopTimer = null; }
        };

        debug.state.stripStats[iframe.src] = stats;
        debug.log('stripIframeNoise', iframe.src, stats);
    }

    /* ============================================================
     * overlay
     * ============================================================ */
    const OVERLAY_ID = 'dz-overlay';

    function openOverlay(links) {
        closeOverlay();
        if (!links.length) {
            toast(`<span class="dz-bad">未找到预览链接</span>`);
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.tabIndex = -1;
        const getOverlay = () => document.getElementById(OVERLAY_ID);

        /* --- 顶栏 --- */
        const topbar = document.createElement('div');
        topbar.className = 'dz-topbar';

        const heading = document.createElement('span');
        heading.className = 'dz-heading';
        heading.textContent = `${links.length}条`;
        const taskName = getTaskName();
        if (taskName) {
            const tag = document.createElement('span');
            tag.className = 'dz-task-name';
            tag.title = taskName;
            tag.textContent = taskName;
            heading.appendChild(tag);
        }
        topbar.appendChild(heading);

        const scoreCards = [];
        SCORE_LABELS.forEach((name, i) => {
            const card = document.createElement('div');
            card.className = 'dz-score-card';
            card.title = FULL_LABELS[i];
            card.innerHTML = `<label>${escapeHtml(name)}</label>`;
            const btns = document.createElement('div');
            btns.className = 'dz-score-btns';
            SCORES.forEach((v, j) => {
                const btn = document.createElement('button');
                btn.dataset.val = v;
                btn.textContent = v;
                btn.title = `快捷键 ${i === 0 ? j + 1 : j + 4}`;
                btn.addEventListener('click', () => pickScore(i, j));
                btns.appendChild(btn);
            });
            card.appendChild(btns);
            const kbd = document.createElement('span');
            kbd.className = 'dz-kbd';
            kbd.textContent = i === 0 ? '(1/2/3)' : '(4/5/6)';
            card.appendChild(kbd);
            topbar.appendChild(card);
            scoreCards.push(btns);
        });

        /* --- 循环控制卡 --- */
        const loopCard = document.createElement('div');
        loopCard.className = 'dz-loop-card';
        loopCard.innerHTML = `
          <label>循环前</label>
          <input type="number" class="dz-loop-sec" min="${LOOP_SEC_MIN}" max="${LOOP_SEC_MAX}" step="1" value="${DEFAULT_LOOP_SEC}">
          <label>s</label>
          <button class="dz-loop-toggle" title="空格键切换">▶ 空格</button>
        `;
        topbar.appendChild(loopCard);
        const $loopSec = loopCard.querySelector('.dz-loop-sec');
        const $loopToggle = loopCard.querySelector('.dz-loop-toggle');

        /* --- 提交按钮 --- */
        const submitOverlayBtn = document.createElement('button');
        submitOverlayBtn.className = 'dz-action-btn';
        submitOverlayBtn.textContent = '提交质检 ↵';
        submitOverlayBtn.title = 'Enter 提交';
        topbar.appendChild(submitOverlayBtn);

        const ruleBtn = document.createElement('button');
        ruleBtn.className = 'dz-rule-btn';
        ruleBtn.textContent = '📖';
        ruleBtn.title = '评分规则';
        topbar.appendChild(ruleBtn);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'dz-close-btn';
        closeBtn.textContent = '✕';
        closeBtn.title = '关闭 (Esc)';
        topbar.appendChild(closeBtn);

        overlay.appendChild(topbar);

        /* --- 3×2 视口 --- */
        const viewport = document.createElement('div');
        viewport.className = 'dz-viewport';
        for (let slot = 0; slot < SLOTS; slot++) {
            const cell = document.createElement('div');
            cell.className = 'dz-cell';
            const lk = links[slot];
            if (!lk) {
                cell.innerHTML = `<div class="dz-cell-empty">— 空 —</div>`;
                viewport.appendChild(cell);
                continue;
            }
            cell.innerHTML = `<span class="dz-cell-tag">EP ${escapeHtml(lk.label)}</span>
                              <div class="dz-loading">加载中…</div>`;
            const iframe = document.createElement('iframe');
            iframe.src = lk.abs;
            iframe.allow = 'autoplay';
            iframe.addEventListener('load', () => {
                cell.classList.add('dz-ready');
                stripIframeNoise(iframe, getOverlay);
            });
            cell.appendChild(iframe);
            viewport.appendChild(cell);
        }
        overlay.appendChild(viewport);
        document.body.appendChild(overlay);

        /* --- 规则浮层 --- */
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

        /* --- 评分 --- */
        function renderActive(idx) {
            scoreCards[idx].querySelectorAll('button').forEach((b) => {
                b.classList.toggle('dz-active', Number(b.dataset.val) === debug.state.scores[idx]);
            });
        }
        function pickScore(idx, tierIdx) {
            const value = SCORES[tierIdx];
            debug.state.scores[idx] = value;
            renderActive(idx);
            writeBack(idx, String(value));
        }
        function submitAll() {
            const btn = findSubmitButton();
            if (!btn) { toast(`<span class="dz-bad">未找到「提交质检」按钮</span>`); return; }
            btn.click();
            toast(`<span class="dz-ok">✓</span> 已提交质检`);
        }

        /* --- 默认分 --- */
        DEFAULT_SCORES.forEach((val, i) => {
            debug.state.scores[i] = val;
            renderActive(i);
            writeBack(i, String(val));
        });

        /* --- 循环控制 --- */
        function readLoopSec() {
            let n = parseInt($loopSec.value, 10);
            if (!Number.isFinite(n)) n = DEFAULT_LOOP_SEC;
            n = Math.max(LOOP_SEC_MIN, Math.min(LOOP_SEC_MAX, n));
            $loopSec.value = n;
            return n;
        }
        function renderLoopToggle() {
            $loopToggle.classList.toggle('dz-active', debug.state.isLooping);
            $loopToggle.textContent = debug.state.isLooping ? '■ 回起点' : '▶ 空格';
        }
        function toggleLoopAll() {
            if (debug.state.isLooping) {
                stopLoopAll();
                toast(`<span class="dz-ok">已停止循环，全部回起点</span>`);
            } else {
                const sec = readLoopSec();
                const n = startLoopAll(sec);
                toast(n > 0
                    ? `<span class="dz-ok">▶</span> ${n} 路开始循环前 ${sec}s`
                    : `<span class="dz-bad">无可控 iframe（跨域或未加载）</span>`);
            }
            renderLoopToggle();
        }
        $loopToggle.addEventListener('click', toggleLoopAll);
        /* 用户边播边改秒数：若在循环中，重启 interval 应用新值 */
        $loopSec.addEventListener('change', () => {
            if (debug.state.isLooping) {
                const sec = readLoopSec();
                stopLoopAll();
                startLoopAll(sec);
                renderLoopToggle();
                toast(`<span class="dz-ok">循环秒数已更新为 ${sec}s</span>`);
            }
        });
        renderLoopToggle();

        /* --- 键盘 --- */
        function onKey(e) {
            const t = e.target;
            const inOverlayInput = t && t.matches && t.matches('input,textarea') && t.closest && t.closest('#dz-overlay');
            const inPageInput    = t && t.matches && t.matches('input,textarea') && !(t.closest && t.closest('#dz-overlay'));
            if (inPageInput)    { if (e.key === 'Escape') doClose(); return; }
            if (inOverlayInput) { if (e.key === 'Escape') doClose(); return; }  // 允许 Space/1-6 作为输入

            if (e.key === 'Escape') { e.preventDefault(); doClose(); return; }
            if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); submitAll(); return; }
            if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault(); e.stopPropagation(); toggleLoopAll(); return;
            }
            if (/^[1-6]$/.test(e.key)) {
                e.preventDefault(); e.stopPropagation();
                const n = Number(e.key);
                n <= 3 ? pickScore(0, n - 1) : pickScore(1, n - 4);
            }
        }
        window.addEventListener('keydown', onKey, true);

        const refocus = (ev) => {
            const overlayNow = getOverlay();
            if (!overlayNow) return;
            const target = ev.target;
            const isIframe = target && target.tagName === 'IFRAME';
            setTimeout(() => {
                const ov = getOverlay();
                if (!ov) return;
                if (isIframe) {
                    focusOverlay(ov);
                } else if (document.activeElement !== ov &&
                           !(target.closest && target.closest('#dz-overlay') &&
                             target.closest('button,input,textarea'))) {
                    focusOverlay(ov);
                }
            }, 0);
        };
        document.addEventListener('pointerdown', refocus, true);

        /* --- 关闭 --- */
        const doClose = () => {
            stopLoopAll();
            document.querySelectorAll('#dz-overlay iframe').forEach((f) => {
                if (typeof f.__dzCleanup === 'function') {
                    try { f.__dzCleanup(); } catch (err) { debug.warn('cleanup fail', err); }
                    f.__dzCleanup = null;
                }
            });
            overlay.remove();
            rules.remove();
            window.removeEventListener('keydown', onKey, true);
            document.removeEventListener('pointerdown', refocus, true);
            debug.log('overlay closed');
        };
        closeBtn.addEventListener('click', doClose);
        submitOverlayBtn.addEventListener('click', submitAll);

        /* --- 打开即聚焦 --- */
        requestAnimationFrame(() => {
            focusOverlay(overlay);
            setTimeout(() => focusOverlay(overlay), 60);
        });

        debug.log('overlay opened', { links: links.length });
    }

    function closeOverlay() {
        stopLoopAll();
        document.querySelectorAll('#dz-overlay iframe').forEach((f) => {
            if (typeof f.__dzCleanup === 'function') {
                try { f.__dzCleanup(); } catch (err) { debug.warn('cleanup fail', err); }
                f.__dzCleanup = null;
            }
        });
        document.getElementById(OVERLAY_ID)?.remove();
        document.querySelector('.dz-rules-overlay')?.remove();
    }

    /* ============================================================
     * 启动器
     * ============================================================ */
    const LAUNCHER_ID = 'dz-launcher';
    let launcherObserver = null;

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
            debug.state.links = n;
        };
        $btn.addEventListener('click', () => openOverlay(collectPreviewLinks()));

        if (!launcherObserver) {
            launcherObserver = new MutationObserver(() => {
                requestAnimationFrame(() => {
                    if (!document.getElementById(LAUNCHER_ID)) return;
                    refresh();
                });
            });
        } else {
            launcherObserver.disconnect();
        }
        launcherObserver.observe(document.body, { childList: true, subtree: true });
        refresh();
    }

    /* ============================================================
     * 自动开 overlay
     * ============================================================ */
    function shouldAutoOpen() {
        if (!AUTO_OPEN_PATH.test(location.pathname)) return false;
        const sp = new URLSearchParams(location.search);
        return (sp.get('mode') || '') === AUTO_OPEN_PARAM;
    }

    async function tryAutoOpen() {
        if (!shouldAutoOpen()) return;
        if (document.getElementById(OVERLAY_ID)) return;
        for (let i = 0; i < 30; i++) {
            const links = collectPreviewLinks();
            if (links.length) {
                debug.state.autoOpened = true;
                openOverlay(links);
                return;
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        debug.warn('tryAutoOpen timeout');
    }

    /* ============================================================
     * 路由变更
     * ============================================================ */
    function onRouteChange() {
        if (location.href === debug.state.route) return;
        debug.state.route = location.href;
        debug.state.autoOpened = false;
        closeOverlay();
        if (document.getElementById(LAUNCHER_ID)) buildLauncher(); else boot();
        setTimeout(tryAutoOpen, 400);
    }
    const historyOriginals = {};
    ['pushState', 'replaceState'].forEach((m) => {
        const orig = history[m];
        historyOriginals[m] = orig;
        const wrapped = function () {
            const r = orig.apply(this, arguments);
            Promise.resolve().then(onRouteChange);
            return r;
        };
        wrapped.__dzOrig = orig;
        history[m] = wrapped;
    });
    window.addEventListener('popstate', onRouteChange);
    let routeTicks = 0;
    const routeTimer = setInterval(() => {
        onRouteChange();
        if (++routeTicks > 600) { clearInterval(routeTimer); debug.warn('route poller stopped'); }
    }, 5000);

    /* ============================================================
     * 启动 / 卸载
     * ============================================================ */
    function boot() {
        if (!document.getElementById(LAUNCHER_ID)) buildLauncher();
        tryAutoOpen();
    }
    boot();

    window.__dzReview_teardown__ = function () {
        closeOverlay();
        document.getElementById(LAUNCHER_ID)?.remove();
        document.getElementById('dz-style')?.remove();
        document.getElementById('dz-toast')?.remove();
        if (launcherObserver) { launcherObserver.disconnect(); launcherObserver = null; }
        clearInterval(routeTimer);
        window.removeEventListener('popstate', onRouteChange);
        Object.entries(historyOriginals).forEach(([m, orig]) => {
            if (history[m] && history[m].__dzOrig === orig) history[m] = orig;
        });
        delete window.__dzReview_loaded__;
        delete window.__dzReview_debug__;
        delete window.__dzReview_teardown__;
        console.info(TAG, 'teardown done');
    };
})();