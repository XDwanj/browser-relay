# Browser Relay 1.5 与 Codex Browser Use 对比

核验日期：2026-09-08。基于远端主分支 `c9f394d` 开发。

已补齐图片工具输出、持久 JavaScript 会话、语义和坐标动作、跨进程 iframe、差量快照、
批量任务与取消，以及本地 Playwright/CDP 接入。最明显的收益来自减少 Agent—Relay—插件
链路上的逐步往返。本机低延迟条件下耗时基本持平；注入 50 ms 往返延迟时，实测中位耗时
由 2205.6 ms 降至 403.0 ms，约 5.47 倍。

**Codex 原生浏览器的同题实机计时尚未完成。** 当前会话的 `cua.getState()`、
`cua.listBrowsers()` 返回空浏览器列表；创建 `iab` 和 `chrome` 都返回
`Browser is not available`。已请求连接浏览器。以下能力对照来自可核验接口和本机插件发布包；
性能表中的 Playwright 经 Relay CDP 不是 Codex 的专有浏览器后端，也不是 GPT-6 的模型评测。

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

## 提示词与 Skill

Skill 入口由原来的 459 行缩减到 135 行，详细 SDK/HTTP 内容按需加载。执行提示词强调：
先获取当前状态；优先 ref/语义定位；合并已确定步骤；遇到未知页面或状态后观察；用一个可靠的
成功信号结束；不重复读取没有变化的快照；中止后不自动重启任务。

MCP 工具描述与运行时对象一致。`browser_exec` 是本地可信代码执行，独立进程提供超时、
重置与故障隔离，不是安全沙箱；HTTP/远程 Hub 没有任意本机 JS 执行入口。
Skill 安装会核验入口及所有参考文件，防止只复制 SKILL.md 后缺少 SDK 指南。

## 待完成的 Codex 实机对照

运行 `npm run bench:serve` 可启动同一测试页。连接 Codex 浏览器后，在该页执行同一任务，单独记录 CUA 工具调用时间、动作与观察次数、
返回状态字节、纠错次数与可见结果。保留“单步观察”和“短批处理”两个流程，使用相同模型与
推理设置，交替运行至少五次。原始浏览器页和测试页面准备时间应与执行时间分开记录。
在取得这些数据前，本报告不声称 Browser Relay 比 Codex Browser Use 更快或更可靠。
