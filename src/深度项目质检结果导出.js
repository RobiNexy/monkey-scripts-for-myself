// ==UserScript==
// @name         深度项目质检结果导出
// @namespace    https://ego-dms.eilake.com/
// @version      4.0.1
// @description  双 Tab：①采集点汇总（三态筛选/单包同步/采集员分组/图片导出/LLM）②质检员绩效（全量抓取/按日期/CSV 导出）
// @match        https://ego-dms.eilake.com/*
// @require      https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @run-at       document-idle
// ==/UserScript==

// ============================== 副作用 ==============================
// - 存储：localStorage
//     · egodms_v31_sync        Record<pkgId, {state:'full'|'partial', exportedAt:ISO}>
//     · egodms_v3_history      Array<ExportEntry>
//     · egodms_v3_llm_prompt   string
//     · egodms_v3_llm_key      string
// - 网络：
//     · GET https://ego-dms.eilake.com/api/query/org/tree
//     · GET https://ego-dms.eilake.com/api/data/package/list?...
//     · GET https://ego-dms.eilake.com/api/data/package/{id}/qc-page
//     · POST https://api.deepseek.com/chat/completions（仅 Tab1 使用；GM_xmlhttpRequest，已声明 @connect）
// - DOM：#egodms-fab、#egodms-panel、#egodms-drawer、<style>
// - 仅在顶层帧运行（运行时 window.top 检查）
// - 全局调试命名空间：unsafeWindow.__egodms_debug__（可 delete 清理）
// - 使用 unsafeWindow 暴露调试入口；@require 来源 unpkg（固定版本）
//
// ============================== 两个 Tab 的定位 ==============================
// Tab1「采集点汇总」：面向外包，按采集点筛选，图片为唯一输出，带 LLM 总结
// Tab2「质检员绩效」：面向内部，全量抓取不按采集点区分，CSV 为唯一输出，无 LLM
//    统计口径：按「质检发生日期」聚合（inspection.inspect_time），非包上传日期
//    质检条数 = 该质检员质检过的视频组数（groups[].inspection 有值即一条）
//    质检总时长 = 这些组的 anchor_file.duration 之和
//
// ============================== 控制台定位本脚本问题 ==============================
// 1. F12 → Console → 过滤框输入 [egodms]
// 2. 看红色 error 行 → 展开堆栈 → 点最上层链接跳到 Sources
// 3. 在 analyzeQc / handleRunStats / handleInspectorFetch / exportResultAsImage 处下断点
// 4. 检查内部状态：Console 输入 __egodms_debug__.state

(function () {
  'use strict';

  if (window.top !== window.self) return;

  // ============================== §0 常量 & 日志 ==============================
  const TAG = '[egodms]';
  const log  = (...a) => console.debug(TAG, ...a);
  const info = (...a) => console.info (TAG, ...a);
  const warn = (...a) => console.warn (TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);
  const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  const API_BASE = 'https://ego-dms.eilake.com';
  const DEFAULT_ORG_NAME    = '宜昌训练场';
  const DEFAULT_POINT_NAME  = '贵州遵义采集点';
  const PAGE_SIZE           = 100;
  const ALL_PAGE_SIZE       = 1000;   // 质检员 Tab 用，尽量一次多拿
  const QC_CONCURRENCY      = 5;
  const TOP_REASON_PER_COLLECTOR = 3;

  const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
  const LLM_MODEL    = 'deepseek-flash';
  const LLM_INPUT_MAX = 50000;

  const LS = {
    sync:    'egodms_v31_sync',
    history: 'egodms_v3_history',
    prompt:  'egodms_v3_llm_prompt',
    key:     'egodms_v3_llm_key',
  };

  const DEFAULT_LLM_PROMPT =
`你是一名深度数据采集质检分析员。用户会给你一段质检统计 CSV（包含按采集员分组的汇总、以及逐条不合格明细），请基于以下常见规范归类问题，输出一份纯文本整改报告（不超过 260 字）。

常见规范：
1. 口播规范：开始必须说"开始录制，任务开始"加任务名称；结束必须说"任务结束，录制结束"。扫场开始说"开始场景录制"，结束说"结束场景录制"。缺开场、缺结束、口播错误、声音太小都算。
2. 定位块规范：扫场起止必须正对1号面，任务时必须从1号面出发（结束任务只有口令要求）。录制过程中不能移动。
3. 文件配对：lrv 和 insv 必须一一对应，数量不一致通常是相机参数错误或拷贝遗漏。
4. 画面曝光：画面黑或过曝，一般保持自动曝光/自动ISO。
5. 扫场规范：必须两个独立视频，第一个中视角顺时针逆时针走，第二个先高视角后低视角；不能合成一段、不能缺方向。
6. 任务粒度：一条视频只做一个任务，多任务串联即过粗。

输出要求：
- 纯文本，不使用任何 Markdown 标记。
- 开头一句话点出整体问题集中在哪几类，若某些采集员问题明显突出请点名。
- 主体给行动清单，按人给建议，再给全员通用建议。
- 只针对 CSV 中出现的问题，不额外补规则。`;

  // ============================== §1 存储层 ==============================
  const STORE = {
    _read(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { warn('STORE._read 失败', key, e); return fallback; }
    },
    _write(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); }
      catch (e) { warn('STORE._write 失败', key, e); }
    },

    getSyncRecord() { return this._read(LS.sync, {}); },
    setSyncRecord(rec) { this._write(LS.sync, rec); },
    markPackagesSynced(items) {
      if (!items || !items.length) return;
      const rec = this.getSyncRecord();
      const now = new Date().toISOString();
      for (const it of items) {
        if (!it || !it.id) continue;
        rec[it.id] = { state: it.annotationState === 'full' ? 'full' : 'partial', exportedAt: now };
      }
      this.setSyncRecord(rec);
    },
    clearSyncRecord() { this._write(LS.sync, {}); },
    getSyncStats() {
      const rec = this.getSyncRecord();
      let full = 0, partial = 0;
      for (const k of Object.keys(rec)) {
        if (rec[k].state === 'full') full++;
        else if (rec[k].state === 'partial') partial++;
      }
      return { total: full + partial, full, partial };
    },

    getHistory() { return this._read(LS.history, []); },
    setHistory(arr) { this._write(LS.history, arr); },
    addHistory(entry) {
      const list = this.getHistory();
      list.unshift(entry);
      if (list.length > 100) list.length = 100;
      this.setHistory(list);
    },
    removeHistory(id) { this.setHistory(this.getHistory().filter(e => e.id !== id)); },
    clearHistory() { this.setHistory([]); },

    getLlmPrompt() {
      const v = localStorage.getItem(LS.prompt);
      return v && v.trim() ? v : DEFAULT_LLM_PROMPT;
    },
    setLlmPrompt(v) { try { localStorage.setItem(LS.prompt, v || ''); } catch (e) { warn(e); } },
    getLlmKey() { return localStorage.getItem(LS.key) || ''; },
    setLlmKey(v) { try { localStorage.setItem(LS.key, v || ''); } catch (e) { warn(e); } },
  };

  // ============================== §2 API 层 ==============================
  function findToken() {
    const jwtRe = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
    const stores = [];
    try { stores.push(localStorage); } catch (e) { warn('localStorage 不可用', e); }
    try { stores.push(sessionStorage); } catch (e) { warn('sessionStorage 不可用', e); }
    for (const st of stores) {
      for (let i = 0; i < st.length; i++) {
        const v = st.getItem(st.key(i));
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (jwtRe.test(t)) return t;
        if (/^Bearer\s+/i.test(t) && jwtRe.test(t.replace(/^Bearer\s+/i, ''))) return t.replace(/^Bearer\s+/i, '');
        try {
          const o = JSON.parse(t);
          if (o && typeof o === 'object') {
            for (const k of Object.keys(o)) {
              const vv = o[k];
              if (typeof vv !== 'string') continue;
              const tt = vv.trim();
              if (jwtRe.test(tt)) return tt;
              if (/^Bearer\s+/i.test(tt) && jwtRe.test(tt.replace(/^Bearer\s+/i, ''))) return tt.replace(/^Bearer\s+/i, '');
            }
          }
        } catch (e) {
          log('storage JSON parse failed while looking for token', e);
        }
      }
    }
    return '';
  }

  async function apiGet(path) {
    const token = (S.tokenOverride && S.tokenOverride.trim()) || findToken();
    const headers = { accept: 'application/json, text/plain, */*' };
    if (token) headers.authorization = /^Bearer\s+/i.test(token) ? token : 'Bearer ' + token;
    const res = await fetch(API_BASE + path, {
      method: 'GET', headers, credentials: 'include', mode: 'cors',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + path);
    const j = await res.json();
    if (j.code !== 200) throw new Error((j.message || '接口错误') + ' @ ' + path);
    return j.data;
  }

  async function fetchOrgTree() { return apiGet('/api/query/org/tree'); }

  // Tab1：按 org + point + 日期
  async function fetchPackageList(orgId, pointId, start, end) {
    let page = 1, all = [];
    while (true) {
      const qs = ['page=' + page, 'page_size=' + PAGE_SIZE];
      if (orgId)   qs.push('org_id=' + encodeURIComponent(orgId));
      if (pointId) qs.push('point_id=' + encodeURIComponent(pointId));
      if (start)   qs.push('target_date_start=' + start);
      if (end)     qs.push('target_date_end=' + end);
      const data = await apiGet('/api/data/package/list?' + qs.join('&'));
      all = all.concat(data.list || []);
      const pages = Number(data.pages) || 1;
      log('列表 page ' + page + '/' + pages + ' +' + (data.list || []).length + ' 累计 ' + all.length);
      if (page >= pages) break;
      page++;
    }
    return all;
  }

  // Tab2：全量（不带 org/point），日期可选
  async function fetchAllPackages(start, end, onProgress) {
    let page = 1, all = [];
    while (true) {
      const qs = ['page=' + page, 'page_size=' + ALL_PAGE_SIZE];
      if (start) qs.push('target_date_start=' + start);
      if (end)   qs.push('target_date_end=' + end);
      const data = await apiGet('/api/data/package/list?' + qs.join('&'));
      all = all.concat(data.list || []);
      const pages = Number(data.pages) || 1;
      const total = Number(data.total) || all.length;
      if (onProgress) onProgress({ page, pages, got: all.length, total });
      log('全量列表 page ' + page + '/' + pages + ' 累计 ' + all.length + '/' + total);
      if (page >= pages) break;
      page++;
    }
    return all;
  }

  async function fetchQcDetail(id) { return apiGet('/api/data/package/' + id + '/qc-page'); }

  // ============================== §3 工具函数 ==============================
  const pad2 = n => String(n).padStart(2, '0');
  function fmtSec(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return pad2(h) + ':' + pad2(m) + ':' + pad2(r);
  }
  function fmtSize(b) {
    b = Number(b) || 0;
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
    if (b >= 1024)      return (b / 1024).toFixed(2) + ' KB';
    return b + ' B';
  }
  function fmtDateTime(iso) {
    if (!iso) return '-';
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
    if (!m) return iso;
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
  }
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtPct(a, b) { return b ? ((a / b) * 100).toFixed(1) + '%' : '—'; }
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  function toDateInput(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  async function mapLimit(items, limit, fn, shouldStop) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        if (shouldStop && shouldStop()) return;
        const idx = i++;
        if (idx >= items.length) return;
        try { out[idx] = await fn(items[idx], idx); }
        catch (e) { warn('mapLimit #' + idx + ' 失败', e); out[idx] = { __error: e }; }
      }
    });
    await Promise.all(workers);
    return out;
  }

  function sortByUploadTimeDesc(arr) {
    return arr.slice().sort((a, b) => {
      const au = a.upload_finish_time || '';
      const bu = b.upload_finish_time || '';
      if (!au && !bu) return 0;
      if (!au) return 1;
      if (!bu) return -1;
      return bu.localeCompare(au);
    });
  }

  // 通用文件下载
  function downloadTextFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // ============================== §4 状态判定 ==============================
  function uploadStateOf(pkg) {
    const v = Number(pkg.process_status);
    if (v === 2) return { code: 'done',      label: '上传完成', cls: 'tag-ok'   };
    if (v === 1) return { code: 'uploading', label: '上传中',   cls: 'tag-info' };
    if (v === 3) return { code: 'failed',    label: '上传失败', cls: 'tag-bad'  };
    return { code: 'unknown', label: '未知(' + v + ')', cls: 'tag-mute' };
  }
  function deliveryStateOf(pkg) {
    const v = Number(pkg.delivery_status);
    if (v === 2) return { code: 'delivered',   label: '已交付', cls: 'tag-ok'   };
    if (v === 1) return { code: 'deliverable', label: '可交付', cls: 'tag-info' };
    if (v === 0) return { code: 'unset',       label: '未设置', cls: 'tag-mute' };
    return { code: 'unknown', label: '未知(' + v + ')', cls: 'tag-mute' };
  }
  function evalStateOf(pkg) {
    const v = Number(pkg.qc_eval_status);
    if (v === 1) return { code: 'done',    label: '已评价', cls: 'tag-ok'   };
    if (v === 0) return { code: 'pending', label: '待评价', cls: 'tag-mute' };
    return { code: 'unknown', label: '未知(' + v + ')', cls: 'tag-mute' };
  }

  function syncStateOfPkg(pkgId) {
    const rec = STORE.getSyncRecord();
    const r = rec[pkgId];
    if (!r) return { status: 'unsynced', exportedAt: null, lastState: null };
    if (r.state === 'full')    return { status: 'synced',  exportedAt: r.exportedAt, lastState: 'full'    };
    if (r.state === 'partial') return { status: 'partial', exportedAt: r.exportedAt, lastState: 'partial' };
    return { status: 'unsynced', exportedAt: null, lastState: null };
  }

  const SYNC_LABEL = {
    synced:   { label: '已同步',   cls: 'tag-ok',   dot: '●' },
    partial:  { label: '部分同步', cls: 'tag-info', dot: '◐' },
    unsynced: { label: '未同步',   cls: 'tag-mute', dot: '○' },
  };

  // ============================== §5 质检分析（Tab1）==============================
  function analyzeQc(pkg, qcData) {
    const groups = (qcData && qcData.groups) || [];
    const detail = (qcData && qcData.package) || pkg;

    const pkgTotal = Number(detail.collect_duration) || Number(pkg.collect_duration) || 0;
    let groupTotal = 0, annotatedDuration = 0, passedDuration = 0;
    let annotatedCount = 0, failCount = 0;
    const fails = [];
    const reasonHist = new Map();
    const inspectors = new Map();

    for (const g of groups) {
      const anchor = g.anchor_file || {};
      const dur = Number(anchor.duration) || 0;
      groupTotal += dur;

      const insp = g.inspection;
      if (!insp) continue;
      const score = insp.total_score;
      if (score === null || score === undefined || score === '') continue;

      annotatedCount++;
      annotatedDuration += dur;
      if (insp.inspector_name) inspectors.set(insp.inspector_name, (inspectors.get(insp.inspector_name) || 0) + 1);

      const isPassed = Number(insp.inspect_status) === 1;
      if (isPassed) {
        passedDuration += dur;
      } else {
        failCount++;
        const fileNames = [];
        if (anchor.file_name) fileNames.push(anchor.file_name);
        for (const f of (g.insv_files || [])) if (f.file_name) fileNames.push(f.file_name);
        const reasons = [];
        for (const d of (insp.dimensions || [])) {
          if (d && d.remark && String(d.remark).trim()) {
            const r = String(d.remark).trim();
            reasons.push((d.dim_name || d.dim_code) + ': ' + r);
            reasonHist.set(r, (reasonHist.get(r) || 0) + 1);
          }
        }
        fails.push({
          packageName:     detail.package_name       || pkg.package_name       || '',
          packageNo:       detail.package_no         || pkg.package_no         || '',
          packageUploadAt: detail.upload_finish_time || pkg.upload_finish_time || null,
          collectorName:   detail.collector_name     || pkg.collector_name     || '',
          fileName:        fileNames.join(' / '),
          duration:        dur,
          score:           score,
          reason:          reasons.length ? reasons.join('\n') : '未填写原因',
          inspector:       insp.inspector_name || '',
          excluded:        Number(anchor.is_excluded) === 1,
        });
      }
    }

    const groupCount = groups.length;
    const totalFiles = Number(detail.total_files) || Number(pkg.total_files) || 0;
    const progressDenom = groupCount > 0 ? groupCount : Math.round(totalFiles / 2);
    const annotationState =
      annotatedCount === 0 ? 'none'
      : (progressDenom > 0 && annotatedCount >= progressDenom ? 'full' : 'partial');

    const fallbackValid = Number(detail.valid_duration) || Number(pkg.valid_duration) || 0;

    return {
      total: pkgTotal || groupTotal || fallbackValid,
      annotatedDuration, passedDuration,
      groupCount, annotatedCount, failCount, fails,
      progressDenom, annotationState,
      reasonHist, inspectors,
    };
  }

  function aggregateResult(rows, meta) {
    let totalDuration = 0, annotatedDuration = 0, passedDuration = 0;
    const allFails = [];
    const reasonTop = new Map();
    const inspectorTop = new Map();
    const collectorStats = new Map();

    for (const { pkg, analysis } of rows) {
      totalDuration     += analysis.total;
      annotatedDuration += analysis.annotatedDuration;
      passedDuration    += analysis.passedDuration;
      for (const f of analysis.fails) allFails.push(f);
      for (const [r, c] of analysis.reasonHist.entries()) reasonTop.set(r, (reasonTop.get(r) || 0) + c);
      for (const [n, c] of analysis.inspectors.entries()) inspectorTop.set(n, (inspectorTop.get(n) || 0) + c);

      const name = (pkg.collector_name || '').trim() || '(未知采集员)';
      if (!collectorStats.has(name)) {
        collectorStats.set(name, {
          name, packages: 0, total: 0, annotated: 0, passed: 0,
          groupCount: 0, annotatedGroups: 0, failCount: 0, failDuration: 0,
          reasons: new Map(), uploadRange: { first: null, last: null },
        });
      }
      const cs = collectorStats.get(name);
      cs.packages += 1;
      cs.total += analysis.total;
      cs.annotated += analysis.annotatedDuration;
      cs.passed += analysis.passedDuration;
      cs.groupCount += analysis.groupCount;
      cs.annotatedGroups += analysis.annotatedCount;
      cs.failCount += analysis.failCount;
      for (const f of analysis.fails) cs.failDuration += f.duration;
      for (const [r, c] of analysis.reasonHist.entries()) cs.reasons.set(r, (cs.reasons.get(r) || 0) + c);

      const ut = pkg.upload_finish_time || '';
      if (ut) {
        if (!cs.uploadRange.first || ut < cs.uploadRange.first) cs.uploadRange.first = ut;
        if (!cs.uploadRange.last  || ut > cs.uploadRange.last)  cs.uploadRange.last  = ut;
      }
    }

    const reasons = Array.from(reasonTop.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const inspectors = Array.from(inspectorTop.entries()).sort((a, b) => b[1] - a[1]);

    const collectors = Array.from(collectorStats.values())
      .map(c => ({
        ...c,
        coverRate: c.total ? c.annotated / c.total : 0,
        passRate:  c.annotated ? c.passed / c.annotated : 0,
        topReasons: Array.from(c.reasons.entries()).sort((a, b) => b[1] - a[1]).slice(0, TOP_REASON_PER_COLLECTOR),
      }))
      .sort((a, b) => b.annotated - a.annotated || b.total - a.total);

    return { meta, rows, totalDuration, annotatedDuration, passedDuration, allFails, reasons, inspectors, collectors, llmSummary: '' };
  }

  // ============================== §5.1 质检员绩效（Tab2）==============================
  // 从 qc-page 抽取质检记录：每个有 inspection 的 group 一条
  function extractInspectorRecords(pkg, qcData) {
    const out = [];
    if (!qcData || qcData.__error) return out;
    const detail = qcData.package || pkg;
    const groups = qcData.groups || [];
    const pointName = (detail.point_name || pkg.point_name || detail.city || pkg.city || '').trim();

    for (const g of groups) {
      const insp = g.inspection;
      if (!insp) continue;
      const name = (insp.inspector_name || '').trim();
      if (!name) continue;
      const anchor = g.anchor_file || {};
      const t = insp.inspect_time || insp.create_time || '';
      out.push({
        inspectorName: name,
        inspectorId:   insp.inspector_id || '',
        inspectTime:   t,
        inspectDate:   t ? t.slice(0, 10) : '(无日期)',
        packageId:     detail.id || pkg.id,
        packageName:   detail.package_name || pkg.package_name || '',
        packageNo:     detail.package_no   || pkg.package_no   || '',
        pointName:     pointName,
        collectorName: detail.collector_name || pkg.collector_name || '',
        fileName:      anchor.file_name || '',
        duration:      Number(anchor.duration) || 0,
        score:         insp.total_score,
        status:        Number(insp.inspect_status),
      });
    }
    return out;
  }

  // 三维聚合：按人 / 按日期 / 按日期×人
  function aggregateInspectorPerf(records) {
    const byInspector = new Map();
    const byDateInspector = new Map();
    const byDate = new Map();

    for (const r of records) {
      // ① 按人
      if (!byInspector.has(r.inspectorName)) {
        byInspector.set(r.inspectorName, {
          name: r.inspectorName,
          ids: new Set(),
          count: 0, duration: 0, pass: 0, fail: 0, other: 0,
          packageIds: new Set(), points: new Set(), dates: new Set(),
          firstTime: '', lastTime: '',
        });
      }
      const s = byInspector.get(r.inspectorName);
      if (r.inspectorId) s.ids.add(r.inspectorId);
      s.count++; s.duration += r.duration;
      if (r.status === 1) s.pass++;
      else if (r.status === 2) s.fail++;
      else s.other++;
      s.packageIds.add(r.packageId);
      s.points.add(r.pointName || '(未知)');
      s.dates.add(r.inspectDate);
      if (r.inspectTime) {
        if (!s.firstTime || r.inspectTime < s.firstTime) s.firstTime = r.inspectTime;
        if (!s.lastTime  || r.inspectTime > s.lastTime)  s.lastTime  = r.inspectTime;
      }

      // ② 按日期×人
      const dk = r.inspectDate + '\u0001' + r.inspectorName;
      if (!byDateInspector.has(dk)) {
        byDateInspector.set(dk, {
          date: r.inspectDate, inspector: r.inspectorName,
          count: 0, duration: 0, pass: 0, fail: 0, other: 0,
          packageIds: new Set(), points: new Set(),
        });
      }
      const di = byDateInspector.get(dk);
      di.count++; di.duration += r.duration;
      if (r.status === 1) di.pass++;
      else if (r.status === 2) di.fail++;
      else di.other++;
      di.packageIds.add(r.packageId);
      di.points.add(r.pointName || '(未知)');

      // ③ 按日期
      if (!byDate.has(r.inspectDate)) {
        byDate.set(r.inspectDate, { date: r.inspectDate, count: 0, duration: 0, inspectors: new Set(), points: new Set() });
      }
      const d = byDate.get(r.inspectDate);
      d.count++; d.duration += r.duration;
      d.inspectors.add(r.inspectorName);
      d.points.add(r.pointName || '(未知)');
    }

    const summary = Array.from(byInspector.values()).map(s => ({
      name: s.name,
      count: s.count,
      duration: s.duration,
      pass: s.pass,
      fail: s.fail,
      other: s.other,
      packageCount: s.packageIds.size,
      pointCount: s.points.size,
      dateCount: s.dates.size,
      passRate: (s.pass + s.fail) ? s.pass / (s.pass + s.fail) : 0,
      avgDuration: s.count ? s.duration / s.count : 0,
      firstTime: s.firstTime,
      lastTime: s.lastTime,
    })).sort((a, b) => b.count - a.count || b.duration - a.duration);

    const byDateInspectorList = Array.from(byDateInspector.values()).map(x => ({
      date: x.date,
      inspector: x.inspector,
      count: x.count,
      duration: x.duration,
      pass: x.pass,
      fail: x.fail,
      other: x.other,
      passRate: (x.pass + x.fail) ? x.pass / (x.pass + x.fail) : 0,
      packageCount: x.packageIds.size,
      pointsText: Array.from(x.points).sort().join(' / '),
    })).sort((a, b) => b.date.localeCompare(a.date) || b.count - a.count);

    const byDateList = Array.from(byDate.values()).map(x => ({
      date: x.date,
      count: x.count,
      duration: x.duration,
      inspectorCount: x.inspectors.size,
      inspectorsText: Array.from(x.inspectors).sort().join('、'),
      pointCount: x.points.size,
    })).sort((a, b) => b.date.localeCompare(a.date));

    return { summary, byDateInspectorList, byDateList };
  }

  // ============================== §6 LLM（Tab1）==============================
  function csvEsc(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function buildLlmInput(res) {
    const L = [];
    L.push(['== 汇总 =='].map(csvEsc).join(','));
    L.push(['采集点', res.meta.pointLabel, '日期', res.meta.start + '-' + res.meta.end].map(csvEsc).join(','));
    L.push(['总包数', res.rows.length, '剔除未标注', res.meta.dropped].map(csvEsc).join(','));
    L.push(['总时长(秒)', res.totalDuration, '已标注(秒)', res.annotatedDuration, '合格(秒)', res.passedDuration].map(csvEsc).join(','));
    L.push(['覆盖率', fmtPct(res.annotatedDuration, res.totalDuration), '合格率', fmtPct(res.passedDuration, res.annotatedDuration)].map(csvEsc).join(','));

    L.push('');
    L.push(['== 采集员分组 =='].map(csvEsc).join(','));
    L.push(['采集员','包数','总时长(秒)','已标注(秒)','合格(秒)','合格率','覆盖率','不合格数','Top原因'].map(csvEsc).join(','));
    for (const c of res.collectors) {
      const top = c.topReasons.map(([r, n]) => r + '×' + n).join('；') || '—';
      L.push([c.name, c.packages, c.total, c.annotated, c.passed, fmtPct(c.passed, c.annotated), fmtPct(c.annotated, c.total), c.failCount, top].map(csvEsc).join(','));
    }

    L.push('');
    L.push(['== 不合格明细 =='].map(csvEsc).join(','));
    L.push(['采集员','包名','编号','上传时间','文件名','时长(秒)','得分','不合格原因','质检人'].map(csvEsc).join(','));
    for (const f of res.allFails) {
      L.push([f.collectorName, f.packageName, f.packageNo, fmtDateTime(f.packageUploadAt), f.fileName, f.duration, f.score, f.reason, f.inspector].map(csvEsc).join(','));
    }

    const text = L.join('\r\n');
    if (text.length <= LLM_INPUT_MAX) return text;
    return '（数据过长已截断）\r\n' + text.slice(0, LLM_INPUT_MAX);
  }
  // 跨域请求统一走 GM_xmlhttpRequest，避免页面 CORS 限制（对应规则 C2/C14）
  function gmPostJson(url, body, headers, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: timeoutMs,
        onload: (resp) => resolve(resp),
        onerror: (resp) => reject(new Error('网络请求失败' + (resp && resp.error ? ': ' + resp.error : ''))),
        ontimeout: () => reject(new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）')),
        onabort: () => reject(new Error('请求已中止')),
      });
    });
  }

  async function callLlm(prompt, apiKey, userContent) {
    const body = JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user',   content: '请分析以下质检数据 CSV：\n\n' + userContent },
      ],
      stream: false,
    });
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey };

    let status, responseText;
    if (typeof GM_xmlhttpRequest === 'function') {
      const resp = await gmPostJson(DEEPSEEK_URL, body, headers);
      status = resp.status;
      responseText = resp.responseText || '';
    } else {
      warn('GM_xmlhttpRequest 不可用，回退到 fetch（可能受 CORS 限制）');
      const res = await fetch(DEEPSEEK_URL, { method: 'POST', headers, body });
      status = res.status;
      responseText = await res.text();
    }

    if (status < 200 || status >= 300) {
      const detail = String(responseText || '').slice(0, 300);
      const tip = status === 401 ? '（API Key 无效）'
                : status === 429 ? '（请求频率受限）'
                : status === 402 ? '（余额不足）' : '';
      throw new Error('HTTP ' + status + tip + (detail ? ' - ' + detail : ''));
    }

    let j;
    try { j = JSON.parse(responseText || '{}'); }
    catch (e) {
      err('LLM 响应不是合法 JSON', e, String(responseText || '').slice(0, 300));
      throw new Error('LLM 响应解析失败');
    }
    const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    if (!text.trim()) throw new Error('LLM 返回为空');
    return text.trim();
  }

  // ============================== §7 运行时状态 ==============================
  const S = {
    tab: 'point',                       // 'point' | 'inspector'
    orgTree: [],
    tokenOverride: '',
    llmBusy: false,

    // Tab1
    allFetchedPackages: [],
    filteredPackages: [],
    selectedIds: new Set(),
    syncStatusByPkg: new Map(),
    result: null,
    groupByCollector: true,
    pointTabForm: null,

    // Tab2
    inspector: {
      records: [],
      summary: [],
      byDateInspectorList: [],
      byDateList: [],
      meta: null,
      includeDetail: true,
      busy: false,
      abort: false,
    },
  };
  const debug = (pageWindow.__egodms_debug__ = { state: S, log });

  let els = {};

  // ============================== §8 UI · 样式 ==============================
  const CSS = `
  #egodms-fab {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
    width: 56px; height: 56px; border-radius: 28px; border: none; cursor: pointer;
    background: linear-gradient(135deg,#6366f1,#8b5cf6); color: #fff;
    font-size: 11px; line-height: 1.3; font-weight: 600;
    box-shadow: 0 10px 24px rgba(99,102,241,.4);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  #egodms-fab:hover { transform: translateY(-2px); box-shadow: 0 14px 28px rgba(99,102,241,.5); }

  #egodms-panel {
    position: fixed; right: 20px; bottom: 20px;
    width: 1240px; max-width: calc(100vw - 40px); max-height: 92vh;
    background: #fff; border-radius: 14px;
    box-shadow: 0 20px 60px rgba(15,23,42,.25);
    z-index: 2147483000; display: none; flex-direction: column;
    font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f2937; overflow: hidden;
  }
  #egodms-panel.open { display: flex; }

  .ed-header {
    padding: 14px 20px; background: linear-gradient(135deg,#4f46e5,#7c3aed);
    color: #fff; display: flex; align-items: center; justify-content: space-between;
    cursor: move; user-select: none; flex-shrink: 0;
  }
  .ed-header h3 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .3px; }
  .ed-header .ed-head-actions { display: flex; gap: 8px; }
  .ed-head-btn {
    background: rgba(255,255,255,.14); color: #fff; border: 1px solid rgba(255,255,255,.2);
    border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px;
    transition: background .15s;
  }
  .ed-head-btn:hover { background: rgba(255,255,255,.25); }
  .ed-close { background: transparent; border: none; color: #fff; font-size: 22px; cursor: pointer; line-height: 1; padding: 0 2px; }

  /* Tab 栏 */
  .ed-tabs {
    display: flex; gap: 0; padding: 0 16px; background: #f9fafb;
    border-bottom: 1px solid #e5e7eb; flex-shrink: 0;
  }
  .ed-tab {
    padding: 11px 20px; border: none; background: transparent; cursor: pointer;
    font-size: 13px; font-weight: 500; color: #6b7280;
    border-bottom: 2px solid transparent; transition: all .15s;
    font-family: inherit;
  }
  .ed-tab:hover { color: #4f46e5; background: #f3f4f6; }
  .ed-tab.active { color: #4f46e5; border-bottom-color: #4f46e5; background: #fff; }

  .ed-body { padding: 16px 20px 20px; overflow: auto; flex: 1; }

  .ed-step {
    display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
    font-size: 11px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .6px;
  }
  .ed-step-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 11px;
    background: #eef2ff; color: #4f46e5; font-size: 12px;
  }
  .ed-step.active .ed-step-num { background: #4f46e5; color: #fff; }

  .ed-card {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
    padding: 14px 16px; margin-bottom: 14px;
  }

  .ed-filter { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px 14px; }
  .ed-field { display: flex; flex-direction: column; gap: 4px; }
  .ed-field > label { font-size: 11px; color: #6b7280; font-weight: 500; }
  .ed-input, .ed-select {
    height: 32px; padding: 0 10px; border: 1px solid #d1d5db; border-radius: 6px;
    font-size: 13px; color: #111827; background: #fff; outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  .ed-input:focus, .ed-select:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.12); }

  .ed-actions { margin-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .ed-btn {
    height: 34px; padding: 0 16px; border: none; border-radius: 7px;
    font-size: 13px; font-weight: 500; cursor: pointer;
    transition: all .15s ease; font-family: inherit;
  }
  .ed-btn.primary { background: #4f46e5; color: #fff; }
  .ed-btn.primary:hover { background: #4338ca; }
  .ed-btn.success { background: #059669; color: #fff; }
  .ed-btn.success:hover { background: #047857; }
  .ed-btn.secondary { background: #f3f4f6; color: #374151; border: 1px solid #e5e7eb; }
  .ed-btn.secondary:hover { background: #e5e7eb; }
  .ed-btn.danger { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
  .ed-btn.danger:hover { background: #fecaca; }
  .ed-btn.ghost { background: transparent; color: #4f46e5; }
  .ed-btn.ghost:hover { background: #eef2ff; }
  .ed-btn:disabled { opacity: .5; cursor: not-allowed; }

  .ed-status { padding: 8px 12px; margin-bottom: 12px; border-radius: 6px; font-size: 12px; background: #f9fafb; color: #4b5563; }
  .ed-status.error { background: #fef2f2; color: #b91c1c; }
  .ed-status.success { background: #ecfdf5; color: #047857; }
  .ed-status.warn { background: #fffbeb; color: #92400e; }

  .ed-progress-bar {
    height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; margin-top: 8px;
  }
  .ed-progress-bar > i {
    display: block; height: 100%; width: 0;
    background: linear-gradient(90deg,#6366f1,#8b5cf6); transition: width .25s;
  }

  .ed-cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 14px; }
  .ed-metric {
    background: linear-gradient(135deg,#f5f7ff,#fafbff);
    border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px;
  }
  .ed-metric .k { font-size: 11px; color: #6b7280; margin-bottom: 4px; }
  .ed-metric .v { font-size: 20px; font-weight: 700; color: #4f46e5; line-height: 1.15; }
  .ed-metric .s { font-size: 11px; color: #9ca3af; margin-top: 3px; }

  .ed-section-title {
    font-weight: 600; margin: 16px 0 8px; font-size: 13px; color: #111827;
    display: flex; align-items: center; gap: 8px;
  }
  .ed-section-title::before { content:''; width: 3px; height: 14px; background: #6366f1; border-radius: 2px; flex-shrink: 0; }
  .ed-section-title > span:first-child { display: flex; align-items: center; gap: 8px; }
  .ed-sub { color: #6b7280; font-size: 11px; font-weight: 400; }

  .ed-table-wrap { border: 1px solid #e5e7eb; border-radius: 8px; overflow: auto; max-height: 420px; }
  .ed-table-wrap.unlimited { max-height: none; }
  table.ed-table { border-collapse: collapse; width: 100%; font-size: 12px; }
  .ed-table th, .ed-table td { padding: 7px 10px; text-align: left; border-bottom: 1px solid #f3f4f6; vertical-align: top; white-space: nowrap; }
  .ed-table th { background: #f9fafb; font-weight: 600; color: #374151; position: sticky; top: 0; z-index: 1; }
  .ed-table tr:hover td { background: #fafbff; }
  .ed-table td.wrap { white-space: normal; word-break: break-word; max-width: 420px; }
  .ed-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .ed-table tr.bad td { background: #fff5f5; }
  .ed-upload-time { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #374151; font-size: 11.5px; }

  .ed-table tr.group-row td {
    background: linear-gradient(90deg,#eef2ff,#f5f3ff);
    color: #4338ca; font-weight: 600; font-size: 12.5px;
    border-bottom: 2px solid #c7d2fe; border-top: 2px solid #c7d2fe;
    padding: 9px 12px;
  }
  .ed-table tr.group-row .g-meta { color: #6b7280; font-weight: 400; margin-left: 8px; font-size: 11.5px; }

  .ed-table tr.total-row td {
    background: #f0fdf4; color: #065f46; font-weight: 600;
    border-top: 2px solid #86efac; border-bottom: 2px solid #86efac;
  }

  .ed-collector-cell { display: flex; align-items: center; gap: 8px; }
  .ed-avatar {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 14px;
    background: linear-gradient(135deg,#6366f1,#8b5cf6); color: #fff;
    font-size: 12px; font-weight: 600; flex-shrink: 0;
  }
  .ed-reasons-mini { color: #6b7280; font-size: 11.5px; line-height: 1.55; white-space: normal; max-width: 340px; }
  .ed-reasons-mini span { display: inline-block; background: #f3f4f6; border-radius: 4px; padding: 0 6px; margin: 1px 4px 1px 0; }

  .ed-tag {
    display: inline-block; padding: 1px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 500; line-height: 1.6;
  }
  .tag-ok   { background: #d1fae5; color: #065f46; }
  .tag-info { background: #dbeafe; color: #1e40af; }
  .tag-mute { background: #f3f4f6; color: #6b7280; }
  .tag-bad  { background: #fee2e2; color: #991b1b; }
  .tag-warn { background: #fef3c7; color: #92400e; }

  .ed-pkg-toolbar {
    display: flex; align-items: center; gap: 14px; padding: 10px 12px; margin-bottom: 10px;
    background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;
    flex-wrap: wrap;
  }
  .ed-pkg-toolbar b { color: #4f46e5; font-weight: 600; }
  .ed-pkg-toolbar label { display: flex; align-items: center; gap: 6px; cursor: pointer; }

  .ed-llm-box {
    border: 1px solid #e5e7eb; background: #fafbff;
    border-radius: 10px; padding: 14px 16px;
  }
  .ed-llm-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  .ed-llm-textarea {
    width: 100%; box-sizing: border-box; min-height: 60px;
    padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 7px;
    font: inherit; font-size: 13px; line-height: 1.7; color: #1f2937;
    white-space: pre-wrap; word-break: break-word; background: #fff;
    resize: none; overflow: hidden; outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  .ed-llm-textarea:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.12); }

  .ed-drawer {
    position: fixed; top: 0; right: 0; width: 480px; max-width: 90vw; height: 100vh;
    background: #fff; z-index: 2147483001; box-shadow: -8px 0 24px rgba(0,0,0,.12);
    transform: translateX(100%); transition: transform .25s ease;
    display: flex; flex-direction: column;
  }
  .ed-drawer.open { transform: translateX(0); }
  .ed-drawer-head {
    padding: 14px 18px; border-bottom: 1px solid #e5e7eb;
    display: flex; justify-content: space-between; align-items: center; background: #f9fafb;
  }
  .ed-drawer-head h4 { margin: 0; font-size: 14px; font-weight: 600; }
  .ed-drawer-body { padding: 14px 18px; overflow: auto; flex: 1; }
  .ed-history-item {
    padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 7px;
    margin-bottom: 8px; font-size: 12px; background: #fff;
  }
  .ed-history-item .h { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .ed-history-item .h b { font-size: 13px; color: #111827; }
  .ed-history-item .m { color: #6b7280; font-size: 11px; margin-bottom: 6px; }
  .ed-history-item .llm { color: #4b5563; font-size: 12px; line-height: 1.5; max-height: 60px; overflow: hidden; }
  .ed-history-item .acts { margin-top: 6px; display: flex; gap: 6px; }

  .ed-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 2147482999;
    opacity: 0; pointer-events: none; transition: opacity .25s;
  }
  .ed-overlay.open { opacity: 1; pointer-events: auto; }
  `;

  // ============================== §9 面板骨架 ==============================
  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'egodms-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function createPanel() {
    const fab = document.createElement('button');
    fab.id = 'egodms-fab';
    fab.innerHTML = '质检<br>汇总';
    document.body.appendChild(fab);

    const overlay = document.createElement('div');
    overlay.className = 'ed-overlay';
    overlay.id = 'egodms-overlay';
    document.body.appendChild(overlay);

    const drawer = document.createElement('div');
    drawer.className = 'ed-drawer';
    drawer.id = 'egodms-drawer';
    drawer.innerHTML = `
      <div class="ed-drawer-head">
        <h4 id="egodms-drawer-title">抽屉</h4>
        <button class="ed-btn ghost" id="egodms-drawer-close">关闭</button>
      </div>
      <div class="ed-drawer-body" id="egodms-drawer-body"></div>
    `;
    document.body.appendChild(drawer);

    const panel = document.createElement('div');
    panel.id = 'egodms-panel';
    panel.innerHTML = `
      <div class="ed-header" id="egodms-header">
        <h3>深度项目质检结果导出</h3>
        <div class="ed-head-actions">
          <button class="ed-head-btn" id="egodms-btn-history">历史记录</button>
          <button class="ed-head-btn" id="egodms-btn-settings">设置</button>
          <button class="ed-close" id="egodms-btn-close" title="收起">×</button>
        </div>
      </div>
      <div class="ed-tabs">
        <button class="ed-tab active" data-tab="point">采集点汇总</button>
        <button class="ed-tab" data-tab="inspector">质检员绩效</button>
      </div>
      <div class="ed-body" id="egodms-body"></div>
    `;
    document.body.appendChild(panel);

    els = {
      fab, panel, drawer, overlay,
      header: panel.querySelector('#egodms-header'),
      body:   panel.querySelector('#egodms-body'),
      btnClose: panel.querySelector('#egodms-btn-close'),
      btnHistory: panel.querySelector('#egodms-btn-history'),
      btnSettings: panel.querySelector('#egodms-btn-settings'),
      drawerTitle: drawer.querySelector('#egodms-drawer-title'),
      drawerBody:  drawer.querySelector('#egodms-drawer-body'),
      drawerClose: drawer.querySelector('#egodms-drawer-close'),
    };

    fab.addEventListener('click', () => {
      panel.classList.add('open'); fab.style.display = 'none';
      renderActiveTab();
      if (!S.orgTree.length) loadOrgTreeIntoUi();
    });
    els.btnClose.addEventListener('click', () => { panel.classList.remove('open'); fab.style.display = ''; });
    els.btnHistory.addEventListener('click', openHistoryDrawer);
    els.btnSettings.addEventListener('click', openSettingsDrawer);
    els.drawerClose.addEventListener('click', closeDrawer);
    overlay.addEventListener('click', closeDrawer);

    panel.querySelectorAll('.ed-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    makeDraggable(panel, els.header);
  }

  function switchTab(tab) {
    if (S.tab === tab) return;
    if (S.tab === 'point') savePointTabForm();
    S.tab = tab;
    document.querySelectorAll('.ed-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    renderActiveTab();
  }

  function renderActiveTab() {
    if (S.tab === 'point') {
      renderFilterSection();
      if (S.result) renderResultSection();
      else if (S.filteredPackages.length) renderPackageSection();
    } else {
      renderInspectorTab();
      if (S.inspector.meta) renderInspectorResult();
    }
  }

  function makeDraggable(panel, handle) {
    let ox = 0, oy = 0;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      const mv = ev => {
        panel.style.left = Math.max(0, ev.clientX - ox) + 'px';
        panel.style.top  = Math.max(0, ev.clientY - oy) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }

  function setStatus(container, text, kind) {
    const el = container.querySelector('.ed-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'ed-status' + (kind ? ' ' + kind : '');
  }
  function setProgress(container, ratio) {
    const bar = container.querySelector('.ed-progress-bar > i');
    if (bar) bar.style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
  }

  // ============================== §10 Tab1 · 筛选区 ==============================
  function savePointTabForm() {
    const sec = els.filterSection;
    if (!sec) return;
    S.pointTabForm = {
      orgId:    sec.querySelector('#f-org').value,
      pointId:  sec.querySelector('#f-point').value,
      start:    sec.querySelector('#f-start').value,
      end:      sec.querySelector('#f-end').value,
      upload:   sec.querySelector('#f-upload').value,
      delivery: sec.querySelector('#f-delivery').value,
      eval:     sec.querySelector('#f-eval').value,
      sync:     sec.querySelector('#f-sync').value,
      dropZero: sec.querySelector('#f-drop-zero').checked,
    };
  }

  function renderFilterSection() {
    const f = S.pointTabForm || {};
    const now = new Date();
    const past = new Date(); past.setDate(past.getDate() - 90);
    const startVal = f.start || toDateInput(past);
    const endVal   = f.end   || toDateInput(now);

    els.body.innerHTML = `
      <div class="ed-step active"><span class="ed-step-num">1</span> 配置筛选条件</div>
      <div class="ed-card" id="egodms-filter-card">
        <div class="ed-filter">
          <div class="ed-field"><label>训练场</label><select class="ed-select" id="f-org"></select></div>
          <div class="ed-field"><label>采集点（留空 = 全部）</label><select class="ed-select" id="f-point"></select></div>
          <div class="ed-field"><label>开始日期</label><input class="ed-input" type="date" id="f-start" value="${esc(startVal)}"></div>
          <div class="ed-field"><label>结束日期</label><input class="ed-input" type="date" id="f-end" value="${esc(endVal)}"></div>
          <div class="ed-field">
            <label>回传状态</label>
            <select class="ed-select" id="f-upload">
              <option value="all">全部</option>
              <option value="done">上传完成</option>
              <option value="uploading">上传中</option>
              <option value="failed">上传失败</option>
            </select>
          </div>
          <div class="ed-field">
            <label>交付状态</label>
            <select class="ed-select" id="f-delivery">
              <option value="all">全部</option>
              <option value="delivered">已交付</option>
              <option value="deliverable">可交付</option>
              <option value="unset">未设置</option>
            </select>
          </div>
          <div class="ed-field">
            <label>评价状态</label>
            <select class="ed-select" id="f-eval">
              <option value="all">全部</option>
              <option value="done">已评价</option>
              <option value="pending">待评价</option>
            </select>
          </div>
          <div class="ed-field">
            <label>同步状态（单包）</label>
            <select class="ed-select" id="f-sync">
              <option value="all">全部</option>
              <option value="unsynced">未同步</option>
              <option value="partial">部分同步</option>
              <option value="synced">已同步</option>
            </select>
          </div>
        </div>
        <div class="ed-actions">
          <button class="ed-btn primary" id="f-run">拉取数据包</button>
          <button class="ed-btn secondary" id="f-reload-tree">刷新训练场列表</button>
          <label style="display:flex;align-items:center;gap:6px;color:#6b7280;font-size:12px;margin-left:auto;">
            <input type="checkbox" id="f-drop-zero" ${f.dropZero !== false ? 'checked' : ''}> 剔除完全未标注包
          </label>
        </div>
        <div class="ed-status" style="margin-top:10px;"></div>
      </div>
      <div id="egodms-result-area"></div>
    `;
    const section = els.body.querySelector('#egodms-filter-card');
    els.filterSection = section;
    els.resultArea = els.body.querySelector('#egodms-result-area');

    // 恢复表单状态
    section.querySelector('#f-upload').value   = f.upload   || 'done';
    section.querySelector('#f-delivery').value = f.delivery || 'delivered';
    section.querySelector('#f-eval').value     = f.eval     || 'done';
    section.querySelector('#f-sync').value     = f.sync     || 'all';

    section.querySelector('#f-org').addEventListener('change', () => {
      renderPointsSelect();
      savePointTabForm();
    });
    section.querySelector('#f-run').addEventListener('click', handleFetch);
    section.querySelector('#f-reload-tree').addEventListener('click', loadOrgTreeIntoUi);

    renderOrgSelect(f.orgId, f.pointId);
  }

  async function loadOrgTreeIntoUi() {
    const sec = els.filterSection;
    if (!sec) return;
    setStatus(sec, '正在加载训练场 / 采集点列表...');
    try {
      S.orgTree = await fetchOrgTree() || [];
      const f = S.pointTabForm || {};
      if (S.tab === 'point') renderOrgSelect(f.orgId, f.pointId);
      setStatus(sec, '训练场 / 采集点已加载');
    } catch (e) {
      err('loadOrgTree 失败', e);
      setStatus(sec, '加载失败：' + e.message + '（请在"设置"里确认 Token）', 'error');
    }
  }

  function renderOrgSelect(preferOrgId, preferPointId) {
    const sec = els.filterSection;
    if (!sec) return;
    const sel = sec.querySelector('#f-org');
    sel.innerHTML = '';
    for (const org of S.orgTree) {
      if (org.type !== 1) continue;
      const opt = document.createElement('option');
      opt.value = org.id; opt.textContent = org.name;
      sel.appendChild(opt);
    }
    const def = S.orgTree.find(o => o.type === 1 && o.name === DEFAULT_ORG_NAME);
    if (preferOrgId && S.orgTree.some(o => o.id === preferOrgId)) sel.value = preferOrgId;
    else if (def) sel.value = def.id;

    renderPointsSelect(preferPointId);
  }

  function renderPointsSelect(preferPointId) {
    const sec = els.filterSection;
    if (!sec) return;
    const sel = sec.querySelector('#f-point');
    sel.innerHTML = '';
    const orgId = sec.querySelector('#f-org').value;
    const org = S.orgTree.find(o => o.id === orgId);
    const children = (org && org.children) || [];
    const all = document.createElement('option');
    all.value = ''; all.textContent = '— 全部采集点 —';
    sel.appendChild(all);
    for (const c of children) {
      if (c.type !== 2) continue;
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.name;
      sel.appendChild(opt);
    }
    if (preferPointId && children.some(c => c.id === preferPointId)) sel.value = preferPointId;
    else {
      const def = children.find(c => c.type === 2 && c.name === DEFAULT_POINT_NAME);
      if (def) sel.value = def.id;
    }
  }

  async function handleFetch() {
    const sec = els.filterSection;
    if (!sec) return;
    savePointTabForm();
    const f = S.pointTabForm;
    const start = f.start.replace(/-/g, '');
    const end   = f.end.replace(/-/g, '');

    if (!f.orgId) { setStatus(sec, '请选择训练场', 'error'); return; }
    if (!start || !end) { setStatus(sec, '请选择完整日期', 'error'); return; }
    if (start > end) { setStatus(sec, '开始日期不能晚于结束日期', 'error'); return; }

    const btn = sec.querySelector('#f-run');
    btn.disabled = true;
    els.resultArea.innerHTML = '';
    S.result = null;
    S.selectedIds.clear();
    setStatus(sec, '正在拉取数据包列表...');

    try {
      const packages = await fetchPackageList(f.orgId, f.pointId, start, end);
      S.allFetchedPackages = packages;
      if (!packages.length) { setStatus(sec, '没有符合日期的数据包'); return; }

      let keep = packages;
      if (f.upload   !== 'all') keep = keep.filter(p => uploadStateOf(p).code   === f.upload);
      if (f.delivery !== 'all') keep = keep.filter(p => deliveryStateOf(p).code === f.delivery);
      if (f.eval     !== 'all') keep = keep.filter(p => evalStateOf(p).code     === f.eval);

      const syncMap = new Map();
      for (const p of keep) syncMap.set(p.id, syncStateOfPkg(p.id));
      S.syncStatusByPkg = syncMap;
      if (f.sync !== 'all') keep = keep.filter(p => (syncMap.get(p.id) || {}).status === f.sync);

      keep = sortByUploadTimeDesc(keep);
      S.filteredPackages = keep;
      S.selectedIds = new Set(keep.map(p => p.id));

      if (!keep.length) { setStatus(sec, `共 ${packages.length} 个包，筛选后 0 个`, 'error'); return; }

      const collectorCount = new Set(keep.map(p => (p.collector_name || '(未知采集员)'))).size;
      setStatus(sec, `共 ${packages.length} 个包 → 命中 ${keep.length} 个（涉及 ${collectorCount} 名采集员），已按上传时间倒序`, 'success');
      renderPackageSection();
    } catch (e) {
      err('handleFetch 失败', e);
      setStatus(sec, '拉取失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ============================== §11 Tab1 · 包选择区 ==============================
  function renderPackageSection() {
    const packages = S.filteredPackages;
    let html = '';
    html += '<div class="ed-step active" style="margin-top:12px"><span class="ed-step-num">2</span> 勾选要统计的数据包（按上传时间倒序）</div>';
    html += '<div class="ed-card">';
    html += `<div class="ed-pkg-toolbar">
      <label><input type="checkbox" id="pk-all" checked> 全选</label>
      <span>命中 <b id="pk-count">${S.selectedIds.size}</b> / ${packages.length}</span>
      <button class="ed-btn primary" id="pk-run" style="margin-left:auto">开始统计选中项</button>
    </div>`;
    html += '<div class="ed-table-wrap"><table class="ed-table"><thead><tr>';
    html += '<th style="width:36px"></th><th>上传时间 ↓</th><th>包名</th><th>编号</th><th>采集员</th><th>文件数</th><th>总大小</th><th>总时长</th><th>回传</th><th>交付</th><th>评价</th><th>同步</th>';
    html += '</tr></thead><tbody>';
    for (const p of packages) {
      const up = uploadStateOf(p), dv = deliveryStateOf(p), ev = evalStateOf(p);
      const syncInfo = S.syncStatusByPkg.get(p.id) || { status: 'unsynced', exportedAt: null, lastState: null };
      const synced = SYNC_LABEL[syncInfo.status];
      const title = syncInfo.exportedAt
        ? `末次导出：${fmtDateTime(syncInfo.exportedAt)}（当时标注：${syncInfo.lastState === 'full' ? '完整' : '部分'}）`
        : '从未导出过';
      const checked = S.selectedIds.has(p.id);
      html += `<tr>
        <td><input type="checkbox" class="pk-row" data-id="${esc(p.id)}" ${checked ? 'checked' : ''}></td>
        <td class="ed-upload-time">${esc(fmtDateTime(p.upload_finish_time))}</td>
        <td title="${esc(p.package_name)}">${esc(p.package_name)}</td>
        <td style="font-family:monospace;color:#6366f1">${esc(p.package_no)}</td>
        <td>${esc(p.collector_name || '-')}</td>
        <td class="num">${esc(p.total_files)}</td>
        <td class="num">${fmtSize(p.total_size)}</td>
        <td class="num">${p.collect_duration ? fmtSec(p.collect_duration) : '-'}</td>
        <td><span class="ed-tag ${up.cls}">${up.label}</span></td>
        <td><span class="ed-tag ${dv.cls}">${dv.label}</span></td>
        <td><span class="ed-tag ${ev.cls}">${ev.label}</span></td>
        <td><span class="ed-tag ${synced.cls}" title="${esc(title)}">${synced.dot} ${synced.label}</span></td>
      </tr>`;
    }
    html += '</tbody></table></div></div>';
    els.resultArea.innerHTML = html;

    const area = els.resultArea;
    const allBox = area.querySelector('#pk-all');
    const countEl = area.querySelector('#pk-count');
    const runBtn = area.querySelector('#pk-run');
    const rows = Array.from(area.querySelectorAll('.pk-row'));
    const refresh = () => {
      countEl.textContent = S.selectedIds.size;
      allBox.checked = packages.length > 0 && packages.every(p => S.selectedIds.has(p.id));
      allBox.indeterminate = !allBox.checked && S.selectedIds.size > 0;
      runBtn.disabled = S.selectedIds.size === 0;
    };
    allBox.addEventListener('change', () => {
      if (allBox.checked) packages.forEach(p => S.selectedIds.add(p.id));
      else packages.forEach(p => S.selectedIds.delete(p.id));
      rows.forEach(c => { c.checked = S.selectedIds.has(c.dataset.id); });
      refresh();
    });
    rows.forEach(c => c.addEventListener('change', () => {
      if (c.checked) S.selectedIds.add(c.dataset.id);
      else S.selectedIds.delete(c.dataset.id);
      refresh();
    }));
    runBtn.addEventListener('click', handleRunStats);
    refresh();
  }

  async function handleRunStats() {
    if (S.llmBusy) { alert('正在生成 LLM 总结，请稍候'); return; }
    const sec = els.filterSection;
    const selected = S.filteredPackages.filter(p => S.selectedIds.has(p.id));
    if (!selected.length) { setStatus(sec, '请至少选择一个数据包', 'error'); return; }
    const dropZero = sec.querySelector('#f-drop-zero').checked;
    const btn = els.resultArea.querySelector('#pk-run');
    btn.disabled = true;
    setStatus(sec, `正在拉取 ${selected.length} 个包的质检详情...`);
    let done = 0;

    try {
      const qcs = await mapLimit(selected, QC_CONCURRENCY, async (pkg) => {
        try { return await fetchQcDetail(pkg.id); }
        finally { done++; setStatus(sec, `正在拉取质检详情 ${done}/${selected.length}...`); }
      });

      const rows = [];
      let dropped = 0;
      for (let i = 0; i < selected.length; i++) {
        const pkg = selected[i];
        const qc = qcs[i];
        let analysis;
        if (qc && qc.__error) {
          analysis = {
            total: Number(pkg.collect_duration) || 0,
            annotatedDuration: 0, passedDuration: 0,
            groupCount: 0, annotatedCount: 0, failCount: 0, fails: [],
            progressDenom: 0, annotationState: 'none',
            reasonHist: new Map(), inspectors: new Map(),
          };
        } else {
          analysis = analyzeQc(pkg, qc);
        }
        if (dropZero && analysis.annotationState === 'none') { dropped++; continue; }
        rows.push({ pkg, analysis });
      }

      const orgName = sec.querySelector('#f-org').selectedOptions[0]?.textContent || '';
      const pointName = sec.querySelector('#f-point').selectedOptions[0]?.textContent || '';
      const pointLabel = (sec.querySelector('#f-point').value)
        ? pointName
        : (orgName + ' · 全部采集点');

      S.result = aggregateResult(rows, {
        orgName, pointName, pointLabel,
        start: S.pointTabForm.start.replace(/-/g, ''),
        end:   S.pointTabForm.end.replace(/-/g, ''),
        dropped,
        tripleHit: S.filteredPackages.length,
      });

      renderResultSection();
      const cc = S.result.collectors.length;
      setStatus(sec, `统计完成：${rows.length} 包、${cc} 名采集员、不合格视频 ${S.result.allFails.length} 条` + (dropped ? `，剔除未标注 ${dropped} 个` : ''), 'success');
      autoRunLlmIfPossible();
    } catch (e) {
      err('handleRunStats 失败', e);
      setStatus(sec, '统计失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ============================== §12 Tab1 · 结果区 ==============================
  function renderResultSection() {
    const r = S.result;
    if (!r) return;
    let html = '';
    html += '<div class="ed-step active" style="margin-top:16px"><span class="ed-step-num">3</span> 统计结果</div>';

    html += '<div class="ed-cards">';
    html += `<div class="ed-metric"><div class="k">采集点总时长</div><div class="v">${fmtSec(r.totalDuration)}</div><div class="s">${r.totalDuration.toLocaleString()} 秒</div></div>`;
    html += `<div class="ed-metric"><div class="k">已标注时长</div><div class="v">${fmtSec(r.annotatedDuration)}</div><div class="s">覆盖率 ${fmtPct(r.annotatedDuration, r.totalDuration)}</div></div>`;
    html += `<div class="ed-metric"><div class="k">合格时长</div><div class="v">${fmtSec(r.passedDuration)}</div><div class="s">合格率 ${fmtPct(r.passedDuration, r.annotatedDuration)}</div></div>`;
    html += `<div class="ed-metric"><div class="k">数据包</div><div class="v">${r.rows.length}</div><div class="s">筛选命中 ${r.meta.tripleHit}${r.meta.dropped ? ` · 剔除 ${r.meta.dropped}` : ''}</div></div>`;
    html += `<div class="ed-metric"><div class="k">不合格视频</div><div class="v" style="color:#dc2626">${r.allFails.length}</div><div class="s">${r.rows.reduce((s, x) => s + x.analysis.annotatedCount, 0)} 个已标注组</div></div>`;
    html += '</div>';

    html += `<div class="ed-actions ed-no-export" style="margin-top:0;margin-bottom:12px;">
      <button class="ed-btn primary" id="r-export">导出图片（唯一输出）</button>
      <button class="ed-btn secondary" id="r-back">← 重新选择数据包</button>
      <label style="display:flex;align-items:center;gap:6px;color:#6b7280;font-size:12px;margin-left:16px;">
        <input type="checkbox" id="r-exp-skipfail"> 不含不合格明细
      </label>
    </div>`;

    // 采集员汇总
    html += `<div class="ed-section-title"><span>按采集员分组 <span class="ed-sub">共 ${r.collectors.length} 人 · 按已标注时长排序</span></span></div>`;
    html += '<div class="ed-table-wrap unlimited"><table class="ed-table"><thead><tr>';
    html += '<th>采集员</th><th>包数</th><th>总时长</th><th>已标注</th><th>覆盖率</th><th>合格</th><th>合格率</th><th>不合格</th><th>主要问题</th>';
    html += '</tr></thead><tbody>';
    for (const c of r.collectors) {
      const avatar = (c.name || '?').slice(0, 1);
      const reasonsHtml = c.topReasons.length
        ? c.topReasons.map(([reason, n]) => `<span>${esc(reason.length > 26 ? reason.slice(0, 26) + '…' : reason)} ×${n}</span>`).join('')
        : '<span style="color:#9ca3af">无</span>';
      html += `<tr>
        <td><div class="ed-collector-cell"><span class="ed-avatar">${esc(avatar)}</span><b>${esc(c.name)}</b></div></td>
        <td class="num">${c.packages}</td>
        <td class="num">${fmtSec(c.total)}</td>
        <td class="num">${fmtSec(c.annotated)}</td>
        <td class="num">${fmtPct(c.annotated, c.total)}</td>
        <td class="num">${fmtSec(c.passed)}</td>
        <td class="num"><b>${fmtPct(c.passed, c.annotated)}</b></td>
        <td class="num" style="color:${c.failCount ? '#dc2626' : '#6b7280'}"><b>${c.failCount}</b></td>
        <td class="wrap"><div class="ed-reasons-mini">${reasonsHtml}</div></td>
      </tr>`;
    }
    html += '</tbody></table></div>';

    // 明细表
    html += `<div class="ed-section-title" style="justify-content:space-between">
      <span>数据包明细 <span class="ed-sub">${r.rows.length} 个 · 按上传时间倒序</span></span>
      <label class="ed-no-export" style="display:flex;align-items:center;gap:6px;color:#6b7280;font-size:11.5px;font-weight:400;cursor:pointer">
        <input type="checkbox" id="r-group-by-collector" ${S.groupByCollector ? 'checked' : ''}> 按采集员分组显示
      </label>
    </div>`;
    html += `<div id="r-detail-wrap"><div class="ed-table-wrap"><table class="ed-table">${buildDetailTableHtml(r.rows, S.groupByCollector)}</table></div></div>`;

    // 原因 Top
    if (r.reasons.length) {
      html += `<div class="ed-section-title"><span>不合格原因 Top <span class="ed-sub">全局合并同义</span></span></div>`;
      html += '<div class="ed-table-wrap"><table class="ed-table"><thead><tr><th>原因</th><th>出现次数</th></tr></thead><tbody>';
      for (const [reason, count] of r.reasons) {
        html += `<tr><td class="wrap">${esc(reason)}</td><td class="num"><b>${count}</b></td></tr>`;
      }
      html += '</tbody></table></div>';
    }

    // LLM
    html += `<div class="ed-section-title"><span>LLM 问题总结 <span class="ed-sub">按采集员给建议；可直接编辑</span></span></div>`;
    html += '<div class="ed-llm-box">';
    html += `<div class="ed-llm-toolbar ed-no-export">
      <button class="ed-btn primary" id="r-llm-run">${r.llmSummary ? '重新生成' : '生成问题总结'}</button>
      <button class="ed-btn secondary" id="r-llm-copy" ${r.llmSummary ? '' : 'disabled'}>复制总结</button>
      <span style="color:#6b7280;font-size:11px">模型：${LLM_MODEL} · 填好 API Key 后统计完成会自动分析</span>
    </div>`;
    const placeholderText = STORE.getLlmKey()
      ? '即将自动生成，或点上方按钮手动触发。生成后可直接在框中编辑。'
      : '未填写 API Key，请在"设置"中填写。也可点上方按钮手动触发。';
    html += `<textarea class="ed-llm-textarea" id="r-llm-ta" placeholder="${esc(placeholderText)}" rows="3">${esc(r.llmSummary || '')}</textarea>`;
    html += '</div>';

    // 不合格明细
    html += '<div class="ed-fail-section">';
    html += `<div class="ed-section-title"><span>不合格明细 <span class="ed-sub">${r.allFails.length} 条</span></span></div>`;
    if (!r.allFails.length) {
      html += '<div style="color:#9ca3af;padding:12px 2px">没有不合格视频 🎉</div>';
    } else {
      html += '<div class="ed-table-wrap unlimited"><table class="ed-table"><thead><tr>';
      html += '<th>上传时间</th><th>采集员</th><th>包名</th><th>编号</th><th>文件名</th><th>时长</th><th>得分</th><th>不合格原因</th><th>质检人</th>';
      html += '</tr></thead><tbody>';
      for (const f of r.allFails) {
        html += `<tr class="bad">
          <td class="ed-upload-time">${esc(fmtDateTime(f.packageUploadAt))}</td>
          <td>${esc(f.collectorName || '-')}</td>
          <td title="${esc(f.packageName)}">${esc(f.packageName)}</td>
          <td style="font-family:monospace">${esc(f.packageNo)}</td>
          <td class="wrap">${esc(f.fileName)}</td>
          <td class="num">${fmtSec(f.duration)}</td>
          <td class="num"><b style="color:#dc2626">${esc(f.score)}</b></td>
          <td class="wrap">${esc(f.reason).replace(/\n/g, '<br>')}</td>
          <td>${esc(f.inspector)}</td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    }
    html += '</div>';

    rebuildResultDom(html);
    bindResultHandlers();
    const ta = els.resultArea.querySelector('#r-llm-ta');
    if (ta) autoResizeTextarea(ta);
  }

  function buildDetailTableHtml(rows, groupBy) {
    const head = '<thead><tr>' +
      '<th>上传时间 ↓</th><th>包名</th><th>编号</th><th>采集员</th><th>标注</th><th>组数</th><th>已标注</th><th>不合格</th><th>总时长</th><th>已标注</th><th>合格</th><th>合格率</th>' +
      '</tr></thead>';
    let body = '<tbody>';
    if (!groupBy) {
      for (const { pkg, analysis } of rows) body += buildDetailRow(pkg, analysis);
    } else {
      const groups = new Map();
      for (const row of rows) {
        const k = (row.pkg.collector_name || '').trim() || '(未知采集员)';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(row);
      }
      const sorted = Array.from(groups.entries()).sort((a, b) => {
        const sa = a[1].reduce((s, x) => s + x.analysis.annotatedDuration, 0);
        const sb = b[1].reduce((s, x) => s + x.analysis.annotatedDuration, 0);
        return sb - sa;
      });
      for (const [name, list] of sorted) {
        const tTotal = list.reduce((s, x) => s + x.analysis.total, 0);
        const tAnno  = list.reduce((s, x) => s + x.analysis.annotatedDuration, 0);
        const tPass  = list.reduce((s, x) => s + x.analysis.passedDuration, 0);
        const tFails = list.reduce((s, x) => s + x.analysis.failCount, 0);
        body += `<tr class="group-row"><td colspan="12">
          👤 ${esc(name)}
          <span class="g-meta">· ${list.length} 个包 · 总时长 ${fmtSec(tTotal)} · 已标注 ${fmtSec(tAnno)} · 覆盖 ${fmtPct(tAnno, tTotal)} · 合格率 ${fmtPct(tPass, tAnno)} · 不合格 ${tFails}</span>
        </td></tr>`;
        for (const { pkg, analysis } of list) body += buildDetailRow(pkg, analysis);
      }
    }
    body += '</tbody>';
    return head + body;
  }

  function buildDetailRow(pkg, analysis) {
    const prog = analysis.progressDenom ? `${analysis.annotatedCount}/${analysis.progressDenom}` : '0/0';
    const stateLabel = analysis.annotationState === 'full' ? '完整' : (analysis.annotationState === 'partial' ? '部分' : '无');
    const stateCls = analysis.annotationState === 'full' ? 'tag-ok' : (analysis.annotationState === 'partial' ? 'tag-info' : 'tag-mute');
    return `<tr>
      <td class="ed-upload-time">${esc(fmtDateTime(pkg.upload_finish_time))}</td>
      <td title="${esc(pkg.package_name)}">${esc(pkg.package_name)}</td>
      <td style="font-family:monospace;color:#6366f1">${esc(pkg.package_no)}</td>
      <td>${esc(pkg.collector_name || '-')}</td>
      <td><span class="ed-tag ${stateCls}" title="标注进度 ${prog}">${stateLabel} ${prog}</span></td>
      <td class="num">${analysis.groupCount}</td>
      <td class="num">${analysis.annotatedCount}</td>
      <td class="num" style="color:${analysis.failCount ? '#dc2626' : '#6b7280'}">${analysis.failCount}</td>
      <td class="num">${fmtSec(analysis.total)}</td>
      <td class="num">${fmtSec(analysis.annotatedDuration)}</td>
      <td class="num">${fmtSec(analysis.passedDuration)}</td>
      <td class="num"><b>${fmtPct(analysis.passedDuration, analysis.annotatedDuration)}</b></td>
    </tr>`;
  }

  function rebuildResultDom(resultHtml) {
    els.resultArea.innerHTML = '';
    renderPackageSection();
    const wrap = document.createElement('div');
    wrap.innerHTML = resultHtml;
    while (wrap.firstChild) els.resultArea.appendChild(wrap.firstChild);
  }

  function bindResultHandlers() {
    const area = els.resultArea;
    const back = area.querySelector('#r-back');
    const exportBtn = area.querySelector('#r-export');
    const llmRun = area.querySelector('#r-llm-run');
    const llmCopy = area.querySelector('#r-llm-copy');
    const ta = area.querySelector('#r-llm-ta');
    const groupCb = area.querySelector('#r-group-by-collector');

    if (back) back.addEventListener('click', () => {
      if (S.llmBusy) { alert('正在生成 LLM 总结，请稍候'); return; }
      S.result = null;
      renderPackageSection();
    });
    if (exportBtn) exportBtn.addEventListener('click', exportResultAsImage);
    if (llmRun) llmRun.addEventListener('click', handleRunLlm);
    if (llmCopy) llmCopy.addEventListener('click', copyLlmSummary);
    if (groupCb) groupCb.addEventListener('change', () => {
      S.groupByCollector = groupCb.checked;
      const wrap = area.querySelector('#r-detail-wrap');
      if (wrap && S.result) {
        wrap.innerHTML = `<div class="ed-table-wrap"><table class="ed-table">${buildDetailTableHtml(S.result.rows, S.groupByCollector)}</table></div>`;
      }
    });
    if (ta) {
      ta.addEventListener('input', () => {
        if (S.result) S.result.llmSummary = ta.value;
        if (llmCopy) llmCopy.disabled = !ta.value.trim();
        if (llmRun) llmRun.textContent = ta.value.trim() ? '重新生成' : '生成问题总结';
        autoResizeTextarea(ta);
      });
    }
  }

  function autoResizeTextarea(ta) {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  }

  function autoRunLlmIfPossible() {
    if (!S.result) return;
    if (!STORE.getLlmKey() || !STORE.getLlmPrompt()) return;
    handleRunLlm();
  }

  async function handleRunLlm() {
    if (!S.result) return;
    if (S.llmBusy) return;
    const apiKey = STORE.getLlmKey();
    const prompt = STORE.getLlmPrompt();
    if (!apiKey) { alert('请先在"设置"中填写 DeepSeek API Key'); openSettingsDrawer(); return; }
    if (!prompt) { alert('请先在"设置"中填写系统提示词'); openSettingsDrawer(); return; }

    const area = els.resultArea;
    const btn = area.querySelector('#r-llm-run');
    const copyBtn = area.querySelector('#r-llm-copy');
    const ta = area.querySelector('#r-llm-ta');
    const oldLabel = btn.textContent;
    btn.disabled = true; btn.textContent = '生成中...';
    if (copyBtn) copyBtn.disabled = true;
    S.llmBusy = true;
    if (ta) { ta.value = ''; autoResizeTextarea(ta); }

    try {
      const text = await callLlm(prompt, apiKey, buildLlmInput(S.result));
      S.result.llmSummary = text;
      S.llmBusy = false;
      if (ta) { ta.value = text; autoResizeTextarea(ta); }
      if (copyBtn) copyBtn.disabled = false;
      btn.disabled = false; btn.textContent = '重新生成';
      setStatus(els.filterSection, 'LLM 问题总结已生成', 'success');
    } catch (e) {
      S.llmBusy = false;
      err('callLlm 失败', e);
      btn.disabled = false; btn.textContent = oldLabel;
      setStatus(els.filterSection, 'LLM 生成失败：' + e.message, 'error');
    }
  }

  async function copyLlmSummary() {
    const ta = els.resultArea.querySelector('#r-llm-ta');
    const text = ta ? ta.value : '';
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus(els.filterSection, 'LLM 总结已复制', 'success');
    } catch (e) {
      warn('复制失败，走兜底', e);
      const t = document.createElement('textarea');
      t.value = text; t.style.cssText = 'position:fixed;left:-9999px;';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); setStatus(els.filterSection, 'LLM 总结已复制', 'success'); }
      catch (e2) { err('兜底也失败', e2); setStatus(els.filterSection, '复制失败', 'error'); }
      document.body.removeChild(t);
    }
  }

  // ============================== §13 Tab2 · 质检员绩效 ==============================
  function renderInspectorTab() {
    const ins = S.inspector;
    const now = new Date();
    const past1y = new Date(); past1y.setDate(past1y.getDate() - 365);
    const startVal = ins.meta ? ins.meta.startInput : toDateInput(past1y);
    const endVal   = ins.meta ? ins.meta.endInput   : toDateInput(now);

    els.body.innerHTML = `
      <div class="ed-step active"><span class="ed-step-num">1</span> 抓取范围（全量，不按采集点区分）</div>
      <div class="ed-card" id="ins-filter-card">
        <div class="ed-filter" style="grid-template-columns: repeat(4, 1fr)">
          <div class="ed-field">
            <label>开始日期（包的采集日期，留空=不限）</label>
            <input class="ed-input" type="date" id="ins-start" value="${esc(startVal)}">
          </div>
          <div class="ed-field">
            <label>结束日期（留空=不限）</label>
            <input class="ed-input" type="date" id="ins-end" value="${esc(endVal)}">
          </div>
          <div class="ed-field">
            <label>并发数</label>
            <select class="ed-select" id="ins-conc">
              <option value="3">3（保守）</option>
              <option value="5" selected>5（推荐）</option>
              <option value="8">8（激进）</option>
            </select>
          </div>
          <div class="ed-field">
            <label>CSV 明细</label>
            <select class="ed-select" id="ins-detail">
              <option value="1" selected>包含逐条明细</option>
              <option value="0">仅汇总与按日期</option>
            </select>
          </div>
        </div>
        <div class="ed-actions">
          <button class="ed-btn primary" id="ins-run">开始抓取并分析</button>
          <button class="ed-btn danger" id="ins-abort" disabled>中止</button>
          <button class="ed-btn success" id="ins-export" disabled>导出 CSV</button>
        </div>
        <div class="ed-status" style="margin-top:10px;">说明：日期筛选作用于「数据包的采集日期」（接口能力），绩效聚合按「质检发生日期」统计。</div>
        <div class="ed-progress-bar"><i></i></div>
      </div>
      <div id="ins-result-area"></div>
    `;

    const sec = els.body.querySelector('#ins-filter-card');
    els.insFilterSection = sec;
    els.insResultArea = els.body.querySelector('#ins-result-area');

    const insStart = sec.querySelector('#ins-start');
    const insEnd = sec.querySelector('#ins-end');
    const insDetail = sec.querySelector('#ins-detail');
    insDetail.value = ins.includeDetail ? '1' : '0';

    insDetail.addEventListener('change', () => { S.inspector.includeDetail = insDetail.value === '1'; });

    sec.querySelector('#ins-run').addEventListener('click', () => handleInspectorFetch(sec));
    sec.querySelector('#ins-abort').addEventListener('click', () => {
      S.inspector.abort = true;
      setStatus(sec, '正在中止...', 'warn');
    });
    sec.querySelector('#ins-export').addEventListener('click', exportInspectorCsv);
  }

  async function handleInspectorFetch(sec) {
    if (S.inspector.busy) return;
    const startInput = sec.querySelector('#ins-start').value;
    const endInput   = sec.querySelector('#ins-end').value;
    const start = startInput ? startInput.replace(/-/g, '') : '';
    const end   = endInput   ? endInput.replace(/-/g, '')   : '';
    if (start && end && start > end) { setStatus(sec, '开始日期不能晚于结束日期', 'error'); return; }

    const conc = Number(sec.querySelector('#ins-conc').value) || 5;
    const runBtn   = sec.querySelector('#ins-run');
    const abortBtn = sec.querySelector('#ins-abort');
    const exportBtn = sec.querySelector('#ins-export');

    S.inspector.busy = true;
    S.inspector.abort = false;
    runBtn.disabled = true;
    abortBtn.disabled = false;
    exportBtn.disabled = true;
    if (els.insResultArea) els.insResultArea.innerHTML = '';
    setProgress(sec, 0);
    setStatus(sec, '正在拉取数据包列表...');

    try {
      // ① 拉全部包
      const packages = await fetchAllPackages(start, end, ({ page, pages, got, total }) => {
        setStatus(sec, `拉取数据包列表 ${page}/${pages}，已获取 ${got} / ${total} 个...`);
        setProgress(sec, pages ? page / pages * 0.15 : 0);
      });

      if (S.inspector.abort) { setStatus(sec, '已中止', 'warn'); return; }
      if (!packages.length) { setStatus(sec, '该范围内的数据包为空', 'error'); return; }

      log('全量包数：' + packages.length);

      // ② 大数量确认
      if (packages.length > 80) {
        const est = Math.ceil(packages.length / conc) * 0.35;
        const ok = confirm(
          `共 ${packages.length} 个数据包，需要逐个拉质检详情。\n` +
          `并发 ${conc}，预计耗时约 ${Math.ceil(est)} 秒。\n\n是否继续？`
        );
        if (!ok) { setStatus(sec, '已取消'); return; }
      }

      // ③ 批量拉 qc-page
      let done = 0;
      const qcs = await mapLimit(packages, conc, async (pkg) => {
        try { return await fetchQcDetail(pkg.id); }
        finally {
          done++;
          if (done % 3 === 0 || done === packages.length) {
            setStatus(sec, `拉取质检详情 ${done}/${packages.length}（${Math.round(done / packages.length * 100)}%）...`);
            setProgress(sec, 0.15 + (done / packages.length) * 0.85);
          }
        }
      }, () => S.inspector.abort);

      if (S.inspector.abort) {
        setStatus(sec, `已中止，已获取 ${done}/${packages.length} 个包的详情`, 'warn');
        return;
      }

      // ④ 抽记录
      setStatus(sec, '正在聚合质检记录...');
      const records = [];
      let failPackages = 0;
      for (let i = 0; i < packages.length; i++) {
        const pkg = packages[i];
        const qc = qcs[i];
        if (!qc || qc.__error) { failPackages++; continue; }
        const recs = extractInspectorRecords(pkg, qc);
        for (const r of recs) records.push(r);
      }

      // ⑤ 聚合
      const { summary, byDateInspectorList, byDateList } = aggregateInspectorPerf(records);

      S.inspector.records = records;
      S.inspector.summary = summary;
      S.inspector.byDateInspectorList = byDateInspectorList;
      S.inspector.byDateList = byDateList;
      S.inspector.meta = {
        startInput, endInput, start, end,
        packageCount: packages.length,
        failPackages,
        recordCount: records.length,
        inspectorCount: summary.length,
        generatedAt: new Date().toISOString(),
      };

      renderInspectorResult();
      exportBtn.disabled = records.length === 0;

      const failTip = failPackages ? `，${failPackages} 个包详情拉取失败` : '';
      setStatus(sec, `完成：${packages.length} 包 → ${records.length} 条质检记录、${summary.length} 名质检员${failTip}`, 'success');
      setProgress(sec, 1);
    } catch (e) {
      err('handleInspectorFetch 失败', e);
      setStatus(sec, '抓取失败：' + e.message, 'error');
    } finally {
      S.inspector.busy = false;
      runBtn.disabled = false;
      abortBtn.disabled = true;
    }
  }

  function renderInspectorResult() {
    const ins = S.inspector;
    const area = els.insResultArea;
    if (!area || !ins.meta) return;

    const m = ins.meta;
    const totalCount = ins.summary.reduce((s, x) => s + x.count, 0);
    const totalDuration = ins.summary.reduce((s, x) => s + x.duration, 0);
    const totalPass = ins.summary.reduce((s, x) => s + x.pass, 0);
    const totalFail = ins.summary.reduce((s, x) => s + x.fail, 0);
    const dateSet = new Set(ins.records.map(r => r.inspectDate));
    const pointSet = new Set(ins.records.map(r => r.pointName).filter(Boolean));

    let html = '';
    html += '<div class="ed-step active" style="margin-top:16px"><span class="ed-step-num">2</span> 绩效结果</div>';

    // 卡片
    html += '<div class="ed-cards">';
    html += `<div class="ed-metric"><div class="k">质检条数</div><div class="v">${totalCount}</div><div class="s">来自 ${m.packageCount} 个包</div></div>`;
    html += `<div class="ed-metric"><div class="k">质检总时长</div><div class="v">${fmtSec(totalDuration)}</div><div class="s">${totalDuration.toLocaleString()} 秒</div></div>`;
    html += `<div class="ed-metric"><div class="k">质检员</div><div class="v">${ins.summary.length}</div><div class="s">平均 ${(totalCount / (ins.summary.length || 1)).toFixed(0)} 条/人</div></div>`;
    html += `<div class="ed-metric"><div class="k">覆盖日期</div><div class="v">${dateSet.size}</div><div class="s">覆盖采集点 ${pointSet.size}</div></div>`;
    html += `<div class="ed-metric"><div class="k">合格 / 不合格</div><div class="v" style="color:#059669">${totalPass} <span style="color:#dc2626">/ ${totalFail}</span></div><div class="s">合格率 ${fmtPct(totalPass, totalPass + totalFail)}</div></div>`;
    html += '</div>';

    // 质检员汇总
    html += `<div class="ed-section-title"><span>质检员绩效汇总 <span class="ed-sub">共 ${ins.summary.length} 人 · 按质检条数排序</span></span></div>`;
    html += '<div class="ed-table-wrap unlimited"><table class="ed-table"><thead><tr>';
    html += '<th>#</th><th>质检员</th><th>质检条数</th><th>质检总时长</th><th>平均单条</th><th>合格数</th><th>不合格数</th><th>合格率</th><th>覆盖包数</th><th>覆盖采集点</th><th>质检天数</th><th>首次质检</th><th>末次质检</th>';
    html += '</tr></thead><tbody>';
    ins.summary.forEach((s, i) => {
      const avatar = (s.name || '?').slice(0, 1);
      html += `<tr>
        <td class="num" style="color:#9ca3af">${i + 1}</td>
        <td><div class="ed-collector-cell"><span class="ed-avatar">${esc(avatar)}</span><b>${esc(s.name)}</b></div></td>
        <td class="num"><b>${s.count}</b></td>
        <td class="num">${fmtSec(s.duration)}</td>
        <td class="num">${fmtSec(s.avgDuration)}</td>
        <td class="num" style="color:#059669"><b>${s.pass}</b></td>
        <td class="num" style="color:#dc2626">${s.fail}</td>
        <td class="num"><b>${fmtPct(s.pass, s.pass + s.fail)}</b></td>
        <td class="num">${s.packageCount}</td>
        <td class="num">${s.pointCount}</td>
        <td class="num">${s.dateCount}</td>
        <td class="ed-upload-time">${esc(fmtDateTime(s.firstTime))}</td>
        <td class="ed-upload-time">${esc(fmtDateTime(s.lastTime))}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';

    // 按日期汇总
    html += `<div class="ed-section-title"><span>按日期汇总 <span class="ed-sub">共 ${ins.byDateList.length} 天 · 倒序</span></span></div>`;
    html += '<div class="ed-table-wrap"><table class="ed-table"><thead><tr>';
    html += '<th>日期</th><th>质检员数</th><th>质检条数</th><th>质检总时长</th><th>覆盖采集点</th><th>质检员</th>';
    html += '</tr></thead><tbody>';
    for (const d of ins.byDateList) {
      html += `<tr>
        <td class="ed-upload-time"><b>${esc(d.date)}</b></td>
        <td class="num">${d.inspectorCount}</td>
        <td class="num"><b>${d.count}</b></td>
        <td class="num">${fmtSec(d.duration)}</td>
        <td class="num">${d.pointCount}</td>
        <td class="wrap" style="color:#6b7280;font-size:11.5px">${esc(d.inspectorsText)}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';

    // 日期 × 质检员
    html += `<div class="ed-section-title"><span>日期 × 质检员 <span class="ed-sub">共 ${ins.byDateInspectorList.length} 条 · 倒序</span></span></div>`;
    html += '<div class="ed-table-wrap"><table class="ed-table"><thead><tr>';
    html += '<th>日期</th><th>质检员</th><th>质检条数</th><th>质检总时长</th><th>合格</th><th>不合格</th><th>合格率</th><th>涉及包数</th><th>涉及采集点</th>';
    html += '</tr></thead><tbody>';
    for (const x of ins.byDateInspectorList) {
      html += `<tr>
        <td class="ed-upload-time">${esc(x.date)}</td>
        <td><b>${esc(x.inspector)}</b></td>
        <td class="num"><b>${x.count}</b></td>
        <td class="num">${fmtSec(x.duration)}</td>
        <td class="num" style="color:#059669">${x.pass}</td>
        <td class="num" style="color:${x.fail ? '#dc2626' : '#6b7280'}">${x.fail}</td>
        <td class="num">${fmtPct(x.pass, x.pass + x.fail)}</td>
        <td class="num">${x.packageCount}</td>
        <td class="wrap" style="color:#6b7280;font-size:11.5px">${esc(x.pointsText)}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';

    // 逐条明细（折叠）
    if (ins.includeDetail && ins.records.length) {
      html += `<div class="ed-section-title"><span>逐条质检明细 <span class="ed-sub">${ins.records.length} 条 · 最新在前</span></span></div>`;
      html += '<div class="ed-table-wrap"><table class="ed-table"><thead><tr>';
      html += '<th>质检时间</th><th>质检员</th><th>采集点</th><th>采集员</th><th>包名</th><th>文件名</th><th>时长</th><th>得分</th><th>结果</th>';
      html += '</tr></thead><tbody>';
      const sorted = ins.records.slice().sort((a, b) => (b.inspectTime || '').localeCompare(a.inspectTime || ''));
      for (const r of sorted) {
        const statusTag = r.status === 1
          ? '<span class="ed-tag tag-ok">合格</span>'
          : r.status === 2
            ? '<span class="ed-tag tag-bad">不合格</span>'
            : '<span class="ed-tag tag-mute">未知</span>';
        html += `<tr>
          <td class="ed-upload-time">${esc(fmtDateTime(r.inspectTime))}</td>
          <td>${esc(r.inspectorName)}</td>
          <td>${esc(r.pointName || '-')}</td>
          <td>${esc(r.collectorName || '-')}</td>
          <td title="${esc(r.packageName)}">${esc(r.packageName)}</td>
          <td class="wrap" style="font-size:11.5px">${esc(r.fileName)}</td>
          <td class="num">${fmtSec(r.duration)}</td>
          <td class="num"><b>${esc(r.score)}</b></td>
          <td>${statusTag}</td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    } else if (ins.records.length === 0) {
      html += '<div style="color:#9ca3af;padding:20px 2px;text-align:center">该范围内没有任何质检记录</div>';
    }

    area.innerHTML = html;
  }

  // CSV 导出（4 段，带 BOM）
  function exportInspectorCsv() {
    const ins = S.inspector;
    if (!ins.summary.length) { alert('没有可导出的数据'); return; }
    const m = ins.meta;
    const L = [];
    const push = arr => L.push(arr.map(csvEsc).join(','));

    push(['== 质检员绩效汇总 ==']);
    push(['导出时间', fmtDateTime(new Date().toISOString())]);
    push(['范围', (m.startInput || '不限') + ' ~ ' + (m.endInput || '不限'), '数据包数', m.packageCount, '质检记录数', m.recordCount]);
    push([]);
    push(['质检员','质检条数','质检总时长(秒)','质检总时长','平均单条(秒)','合格数','不合格数','合格率','覆盖包数','覆盖采集点','质检天数','首次质检','末次质检']);
    for (const s of ins.summary) {
      push([
        s.name, s.count, s.duration, fmtSec(s.duration), s.avgDuration.toFixed(1),
        s.pass, s.fail, fmtPct(s.pass, s.pass + s.fail),
        s.packageCount, s.pointCount, s.dateCount,
        fmtDateTime(s.firstTime), fmtDateTime(s.lastTime),
      ]);
    }

    push([]);
    push(['== 按日期汇总 ==']);
    push(['日期','质检员数','质检条数','质检总时长(秒)','质检总时长','覆盖采集点','质检员']);
    for (const d of ins.byDateList) {
      push([d.date, d.inspectorCount, d.count, d.duration, fmtSec(d.duration), d.pointCount, d.inspectorsText]);
    }

    push([]);
    push(['== 日期 × 质检员 ==']);
    push(['日期','质检员','质检条数','质检总时长(秒)','质检总时长','合格数','不合格数','合格率','涉及包数','涉及采集点']);
    for (const x of ins.byDateInspectorList) {
      push([
        x.date, x.inspector, x.count, x.duration, fmtSec(x.duration),
        x.pass, x.fail, fmtPct(x.pass, x.pass + x.fail),
        x.packageCount, x.pointsText,
      ]);
    }

    if (ins.includeDetail && ins.records.length) {
      push([]);
      push(['== 逐条质检明细 ==']);
      push(['质检时间','质检员','包名','编号','采集点','采集员','文件名','时长(秒)','得分','结果']);
      const sorted = ins.records.slice().sort((a, b) => (b.inspectTime || '').localeCompare(a.inspectTime || ''));
      for (const r of sorted) {
        push([
          fmtDateTime(r.inspectTime), r.inspectorName, r.packageName, r.packageNo,
          r.pointName, r.collectorName, r.fileName, r.duration, r.score,
          r.status === 1 ? '合格' : r.status === 2 ? '不合格' : '未知',
        ]);
      }
    }

    const csv = '\ufeff' + L.join('\r\n');   // BOM 防 Excel 中文乱码
    const filename = `质检员绩效_${m.start || 'ALL'}-${m.end || 'ALL'}_${todayStr()}.csv`;
    downloadTextFile(filename, csv, 'text/csv;charset=utf-8');
    setStatus(els.insFilterSection, 'CSV 已导出：' + filename, 'success');
  }

  // ============================== §14 抽屉 ==============================
  function openDrawer(title, bodyHtml, after) {
    els.drawerTitle.textContent = title;
    els.drawerBody.innerHTML = bodyHtml;
    els.drawer.classList.add('open');
    els.overlay.classList.add('open');
    if (after) after();
  }
  function closeDrawer() {
    els.drawer.classList.remove('open');
    els.overlay.classList.remove('open');
  }

  function openHistoryDrawer() {
    const list = STORE.getHistory();
    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="color:#6b7280;font-size:12px">共 ${list.length} 条导出记录</span>
      <button class="ed-btn secondary" id="h-clear" ${list.length ? '' : 'disabled'}>清空所有</button>
    </div>`;
    if (!list.length) {
      html += '<div style="color:#9ca3af;padding:20px 0;text-align:center">暂无记录，导出一次图片后会自动添加到这里</div>';
    } else {
      for (const e of list) {
        const sum = (e.llmSummary || '').trim();
        const preview = sum ? esc(sum.slice(0, 200)) + (sum.length > 200 ? '...' : '') : '<i style="color:#9ca3af">未保存 LLM 总结</i>';
        const collectorInfo = e.collectorCount ? ` · ${e.collectorCount} 名采集员` : '';
        html += `<div class="ed-history-item" data-id="${esc(e.id)}">
          <div class="h"><b>${esc(e.pointName)}</b><span class="ed-tag tag-info">${esc(e.dateRange)}</span></div>
          <div class="m">${fmtDateTime(e.time)} · ${e.packageCount} 包${collectorInfo} · 合格率 ${esc(e.passRate)} · 覆盖率 ${esc(e.coverRate)}</div>
          <div class="llm">${preview}</div>
          <div class="acts"><button class="ed-btn ghost h-del" data-id="${esc(e.id)}">删除此条</button></div>
        </div>`;
      }
    }
    openDrawer('导出历史', html, () => {
      const clearBtn = els.drawerBody.querySelector('#h-clear');
      if (clearBtn) clearBtn.addEventListener('click', () => {
        if (!confirm('确认清空所有历史记录？同步记录不会被清除。')) return;
        STORE.clearHistory();
        openHistoryDrawer();
      });
      els.drawerBody.querySelectorAll('.h-del').forEach(btn => {
        btn.addEventListener('click', () => {
          STORE.removeHistory(btn.dataset.id);
          openHistoryDrawer();
        });
      });
    });
  }

  function openSettingsDrawer() {
    const prompt = STORE.getLlmPrompt();
    const key = STORE.getLlmKey();
    const autoToken = findToken();
    const stats = STORE.getSyncStats();
    const html = `
      <div class="ed-field" style="margin-bottom:12px">
        <label>Token（优先取 localStorage 里的 JWT；下方填写则覆盖）</label>
        <input class="ed-input" id="s-token" type="text" value="${esc(S.tokenOverride)}" placeholder="${esc(autoToken || '留空则自动寻找')}" style="font-family:monospace">
      </div>
      <div class="ed-field" style="margin-bottom:12px">
        <label>DeepSeek API Key（本地保存，仅 Tab1 使用）</label>
        <input class="ed-input" id="s-key" type="password" value="${esc(key)}" placeholder="sk-..." autocomplete="off" style="font-family:monospace">
      </div>
      <div class="ed-field" style="margin-bottom:12px">
        <label>LLM 系统提示词（本地保存）</label>
        <textarea class="ed-input" id="s-prompt" rows="14" style="min-height:280px;resize:vertical">${esc(prompt)}</textarea>
      </div>
      <div class="ed-field" style="margin-bottom:12px">
        <label>同步记录（单包级，仅 Tab1 使用）</label>
        <div style="font-size:12px;color:#6b7280;margin-bottom:6px">
          已同步 <b style="color:#059669">${stats.full}</b> 个 ·
          部分同步 <b style="color:#2563eb">${stats.partial}</b> 个 ·
          合计 ${stats.total} 个
        </div>
        <button class="ed-btn secondary" id="s-sync-clear">清空同步记录</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="ed-btn primary" id="s-save">保存设置</button>
        <button class="ed-btn secondary" id="s-reset-prompt">还原默认提示词</button>
      </div>
    `;
    openDrawer('设置', html, () => {
      els.drawerBody.querySelector('#s-save').addEventListener('click', () => {
        S.tokenOverride = els.drawerBody.querySelector('#s-token').value.trim();
        STORE.setLlmKey(els.drawerBody.querySelector('#s-key').value.trim());
        STORE.setLlmPrompt(els.drawerBody.querySelector('#s-prompt').value);
        closeDrawer();
      });
      els.drawerBody.querySelector('#s-reset-prompt').addEventListener('click', () => {
        els.drawerBody.querySelector('#s-prompt').value = DEFAULT_LLM_PROMPT;
      });
      els.drawerBody.querySelector('#s-sync-clear').addEventListener('click', () => {
        if (!confirm('确认清空所有同步记录？所有包都会变成"未同步"。')) return;
        STORE.clearSyncRecord();
        openSettingsDrawer();
      });
    });
  }

  // ============================== §15 Tab1 · 导出图片 ==============================
  async function exportResultAsImage() {
    if (!S.result) return;
    if (typeof html2canvas !== 'function') { alert('html2canvas 未加载'); return; }
    const area = els.resultArea;
    const skipFails = area.querySelector('#r-exp-skipfail')?.checked;
    const btn = area.querySelector('#r-export');
    const oldLabel = btn.textContent;
    btn.disabled = true; btn.textContent = '生成中...';
    setStatus(els.filterSection, '正在生成图片...');

    let host = null;
    try {
      const compWidth = Math.max(1240, els.resultArea.scrollWidth + 32);
      host = document.createElement('div');
      host.style.cssText =
        'position:absolute;left:-99999px;top:0;background:#fff;padding:24px;' +
        'width:' + compWidth + 'px;box-sizing:border-box;' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'font-size:13px;color:#1f2937;';
      host.innerHTML = els.resultArea.innerHTML;

      const r = S.result;
      const headEl = document.createElement('div');
      headEl.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid #4f46e5;';
      headEl.innerHTML = `
        <div>
          <div style="font-size:20px;font-weight:700;color:#111827;margin-bottom:4px;">${esc(r.meta.pointLabel)} · 质检汇总</div>
          <div style="color:#6b7280;font-size:12px">数据日期 ${esc(r.meta.start)} ~ ${esc(r.meta.end)} · ${r.rows.length} 包 · ${r.collectors.length} 名采集员 · 生成于 ${fmtDateTime(new Date().toISOString())}</div>
        </div>
        <div style="color:#4f46e5;font-size:11px;font-weight:600;letter-spacing:1px">深度项目质检结果导出</div>
      `;
      host.insertBefore(headEl, host.firstChild);

      host.querySelectorAll('.ed-no-export').forEach(el => el.remove());
      host.querySelectorAll('.ed-step').forEach(el => el.remove());
      if (skipFails) host.querySelectorAll('.ed-fail-section').forEach(el => el.remove());

      host.querySelectorAll('.ed-pkg-toolbar').forEach(el => {
        const card = el.closest('.ed-card');
        if (card) card.remove();
      });

      host.querySelectorAll('.ed-llm-textarea').forEach(ta => {
        const text = ta.value || '';
        if (!text.trim()) { ta.closest('.ed-llm-box')?.remove(); return; }
        const div = document.createElement('div');
        div.className = 'ed-llm-textarea';
        div.style.cssText = 'height:auto;min-height:0;white-space:pre-wrap;word-break:break-word;line-height:1.75;padding:12px 14px;border:1px solid #e5e7eb;background:#fff;border-radius:7px;';
        div.textContent = text;
        ta.parentNode.replaceChild(div, ta);
      });

      host.querySelectorAll('.ed-table-wrap').forEach(w => {
        w.style.maxHeight = 'none'; w.style.overflow = 'visible'; w.style.border = '1px solid #e5e7eb';
      });
      host.querySelectorAll('.ed-table th').forEach(th => { th.style.position = 'static'; });

      const footEl = document.createElement('div');
      footEl.style.cssText = 'margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px;text-align:center;';
      footEl.textContent = '本图由深度项目质检结果导出自动生成 · 按采集员分组统计 · 排序：上传时间倒序';
      host.appendChild(footEl);

      document.body.appendChild(host);

      const canvas = await html2canvas(host, {
        backgroundColor: '#ffffff',
        scale: Math.min(2, (window.devicePixelRatio || 1) * 1.5),
        useCORS: true,
        logging: false,
        width: compWidth,
        windowWidth: compWidth,
      });

      const safe = s => (s || '').replace(/[\\/:*?"<>|]/g, '_');
      const filename = `${safe(r.meta.pointLabel)}_质检汇总_${todayStr()}${skipFails ? '_精简' : ''}.png`;
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);

      STORE.markPackagesSynced(r.rows.map(x => ({ id: x.pkg.id, annotationState: x.analysis.annotationState })));

      STORE.addHistory({
        id: uuid(),
        time: new Date().toISOString(),
        pointName: r.meta.pointLabel,
        dateRange: r.meta.start + '-' + r.meta.end,
        packageIds: r.rows.map(x => x.pkg.id),
        packageCount: r.rows.length,
        collectorCount: r.collectors.length,
        passRate: fmtPct(r.passedDuration, r.annotatedDuration),
        coverRate: fmtPct(r.annotatedDuration, r.totalDuration),
        llmSummary: r.llmSummary || '',
      });

      for (const x of r.rows) S.syncStatusByPkg.set(x.pkg.id, syncStateOfPkg(x.pkg.id));

      setStatus(els.filterSection, '图片已导出：' + filename + '（已标记 ' + r.rows.length + ' 个包的同步状态）', 'success');
    } catch (e) {
      err('exportResultAsImage 失败', e);
      setStatus(els.filterSection, '导出失败：' + e.message, 'error');
    } finally {
      if (host && host.parentNode) host.parentNode.removeChild(host);
      btn.disabled = false; btn.textContent = oldLabel;
    }
  }

  // ============================== §16 入口 ==============================
  function boot() {
    if (document.getElementById('egodms-panel')) { info('面板已存在，跳过'); return; }
    injectStyles();
    createPanel();
    info('深度项目质检结果导出已就绪（双 Tab）');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();