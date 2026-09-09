# Browser Relay 与 Codex Browser Use：差距审计

日期：2026-09-09。主对照为 **Browser Relay 自身的观察/动作接口，与 Codex Browser Use 的原生 AX/截图/动作工作流**。
不把独立 Playwright 或 Codex 的内部 locator 分支当成主比较对象。此前表单微基准保留在
[历史报告](browser-use-comparison.md)，本报告回答复杂任务还有哪些差距、哪些值得吸收，以及已修复什么。

## 结论

在已测的基本交互上已经接近，但还不能说完整体验等价。Codex 更突出的优势是可读的页面上下文、
原生控件语义，以及标签归属、会话/轮次、接管、结束清理的整体设计。Relay 的长处是 CLI/MCP/SDK
接入、插件内批次、远程设备与可控传输；简单表单的速度数字不能覆盖这些差距。

本轮用新探针确认了 Relay 的八类具体缺口并修复。13 类探针每类三次，修复前通过 5 类，
修复后全部 13 类通过。**这是挑选问题的回归集，不是网站总体成功率，也不能折算成与 Codex 的百分比差距。**
原生 AX 则完成了 13 条交互工作流记录和 2 个额外行为探针，覆盖相同的 13 类情况；不将语义不同
的路径硬算成同一总分。

## 怎样测，结果怎样认定

测试页为 [browser-gaps.html](../tests/fixtures/browser-gaps.html)。每题重新打开，只有本地合成数据，
不操作真实账号或生产网站。每道题有独立的可见业务结果，例如 `South saved`、`Custom checked=true`。
对“拒绝操作”类探针，另外检查原值未改变。禁用选项属于明确设定的 UI 一致性要求。

Codex 一侧使用本会话的 `mcp__cua_repl`：先读取原生 AX，依据当前父子关系、控件状态和索引操作，
再读取结果。动态控件在出现或启用后重新观察，不猜索引。移动按钮用 AX 语义动作；截图坐标、
拖拽、普通 iframe/Shadow DOM 的基础能力已在上一轮真实验证。

Relay 一侧使用同一测试页，通过实际扩展的 `/api/observe`、`/api/actions` 与 SDK 执行。
测试工具仅负责启动隔离的可见 Chromium、重置页面和独立验收，**不参与两方能力排名**。
开始和结束状态外，动态等待在插件内完成。对照前后保留相同动作参数，包含明确的动作级 `timeoutMs`；
旧实现忽略该参数，修复后执行有界的准备状态等待。

原生工作流是交互式探索，只有每种流程的一条主记录；会话中包含研究和调度间隔，因此不排名这轮
墙钟耗时。原始文件中的内层 API 时间仅供定位开销，其中一次观察耗时 5583 ms，保留这个异常值，
不据此推断稳定延迟。上一轮五次重复的表单数据另有固定计时口径，也不是独立模型盲测。

## 主对照结果

| 场景 | Codex Browser Use 原生 AX 实测 | Relay 修复前 | Relay 修复后 |
| --- | --- | --- | --- |
| 延迟启用 | 观察到 disabled；启用后重新观察并点击完成。直接盲点 disabled 不报错、也没完成业务 | 立即 `element_disabled`，动作级 timeout 无效 | 有界等待启用，完成 |
| 动态出现 | 出现后获取当前 AX 节点并完成 | 目标不存在立即失败 | 有界等待出现，完成 |
| 临时遮挡 | 观察覆盖层出现、消失，再点击完成 | 立即拒绝，不能按传入 timeout 等待 | 插件内等待遮挡消失后完成 |
| 移动按钮 | AX 根据控件语义直接激活成功 | 本探针已通过 | 仍通过；显式等待时还检查位置稳定 |
| 两区域内同名 Save | AX 父容器清楚显示 North/South，选择 South 的子按钮完成 | 缺少 scope，语义目标匹配两项而失败 | snapshot 提供 within；支持 scoped target 与 SDK 子定位器 |
| DOM 节点替换 | 重新观察后使用当前节点，完成 | 语义目标已能重新解析 | 保留；另测旧 ref 被拒绝，不自动指向新节点 |
| 原生 checkbox 业务事件 | `setValue` 只改变选中值，本页 onclick 不执行；改用 `click` 得到 trusted=true 的业务结果 | check 走 DOM click，事件 trusted=false | 前台使用鼠标输入，trusted=true；校验状态且重复 check 不二次点击 |
| 自定义 ARIA checkbox | 从 AX 看到 checkbox，点击成功 | `not_checkable` | 支持 ARIA checkbox/radio/switch，并校验目标状态 |
| 禁用 option | 明确报 disabled，保持 Open | 可以选中禁用项 | 明确拒绝，保持原值；也处理禁用 optgroup |
| 只读输入 | AX 未标为 settable；赋值时报错，原值不变 | 已正确拒绝 | 保留 |
| contenteditable | setValue 后业务 input 结果更新 | 已通过 | 保留 |
| Shadow DOM 下的永久遮挡 | AX 能触发遮挡下按钮的语义动作 | 已拒绝覆盖下的鼠标动作 | 保留；不把原生的语义激活与鼠标命中混为一谈 |
| iframe 上层永久遮挡 | AX 同样能触发被遮挡 iframe 内按钮 | 鼠标事件被挡住，但动作返回成功 | 检查祖先 iframe 在实际动作点的命中；明确拒绝 |

原生“语义激活能穿过视觉遮挡”是本轮观察到的行为，不代表它一定错误或一定应该复制。
对本项目的鼠标动作，选择保留覆盖检查。对业务结果，控件值变化与事件触发必须分开验证。

原生工作流所需观察次数：简单范围定位、checkbox、富文本一般 2 次；重渲染 3 次；本次延迟启用、
出现、临时遮挡各 4 次。Relay 成功批次通常是初始 observe 加最终状态，共 2 次；等待在插件内进行。
这说明批次和条件等待可以减少 Agent 往返，但不能据此把原生的探索过程和脚本回放总耗时直接相除。
Codex Browser Use 还可以选用其他原生接口；这里的观察次数是此次默认 AX 路径的记录，不是产品的最优次数或能力上限。

### 回归中进一步发现的 iframe 时序问题

复测出现过跨进程 iframe 的 pointerdown 落在父文档、pointerup 才到子文档的情况，按钮没有
收到完整点击，却返回了成功。事件记录见[复现证据](benchmarks/iframe-routing-regression.json)。
证据指向父级滚动后 DOM 几何已更新，而输入路由尚未稳定。现在父 iframe 容器发生滚动后先等待
渲染帧，再派发输入；修复后独立 15 轮和回归里的 20 轮连续操作均通过。只在实际滚动时增加等待，
不通过重复点击掩盖问题。闭合 Shadow DOM 与 iframe 局部覆盖也有独立回归，防止过度拒绝。

### 新等待功能的成本

对已经可点击的 Add row 控件，分别跑 7 次：默认路径中位 36.9 ms，显式设置动作 timeout 的
稳定性等待路径 85.2 ms，多约 48.3 ms。计时只包含 Relay 动作及最终观察，不含准备和独立断言。
因此 Skill 只在预期出现、启用、移动或遮挡变化时建议设置等待；不默认给所有动作加等待。
[原始数据](benchmarks/browser-readiness-cost.json)、[复跑脚本](../scripts/benchmark-browser-readiness.mjs)。

## 插件代码看到了什么

读取的是 Chrome 已安装扩展 **1.26.901.11451**，以及本机桌面 browser 插件 **26.901.51231**。
Chrome 扩展的 `background.js` 为 355753 B，`content-scripts/codex.js` 为 35143 B，
`foreign-frame-monitor.js` 为 5158 B；没有 source map。使用只读格式化副本分析，未修改官方插件。
这些是发行包的 JavaScript 和随包文档，并非完整开发源码；编译组件和线上实际运行分支不全可见。

| 从发行代码核验的设计 | 具体证据 | 对 Relay 的启示 |
| --- | --- | --- |
| 标签有明确归属 | background 的 claimTab/getOwningSessionId/isClaimedBySession，绑定 sessionId、turnId、instanceId，拒绝另一活跃 session 占用 | “按标签排队”只能保证动作组顺序，还不等于整个工作流的独占 |
| 轮次结束与交接 | setTabMark、handoff leases、turn marks；区分保留成果、交给用户、临时标签 | 增加显式 claim/release、handoff 与任务标签清理，而不是默认关闭用户标签 |
| 请求和用户控制有生命周期 | startRequest/finishRequest/stopSession、AbortController、activeRequests、每标签 cursor 状态 | 当前弹窗取消可用，但还缺按会话管理的接管、状态呈现与恢复 |
| 断线时明确失败 | requestHost 的请求 ID/期限；native port 断开时 rejectPendingHostRequests，再调度重连 | 重连与重放必须分开；已经可能执行的写动作不自动重发 |
| 客户端失联后的清理 | client-heartbeat-alarm 定期检测；无客户端时停会话、detach 调试器 | 需要治理进程消失后的所属任务/标签状态，不只依赖正常结束路径 |
| 按需状态和文档 | accessibility.md、api-use-behavior.md：AX 优先、差量、当前索引、确定动作成组、一次充分成功验证 | 已融入 Relay Skill；本轮补充事件语义、条件等待与范围定位 |
| 结构化边界 | 类型/schema、能力发现；桌面服务有受限的只读 DOM 求值与独立修改操作 | Relay eval 的边界较粗，可补只读查询接口与更细的能力描述 |

不要因为扩展里有很多侧边聊天资源就认为控制能力更强；这些 UI 资源不计作浏览器执行能力。
Chrome 扩展与桌面服务各有职责，单看扩展的文件大小也不能推断延迟。

文件版本、SHA-256 和定位符见[源码审计记录](benchmarks/codex-extension-audit.json)。独立实现本轮改动，
没有把官方 bundle 代码复制到项目。

## 本轮实际吸收并落地

1. **保留上下文的语义定位。** AX 输出补 `within`、结构化节点补 `parentRef`；支持
   `tab.getByRole('group',{name:'South'}).getByRole('button',{name:'Save'})`。不默取第一个重名按钮。
2. **把可预期的等待放在执行器里。** 动作可设 `timeoutMs`，在派发前等待出现、启用、无遮挡、位置稳定；
   支持 `wait state=enabled`。默认仍快速报告错误；只有明确设置时才等待。取消、任务总时限继续生效。
3. **区分状态赋值与业务输入。** 前台 check 使用真实鼠标输入，支持 ARIA 控件、重复调用不重复触发。
   后台 DOM fallback 保留并返回 strategy=dom，不宣称它等价于 trusted mouse event。
4. **把遮挡与控件状态校验做完整。** 检查 iframe 祖先在实际动作点是否被挡住，避免“命令成功但没点到”；
   禁用 option/optgroup 不再改变。只重试准备状态，已经派发的点击不会重放。
5. **同步提示词/Skill。** 明确范围定位、准备状态等待，以及依据业务结果而非仅依据函数返回或控件值结束。

代码入口：[automation.js](../extension/automation.js)、[SDK](../server/sdk.js)、
[Skill](../skills/browser-relay/SKILL.md)。

## 仍有多少差距

| 层面 | 当前判断 | 尚缺的具体东西 |
| --- | --- | --- |
| 基本动作与传输效率 | 已接近；本轮修复了可复现缺口 | 更复杂跨 frame 变换、更多真实应用的事件语义仍需验证 |
| 页面观察信息 | 仍有明显差距 | 普通文本框值目前一并隐藏；只读/可编辑状态、完整层次和精细选择诊断仍不如原生丰富 |
| 会话与用户接管 | 差距最大之一 | 标签独占、跨轮次状态、handoff、失联清理、按会话展示任务状态 |
| 完整浏览器工作流 | 仍不完整 | 对话框、上传/下载、导航与新标签事件的统一高层 API；不能拿低层 CDP 可调用就算已补齐 |
| 工具/文档体系 | 已有基础，仍需完善 | 更细能力发现、只读查询、结构化错误上下文，避免 Agent 反复补查 |
| 模型能力与真实网站成功率 | 本次不能下结论 | 未做干净会话盲测、多网站任务集、相同预算的端到端比较 |

下一阶段优先级应是**会话/标签归属 → 观察信息与错误上下文 → 对话框和文件闭环**。
   这些比继续压缩固定表单的几十毫秒更能缩小整体使用体验的差距。

## 验证与原始数据

- [Codex Browser Use 原生 AX 主记录](benchmarks/browser-gaps-codex-ax.json)：13 条工作流与 2 个行为探针。
- [Relay 修复前，39 次](benchmarks/browser-gaps-relay-baseline.json)。
- [Relay 修复后，39 次](benchmarks/browser-gaps-relay-after.json)。
- [可复跑的 Relay 探针](../scripts/benchmark-browser-gaps.mjs)。
- [新增真实浏览器回归](../tests/browser-reliability.test.mjs)：动态等待、范围定位、可信事件与幂等、无效写入、
  iframe 实际命中点、等待取消和不重放，连同原有场景共 20 项浏览器测试通过（18 个场景及 2 个父测试）。
- `npm test`：97 通过、6 个环境相关跳过，无失败；Skill 校验通过。

所有主结论对应原生 AX 或 Relay 直接接口的证据。前期辅助路径试验不作为这里的主评分，
尤其不能把它的控件行为直接套到 Codex Browser Use 的默认 AX 路径。
