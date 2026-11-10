// ============================================================
// Clash Verge Rev / mihomo 全局扩展脚本  v11
// DNS 分流 · 防泄漏 · 降延迟 · GitHub 接管 · 隐私拦截
// · 节点画像重排 · 规则遮蔽检测 · 泄漏评分 · 生效自证 · 幂等
//
// 内核对字段的要求（低于此版本本脚本静默降级，见探针第 4 行）：
//   respect-rules / nameserver-policy / proxy-server-nameserver  mihomo >= 1.18
//   fake-ip-filter-mode                                          mihomo >= 1.18
//   unified-delay / tcp-concurrent                               mihomo >= 1.16
//
// 本脚本不写 mixed-port / allow-lan / mode / log-level / ipv6 / tun
// （由 Verge「Clash 设置」管理，写了也会被丢弃）。
//
// 规则覆盖顺序（自上而下，先命中者胜）：
//   [customRulesTop] >> [隐私拦截] >> [GitHub] >> [泄漏测试站]
//   >> [extraProxyDomains] >> [DoH IP 路由] >> (订阅原规则)
//   >> [customRulesBottom] >> MATCH
// 因此：customRulesTop 可覆盖一切；customRulesBottom 可覆盖除 top 外的一切。
// ============================================================

const VERSION = 'v11';

const OPT = {
  showDashboard: true,            // 在代理页插入 ✅ 探针组
  forceProxyForForeignDNS: true,  // 国外 DoH 的 IP 强制走代理
  githubViaProxy: true,           // GitHub 全域名强制走代理
  useGeoSite: true,               // 用 geosite 精确分流（需 geosite.dat）
  proxyGroup: null,               // 手动指定主代理组名，null 则自动选择
  preferGroup: ['🚀 节点选择', '节点选择', 'Proxy', 'PROXY', '手动切换', 'GLOBAL'],
  extraDoh: [],                   // 自建 DoH（必须是 IP 形式），排在最前
  extraProxyDomains: [],          // 额外强制走代理的域名，如 '+.example.com'
  extraDirectDomains: [],         // 额外直连的域名，如 '+.corp.example'
  customRulesTop: [],             // 置顶自定义规则
  customRulesBottom: [],          // 插入到 MATCH 之前

  assertInvariants: true,         // 结构自检：把静默失效变成探针可见
  sortProxies: true,              // 按静态质量画像重排 proxies（只读评估）
  injectPrivacyRules: true,       // 注入隐私/跟踪拦截块
  privacyExtra: [],               // 额外拦截域名，如 '+.tracker.example'
};

// ---------- 国内 DoH（纯 IP，无引导污染面） ----------
const DNS_CN = ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'];

// ---------- 按大区准备 DoH 池 ----------
const DOH_POOL = {
  asia: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query', 'https://9.9.9.9/dns-query'],
  us:   ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query', 'https://94.140.14.14/dns-query'],
  eu:   ['https://1.1.1.1/dns-query', 'https://9.9.9.9/dns-query', 'https://94.140.14.14/dns-query'],
};
const DEFAULT_DOH = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];
const MAX_DOH = 4;

// ---------- 必须真实解析的域名（fake-ip 白名单外） ----------
// 与 FORCE_GLOBAL 求交必须为空，自检会报告冲突
const FAKE_IP_FILTER = [
  '*.lan', '*.local', '*.localdomain', '*.home.arpa', '*.arpa',
  '+.msftconnecttest.com', '+.msftncsi.com',
  '+.push.apple.com',
  'localhost.ptlogin2.qq.com',
  'time.*.com', 'time.*.apple.com', 'ntp.*.com', 'time1.cloud.tencent.com',
  '+.srv.nintendo.net', '+.stun.playstation.net', '+.xboxlive.com',
  '+.battlenet.com.cn', '+.blizzard.com',
  '+.mijia.cloud', '+.mi.com',
  'WORKGROUP', 'localhost',
];

// ---------- 点名走国外解析的域名 ----------
const FORCE_GLOBAL = [
  '+.google.com', '+.googleapis.com', '+.gstatic.com', '+.googleusercontent.com',
  '+.youtube.com', '+.ytimg.com',
  '+.openai.com', '+.chatgpt.com', '+.oaistatic.com', '+.oaiusercontent.com',
  '+.anthropic.com', '+.claude.ai',
  '+.github.com', '+.githubusercontent.com', '+.githubassets.com',
  '+.github.io', '+.ghcr.io', '+.github.dev', '+.githubnext.com',
  '+.telegram.org', '+.t.me', '+.tdesktop.com',
  '+.x.com', '+.twitter.com', '+.twimg.com',
  '+.facebook.com', '+.instagram.com', '+.whatsapp.net',
  '+.wikipedia.org', '+.reddit.com', '+.discord.com', '+.discordapp.com',
  '+.netflix.com', '+.nflxvideo.net', '+.spotify.com',
  '+.pixiv.net', '+.patreon.com', '+.medium.com',
  '+.dnsleaktest.com', '+.ipleak.net', '+.browserleaks.com', '+.whoer.net',
];

// ---------- GitHub ----------
const GITHUB_SUFFIX = [
  'github.com', 'githubusercontent.com', 'githubassets.com', 'github.io',
  'ghcr.io', 'github.dev', 'githubnext.com', 'github.blog', 'githubstatus.com',
];
const GITHUB_EXACT = [
  'codeload.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'api.github.com', 'gist.github.com',
  'avatars.githubusercontent.com', 'media.githubusercontent.com',
  'npm.pkg.github.com', 'maven.pkg.github.com',
];

// ---------- 泄漏测试站 ----------
const LEAK_TEST_SUFFIX = ['dnsleaktest.com', 'ipleak.net', 'browserleaks.com', 'whoer.net'];

// ---------- 隐私/跟踪拦截（保守集：低误伤、高覆盖） ----------
// 这是静态快照，不实时更新；探针会显示实际注入条数
const TRACKER_SUFFIX = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'googletagmanager.com',
  'scorecardresearch.com', 'quantserve.com',
  'adservice.google.com',
  'telemetry.mozilla.org', 'incoming.telemetry.mozilla.org',
  'events.data.microsoft.com', 'watson.telemetry.microsoft.com',
  'device-metrics-us.amazon.com',
  'ads.linkedin.com', 'ads.twitter.com',
  'staticxx.facebook.com', 'connect.facebook.net',
];

// ============================================================
// 工具
// ============================================================

// 无损深拷贝：structuredClone → JSON 往返 → WeakMap 递归。
// (v9 的 24 层上限会在回退时返回非原始配置，破坏"回退到原始配置"的断言)
function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  try {
    if (typeof structuredClone === 'function') return structuredClone(v);
  } catch (e) { /* 循环引用或不可克隆对象，落 JSON */ }
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (e) { /* 存在循环或不可序列化值，落递归 */ }
  const seen = new WeakMap();
  (function rec(o) {
    if (o === null || typeof o !== 'object') return o;
    if (seen.has(o)) return seen.get(o);
    const out = Array.isArray(o) ? [] : {};
    seen.set(o, out);
    for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = rec(o[k]);
    return out;
  })(v);
  return seen.get(v);
}

function merge(target, patch) {
  for (const k in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    const v = patch[k];
    if (v === null) { delete target[k]; continue; }
    const isObj = v && typeof v === 'object' && !Array.isArray(v);
    const tgtObj = target[k] && typeof target[k] === 'object' && !Array.isArray(target[k]);
    if (isObj && tgtObj) merge(target[k], v);
    else target[k] = deepClone(v);
  }
  return target;
}

function uniq(arr) {
  const seen = {};
  const out = [];
  for (const x of arr) {
    const k = typeof x === 'string' ? x : JSON.stringify(x);
    if (!seen[k]) { seen[k] = 1; out.push(x); }
  }
  return out;
}

function toRule(domain, target) {
  if (domain.indexOf('+.') === 0) return 'DOMAIN-SUFFIX,' + domain.slice(2) + ',' + target;
  return 'DOMAIN,' + domain + ',' + target;
}

// 规则目标名合法性：mihomo 用逗号分隔字段，目标名含逗号会破坏解析
function validTarget(g) {
  return typeof g === 'string' && g.length > 0 && g.indexOf(',') < 0;
}

// ============================================================
// 区域识别
// ============================================================
const REGION_RULES = [
  { label: 'HK', pool: 'asia', re: /香港|hong\s*kong|🇭🇰|\bHK\b/i },
  { label: 'TW', pool: 'asia', re: /台湾|台灣|taiwan|🇹🇼|\bTW\b/i },
  { label: 'JP', pool: 'asia', re: /日本|japan|🇯🇵|\bJP\b|东京|大阪/i },
  { label: 'SG', pool: 'asia', re: /新加坡|singapore|狮城|🇸🇬|\bSG\b/i },
  { label: 'KR', pool: 'asia', re: /韩国|韓國|korea|首尔|🇰🇷|\bKR\b/i },
  { label: 'US', pool: 'us', re: /美国|美國|united\s*states|🇺🇸|\bUS\b|洛杉矶|圣何塞|西雅图|硅谷/i },
  { label: 'UK', pool: 'eu', re: /英国|英國|united\s*kingdom|london|🇬🇧|\bUK\b/i },
  { label: 'DE', pool: 'eu', re: /德国|德國|germany|法兰克福|🇩🇪|\bDE\b/i },
  { label: 'NL', pool: 'eu', re: /荷兰|荷蘭|netherlands|阿姆斯特丹|🇳🇱|\bNL\b/i },
  { label: 'ID', pool: 'asia', re: /印度尼西亚|印尼|indonesia|雅加达/i },
  { label: 'MY', pool: 'asia', re: /马来西亚|馬來西亞|malaysia|吉隆坡/i },
  { label: 'TH', pool: 'asia', re: /泰国|泰國|thailand|曼谷/i },
  { label: 'VN', pool: 'asia', re: /越南|vietnam|胡志明/i },
  { label: 'PH', pool: 'asia', re: /菲律宾|菲律賓|philippines|马尼拉/i },
  { label: 'AU', pool: 'asia', re: /澳大利亚|澳洲|australia|悉尼/i },
  { label: 'CA', pool: 'us', re: /加拿大|canada|多伦多|温哥华/i },
];

function isProbe(name) {
  return typeof name === 'string' && name.charAt(0) === '✅';
}

function detectRegions(config) {
  const names = [];
  const groups = config['proxy-groups'];
  if (Array.isArray(groups)) {
    for (const g of groups) if (g && typeof g.name === 'string' && !isProbe(g.name)) names.push(g.name);
  }
  if (Array.isArray(config.proxies)) {
    for (const p of config.proxies) if (p && typeof p.name === 'string') names.push(p.name);
  }
  const labels = [];
  const pools = [];
  if (!names.length) return { labels: labels, pools: pools };
  const text = ' ' + names.join(' ') + ' ';
  for (const r of REGION_RULES) {
    if (r.re.test(text)) {
      labels.push(r.label);
      if (pools.indexOf(r.pool) < 0) pools.push(r.pool);
    }
  }
  return { labels: uniq(labels), pools: pools };
}

// DoH 池只接受 IP 形式 URL；域名形式会让解析依赖图成环，一律滤掉并报告
function buildDohPool(regionInfo) {
  let list = [].concat(OPT.extraDoh);
  if (regionInfo.pools.length) {
    for (const p of regionInfo.pools) list = list.concat(DOH_POOL[p] || []);
  } else {
    list = list.concat(DEFAULT_DOH);
  }
  list = uniq(list).slice(0, MAX_DOH);

  const urls = [];
  const ips = [];
  const rejected = [];
  for (const u of list) {
    const m = /^https?:\/\/([0-9]{1,3}(?:\.[0-9]{1,3}){3})(?::\d+)?\//.exec(u);
    if (m) { urls.push(u); ips.push(m[1]); }
    else rejected.push(u);
  }
  return { urls: urls.length ? urls : DEFAULT_DOH, ips: uniq(ips), rejected: rejected };
}

function pickProxyGroup(config) {
  const groups = config['proxy-groups'];
  if (!Array.isArray(groups)) return null;
  const names = [];
  for (const g of groups) if (g && typeof g.name === 'string' && !isProbe(g.name)) names.push(g.name);

  if (OPT.proxyGroup && names.indexOf(OPT.proxyGroup) >= 0) return OPT.proxyGroup;
  for (const want of OPT.preferGroup) if (names.indexOf(want) >= 0) return want;
  for (const g of groups) {
    if (!g || isProbe(String(g.name))) continue;
    if (g.type === 'select' && /选择|proxy|节点|机场|手动/i.test(String(g.name))) return g.name;
  }
  for (const g of groups) if (g && g.type === 'select' && !isProbe(String(g.name))) return g.name;
  return names.length ? names[0] : null;
}

// ============================================================
// 节点画像（只读评估，不改节点）
// 度量 mu: proxy -> (reliability, bandwidth, lineTier)，各 in [0,1]
// ============================================================
const QUALITY_TAGS = {
  reliability: [
    { re: /专线|IEPL|IPLC|BGP|CN2/i, w: 1.0 },
    { re: /直连|direct|中转|relay/i, w: 0.7 },
    { re: /家宽|实验|公网|共享/i, w: 0.3 },
  ],
  bandwidth: [
    { re: /1000M|1Gbps|万兆|\bG口\b/i, w: 1.0 },
    { re: /x?[2-9]00M|x?[4-9]倍/i, w: 0.7 },
    { re: /\bx?1(00M)?\b/i, w: 0.4 },
  ],
  lineTier: [
    { re: /IPLC|IEPL/i, w: 1.0 },
    { re: /CN2|GIA|BGP/i, w: 0.8 },
    { re: /直连|直连中转|relay/i, w: 0.5 },
  ],
};

function scoreText(text, rules) {
  for (const r of rules) if (r.re.test(text)) return r.w;
  return 0.2;
}

function profileProxy(p) {
  const text = [p.name, p.type, p.server, p.network, p.sni, p.flow]
    .filter(Boolean).join(' ');
  return {
    reliability: scoreText(text, QUALITY_TAGS.reliability),
    bandwidth: scoreText(text, QUALITY_TAGS.bandwidth),
    lineTier: scoreText(text, QUALITY_TAGS.lineTier),
  };
}

function weightedScore(m) {
  return 0.5 * m.reliability + 0.3 * m.bandwidth + 0.2 * m.lineTier;
}

// 静态画像 + 均衡排序：按加权和降序重排，不删除任何节点；
// 稳定排序保证同分节点保持原相对序。
function sortProxiesByQuality(config) {
  if (!Array.isArray(config.proxies)) return;
  config.proxies = config.proxies
    .map(function (p, i) { return { p: p, i: i, s: weightedScore(profileProxy(p)) }; })
    .sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); })
    .map(function (x) { return x.p; });
}

// ============================================================
// 规则
// ============================================================

// 幂等：新规则与已有规则全局去重，不产生双份
function prependRules(config, rules) {
  if (!Array.isArray(config.rules) || !rules.length) return;
  const block = uniq(rules);
  const blockSet = {};
  for (const r of block) blockSet[r] = 1;
  const rest = config.rules.filter(function (r) { return !(typeof r === 'string' && blockSet[r]); });
  config.rules = block.concat(rest);
}

function insertBeforeMatch(config, rules) {
  if (!Array.isArray(config.rules) || !rules.length) return;
  let idx = config.rules.length;
  for (let i = config.rules.length - 1; i >= 0; i--) {
    if (typeof config.rules[i] === 'string' && /^MATCH,/i.test(config.rules[i])) { idx = i; break; }
  }
  // 与已有规则全局去重后插入
  const existing = {};
  for (const r of config.rules) if (typeof r === 'string') existing[r] = 1;
  const add = uniq(rules).filter(function (r) { return !existing[r]; });
  if (!add.length) return;
  config.rules.splice.apply(config.rules, [idx, 0].concat(add));
}

// ============================================================
// 清理
// ============================================================
function sanitize(config) {
  if (Array.isArray(config.rules)) {
    const seen = {};
    const out = [];
    for (const r of config.rules) {
      const k = typeof r === 'string' ? r : JSON.stringify(r);
      if (seen[k]) continue;
      seen[k] = 1; out.push(r);
    }
    config.rules = out;
  }
  if (Array.isArray(config.proxies)) {
    const seen = {};
    config.proxies = config.proxies.filter(function (p) {
      if (!p || !p.name || seen[p.name]) return false;
      seen[p.name] = 1; return true;
    });
  }
  if (Array.isArray(config['proxy-groups'])) {
    const seen = {};
    config['proxy-groups'] = config['proxy-groups'].filter(function (g) {
      if (!g || !g.name || seen[g.name]) return false;
      seen[g.name] = 1; return true;
    });
  }
  if (config.dns && typeof config.dns === 'object') {
    delete config.dns.fallback;
    delete config.dns['fallback-filter'];
    delete config.dns['fallback-filter-mode'];
  }
}

function fixGroupMembers(config) {
  const groups = config['proxy-groups'];
  if (!Array.isArray(groups)) return;
  const hasProviders = Object.keys(config['proxy-providers'] || {}).length > 0;

  const names = {};
  if (Array.isArray(config.proxies)) for (const p of config.proxies) if (p && p.name) names[p.name] = 1;
  for (const g of groups) if (g && g.name) names[g.name] = 1;
  const builtin = { DIRECT: 1, REJECT: 1, 'REJECT-DROP': 1, PASS: 1, COMPATIBLE: 1, GLOBAL: 1 };

  for (const g of groups) {
    if (!g || !Array.isArray(g.proxies)) continue;
    // 有 use/include-all 的组，成员由 provider 动态注入
    if (g['include-all'] || g['include-all-proxies'] || g.use) continue;
    // 保守：provider 名不可静态枚举，交给 I1 自检报告
    if (hasProviders) continue;
    const kept = g.proxies.filter(function (n) { return builtin[n] || names[n]; });
    if (kept.length) g.proxies = kept;
  }
}

// ============================================================
// DNS
// ============================================================
function buildDNS(doh) {
  const policy = {};
  if (OPT.useGeoSite) {
    policy['geosite:private'] = DNS_CN;
    policy['geosite:cn'] = DNS_CN;
    policy['geosite:geolocation-!cn'] = doh.urls;
  }
  // 无论有没有 geosite，都保留后缀级兜底
  policy['+.cn'] = DNS_CN;
  policy['+.lan'] = DNS_CN;
  policy['+.local'] = DNS_CN;
  policy['+.home.arpa'] = DNS_CN;
  policy['localhost'] = DNS_CN;

  for (const d of OPT.extraDirectDomains) policy[d] = DNS_CN;
  for (const d of FORCE_GLOBAL) policy[d] = doh.urls;
  for (const d of OPT.extraProxyDomains) policy[d] = doh.urls;

  return {
    enable: true,
    listen: '127.0.0.1:1053',          // 只绑本机，不做开放解析器
    ipv6: false,                        // 不查 AAAA，省一轮 RTT
    'prefer-h3': false,                 // QUIC 走代理不可靠，显式关掉
    'use-hosts': true,
    'enhanced-mode': 'fake-ip',
    'fake-ip-range': '198.18.0.1/16',
    'fake-ip-filter-mode': 'blacklist',
    'fake-ip-filter': FAKE_IP_FILTER,

    'default-nameserver': ['223.5.5.5', '119.29.29.29', '180.184.1.1'], // 纯 IP 引导
    'proxy-server-nameserver': DNS_CN,  // 解析机场节点域名：必须直连，否则死循环
    'direct-nameserver': DNS_CN,
    'direct-nameserver-follow-policy': false,
    nameserver: DNS_CN,                 // 默认出口：国内加密 DNS
    'nameserver-policy': policy,        // 分流表
    'respect-rules': true,              // DNS 查询本身也走规则
  };
}

// ============================================================
// 内核调优（只写 Settings 不管理的顶层字段）
// ============================================================
function buildKernelTweaks(config) {
  let needProcess = false;
  if (Array.isArray(config.rules)) {
    for (const r of config.rules) if (typeof r === 'string' && /^PROCESS-/i.test(r)) { needProcess = true; break; }
  }
  return {
    'unified-delay': true,
    'tcp-concurrent': true,
    'keep-alive-idle': 600,
    'keep-alive-interval': 30,
    'find-process-mode': needProcess ? 'strict' : 'off',
    'geo-auto-update': true,
    'geo-update-interval': 24,
    // 关闭订阅自带的 mux：小机场服务器对多路复用支持差，会导致握手卡顿、大文件掉速
    mux: { enable: false },
  };
}

// ============================================================
// 嗅探 / 持久化
// ============================================================
const SNIFFER = {
  enable: true,
  'force-dns-mapping': true,
  'parse-pure-ip': true,
  sniff: {
    HTTP: { ports: [80, '8080-8880'], 'override-destination': true },
    TLS:  { ports: [443, 8443] },
    QUIC: { ports: [443, 8443] },
  },
  'skip-domain': ['+.push.apple.com'],
};

const PROFILE = { 'store-selected': true, 'store-fake-ip': true };

// ============================================================
// 规则块
// ============================================================
function buildDirectRules() {
  return OPT.extraDirectDomains.map(function (d) { return toRule(d, 'DIRECT'); });
}

function buildProxyDomainRules(group) {
  if (!validTarget(group)) return [];
  return OPT.extraProxyDomains.map(function (d) { return toRule(d, group); });
}

function buildGithubRules(group) {
  if (!OPT.githubViaProxy || !validTarget(group)) return [];
  const out = [];
  for (const d of GITHUB_EXACT) out.push('DOMAIN,' + d + ',' + group);
  for (const d of GITHUB_SUFFIX) out.push('DOMAIN-SUFFIX,' + d + ',' + group);
  return out;
}

function buildLeakTestRules(group) {
  if (!validTarget(group)) return [];
  return LEAK_TEST_SUFFIX.map(function (d) { return 'DOMAIN-SUFFIX,' + d + ',' + group; });
}

function buildDnsRoutes(doh, group) {
  if (!OPT.forceProxyForForeignDNS || !validTarget(group)) return [];
  return doh.ips.map(function (ip) { return 'IP-CIDR,' + ip + '/32,' + group + ',no-resolve'; });
}

function buildPrivacyRules() {
  if (!OPT.injectPrivacyRules) return [];
  const all = TRACKER_SUFFIX.concat(OPT.privacyExtra.map(function (d) {
    return d.indexOf('+.') === 0 ? d.slice(2) : d;
  }));
  return uniq(all).map(function (d) { return 'DOMAIN-SUFFIX,' + d + ',REJECT'; });
}

// ============================================================
// 规则遮蔽检测
// 定理：在规则全序链上，若 i<j 且 r_j 的匹配集 ⊆ r_i 的匹配集，
//       则 r_j 对任何被 r_i 覆盖的输入永不生效。
// ============================================================
function parseRule(r) {
  if (typeof r !== 'string') return null;
  const parts = r.split(',');
  if (parts.length < 3) return null;
  return { kind: parts[0].toUpperCase(), value: parts[1], target: parts[2], raw: r };
}

// a 的匹配集 ⊆ b 的匹配集？
function subsetOf(a, b) {
  if (a.kind === 'DOMAIN' && b.kind === 'DOMAIN-SUFFIX') {
    return a.value === b.value || a.value.endsWith('.' + b.value);
  }
  if (a.kind === 'DOMAIN' && b.kind === 'DOMAIN') return a.value === b.value;
  if (a.kind === 'DOMAIN-SUFFIX' && b.kind === 'DOMAIN-SUFFIX') {
    return a.value === b.value || a.value.endsWith('.' + b.value);
  }
  if (a.kind === 'IP-CIDR' && b.kind === 'IP-CIDR') return cidrSubset(a.value, b.value);
  return false;
}

function cidrSubset(a, b) {
  if (!a.includes('/') || !b.includes('/')) return a === b;
  const as = a.split('/');
  const bs = b.split('/');
  const ab = parseInt(as[1], 10);
  const bb = parseInt(bs[1], 10);
  if (!isFinite(ab) || !isFinite(bb)) return false;
  if (ab < bb) return false;
  const mask = function (ip, bits) {
    const n = ip.split('.').reduce(function (acc, x) { return (acc << 8) + (parseInt(x, 10) & 255); }, 0) >>> 0;
    return ((n >>> (32 - bits)) >>> 0);
  };
  return mask(as[0], bb) === mask(bs[0], bb);
}

function findShadowedRules(rules, limit) {
  const out = [];
  const parsed = rules.map(parseRule);
  for (let j = 1; j < parsed.length; j++) {
    const b = parsed[j];
    if (!b || b.kind === 'MATCH') continue;
    for (let i = 0; i < j; i++) {
      const a = parsed[i];
      if (!a || a.kind === 'MATCH') continue;
      if (subsetOf(b, a) && b.target !== a.target) {
        out.push({ earlier: a.raw, shaded: b.raw });
        if (out.length >= (limit || 6)) return out;
        break;
      }
    }
  }
  return out;
}

// ============================================================
// DNS 泄漏评分（只读，启发式；只作展示，不改配置）
// ============================================================
function estimateLeakScore(config, doh) {
  const dns = config.dns || {};
  let score = 100;
  if (!dns['respect-rules']) score -= 20;

  const psn = dns['proxy-server-nameserver'];
  if (Array.isArray(psn) && psn.every(function (x) { return /^\d+\.\d+\.\d+\.\d+$/.test(x); })) score -= 15;

  const fake = {};
  for (const d of (dns['fake-ip-filter'] || [])) fake[d.replace(/^\*\./, '').replace(/^\+\./, '')] = 1;
  let intersect = false;
  for (const d of FORCE_GLOBAL) if (fake[d.replace(/^\+\./, '')]) { intersect = true; break; }
  if (!intersect) score -= 15;

  if (doh.ips.length && Array.isArray(config.rules)) {
    const hasRoute = config.rules.some(function (r) {
      return typeof r === 'string' && r.indexOf('IP-CIDR,' + doh.ips[0] + '/32') === 0;
    });
    if (hasRoute) score -= 10;
  }

  if (Array.isArray(dns['direct-nameserver']) && dns['direct-nameserver'].length) score -= 10;
  if (dns['enhanced-mode'] === 'fake-ip') score -= 10;

  return Math.max(0, score);
}

// ============================================================
// 不变量自检（把静默失效映射为可观测探针）
// ============================================================
function checkInvariants(config, info) {
  const issues = [];

  // I1: 组引用 ⊆ 被定义名 ∪ 内建名
  const names = { DIRECT: 1, REJECT: 1, 'REJECT-DROP': 1, PASS: 1, COMPATIBLE: 1, GLOBAL: 1 };
  if (Array.isArray(config.proxies)) for (const p of config.proxies) if (p && p.name) names[p.name] = 1;
  if (Array.isArray(config['proxy-groups'])) {
    for (const g of config['proxy-groups']) {
      if (!g || !g.name) continue;
      names[g.name] = 1;
      if (Array.isArray(g.proxies)) {
        for (const n of g.proxies) if (!names[n]) { issues.push('悬空:' + n); break; }
      }
    }
  }

  // I2: fake-ip-filter ∩ FORCE_GLOBAL = ∅
  const fake = {};
  for (const d of FAKE_IP_FILTER) fake[d.replace(/^\*\./, '').replace(/^\+\./, '')] = 1;
  for (const d of FORCE_GLOBAL) if (fake[d.replace(/^\+\./, '')]) { issues.push('泄漏面:' + d); break; }

  // I3: 主组缺失
  if (!validTarget(info.group) && (info.github || OPT.extraProxyDomains.length)) issues.push('主组缺失');

  // I4: 被拒 DoH
  if (info.dohRejected && info.dohRejected.length) issues.push('DoH被拒:' + info.dohRejected.length);

  // I5: 规则遮蔽统计
  if (Array.isArray(config.rules)) {
    const shaded = findShadowedRules(config.rules, 6);
    if (shaded.length) issues.push('遮蔽:' + shaded.length + '条');
  }

  // I6: 泄漏分 < 60 → 提示（仅展示）
  const score = estimateLeakScore(config, info.doh || { ips: [] });
  if (score < 60) issues.push('DNS分:' + score);

  return issues;
}

// ============================================================
// 生效自证：先清旧探针，再插新探针（幂等）
// ============================================================
function addDashboard(config, info) {
  if (!Array.isArray(config['proxy-groups'])) return;

  // 先清旧探针，避免多次运行累积
  config['proxy-groups'] = config['proxy-groups'].filter(function (g) { return !isProbe(g && g.name); });
  const groups = config['proxy-groups'];

  const exists = {};
  for (const g of groups) if (g && g.name) exists[g.name] = 1;

  const added = [];
  for (const name of info.lines) {
    if (exists[name]) continue;
    added.push({ name: name, type: 'select', proxies: ['DIRECT'] });
  }
  groups.unshift.apply(groups, added);
}

// ============================================================
// 入口
// ============================================================
function main(config) {
  if (!config || typeof config !== 'object') return config;

  let backup = null;
  try {
    try { backup = deepClone(config); } catch (e) { backup = null; }

    sanitize(config);
    fixGroupMembers(config);

    // 先清旧探针（sanitize 后、区域识别前，保证 detectRegions 不被旧探针干扰）
    if (Array.isArray(config['proxy-groups'])) {
      config['proxy-groups'] = config['proxy-groups'].filter(function (g) { return !isProbe(g && g.name); });
    }

    const regionInfo = detectRegions(config);
    const doh = buildDohPool(regionInfo);
    const group = pickProxyGroup(config);

    if (OPT.sortProxies) sortProxiesByQuality(config);

    merge(config, { dns: buildDNS(doh) });
    merge(config, { sniffer: SNIFFER });
    merge(config, { profile: PROFILE });
    merge(config, buildKernelTweaks(config));

    if (config.tun && typeof config.tun === 'object') {
      merge(config.tun, { 'dns-hijack': ['any:53', 'tcp://any:53'] });
    }

    const privacyRules = buildPrivacyRules();
    prependRules(config, [].concat(
      OPT.customRulesTop,
      privacyRules,
      buildGithubRules(group),
      buildLeakTestRules(group),
      buildProxyDomainRules(group),
      buildDnsRoutes(doh, group)
    ));
    insertBeforeMatch(config, OPT.customRulesBottom);

    const githubOn = buildGithubRules(group).length > 0;
    const issues = OPT.assertInvariants
      ? checkInvariants(config, { group: group, github: githubOn, doh: doh, dohRejected: doh.rejected })
      : [];
    const leakScore = OPT.assertInvariants ? estimateLeakScore(config, doh) : 100;

    if (OPT.showDashboard) {
      let regionText = '默认';
      if (regionInfo.labels.length) {
        regionText = regionInfo.labels.slice(0, 3).join('/');
        if (regionInfo.labels.length > 3) regionText += '+';
      }

      const lines = [
        '✅ 脚本 ' + VERSION + ' 已生效',
        '✅ DNS 防泄漏 · DoH:' + regionText + ' · 分:' + leakScore,
        '✅ GitHub ' + (githubOn ? '走代理' : '未接管') + ' · 隐私拦截:' + privacyRules.length + '条',
      ];
      if (issues.length) lines.push('⚠ 自检:' + issues.slice(0, 2).join(' '));
      if (!backup) lines.push('❌ 深拷贝失败，回退不可用');

      addDashboard(config, { lines: lines });
    }
    return config;
  } catch (e) {
    const out = backup || config;
    if (OPT.showDashboard) {
      try {
        addDashboard(out, { lines: ['❌ 脚本异常：' + String((e && e.message) || e).slice(0, 60)] });
      } catch (e2) { /* 探针也失败时放弃显示，绝不二次抛错 */ }
    }
    return out;
  }
}