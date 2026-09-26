// ==UserScript==
// @name         arXiv 检索缓存区 & 批量下载器
// @namespace    arxiv-cache-downloader
// @version      1.3
// @description  arXiv 检索结果缓存区：跨检索累积、实时查看、可编辑 LLM 留言、纯文本/XML格式切换、生成 aria2 下载脚本
// @match        https://arxiv.org/search/*
// @grant        GM_setClipboard
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CACHE_KEY   = 'arxiv_paper_cache';
  const MSG_KEY     = 'arxiv_llm_message';
  const FORMAT_KEY  = 'arxiv_format_mode';

  const DEFAULT_MSG =
    "在你输出的最后，使用Python的列表格式，将所有建议下载（不要超过35篇）的文章的序号（非Arxiv编号）输出出来，方便我直接复制到我的下载脚本里:";

  // ---------- 数据层 ----------
  const loadCache = () => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || []; }
    catch (e) { return []; }
  };
  const saveCache = (cache) => {
    cache.forEach((p, i) => (p.index = i + 1));
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    return cache;
  };

  const loadMsg = () => localStorage.getItem(MSG_KEY) ?? DEFAULT_MSG;
  const saveMsg = (m) => localStorage.setItem(MSG_KEY, m);

  const loadFormatMode = () => localStorage.getItem(FORMAT_KEY) || 'text';
  const saveFormatMode = (m) => localStorage.setItem(FORMAT_KEY, m);

  const clean = (el) => {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('.MathJax, .MathJax_Preview, a').forEach(e => e.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  };

  const escapeXml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const addCurrentPage = () => {
    const cache = loadCache();
    const existing = new Set(cache.map(p => p.arxivId));
    let added = 0, skipped = 0;

    document.querySelectorAll('li.arxiv-result').forEach((li) => {
      const absLink = li.querySelector('p.list-title a[href*="/abs/"]');
      const arxivId = absLink ? (absLink.href.match(/\/abs\/([^\s?#]+)/)?.[1] || '') : '';
      if (!arxivId) return;
      if (existing.has(arxivId)) { skipped++; return; }

      const pdfLink = li.querySelector('p.list-title a[href*="/pdf/"]');
      const pdfUrl = pdfLink ? pdfLink.href : `https://arxiv.org/pdf/${arxivId}`;

      const title = clean(li.querySelector('p.title'));
      const full = li.querySelector('.abstract-full');
      const short = li.querySelector('.abstract-short');
      const abstract = clean(full || short).replace(/^Abstract\s*:\s*/i, '');

      cache.push({ arxivId, title, abstract, pdfUrl });
      existing.add(arxivId);
      added++;
    });

    saveCache(cache);
    return { added, skipped, total: cache.length };
  };

  // ---------- 格式化组装 ----------
  const buildPlainText = (cache, prefix) => {
    const blocks = cache.map(p =>
`[${p.index}]
Title: ${p.title}
arXiv ID: ${p.arxivId}
Abstract: ${p.abstract}`);
    return `${prefix}\n\n---\n` + blocks.join('\n\n');
  };

  const buildXmlText = (cache, prefix) => {
    const blocks = cache.map(p =>
`<document id="${p.index}">
  <title>${escapeXml(p.title)}</title>
  <arxiv_id>${escapeXml(p.arxivId)}</arxiv_id>
  <abstract>${escapeXml(p.abstract)}</abstract>
</document>`);
    return `${prefix}\n\n---\n` + blocks.join('\n');
  };

  const buildLLMText = () => {
    const cache = loadCache();
    const prefix = loadMsg().trim();
    const mode = loadFormatMode();
    return mode === 'xml' ? buildXmlText(cache, prefix) : buildPlainText(cache, prefix);
  };

  // 生成 aria2 下载脚本（纯 ASCII、CRLF、无 BOM、goto 结构）
  const generateBat = (picks, concurrent, split) => {
    const cache = loadCache();
    if (!cache.length) return { err: '缓存区为空' };

    const uniq = [...new Set(picks)];
    const selected = uniq.map(i => cache.find(p => p.index === i)).filter(Boolean);
    if (!selected.length) return { err: '没有匹配到任何序号' };
    const missing = uniq.filter(i => !selected.some(p => p.index === i));

    const cmdEscape = (s) => String(s)
      .replace(/\^/g, '^^').replace(/&/g, '^&').replace(/\|/g, '^|')
      .replace(/</g, '^<').replace(/>/g, '^>');

    const listLines = selected.map(p => {
      const id = String(p.arxivId || 'unknown').replace(/[^\w.-]/g, '_');
      const filename = `${String(p.index).padStart(3, '0')}_${id}.pdf`;
      const pdfUrl = cmdEscape(p.pdfUrl || `https://arxiv.org/pdf/${p.arxivId}`);
      return `echo(${pdfUrl}\r\necho(  out=${filename}`;
    }).join('\r\n');

    const batLines = [
      '@echo off', 'setlocal', '',
      'where aria2c >nul 2>nul',
      'if errorlevel 1 goto :no_aria2', '',
      'set "DOWNLOAD_DIR=arxiv_downloads"',
      'set "LIST_FILE=%TEMP%\\arxiv_aria2_list.txt"', '',
      'if not exist "%DOWNLOAD_DIR%" mkdir "%DOWNLOAD_DIR%"', '',
      `echo Downloading ${selected.length} paper(s)...`,
      `echo Concurrent files: ${concurrent}`,
      'echo.', '',
      '> "%LIST_FILE%" (', listLines, ')', '',
      `aria2c.exe --continue=true --max-concurrent-downloads=${concurrent} --split=${split} --max-connection-per-server=${split} --min-split-size=5M --max-tries=5 --retry-wait=3 --timeout=60 --auto-file-renaming=false --user-agent="Mozilla/5.0" --dir="%DOWNLOAD_DIR%" --input-file="%LIST_FILE%" --console-log-level=warn --summary-interval=5`,
      '',
      'if errorlevel 1 goto :failed', '',
      'echo.',
      'echo Download complete. Files saved in: %DOWNLOAD_DIR%',
      'del "%LIST_FILE%" >nul 2>nul',
      'goto :done', '',
      ':failed',
      'echo.',
      'echo WARNING: Some downloads may have failed. Re-run to resume.',
      'goto :done', '',
      ':no_aria2',
      'echo ERROR: aria2c was not found in PATH.',
      'echo Install aria2 and add its directory to PATH.', '',
      ':done',
      'pause',
      'endlocal'
    ];

    const bat = batLines.join('\r\n') + '\r\n';
    const blob = new Blob([bat], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'download_arxiv.bat';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    return { count: selected.length, missing };
  };

  // ---------- 提示系统（独立 Toast，不受面板折叠影响）----------
  const showToast = (text, ok = true) => {
    let toast = document.getElementById('axc-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'axc-toast';
      toast.style.cssText = `
        position: fixed; bottom: 24px; right: 24px; z-index: 100001;
        padding: 10px 18px; border-radius: 6px; color: #fff;
        font-family: system-ui, sans-serif; font-size: 14px; font-weight: 500;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        transition: opacity 0.3s, transform 0.3s;
        opacity: 0; transform: translateY(10px); pointer-events: none;
        max-width: 320px; word-break: break-word;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.background = ok ? '#2a7' : '#b31b1b';
    void toast.offsetWidth; // 强制重绘以重置 transition
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
    }, 3000);

    try {
      if (typeof GM_notification === 'function') {
        GM_notification({
          title: ok ? 'arXiv 缓存区' : 'arXiv 缓存区 — 出错',
          text,
          timeout: 3500,
          silent: true
        });
      }
    } catch (e) { /* ignore */ }
  };

  const toClipboard = (text, okMsg) => {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        showToast(okMsg, true);
      } else {
        throw new Error('GM_setClipboard not available');
      }
    } catch (e) {
      navigator.clipboard.writeText(text)
        .then(() => showToast(okMsg, true))
        .catch(() => showToast('复制失败，请检查剪贴板权限', false));
    }
  };

  // ---------- UI ----------
  const css = `
    #axc-panel{position:fixed;top:80px;right:16px;width:390px;max-height:86vh;
      background:#fff;border:1px solid #b31b1b;border-radius:8px;z-index:99999;
      display:flex;flex-direction:column;font-family:system-ui,sans-serif;
      box-shadow:0 4px 20px rgba(0,0,0,.15);font-size:13px}
    #axc-panel.collapsed{width:auto}
    #axc-panel.collapsed .axc-body{display:none}
    #axc-head{background:#b31b1b;color:#fff;padding:8px 12px;border-radius:7px 7px 0 0;
      display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none}
    #axc-toggle{cursor:pointer;background:rgba(255,255,255,.2);border:none;color:#fff;
      border-radius:4px;padding:2px 8px;font-size:13px}
    .axc-body{padding:10px;overflow-y:auto}
    .axc-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
    .axc-btn{flex:1;min-width:70px;padding:6px 4px;border:1px solid #ccc;border-radius:5px;
      background:#f7f7f7;cursor:pointer;font-size:12px;transition:background .15s}
    .axc-btn:hover{background:#eee}
    .axc-btn.primary{background:#b31b1b;color:#fff;border-color:#b31b1b}
    .axc-btn.primary:hover{background:#911}
    .axc-btn.danger{color:#b31b1b;border-color:#b31b1b}
    #axc-stat{font-size:12px;color:#555;margin-bottom:6px}
    .axc-label{font-size:12px;color:#555;display:block;margin:6px 0 2px}
    #axc-msgbox{width:100%;height:70px;font-size:12px;border:1px solid #ddd;border-radius:5px;
      padding:6px;resize:vertical;box-sizing:border-box}
    #axc-view{width:100%;height:170px;font-family:monospace;font-size:11px;
      border:1px solid #ddd;border-radius:5px;padding:6px;resize:vertical;box-sizing:border-box}
    .axc-dl input{width:100%;padding:4px 6px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}
    .axc-inline{display:flex;gap:6px}
    .axc-inline > div{flex:1}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'axc-panel';
  panel.innerHTML = `
    <div id="axc-head">
      <b>📚 arXiv 缓存区</b>
      <button id="axc-toggle">—</button>
    </div>
    <div class="axc-body">
      <div id="axc-stat"></div>
      <div class="axc-row">
        <button class="axc-btn primary" id="axc-add">➕ 添加本页</button>
        <button class="axc-btn" id="axc-refresh">🔄 刷新视图</button>
        <button class="axc-btn danger" id="axc-clear">🗑️ 清空</button>
      </div>

      <label class="axc-label">给 LLM 的留言（可编辑，自动保存）</label>
      <textarea id="axc-msgbox"></textarea>
      <div class="axc-row" style="margin-top:6px">
        <button class="axc-btn" id="axc-copy-llm">📋 复制留言+摘要</button>
        <button class="axc-btn" id="axc-toggle-format">格式: 纯文本</button>
      </div>
      <div class="axc-row">
        <button class="axc-btn" id="axc-copy-json">📋 复制JSON</button>
        <button class="axc-btn" id="axc-reset-msg">↺ 恢复默认留言</button>
      </div>

      <label class="axc-label">缓存区预览</label>
      <textarea id="axc-view" readonly></textarea>

      <div class="axc-dl">
        <label class="axc-label">下载序号 (逗号分隔，如 1,3,5-8；留空=全部)</label>
        <input id="axc-picks" placeholder="留空=全部" />
        <div class="axc-inline">
          <div>
            <label class="axc-label">并发文件数</label>
            <input id="axc-conc" type="number" value="12" min="1" />
          </div>
          <div>
            <label class="axc-label">单文件连接</label>
            <input id="axc-split" type="number" value="1" min="1" />
          </div>
        </div>
      </div>
      <div class="axc-row" style="margin-top:8px">
        <button class="axc-btn primary" id="axc-gen">⬇️ 生成下载脚本</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);

  const refreshView = () => {
    const cache = loadCache();
    $('#axc-stat').textContent = `缓存区共 ${cache.length} 篇`;
    $('#axc-view').value = cache.length
      ? cache.map(p => `[${p.index}] ${p.title}  (${p.arxivId})`).join('\n')
      : '(空)';
  };

  const updateFormatButton = () => {
    const mode = loadFormatMode();
    $('#axc-toggle-format').textContent = `格式: ${mode === 'xml' ? 'XML' : '纯文本'}`;
  };

  const parsePicks = (str) => {
    const cache = loadCache();
    if (!str.trim()) return cache.map(p => p.index);
    const out = [];
    str.split(',').forEach(part => {
      part = part.trim();
      const m = part.match(/^(\d+)-(\d+)$/);
      if (m) { for (let i = +m[1]; i <= +m[2]; i++) out.push(i); }
      else if (/^\d+$/.test(part)) out.push(+part);
    });
    return out;
  };

  // ---------- 事件 ----------
  $('#axc-msgbox').value = loadMsg();
  $('#axc-msgbox').addEventListener('input', (e) => saveMsg(e.target.value));
  updateFormatButton();

  $('#axc-add').onclick = () => {
    const r = addCurrentPage();
    refreshView();
    showToast(`新增 ${r.added} 篇，跳过重复 ${r.skipped} 篇，共 ${r.total} 篇`, true);
  };

  $('#axc-refresh').onclick = () => { refreshView(); showToast('视图已刷新', true); };

  $('#axc-clear').onclick = () => {
    if (confirm('确定清空缓存区、开始新任务吗？')) {
      localStorage.removeItem(CACHE_KEY);
      refreshView();
      showToast('已清空，可以开始新任务', true);
    }
  };

  $('#axc-copy-llm').onclick = () => {
    if (!loadCache().length) return showToast('缓存区为空', false);
    toClipboard(buildLLMText(), '已复制 留言+摘要 到剪贴板');
  };

  $('#axc-toggle-format').onclick = () => {
    const current = loadFormatMode();
    const next = current === 'xml' ? 'text' : 'xml';
    saveFormatMode(next);
    updateFormatButton();
    showToast(`已切换为 ${next === 'xml' ? 'XML' : '纯文本'} 格式`, true);
  };

  $('#axc-copy-json').onclick = () => {
    const cache = loadCache();
    if (!cache.length) return showToast('缓存区为空', false);
    toClipboard(JSON.stringify(cache, null, 2), '已复制 JSON 到剪贴板');
  };

  $('#axc-reset-msg').onclick = () => {
    saveMsg(DEFAULT_MSG);
    $('#axc-msgbox').value = DEFAULT_MSG;
    showToast('已恢复默认留言', true);
  };

  $('#axc-gen').onclick = () => {
    const picks = parsePicks($('#axc-picks').value);
    const conc = Math.max(1, +$('#axc-conc').value || 12);
    const split = Math.max(1, +$('#axc-split').value || 1);
    const r = generateBat(picks, conc, split);
    if (r.err) return showToast(r.err, false);
    let t = `已生成 download_arxiv.bat（${r.count} 篇）`;
    if (r.missing.length) t += `；忽略无效序号 ${r.missing.join(',')}`;
    showToast(t, true);
  };

  $('#axc-toggle').onclick = () => {
    panel.classList.toggle('collapsed');
    $('#axc-toggle').textContent = panel.classList.contains('collapsed') ? '+' : '—';
  };

  // 拖动
  (() => {
    const head = $('#axc-head');
    let dragging = false, ox = 0, oy = 0;
    head.addEventListener('mousedown', (e) => {
      if (e.target.id === 'axc-toggle') return;
      dragging = true;
      ox = e.clientX - panel.offsetLeft;
      oy = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - ox) + 'px';
      panel.style.top = (e.clientY - oy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => dragging = false);
  })();

  refreshView();
})();
