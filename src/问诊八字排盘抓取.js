// ==UserScript==
// @name         问诊八字排盘抓取
// @namespace    http://tampermonkey.net/
// @version      2026.11.09.1
// @description  抓取 .pro-pan-content 整块（主表 + 起运 + 大运/流年/流月 + 五行），导出 Markdown / JSON
// @author       You
// @match        https://pcbz.iwzwh.com/index.html*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=iwzwh.com
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// 副作用：
// - 只读 DOM：.pro-pan-content 及其子结构
// - 写 localStorage：bz-panel-pos-v5（面板位置）
// - 注入 #bz-panel 与一段 <style> 到页面
// - 复制到剪贴板：navigator.clipboard，失败时回退 execCommand
// - 未使用 GM_* / unsafeWindow / eval / @require
// - 调试命名空间：window.__bazi_debug__（可 delete 清理）

// 控制台定位本脚本问题：
// 1. F12 → Console → 过滤框输入 [bazi]
// 2. 展开红色 error 行堆栈，点击跳到 Sources 对应行
// 3. 在 readPanel / readWithRetry / toMarkdown / boot 处下断点
// 4. 检查内部状态：Console 输入 __bazi_debug__.state

(function () {
  'use strict';

  const TAG = '[bazi]';
  const debug = (window.__bazi_debug__ = {
    state: { lastRows: 0, lastReadAt: null, lastError: null },
    log: (...a) => console.debug(TAG, ...a),
    warn: (...a) => console.warn(TAG, ...a),
    error: (...a) => console.error(TAG, ...a),
  });

  /* ============ 1. 常量 ============ */

  const ROOT_SEL = '.pro-pan-content';
  const POS_KEY  = 'bz-panel-pos-v5';

  const TOKENS = {
    bg:'rgba(26,26,46,.94)', fg:'#e8e6f0', accent:'#7c9cf5',
    ok:'#4ade80', err:'#f87171',
    radius:'10px', shadow:'0 6px 22px rgba(0,0,0,.45)',
    font:'13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
  };

  /* ============ 2. 通用工具 ============ */

  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const dedupe = (arr) => arr.filter((v, i) => v && arr.indexOf(v) === i);

  /**
   * 单元格文本抽取：
   *   - 若存在「最内层」span：收集其中文本，做「单字 + 2~4 字中文」的成对合并，
   *     例如 [丁, 正财, 己, 正官] → [丁正财, 己正官]。
   *   - 否则退回 textContent。
   */
  function cellText(cell) {
    if (!cell) return '';
    const inner = [...cell.querySelectorAll('span')].filter((s) => !s.querySelector('span'));
    if (inner.length) {
      const parts = inner.map(txt).filter(Boolean);
      const merged = [];
      for (let i = 0; i < parts.length; i++) {
        const cur = parts[i], nxt = parts[i + 1];
        // 单字天干/地支 + 2~4 字十神名 → 合并（如 丁 + 正财 → 丁正财）
        if (cur.length === 1 && nxt && /^[\u4e00-\u9fa5]{2,4}$/.test(nxt)) {
          merged.push(cur + nxt); i++;
        } else merged.push(cur);
      }
      return dedupe(merged).join('、');
    }
    return txt(cell);
  }

  /* ============ 3. 抽取器 ============ */

  /** 左栏主表：每个 .pro-pan-row → 其直接子 .pro-pan-row-item[] 的文本 */
  function readMainTable(root) {
    const left = root.querySelector('.pro-pan-content-left');
    if (!left) return [];
    const rows = [];
    left.querySelectorAll('.pro-pan-row').forEach((row) => {
      const cells = [...row.querySelectorAll(':scope > .pro-pan-row-item')].map(cellText);
      if (cells.some(Boolean)) rows.push(cells);
    });
    return rows;
  }

  /** 起运栏：左（起运/交运）、中（空亡）、右（年龄 / 司令） */
  function readQiyun(root) {
    const q = root.querySelector('.pro-pan-qiyun');
    if (!q) return null;
    const out = {};
    const left = q.querySelector('.pro-pan-qiyun-left');
    if (left) {
      [...left.children].forEach((d) => {
        const t = txt(d);
        const m1 = t.match(/^起运[：:]\s*(.+)$/);
        const m2 = t.match(/^交运[：:]\s*(.+)$/);
        if (m1) out['起运'] = m1[1].trim();
        if (m2) out['交运'] = m2[1].trim();
      });
    }
    const mid = q.querySelector('.pro-pan-qiyun-middle');
    if (mid) out['空亡'] = txt(mid).replace(/（日）\s*$/, '').trim();
    const age = q.querySelector('.pro-pan-qiyun-right .age');
    if (age) out['当前年龄'] = txt(age);
    const rysl = q.querySelector('.rysl');
    if (rysl) out['司令'] = txt(rysl).replace(/^司令[：:]\s*/, '');
    return Object.keys(out).length ? out : null;
  }

  /** 大运 / 流年 / 流月：三组同构序列，按 .pro-pan-yun 分组解析 */
  function readYun(root) {
    const groups = [];
    // 只取「有 items 的」yun 组（右侧起运块下真实的三档）
    root.querySelectorAll('.pro-pan-yun').forEach((g) => {
      const titleEl = g.querySelector(':scope > .pro-pan-yun-item.pro-pan-yun-item-title');
      if (!titleEl) return;
      // 标题可能拆成多个 span（「大 运」「流 年 小运」），拼在一起
      const title = [...titleEl.querySelectorAll('span')].map(txt).join('');
      const items = [];
      g.querySelectorAll('.pro-pan-yun-items > .pro-pan-yun-item').forEach((it) => {
        const smalls = [...it.querySelectorAll(':scope > .pro-pan-yun-item-small')].map(txt).filter(Boolean);
        const labels = [...it.querySelectorAll(':scope > .pro-pan-yun-item-label')]
          .map((l) => {
            const t = txt(l.querySelector('.pro-pan-yun-item-text'));
            const s = txt(l.querySelector('.pro-pan-yun-item-shishen'));
            return t + s; // 「壬」+「比」→「壬比」
          })
          .filter(Boolean);
        items.push({
          head:     smalls[0] || '',
          time:     smalls[1] || '',
          gz:       labels,                 // 如 ['壬比','戌杀']；大运/流年可能有 2 项，流月同样 2 项
          extra:    smalls[2] || '',        // 流年第三个小字（如「庚申」）；大运的「1~9岁」也在 time
          selected: it.classList.contains('pro-pan-yun-item-selected'),
        });
      });
      if (items.length) groups.push({ title, items });
    });
    return groups;
  }

  /** 五行旺衰：金旺 / 水相 / ... */
  function readWuxing(root) {
    const box = root.querySelector('.pro-pan-wuxing');
    if (!box) return [];
    return [...box.querySelectorAll('.pro-pan-wuxing-item')].map(txt).filter(Boolean);
  }

  /** 顶层读取 */
  function readPanel() {
    const root = document.querySelector(ROOT_SEL);
    if (!root) return null;
    const data = {
      url:     location.origin + location.pathname,
      header:  readMainTable(root),
      qiyun:   readQiyun(root),
      yun:     readYun(root),
      wuxing:  readWuxing(root),
    };
    if (!data.header.length && !data.yun.length && !data.wuxing.length) return null;
    debug.state.lastRows = data.header.length + data.yun.reduce((a, g) => a + g.items.length, 0);
    debug.state.lastReadAt = new Date().toISOString();
    return data;
  }

  /* ============ 4. 序列化 ============ */

  function mdTable(rows) {
    if (!rows.length) return '';
    const w = Math.max(...rows.map((r) => r.length));
    const pad = (r) => [...r, ...Array(w - r.length).fill('')];
    const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const [h, ...b] = rows.map(pad);
    return [
      '| ' + h.map(esc).join(' | ') + ' |',
      '| ' + h.map(() => '---').join(' | ') + ' |',
      ...b.map((r) => '| ' + r.map(esc).join(' | ') + ' |'),
    ].join('\n');
  }

  function toMarkdown(d) {
    const out = ['# 八字排盘\n', `> 来源：${d.url}\n`];

    if (d.header.length) out.push('## 主盘\n', mdTable(d.header) + '\n');

    if (d.qiyun && Object.keys(d.qiyun).length) {
      out.push('## 起运信息\n');
      Object.entries(d.qiyun).forEach(([k, v]) => out.push(`- **${k}**：${v}`));
      out.push('');
    }

    (d.yun || []).forEach((g) => {
      out.push(`## ${g.title}\n`);
      // 三档运势列结构略有差异：
      //   大运：年份 | 年龄 | 干支 | 十神      (head/time + 2 gz)
      //   流年：年份 | —    | 干支 | 十神 | 小运
      //   流月：节气 | 日期 | 干支 | 十神
      const isLiuyue = g.title.includes('流月');
      const head = isLiuyue
        ? ['节气', '日期', '干支', '十神']
        : g.title.includes('流年')
          ? ['年份', '', '干支', '十神', '小运']
          : ['年份', '年龄', '干支', '十神'];

      const rows = g.items.map((it) => {
        // gz 形如 ['壬比','戌杀'] → 干支「壬戌」/ 十神「比杀」
        const gz = it.gz.map((s) => s.charAt(0)).join('');
        const ss = it.gz.map((s) => s.slice(1)).join('');
        if (isLiuyue) return [it.head, it.time, gz, ss];
        if (g.title.includes('流年')) return [it.head, '', gz, ss, it.extra];
        return [it.head, it.time, gz, ss];
      });
      out.push(mdTable([head, ...rows]) + '\n');
    });

    if (d.wuxing && d.wuxing.length) {
      out.push('## 五行旺衰\n', d.wuxing.join(' · ') + '\n');
    }
    return out.join('\n');
  }

  const toJSON = (d) => JSON.stringify(d, null, 2);

  /* ============ 5. UI ============ */

  function injectStyle() {
    const css = `
      #bz-panel{position:fixed;z-index:2147483647;background:${TOKENS.bg};color:${TOKENS.fg};
        font:${TOKENS.font};border-radius:${TOKENS.radius};box-shadow:${TOKENS.shadow};
        width:220px;user-select:none;backdrop-filter:blur(4px);}
      #bz-panel .bz-bar{display:flex;align-items:center;justify-content:space-between;
        padding:8px 10px;cursor:move;border-bottom:1px solid rgba(255,255,255,.08);
        font-weight:600;letter-spacing:.3px;}
      #bz-panel .bz-dot{width:8px;height:8px;border-radius:50%;
        background:${TOKENS.accent};display:inline-block;margin-right:6px;}
      #bz-panel .bz-body{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px;}
      #bz-panel button{all:unset;cursor:pointer;text-align:center;padding:7px 4px;
        border-radius:7px;background:rgba(255,255,255,.07);font-size:12px;transition:background .15s;}
      #bz-panel button:hover{background:rgba(255,255,255,.16);}
      #bz-panel button.bz-full{grid-column:1 / -1;}
      #bz-panel .bz-status{grid-column:1 / -1;font-size:11px;min-height:14px;
        color:${TOKENS.accent};text-align:center;}
    `;
    const s = document.createElement('style');
    s.id = 'bz-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  function makePanel() {
    const panel = document.createElement('div');
    panel.id = 'bz-panel';
    panel.innerHTML = `
      <div class="bz-bar"><span><span class="bz-dot"></span>问诊八字排盘抓取</span><span>⠿</span></div>
      <div class="bz-body">
        <button data-act="scrape" class="bz-full">读取整块</button>
        <button data-act="md">复制 MD</button>
        <button data-act="json">复制 JSON</button>
        <div class="bz-status"></div>
      </div>`;

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); }
    catch (err) { debug.warn('load panel position failed, use default', err); }
    const setPos = (x, y) => {
      const w = panel.offsetWidth || 220, h = panel.offsetHeight || 100;
      panel.style.left  = clamp(x, 0, innerWidth  - w) + 'px';
      panel.style.top   = clamp(y, 0, innerHeight - h) + 'px';
      panel.style.right = panel.style.bottom = 'auto';
    };
    if (saved) setPos(saved.x, saved.y);
    else { panel.style.right = '16px'; panel.style.bottom = '16px'; }

    const bar = panel.querySelector('.bz-bar');
    let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
    bar.addEventListener('pointerdown', (e) => {
      drag = true;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      setPos(ox, oy); bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (drag) setPos(ox + (e.clientX - sx), oy + (e.clientY - sy));
    });
    const end = (e) => {
      if (!drag) return; drag = false;
      const r = panel.getBoundingClientRect();
      localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }));
      try { bar.releasePointerCapture(e.pointerId); } catch (err) { debug.warn('releasePointerCapture failed', err); }
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    return panel;
  }

  function toast(panel, msg, ok = true) {
    const s = panel.querySelector('.bz-status');
    s.textContent = msg;
    s.style.color = ok ? TOKENS.ok : TOKENS.err;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { s.textContent = ''; }, 2600);
  }

  /* ============ 6. 装配 ============ */

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (err) {
      debug.warn('navigator.clipboard failed, fallback to execCommand', err);
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }
  }

  function readWithRetry(maxTries = 10, interval = 500) {
    return new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        const data = readPanel();
        if (data) {
          debug.log('readPanel ok', { tries: tries + 1 });
          return resolve(data);
        }
        if (++tries >= maxTries) {
          debug.warn('readPanel timeout', { maxTries, interval });
          return resolve(null);
        }
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function boot() {
    if (window.__bazi_loaded__) { debug.warn('already loaded, skip'); return; }
    window.__bazi_loaded__ = true;
    injectStyle();
    const panel = makePanel();
    if (!document.body) { debug.error('document.body missing, mount aborted'); return; }
    document.body.appendChild(panel);
    debug.log('mounted');
    let cache = null;

    panel.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;

      if (act === 'scrape') {
        toast(panel, '读取中…');
        cache = await readWithRetry();
        if (!cache) return toast(panel, '未找到 .pro-pan-content', false);
        const n = cache.header.length + cache.yun.reduce((a, g) => a + g.items.length, 0);
        toast(panel, `已读取：主表 ${cache.header.length} 行 / 运势 ${n} 项`);
        return;
      }
      if (!cache) cache = await readWithRetry(3, 400);
      if (!cache) return toast(panel, '无数据，请先读取', false);
      const ok = await copy(act === 'md' ? toMarkdown(cache) : toJSON(cache));
      toast(panel, ok ? '已复制到剪贴板' : '复制失败', ok);
    });
  }

  window.__bazi_teardown__ = () => {
    document.getElementById('bz-panel')?.remove();
    document.getElementById('bz-style')?.remove();
    clearTimeout(toast._t);
    delete window.__bazi_loaded__;
    delete window.__bazi_debug__;
    delete window.__bazi_teardown__;
    console.info(TAG, 'teardown done');
  };

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
