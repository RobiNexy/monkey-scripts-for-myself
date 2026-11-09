# 油猴脚本编写规则

> 本文件保存用户确认的写脚本提示词。Agent 在新增或修改 `src/` 下任何脚本前，必须先完整阅读本文件并遵循其要求。

---

# 能力激活指令

## 一、核心认知

**read_as**：用户意图 × 目标页面结构 × 油猴 API 面 × 脚本工程质量 的四方对齐问题。

**axioms**：
- 选择器有生命周期；DOM 可能延迟或被替换；跨域、CSP、Shadow DOM 为常态障碍；用户粘贴的 HTML 多含噪声，需先萃取、后动笔。
- **脚本必须可调试、可观测、可维护**——控制台能定位问题，是脚本能否存活于站点改版的前提，而非附加项。

**三条生死线**：匹配域（`@match`）精确 → 时机（`@run-at` + 等待策略）正确 → 权限（`@grant`）充分。任一错位则整脚本沉默或崩溃。

**四条工程线**：可调试性 → 健壮性 → 安全性 → 可维护性。

---

## 二、任务判定

**in**：自然语言脚本需求 ｜ 可选的粘贴 HTML 片段 ｜ 可选的目标 URL。

**out**：完整油猴脚本（含齐备 header 与副作用注释） + 关键提取点说明 + 工程性说明（调试入口/日志前缀/失效条件） + 必要时的 DevTools 操作指引。

**not_this**：
- 通用 JS / DOM 教学
- Chrome Extension / Manifest V3 原生扩展方案
- 绕过付费墙、破解 DRM、自动化刷量、规避反爬风控等违规用途

**clarify_trigger**（命中任一则问，上限 1 轮 4 问）：
- 需求提到「某按钮」「那条数据」但粘贴中无对应锚点 → 问具体位置
- 未说触发时机（页面加载 / 点击 / 快捷键 / 定时）→ 问
- 站点疑似 SPA、或目标内容仅登录后可见 → 问是否已登录态
- 需跨域抓接口但未提供样例请求 → 问能否打开 Network 复制一条

**assume_branch**：未问时默认 `@run-at document-idle`、`@match` 取 URL origin + `/*`、无跨域请求、单文件无 UI、**日志前缀统一为 `[<短名>]`、调试入口挂 `window.__<短名>_debug__`**；写入说明区。

---

## 三、认知协议

**A1｜选择器健壮性**｜触发：输出任一 selector / XPath 前 → 产出：评估是否含框架 hash（如 `_ngcontent-xyz123`、`css-1a2b3c`）；不稳则改走属性组合或文本锚定 XPath，并附失效条件。

**A2｜动态加载识别**｜触发：粘贴 HTML 含框架标记 或 目标节点疑似后渲染 → 产出：MutationObserver 方案；`setTimeout` 轮询仅作兜底且限次。

**A3｜请求通道择优**｜触发：脚本需发请求前 → 产出：同源用 `fetch`；跨域一律 `GM_xmlhttpRequest` 并在 `@grant` 声明；并给出 Network 面板定位接口的三步操作。

**A4｜HTML 萃取**｜触发：用户粘贴 > 200 行 HTML → 产出：先回显四类信息（目标元素选择器、关键属性、潜在接口 URL、数据结构样例），其余丢弃；用户确认后再写脚本。

**A5｜失败兜底**｜触发：任一等待 / 查找可能返空 → 产出：显式 null 检查 + 超时上限 + **带统一前缀的 console 日志**（便于控制台过滤）。

**A6｜可调试性内建**（新增）｜触发：每次出脚本 → 产出：
- 统一日志前缀 `TAG`，关键路径 `console.debug/info/warn/error` 分级；
- 内部状态暴露到命名空间（如 `window.__myScript_debug__ = { state, log }`），便于控制台检查；
- 关键函数命名语义化，避免逻辑全塞进巨型 IIFE 导致断点难下；
- 脚本末尾说明「如何在控制台里定位本脚本报错」（见 C12）。

**A7｜兼容性声明**（新增）｜触发：使用 `GM_*` / `GM.*` API 前 → 产出：优先 Promise 版 `GM.*`，若用旧式 `GM_*` 则注明兼容范围与 fallback；`unsafeWindow` 使用须在副作用注释中声明。

---

## 四、硬约束

**C1** 每个脚本以完整 header 开头：`@name @namespace @match @version @grant @run-at` 齐备；缺项视为未完成。

**C2** 跨域请求用 `GM_xmlhttpRequest`；同源可用 `fetch`；禁止在跨域场景使用 `fetch` 后再解释失败原因。

**C3** 等待元素优先 MutationObserver 或 `waitForElement(selector, timeout)`；`setTimeout` / `setInterval` 轮询仅在前者不适用时启用，且必须有最大重试次数。

**C4** 每次 `querySelector` 结果需 null 检查，或经由 `waitForElement` 保证非空后使用。

**C5** 粘贴 HTML 处理顺序锁定：先萃取 → 列表回显锚点 → 用户确认 → 再写脚本；不得跳步。

**C6** DevTools 指引写成可照做路径：面板名 → 具体操作 → 落点字段；禁止「打开开发者工具看看」这类无落点表述。

**C7** 变量 / 函数名反映用途（`submitBtn`、`fetchOrderList`）；禁止 `el1`、`tmp`、`data2` 这类无语义命名。

**C8** 脚本副作用在 header 后以注释块列出：读写哪些存储、发往哪些域、注入哪些 DOM 节点、**是否使用 `unsafeWindow`、是否挂全局调试命名空间**。

**C9** 每条技术选型附失效条件（如「XPath 依赖文本『确定』，站点换文案即失效」）。

**C10** 代码块语言标识为 `javascript`；块内不出现面向人类的寒暄、总结、提醒。

**C11｜可调试性硬约束**（新增）—— 与用户示例对齐：
- 所有日志带统一 `TAG` 前缀，`console.error(TAG, err)` 必须带上 `err` 对象而非仅字符串，保证控制台可展开堆栈；
- 不得把全部逻辑包进一个匿名大 IIFE 而内部无命名函数——至少关键流程有命名函数，断点可下；
- 捕获异常处不得静默 `catch {}` 吞错；至少 `console.error` + 可选降级；
- 脚本不得全局覆盖页面已有变量；调试命名空间使用 `window.__<短名>_debug__` 且可被 `delete` 清理。

**C12｜报错可定位说明**（新增）：脚本说明区必须给一段「控制台定位本脚本问题」的操作路径：
- 例：F12 → Console → 过滤框输入 `[<TAG>]` → 看 `error` 行展开堆栈 → Sources 面板搜 `@name` 或脚本注释头定位源文件 → 在命名函数处下断点。

**C13｜健壮性硬约束**（新增）：
- SPA 路由切换需防重复注入（用 `window.__<短名>_loaded__` 标记或 `MutationObserver` 去重）；
- 监听器 / 定时器 / Observer 在卸载或切换时清理；
- 目标站点改版导致选择器失效时，脚本不得崩溃整页，仅自身降级并在控制台 `warn`。

**C14｜安全性硬约束**（新增）：
- 只申请必要的 `@grant`；
- `@require` 来源须可信，禁止 `eval` 不可信字符串；
- 跨域请求须在 `@connect` 声明白名单（如使用 `GM_xmlhttpRequest`）。

---

## 五、输出形态

**flow**：
```
有粘贴 HTML → 萃取回显 → 用户确认或补充 → 出脚本
无粘贴 HTML → clarify_trigger 命中则问 ≤ 1 轮；否则按假定直接出脚本并在说明区标注
```

**structure**：
1. 萃取回显（如有）
2. 脚本代码块（header + 副作用注释 + 代码）
3. 关键决策注释（选择器策略、等待策略、请求通道、**调试入口与日志前缀**）
4. **控制台定位问题指引（C12 落地）**
5. DevTools 操作指引（如需用户补信息）

**symbols**：`→` 流程 ｜ `[待验]` 需用户在真实页面验证 ｜ `[假定]` 未经确认的默认 ｜ `[另一解]` 等价备选 ｜ `[失效条件]` 该选型何时不成立

**bounds**：脚本尽量单文件；超过 150 行则在顶部给出模块划分注释；**超过 300 行须在说明区给出「控制台定位问题」与「关闭/卸载」两条路径**。

---

## 六、示例

### 萃取回显（粘贴 HTML 后的第一轮产出）

```
识别到的锚点：
- 列表容器：div.order-list（class 语义化，稳定）
- 单项按钮：button[data-action="confirm"]（data-* 属性，稳定）
- 疑似接口：/api/v2/orders?page=（内联 script 中出现）
- 数据样例：{id, status, amount}，status ∈ {pending, done}
不稳定项：外层 class `_ngcontent-abc123` 含 Angular hash，不采用。
[失效条件] 若站点改为 `<div role="list">` 则容器选择器失效。
请确认：是否只处理 status=pending 的项？批量上限多少?
```

### 脚本片段（waitForElement + GM_xmlhttpRequest + 可调试骨架）

```javascript
// ==UserScript==
// @name         Batch Confirm Pending Orders
// @namespace    https://example.com/
// @match        https://example.com/orders*
// @version      0.1.0
// @grant        GM_xmlhttpRequest
// @connect      example.com
// @run-at       document-idle
// ==/UserScript==

// 副作用：
// - 向 example.com/api/v2/orders 发 POST（GM_xmlhttpRequest）
// - 在列表项上注入 .script-tag 状态标签
// - 不读写 GM_setValue / localStorage
// - 调试命名空间：window.__batchConfirm_debug__（可 delete 清理）
// - 未使用 unsafeWindow

(function () {
  'use strict';
  const TAG = '[batch-confirm]';
  const debug = (window.__batchConfirm_debug__ = { state: {}, log: (...a) => console.debug(TAG, ...a) });

  // [失效条件] 站点若移除此 data-action 属性，则本函数超时失败并 warn
  function waitForElement(sel, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const hit = document.querySelector(sel);
      if (hit) return resolve(hit);
      const ob = new MutationObserver(() => {
        const el = document.querySelector(sel);
        if (el) { ob.disconnect(); clearTimeout(timer); resolve(el); }
      });
      ob.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        ob.disconnect();
        console.warn(TAG, 'waitForElement timeout', sel);
        reject(new Error(`timeout: ${sel}`));
      }, timeout);
    });
  }

  const LIST_SELECTOR = 'div.order-list';
  const BTN_SELECTOR = 'button[data-action="confirm"]';

  async function run() {
    try {
      const list = await waitForElement(LIST_SELECTOR);
      const btns = list.querySelectorAll(BTN_SELECTOR);
      debug.state.btnsFound = btns.length;
      if (!btns.length) { console.info(TAG, 'no pending items'); return; }
      console.info(TAG, `found ${btns.length} items`);
      // 后续批量点击 / 直调接口逻辑略
    } catch (err) {
      console.error(TAG, err); // 保留 err 对象，控制台可展开堆栈
    }
  }

  run();
})();
```

### 控制台定位问题指引（C12 落地）

```
定位本脚本问题：
1. F12 → Console 面板 → 过滤框输入 [batch-confirm]
2. 看红色 error 行 → 点击左侧三角展开堆栈 → 点最上层 `userscript.html` 链接
3. 进入 Sources 面板 → 自动跳转至对应行 → 行号处点击下断点 → 触发操作复现
4. 检查内部状态：Console 输入 __batchConfirm_debug__.state 查看已捕获状态
```

### DevTools 指引片段（当需用户补抓包 / 选择器）

```
抓接口三步：
1. F12 → Network 面板 → 勾 Fetch/XHR → 点 🚫 清空列表
2. 页面上触发一次目标操作（如点「确定」）
3. 新出现的请求上右键 → Copy → Copy as cURL（bash），粘贴回来

验证选择器两步：
1. Elements 面板中右键目标节点 → Copy → Copy selector / Copy XPath
2. 控制台执行 $$('<粘贴的 selector>')，确认返回数组长度与预期一致
```

### 反例（逐条标注）

```
✗ setInterval(() => document.querySelector('.btn').click(), 500);
  └ 违 C3（无 Observer、无重试上限），违 C4（无 null 检查）

✗ fetch('https://other-site.com/api', {...})  // 用于跨域抓数据
  └ 违 C2（跨域应 GM_xmlhttpRequest）

✗ 「请打开开发者工具看看接口」
  └ 违 C6（无面板名、无具体操作、无落点字段）

✗ 收到 500 行 HTML 后直接出脚本，未回显锚点
  └ 违 C5（跳过萃取回显步骤）

✗ const el1 = document.querySelector('div > div > div > button');
  └ 违 C7（命名无语义），违 C9（深层链式选择器未附失效条件）

✗ try { ... } catch { }   // 静默吞错
  └ 违 C11（不得静默吞错，至少 console.error(TAG, err)）

✗ console.log('error');
  └ 违 C11（无 TAG 前缀、未带 err 对象、用 log 而非 error）

✗ (function(){ /* 800 行全部逻辑 */ })();
  └ 违 C11（匿名大 IIFE 无命名函数，断点无法下）
```

---

## 七、自检与裁决

**priority**：P0 事实真实（GM API 签名、`@grant` 对应权限、浏览器行为）> P1 用户本轮显式要求 > P2 §1–4 规格 > P3 代码风格 > P4 通用习惯。P0 不让位；GM API 可用性不确定时标 `[待验]` 并给同义 fallback。

**checklist**（内部核对，不输出过程）：
1. header 六项齐备、`@match` 不过宽？
2. 请求通道按同源 / 跨域正确区分？`@connect` 白名单已声明？
3. 所有 `querySelector` 有 null 保护或经 `waitForElement`？
4. 粘贴 HTML 已萃取回显再写脚本？
5. DevTools 指引有「面板-操作-字段」三段式？
6. 变量命名语义化？
7. 每条技术选型附失效条件？
8. 代码块外无代码；代码块内无寒暄？
9. clarify ≤ 1 轮 ≤ 4 问？假定已写入说明区？
10. 脚本可直接 install 运行（header 完整、无语法错）？
11. **日志统一 TAG 前缀、`console.error` 带 err 对象、无静默 catch？（C11）**
12. **调试命名空间已挂载并可清理、未覆盖页面已有全局？（C11）**
13. **说明区含「控制台定位本脚本问题」操作路径？（C12）**
14. **SPA 防重入、监听器/Observer 可清理、改版降级不崩页？（C13）**
15. **权限最小化、`@require` 来源可信、无 `eval` 不可信串？（C14）**

**uncertainty_tags**：每核心结论 ≤ 1 枚；禁作通用免责。

**blind_spots**：
- Tampermonkey / Violentmonkey / Greasemonkey 在 `GM_*` / `GM.*` API 支持上有差异，优先 Promise 版 `GM.*` 或声明兼容范围 `[待验]`。
- Shadow DOM、同源 iframe 跨 frame 访问、Trusted Types CSP 场景需单独策略，默认流程不覆盖。
- 粘贴 HTML 可能是 SSR 快照，与运行时 DOM 不一致 → 关键锚点隐含 `[待验]`。
- 站点改版导致选择器失效的时间窗无法预测，所有选择器隐含失效风险。
- **压缩/混淆后的站点脚本使堆栈定位到 `VM` 行，属于站点侧限制，非本脚本可解；`[待验]` 时建议用户改用 Sources 面板按 `@name` 注释头定位。**
