// ==UserScript==
// @name         穹彻DM3平台每日工作量导出
// @namespace    https://dm3.noematrix.cn/
// @version      2.0.1
// @description  管理员视角：一次导出组级(team56) + 记录级(team55)全部任务。抽检任务走 logs 取标注员提交日，未抽检用 updated_at 兜底。按日 × 人汇总。
// @match        https://dm3.noematrix.cn/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

// 副作用声明：
// - Hook window.fetch / XMLHttpRequest.open / setRequestHeader（document-start 必需，用于捕获 Bearer token）
// - 只读遍历 window.localStorage / window.sessionStorage（找 JWT），不写入
// - 写入 localStorage 键 `__DQX2_CFG__`（保存面板配置）
// - 向 https://dm3.noematrix.cn/api/v1/* 发 GET（同源 fetch，带页面 cookie，带 Bearer）
// - 注入 #dqx2-fab / #dqx2-panel / <style> 到 document.body / document.head
// - @grant none，故 window 即 unsafeWindow，未额外申请 GM_* 权限
// - 挂载调试命名空间 window.__DQX2_DEBUG__（可 delete 清理；不覆盖其他全局）
// - 全局重入标记 window.__DQX2_LOADED__

// 控制台定位本脚本问题：
// 1. F12 → Console → 过滤框输入 [DQX2]
// 2. 展开红色 error 行堆栈，点击跳到 Sources 对应行
// 3. 在 installFetchHook / runExport / renderReport / mount 处下断点
// 4. 检查内部状态：Console 输入 __DQX2_DEBUG__.state

(function () {
  'use strict';

  /* ============================================================
   * 模块划分（本文件约 700 行，分 10 段）
   *   0. 常量 / 状态 / 调试命名空间
   *   1. token 捕获（Hook fetch & XHR）
   *   2. 基础工具（时区工作日 / JWT / 众数 / 转义 / 数值）
   *   3. token 候选池与打分
   *   4. HTTP（同源 fetch + 退避重试）
   *   5. leader_tasks 全量拉取（自适应 page_size）
   *   6. 单任务 logs 拉取（抽检任务专用）
   *   7. 事实表构建（记录级 / 组级）
   *   8. 聚合（按日 / 按日×人）
   *   9. 主流程 runExport
   *  10. UI 面板 + 结果渲染 + 下载
   *  11. 启动
   * ========================================================== */

  /* ------------------------------------------------------------
   * 0. 常量 / 状态 / 调试命名空间
   * ---------------------------------------------------------- */
  if (window.__DQX2_LOADED__) return;
  window.__DQX2_LOADED__ = true;

  const TAG = '[DQX2]';
  const VERSION = '2.0.1';
  const SCHEMA = 'dq-report/2';
  const CFG_KEY = '__DQX2_CFG__';

  // 被选中审核的状态集合（用于判断“是不是一个已提交的抽检任务”）
  const SUBMITTED_STATUS = new Set(['closed', 'pending_review', 'reviewing']);
  const NUM_RE = /^\d+$/;
  const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/;

  const DEFAULT_CFG = {
    teamRecord: 55,       // 记录级 team_id
    teamGroup: 56,        // 组级 team_id
    orgId: 25,
    role: 'dq:user:leader',
    pageSize: 10000,      // 允许 10000，自适应退回
    concurrency: 6,       // logs 并发
    delayMs: 120,         // 请求最小间隔
    cutoffHour: 0,        // 跨天切点
    fetchLogs: true,      // 精确模式：抽检任务拉 logs
    logsTimeoutMs: 10000, // 单条 logs 超时
  };

  const state = {
    running: false,
    aborted: false,
    token: null,
    tokenFrom: null,
    claims: {},
    cfg: null,
    report: null,
    fileName: '',
    // 运行时统计，供调试与 integrity 使用
    stats: {
      pagesFetched: { record: 0, group: 0 },
      pageSizeActual: { record: 0, group: 0 },
      logsRequested: 0,
      logsFailed: 0,
    },
  };

  const debug = (window.__DQX2_DEBUG__ = {
    version: VERSION,
    state: state,
    log: (...a) => console.debug(TAG, ...a),
    candidates: () => rankedCandidates(),
    report: () => state.report,
  });

  /* ------------------------------------------------------------
   * 1. token 捕获（Hook，与 v1.0.2 一致，保留）
   * ---------------------------------------------------------- */
  const captured = { list: [], seen: new Set(), orgId: null };

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && input.url) return String(input.url);
    } catch (e) { console.debug(TAG, 'urlOf failed', e); }
    return '';
  }

  function pushCaptured(token, url) {
    try {
      if (!token || captured.seen.has(token)) return;
      captured.seen.add(token);
      captured.list.push({ token: token, url: url || '', at: Date.now() });
      while (captured.list.length > 40) {
        const drop = captured.list.shift();
        captured.seen.delete(drop.token);
      }
    } catch (e) { console.debug(TAG, 'pushCaptured failed', e); }
  }

  function installFetchHook() {
    try {
      const _fetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          let h = (init && init.headers) || null;
          if (!h && input && typeof input === 'object' && input.headers) h = input.headers;
          if (h) {
            const get = (name) => {
              const key = name.toLowerCase();
              if (typeof h.get === 'function') return h.get(name);
              if (Array.isArray(h)) {
                const hit = h.find((x) => Array.isArray(x) && String(x[0]).toLowerCase() === key);
                return hit ? hit[1] : null;
              }
              for (const k of Object.keys(h)) if (k.toLowerCase() === key) return h[k];
              return null;
            };
            const auth = get('authorization');
            if (auth && /^Bearer\s+/i.test(auth)) {
              pushCaptured(String(auth).replace(/^Bearer\s+/i, '').trim(), urlOf(input));
            }
            const org = get('x-org-id');
            if (org) captured.orgId = Number(org);
          }
        } catch (e) {
          console.debug(TAG, 'fetch hook header parse failed', e);
        }
        return _fetch.apply(this, arguments);
      };
    } catch (e) {
      console.error(TAG, 'installFetchHook failed', e);
    }
  }

  function installXhrHook() {
    try {
      const _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) {
        try { this.__dqx2Url = String(u || ''); }
        catch (e) { console.debug(TAG, 'xhr url capture failed', e); }
        return _open.apply(this, arguments);
      };
      const _setHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        try {
          const key = String(k).toLowerCase();
          if (key === 'authorization' && /^Bearer\s+/i.test(v)) {
            pushCaptured(String(v).replace(/^Bearer\s+/i, '').trim(), this.__dqx2Url);
          }
          if (key === 'x-org-id') captured.orgId = Number(v);
        } catch (e) {
          console.debug(TAG, 'xhr hook header parse failed', e);
        }
        return _setHeader.apply(this, arguments);
      };
    } catch (e) {
      console.error(TAG, 'installXhrHook failed', e);
    }
  }

  installFetchHook();
  installXhrHook();

  /* ------------------------------------------------------------
   * 2. 基础工具
   * ---------------------------------------------------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const round4 = (v) => (v == null || isNaN(v) ? null : Math.round(v * 1e4) / 1e4);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function fmtPct(v) {
    return v == null || v === '' ? '—' : (v * 100).toFixed(1) + '%';
  }

  function isNum(v) {
    return v != null && NUM_RE.test(String(v).trim());
  }

  const DTF = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  function workDate(iso, cutoffHour) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const shifted = new Date(d.getTime() - (Number(cutoffHour) || 0) * 3600 * 1000);
    const parts = DTF.formatToParts(shifted);
    const pick = (t) => (parts.find((p) => p.type === t) || {}).value;
    const y = pick('year'), m = pick('month'), dd = pick('day');
    if (!y || !m || !dd) return null;
    return y + '-' + m + '-' + dd;
  }

  function todayStr() {
    const parts = DTF.formatToParts(new Date());
    const pick = (t) => (parts.find((p) => p.type === t) || {}).value;
    return pick('year') + '-' + pick('month') + '-' + pick('day');
  }

  function decodeJwt(tok) {
    try {
      const part = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
      const bin = atob(padded);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch (e) {
      console.warn(TAG, 'decodeJwt failed', e);
      return {};
    }
  }

  function shortHash(s) {
    let h = 2166136261 >>> 0;
    const str = String(s == null ? '' : s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function modeOf(items) {
    const cnt = new Map();
    let best = null, bestN = 0;
    for (let i = 0; i < items.length; i++) {
      let v = items[i];
      if (v === null || v === undefined) continue;
      v = String(v).trim();
      if (!v) continue;
      const n = (cnt.get(v) || 0) + 1;
      cnt.set(v, n);
      if (n > bestN) { best = v; bestN = n; }
    }
    return { value: best, count: bestN };
  }

  /* ------------------------------------------------------------
   * 3. token 候选池与打分
   * ---------------------------------------------------------- */
  function buildCandidates() {
    const out = [];
    const seen = new Set();
    const add = (token, from, url) => {
      if (!token || seen.has(token)) return;
      seen.add(token);
      out.push({ token: token, from: from, url: url || '' });
    };

    captured.list.forEach((t) => add(t.token, 'network', t.url));

    for (const store of [window.localStorage, window.sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          const val = store.getItem(key);
          if (!val || val.indexOf('eyJ') < 0) continue;
          const m = val.match(JWT_RE);
          if (m) add(m[0], key, '');
        }
      } catch (e) {
        console.debug(TAG, 'storage scan failed', e);
      }
    }
    return out;
  }

  function analyzeCandidate(c) {
    const cl = decodeJwt(c.token) || {};
    let score = 0;
    const notes = [];
    if (isNum(cl.user_id)) { score += 120; notes.push('user_id 数字(+120)'); }
    else if (isNum(cl.uid)) { score += 70; notes.push('uid 数字(+70)'); }
    else if (cl.sub != null) { score += 5; notes.push('仅 sub(+5)'); }
    if (cl.exp) {
      if (cl.exp * 1000 > Date.now()) { score += 30; notes.push('未过期(+30)'); }
      else { score -= 60; notes.push('已过期(-60)'); }
    }
    if (/\/api\/v1\//.test(c.url)) { score += 60; notes.push('业务接口(+60)'); }
    if (/token|auth|jwt|access/i.test(c.from)) { score += 10; notes.push('键名匹配(+10)'); }
    return { score: score, claims: cl, notes: notes };
  }

  function rankedCandidates() {
    return buildCandidates()
      .map((c) => Object.assign({}, c, analyzeCandidate(c)))
      .sort((a, b) => b.score - a.score);
  }

  function resolveToken() {
    const r = rankedCandidates();
    if (!r.length) return null;
    return { token: r[0].token, from: r[0].from, score: r[0].score };
  }

  function currentToken() {
    if (state.tokenFrom === 'manual' && state.token) {
      return { token: state.token, from: 'manual', score: 999 };
    }
    return resolveToken();
  }

  /* ------------------------------------------------------------
   * 4. HTTP（同源 fetch + 退避重试）
   * ---------------------------------------------------------- */
  let _lastReqAt = 0;

  async function http(path, params, opts) {
    opts = opts || {};
    const url = new URL('/api/v1' + path, location.origin);
    if (params) {
      Object.keys(params).forEach((k) => {
        if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]);
      });
    }

    const cfg = state.cfg || DEFAULT_CFG;
    const timeoutMs = opts.timeoutMs || 20000;
    let lastErr = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      if (state.aborted) throw new Error('已停止');

      const wait = (cfg.delayMs || 0) - (Date.now() - _lastReqAt);
      if (wait > 0) await sleep(wait);
      _lastReqAt = Date.now();

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      let resp;
      try {
        resp = await fetch(url.toString(), {
          method: 'GET',
          credentials: 'include',
          signal: ctrl.signal,
          headers: {
            accept: 'application/json, text/plain, */*',
            authorization: 'Bearer ' + state.token,
            'x-org-id': String(cfg.orgId),
          },
        });
      } catch (e) {
        clearTimeout(timer);
        lastErr = new Error('网络/超时(' + (e.name || 'Error') + ')：' + (e.message || ''));
        await sleep(600 * (attempt + 1));
        continue;
      }
      clearTimeout(timer);

      if (resp.status === 401 || resp.status === 403) {
        throw new Error('鉴权失败(HTTP ' + resp.status + ')：token 过期或无权 ' + path);
      }
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error('HTTP ' + resp.status + ' ' + path);
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status + ' ' + path);
      }

      let body;
      try {
        body = await resp.json();
      } catch (e) {
        throw new Error('响应不是合法 JSON：' + path);
      }

      if (body && body.code !== undefined && String(body.code) !== '0') {
        throw new Error('接口 code=' + body.code + ' msg=' + (body.msg || '') + ' path=' + path);
      }
      return body && body.data !== undefined ? body.data : body;
    }

    throw lastErr || new Error('请求失败：' + path);
  }

  /* ------------------------------------------------------------
   * 5. leader_tasks 全量拉取（自适应 page_size）
   *
   * 说明：
   * - 只认 data.leader_tasks（t1/t2 对管理员为 null）
   * - 期望 page_size=10000，若服务端截断（回传 page_size < 请求值），
   *   用回传值继续翻页；同时把 pageSizeActual 记到 stats 供 integrity 报告
   * - 分页游标：leader_page 从 1 递增
   * - 到达条件：累计 >= total，或某页新增为 0，或回传 list 长度 < pageSizeActual
   * ---------------------------------------------------------- */
  async function fetchLeaderTasks(teamId, kind, onProgress) {
    const acc = [];
    const seen = new Set();
    let page = 1;
    let total = null;
    let ps = state.cfg.pageSize;

    for (let guard = 0; guard < 1000; guard++) {
      if (state.aborted) throw new Error('已停止');

      const data = await http('/dq/workbench/snapshot', {
        team_id: teamId,
        role: state.cfg.role,
        leader_page: page,
        t1_page: 1,
        t2_page: 1,
        page_size: ps,
      });
      state.stats.pagesFetched[kind] = page;

      const seg = data && data.leader_tasks;
      if (!seg || !Array.isArray(seg.list)) {
        if (page === 1) throw new Error('接口未返回 leader_tasks 列表（team_id=' + teamId + '）');
        break;
      }
      if (typeof seg.total === 'number') total = seg.total;
      // 自适应：取第一次回传的 page_size 作为真实值（服务端可能截断）
      if (typeof seg.page_size === 'number' && seg.page_size > 0) {
        ps = seg.page_size;
        state.stats.pageSizeActual[kind] = ps;
      }

      let added = 0;
      for (let i = 0; i < seg.list.length; i++) {
        const it = seg.list[i];
        if (!it || it.id === undefined || it.id === null) continue;
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        acc.push(it);
        added++;
      }

      if (onProgress) onProgress(acc.length, total === null ? acc.length : total, page);

      if (added === 0) break;
      if (seg.list.length < ps) break;                       // 拿到不足一页 = 到底
      if (total !== null && acc.length >= total) break;
      page++;
    }

    // 数量核对（不一致仅 warn，不崩）
    if (total !== null && acc.length !== total) {
      console.warn(TAG, '[fetchLeaderTasks] 数量不一致', { kind: kind, fetched: acc.length, total: total });
    }
    return { list: acc, total: total === null ? acc.length : total, pageSizeActual: ps };
  }

  /* ------------------------------------------------------------
   * 6. 单任务 logs 拉取（抽检任务专用）
   * ---------------------------------------------------------- */
  async function fetchTaskLogs(taskId) {
    const arr = await http('/dq/reviews/tasks/' + taskId + '/logs', null, {
      timeoutMs: state.cfg.logsTimeoutMs,
    });
    return Array.isArray(arr) ? arr.slice() : [];
  }

  /* 从 logs 中提取“标注员提交”的时间和“复核完成”的 action */
  function extractFromLogs(events) {
    if (!events || !events.length) return { submit_at: null, review_action: null, has_conflict: false };

    const sorted = events.slice().sort((a, b) =>
      String((a && a.created_at) || '').localeCompare(String((b && b.created_at) || ''))
    );

    let submit = null;
    let reviewDone = null;
    for (const e of sorted) {
      const action = String((e && e.action) || '');
      if (action.indexOf('inspector_submit') === 0) submit = e;
      if (action.indexOf('reviewer_submit') === 0) reviewDone = e;
    }
    return {
      submit_at: submit ? submit.created_at || null : null,
      review_action: reviewDone ? reviewDone.action : null,
      has_conflict: reviewDone ? /conflict/i.test(String(reviewDone.action)) : false,
    };
  }

  /* ------------------------------------------------------------
   * 7. 事实表构建
   *
   * 每条任务统一字段（抽检与否都填）：
   *   task_id, task_kind(record|group), batch_id, inspector_user_id, inspector_name,
   *   status, sampled, reviewed, overridden,
   *   submit_at, submit_date, date_source(log|updated_at|fallback),
   *   episode_count, review_org_id, log_error
   * 组级额外：episode_uuids[]（组级 episodes 数组的 uuid 列表）
   * 记录级额外：episode_uuid（单条）
   * ---------------------------------------------------------- */
  function buildRows(tasks, kind) {
    const isGroup = kind === 'group';
    return tasks.map((t) => {
      const sampled = !!t.is_review_sampled;
      const status = String(t.status || '');
      const reviewed = sampled && status === 'closed';
      const overridden = reviewed && !!t.has_review_conflict;

      const episodes = Array.isArray(t.episodes) ? t.episodes : [];
      const episodeUuids = episodes
        .map((e) => (e && e.episode_uuid) || null)
        .filter((v) => !!v);

      return {
        task_id: t.id,
        task_kind: kind,
        batch_id: t.batch_id === undefined ? null : t.batch_id,
        batch_name: t.batch_name || null,
        inspector_user_id: t.inspector_user_id === undefined ? null : t.inspector_user_id,
        inspector_name: t.inspector_name || null,
        status: status,
        sampled: sampled,
        reviewed: reviewed,
        overridden: overridden,
        review_org_id: t.review_org_id === undefined ? null : t.review_org_id,

        submit_at: null,
        submit_date: null,
        date_source: null,

        episode_count: isGroup ? episodes.length : 1,
        episode_uuid: isGroup ? null : (t.episode_uuid || (episodeUuids[0] || null)),
        episode_uuids: isGroup ? episodeUuids : null,

        log_error: null,
        _t: t, // 临时引用，输出前删除
      };
    });
  }

  /* 对一批已提交的抽检任务并发拉 logs，填 submit_at / submit_date */
  async function fillLogsBatch(rows, kind, onProgress) {
    if (!rows.length) return;
    const conc = Math.min(state.cfg.concurrency, rows.length);
    let cursor = 0;
    let done = 0;

    const workers = [];
    for (let w = 0; w < conc; w++) {
      workers.push((async () => {
        for (;;) {
          if (state.aborted) return;
          const idx = cursor++;
          if (idx >= rows.length) return;
          const row = rows[idx];
          state.stats.logsRequested++;
          try {
            const events = await fetchTaskLogs(row.task_id);
            const ex = extractFromLogs(events);
            if (ex.submit_at) {
              row.submit_at = ex.submit_at;
              row.submit_date = workDate(ex.submit_at, state.cfg.cutoffHour);
              row.date_source = 'log';
            }
            if (ex.review_action) {
              row.reviewed = true;
              row.overridden = ex.has_conflict;
            }
          } catch (e) {
            row.log_error = (e && e.message) ? e.message : String(e);
            state.stats.logsFailed++;
            console.error(TAG, '[fillLogsBatch] task ' + row.task_id + ' log failed', e);
            // 鉴权失败直接中断整批（token 已失效，继续拉只是刷屏）
            if (row.log_error.indexOf('鉴权失败') >= 0) throw e;
          }
          done++;
          if (onProgress && (done % 5 === 0 || done === rows.length)) {
            onProgress(done, rows.length, kind);
          }
        }
      })());
    }

    try {
      await Promise.all(workers);
    } catch (e) {
      console.error(TAG, '[fillLogsBatch] worker aborted', e);
      state.aborted = false; // 允许后续降级继续
    }
  }

  /* ------------------------------------------------------------
   * 8. 聚合
   *
   * dailyCombined: [{date, group: {...}, record: {...}, total: {...}}]
   * dailyByPerson: [{date, inspector_user_id, inspector_name, group, record, total}]
   * ---------------------------------------------------------- */
  function emptyBucket() {
    return {
      submitted: 0,
      sampled: 0,
      reviewed: 0,
      approved: 0,
      overridden: 0,
      pending: 0,
    };
  }

  function bumpBucket(b, r) {
    b.submitted++;
    if (r.sampled) {
      b.sampled++;
      if (r.reviewed) {
        b.reviewed++;
        if (r.overridden) b.overridden++;
        else b.approved++;
      } else {
        b.pending++;
      }
    }
  }

  function finalizeBucket(b) {
    b.decided = b.approved + b.overridden;
    b.sample_rate = b.submitted ? round4(b.sampled / b.submitted) : null;
    b.approve_rate = b.decided ? round4(b.approved / b.decided) : null;
    b.maturity = b.pending > 0 ? 'provisional' : 'final';
    return b;
  }

  function aggregateByDate(rows) {
    const map = new Map();
    for (const r of rows) {
      if (!r.submit_date) continue;
      let d = map.get(r.submit_date);
      if (!d) {
        d = {
          date: r.submit_date,
          group: emptyBucket(),
          record: emptyBucket(),
        };
        map.set(r.submit_date, d);
      }
      bumpBucket(r.task_kind === 'group' ? d.group : d.record, r);
    }
    const out = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    for (const d of out) {
      finalizeBucket(d.group);
      finalizeBucket(d.record);
      // 合并 total
      const t = emptyBucket();
      for (const k of ['submitted', 'sampled', 'reviewed', 'approved', 'overridden', 'pending']) {
        t[k] = d.group[k] + d.record[k];
      }
      d.total = finalizeBucket(t);
    }
    return out;
  }

  function aggregateByDateAndPerson(rows) {
    const map = new Map();
    for (const r of rows) {
      if (!r.submit_date) continue;
      const uid = r.inspector_user_id == null ? 'unknown' : String(r.inspector_user_id);
      const key = r.submit_date + '|' + uid;
      let d = map.get(key);
      if (!d) {
        d = {
          date: r.submit_date,
          inspector_user_id: r.inspector_user_id,
          inspector_name: r.inspector_name || '',
          group: emptyBucket(),
          record: emptyBucket(),
        };
        map.set(key, d);
      }
      if (!d.inspector_name && r.inspector_name) d.inspector_name = r.inspector_name;
      bumpBucket(r.task_kind === 'group' ? d.group : d.record, r);
    }
    const out = Array.from(map.values())
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.inspector_user_id).localeCompare(String(b.inspector_user_id)));
    for (const d of out) {
      finalizeBucket(d.group);
      finalizeBucket(d.record);
      const t = emptyBucket();
      for (const k of ['submitted', 'sampled', 'reviewed', 'approved', 'overridden', 'pending']) {
        t[k] = d.group[k] + d.record[k];
      }
      d.total = finalizeBucket(t);
    }
    return out;
  }

  function sumBuckets(list, kind) {
    const t = emptyBucket();
    for (const d of list) {
      const b = kind === 'total' ? d.total : d[kind];
      for (const k of ['submitted', 'sampled', 'reviewed', 'approved', 'overridden', 'pending']) {
        t[k] += b[k] || 0;
      }
    }
    finalizeBucket(t);
    t.active_days = list.length;
    t.per_day = t.active_days ? round4(t.submitted / t.active_days) : null;
    return t;
  }

  /* ------------------------------------------------------------
   * 9. 主流程
   * ---------------------------------------------------------- */
  async function runExport() {
    if (state.running) return;

    refreshIdentity();
    if (!state.token) throw new Error('没有可用的 token。请刷新页面或手工粘贴。');
    if (state.claims && state.claims.exp && state.claims.exp * 1000 < Date.now()) {
      throw new Error('token 已过期，请刷新页面重新登录。');
    }

    // 读取配置
    state.cfg = {
      teamRecord: Number(el.teamRecord.value) || DEFAULT_CFG.teamRecord,
      teamGroup: Number(el.teamGroup.value) || DEFAULT_CFG.teamGroup,
      orgId: Number(el.org.value) || DEFAULT_CFG.orgId,
      role: (el.role.value || DEFAULT_CFG.role).trim(),
      pageSize: Math.min(10000, Math.max(10, Number(el.psize.value) || DEFAULT_CFG.pageSize)),
      concurrency: Math.min(8, Math.max(1, Number(el.conc.value) || DEFAULT_CFG.concurrency)),
      delayMs: DEFAULT_CFG.delayMs,
      cutoffHour: Math.min(12, Math.max(0, Number(el.cut.value) || 0)),
      fetchLogs: !!el.logs.checked,
      logsTimeoutMs: DEFAULT_CFG.logsTimeoutMs,
    };
    saveCfg(state.cfg);

    state.running = true;
    state.aborted = false;
    state.report = null;
    state.stats = {
      pagesFetched: { record: 0, group: 0 },
      pageSizeActual: { record: 0, group: 0 },
      logsRequested: 0,
      logsFailed: 0,
    };

    el.run.disabled = true;
    el.stop.disabled = false;
    el.log.innerHTML = '';
    el.result.classList.remove('dqx2-show');
    el.log.classList.add('dqx2-show');

    console.info(TAG, 'runExport start', { cfg: state.cfg });
    logMsg('开始：记录级 team=' + state.cfg.teamRecord + '，组级 team=' + state.cfg.teamGroup +
      '，org=' + state.cfg.orgId + '，切点=' + state.cfg.cutoffHour + 'h，精确模式=' + state.cfg.fetchLogs);

    /* ---- 拉两路 leader_tasks ---- */
    logMsg('拉取记录级列表…');
    let rec;
    try {
      rec = await fetchLeaderTasks(state.cfg.teamRecord, 'record', (n, total, p) => {
        setProgress(n, total, '记录级 p' + p);
      });
      logMsg('记录级完成：' + rec.list.length + ' / ' + rec.total + '（实际 page_size=' + rec.pageSizeActual + '）', 's');
    } catch (e) {
      if (state.aborted) throw e;
      console.error(TAG, '[runExport] record fetch failed', e);
      logMsg('记录级拉取失败：' + e.message, 'e');
      rec = { list: [], total: 0, pageSizeActual: 0 };
    }

    logMsg('拉取组级列表…');
    let grp;
    try {
      grp = await fetchLeaderTasks(state.cfg.teamGroup, 'group', (n, total, p) => {
        setProgress(n, total, '组级 p' + p);
      });
      logMsg('组级完成：' + grp.list.length + ' / ' + grp.total + '（实际 page_size=' + grp.pageSizeActual + '）', 's');
    } catch (e) {
      if (state.aborted) throw e;
      console.error(TAG, '[runExport] group fetch failed', e);
      logMsg('组级拉取失败：' + e.message, 'e');
      grp = { list: [], total: 0, pageSizeActual: 0 };
    }

    if (!rec.list.length && !grp.list.length) {
      throw new Error('两路列表都是空。请确认 team_id / 角色，或该账号确实无权限。');
    }

    /* ---- 构建事实表 ---- */
    const recordRows = buildRows(rec.list, 'record');
    const groupRows = buildRows(grp.list, 'group');
    const allRows = recordRows.concat(groupRows);

    // 人员分布（供 UI 提示）
    const perPersonSubmitted = {};
    for (const r of allRows) {
      const key = String(r.inspector_user_id == null ? 'unknown' : r.inspector_user_id);
      perPersonSubmitted[key] = (perPersonSubmitted[key] || 0) + 1;
    }
    const inspectors = new Set(allRows.map((r) => r.inspector_user_id));
    logMsg('任务合计：记录级 ' + recordRows.length + '，组级 ' + groupRows.length +
      '，涉及标注员 ' + inspectors.size + ' 人');

    /* ---- 对抽检任务拉 logs ---- */
    if (state.cfg.fetchLogs) {
      const needLogs = allRows.filter((r) => r.sampled && SUBMITTED_STATUS.has(r.status));
      const recNeed = needLogs.filter((r) => r.task_kind === 'record').length;
      const grpNeed = needLogs.filter((r) => r.task_kind === 'group').length;
      logMsg('抽检任务需拉日志：' + needLogs.length + ' 条（记录级 ' + recNeed + '，组级 ' + grpNeed +
        '），并发 ' + state.cfg.concurrency);

      if (needLogs.length) {
        await fillLogsBatch(needLogs, 'all', (done, total) => {
          setProgress(done, total, 'logs');
        });
        const failCnt = needLogs.filter((r) => r.log_error).length;
        if (failCnt) {
          logMsg('⚠ ' + failCnt + ' 条日志拉取失败，将用 updated_at 兜底', 'w');
        } else {
          logMsg('日志完成：' + needLogs.length + ' 条', 's');
        }
      }
    } else {
      logMsg('已跳过日志（全部使用 updated_at 近似提交时间）', 'w');
    }

    /* ---- 补日期（未抽检 / 日志失败 / 已关闭但无 submit_at）---- */
    for (const r of allRows) {
      if (r.submit_date) continue;
      if (!SUBMITTED_STATUS.has(r.status)) continue;
      const up = r._t && r._t.updated_at;
      if (!up) continue;
      r.submit_at = up;
      r.submit_date = workDate(up, state.cfg.cutoffHour);
      r.date_source = (r.sampled && r.status === 'closed') ? 'fallback' : 'updated_at';
    }

    /* ---- 聚合 ---- */
    const daily = aggregateByDate(allRows);
    const byPerson = aggregateByDateAndPerson(allRows);
    const totals = {
      group: sumBuckets(daily, 'group'),
      record: sumBuckets(daily, 'record'),
      total: sumBuckets(daily, 'total'),
    };

    /* ---- 完整性检查 ---- */
    const cleanRows = allRows.map((r) => {
      const out = {};
      for (const k of Object.keys(r)) if (k !== '_t') out[k] = r[k];
      return out;
    });

    const noDate = cleanRows.filter((r) => !r.submit_date).length;
    const logErrors = cleanRows.filter((r) => r.log_error).length;
    const reviewedNoLog = cleanRows.filter(
      (r) => r.sampled && r.status === 'closed' && r.date_source !== 'log'
    ).length;

    const sampledByStatus = {};
    for (const r of cleanRows) {
      if (!r.sampled) continue;
      sampledByStatus[r.status] = (sampledByStatus[r.status] || 0) + 1;
    }

    const integrity = {
      record_total_declared: rec.total,
      record_fetched: rec.list.length,
      record_page_size_actual: rec.pageSizeActual,
      group_total_declared: grp.total,
      group_fetched: grp.list.length,
      group_page_size_actual: grp.pageSizeActual,
      pages_fetched_record: state.stats.pagesFetched.record,
      pages_fetched_group: state.stats.pagesFetched.group,
      logs_requested: state.stats.logsRequested,
      logs_failed: state.stats.logsFailed,
      tasks_total: cleanRows.length,
      tasks_without_date: noDate,
      reviewed_no_log: reviewedNoLog,
      log_errors: logErrors,
      sampled_by_status: sampledByStatus,
      inspect_people: inspectors.size,
    };

    /* ---- 组包 ---- */
    const claims = state.claims || {};
    const adminUid = isNum(claims.user_id) ? String(claims.user_id) : ('admin-' + shortHash(state.token));

    const report = {
      schema: SCHEMA,
      generated_at: new Date().toISOString(),
      generated_date: todayStr(),
      source: location.origin,
      script_version: VERSION,
      user: {
        user_id: adminUid,
        name: claims.name || claims.email || '',
        role: state.cfg.role,
        team_record: state.cfg.teamRecord,
        team_group: state.cfg.teamGroup,
        org_id: state.cfg.orgId,
      },
      params: {
        cutoff_hour: state.cfg.cutoffHour,
        page_size: state.cfg.pageSize,
        fetch_logs: state.cfg.fetchLogs,
        concurrency: state.cfg.concurrency,
      },
      integrity: integrity,
      totals: totals,
      daily: daily,
      daily_by_person: byPerson,
      tasks: cleanRows,
    };

    state.report = report;
    state.fileName = buildFileName(report);

    hideProgress();
    logMsg('✅ 合计：提交 ' + totals.total.submitted +
      '（组级 ' + totals.group.submitted + ' / 记录级 ' + totals.record.submitted + '）' +
      '，抽检 ' + totals.total.sampled +
      '，认可 ' + totals.total.approved + '，推翻 ' + totals.total.overridden +
      '，待复核 ' + totals.total.pending, 's');
    logMsg('涉及标注员 ' + inspectors.size + ' 人，' + totals.total.active_days + ' 个工作日', 's');

    renderResult(report);
    downloadJson(report);
    finishRun();
  }

  function finishRun() {
    state.running = false;
    state.aborted = false;
    if (el.run) el.run.disabled = false;
    if (el.stop) el.stop.disabled = true;
  }

  /* ------------------------------------------------------------
   * 10. UI
   * ---------------------------------------------------------- */
  const CSS = `
#dqx2-fab{position:fixed;right:24px;bottom:24px;z-index:2147483000;width:50px;height:50px;
  border-radius:50%;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:21px;cursor:pointer;
  user-select:none;box-shadow:0 6px 20px rgba(124,58,237,.45);transition:transform .15s,box-shadow .15s;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
#dqx2-fab:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(124,58,237,.55);}
#dqx2-panel{position:fixed;right:24px;bottom:86px;z-index:2147483001;width:640px;
  max-width:calc(100vw - 32px);max-height:82vh;display:none;flex-direction:column;
  background:#fff;color:#1f2937;border-radius:14px;
  box-shadow:0 20px 56px rgba(15,23,42,.28);overflow:hidden;
  font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
#dqx2-panel.dqx2-open{display:flex;}
#dqx2-panel .dqx2-hd{display:flex;align-items:center;gap:10px;padding:12px 16px;
  background:linear-gradient(135deg,#5b21b6,#7c3aed);color:#fff;flex:0 0 auto;}
#dqx2-panel .dqx2-hd .dqx2-title{font-weight:600;font-size:14px;}
#dqx2-panel .dqx2-hd .dqx2-badge{font-size:11px;background:rgba(255,255,255,.22);
  padding:2px 8px;border-radius:10px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#dqx2-panel .dqx2-hd .dqx2-sp{flex:1;}
#dqx2-panel .dqx2-x{background:transparent;border:0;color:#fff;font-size:20px;line-height:1;
  cursor:pointer;padding:0 2px;opacity:.85;}
#dqx2-panel .dqx2-x:hover{opacity:1;}
#dqx2-panel .dqx2-bd{padding:14px 16px 16px;overflow-y:auto;flex:1 1 auto;}
#dqx2-panel .dqx2-ident{font-size:12px;color:#4b5563;background:#f3f4f6;border-radius:8px;
  padding:8px 10px;margin-bottom:12px;word-break:break-all;line-height:1.7;}
#dqx2-panel .dqx2-ident b{color:#111827;}
#dqx2-panel .dqx2-ident .dqx2-err{color:#b91c1c;font-weight:600;}
#dqx2-panel .dqx2-ident .dqx2-ok{color:#047857;font-weight:600;}
#dqx2-panel .dqx2-ident .dqx2-warn{color:#b45309;font-weight:600;}
#dqx2-panel .dqx2-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-bottom:10px;}
#dqx2-panel .dqx2-grid label{display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;}
#dqx2-panel .dqx2-grid input{flex:1;min-width:0;padding:5px 8px;border:1px solid #d1d5db;
  border-radius:6px;font-size:12px;outline:none;}
#dqx2-panel .dqx2-grid input:focus{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.14);}
#dqx2-panel .dqx2-chk{display:flex;align-items:center;gap:7px;font-size:12px;color:#374151;
  margin-bottom:10px;cursor:pointer;user-select:none;}
#dqx2-panel details.dqx2-adv{font-size:12px;color:#6b7280;margin-bottom:10px;}
#dqx2-panel details.dqx2-adv summary{cursor:pointer;padding:4px 0;user-select:none;}
#dqx2-panel details.dqx2-adv textarea{width:100%;box-sizing:border-box;height:54px;margin-top:6px;
  padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:11px;
  font-family:ui-monospace,Menlo,Consolas,monospace;resize:vertical;outline:none;}
#dqx2-panel .dqx2-actions{display:flex;gap:10px;margin-bottom:10px;}
#dqx2-panel .dqx2-btn{padding:8px 16px;border:1px solid #d1d5db;background:#fff;color:#374151;
  border-radius:8px;font-size:13px;cursor:pointer;transition:all .12s;}
#dqx2-panel .dqx2-btn:hover:not(:disabled){background:#f9fafb;border-color:#9ca3af;}
#dqx2-panel .dqx2-btn:disabled{opacity:.45;cursor:not-allowed;}
#dqx2-panel .dqx2-btn-primary{background:#7c3aed;border-color:#7c3aed;color:#fff;font-weight:500;}
#dqx2-panel .dqx2-btn-primary:hover:not(:disabled){background:#6d28d9;border-color:#6d28d9;}
#dqx2-panel .dqx2-btn-sm{padding:5px 11px;font-size:12px;}
#dqx2-panel .dqx2-progress{display:none;margin-bottom:8px;}
#dqx2-panel .dqx2-progress.dqx2-show{display:block;}
#dqx2-panel .dqx2-bar{height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;}
#dqx2-panel .dqx2-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#a78bfa,#7c3aed);
  border-radius:3px;transition:width .22s;}
#dqx2-panel .dqx2-pct{font-size:11px;color:#6b7280;margin-top:3px;text-align:right;}
#dqx2-panel .dqx2-log{max-height:160px;overflow-y:auto;background:#0f172a;color:#cbd5e1;
  border-radius:8px;padding:8px 10px;font:11px/1.6 ui-monospace,Menlo,Consolas,monospace;
  white-space:pre-wrap;word-break:break-all;display:none;}
#dqx2-panel .dqx2-log.dqx2-show{display:block;}
#dqx2-panel .dqx2-log .w{color:#fbbf24;}
#dqx2-panel .dqx2-log .e{color:#f87171;}
#dqx2-panel .dqx2-log .s{color:#4ade80;}
#dqx2-panel .dqx2-result{display:none;margin-top:12px;}
#dqx2-panel .dqx2-result.dqx2-show{display:block;}
#dqx2-panel .dqx2-kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px;}
#dqx2-panel .dqx2-kpi div{background:#f3f4f6;border-radius:8px;padding:8px 10px;text-align:center;}
#dqx2-panel .dqx2-kpi span{display:block;font-size:11px;color:#6b7280;margin-bottom:2px;}
#dqx2-panel .dqx2-kpi b{font-size:17px;color:#111827;font-variant-numeric:tabular-nums;}
#dqx2-panel .dqx2-tabs{display:flex;gap:4px;margin-bottom:8px;border-bottom:1px solid #e5e7eb;}
#dqx2-panel .dqx2-tab{padding:6px 12px;font-size:12px;cursor:pointer;border:0;background:transparent;
  color:#6b7280;border-bottom:2px solid transparent;}
#dqx2-panel .dqx2-tab.dqx2-on{color:#7c3aed;border-bottom-color:#7c3aed;font-weight:500;}
#dqx2-panel .dqx2-tblwrap{max-height:400px;overflow:auto;}
#dqx2-panel table.dqx2-tbl{width:100%;border-collapse:collapse;font-size:11.5px;
  font-variant-numeric:tabular-nums;}
#dqx2-panel table.dqx2-tbl th{background:#f9fafb;color:#6b7280;font-weight:500;text-align:right;
  padding:5px 6px;border-bottom:1px solid #e5e7eb;white-space:nowrap;position:sticky;top:0;}
#dqx2-panel table.dqx2-tbl th:first-child,#dqx2-panel table.dqx2-tbl td:first-child{text-align:left;}
#dqx2-panel table.dqx2-tbl td{padding:4px 6px;border-bottom:1px solid #f3f4f6;text-align:right;white-space:nowrap;}
#dqx2-panel table.dqx2-tbl tr.dqx2-total td{font-weight:600;background:#f9fafb;
  border-top:1px solid #e5e7eb;position:sticky;bottom:0;}
#dqx2-panel table.dqx2-tbl tr.dqx2-prov td{color:#9ca3af;}
#dqx2-panel .dqx2-note{font-size:11px;color:#6b7280;margin-top:8px;line-height:1.6;}
#dqx2-panel .dqx2-note .dqx2-warn{color:#b45309;}
#dqx2-panel .dqx2-note .dqx2-bad{color:#b91c1c;}
#dqx2-panel .dqx2-dl{display:flex;gap:10px;margin-top:12px;}
`;

  let el = {};

  function $(id) { return document.getElementById(id); }

  function ensureBodyAndMount() {
    // document-start 阶段 body 可能不存在；此处由 onReady 调用，理论上 body 已有，
    // 但某些站点（如 <html> 未完成）仍需轮询兜底
    if (document.body && document.head) {
      mount();
      return;
    }
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (document.body && document.head) {
        clearInterval(timer);
        mount();
      } else if (tries > 40) { // 最多 2s
        clearInterval(timer);
        console.error(TAG, 'mount aborted: document.body/head unavailable');
      }
    }, 50);
  }

  function mount() {
    if (document.getElementById('dqx2-fab')) return;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const fab = document.createElement('div');
    fab.id = 'dqx2-fab';
    fab.title = '导出全量质检数据（管理员）';
    fab.textContent = '📊';
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'dqx2-panel';
    panel.innerHTML = [
      '<div class="dqx2-hd">',
      '  <span class="dqx2-title">穹彻DM3平台每日工作量导出</span>',
      '  <span class="dqx2-badge" id="dqx2-user">—</span>',
      '  <span class="dqx2-sp"></span>',
      '  <button class="dqx2-x" id="dqx2-close" title="关闭">×</button>',
      '</div>',
      '<div class="dqx2-bd">',
      '  <div class="dqx2-ident" id="dqx2-ident">正在检测登录状态…</div>',

      '  <div class="dqx2-grid">',
      '    <label>记录级 team<input id="dqx2-team-record" type="number" min="1"></label>',
      '    <label>组级 team<input id="dqx2-team-group" type="number" min="1"></label>',
      '    <label>组织 ID<input id="dqx2-org" type="number" min="1"></label>',
      '    <label>跨天切点(时)<input id="dqx2-cut" type="number" min="0" max="12"></label>',
      '  </div>',

      '  <label class="dqx2-chk"><input id="dqx2-logs" type="checkbox"> 精确模式：抽检任务逐条拉 logs（慢但准确）</label>',

      '  <details class="dqx2-adv">',
      '    <summary>高级设置 / 手工 token</summary>',
      '    <div class="dqx2-grid" style="margin-top:8px;">',
      '      <label>每页条数<input id="dqx2-psize" type="number" min="10" max="10000"></label>',
      '      <label>logs 并发<input id="dqx2-conc" type="number" min="1" max="8"></label>',
      '      <label>角色<input id="dqx2-role" type="text"></label>',
      '    </div>',
      '    <textarea id="dqx2-token" placeholder="仅在自动检测失败时使用：粘贴 Bearer 后面那串 token"></textarea>',
      '    <button class="dqx2-btn dqx2-btn-sm" id="dqx2-usetoken" style="margin-top:6px;">使用此 token</button>',
      '    <button class="dqx2-btn dqx2-btn-sm" id="dqx2-diag" style="margin-top:6px;">诊断 token</button>',
      '  </details>',

      '  <div class="dqx2-actions">',
      '    <button class="dqx2-btn dqx2-btn-primary" id="dqx2-run">开始导出</button>',
      '    <button class="dqx2-btn" id="dqx2-stop" disabled>停止</button>',
      '  </div>',

      '  <div class="dqx2-progress" id="dqx2-progress">',
      '    <div class="dqx2-bar"><i id="dqx2-bar-fill"></i></div>',
      '    <div class="dqx2-pct" id="dqx2-pct">0%</div>',
      '  </div>',

      '  <div class="dqx2-log" id="dqx2-log"></div>',
      '  <div class="dqx2-result" id="dqx2-result"></div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(panel);

    el = {
      fab: fab,
      panel: panel,
      ident: $('dqx2-ident'),
      user: $('dqx2-user'),
      teamRecord: $('dqx2-team-record'),
      teamGroup: $('dqx2-team-group'),
      org: $('dqx2-org'),
      cut: $('dqx2-cut'),
      logs: $('dqx2-logs'),
      psize: $('dqx2-psize'),
      conc: $('dqx2-conc'),
      role: $('dqx2-role'),
      token: $('dqx2-token'),
      run: $('dqx2-run'),
      stop: $('dqx2-stop'),
      progress: $('dqx2-progress'),
      bar: $('dqx2-bar-fill'),
      pct: $('dqx2-pct'),
      log: $('dqx2-log'),
      result: $('dqx2-result'),
    };

    // el 完整性检查，防止某个 id 因 CSP / Trusted Types 拦截而缺失
    const missing = Object.keys(el).filter((k) => !el[k]);
    if (missing.length) {
      console.error(TAG, 'mount failed: missing elements', missing);
      return;
    }

    state.cfg = loadCfg();
    el.teamRecord.value = state.cfg.teamRecord;
    el.teamGroup.value = state.cfg.teamGroup;
    el.org.value = state.cfg.orgId;
    el.cut.value = state.cfg.cutoffHour;
    el.logs.checked = !!state.cfg.fetchLogs;
    el.psize.value = state.cfg.pageSize;
    el.conc.value = state.cfg.concurrency;
    el.role.value = state.cfg.role;

    fab.addEventListener('click', () => {
      panel.classList.toggle('dqx2-open');
      if (panel.classList.contains('dqx2-open')) refreshIdentity();
    });
    $('dqx2-close').addEventListener('click', () => panel.classList.remove('dqx2-open'));

    $('dqx2-usetoken').addEventListener('click', () => {
      const raw = (el.token.value || '').trim().replace(/^Bearer\s+/i, '');
      if (!raw) { logMsg('请先粘贴 token', 'w'); return; }
      state.token = raw;
      state.tokenFrom = 'manual';
      refreshIdentity();
      logMsg('已使用手工 token', 's');
    });

    $('dqx2-diag').addEventListener('click', () => {
      const ranked = rankedCandidates();
      const lines = ['共 ' + ranked.length + ' 个候选 token（按分数降序）：'];
      ranked.forEach((c, i) => {
        const cl = c.claims || {};
        const uidTxt = cl.user_id != null ? 'user_id=' + cl.user_id
          : cl.uid != null ? 'uid=' + cl.uid
            : cl.sub != null ? 'sub=' + cl.sub : '(无身份字段)';
        lines.push('  #' + (i + 1) + ' 得分 ' + c.score + ' 来源 ' + c.from +
          (c.url ? ' url=' + c.url.slice(0, 60) : ''));
        lines.push('      ' + uidTxt + ' [' + (c.notes || []).join(', ') + ']');
      });
      console.info(TAG, 'diagnose:\n' + lines.join('\n'));
      logMsg('诊断结果已输出到 Console（F12 过滤 ' + TAG + '）', 's');
    });

    el.run.addEventListener('click', () => {
      runExport().catch((e) => {
        console.error(TAG, '[runExport] fatal', e);
        logMsg('导出失败：' + (e && e.message ? e.message : e), 'e');
        finishRun();
      });
    });

    el.stop.addEventListener('click', () => {
      state.aborted = true;
      el.stop.disabled = true;
      logMsg('已请求停止…', 'w');
    });

    refreshIdentity();
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function logMsg(msg, level) {
    if (!el.log) return;
    el.log.classList.add('dqx2-show');
    const cls = level === 'e' ? 'e' : level === 'w' ? 'w' : level === 's' ? 's' : '';
    const line = document.createElement('div');
    if (cls) line.className = cls;
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    line.textContent = '[' + hh + ':' + mm + ':' + ss + '] ' + msg;
    el.log.appendChild(line);
    while (el.log.childNodes.length > 400) el.log.removeChild(el.log.firstChild);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function setProgress(done, total, label) {
    if (!el.progress) return;
    el.progress.classList.add('dqx2-show');
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    el.bar.style.width = pct + '%';
    el.pct.textContent = (label ? label + ' : ' : '') + done + ' / ' + total + '  (' + pct + '%)';
  }

  function hideProgress() {
    if (el.progress) el.progress.classList.remove('dqx2-show');
  }

  function refreshIdentity() {
    const tk = currentToken();
    if (!tk) {
      state.token = null;
      state.tokenFrom = null;
      state.claims = {};
      el.ident.innerHTML = '<span class="dqx2-err">未检测到登录凭据</span><br>' +
        '请在页面上任意点一次菜单触发一次请求，或在「高级设置」里手工粘贴 token。';
      el.user.textContent = '未登录';
      return;
    }
    state.token = tk.token;
    state.tokenFrom = tk.from;
    const c = decodeJwt(tk.token);
    state.claims = c;

    const expMs = c.exp ? c.exp * 1000 : 0;
    const expired = expMs && expMs < Date.now();
    const expTxt = expMs ? new Date(expMs).toLocaleString('zh-CN', { hour12: false }) : '未知';

    const uidTxt = isNum(c.user_id) ? String(c.user_id)
      : isNum(c.uid) ? String(c.uid)
        : c.sub != null ? 'sub(UUID)' : '无法识别';
    const uidClass = (isNum(c.user_id) || isNum(c.uid)) ? 'dqx2-ok' : 'dqx2-warn';

    el.ident.innerHTML =
      '登录用户：<span class="' + uidClass + '"><b>' + esc(uidTxt) + '</b></span>' +
      '　来源：' + esc(tk.from) +
      '　token 到期：' + esc(expTxt) +
      (expired ? ' <span class="dqx2-err">已过期</span>' : '');
    el.user.textContent = (isNum(c.user_id) ? 'uid=' + c.user_id : 'uid=' + uidTxt) +
      (expired ? ' · 已过期' : '');
  }

  function loadCfg() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {};
    } catch (e) {
      console.warn(TAG, 'loadCfg parse failed, use default', e);
    }
    return Object.assign({}, DEFAULT_CFG, stored);
  }

  function saveCfg(cfg) {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    } catch (e) {
      console.warn(TAG, 'saveCfg failed', e);
    }
  }

  /* ---- 结果渲染 ---- */
  function buildFileName(report) {
    const uid = (report.user && report.user.user_id) || 'unknown';
    const day = (report.generated_date || todayStr()).replace(/-/g, '');
    return 'dq_all_' + uid + '_' + day + '.json';
  }

  function downloadJson(report) {
    try {
      const text = JSON.stringify(report, null, 2);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = state.fileName || 'dq_all_report.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      logMsg('📁 已下载 ' + (state.fileName || 'dq_all_report.json'), 's');
    } catch (e) {
      console.error(TAG, 'downloadJson failed', e);
      logMsg('自动下载失败，请点「复制 JSON」：' + e.message, 'w');
    }
  }

  function renderResult(report) {
    const t = report.totals;
    const ig = report.integrity;

    const kpi = [
      ['提交总数', t.total.submitted],
      ['组级 / 记录级', t.group.submitted + ' / ' + t.record.submitted],
      ['抽检总数', t.total.sampled],
      ['认可 / 推翻', t.total.approved + ' / ' + t.total.overridden],
    ].map((x) => '<div><span>' + x[0] + '</span><b>' + x[1] + '</b></div>').join('');

    el.result.innerHTML =
      '<div class="dqx2-kpi">' + kpi + '</div>' +
      '<div class="dqx2-tabs">' +
      '  <button class="dqx2-tab dqx2-on" data-view="daily">按日</button>' +
      '  <button class="dqx2-tab" data-view="person">按日 × 人</button>' +
      '</div>' +
      '<div class="dqx2-tblwrap" id="dqx2-view"></div>' +
      '<div class="dqx2-note" id="dqx2-note"></div>' +
      '<div class="dqx2-dl">' +
      '  <button class="dqx2-btn dqx2-btn-primary" id="dqx2-dl">下载 JSON</button>' +
      '  <button class="dqx2-btn" id="dqx2-copy">复制 JSON</button>' +
      '</div>';

    el.result.classList.add('dqx2-show');

    const view = $('dqx2-view');

    function renderDaily() {
      const head = '<tr><th>日期</th>' +
        '<th>组级提交</th><th>组级抽检</th><th>组级认可</th><th>组级推翻</th><th>组级待复核</th>' +
        '<th>记级提交</th><th>记级抽检</th><th>记级认可</th><th>记级推翻</th><th>记级待复核</th>' +
        '<th>总提交</th><th>总抽检率</th><th>总认可率</th></tr>';
      const body = report.daily.map((d) => {
        const g = d.group, r = d.record, t2 = d.total;
        const cls = t2.maturity === 'provisional' ? 'dqx2-prov' : '';
        return '<tr class="' + cls + '">' +
          '<td>' + esc(d.date) + (t2.maturity === 'provisional' ? ' *' : '') + '</td>' +
          '<td>' + g.submitted + '</td><td>' + g.sampled + '</td>' +
          '<td>' + g.approved + '</td><td>' + g.overridden + '</td><td>' + g.pending + '</td>' +
          '<td>' + r.submitted + '</td><td>' + r.sampled + '</td>' +
          '<td>' + r.approved + '</td><td>' + r.overridden + '</td><td>' + r.pending + '</td>' +
          '<td>' + t2.submitted + '</td>' +
          '<td>' + fmtPct(t2.sample_rate) + '</td>' +
          '<td>' + fmtPct(t2.approve_rate) + '</td>' +
          '</tr>';
      }).join('');
      const g = t.group, r = t.record, tt = t.total;
      const totalRow = '<tr class="dqx2-total">' +
        '<td>合计</td>' +
        '<td>' + g.submitted + '</td><td>' + g.sampled + '</td>' +
        '<td>' + g.approved + '</td><td>' + g.overridden + '</td><td>' + g.pending + '</td>' +
        '<td>' + r.submitted + '</td><td>' + r.sampled + '</td>' +
        '<td>' + r.approved + '</td><td>' + r.overridden + '</td><td>' + r.pending + '</td>' +
        '<td>' + tt.submitted + '</td>' +
        '<td>' + fmtPct(tt.sample_rate) + '</td>' +
        '<td>' + fmtPct(tt.approve_rate) + '</td>' +
        '</tr>';
      view.innerHTML = '<table class="dqx2-tbl"><thead>' + head + '</thead><tbody>' + body + totalRow + '</tbody></table>';
    }

    function renderPerson() {
      const head = '<tr><th>日期</th><th>标注员</th><th>UID</th>' +
        '<th>组级</th><th>记录级</th><th>总提交</th>' +
        '<th>抽检</th><th>认可</th><th>推翻</th><th>待复核</th><th>认可率</th></tr>';
      const body = report.daily_by_person.map((d) => {
        const g = d.group, r = d.record, tt = d.total;
        const cls = tt.maturity === 'provisional' ? 'dqx2-prov' : '';
        return '<tr class="' + cls + '">' +
          '<td>' + esc(d.date) + '</td>' +
          '<td>' + esc(d.inspector_name || '—') + '</td>' +
          '<td>' + esc(d.inspector_user_id == null ? '—' : d.inspector_user_id) + '</td>' +
          '<td>' + g.submitted + '</td><td>' + r.submitted + '</td>' +
          '<td>' + tt.submitted + '</td>' +
          '<td>' + tt.sampled + '</td><td>' + tt.approved + '</td>' +
          '<td>' + tt.overridden + '</td><td>' + tt.pending + '</td>' +
          '<td>' + fmtPct(tt.approve_rate) + '</td>' +
          '</tr>';
      }).join('');
      view.innerHTML = '<table class="dqx2-tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
    }

    const tabs = el.result.querySelectorAll('.dqx2-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((x) => x.classList.remove('dqx2-on'));
        tab.classList.add('dqx2-on');
        if (tab.dataset.view === 'daily') renderDaily();
        else renderPerson();
      });
    });
    renderDaily();

    /* ---- 备注 ---- */
    const notes = [];
    notes.push('<div>记录级：' + ig.record_fetched + ' / ' + ig.record_total_declared +
      '（page_size 实际 ' + ig.record_page_size_actual + '，' + ig.pages_fetched_record + ' 页）' +
      '　组级：' + ig.group_fetched + ' / ' + ig.group_total_declared +
      '（page_size 实际 ' + ig.group_page_size_actual + '，' + ig.pages_fetched_group + ' 页）</div>');
    notes.push('<div>标注员：' + ig.inspect_people + ' 人　' +
      'logs 请求：' + ig.logs_requested + '（失败 ' + ig.logs_failed + '）</div>');

    if (t.total.pending > 0) {
      notes.push('<div class="dqx2-warn">有 ' + t.total.pending +
        ' 条抽检任务尚未复核完成，带 * 的日期其认可率还会变化。</div>');
    }
    if (ig.reviewed_no_log > 0) {
      notes.push('<div class="dqx2-warn">' + ig.reviewed_no_log +
        ' 条抽检任务未取到日志，提交日退化为 updated_at。</div>');
    }
    if (ig.log_errors > 0) {
      notes.push('<div class="dqx2-bad">' + ig.log_errors + ' 条日志请求失败（详见 tasks[].log_error）。</div>');
    }
    if (ig.tasks_without_date > 0) {
      notes.push('<div>' + ig.tasks_without_date + ' 条任务未计入（尚未提交或状态不属于已提交集合）。</div>');
    }
    if (ig.record_fetched !== ig.record_total_declared) {
      notes.push('<div class="dqx2-bad">记录级数量不一致：声明 ' + ig.record_total_declared +
        '，实际 ' + ig.record_fetched + '。</div>');
    }
    if (ig.group_fetched !== ig.group_total_declared) {
      notes.push('<div class="dqx2-bad">组级数量不一致：声明 ' + ig.group_total_declared +
        '，实际 ' + ig.group_fetched + '。</div>');
    }

    $('dqx2-note').innerHTML = notes.join('');

    const dl = $('dqx2-dl');
    const cp = $('dqx2-copy');

    if (dl) {
      dl.addEventListener('click', () => {
        if (state.report) downloadJson(state.report);
      });
    }
    if (cp) {
      cp.addEventListener('click', async () => {
        if (!state.report) return;
        const text = JSON.stringify(state.report);
        try {
          await navigator.clipboard.writeText(text);
          logMsg('已复制到剪贴板（' + Math.round(text.length / 1024) + ' KB）', 's');
        } catch (e) {
          console.warn(TAG, 'clipboard API failed, fallback to execCommand', e);
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); logMsg('已复制到剪贴板', 's'); }
          catch (e2) { console.error(TAG, 'execCommand copy failed', e2); logMsg('复制失败，请用「下载 JSON」', 'e'); }
          ta.remove();
        }
      });
    }
  }

  /* ------------------------------------------------------------
   * 11. 启动
   * ---------------------------------------------------------- */
  onReady(ensureBodyAndMount);

  console.info(TAG, '穹彻DM3平台每日工作量导出已加载，右下角 📊 打开面板；调试：__DQX2_DEBUG__');
})();