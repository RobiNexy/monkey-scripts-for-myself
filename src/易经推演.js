// ==UserScript==
// @name         易经推演
// @namespace    http://tampermonkey.net/
// @version      4.1.0
// @description  手动选卦（逐爻 6/7/8/9/多动爻/之卦）、梅花易数推演、大衍筮法（全自动/半自动滑竿/序列导出回放）、ctext 同源抓取
// @author       AI
// @match        https://ctext.org/book-of-changes/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/*
 * 副作用声明：
 * - 读：ctext.org 同源页面 /book-of-changes/<slug>/zh（fetch，同源无需 @connect）
 * - 写：剪贴板（GM_setClipboard）；localStorage 键 yj-panel-pos-v2（面板位置）
 * - 注入：GM_addStyle 一段样式；body 下追加 #yj-panel / #yj-derive-modal / #yj-modal
 * - 全局：unsafeWindow.__yj_loaded__（防重入）、unsafeWindow.__yj_debug__（调试命名空间，destroy() 可清理）
 * - 使用 unsafeWindow：仅用于把调试命名空间挂到页面上下文，便于 F12 Console 访问
 * - 不向任何第三方域发请求
 *
 * 控制台定位本脚本问题：
 * 1. F12 → Console → 过滤框输入 [yj]
 * 2. 展开红色 error 行堆栈，点击跳到 Sources 对应行
 * 3. 在 parseHexDocument / fetchGuaContent / runDaYan / runMeihua 处下断点
 * 4. 检查内部状态：Console 输入 __yj_debug__.state，销毁输入 __yj_debug__.destroy()
 */

(function () {
  'use strict';

  /* ================================================================
   *  〇、防重入 · 调试命名空间 · 事件登记（便于 destroy 清理）
   * ================================================================ */

  const TAG = '[yj]';
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  if (pageWin.__yj_loaded__) {
    console.warn(TAG, '脚本已注入，本次跳过重复执行');
    return;
  }
  pageWin.__yj_loaded__ = true;

  const listeners = [];
  let destroyed = false;
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  };
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ================================================================
   *  一、数据层
   * ================================================================ */

  const trigramMap = {
    '1,1,1': { name: '乾', xiang: '天', pinyin: 'qian', num: 1 },
    '1,1,0': { name: '兑', xiang: '泽', pinyin: 'dui',  num: 2 },
    '1,0,1': { name: '离', xiang: '火', pinyin: 'li',   num: 3 },
    '1,0,0': { name: '震', xiang: '雷', pinyin: 'zhen', num: 4 },
    '0,1,1': { name: '巽', xiang: '风', pinyin: 'xun',  num: 5 },
    '0,1,0': { name: '坎', xiang: '水', pinyin: 'kan',  num: 6 },
    '0,0,1': { name: '艮', xiang: '山', pinyin: 'gen',  num: 7 },
    '0,0,0': { name: '坤', xiang: '地', pinyin: 'kun',  num: 0 },
  };
  const trigramByPinyin = {};
  const trigramByNum = {};
  Object.entries(trigramMap).forEach(([k, v]) => {
    v.yao = k.split(',').map(Number); // 下标 0 = 初爻
    trigramByPinyin[v.pinyin] = v;
    trigramByNum[v.num] = v;
  });

  const hexagramMap = {
    qian_qian: { name: '乾', fullName: '乾为天', unicode: '䷀', slug: 'qian' },
    kun_kun: { name: '坤', fullName: '坤为地', unicode: '䷁', slug: 'kun' },
    kan_zhen: { name: '屯', fullName: '水雷屯', unicode: '䷂', slug: 'zhun' },
    gen_kan: { name: '蒙', fullName: '山水蒙', unicode: '䷃', slug: 'meng' },
    kan_qian: { name: '需', fullName: '水天需', unicode: '䷄', slug: 'xu' },
    qian_kan: { name: '讼', fullName: '天水讼', unicode: '䷅', slug: 'song' },
    kun_kan: { name: '师', fullName: '地水师', unicode: '䷆', slug: 'shi' },
    kan_kun: { name: '比', fullName: '水地比', unicode: '䷇', slug: 'bi' },
    xun_qian: { name: '小畜', fullName: '风天小畜', unicode: '䷈', slug: 'xiao-xu' },
    qian_dui: { name: '履', fullName: '天泽履', unicode: '䷉', slug: 'lv' },
    kun_qian: { name: '泰', fullName: '地天泰', unicode: '䷊', slug: 'tai' },
    qian_kun: { name: '否', fullName: '天地否', unicode: '䷋', slug: 'pi' },
    qian_li: { name: '同人', fullName: '天火同人', unicode: '䷌', slug: 'tong-ren' },
    li_qian: { name: '大有', fullName: '火天大有', unicode: '䷍', slug: 'da-you' },
    kun_gen: { name: '谦', fullName: '地山谦', unicode: '䷎', slug: 'qian1' },
    zhen_kun: { name: '豫', fullName: '雷地豫', unicode: '䷏', slug: 'yu' },
    dui_zhen: { name: '随', fullName: '泽雷随', unicode: '䷐', slug: 'sui' },
    gen_xun: { name: '蛊', fullName: '山风蛊', unicode: '䷑', slug: 'gu' },
    kun_dui: { name: '临', fullName: '地泽临', unicode: '䷒', slug: 'lin' },
    xun_kun: { name: '观', fullName: '风地观', unicode: '䷓', slug: 'guan' },
    li_zhen: { name: '噬嗑', fullName: '火雷噬嗑', unicode: '䷔', slug: 'shi-he' },
    gen_li: { name: '贲', fullName: '山火贲', unicode: '䷕', slug: 'bi1' },
    gen_kun: { name: '剥', fullName: '山地剥', unicode: '䷖', slug: 'bo' },
    kun_zhen: { name: '复', fullName: '地雷复', unicode: '䷗', slug: 'fu' },
    qian_zhen: { name: '无妄', fullName: '天雷无妄', unicode: '䷘', slug: 'wu-wang' },
    gen_qian: { name: '大畜', fullName: '山天大畜', unicode: '䷙', slug: 'da-xu' },
    gen_zhen: { name: '颐', fullName: '山雷颐', unicode: '䷚', slug: 'yi' },
    dui_xun: { name: '大过', fullName: '泽风大过', unicode: '䷛', slug: 'da-guo' },
    kan_kan: { name: '坎', fullName: '坎为水', unicode: '䷜', slug: 'kan' },
    li_li: { name: '离', fullName: '离为火', unicode: '䷝', slug: 'li' },
    dui_gen: { name: '咸', fullName: '泽山咸', unicode: '䷞', slug: 'xian' },
    zhen_xun: { name: '恒', fullName: '雷风恒', unicode: '䷟', slug: 'heng' },
    qian_gen: { name: '遁', fullName: '天山遁', unicode: '䷠', slug: 'dun' },
    zhen_qian: { name: '大壮', fullName: '雷天大壮', unicode: '䷡', slug: 'da-zhuang' },
    li_kun: { name: '晋', fullName: '火地晋', unicode: '䷢', slug: 'jin' },
    kun_li: { name: '明夷', fullName: '地火明夷', unicode: '䷣', slug: 'ming-yi' },
    xun_li: { name: '家人', fullName: '风火家人', unicode: '䷤', slug: 'jia-ren' },
    li_dui: { name: '睽', fullName: '火泽睽', unicode: '䷥', slug: 'kui' },
    kan_gen: { name: '蹇', fullName: '水山蹇', unicode: '䷦', slug: 'jian' },
    zhen_kan: { name: '解', fullName: '雷水解', unicode: '䷧', slug: 'jie' },
    gen_dui: { name: '损', fullName: '山泽损', unicode: '䷨', slug: 'sun' },
    xun_zhen: { name: '益', fullName: '风雷益', unicode: '䷩', slug: 'yi1' },
    dui_qian: { name: '夬', fullName: '泽天夬', unicode: '䷪', slug: 'guai' },
    qian_xun: { name: '姤', fullName: '天风姤', unicode: '䷫', slug: 'gou' },
    dui_kun: { name: '萃', fullName: '泽地萃', unicode: '䷬', slug: 'cui' },
    kun_xun: { name: '升', fullName: '地风升', unicode: '䷭', slug: 'sheng' },
    dui_kan: { name: '困', fullName: '泽水困', unicode: '䷮', slug: 'kun1' },
    kan_xun: { name: '井', fullName: '水风井', unicode: '䷯', slug: 'jing' },
    dui_li: { name: '革', fullName: '泽火革', unicode: '䷰', slug: 'ge' },
    li_xun: { name: '鼎', fullName: '火风鼎', unicode: '䷱', slug: 'ding' },
    zhen_zhen: { name: '震', fullName: '震为雷', unicode: '䷲', slug: 'zhen' },
    gen_gen: { name: '艮', fullName: '艮为山', unicode: '䷳', slug: 'gen' },
    xun_gen: { name: '渐', fullName: '风山渐', unicode: '䷴', slug: 'jian1' },
    zhen_dui: { name: '归妹', fullName: '雷泽归妹', unicode: '䷵', slug: 'gui-mei' },
    zhen_li: { name: '丰', fullName: '雷火丰', unicode: '䷶', slug: 'feng' },
    li_gen: { name: '旅', fullName: '火山旅', unicode: '䷷', slug: 'lv1' },
    xun_xun: { name: '巽', fullName: '巽为风', unicode: '䷸', slug: 'xun' },
    dui_dui: { name: '兑', fullName: '兑为泽', unicode: '䷹', slug: 'dui' },
    xun_kan: { name: '涣', fullName: '风水涣', unicode: '䷺', slug: 'huan' },
    kan_dui: { name: '节', fullName: '水泽节', unicode: '䷻', slug: 'jie1' },
    xun_dui: { name: '中孚', fullName: '风泽中孚', unicode: '䷼', slug: 'zhong-fu' },
    zhen_gen: { name: '小过', fullName: '雷山小过', unicode: '䷽', slug: 'xiao-guo' },
    kan_li: { name: '既济', fullName: '水火既济', unicode: '䷾', slug: 'ji-ji' },
    li_kan: { name: '未济', fullName: '火水未济', unicode: '䷿', slug: 'wei-ji' },
  };

  /* ================================================================
   *  二、计算层
   * ================================================================ */

  const YAO_POS = ['初', '二', '三', '四', '五', '上'];
  const MANUAL_VALUE_OPTIONS = [
    ['', '未定'],
    ['6', '6 老阴（动）'],
    ['7', '7 少阳'],
    ['8', '8 少阴'],
    ['9', '9 老阳（动）'],
  ];

  /** 爻名：初/上 为「初九/上六」，其余为「九二/六五」 */
  function yaoLabel(i, isYang) {
    const core = isYang ? '九' : '六';
    return (i === 0 || i === 5) ? `${YAO_POS[i]}${core}` : `${core}${YAO_POS[i]}`;
  }

  /** 大衍爻值 → 名称 */
  function yaoKindName(v) {
    return ({ 6: '老阴·动', 7: '少阳', 8: '少阴', 9: '老阳·动' })[v] || '未知';
  }

  function getHexagramByYaoList(yaoList) {
    const lower = trigramMap[yaoList.slice(0, 3).join(',')];
    const upper = trigramMap[yaoList.slice(3, 6).join(',')];
    const base = hexagramMap[`${upper.pinyin}_${lower.pinyin}`];
    if (!base) throw new Error(`未知卦组合: 上${upper.name}下${lower.name}`);
    // 八纯卦按「乾为天 / 坤为地」命名，其余按「上象 + 下象 + 卦名」命名
    return { ...base, upper, lower, commonName: base.fullName, yaoList: [...yaoList] };
  }

  /** 梅花：除6取动爻（0-based） */
  const getDongYaoIndex = (num) => { const r = num % 6; return r === 0 ? 5 : r - 1; };

  /** 互卦：下互 2/3/4 爻，上互 3/4/5 爻 */
  const getHuGua = (yaoList) =>
    getHexagramByYaoList([yaoList[1], yaoList[2], yaoList[3], yaoList[2], yaoList[3], yaoList[4]]);

  /**
   * 之卦：翻转全部动爻（dongIdxs 为 0-based 下标）
   * 单动爻时即梅花所称「变卦」；多动爻时按「之卦」统一翻转
   */
  function getZhiGua(yaoList, dongIdxs) {
    const yao = [...yaoList];
    dongIdxs.forEach((i) => { yao[i] ^= 1; });
    return getHexagramByYaoList(yao);
  }

  /** 梅花体用：动爻在内卦则上卦为体，否则下卦为体 */
  function getTiYong(ben, dongIndex) {
    return dongIndex < 3 ? { ti: ben.upper, yong: ben.lower } : { ti: ben.lower, yong: ben.upper };
  }

  /* ---------- 大衍筮法核心 ---------- */

  const DAYAN_TOTAL = 49;     // 其用四十九
  const DAYAN_CHANGES = 18;   // 十八变成卦

  /**
   * 单变运算（纯函数，可独立验证）
   * M：当前蓍草存数；L：分二左堆数（合法区间 [1, M-2]，保证右堆挂一后至少 1 根）
   * 挂一恒为 1（取自右堆）；揲四余数取值 1..4；归奇 = 左余 + 右余 + 挂一
   * 第一变 gua ∈ {5, 9}；后续变 gua ∈ {4, 8}
   */
  function castChange(M, L) {
    if (!Number.isInteger(L) || L < 1 || L > M - 2) {
      throw new RangeError(`分二越界：存数 ${M}，左堆 ${L}（合法 1–${M - 2}）`);
    }
    const R = M - L;
    const hang = 1;
    const rightAfterHang = R - 1;
    const lRem = ((L - 1) % 4) + 1;               // 揲四余数 1..4
    const rRem = ((rightAfterHang - 1) % 4) + 1;  // 揲四余数 1..4
    const gua = lRem + rRem + hang;               // 归奇
    return { M, L, R, hang, lRem, rRem, gua, nextM: M - gua };
  }

  /**
   * 整卦序列校验（纯计算，不触碰 UI）；用于回放前全量验证，避免半途报错
   * 每爻从 49 起，三变后存数 M 必为 4 的倍数（24..36），爻值 = M / 4
   */
  function simulateSplits(splits) {
    if (!Array.isArray(splits) || splits.length !== DAYAN_CHANGES) {
      throw new Error(`序列长度应为 ${DAYAN_CHANGES}，实际 ${splits ? splits.length : 'null'}`);
    }
    const yaos = [];
    let M = DAYAN_TOTAL;
    for (let c = 0; c < DAYAN_CHANGES; c++) {
      const rec = castChange(M, splits[c]);
      M = rec.nextM;
      if ((c + 1) % 3 === 0) {
        const v = M / 4;
        if (!Number.isInteger(v) || v < 6 || v > 9) throw new Error(`第 ${c + 1} 变后存数 ${M} 非法`);
        yaos.push(v);
        M = DAYAN_TOTAL;
      }
    }
    return { yaos };
  }

  /* ================================================================
   *  三、抓取层（fetch 同源）
   * ================================================================ */

  const contentCache = {};

  function unwrapAnchors(root) {
    root.querySelectorAll('a.popup').forEach((a) => {
      while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a);
      a.remove();
    });
  }

  function parseHexDocument(html, slug) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = doc.querySelectorAll('#content3 tr');
    console.debug(TAG, `${slug} → 响应 ${html.length} 字符, title="${doc.title}", 命中 ${rows.length} 行`);
    if (rows.length === 0) {
      console.error(TAG, '响应前 500 字符：', html.slice(0, 500));
      if (/captcha|robot|verify/i.test(html)) throw new Error('被反爬拦截（验证码页）');
      if (html.length < 2000) throw new Error(`返回疑似空壳页（${html.length} 字符）`);
      throw new Error(`页面无 #content3（title="${doc.title}"），结构可能变更`);
    }
    let text = '', matched = 0;
    rows.forEach((row) => {
      const label = row.querySelector('td.ctext.opt');
      const content = row.querySelector('td.ctext:not(.opt)');
      if (!content) return;
      const clone = content.cloneNode(true);
      clone.querySelectorAll('.sprite-more, .sprite-parallel, .sprite-discuss, p.ctext:empty, div[id^="comm"]').forEach((el) => el.remove());
      unwrapAnchors(clone);
      const labelText = label ? label.textContent.trim().replace(/\s+/g, ' ') : '';
      const contentText = clone.textContent.trim().replace(/[ \t]+/g, ' ');
      if (!contentText) return;
      text += (labelText ? labelText + ' ' : '') + contentText + '\n\n';
      matched++;
    });
    if (matched === 0) {
      console.error(TAG, '首行 HTML：', rows[0].outerHTML.slice(0, 300));
      throw new Error('解析到行但提取到 0 条内容');
    }
    return text.trim();
  }

  async function fetchHexContent(slug) {
    if (contentCache[slug]) return contentCache[slug];
    const url = `/book-of-changes/${slug}/zh`;
    const res = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!res.ok) throw new Error(`抓取失败: HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();
    const text = parseHexDocument(html, slug);
    contentCache[slug] = text;
    return text;
  }

  /* ================================================================
   *  四、样式层
   * ================================================================ */

  const styleEl = GM_addStyle(`
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes scaleIn { from { opacity: 0; transform: scale(0.7); } to { opacity: 1; transform: scale(1); } }
    @keyframes flipYao { 0% { transform: rotateY(0deg); } 50% { transform: rotateY(90deg); } 100% { transform: rotateY(0deg); } }
    @keyframes glow { 0%, 100% { box-shadow: 0 0 12px #a855f7; } 50% { box-shadow: 0 0 24px #a855f7, 0 0 40px #a855f7; } }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    @keyframes shimmer { 0% { background-position: -200% center; } 100% { background-position: 200% center; } }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    :root {
      --neon-purple: #a855f7; --neon-cyan: #22d3ee; --gold: #fbbf24;
      --glass-bg: rgba(15, 23, 42, 0.78); --glass-border: rgba(255, 255, 255, 0.25);
      --text-primary: #ffffff; --text-sub: #d1d5db; --text-muted: #9ca3af;
    }
    body::before {
      content: ''; position: fixed; inset: 0; z-index: -1;
      background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%);
      background-size: 200% 100%; animation: shimmer 12s linear infinite;
    }

    /* ---------- 面板 ---------- */
    #yj-panel {
      position: fixed; bottom: 100px; right: 24px; width: 360px;
      max-height: calc(100vh - 120px); display: flex; flex-direction: column;
      background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: 20px;
      backdrop-filter: blur(20px) saturate(180%);
      box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 1px rgba(255,255,255,0.3) inset;
      z-index: 99999; font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
      font-size: 13px; color: var(--text-primary); user-select: none; overflow: hidden;
      animation: fadeInUp 0.5s ease-out;
    }
    #yj-drag {
      flex-shrink: 0; display: flex; justify-content: space-between; align-items: center;
      padding: 12px 16px; cursor: move; font-weight: 700; font-size: 15px;
      background: linear-gradient(135deg, rgba(168,85,247,0.5), rgba(167,139,250,0.5));
      border-bottom: 1px solid rgba(255,255,255,0.2); text-shadow: 0 2px 10px rgba(0,0,0,0.5);
    }
    #yj-drag .ico { font-size: 18px; }
    #yj-drag .yj-collapse { cursor: pointer; font-size: 20px; padding: 2px 6px; transition: transform 0.2s; }
    #yj-drag .yj-collapse:hover { transform: scale(1.15); }
    #yj-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    #yj-panel.collapsed #yj-body { display: none; }
    #yj-body::-webkit-scrollbar { width: 6px; }
    #yj-body::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.5); border-radius: 3px; }

    .yj-tabs {
      display: flex; position: sticky; top: 0; z-index: 5;
      background: rgba(0,0,0,0.35); border-bottom: 1px solid rgba(255,255,255,0.2);
      backdrop-filter: blur(10px);
    }
    .yj-tab {
      flex: 1; text-align: center; padding: 10px 4px; cursor: pointer; font-size: 13px;
      color: var(--text-sub); border-bottom: 2px solid transparent; transition: all 0.25s;
    }
    .yj-tab:hover { background: rgba(168,85,247,0.2); }
    .yj-tab.active { color: var(--gold); border-bottom-color: var(--neon-purple); font-weight: 700; }
    .yj-pane { padding: 14px 16px; display: none; animation: fadeIn 0.3s; }
    .yj-pane.active { display: block; }

    .yj-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .yj-row label { width: 56px; color: var(--text-sub); font-weight: 600; flex-shrink: 0; }
    .yj-row select, .yj-row input[type="number"] {
      flex: 1; padding: 8px 10px; border: 1px solid rgba(255,255,255,0.25); border-radius: 10px;
      font-size: 14px; background: rgba(0,0,0,0.4); color: var(--text-primary); outline: none;
    }
    .yj-row select:focus, .yj-row input:focus { border-color: var(--neon-purple); box-shadow: 0 0 14px rgba(168,85,247,0.6); }
    .yj-sub-title { font-size: 12px; color: var(--text-muted); margin: 8px 0 6px; letter-spacing: 1px; }

    .yj-preview {
      display: flex; align-items: center; gap: 14px; padding: 12px; margin-bottom: 12px;
      background: rgba(168,85,247,0.2); border: 1px solid rgba(168,85,247,0.5); border-radius: 12px;
      animation: rise 0.4s both;
    }
    .yj-preview .hex-name { font-size: 17px; font-weight: 700; color: var(--gold); }
    .yj-preview .hex-sub { font-size: 11px; color: var(--text-sub); margin-top: 3px; }

    /* 逐爻标注 */
    .yj-yao-row {
      display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin-bottom: 5px;
      background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
      transition: all 0.2s;
    }
    .yj-yao-row.is-dong { border-color: rgba(251,191,36,0.7); box-shadow: 0 0 12px rgba(251,191,36,0.35); }
    .yj-yao-name { width: 64px; font-weight: 700; color: var(--text-primary); }
    .yj-yao-yy {
      flex: 1; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 13px;
      background: rgba(224,213,255,0.2); color: #e0d5ff; border: 1px solid rgba(224,213,255,0.4);
    }
    .yj-yao-yy.yin { background: rgba(0,0,0,0.4); color: var(--text-sub); border-color: rgba(255,255,255,0.3); }
    .yj-yao-dong { display: flex; align-items: center; gap: 4px; color: var(--gold); font-weight: 600; cursor: pointer; }
    .yj-yao-val {
      flex: 1; padding: 5px 8px; border-radius: 8px; font-size: 13px;
      background: rgba(0,0,0,0.4); color: var(--text-primary);
      border: 1px solid rgba(255,255,255,0.25); outline: none;
    }
    .yj-yao-val:focus { border-color: var(--neon-purple); box-shadow: 0 0 10px rgba(168,85,247,0.5); }
    .yj-yao-row.is-dong .yj-yao-val { border-color: rgba(251,191,36,0.8); color: var(--gold); }

    .yj-checks { display: flex; gap: 12px; margin: 10px 0; font-size: 13px; justify-content: center; flex-wrap: wrap; }
    .yj-checks label { display: flex; align-items: center; gap: 5px; cursor: pointer; color: var(--text-sub); }
    .yj-checks label:hover { color: var(--text-primary); }

    .yj-btn {
      width: 100%; padding: 11px; border: none; border-radius: 12px; cursor: pointer;
      font-size: 14px; font-weight: 700; transition: all 0.25s; color: #fff;
      background: linear-gradient(135deg, #8b5cf6, #a78bfa); box-shadow: 0 4px 18px rgba(139,92,246,0.5);
    }
    .yj-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 26px rgba(139,92,246,0.7); }
    .yj-btn:active:not(:disabled) { transform: translateY(0); }
    .yj-btn:disabled { background: rgba(107,114,128,0.5); cursor: not-allowed; box-shadow: none; color: var(--text-muted); }
    .yj-btn-sm {
      padding: 7px 10px; border: 1px solid rgba(168,85,247,0.6); border-radius: 10px; cursor: pointer;
      font-size: 12px; font-weight: 600; color: #e0d5ff; background: rgba(168,85,247,0.25); transition: all 0.2s;
    }
    .yj-btn-sm:hover:not(:disabled) { background: rgba(168,85,247,0.5); }
    .yj-btn-sm:disabled { opacity: 0.4; cursor: not-allowed; }
    .yj-btn-row { display: flex; gap: 8px; margin-bottom: 10px; }
    .yj-btn-row > * { flex: 1; }

    .yj-status { margin-top: 10px; text-align: center; font-size: 13px; min-height: 18px; color: var(--text-sub); font-weight: 600; }
    .yj-status.ok { color: #6ee7b7; text-shadow: 0 0 10px rgba(110,231,183,0.8); }
    .yj-status.warn { color: #fbbf24; text-shadow: 0 0 10px rgba(251,191,36,0.8); }
    .yj-status.err { color: #f87171; text-shadow: 0 0 10px rgba(248,113,113,0.8); }

    /* 卦牌 */
    .yj-cards { display: flex; gap: 8px; margin-bottom: 12px; }
    .gua-card {
      flex: 1; padding: 10px 6px 8px; border: 2px solid rgba(255,255,255,0.2); border-radius: 12px;
      text-align: center; cursor: pointer; transition: all 0.25s; background: rgba(0,0,0,0.3);
      animation: scaleIn 0.4s ease-out;
    }
    .gua-card:hover { border-color: rgba(168,85,247,0.7); transform: translateY(-3px); box-shadow: 0 8px 26px rgba(139,92,246,0.5); }
    .gua-card.active { border-color: var(--neon-purple); background: rgba(168,85,247,0.25); box-shadow: 0 0 22px rgba(168,85,247,0.7); }
    .gua-card .card-label { font-size: 11px; color: var(--text-muted); }
    .gua-card .card-name { font-size: 13px; font-weight: 700; margin: 4px 0 2px; }
    .gua-card .hex-paint { --yj-yao-w: 34px; margin: 4px auto 0; }

    /* 卦象绘制 */
    .hex-paint { width: var(--yj-yao-w, 46px); --yj-yao-w: 46px; }
    .hex-yao { height: 7px; margin-bottom: 5px; position: relative; transition: transform 0.3s, filter 0.3s; }
    .hex-yao:last-child { margin-bottom: 0; }
    .hex-yao.highlight { animation: glow 1s ease-in-out; transform: scale(1.08); }
    .hex-yao.flip { animation: flipYao 0.6s ease-in-out; }
    .hex-yao.dong .yao-yang, .hex-yao.dong .yao-yin-left, .hex-yao.dong .yao-yin-right {
      background: linear-gradient(90deg, #fde68a, #fbbf24) !important; box-shadow: 0 0 10px rgba(251,191,36,0.85) !important;
    }
    .yao-yang { width: 100%; height: 100%; background: linear-gradient(90deg, #e0d5ff, #c4b5fd); border-radius: 2px; box-shadow: 0 2px 10px rgba(196,181,253,0.6); }
    .yao-unknown { width: 100%; height: 100%; border: 1px dashed rgba(255,255,255,0.35); border-radius: 2px; box-sizing: border-box; }
    .yao-yin-left, .yao-yin-right {
      position: absolute; width: 44%; height: 100%; background: linear-gradient(90deg, #e0d5ff, #c4b5fd);
      border-radius: 2px; box-shadow: 0 2px 10px rgba(196,181,253,0.6);
    }
    .yao-yin-left { left: 0; } .yao-yin-right { right: 0; }

    /* 大衍专属 */
    .yj-mode { display: flex; gap: 8px; margin-bottom: 10px; }
    .yj-mode label {
      flex: 1; text-align: center; padding: 8px 4px; border-radius: 10px; cursor: pointer;
      border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3); color: var(--text-sub); font-weight: 600;
    }
    .yj-mode input { display: none; }
    .yj-mode label:has(input:checked) { border-color: var(--neon-purple); background: rgba(168,85,247,0.3); color: var(--gold); }
    .yj-mode label:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }

    .yj-dy-hud { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .yj-dy-M { font-size: 13px; color: var(--text-sub); }
    .yj-dy-M span { font-size: 22px; font-weight: 800; color: var(--gold); text-shadow: 0 0 12px rgba(251,191,36,0.6); }
    .yj-dy-info { font-size: 12px; color: var(--neon-cyan); text-align: right; }
    .yj-progress { height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-bottom: 10px; }
    .yj-progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg, var(--neon-purple), var(--neon-cyan)); transition: width 0.4s; box-shadow: 0 0 10px var(--neon-purple); }
    .yj-dy-bricks { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
    .yj-dy-brick {
      padding: 5px 10px; border-radius: 8px; font-size: 13px; text-align: center;
      background: rgba(0,0,0,0.35); border: 1px dashed rgba(255,255,255,0.15); color: var(--text-muted);
    }
    .yj-dy-brick.yang { border-style: solid; border-color: rgba(196,181,253,0.6); color: #e0d5ff; }
    .yj-dy-brick.yin { border-style: solid; border-color: rgba(255,255,255,0.35); color: var(--text-sub); }
    .yj-dy-brick.dong { border-color: var(--gold); color: var(--gold); box-shadow: 0 0 12px rgba(251,191,36,0.4); }
    .yj-dy-semi { display: none; padding: 10px; margin-bottom: 10px; border-radius: 12px; background: rgba(34,211,238,0.1); border: 1px solid rgba(34,211,238,0.4); }
    #yj-dy-slider { width: 100%; accent-color: var(--neon-purple); }
    .yj-dy-tip { text-align: center; color: var(--neon-cyan); font-size: 12px; margin: 4px 0 8px; }
    .yj-dy-log {
      max-height: 150px; overflow-y: auto; padding: 8px; margin-bottom: 10px; border-radius: 10px;
      background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1); font-size: 12px; line-height: 1.7;
      font-family: 'Courier New', monospace; color: var(--text-sub);
    }
    .yj-dy-logline { animation: rise 0.35s both; }
    .yj-dy-logline.last { color: var(--gold); font-weight: 700; }
    .yj-vow {
      display: none; text-align: center; padding: 14px; margin-bottom: 10px; border-radius: 14px;
      background: rgba(168,85,247,0.2); border: 1px solid rgba(168,85,247,0.6); animation: scaleIn 0.4s;
    }
    .yj-vow .vow-text { font-size: 14px; color: var(--text-primary); margin-bottom: 6px; }
    .yj-vow .vow-count { font-size: 34px; font-weight: 800; color: var(--gold); animation: pulse 1s infinite; }
    .yj-dy-verdict { font-size: 12px; color: var(--text-sub); text-align: center; margin: 4px 0 10px; line-height: 1.7; }
    .yj-seq { margin-top: 10px; font-size: 12px; color: var(--text-sub); }
    .yj-seq summary { cursor: pointer; color: var(--neon-cyan); margin-bottom: 6px; }
    .yj-seq textarea {
      width: 100%; height: 56px; margin: 6px 0; padding: 6px; border-radius: 8px; box-sizing: border-box;
      background: rgba(0,0,0,0.4); color: var(--text-primary); border: 1px solid rgba(255,255,255,0.25); font-size: 12px;
    }

    /* ---------- 全屏推演 ---------- */
    #yj-derive-modal {
      position: fixed; inset: 0; z-index: 100001; background: rgba(15,23,42,0.98);
      backdrop-filter: blur(12px); display: none; flex-direction: column; overflow-y: auto; animation: fadeIn 0.4s;
    }
    #yj-derive-modal.show { display: flex; }
    .derive-header {
      position: sticky; top: 0; z-index: 10; padding: 18px 32px; background: rgba(30,27,75,0.95);
      border-bottom: 2px solid rgba(168,85,247,0.5); backdrop-filter: blur(20px);
    }
    .derive-header h2 { font-size: 22px; font-weight: 800; color: var(--gold); margin: 0; text-shadow: 0 0 20px rgba(251,191,36,0.6); }
    .derive-progress { margin-top: 10px; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
    .derive-progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg, var(--neon-purple), var(--neon-cyan)); transition: width 0.5s; box-shadow: 0 0 12px var(--neon-purple); }
    .derive-close { position: absolute; top: 18px; right: 32px; font-size: 32px; cursor: pointer; color: var(--text-sub); }
    .derive-close:hover { color: var(--text-primary); transform: scale(1.2); }
    .derive-body { padding: 36px 32px 80px; max-width: 1100px; margin: 0 auto; width: 100%; }
    .derive-step {
      margin-bottom: 32px; padding: 22px; border-radius: 16px; background: rgba(0,0,0,0.4);
      border: 2px solid rgba(34,211,238,0.3); opacity: 0; transform: translateY(30px); transition: opacity 0.5s, transform 0.5s;
    }
    .derive-step.show { opacity: 1; transform: translateY(0); }
    .derive-step-title { font-size: 19px; font-weight: 700; color: var(--neon-cyan); margin-bottom: 14px; text-shadow: 0 0 12px rgba(34,211,238,0.6); }
    .derive-step-title::before { content: '◈ '; animation: pulse 2s infinite; }
    .derive-step-content { font-size: 16px; line-height: 2; color: var(--text-primary); }
    .derive-math {
      display: inline-block; padding: 4px 12px; margin: 0 4px; background: rgba(168,85,247,0.3);
      border: 2px solid rgba(168,85,247,0.6); border-radius: 8px; font-family: 'Courier New', monospace; font-weight: 700; color: #e0d5ff;
    }
    .derive-hexes { display: flex; gap: 22px; align-items: center; justify-content: center; margin-top: 18px; flex-wrap: wrap; }
    .derive-hex-item { text-align: center; animation: scaleIn 0.6s both; }
    .derive-hex-item .hex-paint { --yj-yao-w: 50px; margin: 0 auto 8px; }
    .derive-hex-item .hex-label { font-size: 13px; color: var(--text-muted); font-weight: 600; }
    .derive-hex-item .hex-name { font-size: 16px; font-weight: 700; color: var(--gold); }
    .derive-arrow { font-size: 30px; color: var(--neon-cyan); animation: pulse 2s infinite; }
    .derive-footer {
      position: sticky; bottom: 0; padding: 18px 32px; background: rgba(30,27,75,0.95);
      border-top: 2px solid rgba(168,85,247,0.5); backdrop-filter: blur(20px); text-align: center;
    }
    .derive-footer .yj-btn { max-width: 300px; margin: 0 auto; background: linear-gradient(135deg, #22d3ee, #06b6d4); }

    /* ---------- 内容模态 ---------- */
    #yj-modal {
      position: fixed; inset: 0; background: rgba(15,23,42,0.92); z-index: 100000; display: none;
      align-items: center; justify-content: center; backdrop-filter: blur(10px); animation: fadeIn 0.3s;
    }
    #yj-modal.show { display: flex; }
    .yj-modal-content {
      width: 680px; max-width: 92vw; max-height: 84vh; background: rgba(30,27,75,0.98);
      border: 2px solid rgba(255,255,255,0.25); border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.7);
      display: flex; flex-direction: column; overflow: hidden; animation: scaleIn 0.4s ease-out;
    }
    .yj-modal-header {
      padding: 16px 22px; border-bottom: 2px solid rgba(255,255,255,0.2); font-size: 18px; font-weight: 700;
      display: flex; justify-content: space-between; align-items: center; background: rgba(168,85,247,0.25); color: var(--gold);
    }
    .yj-modal-close { cursor: pointer; font-size: 28px; line-height: 1; color: var(--text-sub); padding: 0 6px; }
    .yj-modal-close:hover { color: var(--text-primary); transform: scale(1.2); }
    .yj-modal-body {
      padding: 22px 26px; overflow-y: auto; line-height: 2.1; font-size: 16px; white-space: pre-wrap;
      user-select: text; color: var(--text-primary);
    }
    .yj-modal-footer {
      padding: 14px 22px; border-top: 2px solid rgba(255,255,255,0.2); display: flex; justify-content: space-between;
      align-items: center; font-size: 14px; background: rgba(0,0,0,0.3);
    }
    .foot-msg-ok { color: #6ee7b7; font-weight: 700; } .foot-msg-warn { color: #fbbf24; font-weight: 700; } .foot-msg-err { color: #f87171; font-weight: 700; }
    .yj-modal-copy {
      background: rgba(168,85,247,0.4); border: 2px solid rgba(168,85,247,0.6); border-radius: 8px;
      padding: 6px 16px; font-size: 13px; cursor: pointer; color: #e0d5ff; font-weight: 700;
    }
    .yj-modal-copy:hover { background: rgba(168,85,247,0.6); }
  `);

  /* ================================================================
   *  五、渲染工具 · 时间工具 · 随机
   * ================================================================ */

  /**
   * 绘制卦象（yaoList 下标 0 = 初爻，binary：1 阳 / 0 阴）
   * dongIdxs：需要金色高亮的动爻下标
   */
  function renderHexPaint(yaoList, extraClass = '', dongIdxs = []) {
    const c = document.createElement('div');
    c.className = `hex-paint ${extraClass}`.trim();
    for (let i = yaoList.length - 1; i >= 0; i--) {
      const yao = document.createElement('div');
      const v = yaoList[i];
      yao.className = 'hex-yao' + (dongIdxs.includes(i) ? ' dong' : '');
      yao.dataset.index = String(i);
      if (v === null || v === undefined) {
        yao.classList.add('is-unknown');
        yao.innerHTML = '<div class="yao-unknown"></div>';
      } else {
        yao.innerHTML = v === 1
          ? '<div class="yao-yang"></div>'
          : '<div class="yao-yin-left"></div><div class="yao-yin-right"></div>';
      }
      c.appendChild(yao);
    }
    return c;
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 大衍用：可被 daYan.skip 快进的等待；skip 时立即 resolve */
  const sleep = (ms) => new Promise((r) => setTimeout(r, daYan.skip ? 0 : ms));

  /** 真随机整数 [min, max]（crypto 源，无偏差风险可忽略） */
  function randInt(min, max) {
    if (max < min) throw new RangeError(`randInt 区间非法 [${min}, ${max}]`);
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return min + (buf[0] % (max - min + 1));
  }

  /* ================================================================
   *  六、梅花推演（全屏动画）
   * ================================================================ */

  async function showDerivation(n1, n2, n3) {
    const body = deriveModal.querySelector('.derive-body');
    const bar = deriveModal.querySelector('.derive-progress-bar');
    body.innerHTML = '';
    bar.style.width = '0%';
    deriveModal.classList.add('show');

    const addStep = (title, html) => {
      const step = document.createElement('div');
      step.className = 'derive-step';
      step.innerHTML = `<div class="derive-step-title">${title}</div><div class="derive-step-content">${html}</div>`;
      body.appendChild(step);
      requestAnimationFrame(() => step.classList.add('show'));
      return step.querySelector('.derive-step-content');
    };
    const hexItem = (paint, text, cls) => {
      const item = document.createElement('div');
      item.className = 'derive-hex-item';
      const t = document.createElement('div');
      t.className = cls;
      t.textContent = text;
      item.append(paint, t);
      return item;
    };
    const rowOf = (...nodes) => {
      const r = document.createElement('div');
      r.className = 'derive-hexes';
      r.append(...nodes);
      return r;
    };
    const arrowOf = (s) => {
      const a = document.createElement('div');
      a.className = 'derive-arrow';
      a.textContent = s;
      return a;
    };
    const shown = (n, m) => (n % m === 0 ? m : n % m);

    const upper = trigramByNum[n1 % 8];
    const lower = trigramByNum[n2 % 8];
    const dongIndex = getDongYaoIndex(n3);
    const benYao = [...lower.yao, ...upper.yao];
    const ben = getHexagramByYaoList(benYao);
    const bian = getZhiGua(benYao, [dongIndex]);
    const hu = getHuGua(benYao);
    const { ti, yong } = getTiYong(ben, dongIndex);
    const dongName = yaoLabel(dongIndex, benYao[dongIndex] === 1);

    await delay(250);
    bar.style.width = '16%';
    const c1 = addStep('① 起卦：模运算取经卦', `
      第一数 <span class="derive-math">${n1}</span> ÷ 8 余 <span class="derive-math">${shown(n1, 8)}</span> → 上卦 <strong>${upper.name}（${upper.xiang}）</strong><br>
      第二数 <span class="derive-math">${n2}</span> ÷ 8 余 <span class="derive-math">${shown(n2, 8)}</span> → 下卦 <strong>${lower.name}（${lower.xiang}）</strong><br>
      第三数 <span class="derive-math">${n3}</span> ÷ 6 余 <span class="derive-math">${shown(n3, 6)}</span> → 动爻 <strong>${dongName}</strong>
    `);
    void c1;

    await delay(600);
    bar.style.width = '33%';
    const c2 = addStep('② 组合本卦', `上${upper.name}下${lower.name} 得本卦 <strong style="color:var(--gold)">${ben.unicode} ${ben.commonName}</strong>`);
    c2.appendChild(rowOf(
      hexItem(renderHexPaint(lower.yao), `下卦 ${lower.name}`, 'hex-label'),
      arrowOf('+'),
      hexItem(renderHexPaint(upper.yao), `上卦 ${upper.name}`, 'hex-label'),
      arrowOf('→'),
      hexItem(renderHexPaint(benYao), `${ben.unicode} ${ben.commonName}`, 'hex-name'),
    ));

    await delay(700);
    bar.style.width = '50%';
    const c3 = addStep('③ 标记动爻', `动爻为 <strong style="color:var(--gold)">${dongName}</strong>（第 ${dongIndex + 1} 爻，自下而上）`);
    c3.appendChild(rowOf(hexItem(renderHexPaint(benYao, '', [dongIndex]), `${ben.unicode} ${ben.commonName}`, 'hex-name')));

    await delay(700);
    bar.style.width = '66%';
    const c4 = addStep('④ 变卦推演', `动爻阴阳互变 → 变卦 <strong style="color:var(--gold)">${bian.unicode} ${bian.commonName}</strong>`);
    c4.appendChild(rowOf(
      hexItem(renderHexPaint(benYao, '', [dongIndex]), '本卦', 'hex-label'),
      arrowOf('🔄'),
      hexItem(renderHexPaint(bian.yaoList, '', [dongIndex]), `${bian.unicode} ${bian.commonName}`, 'hex-name'),
    ));

    await delay(700);
    bar.style.width = '83%';
    const c5 = addStep('⑤ 互卦推演', `取 2/3/4 爻为下互，3/4/5 爻为上互 → 互卦 <strong style="color:var(--gold)">${hu.unicode} ${hu.commonName}</strong>`);
    c5.appendChild(rowOf(
      hexItem(renderHexPaint(benYao), '本卦（取中四爻）', 'hex-label'),
      arrowOf('⇝'),
      hexItem(renderHexPaint(hu.yaoList), `${hu.unicode} ${hu.commonName}`, 'hex-name'),
    ));

    await delay(700);
    bar.style.width = '100%';
    addStep('⑥ 体用分析', `
      动爻在<strong>${dongIndex < 3 ? '下卦（内卦）' : '上卦（外卦）'}</strong>，则 <strong style="color:var(--gold)">${dongIndex < 3 ? '上卦为体' : '下卦为体'}</strong><br>
      <span style="font-size:17px">体卦：<strong style="color:var(--neon-cyan)">${ti.name}</strong>　用卦：<strong style="color:var(--neon-purple)">${yong.name}</strong></span>
    `);

    await delay(500);
    return { ben, bian, hu, dongIndex };
  }

  /* ================================================================
   *  七、大衍筮法 · 状态与引擎
   * ================================================================ */

  /**
   * 大衍状态（单一对象，便于调试与 destroy）
   * session：idle | vow（立愿）| auto（全自动）| semi（半自动）| replay（序列回放）| done
   * runId：运行令牌，每次 beginRun 递增；所有异步循环都以此判断是否仍有效
   */
  const daYan = {
    session: 'idle',
    runId: 0,
    abort: false,
    skip: false,
    vowFinish: null,
    M: DAYAN_TOTAL,
    change: 0,
    yaos: [],
    splits: [],
    logs: [],
    result: null,
  };

  function resetEngine() {
    daYan.M = DAYAN_TOTAL;
    daYan.change = 0;
    daYan.yaos = [];
    daYan.splits = [];
    daYan.logs = [];
    daYan.result = null;
  }

  const isRunActive = (runId) => !destroyed && runId === daYan.runId && !daYan.abort;

  function formatChangeLog(rec, n) {
    return `第${n}变 ｜ 分二 ${rec.L}·${rec.R} ｜ 挂一 ${rec.hang} ｜ 揲四 ${rec.lRem}+${rec.rRem} ｜ 归奇 ${rec.gua} ｜ 存 ${rec.M}→${rec.nextM}`;
  }

  /**
   * 推进一变（唯一状态写入口）
   * 每三变成一爻，成爻后存数重置为 49
   */
  function advanceChange(L) {
    if (daYan.change >= DAYAN_CHANGES) throw new Error('十八变已完成，不可再推进');
    const rec = castChange(daYan.M, L);
    daYan.splits.push(L);
    daYan.change += 1;
    daYan.logs.push(formatChangeLog(rec, daYan.change));
    daYan.M = rec.nextM;
    if (daYan.change % 3 === 0) {
      const v = daYan.M / 4;
      if (!Number.isInteger(v) || v < 6 || v > 9) throw new Error(`爻值异常：存数 ${daYan.M}`);
      const idx = daYan.yaos.length;
      daYan.yaos.push(v);
      daYan.logs.push(`▶ 成${yaoLabel(idx, v % 2 === 1)}：${yaoKindName(v)}（${v}）`);
      daYan.M = DAYAN_TOTAL;
    }
    return rec;
  }

  /**
   * 有界推演循环：pickSplit(step) 决定每变的分二位置
   * 循环上限 18；每步检查令牌；返回 true 表示完整跑完
   */
  async function runDaYanSequence(pickSplit, runId, pace) {
    for (let step = 0; step < DAYAN_CHANGES; step++) {
      if (!isRunActive(runId)) return false;
      advanceChange(pickSplit(step));
      renderDaYan();
      await sleep(pace);
    }
    return isRunActive(runId);
  }

  /** 立愿倒计时：可被跳过 / 中止，返回 true 表示正常结束 */
  function runVow(seconds, runId) {
    return new Promise((resolve) => {
      const overlay = $('#yj-dy-vow');
      const countEl = $('#yj-dy-vow-count');
      let left = seconds;
      let timer = null;
      overlay.style.display = 'block';
      countEl.textContent = String(left);

      const finish = (ok) => {
        if (timer) clearInterval(timer);
        daYan.vowFinish = null;
        overlay.style.display = 'none';
        resolve(Boolean(ok) && isRunActive(runId));
      };
      timer = setInterval(() => {
        left -= 1;
        countEl.textContent = String(Math.max(left, 0));
        if (left <= 0) finish(true);
      }, 1000);
      daYan.vowFinish = finish;
    });
  }

  function beginRun(session) {
    daYan.runId += 1;
    daYan.abort = false;
    daYan.skip = false;
    daYan.session = session;
    resetEngine();
    clearDaYanResultUI();
    renderDaYan();
    renderDaYanLog();
    return daYan.runId;
  }

  function finishDaYan() {
    daYan.session = 'done';
    daYan.result = buildDaYanResult();
    renderDaYanResult();
    setDaYanStatus('✨ 十八变毕，结果已成', 'ok');
    syncDaYanControls();
  }

  function abortDaYan() {
    if (!['vow', 'auto', 'semi', 'replay'].includes(daYan.session)) return;
    daYan.abort = true;
    daYan.runId += 1;               // 令牌失效，所有在途循环自行退出
    if (daYan.vowFinish) daYan.vowFinish(false);
    daYan.session = 'idle';
    setDaYanStatus(`已中止（完成 ${daYan.change}/${DAYAN_CHANGES} 变）`, 'warn');
    syncDaYanControls();
    renderDaYan();
  }

  function buildDaYanResult() {
    const yaoBin = daYan.yaos.map((v) => (v % 2 === 1 ? 1 : 0));
    const dongIdxs = daYan.yaos.map((v, i) => (v === 6 || v === 9 ? i : -1)).filter((i) => i >= 0);
    const ben = getHexagramByYaoList(yaoBin);
    const zhi = dongIdxs.length ? getZhiGua(yaoBin, dongIdxs) : null;
    const hu = getHuGua(yaoBin);
    return { ben, zhi, hu, yaoBin, dongIdxs, splits: [...daYan.splits] };
  }

  /* ================================================================
   *  八、大衍 UI 渲染 · 控件同步
   * ================================================================ */

  const getDaYanMode = () => document.querySelector('input[name="yj-dy-mode"]:checked').value;

  function setDaYanStatus(msg, type = '') {
    setStatus('#yj-dy-status', msg, type);
  }

  function syncDaYanControls() {
    const s = daYan.session;
    const idle = s === 'idle' || s === 'done';
    $('#yj-dy-start').disabled = !idle;
    $('#yj-dy-start').textContent = s === 'done' ? '🙏 再次起蓍' : '🙏 立愿并起蓍';
    $('#yj-dy-replay-btn').disabled = !idle;
    $$('input[name="yj-dy-mode"]').forEach((r) => { r.disabled = !idle; });
    $('#yj-dy-semi').style.display = s === 'semi' ? 'block' : 'none';
    $('#yj-dy-skip').disabled = !(s === 'auto' || s === 'replay');
    $('#yj-dy-abort').disabled = idle;
    $('#yj-dy-export').disabled = daYan.splits.length !== DAYAN_CHANGES;
  }

  function renderDaYan() {
    $('#yj-dy-M').textContent = String(daYan.M);

    const done = daYan.change;
    const info = $('#yj-dy-info');
    if (daYan.session === 'idle' && done === 0) info.textContent = '未起蓍';
    else if (done >= DAYAN_CHANGES) info.textContent = '十八变毕';
    else info.textContent = `第 ${done + 1} 变 · 第 ${daYan.yaos.length + 1} 爻 · 本爻第 ${(done % 3) + 1}/3 变`;
    $('#yj-dy-bar').style.width = `${((done / DAYAN_CHANGES) * 100).toFixed(1)}%`;

    // 六爻砖：自上而下（上 → 初）
    $$('.yj-dy-brick').forEach((el) => {
      const i = Number(el.dataset.i);
      const v = daYan.yaos[i];
      el.className = 'yj-dy-brick';
      if (v === undefined) {
        el.textContent = `${YAO_POS[i]}爻 —`;
      } else {
        const yang = v % 2 === 1;
        const dong = v === 6 || v === 9;
        el.classList.add(yang ? 'yang' : 'yin');
        if (dong) el.classList.add('dong');
        el.textContent = `${yaoLabel(i, yang)} · ${yaoKindName(v)}`;
      }
    });

    // 半自动滑竿范围与提示
    const slider = $('#yj-dy-slider');
    const maxL = Math.max(1, daYan.M - 2);
    slider.max = String(maxL);
    let L = Number(slider.value);
    if (!Number.isInteger(L) || L < 1 || L > maxL) {
      L = Math.floor(daYan.M / 2);
      slider.value = String(L);
    }
    $('#yj-dy-tip').textContent = `左堆 ${L} · 右堆 ${daYan.M - L}`;

    renderDaYanLog();
    syncDaYanControls();
  }

  function renderDaYanLog() {
    const box = $('#yj-dy-log');
    box.textContent = '';
    daYan.logs.forEach((line, idx) => {
      const d = document.createElement('div');
      d.className = 'yj-dy-logline' + (idx === daYan.logs.length - 1 ? ' last' : '');
      d.textContent = line;
      box.appendChild(d);
    });
    box.scrollTop = box.scrollHeight;
  }

  function clearDaYanResultUI() {
    $('#yj-dy-result').style.display = 'none';
    $('#yj-dy-result').textContent = '';
    $('#yj-dy-checks').style.display = 'none';
    $('#yj-dy-copy').style.display = 'none';
    // 新一轮开始时恢复「之卦」勾选，避免上一轮静卦留下的未勾选状态影响本轮复制
    $('#yj-dy-ck-zhi').disabled = false;
    $('#yj-dy-ck-zhi').checked = true;
  }

  function makeGuaCard(gua, label, yaoBin, dongIdxs) {
    const card = document.createElement('div');
    card.className = 'gua-card';
    const paint = renderHexPaint(yaoBin, '', dongIdxs);
    paint.style.setProperty('--yj-yao-w', '34px');
    paint.style.margin = '4px auto 0';
    const lb = document.createElement('div');
    lb.className = 'card-label';
    lb.textContent = label;
    const nm = document.createElement('div');
    nm.className = 'card-name';
    nm.textContent = `${gua.unicode} ${gua.commonName}`;
    card.append(lb, nm, paint);
    card.addEventListener('click', () => openGuaContent(gua, label));
    return card;
  }

  function renderDaYanResult() {
    const res = daYan.result;
    if (!res) return;
    const box = $('#yj-dy-result');
    box.textContent = '';
    box.style.display = 'block';

    const cards = document.createElement('div');
    cards.className = 'yj-cards';
    cards.appendChild(makeGuaCard(res.ben, '本卦', res.yaoBin, res.dongIdxs));
    if (res.zhi) cards.appendChild(makeGuaCard(res.zhi, '之卦', res.zhi.yaoList, []));
    cards.appendChild(makeGuaCard(res.hu, '互卦', res.hu.yaoList, []));
    box.appendChild(cards);

    const verdict = document.createElement('div');
    verdict.className = 'yj-dy-verdict';
    const dongText = res.dongIdxs.length
      ? res.dongIdxs.map((i) => yaoLabel(i, res.yaoBin[i] === 1)).join('、')
      : '无（静卦，以本卦为断）';
    verdict.textContent = `动爻：${dongText}${res.zhi ? `　→　之卦 ${res.zhi.commonName}` : ''}`;
    box.appendChild(verdict);

    $('#yj-dy-checks').style.display = 'flex';
    $('#yj-dy-copy').style.display = 'block';
    $('#yj-dy-ck-zhi').disabled = !res.zhi;
    // 有之卦时恢复勾选；静卦时禁用并取消勾选
    $('#yj-dy-ck-zhi').checked = Boolean(res.zhi);
    syncDaYanControls();
  }

  /* ================================================================
   *  九、大衍 · 事件绑定（起蓍 / 半自动 / 跳过 / 中止 / 导出 / 回放）
   * ================================================================ */

  async function startDaYan() {
    if (!['idle', 'done'].includes(daYan.session)) return;
    const mode = getDaYanMode();
    const runId = beginRun('vow');
    syncDaYanControls();
    setDaYanStatus('请心中默念所问之事…');
    try {
      const ok = await runVow(10, runId);
      if (!ok) return;     // 中止或被替换，由 abortDaYan 负责 UI
      if (mode === 'auto') {
        daYan.session = 'auto';
        syncDaYanControls();
        setDaYanStatus('全自动推演中…（可「一键跳过」）');
        const finished = await runDaYanSequence(() => randInt(1, daYan.M - 2), runId, 240);
        if (finished) finishDaYan();
      } else {
        daYan.session = 'semi';
        renderDaYan();
        setDaYanStatus('半自动：拖动滑竿决定分二，点「推进一变」');
      }
    } catch (err) {
      console.error(TAG, '大衍起蓍异常', err);
      setDaYanStatus(`推演异常：${err.message}`, 'err');
      if (runId === daYan.runId) daYan.session = 'idle';
    } finally {
      if (runId === daYan.runId) syncDaYanControls();
    }
  }

  function bindDaYanEvents() {
    on($('#yj-dy-start'), 'click', () => { startDaYan(); });

    on($('#yj-dy-abort'), 'click', () => abortDaYan());

    on($('#yj-dy-skip'), 'click', () => {
      if (daYan.session === 'auto' || daYan.session === 'replay') {
        daYan.skip = true;
        setDaYanStatus('已跳过动画，快速完成…');
      }
    });

    on($('#yj-vow-skip'), 'click', () => {
      if (daYan.vowFinish) daYan.vowFinish(true);
    });

    const slider = $('#yj-dy-slider');
    on(slider, 'input', () => {
      $('#yj-dy-tip').textContent = `左堆 ${slider.value} · 右堆 ${daYan.M - Number(slider.value)}`;
    });
    on($('#yj-dy-rand'), 'click', () => {
      slider.value = String(randInt(1, Math.max(1, daYan.M - 2)));
      slider.dispatchEvent(new Event('input'));
    });

    on($('#yj-dy-next'), 'click', () => {
      if (daYan.session !== 'semi') return;
      const L = Number(slider.value);
      try {
        advanceChange(L);
      } catch (err) {
        console.error(TAG, '半自动分二参数非法', err);
        setDaYanStatus(err.message, 'err');
        return;
      }
      renderDaYan();
      if (daYan.change >= DAYAN_CHANGES) {
        finishDaYan();
      } else {
        setDaYanStatus(`第 ${daYan.change} 变完成，继续推进`);
      }
    });

    on($('#yj-dy-export'), 'click', () => {
      if (daYan.splits.length !== DAYAN_CHANGES) {
        setDaYanStatus('需完成十八变后才能导出', 'warn');
        return;
      }
      GM_setClipboard(JSON.stringify({ v: 1, splits: daYan.splits }), 'text');
      setDaYanStatus('✔ 筮法序列已复制到剪贴板', 'ok');
    });

    on($('#yj-dy-replay-btn'), 'click', async () => {
      if (!['idle', 'done'].includes(daYan.session)) return;
      let seq;
      try {
        const raw = JSON.parse($('#yj-dy-replay').value);
        seq = Array.isArray(raw) ? raw : raw.splits;
        simulateSplits(seq);          // 全量预校验，失败则不进入任何状态
      } catch (err) {
        console.error(TAG, '序列回放校验失败', err);
        setDaYanStatus(`序列无效：${err.message}`, 'err');
        return;
      }
      const frozen = seq.slice();
      const runId = beginRun('replay');
      syncDaYanControls();
      setDaYanStatus('序列回放中…（可「一键跳过」）');
      try {
        const finished = await runDaYanSequence((step) => frozen[step], runId, 200);
        if (finished) finishDaYan();
      } catch (err) {
        console.error(TAG, '序列回放异常', err);
        setDaYanStatus(`回放异常：${err.message}`, 'err');
        if (runId === daYan.runId) daYan.session = 'idle';
      } finally {
        if (runId === daYan.runId) syncDaYanControls();
      }
    });

    on($('#yj-dy-copy'), 'click', async () => {
      const res = daYan.result;
      if (!res) return;
      const tasks = [{ tag: '本卦', data: res.ben }];
      if ($('#yj-dy-ck-hu').checked) tasks.push({ tag: '互卦', data: res.hu });
      if ($('#yj-dy-ck-zhi').checked && res.zhi) tasks.push({ tag: '之卦', data: res.zhi });
      const dongText = res.dongIdxs.length
        ? res.dongIdxs.map((i) => yaoLabel(i, res.yaoBin[i] === 1)).join('、')
        : '无（静卦）';
      const header = `> 占法：大衍筮法（十八变）
> 本卦：${res.ben.commonName}（上${res.ben.upper.name}下${res.ben.lower.name}）
> 动爻：${dongText}
> 之卦：${res.zhi ? res.zhi.commonName : '无'}
> 互卦：上互${res.hu.upper.name}、下互${res.hu.lower.name}
> 分二序列：${JSON.stringify(res.splits)}

${'='.repeat(30)}
`;
      await runBatchCopy(tasks, '#yj-dy-status', $('#yj-dy-copy'), header);
    });
  }

  /* ================================================================
   *  十、DOM 构建
   * ================================================================ */

  const panel = document.createElement('div');
  panel.id = 'yj-panel';
  panel.innerHTML = `
    <div id="yj-drag"><span class="ico">☰</span><span>易经推演</span><span class="yj-collapse" title="折叠 / 展开">−</span></div>
    <div id="yj-body">
      <div class="yj-tabs">
        <div class="yj-tab active" data-tab="manual">手动选卦</div>
        <div class="yj-tab" data-tab="pai">梅花排卦</div>
        <div class="yj-tab" data-tab="dayan">大衍筮法</div>
      </div>

      <div class="yj-pane active" data-pane="manual">
        <div class="yj-preview" id="yj-preview">
          <div class="paint-wrap"></div>
          <div><div class="hex-name"></div><div class="hex-sub"></div></div>
        </div>
        <div class="yj-sub-title">逐爻选择（自上而下：上爻 → 初爻；6 老阴 / 9 老阳 自动为动爻）</div>
        <div id="yj-man-yao"></div>
        <div class="yj-row" style="margin-top:8px">
          <span id="yj-man-count" style="flex:1;color:var(--text-muted);font-size:12px">已定 0/6 爻</span>
          <button class="yj-btn-sm" id="yj-manual-reset" type="button">清空</button>
        </div>
        <div class="yj-checks">
          <label><input type="checkbox" checked disabled> 本卦</label>
          <label><input type="checkbox" id="yj-mc-hu" checked> 互卦</label>
          <label><input type="checkbox" id="yj-mc-zhi" checked> 之卦</label>
        </div>
        <button class="yj-btn" id="yj-manual-copy">📋 抓取并复制</button>
        <div class="yj-status" id="yj-manual-status"></div>
      </div>

      <div class="yj-pane" data-pane="pai">
        <div class="yj-row"><label>第一数</label><input type="number" id="yj-n1" min="1" placeholder="除8取上卦"></div>
        <div class="yj-row"><label>第二数</label><input type="number" id="yj-n2" min="1" placeholder="除8取下卦"></div>
        <div class="yj-row"><label>第三数</label><input type="number" id="yj-n3" min="1" placeholder="除6取动爻"></div>
        <button class="yj-btn" id="yj-pai-btn" style="margin-bottom:12px">🎲 开始排卦推演</button>
        <div class="yj-cards" id="yj-cards" style="display:none">
          <div class="gua-card" data-type="ben"><div class="paint"></div><div class="card-name"></div><div class="card-label">本卦</div></div>
          <div class="gua-card" data-type="bian"><div class="paint"></div><div class="card-name"></div><div class="card-label">变卦</div></div>
          <div class="gua-card" data-type="hu"><div class="paint"></div><div class="card-name"></div><div class="card-label">互卦</div></div>
        </div>
        <div class="yj-checks" id="yj-pai-checks" style="display:none">
          <label><input type="checkbox" id="yj-pc-ben" checked> 本卦</label>
          <label><input type="checkbox" id="yj-pc-hu" checked> 互卦</label>
          <label><input type="checkbox" id="yj-pc-bian" checked> 变卦</label>
        </div>
        <button class="yj-btn" id="yj-pai-copy" style="display:none">📋 抓取并复制选中内容</button>
        <div class="yj-status" id="yj-pai-status"></div>
      </div>

      <div class="yj-pane" data-pane="dayan">
        <div class="yj-mode">
          <label><input type="radio" name="yj-dy-mode" value="auto" checked>全自动</label>
          <label><input type="radio" name="yj-dy-mode" value="semi">半自动（滑竿）</label>
        </div>
        <div class="yj-dy-hud">
          <div class="yj-dy-M">本爻存数 <span id="yj-dy-M">49</span></div>
          <div class="yj-dy-info" id="yj-dy-info">未起蓍</div>
        </div>
        <div class="yj-progress"><div class="yj-progress-bar" id="yj-dy-bar"></div></div>
        <div class="yj-dy-bricks" id="yj-dy-bricks"></div>

        <div class="yj-dy-semi" id="yj-dy-semi">
          <input type="range" id="yj-dy-slider" min="1" max="47" value="24">
          <div class="yj-dy-tip" id="yj-dy-tip"></div>
          <div class="yj-btn-row">
            <button class="yj-btn-sm" id="yj-dy-rand">🎲 随机</button>
            <button class="yj-btn" id="yj-dy-next">推进一变</button>
          </div>
        </div>

        <div class="yj-vow" id="yj-dy-vow">
          <div class="vow-text">🙏 请心中默念所问之事</div>
          <div class="vow-count" id="yj-dy-vow-count">10</div>
          <button class="yj-btn-sm" id="yj-vow-skip">跳过立愿</button>
        </div>

        <div class="yj-btn-row">
          <button class="yj-btn" id="yj-dy-start">🙏 立愿并起蓍</button>
        </div>
        <div class="yj-btn-row">
          <button class="yj-btn-sm" id="yj-dy-skip" disabled>⏭ 一键跳过</button>
          <button class="yj-btn-sm" id="yj-dy-abort" disabled>⏹ 中止</button>
        </div>

        <div class="yj-dy-log" id="yj-dy-log"></div>
        <div id="yj-dy-result" style="display:none"></div>
        <div class="yj-checks" id="yj-dy-checks" style="display:none">
          <label><input type="checkbox" checked disabled> 本卦</label>
          <label><input type="checkbox" id="yj-dy-ck-hu" checked> 互卦</label>
          <label><input type="checkbox" id="yj-dy-ck-zhi" checked> 之卦</label>
        </div>
        <button class="yj-btn" id="yj-dy-copy" style="display:none">📋 抓取并复制选中内容</button>

        <details class="yj-seq">
          <summary>筮法序列：导出 / 回放</summary>
          <button class="yj-btn-sm" id="yj-dy-export" disabled>导出序列（JSON → 剪贴板）</button>
          <textarea id="yj-dy-replay" placeholder='粘贴导出的 JSON，或 [24, 10, ...] 共 18 个分二位置'></textarea>
          <button class="yj-btn-sm" id="yj-dy-replay-btn">▶ 回放</button>
        </details>
        <div class="yj-status" id="yj-dy-status"></div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  // 大衍六爻砖（自上而下）
  const brickBox = $('#yj-dy-bricks');
  for (let i = 5; i >= 0; i--) {
    const b = document.createElement('div');
    b.className = 'yj-dy-brick';
    b.dataset.i = String(i);
    b.textContent = `${YAO_POS[i]}爻 —`;
    brickBox.appendChild(b);
  }

  // 手动逐爻行（自上而下）
  const manualYaoBox = $('#yj-man-yao');
  for (let i = 5; i >= 0; i--) {
    const row = document.createElement('div');
    row.className = 'yj-yao-row';
    row.dataset.i = String(i);
    row.innerHTML = `
      <span class="yj-yao-name"></span>
      <select class="yj-yao-val"></select>`;
    const sel = row.querySelector('.yj-yao-val');
    MANUAL_VALUE_OPTIONS.forEach(([value, label]) => sel.add(new Option(label, value)));
    sel.value = '';
    manualYaoBox.appendChild(row);
  }

  const deriveModal = document.createElement('div');
  deriveModal.id = 'yj-derive-modal';
  deriveModal.innerHTML = `
    <div class="derive-header">
      <h2>🔮 梅花易数推演过程</h2>
      <div class="derive-progress"><div class="derive-progress-bar"></div></div>
      <div class="derive-close">×</div>
    </div>
    <div class="derive-body"></div>
    <div class="derive-footer"><button class="yj-btn" id="derive-done">✓ 完成推演，查看结果</button></div>`;
  document.body.appendChild(deriveModal);

  const modal = document.createElement('div');
  modal.id = 'yj-modal';
  modal.innerHTML = `
    <div class="yj-modal-content">
      <div class="yj-modal-header"><span id="yj-modal-title">加载中</span><span class="yj-modal-close">×</span></div>
      <div class="yj-modal-body" id="yj-modal-body">正在抓取…</div>
      <div class="yj-modal-footer">
        <span id="yj-modal-msg"></span>
        <button class="yj-modal-copy" id="yj-modal-copy" style="display:none">📄 复制正文</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  /* ================================================================
   *  十一、通用 UI：模态 · 状态 · 批量复制 · 卦内容打开
   * ================================================================ */

  function setStatus(sel, msg, type = '') {
    const el = $(sel);
    el.textContent = msg;
    el.className = `yj-status ${type}`;
  }

  let modalLastText = '';
  let modalSeq = 0;
  const modalUI = {
    open(title) {
      if (destroyed) return -1;
      const seq = ++modalSeq;
      $('#yj-modal-title').textContent = title;
      $('#yj-modal-body').textContent = '正在抓取内容，请稍候…';
      $('#yj-modal-msg').textContent = '';
      $('#yj-modal-msg').className = '';
      $('#yj-modal-copy').style.display = 'none';
      modalLastText = '';
      modal.classList.add('show');
      return seq;
    },
    showText(text, msg, type = 'ok', seq = modalSeq) {
      if (destroyed || seq !== modalSeq) return false;
      modalLastText = text;
      $('#yj-modal-body').textContent = text;
      $('#yj-modal-msg').textContent = msg;
      $('#yj-modal-msg').className = `foot-msg-${type}`;
      $('#yj-modal-copy').style.display = 'inline-block';
      return true;
    },
    showError(msg, seq = modalSeq) {
      if (destroyed || seq !== modalSeq) return false;
      $('#yj-modal-body').textContent = `抓取失败：${msg}\n\n排查提示：\n1. F12 → Console，过滤 [yj] 查看日志\n2. 若为反爬拦截，刷新页面后重试\n3. 若提示结构变更，请反馈`;
      $('#yj-modal-msg').textContent = '抓取失败';
      $('#yj-modal-msg').className = 'foot-msg-err';
      $('#yj-modal-copy').style.display = 'none';
      return true;
    },
    close() {
      modalSeq += 1;
      modal.classList.remove('show');
    },
  };

  async function openGuaContent(gua, label) {
    const seq = modalUI.open(`${gua.unicode} ${gua.commonName}（${label}）`);
    try {
      const text = await fetchHexContent(gua.slug);
      modalUI.showText(text, '内容加载完成', 'ok', seq);
    } catch (err) {
      console.error(TAG, `卦辞抓取失败：${gua.commonName}`, err);
      modalUI.showError(err.message, seq);
    }
  }

  /**
   * 批量抓取并复制
   * tasks：[{tag, data}]，data 为卦对象（含 slug / unicode / commonName）
   * headerText：已拼好的头部说明（可为空串）
   */
  async function runBatchCopy(tasks, statusSel, btn, headerText) {
    if (destroyed) return;
    btn.disabled = true;
    const btnText = btn.textContent;
    btn.textContent = '抓取中…';
    setStatus(statusSel, '正在批量抓取…');
    const seq = modalUI.open(`正在复制 ${tasks.length} 个卦的内容`);
    if (seq < 0) {
      btn.disabled = false;
      btn.textContent = btnText;
      return;
    }

    let output = '', okCount = 0;
    const errors = [];
    try {
      for (let i = 0; i < tasks.length; i++) {
        if (destroyed || seq !== modalSeq) break;
        const t = tasks[i];
        $('#yj-modal-body').textContent = `正在抓取：${t.tag} ${t.data.commonName}（${i + 1}/${tasks.length}）`;
        try {
          const text = await fetchHexContent(t.data.slug);
          output += `${t.tag}：${t.data.unicode} ${t.data.commonName}\n${text}`;
          if (i !== tasks.length - 1) output += `\n\n${'='.repeat(30)}\n\n`;
          okCount++;
        } catch (err) {
          console.error(TAG, `${t.tag} ${t.data.commonName} 抓取失败`, err);
          errors.push(`${t.tag} ${t.data.commonName}：${err.message}`);
        }
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = btnText;
      }
    }

    // 用户已关闭弹窗或切换到另一条内容，丢弃本次结果，避免旧请求覆盖新内容
    if (destroyed || seq !== modalSeq) return;

    if (okCount > 0) {
      const full = (headerText + output).trim();
      GM_setClipboard(full, 'text');
      const msg = `✔ 已复制 ${okCount}/${tasks.length} 个卦的内容`;
      modalUI.showText(full, errors.length ? `${msg}（${errors.length} 个失败）` : msg, errors.length ? 'warn' : 'ok', seq);
      setStatus(statusSel, errors.length ? `部分成功（${errors.length} 个失败）` : '全部复制成功', errors.length ? 'warn' : 'ok');
    } else {
      modalUI.showError(errors[0] || '未知错误', seq);
      setStatus(statusSel, '抓取失败（原因见弹窗）', 'err');
    }
  }

  /* ================================================================
   *  十二、面板：拖拽 · 折叠 · 位置记忆 · Tab 切换
   * ================================================================ */

  const POS_KEY = 'yj-panel-pos-v2';
  let savedPos = null;
  try { savedPos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); }
  catch (err) { console.warn(TAG, '读取面板位置失败，使用默认位置', err); }
  if (savedPos && savedPos.top && savedPos.left) {
    const top = parseFloat(savedPos.top), left = parseFloat(savedPos.left);
    const panelH = panel.offsetHeight || 420;
    if (top >= 0 && top + panelH <= window.innerHeight && left >= 0 && left + 360 <= window.innerWidth) {
      // 恢复绝对坐标时必须清掉默认的 right/bottom，否则 top+bottom 会把面板拉伸到视口高度
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      Object.assign(panel.style, savedPos);
    }
  }

  let dragging = false, dragOx = 0, dragOy = 0;
  on($('#yj-drag'), 'mousedown', (e) => {
    if (e.target.classList.contains('yj-collapse')) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    dragOx = e.clientX - r.left;
    dragOy = e.clientY - r.top;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    e.preventDefault();
  });
  on(document, 'mousemove', (e) => {
    if (!dragging) return;
    const maxLeft = window.innerWidth - 60, maxTop = window.innerHeight - 60;
    const left = Math.min(Math.max(e.clientX - dragOx, 0), maxLeft);
    const top = Math.min(Math.max(e.clientY - dragOy, 0), maxTop);
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px` });
  });
  on(document, 'mouseup', () => {
    if (!dragging) return;
    dragging = false;
    try { localStorage.setItem(POS_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top })); }
    catch (err) { console.warn(TAG, '保存面板位置失败', err); }
  });

  on($('.yj-collapse'), 'click', () => {
    panel.classList.toggle('collapsed');
    $('.yj-collapse').textContent = panel.classList.contains('collapsed') ? '☐' : '−';
  });

  $$('.yj-tab').forEach((tab) => {
    on(tab, 'click', () => {
      $$('.yj-tab').forEach((t) => t.classList.remove('active'));
      $$('.yj-pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`.yj-pane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
      $('#yj-body').scrollTop = 0;
    });
  });

  /* ================================================================
   *  十三、Tab1：手动选卦（逐爻 6/7/8/9 + 多动爻 + 之卦）
   * ================================================================ */

  const manual = {
    values: [null, null, null, null, null, null], // 下标 0 = 初爻；null = 未定
  };
  let manualHex = null;
  let manualDongIdxs = [];

  const manualBinary = () => manual.values.map((v) => (v === null ? null : (v % 2 === 1 ? 1 : 0)));
  const manualIsComplete = () => manual.values.every((v) => v !== null);

  function renderManual() {
    const binary = manualBinary();
    const count = manual.values.filter((v) => v !== null).length;
    manualDongIdxs = manual.values
      .map((v, i) => (v === 6 || v === 9 ? i : -1))
      .filter((i) => i >= 0);
    manualHex = manualIsComplete() ? getHexagramByYaoList(binary) : null;

    manual.values.forEach((v, i) => {
      const row = $(`.yj-yao-row[data-i="${i}"]`);
      row.querySelector('.yj-yao-name').textContent = v === null ? `${YAO_POS[i]}爻` : yaoLabel(i, v % 2 === 1);
      const sel = row.querySelector('.yj-yao-val');
      sel.value = v === null ? '' : String(v);
      row.classList.toggle('is-dong', v === 6 || v === 9);
    });

    const wrap = $('#yj-preview .paint-wrap');
    wrap.textContent = '';
    wrap.appendChild(renderHexPaint(binary, '', manualDongIdxs));

    const copyBtn = $('#yj-manual-copy');
    copyBtn.disabled = !manualHex;
    $('#yj-man-count').textContent = `已定 ${count}/6 爻`;

    if (!manualHex) {
      $('#yj-preview .hex-name').textContent = '— 未定 —';
      $('#yj-preview .hex-sub').textContent = count === 0
        ? '请从上往下依次选择每爻，或直接按蓍草结果填写'
        : `已定 ${count}/6 爻，还差 ${6 - count} 爻`;
      return;
    }

    $('#yj-preview .hex-name').textContent = `${manualHex.unicode} ${manualHex.commonName}`;
    let hint;
    if (manualDongIdxs.length === 0) {
      hint = '无动爻 · 静卦';
    } else {
      const zhi = getZhiGua(binary, manualDongIdxs);
      hint = `动 ${manualDongIdxs.length} 爻 → 之卦 ${zhi.commonName}`;
    }
    $('#yj-preview .hex-sub').textContent = `上${manualHex.upper.name}下${manualHex.lower.name} · ${hint}`;
  }

  on(manualYaoBox, 'change', (e) => {
    if (!e.target.classList.contains('yj-yao-val')) return;
    const row = e.target.closest('.yj-yao-row');
    const i = Number(row.dataset.i);
    manual.values[i] = e.target.value === '' ? null : Number(e.target.value);
    renderManual();
  });

  on($('#yj-manual-reset'), 'click', () => {
    manual.values = [null, null, null, null, null, null];
    renderManual();
  });

  on($('#yj-manual-copy'), 'click', async () => {
    if (!manualHex) {
      setStatus('#yj-manual-status', '请先选满六爻', 'err');
      return;
    }
    const hex = manualHex;
    const binary = manualBinary();
    const tasks = [{ tag: '本卦', data: hex }];
    let zhi = null;
    if (manualDongIdxs.length) zhi = getZhiGua(binary, manualDongIdxs);
    if ($('#yj-mc-hu').checked) tasks.push({ tag: '互卦', data: getHuGua(binary) });
    if ($('#yj-mc-zhi').checked && zhi) tasks.push({ tag: '之卦', data: zhi });

    const dongText = manualDongIdxs.length
      ? manualDongIdxs.map((i) => yaoLabel(i, binary[i] === 1)).join('、')
      : '无（静卦）';
    const header = `> 本卦：${hex.commonName}（上${hex.upper.name}下${hex.lower.name}）
> 动爻：${dongText}
> 之卦：${zhi ? zhi.commonName : '无'}

${'='.repeat(30)}
`;
    await runBatchCopy(tasks, '#yj-manual-status', $('#yj-manual-copy'), header);
  });

  /* ================================================================
   *  十四、Tab2：梅花排卦
   * ================================================================ */

  let paiResult = null;

  function fillPaiCards(pai) {
    if (destroyed) return;
    const dyName = yaoLabel(pai.dongIndex, pai.ben.yaoList[pai.dongIndex] === 1);
    const fill = (type, gua, label) => {
      const card = $(`.gua-card[data-type="${type}"]`);
      const paint = card.querySelector('.paint');
      paint.textContent = '';
      paint.appendChild(renderHexPaint(gua.yaoList, '', type === 'hu' ? [] : [pai.dongIndex]));
      card.querySelector('.card-name').textContent = `${gua.unicode} ${gua.commonName}`;
      card.querySelector('.card-label').textContent = label;
    };
    fill('ben', pai.ben, `本卦 · ${dyName}动`);
    fill('bian', pai.bian, '变卦');
    fill('hu', pai.hu, '互卦');
    $$('.gua-card').forEach((c) => c.classList.remove('active'));
    $('.gua-card[data-type="ben"]').classList.add('active');
    $('#yj-cards').style.display = 'flex';
    $('#yj-pai-checks').style.display = 'flex';
    $('#yj-pai-copy').style.display = 'block';
  }

  function buildPaiHeader(pai) {
    const { ti, yong } = getTiYong(pai.ben, pai.dongIndex);
    const dyName = yaoLabel(pai.dongIndex, pai.ben.yaoList[pai.dongIndex] === 1);
    return `> 本卦：${pai.ben.commonName}（上${pai.ben.upper.name}下${pai.ben.lower.name}），${dyName}动
> 体卦：${ti.name}　用卦：${yong.name}
> 变卦：${pai.bian.commonName}
> 互卦：上互${pai.hu.upper.name}、下互${pai.hu.lower.name}

${'='.repeat(30)}
`;
  }

  on($('#yj-pai-btn'), 'click', async () => {
    const n1 = parseInt($('#yj-n1').value, 10);
    const n2 = parseInt($('#yj-n2').value, 10);
    const n3 = parseInt($('#yj-n3').value, 10);
    if ([n1, n2, n3].some((n) => Number.isNaN(n) || n < 1)) {
      setStatus('#yj-pai-status', '请输入三个正整数', 'err');
      return;
    }
    const btn = $('#yj-pai-btn');
    btn.disabled = true;
    setStatus('#yj-pai-status', '正在推演…');
    try {
      paiResult = await showDerivation(n1, n2, n3);
      if (destroyed) return;
      fillPaiCards(paiResult);
      const dyName = yaoLabel(paiResult.dongIndex, paiResult.ben.yaoList[paiResult.dongIndex] === 1);
      setStatus('#yj-pai-status', `推演完成：${dyName}动`, 'ok');
      $('#yj-body').scrollTop = $('#yj-body').scrollHeight;
    } catch (err) {
      if (destroyed) return;
      console.error(TAG, '梅花推演异常', err);
      setStatus('#yj-pai-status', `推演异常：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $$('.gua-card[data-type]').forEach((card) => {
    on(card, 'click', () => {
      if (!paiResult) return;
      $$('.gua-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      const gua = paiResult[card.dataset.type];
      const label = card.querySelector('.card-label').textContent;
      openGuaContent(gua, label);
    });
  });

  on($('#yj-pai-copy'), 'click', async () => {
    if (!paiResult) return;
    const tasks = [];
    if ($('#yj-pc-ben').checked) tasks.push({ tag: '本卦', data: paiResult.ben });
    if ($('#yj-pc-hu').checked) tasks.push({ tag: '互卦', data: paiResult.hu });
    if ($('#yj-pc-bian').checked) tasks.push({ tag: '变卦', data: paiResult.bian });
    if (!tasks.length) {
      setStatus('#yj-pai-status', '请至少勾选一个卦', 'err');
      return;
    }
    await runBatchCopy(tasks, '#yj-pai-status', $('#yj-pai-copy'), buildPaiHeader(paiResult));
  });

  /* ================================================================
   *  十五、Tab3 事件 · 初始化
   * ================================================================ */

  function initDaYanUI() {
    $$('input[name="yj-dy-mode"]').forEach((r) => on(r, 'change', () => syncDaYanControls()));
    bindDaYanEvents();
    renderDaYan();
    syncDaYanControls();
  }

  on($('#derive-done'), 'click', () => deriveModal.classList.remove('show'));
  deriveModal.querySelector('.derive-close').addEventListener('click', () => deriveModal.classList.remove('show'));
  modal.querySelector('.yj-modal-close').addEventListener('click', () => modalUI.close());
  modal.addEventListener('click', (e) => { if (e.target === modal) modalUI.close(); });
  $('#yj-modal-copy').addEventListener('click', () => {
    if (!modalLastText) return;
    GM_setClipboard(modalLastText, 'text');
    $('#yj-modal-msg').textContent = '✔ 已复制到剪贴板';
    $('#yj-modal-msg').className = 'foot-msg-ok';
  });
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape') {
      modalUI.close();
      deriveModal.classList.remove('show');
    }
  });

  renderManual();
  initDaYanUI();

  /* ================================================================
   *  十六、调试命名空间 · 销毁
   * ================================================================ */

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    daYan.abort = true;
    daYan.runId += 1;
    if (daYan.vowFinish) daYan.vowFinish(false);
    listeners.splice(0).forEach(([t, type, fn, opts]) => t.removeEventListener(type, fn, opts));
    [panel, deriveModal, modal].forEach((el) => el && el.remove());
    if (styleEl && typeof styleEl.remove === 'function') styleEl.remove();
    delete pageWin.__yj_debug__;
    pageWin.__yj_loaded__ = false;
    console.info(TAG, '已销毁并清理全部监听、节点与样式');
  }

  pageWin.__yj_debug__ = {
    version: '4.1.0',
    log: (...a) => console.debug(TAG, ...a),
    warn: (...a) => console.warn(TAG, ...a),
    error: (...a) => console.error(TAG, ...a),
    state: daYan,
    manual,
    castChange,
    simulateSplits,
    getZhiGua,
    destroy,
  };

  console.info(TAG, '已加载 · 调试入口 __yj_debug__ · 销毁 __yj_debug__.destroy()');
})();
