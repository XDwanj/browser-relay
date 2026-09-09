# Browser Relay 1.5 与 Codex Browser Use 对比

核验日期：2026-09-09。实现提交 `42c5061`，基于远端主分支 `c9f394d` 开发。

已补齐图片工具输出、持久 JavaScript 会话、语义和坐标动作、跨进程 iframe、差量快照、
批量任务与取消，以及本地 Playwright/CDP 接入。最明显的收益来自减少 Agent—Relay—插件
链路上的逐步往返。9 月 9 日无头浏览器的严格对照中，相对于只读首尾状态的旧接口流程，新动作批次在
注入 50 ms 往返延迟时由 1702.35 ms 降至 394.4 ms，约快 4.32 倍；本机则由 254.1 ms
增至 288.05 ms，慢约 13.4%。首轮的 5.47 倍同时包含移除冗余观察的收益。

**Codex 原生同题测试已完成。** 用户安装官方扩展后，使用 CUA 连接原生 Chrome 扩展，
AX 单步、AX 批量、原生 Playwright 各跑 5 次，15 次均成功。中位耗时分别为 902、436、788 ms。
另补测相同视口的可见 Chromium，Relay actions 中位数 258.4 ms。这里计的是固定任务的内层
工具执行时间，不能当作整个 Codex 产品或 GPT-6 模型的端到端胜率。详见文末原生实测章节。

9 月 9 日增加了旧接口精简流程和轮换执行顺序，见下方补测。新结果应优先于首轮结果用于判断
接口本身的收益；不能把 5.47 倍直接归因于新执行器，也不能宣称相对旧接口在本机普遍存在加速。

## 核验材料与借鉴范围

- 当前 `mcp__cua_repl` 返回的 API/工作流文档：持久 JS、AX 状态差量、索引动作、批量动作后观察。
- 本机官方 browser 插件包 `26.901.51231`：`docs/api.json`、`docs/accessibility.md`、
  `docs/api-use-behavior.md`、`docs/tab-claiming-chrome.md`、`docs/capabilities/tab/cdp.md`、
  `scripts/browser-client.mjs`。该包已经在本机，无需再次克隆。
- `browser-client.mjs` SHA-256：`b9b9bc2319d5ee6aa0b1e481d63bb2130d28102fc7c9080803ab5552185d9037`。
- `docs/api.json` SHA-256：`fc7966ffbc9010252ad3ea745e061068bec3919efff860a87e6013a38a7e277f`。

官方 Computer use 指南建议 GPT-6 使用持久代码执行环境，结合截图和短动作序列，仍支持
自定义函数/MCP 接口。本项目沿用自己的传输和登录态管理，把这些设计落实到执行器与工具层。
[官方指南](https://developers.openai.com/api/docs/guides/tools-computer-use)

异步工具调用与执行中修正属于模型/调用方协议。Relay 提供异步任务、结果查询和取消能力；
模型接收新要求不会自动撤回已执行的浏览器操作。
[异步工具](https://developers.openai.com/api/docs/guides/async-tool-calling)、
[执行中修正](https://developers.openai.com/api/docs/guides/steering)

## 能力对照

| 方面 | Codex 可核验接口/指导 | Browser Relay 1.5 |
| --- | --- | --- |
| 状态读取 | AX 状态优先，支持差量 | Chrome AX 树、角色/名称/状态、引用、独立会话差量；截断不推进基线 |
| 元素定位 | AX 索引、Playwright 定位器 | ref、唯一 role/name、CSS、frameId；重复匹配报错，旧引用失效 |
| 复杂页面 | iframe、DOM/视觉操作 | 同源与跨进程 iframe、Shadow DOM；取不到的 frame 显式报告 |
| 图像 | 图片输出、坐标操作 | MCP image 内容块；PNG 尺寸解析、截图坐标映射、视口变化校验 |
| 执行效率 | 持久 JS，确定动作与观察合并 | MCP browser_exec / CLI repl 保留变量；act 在插件内连续执行并返回状态 |
| 交互动作 | click、drag、move、键盘、滚动等 | 单/双击、悬停、路径拖拽、输入/清空、选择/勾选、条件等待、容器滚动 |
| 中断 | 用户接管/中止后停止 | 按标签排队；任务查询/取消；插件弹窗取消；运行时超时重置并取消所属待执行任务 |
| 标签范围 | 显式选择/接管标签，匹配可见证据 | 显式 tabId、导航后 ref 失效、新建/关闭指定标签；保持已有登录态 |
| 开发接口 | 可选 CDP 能力和 Playwright 接口 | 本地 /cdp 虚拟会话；已测连接、定位、截图、新建、导航、关闭、断开后继续加载 |
| 远程机器 | 本次未实测 | 已用真实扩展 + 本地测试 Hub 验证新动作和取消；生产 Hub 未部署变更 |
| 桌面/其他能力 | 原生应用、剪贴板、文件对话框、WebMCP 等 | 仍聚焦 Chrome；未宣称这些额外能力与 Codex 完全等价 |

Playwright 接入保留用户默认上下文，禁止创建/销毁浏览器配置和调整共享窗口。
调试器自动附加不暂停新 iframe，断开连接不关闭用户浏览器。旧接口/原始 CDP 不应与同一标签上
正在运行的新动作组混用。页面动画可能改变元素位置，即使 URL/视口未变；坐标前仍须观察。

## 同题执行基准

任务：搜索 invoice，选择 Owner=Alice，勾选 Active only，提交并等待页面显示
`Found: invoice / alice / active`。每种方案都检查这个可见结果。

### 如何控制条件与计时

- 环境：macOS、Node v22.23.1、Playwright 1.63.0、Chromium 153.0.8010.12。
  使用真实 Chromium 的 headless 模式和真实扩展，视口 1280 × 1000；并非浏览器模拟对象。
- 测试页：[automation.html](../tests/fixtures/automation.html)。四个表单操作后，页面固定延迟
  120 ms 更新状态；这是已知的异步业务延迟，所有方案相同。页面没有外部业务服务器、登录或验证码。
- 每次测量前重新加载页面并置为当前页。浏览器启动、扩展连接、页面重载、Playwright 连接建立、
  调试计数读取均不计入执行耗时；第一次实际观察起计时，最后一次结果快照返回后停止计时。
- 独立的最终 `#status` 文本断言在计时结束后运行，严格检查完整结果。提交后的等待及最后一次
  快照在计时内。断言失败会让脚本退出，因此当前样本不能用于估计一般网页的成功率。
- 首轮每轮按旧 HTTP → 新 actions → Playwright 固定顺序执行，本机各 7 次、延迟各 5 次；
  没有随机化，也没有排除专门的预热样本。后面的补测使用循环轮换顺序以减小位置偏差。
- 50 ms RTT 注入位置是 **Relay 与扩展之间**：本地 TCP 代理收发两个方向各延迟 25 ms。
  Agent 与 HTTP 服务之间仍为本机连接，页面自身网络未加延迟。命令可流水执行，不能简单用
  “命令数 × 50 ms”推算总时长。这不是公网弱网、丢包或带宽受限实验。
- 同一进程、同一个临时浏览器配置、同一测试页顺序执行。Playwright 客户端只在其方案运行期间
  连接，避免其他方案被后台 CDP 流量影响。

### 每条路径到底做了什么

| 路径 | 可复核操作序列 | HTTP 次数 | 状态观察次数 |
| --- | --- | ---: | ---: |
| 旧 HTTP | 快照 → type → 快照 → eval 选择 Owner → 快照 → click 勾选 → 快照 → click 提交 → wait → 快照 | 10 | 5 |
| 旧 HTTP 精简，补测 | 快照 → type → eval 选择 Owner → click 勾选 → click 提交 → wait → 快照 | 7 | 2 |
| 新 actions | observe 获取 ref → actions 内 fill/select/check/click/wait，并返回最终状态差量 | 2 | 2 |
| Playwright 经 Relay | 初始 ariaSnapshot → fill → selectOption → check → click → waitFor → 最终 ariaSnapshot | WebSocket | 2 |

这里比较的是**已编写好的确定性工具执行路径**。旧方案使用已知 CSS，actions 从当轮快照
提取 ref，Playwright 使用已知语义定位器；没有让模型阅读三个不同 Skill 后自主决定动作。
旧接口的 eval 也能编写更大的 DOM 动作批次，但这可能改变原生输入事件语义，本次未作为完整替代方案测试。

### 9 月 8 日首轮结果

| 方案 | 完成次数 | 中位耗时 | HTTP 请求数 | Relay→插件命令数 | 快照文本总量 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 旧 HTTP 工作流，本机 | 7/7 | 273.5 ms | 10 | 39 | 2301 B |
| 新批量动作，本机 | 7/7 | 278.7 ms | 2 | 2 | 2202 B |
| Playwright 经 Relay CDP，本机 | 7/7 | 334.8 ms | 0 | 73 | 1425 B |
| 旧 HTTP 工作流，注入 50 ms RTT | 5/5 | 2205.6 ms | 10 | 38 | 2301 B |
| 新批量动作，注入 50 ms RTT | 5/5 | 403.0 ms | 2 | 2 | 2202 B |
| Playwright 经 Relay CDP，注入 50 ms RTT | 5/5 | 2465.1 ms | 0 | 70 | 1425 B |

所有数值取各次运行的中位数。HTTP 计数不包括 CDP WebSocket；命令数是逻辑请求数，并非 TCP
包数。文本量是 UTF-8 字节，不是 token。Playwright 的完整传输字节没有采集。
旧方案遵循原 Skill 的单步动作与快照流程，选项操作通过旧 eval 接口；新方案一次动作组完成。

新方案初始快照覆盖更多内容（iframe、Shadow DOM、引用与状态），完整 JSON 还包含任务与视口
元数据，因此不能据此声称所有返回体都更小。单次“新增一行”变化的快照由
1880 B 全量降为 160 B 差量。

慢链路实验使用真实 Chromium 和扩展，在本地 TCP 代理两个方向各注入 25 ms 延迟；
这是受控延迟实验，不代表生产互联网的真实 RTT。未运行模型推理，未计模型生成/思考耗时，
也没有估算模型任务成功率或 API 费用。

首轮逐次耗时，单位 ms；顺序与原始 JSON 的 iteration 一致：

| 条件 / 路径 | 逐次耗时 |
| --- | --- |
| 本机 / 旧 HTTP | 292.4, 274.7, 291.8, 270.2, 273.5, 269.7, 261.4 |
| 本机 / 新 actions | 278.7, 284.1, 265.9, 288.1, 269.7, 278.3, 280.1 |
| 本机 / Playwright | 293.0, 329.3, 338.5, 323.5, 338.4, 334.8, 342.5 |
| 50 ms RTT / 旧 HTTP | 2218.2, 2205.2, 2205.6, 2204.1, 2209.3 |
| 50 ms RTT / 新 actions | 411.1, 385.3, 403.0, 410.4, 382.9 |
| 50 ms RTT / Playwright | 2422.6, 2473.1, 2470.5, 2455.5, 2465.1 |

完整 JSON 返回体的本机中位数是旧 3521 B、新 3919 B，增加约 11.3%；快照文本总量
2301 → 2202 B 仅减少约 4.3%。新增一行的差量快照减少约 91.5%，是另一项局部实验，
不能替代整道任务的 token 节省数据。

- [本机原始样本](benchmarks/browser-runtime.json)
- [50 ms RTT 原始样本](benchmarks/browser-runtime-rtt50.json)
- [可复跑脚本](../scripts/benchmark-browser.mjs)

```bash
npm ci --ignore-scripts
npx playwright install chromium
npm test
npm run test:browser
npm run bench:browser
BROWSER_RELAY_BENCH_RUNS=5 BROWSER_RELAY_BENCH_RTT_MS=50 npm run bench:browser
```

测试使用临时 Chrome 配置、复制的扩展和随机端口，不操作用户日常浏览器或登录账号。
测试只替换扩展默认端口以连接隔离 Relay。截图、DOM 结果都来自真实浏览器；基础单元测试另有
模拟传输，以检查错误、字节边界、进程超时、任务顺序与取消。

### 9 月 9 日补测：精简旧流程并轮换顺序

为区分“减少冗余观察”和“插件内执行批次”的收益，增加 `legacy-minimal`：保留旧接口和相同动作，只移除三次中间快照。四种路径在每个网络条件下各执行 8 次；每轮将执行顺序向前轮换一位，每条路径在四个位置各出现两次。不是随机实验，也没有模型推理。

旧 API 工作流运行在当前 1.5 的兼容接口上，并未启动历史 1.4 二进制。因此这是同一实现中不同调用路径的对照，不是两个历史发布版本的全量 A/B。

| 条件 | 路径 | 完成 | 中位耗时 ms | 范围 ms | HTTP | 插件逻辑命令 | 快照 B | 完整 JSON B |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 本机 | 旧 HTTP，每步观察 | 8/8 | 262.1 | 257.1–285.9 | 10 | 39 | 2301 | 3522.0 |
| 本机 | 旧 HTTP，只观察首尾 | 8/8 | 254.1 | 245.5–261.8 | 7 | 30 | 926 | 1670.0 |
| 本机 | 新 actions 批量 | 8/8 | 288.1 | 262.3–293.1 | 2 | 2 | 2202 | 3918.5 |
| 本机 | Playwright 经 Relay CDP | 8/8 | 329.2 | 293.1–332.7 | WS | 73 | 1425 | 未采集 |
| 注入 50 ms RTT | 旧 HTTP，每步观察 | 8/8 | 2210.6 | 2197.0–2223.9 | 10 | 38 | 2301 | 3535.0 |
| 注入 50 ms RTT | 旧 HTTP，只观察首尾 | 8/8 | 1702.3 | 1696.5–1710.3 | 7 | 29 | 926 | 1671.5 |
| 注入 50 ms RTT | 新 actions 批量 | 8/8 | 394.4 | 379.0–405.6 | 2 | 2 | 2202 | 3923.5 |
| 注入 50 ms RTT | Playwright 经 Relay CDP | 8/8 | 2466.8 | 2433.5–2494.6 | WS | 70 | 1425 | 未采集 |

- 相对于精简旧流程，新方案本机耗时增加约 13.4%（多 33.9 ms）；不能声称本机更快。
- 注入 50 ms RTT 后，新方案相对精简旧流程快 4.32 倍，时间减少约 76.8%。HTTP 从 7 降为 2，插件逻辑命令从 29 降为 2。
- 相对于精简旧流程，新方案快照 2202 B 大于 926 B，完整 JSON 也更大。两者包含的状态范围不同：新版覆盖 frame、Shadow DOM、引用和状态，不能按字节判断信息质量。
- 当前证据支持“中高延迟链路上批次执行有效”。并未证明新接口对所有短任务更省时、更省字节，更未证明比 Codex 原生快。

补测逐次耗时，单位 ms；各行按 iteration 排列，而非实际全局执行顺序：

| 条件 / 路径 | 逐次耗时 |
| --- | --- |
| 本机 / 旧 HTTP，每步观察 | 285.9, 262.6, 269.8, 257.1, 261.5, 268.4, 260.5, 257.9 |
| 本机 / 旧 HTTP，只观察首尾 | 252.4, 246.2, 254.4, 260.3, 245.5, 261.8, 260.1, 253.8 |
| 本机 / 新 actions 批量 | 276.4, 286.0, 290.1, 293.1, 292.1, 291.0, 262.3, 269.4 |
| 本机 / Playwright 经 Relay CDP | 293.1, 324.5, 328.0, 331.7, 332.7, 326.5, 330.4, 330.5 |
| 50 ms RTT / 旧 HTTP，每步观察 | 2215.4, 2197.0, 2198.7, 2214.3, 2223.9, 2199.9, 2214.2, 2207.0 |
| 50 ms RTT / 旧 HTTP，只观察首尾 | 1703.3, 1699.6, 1700.8, 1708.8, 1696.5, 1710.3, 1701.4, 1703.4 |
| 50 ms RTT / 新 actions 批量 | 401.5, 405.6, 379.0, 389.2, 387.6, 398.7, 390.1, 402.9 |
| 50 ms RTT / Playwright 经 Relay CDP | 2433.5, 2468.9, 2484.7, 2454.4, 2494.6, 2482.2, 2456.4, 2464.7 |

偶数样本的中位数取排序后中间两项的平均值，范围列保留最小值和最大值。原始 JSON 保留每次执行位置、耗时和计数。

- [补测本机原始数据](benchmarks/browser-runtime-balanced.json)
- [补测延迟原始数据](benchmarks/browser-runtime-balanced-rtt50.json)

```bash
BROWSER_RELAY_BENCH_SUITE=balanced BROWSER_RELAY_BENCH_RUNS=8 npm run bench:browser
BROWSER_RELAY_BENCH_SUITE=balanced BROWSER_RELAY_BENCH_RUNS=8 BROWSER_RELAY_BENCH_RTT_MS=50 npm run bench:browser
```

补测写入单独的 `browser-runtime-balanced*.json`，保留首轮原始文件。

## 提示词与 Skill

Skill 入口由原来的 459 行缩减到 135 行，详细 SDK/HTTP 内容按需加载。执行提示词强调：
先获取当前状态；优先 ref/语义定位；合并已确定步骤；遇到未知页面或状态后观察；用一个可靠的
成功信号结束；不重复读取没有变化的快照；中止后不自动重启任务。

MCP 工具描述与运行时对象一致。`browser_exec` 是本地可信代码执行，独立进程提供超时、
重置与故障隔离，不是安全沙箱；HTTP/远程 Hub 没有任意本机 JS 执行入口。
Skill 安装会核验入口及所有参考文件，防止只复制 SKILL.md 后缺少 SDK 指南。

具体借鉴与未证明的部分：

| 从 Codex 学到的做法 | 在 Relay 的落点 | 证据与边界 |
| --- | --- | --- |
| 持久 JS 保留浏览器和标签句柄 | `server/script-runtime.js`、`runtime-worker.js`、CLI repl、MCP exec | 已测跨调用保留变量；尚未测模型实际减少多少输出 token |
| 一轮内合并确定动作，再观察 | 扩展 `automation.js` 批次执行、SDK act | 同题基准直接证明跨链路命令减少 |
| 默认 AX 与差量；需要视觉判断才截图 | observe、引用、每会话差量、图片输出 | 已测差量与坐标；尚未取得 Codex 原生截图编码、字节或耗时对照 |
| 用当前状态定位，失败后先重新观察 | 旧 ref 失效、重复语义目标报错、Skill 错误恢复规则 | 有真实浏览器场景验证；不代表模型在未知站点更少犯错 |
| 一个充分的成功信号就结束 | Skill 要求检查状态文本或业务结果 | 基准采用完整状态文本断言；未进行提示词 A/B 模型实验 |
| 文档按需加载，避免每轮塞全部 API | 135 行入口与按需引用文件 | 行数下降不是 token 成本或任务完成时间的实测结论 |

所以，目前可以交付的是执行器能力、传输效率和工作流设计的改进。GPT-6 的视觉判断、任务规划、
网页泛化成功率、模型思考时间和费用，需要相同模型设置的独立 Agent 评测，不能由接口数量推导。

## Codex 原生实机对照：已完成

### 安装过程与已解决的阻塞

2026-09-09 早先按用户要求用 CUA 尝试安装官方扩展，遭遇以下问题。随后用户完成安装，
本会话成功连接 Chrome 扩展并执行测试。下表是历史诊断，不代表当前仍无法连接：

| 步骤 | 工具结果 | 可得结论 |
| --- | --- | --- |
| CUA 发现浏览器 | `browsers: []` | 安装前没有可用 Browser provider |
| CUA 打开 Codex 自身应用 | `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` | CUA 自身限制，不能代点该应用设置 |
| CUA 打开 Chrome，尝试两次 | `cgWindowNotFound` | 取不到可操作窗口；不能确认原因就是锁屏 |
| CUA 打开访达 | `cgWindowNotFound` | 问题也影响其他应用，安装界面未能打开 |
| 本地官方诊断脚本 | Default profile 没有可读 Preferences；扩展、native host 未检出 | 仅代表检查到的本地文件路径；不排除 CUA 桌面与文件系统或 profile 不一致 |

用户安装后 CUA 返回 Chrome extension provider，测试页可正常创建和操作。未尝试绕过 CUA 自身应用限制。
[官方安装说明](https://learn.chatgpt.com/docs/chrome-extension)

运行 `npm run bench:serve` 可启动同一测试页。完整的同题提示、计时边界、单步/批次流程、
失败样本处理及环境一致性要求见[原生测试协议](benchmarks/codex-native-protocol.md)；
连接尝试保存在[机器可读状态记录](benchmarks/codex-native-status.json)。原生 Browser、
原生桌面 Computer Use、Playwright 经 Relay 必须分别标注，不能互相替代。

### 实际执行与计时口径

使用 `cua.createBrowserTab('chrome', fixtureUrl, ...)` 新建专用标签，浏览器视口实测为
1466 × 925。任务与 Relay 完全相同。通过原生 AX 返回的当前索引执行，绝不跨页面重载复用索引；
每次新试验读取完整初始 AX，后续采用默认差量，按新增、修改、删除的节点维护当前目标。

原生三条路径：

| 路径 | 操作 | 浏览器 API 次数 | 状态读取次数 |
| --- | --- | ---: | ---: |
| AX 单步观察 | getAXState；setValue Search + 状态；setValue Owner + 状态；setValue checkbox + 状态；click 提交 + 状态 | 9 | 5 |
| AX 批量 | getAXState；连续三个 setValue 和 click；最终 getAXState | 6 | 2 |
| 原生 Playwright | domSnapshot；fill、selectOption、check、click、waitFor 可见结果；domSnapshot | 7 | 2 |

AX 的状态读取已经等待到本题的 120 ms 异步结果，不额外插入固定 sleep。原生 Playwright
显式等待结果可见；两条路径都要求最后状态包含完整成功文本。

先做各一轮交互式探索：AX 单步 5 次外层 `js`，内层 API 累计 1190 ms，整轮经过 29552 ms。
后者包含模型决策、工具调度与会话间隔，并非纯浏览器耗时。探索时一次计时闭包因跨 REPL
重绑定记到了旧数组，批量汇总曾错误显示 0；原始逐操作记录可恢复为 390 ms。随后改为修改
固定日志对象，解决计时记录问题；两轮探索均不进入正式中位数。

正式数据采用**已验证流程的确定性脚本回放**。AX 两条路径各 5 次，先后顺序逐组交替，
每个 `js` 执行一组两条路径；原生 Playwright 随后另跑 5 次，未与 AX 随机交错。
这一步没有让模型在每次状态读取后重新规划，因此适合分析工具执行成本，不能当成 15 次独立模型任务。
记录每个 API 的开始、结束时间，以及重载之后到最终状态返回的脚本时间；外层工具耗时另列。

### 原生结果及可见浏览器 Relay 对照

Relay 补测使用隔离配置的可见 Chromium 153.0.8010.12，并设同样的 1466 × 925 视口。
四条 Relay 路径各跑 8 次，循环轮换顺序，32 次全部成功；未注入延迟。

| 实测路径 | 成功 | 内层执行中位 ms | 范围 ms | 状态文本 B |
| --- | ---: | ---: | --- | ---: |
| Codex 原生 AX 单步 | 5/5 | 902 | 860–915 | 3287 |
| Codex 原生 AX 批量 | 5/5 | 436 | 411–443 | 3178 |
| Codex 原生 Playwright | 5/5 | 788 | 763–816 | 1706 |
| Relay 旧 HTTP，每步观察，可见 Chromium | 8/8 | 265.25 | 见原始样本 | 2301 |
| Relay 旧 HTTP，只观察首尾，可见 Chromium | 8/8 | 262.95 | 见原始样本 | 926 |
| Relay actions，可见 Chromium | 8/8 | 258.4 | 见原始样本 | 2202 |
| Playwright 经 Relay CDP，可见 Chromium | 8/8 | 264.5 | 见原始样本 | 1425 |

原生逐轮脚本耗时，单位 ms：

- AX 单步：910, 902, 915, 900, 860。第 4 轮 API 累计 899 ms，另有 1 ms 脚本开销。
- AX 批量：413, 443, 411, 441, 436。
- 原生 Playwright：816, 813, 780, 788, 763。

原生 AX 合并动作后约快 **2.07 倍**，减少约 **51.7%** 时间；状态字节只减少 **3.3%**，
因为该题批量修改后返回了完整 AX，而逐步修改可返回差量。不能把少读三次状态理解成少三份全量快照。

这道题的 Relay actions 内层时间比原生 AX 批量低约 **40.7%**（258.4 对 436 ms，约 1.69 倍速度比）。
这个数值有明确限制：原生是用户 Chrome 配置，Relay 是隔离 Chromium；原生 Chrome 版本读取被
浏览器 URL 策略阻止，版本记为 unknown，没有通过其他通路绕过；浏览器后端和快照内容也不完全相同。
它是本机该固定任务的描述性对照，不能宣称普遍比 Codex 快 1.69 倍。

原生 API 计时不含外层 MCP/工具调度，Relay 的 HTTP 计时也不含外层 Agent 工具调用。
原生每组两个 AX 回放的外层 `js` 约 3.8–5.0 秒，包含重载、两个任务、工具调度，不能拿这个数字
直接除以 Relay 单题 258 ms。相关外层观测已保存在原始 JSON。模型配置、token 和实际费用未测，
也没有在 Codex 原生链路中注入对应的 50 ms 延迟。

### 能力实测与可吸收的经验

除了 15 次表单任务，还在同一原生标签上完成：

- AX 直接点击 Shadow DOM 按钮：显示 `Shadow done`。
- AX 分别点击同源和跨域 iframe 按钮：节点 34、37 均显示 `Frame done`。
- 根据原生截图，在画布可见绿色目标内坐标点击：显示 `Canvas done`。
- 根据同一截图拖动蓝色方块：显示 `Drag done`。

因此，表单、Shadow DOM、同源/跨域 iframe、截图坐标和拖拽现在都有原生实测证据。
原生取消、文件对话框、下载、多标签并发、生产复杂站点仍未进行对等实测，不能称为全面能力等价。

对项目的直接启示是：简单控件优先 AX/ref；把已经确定的填写与点击合并；读取状态按决策需要安排。
本次原生 AX 状态获取约 157–200 ms，批量后的两次状态获取占了主要时间。
原生 Playwright 的 check/click 各约 272–292 ms，占该路径的大部分时间；计时只定位到 API，
没有核实其内部开销原因。保留 Playwright 用于复杂定位与开发集成，不应把它当成短任务必然更快的路径。

- [原生 15 次逐操作计时、完整去重状态和能力结果](benchmarks/codex-native.json)
- [Relay 可见浏览器 32 次原始数据](benchmarks/browser-runtime-balanced-headed.json)

可见浏览器 Relay 复跑命令：

```bash
BROWSER_RELAY_BENCH_SUITE=balanced BROWSER_RELAY_BENCH_RUNS=8 BROWSER_RELAY_BENCH_HEADED=1 BROWSER_RELAY_BENCH_WIDTH=1466 BROWSER_RELAY_BENCH_HEIGHT=925 npm run bench:browser
```
