// ==UserScript==
// @name         真机数据标注流水线
// @namespace    http://10.22.1.11/
// @match        http://10.22.1.11/task/*
// @match        http://10.22.1.11:8080/*
// @version      2.1.2
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * v2.1.1 修复清单（相对 v2.1.0）：
 *   #1  scheduleAutoSubmit 语法事故
 *   #3  Exception.detect 卡死态自愈
 *   #5  Speed.collectOptions 兼容 position:fixed 菜单（getClientRects）
 *   #6  Task.pickPendingJobs 分页用 total + picked 判终止
 *   #7  autoSubmitGuard 改为 modal 内 mousedown + Escape（方向键不再误取消）
 *   #8  Batch.read 对 i 数组去重
 *   #10 Task.acquireToken 校验 token 类型
 *   #11 JWT_RE 放宽
 *   #12 Drag._applyStored clamp 到视口
 *   #13 Exception.pickOption 优先精确匹配
 *   #14 reactSetValue 沿原型链找 setter
 *   #16 Speed.schedule 保存 setTimeout 句柄
 *   #18 Exception.watchSubmit 的取消检测放宽到 role=button、a
 *   #2  Batch 口径统一：done 含异常，HUD/回执注明
 *
 * 模块：
 *   Logs ｜ Core ｜ Cfg ｜ Fsm ｜ Mode ｜ Drag ｜ Speed
 *   Task ｜ Batch ｜ Annotate ｜ Finish ｜ Exception ｜ Hud ｜ Keys ｜ Mk
 *
 * 副作用：
 * - 网络：仅任务页，GET /api/tasks/:id/jobs、POST /api/jobs/:id/lock（同源 CORS）
 * - 存储（localStorage）：
 *     mk_mode / mk_cursor_v3 / mk_batch_recent / mk_batch_<taskId> / mk_batch_timing /
 *     mk_batch_size / mk_token_hint / mk_cfg / mk_hud_collapsed / mk_speed_sel /
 *     mk_pos_hud / mk_pos_panel / mk_pos_pill / mk_pos_exc
 * - 跳转：location.href / window.open
 * - 注入 DOM：#mk-panel #mk-hud #mk-pill #mk-exc-panel #mk-toast .mk-badge
 * - 合成按键：keydown/keyup(key='q')，isTrusted=false
 * - 修改页面 textarea.value（原型链 setter + input/change 事件）
 * - 调试命名空间：window.__mk__（delete 可清理）
 * - 未使用 GM_* / unsafeWindow / @require / eval
 *
 * 控制台定位本脚本问题：
 * 1. F12 → Console → 过滤框输入 [mk]
 * 2. 展开红色 error 行堆栈，点击跳到 Sources 对应行
 * 3. 在 Mk.bootTask / Mk.bootAnnotate / Batch.run / Annotate.apply / Finish.start 处下断点
 * 4. 检查内部状态：Console 输入 __mk__.ping() 或 __mk__.exportLogs()
 */

(function () {
  'use strict';

  // =========================================================================
  // M0 常量 & 守卫
  // =========================================================================
  const TAG = '[mk]';
  const VERSION = '2.1.2';
  const TASK_ORIGIN = 'http://10.22.1.11';
  const ANNOT_ORIGIN = 'http://10.22.1.11:8080';
  const API_BASE = 'http://10.22.1.11:8000';
  const HASH_BATCH = 'mkb';
  const HASH_DONE = 'mkDone';
  const IS_ANNOT = location.port === '8080';
  // #11 放宽：允许短签名
  const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;

  if (window.__mk__ && window.__mk__.version === VERSION) {
    console.warn(TAG, 'v' + VERSION + ' 已注入，跳过');
    return;
  }
  if (window.__mk__) {
    console.warn(TAG, '覆盖旧版本', window.__mk__.version, '→', VERSION);
    try { window.__mk__.dispose && window.__mk__.dispose(); }
    catch (e) { console.warn(TAG, '旧版本 dispose 失败', e); }
  }

  const S = Object.freeze({
    IDLE: 'IDLE',
    MODAL_OPEN: 'MODAL_OPEN',
    MODAL_SUBMITTING: 'MODAL_SUBMITTING',
    SEG_ADVANCING: 'SEG_ADVANCING',
    FINISH_DIALOG: 'FINISH_DIALOG',
    FINISH_SUBMITTING: 'FINISH_SUBMITTING',
    EXCEPTION_DIALOG: 'EXCEPTION_DIALOG',
    EXCEPTION_SUBMITTING: 'EXCEPTION_SUBMITTING',
    NAVIGATING: 'NAVIGATING',
  });

  const SEL = {
    modal: 'div.modal-content[role="dialog"]',
    radio: '.radio-list input[type="radio"]',
    confirm: 'button.btn-confirm',
    finishMarker: '是否完成标注',
    speedBtn: '#playback-speed-button, [data-testid="PlaybackSpeedControls-Dropdown"]',
    speedMenu: '[role="menu"], [role="listbox"], .MuiMenu-root, .MuiPopover-root',
  };
  const TXT = {
    confirm: '确定',
    finishConfirm: '确认',
    finishCancel: '取消',
    tabSkill: '技能',
    excHeader: '数据异常',
    excSubmit: '提交异常',
    excCancel: '取消',
    excReasonLabel: '原因',
    excReasonDefault: '数据异常',
  };
  const SPEED_RE = /(\d+(?:\.\d+)?)\s*[×xX]/;

  const DEFAULT_CFG = Object.freeze({
    autoSubmitDelay: 800,
    submitDetectTimeout: 5000,
    finishWaitTimeout: 5000,
    batchNavDelay: 800,
    nextKeyDelay: 400,
    nextKeyCooldown: 1200,
    maxAutoQPerDoc: 200,
    maxCursorPerTask: 60,
    maxTimingSamples: 20,
    speedTarget: 3,
  });

  const EXCEPTION_TEMPLATES = [
    { cat: '执行步骤异常', items: [
      { code: '1.1', name: '步骤缺失', desc: '缺少任务步骤描述中要求的动作。' },
      { code: '1.2', name: '步骤顺序错误', desc: '步骤的执行顺序与步骤描述的不符。' },
      { code: '1.3', name: '步骤执行仓促', desc: '步骤执行明显过快，步骤执行过程非匀速完成；最后一个步骤执行结束后双臂未回到初始状态就断录，结尾仓促。' },
    ]},
    { cat: '场景道具异常', items: [
      { code: '2.1', name: '场景搭建错误', desc: '搭建的场景与任务中的场景描述不符。' },
      { code: '2.2', name: '场景道具缺失', desc: '画面中未出现任务场景描述中的物品。' },
      { code: '2.3', name: '场景初始状态异常', desc: '搭建场景中物品的摆放位置、状态、颜色等跟任务的场景描述不一样。' },
    ]},
    { cat: '执行动作异常', items: [
      { code: '3.1', name: '动作错误', desc: '执行动作与任务执行步骤描述不符。' },
      { code: '3.2', name: '动作失败', desc: '除有明确重试要求外，动作执行未一次成功，如发生无意碰撞、物品掉落等。' },
      { code: '3.3', name: '运动类型错误', desc: '动作执行过程与任务中的"运动类型"不符，如运动类型是"静止型"的任务在执行过程中出现了弯腰、下蹲、双足移动等动作。' },
      { code: '3.4', name: '动作跟随异常', desc: '步骤执行过程中机器动作明显卡顿，单一步骤执行完毕后的稳定时间超过3秒；步骤执行过程中，机器出现反关节动作，姿态明显不自然。' },
      { code: '3.5', name: '单臂状态异常', desc: '单臂执行的任务中，某一时刻非操作手臂有明显移动。' },
    ]},
    { cat: '画面质量异常', items: [
      { code: '4.1', name: '画面模糊', desc: '看不清画面中的关键动作或场景道具。' },
      { code: '4.2', name: '曝光异常', desc: '过曝（大片发白）、欠曝（太暗看不清）、全黑全白、存在异常亮点。' },
    ]},
    { cat: '画面内容异常', items: [
      { code: '5.1', name: '关键遮挡', desc: '主视角画面（头部摄像机）中，执行动作、执行道具被执行末端（夹爪、灵巧手等）、道具完全挡住了。' },
      { code: '5.2', name: '末端出镜', desc: '主视角画面（头部摄像机）中不能全程看到要求的机器人末端，默认要求双末端均全程在主视角画面中。' },
      { code: '5.3', name: '隐私违规', desc: '任一视角或反光面出现了操作员的五官、人脸、工牌、手机号、聊天窗口等隐私信息。' },
      { code: '5.4', name: '画面串场', desc: '主视角画面中出现了相邻场景中的道具。' },
    ]},
    { cat: '泛化异常', items: [
      { code: '6.1', name: '场景泛化不符', desc: '搭建的场景和道具与泛化要求不符。' },
      { code: '6.2', name: '动作泛化不符', desc: '每步骤的执行动作与泛化要求不符。' },
      { code: '6.3', name: '语音泛化不符', desc: '语音内容与泛化要求不符。' },
    ]},
  ];

  function stringify(x) {
    if (x instanceof Error) return x.stack || x.message || String(x);
    if (typeof x === 'object' && x !== null) {
      try { return JSON.stringify(x); } catch (e) { return String(x); }
    }
    return String(x);
  }

  // =========================================================================
  // Logs
  // =========================================================================
  const Logs = {
    _buf: [], MAX: 500,
    push(level, args) {
      try {
        this._buf.push({ t: Date.now(), lv: level, m: args.map(stringify).join(' ') });
        if (this._buf.length > this.MAX) this._buf.shift();
      } catch (e) { console.warn(TAG, '日志缓冲写入失败', e); }
    },
    dump(n) { return this._buf.slice(-(n || 50)); },
    export() {
      const blob = new Blob([JSON.stringify(this._buf, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'mk-logs-' + Date.now() + '.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    clear() { this._buf.length = 0; },
  };

  // =========================================================================
  // Core
  // =========================================================================
  const Core = {
    log: {
      debug: (...a) => { Logs.push('debug', a); console.debug(TAG, ...a); },
      info:  (...a) => { Logs.push('info',  a); console.info(TAG, ...a); },
      warn:  (...a) => { Logs.push('warn',  a); console.warn(TAG, ...a); },
      error: (...a) => { Logs.push('error', a); console.error(TAG, ...a); Hud.setLastError(a); },
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    storeGet(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (err) { Core.log.error('读取存储失败', key, err); return fallback; }
    },
    storeSet(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); }
      catch (err) { Core.log.error('写入存储失败', key, err); }
    },
    storeDel(key) {
      try { localStorage.removeItem(key); } catch (err) { Core.log.error('删除存储失败', key, err); }
    },
    b64Encode(str) { return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    b64Decode(s) {
      const p = s.replace(/-/g, '+').replace(/_/g, '/');
      return atob(p + '='.repeat((4 - (p.length % 4)) % 4));
    },
    toast(text, isWarning) {
      try {
        let el = document.getElementById('mk-toast');
        if (!el || !el.isConnected) {
          el = document.createElement('div');
          el.id = 'mk-toast';
          Object.assign(el.style, {
            position: 'fixed', top: '20px', right: '20px', zIndex: '2147483647',
            padding: '10px 16px', borderRadius: '6px', color: '#fff', fontSize: '13px',
            maxWidth: '340px', boxShadow: '0 4px 12px rgba(0,0,0,.2)', transition: 'opacity .2s',
            pointerEvents: 'none',
          });
          (document.body || document.documentElement).appendChild(el);
        }
        el.style.background = isWarning ? 'rgba(212,120,0,.95)' : 'rgba(0,0,0,.82)';
        el.textContent = text;
        el.style.opacity = '1';
        clearTimeout(Core._toastT);
        Core._toastT = setTimeout(() => {
          if (!el.isConnected) return;
          el.style.opacity = '0';
          setTimeout(() => { if (el.isConnected) el.remove(); }, 250);
        }, 2600);
      } catch (err) { console.error(TAG, 'toast 失败', err); }
    },
    isEditable(el) {
      if (!el || el.nodeType !== 1) return false;
      return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true;
    },
    fmtDuration(ms) {
      if (!ms || ms < 0) return '--';
      const s = Math.round(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60), r = s % 60;
      if (m < 60) return m + 'm' + (r ? r + 's' : '');
      const h = Math.floor(m / 60);
      return h + 'h' + (m % 60) + 'm';
    },
    // #14：沿原型链找 value 的 setter，兼容 React 托管 + 自有属性
    reactSetValue(el, value) {
      try {
        let proto = Object.getPrototypeOf(el);
        let desc = null;
        while (proto) {
          desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) break;
          proto = Object.getPrototypeOf(proto);
        }
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (err) { Core.log.error('reactSetValue 失败', err); return false; }
    },
  };

  // =========================================================================
  // Cfg
  // =========================================================================
  const Cfg = {
    _data: null,
    init() {
      const saved = Core.storeGet('mk_cfg', {});
      this._data = Object.assign({}, DEFAULT_CFG, saved);
    },
    get(key) { return this._data[key]; },
    set(key, val) {
      if (!(key in DEFAULT_CFG)) { Core.log.warn('未知配置项', key); return; }
      const n = typeof DEFAULT_CFG[key] === 'number' ? Number(val) : val;
      if (typeof DEFAULT_CFG[key] === 'number' && !Number.isFinite(n)) {
        Core.log.warn('配置值不是数字', key, val); return;
      }
      this._data[key] = n;
      Core.storeSet('mk_cfg', this._data);
      Core.log.info('配置更新', key, '=', n);
      Hud.refresh();
    },
    reset() {
      this._data = Object.assign({}, DEFAULT_CFG);
      Core.storeDel('mk_cfg');
      Core.log.info('配置已重置');
      Hud.refresh();
    },
    all() { return Object.assign({}, this._data); },
  };

  // =========================================================================
  // Fsm
  // =========================================================================
  const Fsm = {
    state: S.IDLE,
    prev: null,
    changedAt: Date.now(),
    paused: false,
    transition(next, reason) {
      if (this.state === next) return;
      this.prev = this.state;
      this.state = next;
      this.changedAt = Date.now();
      Core.log.info('fsm:', this.prev, '→', next, reason ? '(' + reason + ')' : '');
      Hud.refresh();
    },
    is(s) { return this.state === s; },
    isAny(...ss) { return ss.includes(this.state); },
    canAutomate() { return !this.paused && !this.is(S.NAVIGATING); },
    reset() { this.transition(S.IDLE, 'reset'); },
    pause() { this.paused = true; Core.log.info('已暂停全部自动化'); Hud.refresh(); },
    resume() { this.paused = false; Core.log.info('已恢复自动化'); Hud.refresh(); },
    togglePause() { this.paused ? this.resume() : this.pause(); },
  };

  // =========================================================================
  // Mode
  // =========================================================================
  const MODES = { MANUAL: 'manual', PRESELECT: 'preselect', AUTOSUBMIT: 'autosubmit' };
  const MODE_ORDER = [MODES.MANUAL, MODES.PRESELECT, MODES.AUTOSUBMIT];
  const MODE_META = {
    manual: { label: '手动', toast: '标注助手 → 手动（↑↓ 选择，Enter 提交）' },
    preselect: { label: '自动预选', toast: '标注助手 → 自动预选（循环下一项，手动 Enter）' },
    autosubmit: { label: '自动提交', toast: '标注助手 → 自动提交（弹窗后自动确定，Esc 或点击弹窗取消）' },
  };
  const Mode = {
    get() {
      const m = Core.storeGet('mk_mode', MODES.PRESELECT);
      return MODE_ORDER.includes(m) ? m : MODES.PRESELECT;
    },
    set(m) { Core.storeSet('mk_mode', m); Hud.refresh(); },
    cycle() {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(this.get()) + 1) % MODE_ORDER.length];
      this.set(next);
      Core.toast(MODE_META[next].toast, next === MODES.AUTOSUBMIT);
      Core.log.info('模式 →', MODE_META[next].label);
    },
  };

  // =========================================================================
  // Drag
  // =========================================================================
  const Drag = {
    enabled: new WeakMap(),
    enable(el, opts) {
      if (!el || this.enabled.has(el)) return;
      opts = opts || {};
      const handle = opts.handle || el;
      const storageKey = opts.storageKey;
      if (storageKey) this._applyStored(el, storageKey);
      if (el.style.position !== 'absolute' && el.style.position !== 'fixed') {
        el.style.position = 'fixed';
      }
      handle.style.cursor = handle.style.cursor || 'move';
      handle.style.userSelect = 'none';
      handle.style.touchAction = 'none';

      let dragging = false;
      let startX = 0, startY = 0, startLeft = 0, startTop = 0;
      let moved = false;

      const onDown = (e) => {
        const t = e.target;
        if (t instanceof Element) {
          if (t.closest('button, input, textarea, select, [data-no-drag]')) return;
        }
        if (e.button !== undefined && e.button !== 0) return;
        dragging = true;
        moved = false;
        const rect = el.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        el.style.left = startLeft + 'px';
        el.style.top = startTop + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        let nl = Math.max(-r.width + 24, Math.min(vw - 24, startLeft + dx));
        let nt = Math.max(0, Math.min(vh - 24, startTop + dy));
        el.style.left = nl + 'px';
        el.style.top = nt + 'px';
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        if (moved && storageKey) this._saveStored(el, storageKey);
      };

      handle.addEventListener('mousedown', onDown);
      this.enabled.set(el, { handle, onDown });
    },

    // #12 clamp 到当前视口
    _applyStored(el, key) {
      const pos = Core.storeGet(key, null);
      if (!pos) return;
      try {
        const vw = window.innerWidth, vh = window.innerHeight;
        const SAFE = 24;
        let left = typeof pos.left === 'number' ? pos.left : null;
        let top = typeof pos.top === 'number' ? pos.top : null;
        if (left !== null) {
          left = Math.max(-200, Math.min(vw - SAFE, left));
          el.style.left = left + 'px';
          el.style.right = 'auto';
        }
        if (top !== null) {
          top = Math.max(0, Math.min(vh - SAFE, top));
          el.style.top = top + 'px';
          el.style.bottom = 'auto';
        }
      } catch (err) { Core.log.warn('恢复位置失败', key, err); }
    },

    _saveStored(el, key) {
      const r = el.getBoundingClientRect();
      const pos = { left: Math.round(r.left), top: Math.round(r.top) };
      Core.storeSet(key, pos);
      Core.log.debug('位置已保存', key, pos);
    },

    resetAll() {
      ['mk_pos_hud', 'mk_pos_panel', 'mk_pos_pill', 'mk_pos_exc'].forEach(Core.storeDel);
      Core.toast('浮层位置已重置，刷新页面生效');
      Core.log.info('已重置全部浮层位置');
    },
  };

  // =========================================================================
  // Speed
  // =========================================================================
  const Speed = {
    tries: 0,
    ok: false,
    _scheduleTimers: [],  // #16

    getButton() {
      const custom = Core.storeGet('mk_speed_sel', null);
      if (custom && typeof custom === 'string') {
        try {
          const el = document.querySelector(custom);
          if (el) return el;
          Core.log.warn('自定义速度选择器未命中，回退默认', custom);
        } catch (e) { Core.log.warn('自定义速度选择器语法错', e); }
      }
      return document.querySelector(SEL.speedBtn);
    },

    readValue(btn) {
      if (!btn) return null;
      const spans = btn.querySelectorAll('span');
      for (const sp of spans) {
        const t = (sp.textContent || '').trim();
        const m = t.match(SPEED_RE);
        if (m && t.length <= 8) return parseFloat(m[1]);
      }
      const t = (btn.textContent || '').trim();
      const m = t.match(SPEED_RE);
      return m ? parseFloat(m[1]) : null;
    },

    // #5：用 getClientRects 判可见性，兼容 position:fixed 的 MUI Popover
    _isVisible(el) {
      if (!el) return false;
      const rects = el.getClientRects();
      if (!rects || rects.length === 0) return false;
      const r = rects[0];
      return r.width > 0 && r.height > 0;
    },

    collectOptions() {
      const roots = [...document.querySelectorAll(SEL.speedMenu)];
      const pool = roots.length
        ? roots.flatMap((r) => [...r.querySelectorAll('[role="menuitem"],[role="option"],li,button,div,span')])
        : [...document.querySelectorAll('[role="menuitem"],[role="option"]')];
      const seen = new Set();
      const out = [];
      for (const el of pool) {
        if (el.children.length > 1) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 10) continue;
        const m = t.match(/^\s*(\d+(?:\.\d+)?)\s*[×xX]\s*$/);
        if (!m) continue;
        if (!this._isVisible(el)) continue;
        const key = t + '@' + Math.round(el.getBoundingClientRect().top);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ el, text: t, value: parseFloat(m[1]) });
      }
      return out;
    },

    async waitOption(target, timeout) {
      const deadline = Date.now() + (timeout || 2000);
      while (Date.now() < deadline) {
        const hit = this.collectOptions().find((o) => o.value === target);
        if (hit) return hit.el;
        await Core.sleep(100);
      }
      return null;
    },

    closeMenu(btn) {
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        if (this.collectOptions().length && btn) btn.click();
      } catch (err) { Core.log.warn('收起速度菜单失败', err); }
    },

    async set(target) {
      const want = typeof target === 'number' ? target : Cfg.get('speedTarget');
      const btn = this.getButton();
      if (!btn) {
        Core.log.warn('未找到播放速度按钮（' + SEL.speedBtn + '）');
        return false;
      }
      const before = this.readValue(btn);
      if (before === want) { this.ok = true; Hud.refresh(); Core.log.info('速度已是 ' + want + '×'); return true; }
      let opt = this.collectOptions().find((o) => o.value === want);
      if (!opt) {
        btn.click();
        const el = await this.waitOption(want, 2000);
        if (el) opt = { el };
      }
      if (!opt) {
        const avail = this.collectOptions().map((o) => o.text);
        Core.log.warn('速度菜单无 ' + want + '×，可选：', avail.length ? avail : '(未读到)');
        this.closeMenu(btn);
        return false;
      }
      opt.el.click();
      await Core.sleep(200);
      const after = this.readValue(this.getButton());
      if (after === want) { this.ok = true; Hud.refresh(); Core.log.info('速度已切 ' + want + '×'); return true; }
      Core.log.warn('已点 ' + want + '×，回读 ' + (after === null ? '未知' : after + '×'));
      return false;
    },

    // #16 保存句柄
    schedule() {
      [1200, 3000, 6000].forEach((d, i) => {
        const h = setTimeout(async () => {
          if (this.ok) return;
          if (i > 0 && i >= this.tries) return;
          this.tries = Math.max(this.tries, i + 1);
          try { await this.set(Cfg.get('speedTarget')); }
          catch (err) { Core.log.error('速度调整异常', err); }
        }, d);
        this._scheduleTimers.push(h);
      });
    },

    dispose() {
      this._scheduleTimers.forEach(clearTimeout);
      this._scheduleTimers = [];
    },

    probe() {
      const btn = this.getButton();
      return {
        buttonFound: !!btn,
        currentValue: this.readValue(btn),
        buttonHtml: btn ? btn.outerHTML.slice(0, 500) : null,
        optionsInMenu: this.collectOptions().map((o) => ({ text: o.text, value: o.value })),
      };
    },
  };

  // =========================================================================
  // Task
  // =========================================================================
  const Task = {
    async apiFetch(path, token, options) {
      const res = await fetch(API_BASE + path, Object.assign({
        headers: { accept: '*/*', 'content-type': 'application/json', authorization: 'Bearer ' + token },
        credentials: 'include',
      }, options || {}));
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status + ' ' + path);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },

    async verifyToken(taskId, token) {
      await this.apiFetch('/api/tasks/' + taskId + '/jobs?page=1&page_size=1', token);
      return true;
    },

    scanTokenFromStorage() {
      const hits = [];
      for (const store of [window.localStorage, window.sessionStorage]) {
        try {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            const v = store.getItem(k);
            if (!v) continue;
            const m = v.match(JWT_RE);
            if (m) hits.push({ from: k, token: m[0] });
          }
        } catch (err) { Core.log.warn('扫描存储失败', err); }
      }
      return hits;
    },

    // #6：直接用 total + picked.length 判终止，分页大小由服务端返回
    async pickPendingJobs(taskId, token, want) {
      const picked = [];
      let page = 1;
      const pageSize = 50;
      let total = Infinity;
      let seen = 0;
      while (picked.length < want && page <= 100 && seen < total) {
        const data = await this.apiFetch(
          '/api/tasks/' + taskId + '/jobs?page=' + page + '&page_size=' + pageSize, token);
        const items = Array.isArray(data.items) ? data.items : [];
        total = typeof data.total === 'number' ? data.total : total;
        if (!items.length) break;
        seen += items.length;
        for (const it of items) {
          if (it.status === '待标注' && picked.length < want) picked.push(it);
        }
        page++;
      }
      Core.log.debug('pickPendingJobs: pages=' + (page - 1) + ' seen=' + seen + ' total=' + total + ' picked=' + picked.length);
      return picked;
    },

    async lockJob(jobId, token) {
      return this.apiFetch('/api/jobs/' + jobId + '/lock?kind=mark', token, { method: 'POST', body: null });
    },

    buildAnnotUrl(jobId, token, batch) {
      const q = new URLSearchParams({
        ds: 'remote-file', 'ds.action': 'mark', 'ds.content': jobId, 'ds.auth': token,
      });
      return ANNOT_ORIGIN + '/?' + q.toString() + '#' + HASH_BATCH + '=' + Core.b64Encode(JSON.stringify(batch));
    },

    buildTaskDoneUrl(taskId, summary) {
      return TASK_ORIGIN + '/task/' + taskId + '#' + HASH_DONE + '=' + Core.b64Encode(JSON.stringify(summary));
    },

    // #10：校验 token 类型
    async acquireToken(taskId) {
      const cached = Core.storeGet('mk_token_hint', null);
      const candidates = [];
      if (typeof cached === 'string' && cached) candidates.push({ from: 'cache', token: cached });
      else if (cached) { Core.log.warn('缓存 token 类型异常，清除'); Core.storeDel('mk_token_hint'); }
      candidates.push(...this.scanTokenFromStorage());
      const seen = new Set();
      for (const c of candidates) {
        if (!c.token || typeof c.token !== 'string' || seen.has(c.token)) continue;
        seen.add(c.token);
        try {
          await this.verifyToken(taskId, c.token);
          Core.storeSet('mk_token_hint', c.token);
          return { token: c.token, from: c.from };
        } catch (err) {
          Core.log.warn('token 验证失败 from=' + c.from, err.status || err.message);
          if (c.from === 'cache' && err.status === 401) Core.storeDel('mk_token_hint');
        }
      }
      return null;
    },

    mountPanel() {
      if (document.getElementById('mk-panel')) return;
      const panel = document.createElement('div');
      panel.id = 'mk-panel';
      Object.assign(panel.style, {
        position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483600',
        width: '280px', background: '#fff', border: '1px solid #e5e6eb', borderRadius: '10px',
        boxShadow: '0 6px 24px rgba(0,0,0,.12)', font: '13px/1.5 system-ui,"PingFang SC",Arial',
        color: '#1d2129', padding: '12px 14px',
      });
      panel.innerHTML =
        '<div id="mk-panel-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;cursor:move">' +
          '<b style="font-size:14px">真机数据标注流水线</b>' +
          '<span style="color:#86909c;font-size:11px">v' + VERSION + '</span>' +
        '</div>' +
        '<div id="mk-status" style="color:#4e5969;font-size:12px;margin-bottom:8px">正在读取 token…</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
          '<span style="color:#4e5969">本批次</span>' +
          '<input id="mk-size" type="number" min="1" max="200" value="5"' +
          ' style="width:64px;padding:4px 6px;border:1px solid #e5e6eb;border-radius:6px;font-size:13px" data-no-drag>' +
          '<span style="color:#4e5969">条</span>' +
          '<button id="mk-refresh" type="button"' +
          ' style="margin-left:auto;padding:4px 10px;border:1px solid #e5e6eb;background:#fff;border-radius:6px;cursor:pointer;font-size:12px">刷新</button>' +
        '</div>' +
        '<button id="mk-start" type="button"' +
        ' style="width:100%;padding:8px 0;border:0;border-radius:6px;background:#1677ff;color:#fff;font-weight:600;cursor:pointer">开始批次</button>' +
        '<div id="mk-token-row" style="display:none;margin-top:10px">' +
          '<div style="color:#d47800;font-size:12px;margin-bottom:4px">自动获取 token 失败，请粘贴：</div>' +
          '<input id="mk-token" type="password" placeholder="eyJhbGciOi…"' +
          ' style="width:100%;padding:5px 8px;border:1px solid #e5e6eb;border-radius:6px;font-size:12px;box-sizing:border-box" data-no-drag>' +
          '<button id="mk-token-save" type="button"' +
          ' style="margin-top:6px;width:100%;padding:5px 0;border:1px solid #1677ff;background:#fff;color:#1677ff;border-radius:6px;cursor:pointer;font-size:12px">保存并使用</button>' +
        '</div>' +
        '<div id="mk-last-report" style="display:none;margin-top:10px;padding:8px;background:#f7f8fa;border-radius:6px;font-size:12px;color:#4e5969"></div>' +
        '<div style="margin-top:8px;color:#86909c;font-size:11px">Alt+点击面板隐藏 · 拖拽头部移动</div>';
      (document.body || document.documentElement).appendChild(panel);
      Drag.enable(panel, { handle: panel.querySelector('#mk-panel-head'), storageKey: 'mk_pos_panel' });

      const elStatus = panel.querySelector('#mk-status');
      const elSize = panel.querySelector('#mk-size');
      const elStart = panel.querySelector('#mk-start');
      const elRefresh = panel.querySelector('#mk-refresh');
      const elTokenRow = panel.querySelector('#mk-token-row');
      const elToken = panel.querySelector('#mk-token');
      const elTokenSave = panel.querySelector('#mk-token-save');
      const elReport = panel.querySelector('#mk-last-report');

      elSize.value = String(Core.storeGet('mk_batch_size', 5));
      elSize.addEventListener('change', () => {
        const n = Math.max(1, Math.min(200, parseInt(elSize.value, 10) || 5));
        elSize.value = String(n);
        Core.storeSet('mk_batch_size', n);
      });

      panel.addEventListener('click', (e) => {
        if (e.altKey) { panel.style.display = 'none'; Core.log.info('面板已隐藏，刷新恢复'); }
      });

      let token = null;
      let busy = false;

      const setStatus = (text, color) => {
        elStatus.textContent = text;
        elStatus.style.color = color || '#4e5969';
      };

      const refresh = async (taskId) => {
        setStatus('正在获取 token…');
        const r = await Task.acquireToken(taskId);
        if (!r) {
          elTokenRow.style.display = 'block';
          setStatus('需要 token 才能读取任务列表', '#d47800');
          return false;
        }
        elTokenRow.style.display = 'none';
        token = r.token;
        setStatus('token 就绪（来源：' + r.from + '）');
        return true;
      };

      elTokenSave.addEventListener('click', async () => {
        const v = (elToken.value || '').trim();
        const m = v.match(JWT_RE);
        if (!m) { setStatus('粘贴内容不像 JWT', '#c0392b'); return; }
        const taskId = (location.pathname.match(/\/task\/(\d+)/) || [])[1];
        try {
          await Task.verifyToken(taskId, m[0]);
          Core.storeSet('mk_token_hint', m[0]);
          token = m[0];
          elTokenRow.style.display = 'none';
          setStatus('token 已保存 · 可开始批次');
          Core.toast('token 已保存');
        } catch (err) {
          Core.log.error('手动 token 验证失败', err);
          setStatus('token 验证失败（可能已过期）', '#c0392b');
        }
      });

      elRefresh.addEventListener('click', async () => {
        const taskId = (location.pathname.match(/\/task\/(\d+)/) || [])[1];
        if (taskId) await refresh(taskId);
      });

      elStart.addEventListener('click', async () => {
        if (busy) return;
        const taskId = (location.pathname.match(/\/task\/(\d+)/) || [])[1];
        if (!taskId) { setStatus('URL 未解析到 taskId', '#c0392b'); return; }
        if (!token && !(await refresh(taskId))) return;

        const want = Math.max(1, Math.min(200, parseInt(elSize.value, 10) || 5));
        busy = true;
        elStart.disabled = true;
        elStart.style.opacity = '0.6';
        elStart.textContent = '正在挑选…';
        try {
          const jobs = await Task.pickPendingJobs(taskId, token, want);
          Core.log.info('挑选完成：需要', want, '实际待标注', jobs.length);
          if (!jobs.length) {
            setStatus('没有 status=待标注 的数据', '#d47800');
            Core.toast('没有待标注数据', true);
            return;
          }

          elStart.textContent = '锁定中 0/' + jobs.length + '…';
          const locked = [], failed = [];
          for (const job of jobs) {
            try {
              await Task.lockJob(job.id, token);
              locked.push(job);
            } catch (err) {
              Core.log.error('锁定失败', job.id, err);
              failed.push({ id: job.id, reason: err.status || err.message });
            }
            elStart.textContent = '锁定中 ' + locked.length + '/' + jobs.length + '…';
          }
          if (!locked.length) {
            setStatus('全部锁定失败', '#c0392b');
            Core.toast('锁定失败', true);
            return;
          }

          const batch = {
            t: taskId, i: locked.map((j) => j.id), c: 0, k: token,
            at: Date.now(), failed: [], done: 0, exc: 0,
          };
          Core.storeSet('mk_batch_recent', batch);
          const url = Task.buildAnnotUrl(batch.i[0], token, batch);
          const win = window.open(url, '_blank');
          if (!win) {
            setStatus('弹窗被拦截，5s 后当前页跳转…', '#d47800');
            setTimeout(() => { location.href = url; }, 5000);
            return;
          }
          const extra = failed.length ? '（' + failed.length + ' 条锁定失败已丢弃）' : '';
          setStatus('已启动：' + locked.length + ' 条' + extra, '#0e9f6e');
          Core.toast('批次已启动：' + locked.length + ' 条');
        } catch (err) {
          Core.log.error('启动批次失败', err);
          setStatus('启动失败：' + (err.message || err), '#c0392b');
        } finally {
          busy = false;
          elStart.disabled = false;
          elStart.style.opacity = '1';
          elStart.textContent = '开始批次';
        }
      });

      // #2 口径统一：N 完成（含 M 异常）
      const renderLastReport = (summary) => {
        if (!summary) { elReport.style.display = 'none'; return; }
        elReport.style.display = 'block';
        const failedList = (summary.failed || []).slice(0, 5)
          .map((f) => '· ' + (f.id || f) + (f.reason ? ' (' + f.reason + ')' : '')).join('<br>');
        const more = (summary.failed || []).length > 5 ? '<br>…(共 ' + summary.failed.length + ')' : '';
        const exc = typeof summary.exc === 'number' ? summary.exc : 0;
        const okCount = Math.max(0, (summary.done || 0) - exc);
        const detail = exc > 0
          ? summary.done + '/' + summary.total + '（正常 ' + okCount + ' · 异常 ' + exc + '）'
          : summary.done + '/' + summary.total;
        elReport.innerHTML =
          '<b>上次批次</b>：' + detail
          + (summary.failed && summary.failed.length ? '<br>锁定失败：<br>' + failedList + more : '')
          + (summary.durationMs ? '<br>耗时：' + Core.fmtDuration(summary.durationMs) : '');
      };
      Task._renderLastReport = renderLastReport;

      const taskId = (location.pathname.match(/\/task\/(\d+)/) || [])[1];
      if (taskId) refresh(taskId);
      else setStatus('URL 未解析到 taskId（需 /task/<数字>）', '#c0392b');
    },

    handleDoneFlag() {
      const hash = location.hash.replace(/^#/, '');
      if (!hash.startsWith(HASH_DONE + '=')) return;
      try {
        const summary = JSON.parse(Core.b64Decode(hash.slice(HASH_DONE.length + 1)));
        Core.log.info('收到批次回执', summary);
        const exc = typeof summary.exc === 'number' ? summary.exc : 0;
        const okCount = Math.max(0, (summary.done || 0) - exc);
        Core.toast('批次完成：' + summary.done + '/' + summary.total +
          (exc ? '（正常 ' + okCount + ' · 异常 ' + exc + '）' : ''));
        setTimeout(() => { Task._renderLastReport && Task._renderLastReport(summary); }, 300);
      } catch (err) {
        Core.log.error('回执解析失败', err);
      }
      history.replaceState(null, '', location.pathname + location.search);
      Core.storeDel('mk_batch_recent');
    },
  };

  // =========================================================================
  // Batch
  // =========================================================================
  const Batch = {
    data: null,
    pkgStart: 0,

    // #8：i 数组去重
    _dedupe(b) {
      if (!b || !Array.isArray(b.i)) return b;
      const seen = new Set();
      const out = [];
      for (const id of b.i) { if (!seen.has(id)) { seen.add(id); out.push(id); } }
      if (out.length !== b.i.length) {
        Core.log.warn('批次队列发现重复，已去重', b.i.length, '→', out.length);
        b.i = out;
      }
      return b;
    },

    read() {
      const hash = location.hash.replace(/^#/, '');
      if (hash.startsWith(HASH_BATCH + '=')) {
        try {
          const obj = JSON.parse(Core.b64Decode(hash.slice(HASH_BATCH.length + 1)));
          if (obj && Array.isArray(obj.i) && obj.i.length) return this._dedupe(obj);
        } catch (err) { Core.log.error('batch hash 解析失败', err); }
      }
      const recent = Core.storeGet('mk_batch_recent', null);
      if (recent && Array.isArray(recent.i) && recent.i.includes(Annotate.jobId)) {
        Core.log.info('从本地恢复批次（无 hash）');
        return this._dedupe(recent);
      }
      return null;
    },

    persist(b) {
      this.data = b;
      Core.storeSet('mk_batch_recent', b);
      Core.storeSet('mk_batch_' + b.t, b);
    },

    index() {
      if (!this.data) return -1;
      return this.data.i.indexOf(Annotate.jobId);
    },

    recordPkgDone() {
      if (!this.pkgStart) return;
      const dur = Date.now() - this.pkgStart;
      const timings = Core.storeGet('mk_batch_timing', []);
      timings.push(dur);
      while (timings.length > Cfg.get('maxTimingSamples')) timings.shift();
      Core.storeSet('mk_batch_timing', timings);
      Core.log.info('本包耗时', Core.fmtDuration(dur));
    },

    getETA() {
      if (!this.data) return null;
      const idx = this.index();
      if (idx < 0) return null;
      const remain = this.data.i.length - idx - 1;
      if (!remain) return 0;
      const timings = Core.storeGet('mk_batch_timing', []);
      if (!timings.length) return null;
      const avg = timings.reduce((s, x) => s + x, 0) / timings.length;
      return Math.round(avg * remain);
    },

    // #2 口径：done 含异常，exc 单独记
    advance(reason) {
      const b = this.data;
      if (!b) { Finish.attemptCloseTab(); return; }
      const idx = this.index();
      if (idx < 0) { this.abort('当前 jobId 不在批次内'); return; }
      this.recordPkgDone();
      b.done = idx + 1;  // 含异常
      if (reason === 'exception') b.exc = (b.exc || 0) + 1;
      const nextIdx = idx + 1;
      if (nextIdx < b.i.length) {
        const next = Object.assign({}, b, { c: nextIdx });
        this.persist(next);
        const url = Task.buildAnnotUrl(b.i[nextIdx], b.k, next);
        Core.log.info('批次推进 (' + (reason || 'finish') + ')', (idx + 1) + '/' + b.i.length);
        Fsm.transition(S.NAVIGATING, 'batch advance');
        setTimeout(() => { location.href = url; }, Cfg.get('batchNavDelay'));
      } else {
        Core.log.info('批次最后一条完成，回任务页');
        this.persist(Object.assign({}, b, { c: nextIdx, done: nextIdx }));
        const summary = {
          total: b.i.length, done: nextIdx, exc: b.exc || 0,
          failed: b.failed || [],
          durationMs: Date.now() - b.at,
        };
        const url = Task.buildTaskDoneUrl(b.t, summary);
        Fsm.transition(S.NAVIGATING, 'batch complete');
        setTimeout(() => { location.href = url; }, Cfg.get('batchNavDelay'));
      }
    },

    skip(reason) {
      if (!this.data) { Core.log.warn('非批次模式，跳过无效'); return; }
      const idx = this.index();
      const nextIdx = idx + 1;
      this.data.failed = (this.data.failed || []).concat([{ id: Annotate.jobId, reason: reason }]);
      if (nextIdx >= this.data.i.length) { this.abort('已到末尾（跳过触发）'); return; }
      Core.log.warn('跳过当前包：', reason);
      const next = Object.assign({}, this.data, { c: nextIdx });
      this.persist(next);
      Fsm.transition(S.NAVIGATING, 'skip');
      location.href = Task.buildAnnotUrl(this.data.i[nextIdx], this.data.k, next);
    },

    abort(reason) {
      if (!this.data) return;
      Core.log.warn('中止批次：', reason);
      Fsm.transition(S.NAVIGATING, 'abort');
      const summary = {
        total: this.data.i.length,
        done: Math.max(0, this.index()),
        exc: this.data.exc || 0,
        failed: this.data.failed || [],
        durationMs: Date.now() - this.data.at,
        aborted: true,
      };
      location.href = Task.buildTaskDoneUrl(this.data.t, summary);
    },

    enqueue(jobId) {
      if (!this.data) { Core.log.warn('非批次模式'); return false; }
      if (this.data.i.includes(jobId)) { Core.log.warn('jobId 已在队列'); return false; }
      this.data.i.push(jobId);
      this.persist(this.data);
      Core.log.info('已追加', jobId, '新总数', this.data.i.length);
      Hud.refresh();
      return true;
    },

    mountPill() {
      if (!this.data) return;
      const idx = this.index();
      let el = document.getElementById('mk-pill');
      if (!el || !el.isConnected) {
        el = document.createElement('div');
        el.id = 'mk-pill';
        Object.assign(el.style, {
          position: 'fixed', top: '10px', left: '10px', zIndex: '2147483000',
          padding: '4px 10px', borderRadius: '999px', background: 'rgba(22,119,255,.92)',
          color: '#fff', font: '12px/1.6 system-ui,Arial', boxShadow: '0 2px 8px rgba(0,0,0,.18)',
          cursor: 'move', userSelect: 'none',
        });
        (document.body || document.documentElement).appendChild(el);
        Drag.enable(el, { storageKey: 'mk_pos_pill' });
      }
      el.textContent = '批次 ' + (idx + 1) + '/' + this.data.i.length +
        ' · 剩余 ' + (this.data.i.length - idx - 1);
    },
  };

  // =========================================================================
  // Annotate
  // =========================================================================
  const Annotate = {
    jobId: null,
    taskId: null,
    handledModal: null,
    autoSubmitTimer: null,
    autoSubmitGuardKey: null,     // Escape 取消
    autoSubmitGuardMouse: null,   // modal 内 mousedown 取消
    autoSubmitModalRef: null,
    qTimer: null,
    qGuard: null,
    lastQAt: 0,
    qCount: 0,  // 页级计数，每次页面加载从 0 开始（整页导航模型下 OK）
    modalScheduled: false,

    _migrateCursor() {
      const v2 = Core.storeGet('mk_cursor_v2', null);
      const v3 = Core.storeGet('mk_cursor_v3', null);
      if (v2 && !v3) {
        Core.storeSet('mk_cursor_v3', { _legacy_: v2 });
        Core.storeDel('mk_cursor_v2');
        Core.log.info('游标存储已迁移 v2 → v3');
      } else if (!v3) {
        Core.storeSet('mk_cursor_v3', {});
      }
    },

    loadMap() {
      const m = Core.storeGet('mk_cursor_v3', {});
      return m && typeof m === 'object' ? m : {};
    },

    _bucket() { return this.taskId || '_legacy_'; },

    getCursor() {
      const map = this.loadMap();
      const b = map[this._bucket()];
      return b ? b[this.jobId] : undefined;
    },

    setCursor(data) {
      const map = this.loadMap();
      const bk = this._bucket();
      if (!map[bk]) map[bk] = {};
      map[bk][this.jobId] = data;
      const entries = Object.entries(map[bk]);
      if (entries.length > Cfg.get('maxCursorPerTask')) {
        const kept = entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
          .slice(0, Cfg.get('maxCursorPerTask'));
        map[bk] = Object.fromEntries(kept);
      }
      Core.storeSet('mk_cursor_v3', map);
    },

    resetCursor() {
      const map = this.loadMap();
      const bk = this._bucket();
      if (map[bk]) delete map[bk][this.jobId];
      Core.storeSet('mk_cursor_v3', map);
      Core.toast('本包游标已重置');
      Core.log.info('游标重置', this.jobId);
    },

    findConfirmButton(modal) {
      const byClass = modal.querySelector(SEL.confirm);
      if (byClass) return byClass;
      for (const b of modal.querySelectorAll('button')) {
        if ((b.textContent || '').trim() === TXT.confirm) return b;
      }
      return null;
    },
    isConfirmButton(btn) {
      return btn.matches(SEL.confirm) || (btn.textContent || '').trim() === TXT.confirm;
    },
    computeFp(radios) {
      const first = (radios[0].closest('label')?.textContent ?? '').trim().slice(0, 24);
      const last = (radios[radios.length - 1].closest('label')?.textContent ?? '').trim().slice(0, 24);
      return radios.length + '|' + first + '|' + last;
    },
    waitForRadios(modal, timeout) {
      return new Promise((resolve) => {
        const q = () => Array.from(modal.querySelectorAll(SEL.radio));
        const initial = q();
        if (initial.length) return resolve(initial);
        let timer = null;
        const ob = new MutationObserver(() => {
          const list = q();
          if (list.length) { ob.disconnect(); clearTimeout(timer); resolve(list); }
        });
        ob.observe(modal, { childList: true, subtree: true });
        timer = setTimeout(() => { ob.disconnect(); resolve(q()); }, timeout || 5000);
      });
    },
    upsertBadge(modal, text) {
      try {
        const header = modal.querySelector('.modal-header');
        if (!header) return;
        let badge = header.querySelector('.mk-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'mk-badge';
          Object.assign(badge.style, {
            marginLeft: '12px', padding: '2px 10px', borderRadius: '10px',
            fontSize: '12px', background: '#f0f7ff', color: '#1677ff',
          });
          header.appendChild(badge);
        }
        badge.textContent = text;
      } catch (err) { Core.log.error('徽标渲染失败', err); }
    },
    markPrevious(radio) {
      const label = radio.closest('label') || radio.parentElement;
      if (label) label.style.boxShadow = 'inset 3px 0 0 #91caff';
    },

    // --- onModalOpen ---
    async onModalOpen(modal) {
      try {
        Fsm.transition(S.MODAL_OPEN, 'modal detected');
        if (!Fsm.canAutomate()) { Core.log.debug('已暂停，跳过预选'); return; }
        const mode = Mode.get();
        if (mode === MODES.MANUAL) { Core.log.debug('手动模式'); return; }

        const tabText = modal.querySelector('.modal-tabs .tab-item.active')?.textContent.trim() ?? '';
        if (tabText !== TXT.tabSkill) {
          Core.log.info('tab=', tabText || '(未知)', '非技能，跳过预选');
          return;
        }
        const radios = await this.waitForRadios(modal);
        if (!modal.isConnected) return;
        if (!radios.length) { Core.log.warn('未找到技能单选项', SEL.radio); return; }

        const fp = this.computeFp(radios);
        const saved = this.getCursor();
        const okSaved = saved && saved.fp === fp && saved.index < radios.length;
        const nextIdx = okSaved ? (saved.index + 1) % radios.length : 0;

        if (okSaved && saved.index !== nextIdx) this.markPrevious(radios[saved.index]);
        radios[nextIdx].click();

        this.upsertBadge(modal,
          (mode === MODES.AUTOSUBMIT ? '自动提交' : '自动预选') + ' ' + (nextIdx + 1) + '/' + radios.length);
        Core.log.info('已选第', (nextIdx + 1) + '/' + radios.length, okSaved ? '' : '(首次)');

        if (mode === MODES.AUTOSUBMIT) this.scheduleAutoSubmit(modal);
      } catch (err) { Core.log.error('onModalOpen 失败', err); }
    },

    // --- scheduleAutoSubmit ---
    // #7：只在 modal 内 mousedown + 全局 Escape 取消，方向键不再误触发
    scheduleAutoSubmit(modal) {
      this.cancelAutoSubmit();
      this.autoSubmitModalRef = modal;
      this.autoSubmitTimer = setTimeout(() => this.fireAutoSubmit(), Cfg.get('autoSubmitDelay'));

      this.autoSubmitGuardMouse = (e) => {
        if (!this.autoSubmitTimer || !this.autoSubmitModalRef) return;
        if (e.target instanceof Node && this.autoSubmitModalRef.contains(e.target)) {
          Core.log.debug('modal 内点击，取消本次自动提交');
          this.cancelAutoSubmit();
        }
      };
      this.autoSubmitGuardKey = (e) => {
        if (!this.autoSubmitTimer) return;
        if (e.key === 'Escape') {
          Core.log.debug('Esc 取消本次自动提交');
          this.cancelAutoSubmit();
        }
      };
      document.addEventListener('mousedown', this.autoSubmitGuardMouse, true);
      document.addEventListener('keydown', this.autoSubmitGuardKey, true);
    },

    // --- cancelAutoSubmit ---
    cancelAutoSubmit() {
      if (this.autoSubmitTimer) { clearTimeout(this.autoSubmitTimer); this.autoSubmitTimer = null; }
      if (this.autoSubmitGuardMouse) {
        document.removeEventListener('mousedown', this.autoSubmitGuardMouse, true);
        this.autoSubmitGuardMouse = null;
      }
      if (this.autoSubmitGuardKey) {
        document.removeEventListener('keydown', this.autoSubmitGuardKey, true);
        this.autoSubmitGuardKey = null;
      }
      this.autoSubmitModalRef = null;
    },

    // --- fireAutoSubmit ---
    fireAutoSubmit() {
      this.autoSubmitTimer = null;
      this.cancelAutoSubmit();
      try {
        if (!Fsm.canAutomate()) return;
        if (Fsm.is(S.MODAL_SUBMITTING)) { Core.log.debug('已在提交'); return; }
        const modal = document.querySelector(SEL.modal);
        if (!modal) return;
        if (Mode.get() !== MODES.AUTOSUBMIT) return;
        const btn = this.findConfirmButton(modal);
        if (!btn || btn.disabled) { Core.log.warn('确定按钮不可用'); return; }
        Core.log.info('自动点击「确定」');
        btn.click();
      } catch (err) { Core.log.error('自动提交失败', err); }
    },

    // --- watchSubmitResult ---
    watchSubmitResult(modal, fp, index) {
      Fsm.transition(S.MODAL_SUBMITTING, 'confirm clicked');
      const baseline = modal.querySelector('.time-row')?.textContent ?? '';
      const started = Date.now();
      const timer = setInterval(() => {
        let ok = null;
        let reason = '';
        try {
          if (!modal.isConnected) { ok = true; reason = '弹窗已关闭'; }
          else {
            const nowText = modal.querySelector('.time-row')?.textContent ?? '';
            if (baseline && nowText !== baseline) { ok = true; reason = '弹窗内容刷新'; }
            else if (Date.now() - started > Cfg.get('submitDetectTimeout')) {
              ok = false; reason = '超时';
            }
          }
        } catch (err) { Core.log.error('提交检测异常', err); ok = false; reason = '异常'; }
        if (ok === null) return;
        clearInterval(timer);
        if (ok) {
          Core.log.info('提交成功：', reason);
          this.commitCursor(fp, index);
          Fsm.transition(S.SEG_ADVANCING, 'submit ok');
          this.scheduleKick();
        } else {
          Core.log.warn('提交失败判定：', reason);
          Fsm.transition(S.IDLE, 'submit failed');
        }
      }, 200);
    },

    // --- commitCursor ---
    // #9：清所有 badge
    commitCursor(fp, index) {
      this.setCursor({ index: index, fp: fp, ts: Date.now() });
      document.querySelectorAll('.mk-badge').forEach((b) => b.remove());
      Core.log.info('游标提交 →', (index + 1), '(fp=' + fp.slice(0, 24) + '…)');
      Hud.refresh();
    },

    moveSelection(modal, delta) {
      const radios = Array.from(modal.querySelectorAll(SEL.radio));
      if (!radios.length) { Core.log.warn('无单选项'); return; }
      const cur = radios.findIndex((r) => r.checked);
      const next = cur === -1
        ? (delta > 0 ? 0 : radios.length - 1)
        : (cur + delta + radios.length) % radios.length;
      radios[next].click();
      Core.log.debug('选第 ' + (next + 1) + '/' + radios.length);
    },

    confirmModal(modal) {
      const btn = this.findConfirmButton(modal);
      if (!btn || btn.disabled) { Core.log.warn('确定按钮不可用'); return; }
      btn.click();
      Core.log.info('已触发「确定」');
    },

    dispatchKey(target, type, key, code, keyCode) {
      try {
        const ev = new KeyboardEvent(type, {
          key: key, code: code, bubbles: true, cancelable: true, composed: true, view: window,
        });
        const getter = () => keyCode;
        Object.defineProperty(ev, 'keyCode', { get: getter });
        Object.defineProperty(ev, 'which', { get: getter });
        return target.dispatchEvent(ev);
      } catch (err) { Core.log.error('dispatchKey 失败', err); return false; }
    },

    cancelKick(reason) {
      if (this.qTimer) { clearTimeout(this.qTimer); this.qTimer = null; }
      if (this.qGuard) { document.removeEventListener('keydown', this.qGuard, true); this.qGuard = null; }
      if (reason) Core.log.debug('取消自动 Q：', reason);
    },

    kickNextSegment() {
      if (!Fsm.canAutomate()) { Core.log.info('已暂停/跳转中，跳过 Q'); return; }
      if (document.querySelector(SEL.modal)) { Core.log.info('modal 仍在，跳过 Q'); return; }
      const now = Date.now();
      if (now - this.lastQAt < Cfg.get('nextKeyCooldown')) { Core.log.debug('Q 冷却'); return; }
            if (this.qCount >= Cfg.get('maxAutoQPerDoc')) {
        Core.log.warn('Q 达上限 ' + this.qCount + '，本包不再自动推进');
        Core.toast('自动按 Q 达上限', true);
        return;
      }
      this.lastQAt = now;
      this.qCount += 1;
      const active = document.activeElement;
      if (active && Core.isEditable(active) && typeof active.blur === 'function') active.blur();
      const target = document.body || document.documentElement;
      const ok1 = this.dispatchKey(target, 'keydown', 'q', 'KeyQ', 81);
      const ok2 = this.dispatchKey(target, 'keyup', 'q', 'KeyQ', 81);
      if (ok1 && ok2) Core.log.info('已自动按 Q（本页第 ' + this.qCount + ' 次）');
      else { Core.log.warn('Q 合成失败'); Core.toast('合成 Q 失败', true); }
      Fsm.transition(S.IDLE, 'after Q');
      Hud.refresh();
    },

    // --- scheduleKick ---
    scheduleKick() {
      this.cancelKick();
      this.qGuard = (e) => { if (e.key === 'q' || e.key === 'Q') this.cancelKick('用户按了 Q'); };
      document.addEventListener('keydown', this.qGuard, true);
      this.qTimer = setTimeout(() => {
        this.qTimer = null;
        if (this.qGuard) { document.removeEventListener('keydown', this.qGuard, true); this.qGuard = null; }
        try { this.kickNextSegment(); } catch (err) { Core.log.error('kick 失败', err); }
      }, Cfg.get('nextKeyDelay'));
    },

    // --- checkModal ---
    checkModal() {
      const modal = document.querySelector(SEL.modal);
      if (!modal) return;
      if (this.handledModal && this.handledModal.isConnected) return;
      this.handledModal = modal;
      this.onModalOpen(modal);
    },
  };

  // =========================================================================
  // Finish：W 后的"是否完成标注"确认框
  // =========================================================================
  const Finish = {
    pollTimer: null,
    guardClick: null,
    guardKey: null,
    cancelRequested: false,

    findDialog() {
      const dialogs = document.querySelectorAll('div[role="dialog"]:not(.modal-content)');
      for (const d of dialogs) {
        const t = d.textContent || '';
        if (t.includes(SEL.finishMarker) && !Exception.isExceptionDialog(d)) return d;
      }
      return null;
    },

    findButton(root, text) {
      for (const b of root.querySelectorAll('button, a, [role="button"]')) {
        if ((b.textContent || '').trim() === text) return b;
      }
      return null;
    },

    teardown() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      if (this.guardClick) { document.removeEventListener('click', this.guardClick, true); this.guardClick = null; }
      if (this.guardKey) { document.removeEventListener('keydown', this.guardKey, true); this.guardKey = null; }
    },

    attemptCloseTab() {
      Core.log.info('尝试关闭标签页');
      window.close();
      setTimeout(() => {
        if (window.closed) return;
        Core.log.warn('close 被拦截');
        Core.toast('浏览器拦截自动关闭，请 Ctrl+W', true);
      }, 250);
    },

    // --- handleEnter ---
    handleEnter(dialog) {
      if (Fsm.is(S.FINISH_SUBMITTING)) { Core.log.debug('处理中'); return; }
      const btn = this.findButton(dialog, TXT.finishConfirm);
      if (!btn || btn.disabled) { Core.log.warn('确认按钮不可用'); return; }

      Fsm.transition(S.FINISH_SUBMITTING, 'W confirm clicked');
      this.cancelRequested = false;

      this.guardClick = (e) => {
        if (!(e.target instanceof Element)) return;
        const b = e.target.closest('button, a, [role="button"]');
        if (b && (b.textContent || '').trim() === TXT.finishCancel) {
          this.cancelRequested = true;
          Core.log.info('检测到「取消」');
        }
      };
      this.guardKey = (e) => {
        if (e.key === 'Escape') { this.cancelRequested = true; Core.log.info('检测到 Esc'); }
      };
      document.addEventListener('click', this.guardClick, true);
      document.addEventListener('keydown', this.guardKey, true);

      Core.log.info('点击「确认」');
      btn.click();

      const started = Date.now();
      this.pollTimer = setInterval(() => {
        try {
          if (this.cancelRequested) {
            this.teardown();
            Fsm.transition(S.IDLE, 'user cancelled finish');
            return;
          }
          if (!dialog.isConnected) {
            this.teardown();
            Core.log.info('确认弹窗关闭，推进批次');
            if (Batch.data) Batch.advance('finish');
            else this.attemptCloseTab();
            return;
          }
          if (Date.now() - started > Cfg.get('finishWaitTimeout')) {
            this.teardown();
            Fsm.transition(S.IDLE, 'finish wait timeout');
            Core.toast('完成确认超时', true);
          }
        } catch (err) { Core.log.error('finish 检测异常', err); this.teardown(); }
      }, 150);
    },

    // --- detect ---
    detect() {
      const d = this.findDialog();
      if (d) {
        if (!Fsm.isAny(S.FINISH_DIALOG, S.FINISH_SUBMITTING)) {
          Fsm.transition(S.FINISH_DIALOG, 'W pressed');
        }
      } else if (Fsm.is(S.FINISH_DIALOG)) {
        // #3：弹窗自行消失（未走 handleEnter）→ 回退 IDLE，避免卡死
        Core.log.warn('完成确认框已消失但状态滞留，回退 IDLE');
        Fsm.transition(S.IDLE, 'finish dialog vanished');
      }
    },
  };

    // =========================================================================
  // Exception：A 后的"数据异常"弹窗
  // =========================================================================
  /*
   * [失效条件]
   * - 表头文本不再是"数据异常" → findDialog 失效
   * - "原因"下拉换成 <select> → openDropdown 的 click 策略失效
   * - 下拉面板改为 Portal 挂到 body 外 → openDropdown 找不到
   * - "提交异常" 按钮文案变化 → submit() / watchSubmit 失效
   */
  const Exception = {
    pollTimer: null,
    guardClick: null,
    submittedDesc: null,
    panelEl: null,
    state: { reasonIndex: -1, reasons: [], moving: false },

    // 当站点下拉未能被成功读取时的兜底列表（来自粘贴的 HTML）
    EXC_REASONS_FALLBACK: [
      '数据异常', '摄像头时间异常', '摄像头获取异常',
      '话题缺失', '视频卡顿', '数据采集不完整',
    ],

    // --- isExceptionDialog ---
    isExceptionDialog(d) {
      if (!d) return false;
      const firstDiv = d.querySelector(':scope > div');
      if (!firstDiv) return false;
      return (firstDiv.textContent || '').trim() === TXT.excHeader;
    },

    // --- findDialog ---
    findDialog() {
      const dialogs = document.querySelectorAll('div[role="dialog"]');
      for (const d of dialogs) {
        if (this.isExceptionDialog(d)) return d;
      }
      return null;
    },

    // --- findReasonTrigger ---
    findReasonTrigger(dialog) {
      const labelDivs = [...dialog.querySelectorAll('div')].filter(
        (d) => (d.textContent || '').trim() === TXT.excReasonLabel && d.children.length === 0
      );
      if (!labelDivs.length) return null;
      const container = labelDivs[0].nextElementSibling;
      if (!container) return null;
      return container.querySelector('div') || null;
    },

    // --- findPanel ---
    findPanel(trigger) {
      const parent = trigger && trigger.parentElement;
      if (!parent) return null;
      return [...parent.children].find(
        (c) => c !== trigger && c.style && c.style.position === 'absolute'
      );
    },

    // --- openDropdown ---
    async openDropdown(dialog) {
      const trigger = this.findReasonTrigger(dialog);
      if (!trigger) { Core.log.warn('未找到"原因"下拉触发框'); return null; }
      let panel = this.findPanel(trigger);
      if (panel) return panel;
      trigger.click();
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        panel = this.findPanel(trigger);
        if (panel) break;
        await Core.sleep(50);
      }
      if (!panel) Core.log.warn('下拉面板未出现（可能改为 Portal 渲染）');
      return panel;
    },

    // --- closeDropdownIfOpen ---
    async closeDropdownIfOpen(dialog) {
      const trigger = this.findReasonTrigger(dialog);
      if (!trigger) return;
      if (!this.findPanel(trigger)) return;
      trigger.click();
      await Core.sleep(80);
    },

    // --- pickOption ---  优先精确匹配
    pickOption(panel, text) {
      if (!panel) return false;
      const items = [...panel.querySelectorAll(':scope > div')]
        .filter((d) => (d.textContent || '').trim());
      const exact = items.find((d) => (d.textContent || '').trim() === text);
      if (exact) {
        exact.click();
        Core.log.info('已选异常原因：', text, '(精确)');
        return true;
      }
      const loose = items.find((d) => (d.textContent || '').trim().endsWith(text));
      if (loose) {
        loose.click();
        Core.log.warn('已选异常原因：', text, '(后缀匹配)');
        return true;
      }
      Core.log.warn('下拉中未匹配到：', text, '可选：', items.map((d) => (d.textContent || '').trim()));
      return false;
    },

    // --- getCurrentReason ---
    getCurrentReason(dialog) {
      const trigger = this.findReasonTrigger(dialog);
      if (!trigger) return null;
      const t = (trigger.textContent || '').trim();
      if (t.startsWith('请选择')) return null;
      return t.replace(/[▲▼]/g, '').trim();
    },

    // --- findTextarea ---
    findTextarea(dialog) {
      return dialog.querySelector('textarea');
    },

    // --- findSubmitButton ---
    findSubmitButton(dialog) {
      for (const b of dialog.querySelectorAll('button, a, [role="button"]')) {
        if ((b.textContent || '').trim() === TXT.excSubmit) return b;
      }
      return null;
    },

    // --- getReasons ---
    getReasons() {
      return this.state.reasons.length ? this.state.reasons : this.EXC_REASONS_FALLBACK;
    },

    // --- selectReasonByIndex ---
    async selectReasonByIndex(dialog, index) {
      const reasons = this.getReasons();
      if (index < 0 || index >= reasons.length) return false;
      const panel = await this.openDropdown(dialog);
      if (!panel) return false;
      const ok = this.pickOption(panel, reasons[index]);
      if (ok) this.state.reasonIndex = index;
      return ok;
    },

    // --- moveReason ---  由键盘 ↑↓ 调用
    async moveReason(delta) {
      if (this.state.moving) { Core.log.debug('moveReason busy'); return; }
      const dialog = this.findDialog();
      if (!dialog) return;
      this.state.moving = true;
      try {
        const reasons = this.getReasons();
        const len = reasons.length;
        if (!len) return;
        const cur = this.state.reasonIndex;
        const next = ((cur < 0 ? 0 : cur + delta) + len) % len;
        const ok = await this.selectReasonByIndex(dialog, next);
        if (ok) {
          Core.log.info('切换原因 →', reasons[next], '(' + (next + 1) + '/' + len + ')');
          Hud.refresh();
        } else {
          Core.toast('切换原因失败', true);
        }
      } finally {
        this.state.moving = false;
      }
    },

    // --- submit ---  Enter / Ctrl+Enter 调用
    submit(dialog) {
      const btn = this.findSubmitButton(dialog);
      if (!btn || btn.disabled) {
        Core.log.warn('「提交异常」按钮不可用');
        Core.toast('提交按钮不可用', true);
        return;
      }
      Core.log.info('已点击「提交异常」');
      btn.click();
    },

    // --- onDialogOpen ---
    async onDialogOpen(dialog) {
      try {
        Fsm.transition(S.EXCEPTION_DIALOG, 'exception dialog detected');
        this.submittedDesc = null;
        this.state.reasonIndex = -1;
        this.state.reasons = [];
        this.state.moving = false;

        // 打开下拉读取真实选项，顺便决定是否自动选默认项
        const panel = await this.openDropdown(dialog);
        if (panel) {
          const items = [...panel.querySelectorAll(':scope > div')]
            .map((d) => (d.textContent || '').trim())
            .filter(Boolean);
          if (items.length) {
            this.state.reasons = items;
            Core.log.info('缓存原因列表：', items.length, '项');
          } else {
            Core.log.warn('下拉面板为空，使用 fallback');
          }

          const curr = this.getCurrentReason(dialog);
          if (curr) {
            const idx = this.getReasons().indexOf(curr);
            this.state.reasonIndex = idx;
            Core.log.info('原因已有值：', curr, 'index=', idx);
            await this.closeDropdownIfOpen(dialog);
          } else {
            // 默认选"数据异常"（在读取到的列表里精确匹配）
            const defaultIdx = this.getReasons().indexOf(TXT.excReasonDefault);
            const target = defaultIdx >= 0 ? defaultIdx : 0;
            const ok = this.pickOption(panel, this.getReasons()[target]);
            if (ok) this.state.reasonIndex = target;
            else Core.log.warn('默认选项选择失败');
          }
        } else {
          Core.log.warn('下拉未能打开，fallback 到静态列表（↑↓ 仍可用，但首次切换会即时打开）');
        }

        this.mountTemplatePanel(dialog);
      } catch (err) { Core.log.error('onDialogOpen 失败', err); }
    },

    // --- mountTemplatePanel ---
    mountTemplatePanel(dialog) {
      if (this.panelEl && this.panelEl.isConnected) return;

      const panel = document.createElement('div');
      panel.id = 'mk-exc-panel';
      Object.assign(panel.style, {
        position: 'fixed', top: '120px', left: '20px', zIndex: '2147483550',
        width: '340px', maxHeight: '72vh', background: '#fff',
        border: '1px solid #e5e6eb', borderRadius: '8px',
        boxShadow: '0 6px 24px rgba(0,0,0,.15)',
        font: '12px/1.5 system-ui,"PingFang SC",Arial', color: '#1d2129',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      });
      panel.innerHTML =
        '<div id="mk-exc-head" style="padding:8px 12px;background:#fff2f0;border-bottom:1px solid #ffccc7;cursor:move;display:flex;justify-content:space-between;align-items:center">' +
          '<b style="color:#cf1322">异常描述模板</b>' +
          '<div style="display:flex;gap:4px">' +
            '<button data-exc-act="append" title="追加而非覆盖" style="padding:2px 6px;border:1px solid #ffccc7;background:#fff;color:#cf1322;border-radius:3px;font-size:11px;cursor:pointer">追加</button>' +
            '<button data-exc-act="close" style="padding:2px 6px;border:1px solid #d9d9d9;background:#fff;border-radius:3px;font-size:11px;cursor:pointer">×</button>' +
          '</div>' +
        '</div>' +
        '<div style="padding:6px 10px;background:#fffbe6;border-bottom:1px solid #ffe58f;color:#874d00;font-size:11px;line-height:1.6">' +
          '<b>快捷键</b>：↑↓ 切换原因 · Enter 提交异常 · Ctrl+Enter（备注内也可提交）· 备注内其它按键放行' +
        '</div>' +
        '<div id="mk-exc-filter" style="padding:6px 10px;border-bottom:1px solid #f0f0f0">' +
          '<input type="text" placeholder="按关键词过滤…" data-no-drag' +
          ' style="width:100%;padding:4px 8px;border:1px solid #e5e6eb;border-radius:4px;font-size:12px;box-sizing:border-box">' +
        '</div>' +
        '<div id="mk-exc-list" style="flex:1;overflow:auto;padding:4px 0"></div>' +
        '<div style="padding:6px 10px;border-top:1px solid #f0f0f0;color:#86909c;font-size:11px">' +
          '点击填入备注 · Shift+点击仅复制' +
        '</div>';
      (document.body || document.documentElement).appendChild(panel);
      this.panelEl = panel;
      Drag.enable(panel, { handle: panel.querySelector('#mk-exc-head'), storageKey: 'mk_pos_exc' });

      const list = panel.querySelector('#mk-exc-list');
      const filter = panel.querySelector('#mk-exc-filter input');
      const btnAppend = panel.querySelector('button[data-exc-act="append"]');
      let appendMode = false;

      btnAppend.addEventListener('click', () => {
        appendMode = !appendMode;
        btnAppend.style.background = appendMode ? '#cf1322' : '#fff';
        btnAppend.style.color = appendMode ? '#fff' : '#cf1322';
        btnAppend.textContent = appendMode ? '追加✓' : '追加';
      });
      panel.querySelector('button[data-exc-act="close"]').addEventListener('click', () => {
        panel.style.display = 'none';
      });

      const render = (kw) => {
        const q = (kw || '').toLowerCase().trim();
        list.innerHTML = EXCEPTION_TEMPLATES.map((group) => {
          const items = group.items.filter((it) =>
            !q ||
            it.name.toLowerCase().includes(q) ||
            it.desc.toLowerCase().includes(q) ||
            it.code.includes(q)
          );
          if (!items.length) return '';
          return '<div style="padding:4px 10px 2px;color:#86909c;font-weight:600;font-size:11px;background:#fafafa">' + group.cat + '</div>' +
            items.map((it) =>
              '<div class="mk-exc-item" data-desc="' + encodeURIComponent(it.desc) + '"' +
              ' style="padding:6px 10px;border-bottom:1px solid #f5f5f5;cursor:pointer">' +
                '<div style="color:#1d2129;font-size:12px">' +
                  '<span style="color:#cf1322;font-weight:600">' + it.code + '</span> ' + it.name +
                '</div>' +
                '<div style="color:#86909c;font-size:11px;margin-top:2px;line-height:1.4">' + it.desc + '</div>' +
              '</div>'
            ).join('');
        }).join('');

        list.querySelectorAll('.mk-exc-item').forEach((el) => {
          el.addEventListener('mouseenter', () => { el.style.background = '#fff2f0'; });
          el.addEventListener('mouseleave', () => { el.style.background = ''; });
          el.addEventListener('click', (e) => {
            const desc = decodeURIComponent(el.getAttribute('data-desc'));
            if (e.shiftKey) {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(desc).then(
                  () => Core.toast('已复制'),
                  (err) => Core.log.error('复制失败', err)
                );
              } else {
                Core.log.warn('剪贴板不可用');
              }
              return;
            }
            this.fillTextarea(dialog, desc, appendMode);
          });
        });
      };

      filter.addEventListener('input', () => render(filter.value));
      render('');
    },

    // --- fillTextarea ---
    fillTextarea(dialog, desc, append) {
      const ta = this.findTextarea(dialog);
      if (!ta) { Core.log.warn('未找到备注 textarea'); return; }
      const value = append && ta.value
        ? (ta.value.replace(/\s*$/, '') + '\n' + desc)
        : desc;
      const ok = Core.reactSetValue(ta, value);
      if (ok) {
        this.submittedDesc = value;
        Core.toast(append ? '已追加到备注' : '已填入备注');
        Core.log.info('备注已填：', value.slice(0, 60));
      } else {
        Core.toast('填入失败，详见控制台', true);
      }
    },

    // --- teardown ---
    teardown() {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      if (this.guardClick) { document.removeEventListener('click', this.guardClick, true); this.guardClick = null; }
      if (this.panelEl && this.panelEl.isConnected) this.panelEl.remove();
      this.panelEl = null;
    },

    // --- watchSubmit ---
    watchSubmit(dialog) {
      Fsm.transition(S.EXCEPTION_SUBMITTING, 'exception submit clicked');
      let cancelled = false;

      this.guardClick = (e) => {
        if (!(e.target instanceof Element)) return;
        const b = e.target.closest('button, a, [role="button"]');
        if (b && (b.textContent || '').trim() === TXT.excCancel) {
          cancelled = true;
          Core.log.info('异常弹窗检测到「取消」');
        }
      };
      document.addEventListener('click', this.guardClick, true);

      const started = Date.now();
      this.pollTimer = setInterval(() => {
        try {
          if (cancelled) {
            this.teardown();
            Fsm.transition(S.EXCEPTION_DIALOG, 'user cancelled exception');
            return;
          }
          if (!dialog.isConnected) {
            this.teardown();
            Core.log.info('异常弹窗关闭，推进批次（算作完成）');
            if (Batch.data) Batch.advance('exception');
            else Finish.attemptCloseTab();
            return;
          }
          if (Date.now() - started > Cfg.get('finishWaitTimeout')) {
            this.teardown();
            Fsm.transition(S.EXCEPTION_DIALOG, 'exception wait timeout');
            Core.toast('异常提交超时', true);
          }
        } catch (err) { Core.log.error('exception 检测异常', err); this.teardown(); }
      }, 150);
    },

    // --- detect ---
    detect() {
      const d = this.findDialog();
      if (d) {
        if (!Fsm.isAny(S.EXCEPTION_DIALOG, S.EXCEPTION_SUBMITTING)) {
          this.onDialogOpen(d);
        }
        return;
      }
      if (Fsm.is(S.EXCEPTION_DIALOG)) {
        Core.log.warn('异常弹窗已消失但状态滞留，回退 IDLE');
        Fsm.transition(S.IDLE, 'exception dialog vanished');
      }
      if (this.panelEl && this.panelEl.isConnected && !Fsm.is(S.EXCEPTION_SUBMITTING)) {
        this.teardown();
      }
    },
  };

  // =========================================================================
  // Hud
  // =========================================================================
  const Hud = {
    root: null,
    lastError: null,
    refreshTimer: null,

    setLastError(args) {
      try { this.lastError = args.map(stringify).join(' ').slice(0, 100); }
      catch (e) { console.warn(TAG, 'HUD 错误摘要处理失败', e); }
    },

    // --- mount ---
    mount() {
      if (document.getElementById('mk-hud')) return;
      const collapsed = Core.storeGet('mk_hud_collapsed', false);
      const el = document.createElement('div');
      el.id = 'mk-hud';
      Object.assign(el.style, {
        position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483500',
        minWidth: '240px', maxWidth: '320px', background: 'rgba(255,255,255,.96)',
        border: '1px solid #d9d9d9', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.12)',
        font: '12px/1.6 system-ui,"PingFang SC",Arial', color: '#1d2129',
        backdropFilter: 'blur(6px)',
      });
      el.innerHTML =
        '<div id="mk-hud-head" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:#f5f7fa;border-radius:8px 8px 0 0;cursor:move;user-select:none">' +
          '<b>标注助手 <span style="color:#86909c;font-weight:normal">v' + VERSION + '</span></b>' +
          '<span id="mk-hud-toggle" style="color:#86909c;cursor:pointer" data-no-drag>' + (collapsed ? '▲' : '▼') + '</span>' +
        '</div>' +
        '<div id="mk-hud-body" style="padding:8px 10px;display:' + (collapsed ? 'none' : 'block') + '">' +
          '<div id="mk-hud-rows"></div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
            '<button data-act="pause" style="padding:3px 8px;border:1px solid #d9d9d9;background:#fff;border-radius:4px;cursor:pointer;font-size:12px">暂停</button>' +
            '<button data-act="mode" style="padding:3px 8px;border:1px solid #d9d9d9;background:#fff;border-radius:4px;cursor:pointer;font-size:12px">切模式</button>' +
            '<button data-act="speed" style="padding:3px 8px;border:1px solid #d9d9d9;background:#fff;border-radius:4px;cursor:pointer;font-size:12px">3×</button>' +
            '<button data-act="skip" style="padding:3px 8px;border:1px solid #d9d9d9;background:#fff;border-radius:4px;cursor:pointer;font-size:12px">跳过</button>' +
            '<button data-act="abort" style="padding:3px 8px;border:1px solid #ffccc7;background:#fff2f0;color:#cf1322;border-radius:4px;cursor:pointer;font-size:12px">中止</button>' +
            '<button data-act="cfg" style="padding:3px 8px;border:1px solid #d9d9d9;background:#fff;border-radius:4px;cursor:pointer;font-size:12px">⚙</button>' +
            '<button data-act="reset-pos" title="重置所有浮层位置" style="padding:3px 8px;border:1px solid #d9d9d9;background:#fff;border-radius:4px;cursor:pointer;font-size:12px">⇱</button>' +
          '</div>' +
          '<div id="mk-hud-cfg" style="display:none;margin-top:8px;padding:8px;background:#fafafa;border-radius:4px"></div>' +
          '<div style="margin-top:6px;color:#86909c;font-size:11px">' +
            'Alt+Space 暂停 · Alt+M 模式 · Alt+3 速度 · Alt+S 跳过 · Alt+B 中止 · Alt+H 折叠' +
          '</div>' +
        '</div>';
      (document.body || document.documentElement).appendChild(el);
      this.root = el;

      Drag.enable(el, { handle: el.querySelector('#mk-hud-head'), storageKey: 'mk_pos_hud' });

      const toggle = el.querySelector('#mk-hud-toggle');
      toggle.addEventListener('click', (e) => { e.stopPropagation(); this.toggleCollapse(); });

      el.querySelectorAll('button[data-act]').forEach((b) => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = b.getAttribute('data-act');
          if (act === 'pause') Fsm.togglePause();
          else if (act === 'mode') Mode.cycle();
          else if (act === 'speed') Speed.set(Cfg.get('speedTarget'));
          else if (act === 'skip') Batch.data ? Batch.skip('HUD skip') : Core.toast('非批次模式', true);
          else if (act === 'abort') Batch.data ? Batch.abort('HUD abort') : Core.toast('非批次模式', true);
          else if (act === 'cfg') this.toggleCfgPanel();
          else if (act === 'reset-pos') Drag.resetAll();
        });
      });

      this.renderCfgPanel();
      this.refresh();
      this.refreshTimer = setInterval(() => this.refresh(), 2000);
    },

    // --- toggleCollapse ---
    toggleCollapse() {
      const body = this.root.querySelector('#mk-hud-body');
      const tog = this.root.querySelector('#mk-hud-toggle');
      const now = body.style.display === 'none';
      body.style.display = now ? 'block' : 'none';
      tog.textContent = now ? '▼' : '▲';
      Core.storeSet('mk_hud_collapsed', !now);
    },

    // --- toggleCfgPanel ---
    toggleCfgPanel() {
      const p = this.root.querySelector('#mk-hud-cfg');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    },

    // --- renderCfgPanel ---
    renderCfgPanel() {
      const p = this.root.querySelector('#mk-hud-cfg');
      const keys = Object.keys(DEFAULT_CFG);
      p.innerHTML = keys.map((k) =>
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
          '<label style="flex:1;font-size:11px;color:#4e5969">' + k + '</label>' +
          '<input data-key="' + k + '" type="number" value="' + Cfg.get(k) + '" data-no-drag' +
          ' style="width:70px;padding:2px 4px;border:1px solid #d9d9d9;border-radius:3px;font-size:11px">' +
        '</div>'
      ).join('') +
        '<button data-cfg-reset style="margin-top:4px;padding:3px 8px;border:1px solid #d9d9d9;background:#fff;border-radius:4px;cursor:pointer;font-size:11px">重置默认</button>';

      p.querySelectorAll('input[data-key]').forEach((inp) => {
        inp.addEventListener('change', () => {
          Cfg.set(inp.getAttribute('data-key'), inp.value);
        });
      });
      p.querySelector('[data-cfg-reset]').addEventListener('click', () => {
        Cfg.reset();
        this.renderCfgPanel();
      });
    },

    // --- refresh ---
    refresh() {
      if (!this.root || !this.root.isConnected) return;
      const rows = this.root.querySelector('#mk-hud-rows');
      if (!rows) return;

      const eta = Batch.getETA();
      const batchStr = Batch.data
        ? ((Batch.index() + 1) + '/' + Batch.data.i.length +
           (eta !== null ? ' · ETA ' + Core.fmtDuration(eta) : ''))
        : '（无批次）';

      // #2 口径统一：done 含异常
      let resultStr = null;
      if (Batch.data) {
        const done = Batch.data.done || 0;
        const exc = Batch.data.exc || 0;
        const okCount = Math.max(0, done - exc);
        resultStr = okCount + ' 正常 / ' + exc + ' 异常';
      }

      const cursor = IS_ANNOT ? Annotate.getCursor() : null;

      rows.innerHTML = [
        row('状态', (Fsm.paused ? '⏸ ' : '') + Fsm.state, Fsm.paused ? '#faad14' : null),
        row('模式', MODE_META[Mode.get()].label),
        IS_ANNOT ? row('批次', batchStr) : null,
        IS_ANNOT && resultStr ? row('本批结果', resultStr) : null,
        IS_ANNOT ? row('速度', Speed.ok ? (Cfg.get('speedTarget') + '× ✓') : '待设置', Speed.ok ? '#52c41a' : '#faad14') : null,
        IS_ANNOT ? row('本包游标', cursor ? ('第 ' + (cursor.index + 1) + ' 项') : '--') : null,
        IS_ANNOT ? row('自动 Q', Annotate.qCount + ' / ' + Cfg.get('maxAutoQPerDoc')) : null,
        this.lastError ? row('最近错误', this.lastError, '#cf1322') : null,
      ].filter(Boolean).join('');

      const pauseBtn = this.root.querySelector('button[data-act="pause"]');
      if (pauseBtn) pauseBtn.textContent = Fsm.paused ? '继续' : '暂停';

      function row(label, value, color) {
        const v = (value === null || value === undefined) ? '' : String(value);
        return '<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:3px">' +
          '<span style="color:#86909c">' + label + '</span>' +
          '<span style="color:' + (color || '#1d2129') + ';text-align:right;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + v.replace(/"/g, '&quot;') + '">' + v + '</span>' +
        '</div>';
      }
    },

    // --- dispose ---
    dispose() {
      if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
      if (this.root && this.root.isConnected) this.root.remove();
      this.root = null;
    },
  };

    // =========================================================================
  // Keys
  // =========================================================================
  const Keys = {
    // --- onKey ---
    onKey(e) {
      // 1. Alt 组合优先
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'm') { e.preventDefault(); e.stopPropagation(); Mode.cycle(); return; }
        if (k === 's') { e.preventDefault(); e.stopPropagation(); Batch.data ? Batch.skip('Alt+S') : Core.toast('非批次', true); return; }
        if (k === 'b') { e.preventDefault(); e.stopPropagation(); Batch.data ? Batch.abort('Alt+B') : Core.toast('非批次', true); return; }
        if (k === 'h') { e.preventDefault(); e.stopPropagation(); Hud.toggleCollapse(); return; }
        if (k === '3') {
          e.preventDefault(); e.stopPropagation();
          Speed.set(Cfg.get('speedTarget')).then((ok) => {
            Core.toast(ok ? '已切 3×' : '3× 失败', !ok);
          });
          return;
        }
        if (k === ' ' || e.code === 'Space') {
          e.preventDefault(); e.stopPropagation();
          Fsm.togglePause();
          Core.toast(Fsm.paused ? '已暂停自动化' : '已恢复自动化', Fsm.paused);
          return;
        }
        return;
      }

      // 2. 异常弹窗（优先级高于完成框和技能 modal）
      const excDialog = Exception.findDialog();
      if (excDialog) {
        const t = e.target;
        const insideTa = t && t.tagName === 'TEXTAREA' && excDialog.contains(t);

        // textarea 内：Ctrl/Cmd+Enter 提交；其它按键一律放行
        if (insideTa) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault(); e.stopPropagation();
            try { Exception.submit(excDialog); }
            catch (err) { Core.log.error('提交异常失败', err); }
            return;
          }
          return;
        }

        // 非 textarea：过滤 Ctrl/Meta
        if (e.ctrlKey || e.metaKey) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); e.stopPropagation();
          try { Exception.moveReason(e.key === 'ArrowDown' ? 1 : -1); }
          catch (err) { Core.log.error('切换原因失败', err); }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          try { Exception.submit(excDialog); }
          catch (err) { Core.log.error('提交异常失败', err); }
          return;
        }
        return;
      }

      // 3. 后续按键过滤 Ctrl/Meta（Alt 已前置处理）
      if (e.ctrlKey || e.metaKey) return;

      // 4. 完成确认框
      const finishDialog = Finish.findDialog();
      if (finishDialog) {
        if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation();
          try { Finish.handleEnter(finishDialog); }
          catch (err) { Core.log.error('完成确认失败', err); }
        }
        return;
      }

      // 5. 技能选择 modal
      const modal = document.querySelector(SEL.modal);
      if (!modal) return;
      const target = e.target;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (Core.isEditable(target)) return;
        e.preventDefault(); e.stopPropagation();
        try { Annotate.moveSelection(modal, e.key === 'ArrowDown' ? 1 : -1); }
        catch (err) { Core.log.error('移动选中失败', err); }
        return;
      }
      if (e.key === 'Enter') {
        if (!target) return;
        if (target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.isContentEditable) return;
        e.preventDefault(); e.stopPropagation();
        try { Annotate.confirmModal(modal); } catch (err) { Core.log.error('提交失败', err); }
      }
    },

    // --- onClick ---
    onClick(e) {
      if (!(e.target instanceof Element)) return;
      const btn = e.target.closest('button, a, [role="button"]');
      if (!btn) return;
      const btnText = (btn.textContent || '').trim();

      if (btnText === TXT.excSubmit) {
        const excDialog = btn.closest('div[role="dialog"]');
        if (excDialog && Exception.isExceptionDialog(excDialog) && !Fsm.is(S.EXCEPTION_SUBMITTING)) {
          Core.log.info('检测到「提交异常」点击');
          Exception.watchSubmit(excDialog);
        }
        return;
      }

      if (Annotate.isConfirmButton(btn)) {
        const modal = btn.closest(SEL.modal);
        if (!modal || Fsm.is(S.MODAL_SUBMITTING)) return;
        const radios = Array.from(modal.querySelectorAll(SEL.radio));
        const idx = radios.findIndex((r) => r.checked);
        if (idx === -1) { Core.log.warn('提交时无选中，游标不推进'); return; }
        Annotate.watchSubmitResult(modal, Annotate.computeFp(radios), idx);
      }
    },
  };

  // =========================================================================
  // Mk：入口
  // =========================================================================
  const Mk = {
    version: VERSION,
    page: IS_ANNOT ? 'annotate' : 'task',

    // --- bootTask ---
    bootTask() {
      Cfg.init();
      Core.log.info('任务页初始化 v' + VERSION);
      const run = () => {
        Task.handleDoneFlag();
        Task.mountPanel();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true });
      } else { run(); }
    },

    // --- bootAnnotate ---
    bootAnnotate() {
      Cfg.init();
      Annotate._migrateCursor();
      Core.log.info('标注页初始化 v' + VERSION);

      const sp = new URLSearchParams(location.search);
      Annotate.jobId = sp.get('ds.content');
      if (!Annotate.jobId) { Core.log.warn('URL 无 ds.content，不启用自动化'); return; }

      Batch.data = Batch.read();
      if (Batch.data) {
        Annotate.taskId = Batch.data.t;
        const idx = Batch.index();
        if (idx < 0) Core.log.warn('当前包不在批次队列');
        else Batch.persist(Batch.data);
        Batch.mountPill();
        Batch.pkgStart = Date.now();
        Core.log.info('批次就绪', (idx + 1) + '/' + Batch.data.i.length);
      } else {
        Core.log.info('单包模式');
      }

      Hud.mount();

      document.addEventListener('keydown', Keys.onKey, false);
      document.addEventListener('click', Keys.onClick, true);
      window.addEventListener('beforeunload', () => Fsm.transition(S.NAVIGATING, 'beforeunload'));
      window.addEventListener('pagehide', () => Fsm.transition(S.NAVIGATING, 'pagehide'));

      const observer = new MutationObserver(() => {
        if (Annotate.modalScheduled) return;
        Annotate.modalScheduled = true;
        setTimeout(() => {
          Annotate.modalScheduled = false;
          Annotate.checkModal();
          Exception.detect();
          Finish.detect();
        }, 100);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      this._observer = observer;

      Annotate.checkModal();
      Exception.detect();
      Finish.detect();
      Speed.schedule();

      Core.log.info('已启用（模式：' + MODE_META[Mode.get()].label +
        '｜jobId：' + Annotate.jobId + (Batch.data ? '｜批次' : '') + '）');
    },

    // --- dispose ---
    dispose() {
      try { if (this._observer) this._observer.disconnect(); }
      catch (e) { console.warn(TAG, 'dispose: observer 取消失败', e); }
      try { Hud.dispose(); }
      catch (e) { console.warn(TAG, 'dispose: HUD 清理失败', e); }
      try { Exception.teardown(); }
      catch (e) { console.warn(TAG, 'dispose: 异常面板清理失败', e); }
      try { Finish.teardown(); }
      catch (e) { console.warn(TAG, 'dispose: 完成流程清理失败', e); }
      try { Annotate.cancelAutoSubmit(); }
      catch (e) { console.warn(TAG, 'dispose: 自动提交取消失败', e); }
      try { Annotate.cancelKick(); }
      catch (e) { console.warn(TAG, 'dispose: kick 取消失败', e); }
      try { Speed.dispose(); }
      catch (e) { console.warn(TAG, 'dispose: 倍速清理失败', e); }
      try { document.removeEventListener('keydown', Keys.onKey, false); }
      catch (e) { console.warn(TAG, 'dispose: keydown 解绑失败', e); }
      try { document.removeEventListener('click', Keys.onClick, true); }
      catch (e) { console.warn(TAG, 'dispose: click 解绑失败', e); }
    },

    // 子模块
    core: Core, task: Task, batch: Batch, annotate: Annotate, finish: Finish,
    exception: Exception, speed: Speed, hud: Hud, mode: Mode, fsm: Fsm,
    cfg: Cfg, logs: Logs, drag: Drag,

    // --- 调试 API ---
    ping() {
      return {
        version: VERSION,
        page: this.page,
        jobId: Annotate.jobId,
        taskId: Annotate.taskId,
        batch: Batch.data && {
          total: Batch.data.i.length,
          idx: Batch.index(),
          done: Batch.data.done,
          exc: Batch.data.exc,
        },
        fsm: Fsm.state,
        paused: Fsm.paused,
        mode: Mode.get(),
        speedOk: Speed.ok,
        qCount: Annotate.qCount,
        cursor: IS_ANNOT ? Annotate.getCursor() : null,
      };
    },
    cursor: () => Annotate.getCursor(),
    resetCursor: () => Annotate.resetCursor(),
    cycleMode: () => Mode.cycle(),
    skip: () => Batch.skip('debug'),
    abort: () => Batch.abort('debug'),
    enqueue: (jobId) => Batch.enqueue(jobId),
    pause: () => Fsm.pause(),
    resume: () => Fsm.resume(),
    setSpeed: (n) => Speed.set(n),
    probeSpeed: () => Speed.probe(),
    resetPositions: () => Drag.resetAll(),
    probeExc: () => {
      const d = Exception.findDialog();
      return {
        dialogFound: !!d,
        currentReason: d ? Exception.getCurrentReason(d) : null,
        hasTextarea: !!(d && Exception.findTextarea(d)),
        triggerFound: !!(d && Exception.findReasonTrigger(d)),
        panelMounted: !!(Exception.panelEl && Exception.panelEl.isConnected),
        reasonIndex: Exception.state.reasonIndex,
        reasonsCache: Exception.state.reasons,
      };
    },
    speedOptions() {
      const btn = Speed.getButton();
      if (btn) btn.click();
      return Speed.waitOption(-1, 600).then(() => Speed.collectOptions().map((o) => o.text));
    },
    exportLogs: () => Logs.export(),
    dumpLogs: (n) => Logs.dump(n),
  };

  window.__mk__ = Mk;
  if (IS_ANNOT) Mk.bootAnnotate();
  else Mk.bootTask();
})();