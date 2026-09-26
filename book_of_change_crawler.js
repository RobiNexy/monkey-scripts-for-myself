// ==UserScript==
// @name         易经内容抓取与排卦工具 - 炫酷增强版
// @namespace    http://tampermonkey.net/
// @version      3.7
// @description  梅花易数全屏推演、高对比度配色、玻璃态炫酷 UI、fetch 同源抓取
// @author       AI
// @match        https://ctext.org/book-of-changes/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    /* ================================================================
     *  一、数据层
     * ================================================================ */

    const trigramMap = {
        "1,1,1": { name: "乾", xiang: "天", pinyin: "qian", num: 1 },
        "1,1,0": { name: "兑", xiang: "泽", pinyin: "dui",  num: 2 },
        "1,0,1": { name: "离", xiang: "火", pinyin: "li",   num: 3 },
        "1,0,0": { name: "震", xiang: "雷", pinyin: "zhen", num: 4 },
        "0,1,1": { name: "巽", xiang: "风", pinyin: "xun",  num: 5 },
        "0,1,0": { name: "坎", xiang: "水", pinyin: "kan",  num: 6 },
        "0,0,1": { name: "艮", xiang: "山", pinyin: "gen",  num: 7 },
        "0,0,0": { name: "坤", xiang: "地", pinyin: "kun",  num: 0 },
    };
    const trigramByPinyin = {};
    Object.entries(trigramMap).forEach(([k, v]) => {
        v.yao = k.split(',').map(Number);
        trigramByPinyin[v.pinyin] = v;
    });

    const hexagramMap = {
        "qian_qian": { name: "乾",   unicode: "䷀", slug: "qian" },
        "kun_kun":   { name: "坤",   unicode: "䷁", slug: "kun" },
        "kan_zhen":  { name: "屯",   unicode: "䷂", slug: "zhun" },
        "gen_kan":   { name: "蒙",   unicode: "䷃", slug: "meng" },
        "kan_qian":  { name: "需",   unicode: "䷄", slug: "xu" },
        "qian_kan":  { name: "讼",   unicode: "䷅", slug: "song" },
        "kun_kan":   { name: "师",   unicode: "䷆", slug: "shi" },
        "kan_kun":   { name: "比",   unicode: "䷇", slug: "bi" },
        "xun_qian":  { name: "小畜", unicode: "䷈", slug: "xiao-xu" },
        "qian_dui":  { name: "履",   unicode: "䷉", slug: "lv" },
        "kun_qian":  { name: "泰",   unicode: "䷊", slug: "tai" },
        "qian_kun":  { name: "否",   unicode: "䷋", slug: "pi" },
        "qian_li":   { name: "同人", unicode: "䷌", slug: "tong-ren" },
        "li_qian":   { name: "大有", unicode: "䷍", slug: "da-you" },
        "kun_gen":   { name: "谦",   unicode: "䷎", slug: "qian1" },
        "zhen_kun":  { name: "豫",   unicode: "䷏", slug: "yu" },
        "dui_zhen":  { name: "随",   unicode: "䷐", slug: "sui" },
        "gen_xun":   { name: "蛊",   unicode: "䷑", slug: "gu" },
        "kun_dui":   { name: "临",   unicode: "䷒", slug: "lin" },
        "xun_kun":   { name: "观",   unicode: "䷓", slug: "guan" },
        "li_zhen":   { name: "噬嗑", unicode: "䷔", slug: "shi-he" },
        "gen_li":    { name: "贲",   unicode: "䷕", slug: "bi1" },
        "gen_kun":   { name: "剥",   unicode: "䷖", slug: "bo" },
        "kun_zhen":  { name: "复",   unicode: "䷗", slug: "fu" },
        "qian_zhen": { name: "无妄", unicode: "䷘", slug: "wu-wang" },
        "gen_qian":  { name: "大畜", unicode: "䷙", slug: "da-xu" },
        "gen_zhen":  { name: "颐",   unicode: "䷚", slug: "yi" },
        "dui_xun":   { name: "大过", unicode: "䷛", slug: "da-guo" },
        "kan_kan":   { name: "坎",   unicode: "䷜", slug: "kan" },
        "li_li":     { name: "离",   unicode: "䷝", slug: "li" },
        "dui_gen":   { name: "咸",   unicode: "䷞", slug: "xian" },
        "zhen_xun":  { name: "恒",   unicode: "䷟", slug: "heng" },
        "qian_gen":  { name: "遁",   unicode: "䷠", slug: "dun" },
        "zhen_qian": { name: "大壮", unicode: "䷡", slug: "da-zhuang" },
        "li_kun":    { name: "晋",   unicode: "䷢", slug: "jin" },
        "kun_li":    { name: "明夷", unicode: "䷣", slug: "ming-yi" },
        "xun_li":    { name: "家人", unicode: "䷤", slug: "jia-ren" },
        "li_dui":    { name: "睽",   unicode: "䷥", slug: "kui" },
        "kan_gen":   { name: "蹇",   unicode: "䷦", slug: "jian" },
        "zhen_kan":  { name: "解",   unicode: "䷧", slug: "jie" },
        "gen_dui":   { name: "损",   unicode: "䷨", slug: "sun" },
        "xun_zhen":  { name: "益",   unicode: "䷩", slug: "yi1" },
        "dui_qian":  { name: "夬",   unicode: "䷪", slug: "guai" },
        "qian_xun":  { name: "姤",   unicode: "䷫", slug: "gou" },
        "dui_kun":   { name: "萃",   unicode: "䷬", slug: "cui" },
        "kun_xun":   { name: "升",   unicode: "䷭", slug: "sheng" },
        "dui_kan":   { name: "困",   unicode: "䷮", slug: "kun1" },
        "kan_xun":   { name: "井",   unicode: "䷯", slug: "jing" },
        "dui_li":    { name: "革",   unicode: "䷰", slug: "ge" },
        "li_xun":    { name: "鼎",   unicode: "䷱", slug: "ding" },
        "zhen_zhen": { name: "震",   unicode: "䷲", slug: "zhen" },
        "gen_gen":   { name: "艮",   unicode: "䷳", slug: "gen" },
        "xun_gen":   { name: "渐",   unicode: "䷴", slug: "jian1" },
        "zhen_dui":  { name: "归妹", unicode: "䷵", slug: "gui-mei" },
        "zhen_li":   { name: "丰",   unicode: "䷶", slug: "feng" },
        "li_gen":    { name: "旅",   unicode: "䷷", slug: "lv1" },
        "xun_xun":   { name: "巽",   unicode: "䷸", slug: "xun" },
        "dui_dui":   { name: "兑",   unicode: "䷹", slug: "dui" },
        "xun_kan":   { name: "涣",   unicode: "䷺", slug: "huan" },
        "kan_dui":   { name: "节",   unicode: "䷻", slug: "jie1" },
        "xun_dui":   { name: "中孚", unicode: "䷼", slug: "zhong-fu" },
        "zhen_gen":  { name: "小过", unicode: "䷽", slug: "xiao-guo" },
        "kan_li":    { name: "既济", unicode: "䷾", slug: "ji-ji" },
        "li_kan":    { name: "未济", unicode: "䷿", slug: "wei-ji" },
    };

    /* ================================================================
     *  二、计算层
     * ================================================================ */

    function getHexagramByYaoList(yaoList) {
        const lower = trigramMap[yaoList.slice(0, 3).join(',')];
        const upper = trigramMap[yaoList.slice(3, 6).join(',')];
        const base = hexagramMap[`${upper.pinyin}_${lower.pinyin}`];
        if (!base) throw new Error(`未知卦组合: 上${upper.name}下${lower.name}`);
        return { ...base, upper, lower, commonName: upper.xiang + lower.xiang + base.name, yaoList: [...yaoList] };
    }

    const getDongYaoIndex = (num) => { const r = num % 6; return r === 0 ? 5 : r - 1; };
    const getHuGua = (benYao) => getHexagramByYaoList([benYao[1], benYao[2], benYao[3], benYao[2], benYao[3], benYao[4]]);
    const getBianGua = (benYao, dongIndex) => { const yao = [...benYao]; yao[dongIndex] ^= 1; return getHexagramByYaoList(yao); };
    const getTiYong = (ben, dongIndex) => dongIndex < 3 ? { ti: ben.upper, yong: ben.lower } : { ti: ben.lower, yong: ben.upper };
    const yaoPosName = ['初', '二', '三', '四', '五', '上'];
    const dongYaoName = (yaoList, i) => `${yaoList[i] === 1 ? '九' : '六'}${yaoPosName[i]}`;

    /* ================================================================
     *  三、抓取层（fetch 同源）
     * ================================================================ */

    const contentCache = {};

    function unwrapAnchors(root) {
        root.querySelectorAll('a.popup').forEach(a => {
            while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a);
            a.remove();
        });
    }

    function parseHexDocument(html, slug) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = doc.querySelectorAll('#content3 tr');
        console.log(`[易经工具] ${slug} → 响应 ${html.length} 字符, title="${doc.title}", 命中 ${rows.length} 行`);
        if (rows.length === 0) {
            console.error('[易经工具] 响应前 500 字符：', html.slice(0, 500));
            if (/captcha|robot|verify/i.test(html)) throw new Error('被反爬拦截（验证码页）');
            if (html.length < 2000) throw new Error(`返回疑似空壳页（${html.length} 字符）`);
            throw new Error(`页面无 #content3（title="${doc.title}"），结构可能变更`);
        }
        let text = '', matched = 0;
        rows.forEach(row => {
            const label = row.querySelector('td.ctext.opt');
            const content = row.querySelector('td.ctext:not(.opt)');
            if (!content) return;
            const clone = content.cloneNode(true);
            clone.querySelectorAll('.sprite-more, .sprite-parallel, .sprite-discuss, p.ctext:empty, div[id^="comm"]').forEach(el => el.remove());
            unwrapAnchors(clone);
            const labelText = label ? label.textContent.trim().replace(/\s+/g, ' ') : '';
            const contentText = clone.textContent.trim().replace(/[ \t]+/g, ' ');
            if (!contentText) return;
            text += (labelText ? labelText + ' ' : '') + contentText + '\n\n';
            matched++;
        });
        if (matched === 0) {
            console.error('[易经工具] 首行 HTML：', rows[0].outerHTML.slice(0, 300));
            throw new Error('解析到行但提取到 0 条内容');
        }
        return text.trim();
    }

    async function fetchHexContent(slug) {
        if (contentCache[slug]) return contentCache[slug];
        try {
            const url = `/book-of-changes/${slug}/zh`;
            const res = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
            const html = await res.text();
            const text = parseHexDocument(html, slug);
            contentCache[slug] = text;
            return text;
        } catch (e) {
            throw new Error(`抓取失败: ${e.message}`);
        }
    }

    /* ================================================================
     *  四、样式层（高对比度 + 面板高度自适应）
     * ================================================================ */

    GM_addStyle(`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.7); } to { opacity: 1; transform: scale(1); } }
        @keyframes flipYao { 0% { transform: rotateY(0deg); } 50% { transform: rotateY(90deg); } 100% { transform: rotateY(0deg); } }
        @keyframes glow { 0%, 100% { box-shadow: 0 0 12px var(--neon-purple), 0 0 24px var(--neon-purple); } 50% { box-shadow: 0 0 24px var(--neon-purple), 0 0 40px var(--neon-purple); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        @keyframes shimmer { 0% { background-position: -200% center; } 100% { background-position: 200% center; } }
        @keyframes countUp { 0% { opacity: 0; transform: translateY(10px) scale(0.8); } 100% { opacity: 1; transform: translateY(0) scale(1); } }

        :root {
            --neon-purple: #a855f7; --neon-cyan: #22d3ee; --gold: #fbbf24;
            --glass-bg: rgba(15, 23, 42, 0.75); --glass-border: rgba(255, 255, 255, 0.25);
            --text-primary: #ffffff; --text-sub: #d1d5db; --text-muted: #9ca3af;
        }

        body::before {
            content: ''; position: fixed; inset: 0; z-index: -1;
            background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%);
            animation: shimmer 10s linear infinite; background-size: 200% 100%;
        }

        /* ---------- 面板：默认上移 + 高度自适应（内容多时内部滚动，按钮永不截断） ---------- */
        #yj-panel {
            position: fixed; bottom: 100px; right: 24px; width: 340px;
            /* 关键：面板整体高度上限 = 视口减去上下留白，flex 布局让 body 成为唯一可滚动区 */
            max-height: calc(100vh - 120px);
            display: flex; flex-direction: column;
            background: var(--glass-bg); border: 1px solid var(--glass-border);
            border-radius: 20px; backdrop-filter: blur(20px) saturate(180%);
            box-shadow: 0 12px 40px rgba(0,0,0,0.6), 0 0 1px rgba(255,255,255,0.3) inset;
            z-index: 99999; font-family: system-ui, -apple-system, "PingFang SC", sans-serif;
            font-size: 13px; color: var(--text-primary); user-select: none; overflow: hidden;
            animation: fadeInUp 0.5s ease-out;
        }
        #yj-drag {
            flex-shrink: 0; /* 拖拽头固定，不参与滚动 */
            display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;
            background: linear-gradient(135deg, rgba(168,85,247,0.5), rgba(167,139,250,0.5));
            border-bottom: 1px solid rgba(255,255,255,0.2);
            color: var(--text-primary); cursor: move; font-weight: 700; font-size: 15px;
            text-shadow: 0 2px 10px rgba(0,0,0,0.5);
        }
        #yj-drag .ico { font-size: 18px; }
        #yj-drag .yj-collapse { cursor: pointer; font-size: 20px; opacity: 0.9; padding: 2px 6px; transition: all 0.2s; }
        #yj-drag .yj-collapse:hover { opacity: 1; transform: scale(1.15); }
        /* 关键：body 成为弹性滚动容器 */
        #yj-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
        #yj-panel.collapsed #yj-body { display: none; }
        /* 细滚动条，避免深色主题下滚动条刺眼 */
        #yj-body::-webkit-scrollbar { width: 6px; }
        #yj-body::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
        #yj-body::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.5); border-radius: 3px; }
        .yj-tabs {
            display: flex; border-bottom: 1px solid rgba(255,255,255,0.2);
            background: rgba(0,0,0,0.3); position: sticky; top: 0; z-index: 5;
            backdrop-filter: blur(10px);
        }
        .yj-tab {
            flex: 1; text-align: center; padding: 10px 4px; cursor: pointer; font-size: 13px;
            color: var(--text-sub); border-bottom: 2px solid transparent; transition: all 0.25s;
            position: relative; overflow: hidden;
        }
        .yj-tab::before {
            content: ''; position: absolute; inset: 0; background: rgba(168,85,247,0.2);
            transform: translateY(100%); transition: transform 0.3s;
        }
        .yj-tab:hover::before { transform: translateY(0); }
        .yj-tab.active {
            color: var(--gold); border-bottom-color: var(--neon-purple);
            font-weight: 700; text-shadow: 0 0 12px rgba(251,191,36,0.8);
        }
        .yj-pane { padding: 16px; display: none; animation: fadeIn 0.3s; }
        .yj-pane.active { display: block; }
        .yj-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .yj-row label { width: 56px; color: var(--text-sub); font-size: 13px; font-weight: 600; }
        .yj-row select, .yj-row input {
            flex: 1; padding: 9px 11px; border: 1px solid rgba(255,255,255,0.25);
            border-radius: 10px; font-size: 14px;
            background: rgba(0,0,0,0.4); color: var(--text-primary);
            outline: none; transition: all 0.25s;
        }
        .yj-row select:focus, .yj-row input:focus {
            border-color: var(--neon-purple);
            box-shadow: 0 0 16px rgba(168,85,247,0.6);
            background: rgba(0,0,0,0.5);
        }
        .yj-preview {
            display: flex; align-items: center; gap: 16px; padding: 14px;
            background: rgba(168,85,247,0.2); border: 1px solid rgba(168,85,247,0.5);
            border-radius: 12px; margin-bottom: 14px;
            box-shadow: 0 4px 20px rgba(168,85,247,0.3);
            animation: fadeInUp 0.4s 0.1s both;
        }
        .yj-preview .hex-name { font-size: 18px; font-weight: 700; line-height: 1.5; color: var(--gold); }
        .yj-preview .hex-sub { font-size: 11px; color: var(--text-sub); margin-top: 3px; }
        .hex-paint { width: var(--yj-yao-w, 46px); --yj-yao-w: 46px; }
        .hex-yao {
            height: 7px; margin-bottom: 5px; position: relative;
            transition: transform 0.3s, filter 0.3s;
        }
        .hex-yao:last-child { margin-bottom: 0; }
        .hex-yao.highlight { animation: glow 1s ease-in-out; transform: scale(1.08); }
        .hex-yao.flip { animation: flipYao 0.6s ease-in-out; }
        .yao-yang {
            width: 100%; height: 100%; background: linear-gradient(90deg, #e0d5ff, #c4b5fd);
            border-radius: 2px; box-shadow: 0 2px 10px rgba(196,181,253,0.6);
        }
        .yao-yin-left, .yao-yin-right {
            position: absolute; width: 44%; height: 100%;
            background: linear-gradient(90deg, #e0d5ff, #c4b5fd);
            border-radius: 2px; box-shadow: 0 2px 10px rgba(196,181,253,0.6);
        }
        .yao-yin-left { left: 0; } .yao-yin-right { right: 0; }
        .yj-checks {
            display: flex; gap: 10px; margin-bottom: 14px; font-size: 13px;
            justify-content: center; flex-wrap: wrap;
        }
        .yj-checks label {
            display: flex; align-items: center; gap: 5px; cursor: pointer;
            color: var(--text-sub); transition: color 0.2s; font-weight: 500;
        }
        .yj-checks label:hover { color: var(--text-primary); }
        .yj-btn {
            width: 100%; padding: 12px; border: none; border-radius: 12px;
            cursor: pointer; font-size: 14px; font-weight: 700; transition: all 0.3s;
            background: linear-gradient(135deg, #8b5cf6, #a78bfa);
            color: #fff; box-shadow: 0 4px 20px rgba(139,92,246,0.5);
            position: relative; overflow: hidden;
        }
        .yj-btn::before {
            content: ''; position: absolute; inset: 0;
            background: linear-gradient(135deg, transparent, rgba(255,255,255,0.3), transparent);
            transform: translateX(-100%); transition: transform 0.6s;
        }
        .yj-btn:hover:not(:disabled)::before { transform: translateX(100%); }
        .yj-btn:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 6px 28px rgba(139,92,246,0.7);
        }
        .yj-btn:active:not(:disabled) { transform: translateY(0); }
        .yj-btn:disabled {
            background: rgba(107,114,128,0.5); cursor: not-allowed;
            box-shadow: none; color: var(--text-muted);
        }
        .yj-status {
            margin-top: 12px; text-align: center; font-size: 13px; min-height: 18px;
            color: var(--text-sub); animation: fadeIn 0.3s; font-weight: 600;
        }
        .yj-status.ok { color: #6ee7b7; text-shadow: 0 0 10px rgba(110,231,183,0.8); }
        .yj-status.warn { color: #fbbf24; text-shadow: 0 0 10px rgba(251,191,36,0.8); }
        .yj-status.err { color: #f87171; text-shadow: 0 0 10px rgba(248,113,113,0.8); }
        .yj-cards { display: flex; gap: 10px; margin-bottom: 14px; }
        .gua-card {
            flex: 1; padding: 12px 8px 10px; border: 2px solid rgba(255,255,255,0.2);
            border-radius: 12px; text-align: center; cursor: pointer; transition: all 0.3s;
            background: rgba(0,0,0,0.3); animation: scaleIn 0.4s ease-out;
        }
        .gua-card:nth-child(1) { animation-delay: 0s; }
        .gua-card:nth-child(2) { animation-delay: 0.1s; }
        .gua-card:nth-child(3) { animation-delay: 0.2s; }
        .gua-card:hover {
            border-color: rgba(168,85,247,0.7);
            background: rgba(168,85,247,0.15);
            transform: translateY(-3px);
            box-shadow: 0 8px 28px rgba(139,92,246,0.5);
        }
        .gua-card.active {
            border-color: var(--neon-purple);
            background: rgba(168,85,247,0.25);
            box-shadow: 0 0 24px rgba(168,85,247,0.7), 0 0 2px rgba(168,85,247,0.9) inset;
        }
        .gua-card .card-label { font-size: 11px; color: var(--text-muted); }
        .gua-card .card-name { font-size: 14px; font-weight: 700; margin: 5px 0 3px; color: var(--text-primary); }
        .gua-card .hex-paint { --yj-yao-w: 36px; margin: 5px auto 0; }

        /* ---------- 全屏推演模态 ---------- */
        #yj-derive-modal {
            position: fixed; inset: 0; z-index: 100001;
            background: rgba(15,23,42,0.98); backdrop-filter: blur(12px);
            display: none; flex-direction: column; overflow-y: auto;
            animation: fadeIn 0.4s;
        }
        #yj-derive-modal.show { display: flex; }
        .derive-header {
            position: sticky; top: 0; z-index: 10;
            padding: 20px 32px; background: rgba(30,27,75,0.95); border-bottom: 2px solid rgba(168,85,247,0.5);
            backdrop-filter: blur(20px); box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        }
        .derive-header h2 {
            font-size: 24px; font-weight: 800; color: var(--gold); margin: 0;
            text-shadow: 0 0 20px rgba(251,191,36,0.6);
        }
        .derive-progress {
            margin-top: 12px; height: 6px; background: rgba(255,255,255,0.1);
            border-radius: 3px; overflow: hidden;
        }
        .derive-progress-bar {
            height: 100%; background: linear-gradient(90deg, var(--neon-purple), var(--neon-cyan));
            border-radius: 3px; width: 0%; transition: width 0.5s ease-out;
            box-shadow: 0 0 12px var(--neon-purple);
        }
        .derive-close {
            position: absolute; top: 20px; right: 32px; font-size: 32px; cursor: pointer;
            color: var(--text-sub); transition: all 0.2s;
        }
        .derive-close:hover { color: var(--text-primary); transform: scale(1.2); }
        .derive-body {
            padding: 40px 32px 80px; max-width: 1200px; margin: 0 auto; width: 100%;
        }
        .derive-step {
            margin-bottom: 40px; padding: 24px; border-radius: 16px;
            background: rgba(0,0,0,0.4); border: 2px solid rgba(34,211,238,0.3);
            opacity: 0; transform: translateY(30px);
            transition: opacity 0.5s, transform 0.5s;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }
        .derive-step.show { opacity: 1; transform: translateY(0); }
        .derive-step-title {
            font-size: 20px; font-weight: 700; color: var(--neon-cyan);
            margin-bottom: 16px; display: flex; align-items: center; gap: 12px;
            text-shadow: 0 0 12px rgba(34,211,238,0.6);
        }
        .derive-step-title::before {
            content: '◈'; font-size: 24px;
            animation: pulse 2s infinite;
        }
        .derive-step-content {
            font-size: 16px; line-height: 2; color: var(--text-primary);
        }
        .derive-math {
            display: inline-block; padding: 6px 14px; margin: 0 6px;
            background: rgba(168,85,247,0.3); border: 2px solid rgba(168,85,247,0.6);
            border-radius: 8px; font-family: 'Courier New', monospace; font-weight: 700;
            color: #e0d5ff; animation: countUp 0.5s ease-out;
            font-size: 18px;
        }
        .derive-hexes {
            display: flex; gap: 24px; align-items: center; justify-content: center;
            margin-top: 20px; flex-wrap: wrap;
        }
        .derive-hex-item { text-align: center; opacity: 0; animation: scaleIn 0.6s forwards; }
        .derive-hex-item .hex-paint { --yj-yao-w: 50px; margin: 0 auto 10px; }
        .derive-hex-item .hex-label { font-size: 13px; color: var(--text-muted); font-weight: 600; }
        .derive-hex-item .hex-name { font-size: 16px; font-weight: 700; margin-top: 6px; color: var(--gold); }
        .derive-arrow {
            font-size: 32px; color: var(--neon-cyan); opacity: 0;
            animation: fadeIn 0.5s 0.3s forwards, pulse 2s 0.5s infinite;
        }
        .derive-footer {
            position: sticky; bottom: 0; padding: 20px 32px;
            background: rgba(30,27,75,0.95); border-top: 2px solid rgba(168,85,247,0.5);
            backdrop-filter: blur(20px); text-align: center;
            box-shadow: 0 -4px 20px rgba(0,0,0,0.5);
        }
        .derive-footer .yj-btn {
            max-width: 300px; margin: 0 auto;
            background: linear-gradient(135deg, #22d3ee, #06b6d4);
        }
        .derive-footer .yj-btn:hover:not(:disabled) {
            box-shadow: 0 6px 28px rgba(34,211,238,0.7);
        }

        /* ---------- 内容模态 ---------- */
        #yj-modal {
            position: fixed; inset: 0; background: rgba(15,23,42,0.92);
            z-index: 100000; display: none; align-items: center; justify-content: center;
            backdrop-filter: blur(10px); animation: fadeIn 0.3s;
        }
        #yj-modal.show { display: flex; }
        .yj-modal-content {
            width: 680px; max-width: 92vw; max-height: 84vh;
            background: rgba(30,27,75,0.98); border: 2px solid rgba(255,255,255,0.25);
            border-radius: 20px; backdrop-filter: blur(30px); box-shadow: 0 20px 60px rgba(0,0,0,0.7);
            display: flex; flex-direction: column; overflow: hidden;
            animation: scaleIn 0.4s ease-out;
        }
        .yj-modal-header {
            padding: 18px 24px; border-bottom: 2px solid rgba(255,255,255,0.2);
            font-size: 18px; font-weight: 700; display: flex; justify-content: space-between;
            align-items: center; background: rgba(168,85,247,0.25);
            color: var(--gold);
        }
        .yj-modal-close {
            cursor: pointer; font-size: 28px; line-height: 1; color: var(--text-sub);
            padding: 0 6px; transition: all 0.2s;
        }
        .yj-modal-close:hover { color: var(--text-primary); transform: scale(1.2); }
        .yj-modal-body {
            padding: 24px 28px; overflow-y: auto; line-height: 2.2; font-size: 16px;
            white-space: pre-wrap; user-select: text; color: var(--text-primary);
        }
        .yj-modal-footer {
            padding: 16px 24px; border-top: 2px solid rgba(255,255,255,0.2);
            display: flex; justify-content: space-between; align-items: center; font-size: 14px;
            background: rgba(0,0,0,0.3);
        }
        .yj-modal-footer .foot-msg-ok { color: #6ee7b7; text-shadow: 0 0 10px rgba(110,231,183,0.8); font-weight: 700; }
        .yj-modal-footer .foot-msg-warn { color: #fbbf24; text-shadow: 0 0 10px rgba(251,191,36,0.8); font-weight: 700; }
        .yj-modal-footer .foot-msg-err { color: #f87171; text-shadow: 0 0 10px rgba(248,113,113,0.8); font-weight: 700; }
        .yj-modal-copy {
            background: rgba(168,85,247,0.4); border: 2px solid rgba(168,85,247,0.6);
            border-radius: 8px; padding: 7px 18px; font-size: 13px; cursor: pointer;
            color: #e0d5ff; transition: all 0.2s; font-weight: 700;
        }
        .yj-modal-copy:hover {
            background: rgba(168,85,247,0.6);
            box-shadow: 0 0 20px rgba(168,85,247,0.8);
        }
    `);

    /* ================================================================
     *  五、渲染工具
     * ================================================================ */

    function renderHexPaint(yaoList, extraClass = '') {
    const c = document.createElement('div');
    c.className = 'hex-paint ' + extraClass;
    // 按实际长度渲染：经卦 3 爻、重卦 6 爻通用
    for (let i = yaoList.length - 1; i >= 0; i--) {
        const yao = document.createElement('div');
        yao.className = 'hex-yao';
        yao.dataset.index = i;
        yao.innerHTML = yaoList[i] === 1
            ? '<div class="yao-yang"></div>'
            : '<div class="yao-yin-left"></div><div class="yao-yin-right"></div>';
        c.appendChild(yao);
    }
    return c;
}

    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    /* ================================================================
     *  六、全屏推演动画控制
     * ================================================================ */

    async function showDerivation(n1, n2, n3) {
        const modal = document.getElementById('yj-derive-modal');
        const body = modal.querySelector('.derive-body');
        const progressBar = modal.querySelector('.derive-progress-bar');
        body.innerHTML = '';
        progressBar.style.width = '0%';
        modal.classList.add('show');

        const addStep = (title, content) => {
            const step = document.createElement('div');
            step.className = 'derive-step';
            step.innerHTML = `<div class="derive-step-title">${title}</div><div class="derive-step-content">${content}</div>`;
            body.appendChild(step);
            setTimeout(() => step.classList.add('show'), 50);
            return step;
        };

        // 步骤1：模运算
        await delay(300);
        progressBar.style.width = '16%';
        const r1 = n1 % 8, r2 = n2 % 8, r3 = n3 % 6;
        const triByNum = (n) => {
            const r = n % 8;
            return Object.values(trigramMap).find(t => t.num === (r === 0 ? 0 : r));
        };
        const upper = triByNum(n1), lower = triByNum(n2);
        addStep('① 起卦：模运算取经卦', `
            第一数 <span class="derive-math">${n1}</span> ÷ 8 余 <span class="derive-math">${r1 === 0 ? 8 : r1}</span> → 上卦 <strong>${upper.name}（${upper.xiang}）</strong><br>
            第二数 <span class="derive-math">${n2}</span> ÷ 8 余 <span class="derive-math">${r2 === 0 ? 8 : r2}</span> → 下卦 <strong>${lower.name}（${lower.xiang}）</strong><br>
            第三数 <span class="derive-math">${n3}</span> ÷ 6 余 <span class="derive-math">${r3 === 0 ? 6 : r3}</span> → 动爻位
        `);

        // 步骤2：组合本卦
        await delay(800);
        progressBar.style.width = '33%';
        const benYao = [...lower.yao, ...upper.yao];
        const ben = getHexagramByYaoList(benYao);
        const dongIndex = getDongYaoIndex(n3);
        const step2 = addStep('② 组合本卦', `上${upper.name}下${lower.name} 得本卦 <strong style="color:var(--gold)">${ben.unicode} ${ben.commonName}</strong>`);
        await delay(500);
        const hexCon = document.createElement('div');
        hexCon.className = 'derive-hexes';
        hexCon.innerHTML = `
            <div class="derive-hex-item" style="animation-delay:0s">
                ${renderHexPaint(lower.yao).outerHTML}
                <div class="hex-label">下卦 ${lower.name}</div>
            </div>
            <div class="derive-arrow">+</div>
            <div class="derive-hex-item" style="animation-delay:0.2s">
                ${renderHexPaint(upper.yao).outerHTML}
                <div class="hex-label">上卦 ${upper.name}</div>
            </div>
            <div class="derive-arrow">→</div>
            <div class="derive-hex-item" style="animation-delay:0.4s">
                ${renderHexPaint(benYao).outerHTML}
                <div class="hex-name">${ben.unicode} ${ben.commonName}</div>
            </div>
        `;
        step2.querySelector('.derive-step-content').appendChild(hexCon);

        // 步骤3：标记动爻
        await delay(1400);
        progressBar.style.width = '50%';
        const dy = dongYaoName(benYao, dongIndex);
        addStep('③ 标记动爻', `动爻为 <strong style="color:var(--gold)">${dy}</strong>（第 ${dongIndex + 1} 爻，从下往上数）`);
        await delay(400);
        const benPaint = step2.querySelector('.derive-hex-item:last-child .hex-paint');
        const yaoEls = benPaint.querySelectorAll('.hex-yao');
        yaoEls[5 - dongIndex].classList.add('highlight');

        // 步骤4：变卦推演
        await delay(1000);
        progressBar.style.width = '66%';
        const bian = getBianGua(benYao, dongIndex);
        const step4 = addStep('④ 变卦推演', `动爻阴阳互变 → 变卦 <strong style="color:var(--gold)">${bian.unicode} ${bian.commonName}</strong>`);
        await delay(500);
        const bianCon = document.createElement('div');
        bianCon.className = 'derive-hexes';
        const benPaint2 = renderHexPaint(benYao);
        benPaint2.querySelectorAll('.hex-yao')[5 - dongIndex].classList.add('flip');
        const bianPaint = renderHexPaint(bian.yaoList);
        bianPaint.querySelectorAll('.hex-yao')[5 - dongIndex].classList.add('flip');
        bianCon.innerHTML = `
            <div class="derive-hex-item" style="animation-delay:0s">
                ${benPaint2.outerHTML}
                <div class="hex-label">本卦</div>
            </div>
            <div class="derive-arrow">🔄</div>
            <div class="derive-hex-item" style="animation-delay:0.4s">
                ${bianPaint.outerHTML}
                <div class="hex-name">${bian.unicode} ${bian.commonName}</div>
            </div>
        `;
        step4.querySelector('.derive-step-content').appendChild(bianCon);

        // 步骤5：互卦推演
        await delay(1400);
        progressBar.style.width = '83%';
        const hu = getHuGua(benYao);
        const step5 = addStep('⑤ 互卦推演', `取 2/3/4 爻为互卦下卦，3/4/5 爻为互卦上卦 → 互卦 <strong style="color:var(--gold)">${hu.unicode} ${hu.commonName}</strong>`);
        await delay(500);
        const huCon = document.createElement('div');
        huCon.className = 'derive-hexes';
        const benPaint3 = renderHexPaint(benYao);
        [0, 5].forEach(i => benPaint3.querySelectorAll('.hex-yao')[i].style.opacity = '0.3');
        const huPaint = renderHexPaint(hu.yaoList);
        huCon.innerHTML = `
            <div class="derive-hex-item" style="animation-delay:0s">
                ${benPaint3.outerHTML}
                <div class="hex-label">本卦（取中四爻）</div>
            </div>
            <div class="derive-arrow">⇝</div>
            <div class="derive-hex-item" style="animation-delay:0.4s">
                ${huPaint.outerHTML}
                <div class="hex-name">${hu.unicode} ${hu.commonName}</div>
            </div>
        `;
        step5.querySelector('.derive-step-content').appendChild(huCon);

        // 步骤6：体用分析
        await delay(1400);
        progressBar.style.width = '100%';
        const { ti, yong } = getTiYong(ben, dongIndex);
        addStep('⑥ 体用分析', `
            动爻在<strong>${dongIndex < 3 ? '下卦（内卦）' : '上卦（外卦）'}</strong>，则 <strong style="color:var(--gold)">${dongIndex < 3 ? '上卦为体' : '下卦为体'}</strong><br>
            <span style="font-size:18px">体卦：<strong style="color:var(--neon-cyan)">${ti.name}</strong>　用卦：<strong style="color:var(--neon-purple)">${yong.name}</strong></span>
        `);

        await delay(800);
        return { ben, bian, hu, dongIndex };
    }

    /* ================================================================
     *  七、DOM 构建
     * ================================================================ */

    const panel = document.createElement('div');
    panel.id = 'yj-panel';
    panel.innerHTML = `
        <div id="yj-drag"><span class="ico">☰</span><span>易经推演工具</span><span class="yj-collapse">−</span></div>
        <div id="yj-body">
            <div class="yj-tabs">
                <div class="yj-tab active" data-tab="manual">手动选卦</div>
                <div class="yj-tab" data-tab="pai">梅花排卦</div>
            </div>
            <div class="yj-pane active" data-pane="manual">
                <div class="yj-row"><label>上卦</label><select id="yj-upper"></select></div>
                <div class="yj-row"><label>下卦</label><select id="yj-lower"></select></div>
                <div class="yj-preview" id="yj-preview">
                    <div class="paint-wrap"></div>
                    <div><div class="hex-name"></div><div class="hex-sub"></div></div>
                </div>
                <div class="yj-checks">
                    <label><input type="checkbox" id="yj-mc-ben" checked disabled> 本卦</label>
                    <label><input type="checkbox" id="yj-mc-hu"> 互卦</label>
                    <label><input type="checkbox" id="yj-mc-bian"> 变卦</label>
                </div>
                <div class="yj-row" id="yj-dong-row" style="display:none"><label>动爻数</label><input type="number" id="yj-dong-num" min="1" placeholder="除6定动爻"></div>
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
        </div>`;
    document.body.appendChild(panel);

    const deriveModal = document.createElement('div');
    deriveModal.id = 'yj-derive-modal';
    deriveModal.innerHTML = `
        <div class="derive-header">
            <h2>🔮 梅花易数推演过程</h2>
            <div class="derive-progress"><div class="derive-progress-bar"></div></div>
            <div class="derive-close">×</div>
        </div>
        <div class="derive-body"></div>
        <div class="derive-footer">
            <button class="yj-btn" id="derive-done">✓ 完成推演，查看结果</button>
        </div>`;
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

    const $ = (sel) => document.querySelector(sel);

    /* ================================================================
     *  八、交互逻辑
     * ================================================================ */

    let modalLastText = '';
    const modalUI = {
        open(title) {
            $('#yj-modal-title').textContent = title;
            $('#yj-modal-body').textContent = '正在抓取内容，请稍候…';
            $('#yj-modal-msg').textContent = '';
            $('#yj-modal-msg').className = '';
            $('#yj-modal-copy').style.display = 'none';
            modalLastText = '';
            modal.classList.add('show');
        },
        showText(text, msg, type = 'ok') {
            modalLastText = text;
            $('#yj-modal-body').textContent = text;
            $('#yj-modal-msg').textContent = msg;
            $('#yj-modal-msg').className = `foot-msg-${type}`;
            $('#yj-modal-copy').style.display = 'inline-block';
        },
        showError(msg) {
            $('#yj-modal-body').textContent = `抓取失败：${msg}\n\n排查提示：\n1. 打开控制台（F12）查看 [易经工具] 日志\n2. 若为反爬拦截，请刷新页面重试\n3. 若提示结构变更，请反馈`;
            $('#yj-modal-msg').textContent = '抓取失败';
            $('#yj-modal-msg').className = 'foot-msg-err';
            $('#yj-modal-copy').style.display = 'none';
        },
        close() { modal.classList.remove('show'); },
    };
    modal.querySelector('.yj-modal-close').addEventListener('click', modalUI.close);
    modal.addEventListener('click', e => { if (e.target === modal) modalUI.close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { modalUI.close(); deriveModal.classList.remove('show'); } });
    $('#yj-modal-copy').addEventListener('click', () => {
        if (modalLastText) {
            GM_setClipboard(modalLastText, 'text');
            $('#yj-modal-msg').textContent = '✔ 已复制到剪贴板';
            $('#yj-modal-msg').className = 'foot-msg-ok';
        }
    });

    deriveModal.querySelector('.derive-close').addEventListener('click', () => deriveModal.classList.remove('show'));
    $('#derive-done').addEventListener('click', () => deriveModal.classList.remove('show'));

    const setStatus = (id, msg, type = '') => {
        const el = $(id); el.textContent = msg; el.className = `yj-status ${type}`;
    };

    // ---------- 拖拽 + 折叠 + 位置记忆（含视口钳制） ----------
    // ⚠ 键名升级为 v2：使旧版保存的低位坐标失效，让新的 bottom:100px 默认值生效
    const POS_KEY = 'yj-panel-pos-v2';
    const savedPos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (savedPos && savedPos.top && savedPos.left) {
        // 校验旧坐标在当前视口内，且面板底边不超出屏幕；越界则放弃恢复，回到 CSS 默认 bottom:100px
        const panelH = panel.offsetHeight || 400;
        const top = parseFloat(savedPos.top), left = parseFloat(savedPos.left);
        if (top >= 0 && top + panelH <= window.innerHeight && left >= 0 && left + 360 <= window.innerWidth) {
            Object.assign(panel.style, savedPos);
        }
    }
    let dragging = false, ox, oy;
    $('#yj-drag').addEventListener('mousedown', e => {
        if (e.target.classList.contains('yj-collapse')) return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        // 钳制在视口内，防止拖出屏幕找不回
        const maxLeft = window.innerWidth - 60, maxTop = window.innerHeight - 60;
        const left = Math.min(Math.max(e.clientX - ox, 0), maxLeft);
        const top = Math.min(Math.max(e.clientY - oy, 0), maxTop);
        Object.assign(panel.style, { left: left + 'px', top: top + 'px' });
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        localStorage.setItem(POS_KEY, JSON.stringify({ left: panel.style.left, top: panel.style.top }));
    });
    panel.querySelector('.yj-collapse').addEventListener('click', () => {
        panel.classList.toggle('collapsed');
        panel.querySelector('.yj-collapse').textContent = panel.classList.contains('collapsed') ? '☐' : '−';
    });

    // ---------- Tab 切换 ----------
    document.querySelectorAll('.yj-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.yj-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.yj-pane').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            $(`.yj-pane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
            // 切换后内容高度变化，若面板溢出自动滚回顶部
            $('#yj-body').scrollTop = 0;
        });
    });

    /* ---------------- 手动选卦 ---------------- */
    const upperSel = $('#yj-upper'), lowerSel = $('#yj-lower');
    const triOrder = ['qian', 'dui', 'li', 'zhen', 'xun', 'kan', 'gen', 'kun'];
    triOrder.forEach(py => {
        const t = trigramByPinyin[py];
        upperSel.add(new Option(`${t.name}（${t.xiang}）`, py));
        lowerSel.add(new Option(`${t.name}（${t.xiang}）`, py));
    });

    function buildFromTrigrams(upPy, lowPy) {
        const yao = [...trigramByPinyin[lowPy].yao, ...trigramByPinyin[upPy].yao];
        return getHexagramByYaoList(yao);
    }

    let manualHex = null;
    function updateManualPreview() {
        manualHex = buildFromTrigrams(upperSel.value, lowerSel.value);
        const wrap = $('#yj-preview .paint-wrap');
        wrap.innerHTML = ''; wrap.appendChild(renderHexPaint(manualHex.yaoList));
        $('#yj-preview .hex-name').textContent = `${manualHex.unicode} ${manualHex.commonName}`;
        $('#yj-preview .hex-sub').textContent = `上${manualHex.upper.name}下${manualHex.lower.name}`;
        $('#yj-dong-row').style.display = $('#yj-mc-bian').checked ? 'flex' : 'none';
    }
    upperSel.addEventListener('change', updateManualPreview);
    lowerSel.addEventListener('change', updateManualPreview);
    $('#yj-mc-bian').addEventListener('change', updateManualPreview);
    updateManualPreview();

    $('#yj-manual-copy').addEventListener('click', async () => {
        const tasks = [{ tag: '本卦', data: manualHex }];
        if ($('#yj-mc-hu').checked) tasks.push({ tag: '互卦', data: getHuGua(manualHex.yaoList) });
        if ($('#yj-mc-bian').checked) {
            const dn = parseInt($('#yj-dong-num').value, 10);
            if (isNaN(dn) || dn < 1) {
                setStatus('#yj-manual-status', '勾选变卦时需填写动爻数', 'err');
                $('#yj-dong-num').focus();
                return;
            }
            tasks.push({ tag: '变卦', data: getBianGua(manualHex.yaoList, getDongYaoIndex(dn)) });
        }
        await runBatchCopy(tasks, '#yj-manual-status', $('#yj-manual-copy'), null);
    });

    /* ---------------- 梅花排卦 ---------------- */
    let paiResult = null;

    $('#yj-pai-btn').addEventListener('click', async () => {
        const n1 = parseInt($('#yj-n1').value, 10),
              n2 = parseInt($('#yj-n2').value, 10),
              n3 = parseInt($('#yj-n3').value, 10);
        if ([n1, n2, n3].some(n => isNaN(n) || n < 1)) {
            setStatus('#yj-pai-status', '请输入三个正整数', 'err');
            return;
        }

        $('#yj-pai-btn').disabled = true;
        setStatus('#yj-pai-status', '正在推演…');

        paiResult = await showDerivation(n1, n2, n3);

        const { ben, bian, hu, dongIndex } = paiResult;
        const dy = dongYaoName(ben.yaoList, dongIndex);

        $('#yj-cards').style.display = 'flex';
        $('#yj-pai-checks').style.display = 'flex';
        $('#yj-pai-copy').style.display = 'block';

        const fill = (type, gua, label) => {
            const card = $(`.gua-card[data-type="${type}"]`);
            const paint = card.querySelector('.paint');
            paint.innerHTML = ''; paint.appendChild(renderHexPaint(gua.yaoList));
            card.querySelector('.card-name').textContent = `${gua.unicode} ${gua.commonName}`;
            card.querySelector('.card-label').textContent = label;
        };
        fill('ben', ben, `本卦 · ${dy}动`);
        fill('bian', bian, '变卦');
        fill('hu', hu, '互卦');

        document.querySelectorAll('.gua-card').forEach(c => c.classList.remove('active'));
        $('.gua-card[data-type="ben"]').classList.add('active');
        setStatus('#yj-pai-status', `推演完成：动爻为${dy}`, 'ok');
        $('#yj-pai-btn').disabled = false;
        // 排卦结果填充后，面板内容变高；滚到底部让复制按钮立即可见
        await delay(100);
        $('#yj-body').scrollTop = $('#yj-body').scrollHeight;
    });

    document.querySelectorAll('.gua-card').forEach(card => {
        card.addEventListener('click', async () => {
            if (!paiResult) return;
            document.querySelectorAll('.gua-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            const gua = paiResult[card.dataset.type];
            const label = card.querySelector('.card-label').textContent;
            modalUI.open(`${gua.unicode} ${gua.commonName}（${label}）`);
            try {
                modalUI.showText(await fetchHexContent(gua.slug), '内容加载完成', 'ok');
            } catch (e) {
                modalUI.showError(e.message);
            }
        });
    });

    $('#yj-pai-copy').addEventListener('click', async () => {
        if (!paiResult) return;
        const tasks = [];
        if ($('#yj-pc-ben').checked)   tasks.push({ tag: '本卦', data: paiResult.ben });
        if ($('#yj-pc-hu').checked)    tasks.push({ tag: '互卦', data: paiResult.hu });
        if ($('#yj-pc-bian').checked)  tasks.push({ tag: '变卦', data: paiResult.bian });
        if (!tasks.length) {
            setStatus('#yj-pai-status', '请至少勾选一个卦', 'err');
            return;
        }
        await runBatchCopy(tasks, '#yj-pai-status', $('#yj-pai-copy'), paiResult);
    });

    /* ---------------- 批量抓取复制 ---------------- */
    async function runBatchCopy(tasks, statusSel, btn, pai) {
        btn.disabled = true;
        const btnText = btn.textContent;
        btn.textContent = '抓取中…';
        setStatus(statusSel, '正在批量抓取…');

        let header = '';
        if (pai) {
            const { ti, yong } = getTiYong(pai.ben, pai.dongIndex);
            const dy = dongYaoName(pai.ben.yaoList, pai.dongIndex);
            header = `
> 本卦：${pai.ben.commonName}（上${pai.ben.upper.name}下${pai.ben.lower.name}），${dy}爻动
> 体卦：${ti.name}　用卦：${yong.name}
> 变卦：${pai.bian.commonName}
> 互卦：上互${pai.hu.upper.name}、下互${pai.hu.lower.name}

${'='.repeat(30)}
`;
        }

        modalUI.open(`正在复制选中的 ${tasks.length} 个卦内容`);
        let output = '', okCount = 0;
        const errors = [];

        for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            $('#yj-modal-body').textContent = `正在抓取：${t.tag} ${t.data.commonName}（${i + 1}/${tasks.length}）`;
            try {
                const text = await fetchHexContent(t.data.slug);
                output += `${t.tag}：${t.data.unicode} ${t.data.commonName}\n${text}`;
                if (i !== tasks.length - 1) output += '\n\n' + '='.repeat(30) + '\n\n';
                okCount++;
            } catch (e) {
                errors.push(`${t.tag} ${t.data.commonName}：${e.message}`);
            }
        }

        btn.disabled = false;
        btn.textContent = btnText;

        if (okCount > 0) {
            const full = (header + output).trim();
            GM_setClipboard(full, 'text');
            const msg = `✔ 已复制 ${okCount}/${tasks.length} 个卦的内容`;
            modalUI.showText(full, errors.length ? msg + `（${errors.length} 个失败）` : msg, errors.length ? 'warn' : 'ok');
            if (errors.length) {
                console.error('[易经工具] 失败明细：', errors);
                setStatus(statusSel, `部分成功（${errors.length} 个失败）`, 'warn');
            } else {
                setStatus(statusSel, '全部复制成功', 'ok');
            }
        } else {
            modalUI.showError(errors[0] || '未知错误');
            setStatus(statusSel, '抓取失败（原因见弹窗）', 'err');
        }
    }

})();
