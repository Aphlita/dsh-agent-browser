# dsh-agent-browser

[![test](https://github.com/Aphlita/dsh-agent-browser/actions/workflows/test.yml/badge.svg)](https://github.com/Aphlita/dsh-agent-browser/actions/workflows/test.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

给 DSH 加一个「agent 可共用」的浏览器：模型通过 `browser_*` 工具操作一个真实 Chrome/Edge 页面，人能看见、也能随时接手。人和 agent 看到的是同一屏、同一份登录态。

- **传输**：CDP over **pipe**（stdio，不监听任何 TCP 端口），默认零调试端口暴露；`transport: ws` 可回退。
- **页面模型**：可访问性树（AX）+ DOMSnapshot 混合快照，元素引用稳定，支持同进程 iframe 与跨进程 iframe（OOPIF），旧引用自动 STALE_REF 自愈。
- **协作**：单写者租约，人类点画面/打字立即抢占，agent 30s TTL / 人类 120s TTL。
- **安全**：域名黑白名单、跨域/高危跳转审批、上传审批、对话框审批、eval 审批、密码/令牌脱敏、全量审计。
- **出口**：既是 DSH 插件（右栏 tab + 工具 + 系统提示 + 工具卡），也能作为独立 **MCP server** 给别的客户端用。

> **怎么用**：[`docs/usage.md`](docs/usage.md)。MCP 用法见 [`docs/mcp.md`](docs/mcp.md)。host 半 + client 半 + 引擎 + 自研 WebSocket / 租约 / CDP 客户端全部在本仓库内实现，运行时零第三方依赖。

![右栏全屏下的 Agent 浏览器：实时像素流 + 地址栏 + 租约状态](docs/images/gui.jpg)

> 说明：「共享登录态」目前指**同一个浏览器 profile**（插件自己的 profile，可长期登录）；接你日常 Chrome 的登录态属于尚未实现的 Copilot 档位。

## 两种显示模式

| | 像素流（`nativeWindow: false`，默认） | 原生窗口（`nativeWindow: true`） |
|---|---|---|
| 画面在哪 | 右栏 tab 内，`<img>` 实时帧 | 独立 Chrome/Edge 窗口（原生渲染） |
| 人的操作延迟 | 约 80–120ms（CDP 出帧 + 编码 + 传输 + 解码） | **0**（就是本地浏览器） |
| 人顺手看一眼 | 打开右栏即可 | 点右栏「回到浏览器窗口」让窗口到前台；或开「实时镜像」 |
| 带宽/CPU | 30fps 持续编码 | 关镜像时 **不产生任何帧**；开镜像时按 `mirrorFps`（默认 6） |
| agent 操作 | 走 CDP，与人共享同一页面 | 同左 |
| 适用 | 需要画面常驻在对话旁 | 人机接力、自己也要高频操作 |

另有**嵌入模式**（`embedded: true`）：浏览器是右栏里的一个 Electron `<webview>`，零帧流、零延迟。它需要桌面端打过 `webviewTag` 补丁；**没打补丁也不会坏**——客户端连上后会先上报 `capability`，host 确认支持 `<webview>` 才启用，否则自动回退像素流并在面板上提示。

## 它和内置 Browser tab / Playwright MCP 的区别

| | 内置 Browser tab | Playwright MCP | 本插件 |
|---|---|---|---|
| 人能看见 | ✅ | ❌ | ✅ 右栏实时画面 |
| agent 能读页面 | ❌ | ✅ | ✅ AX 快照（f0e1..fNeN 引用，含 iframe） |
| 共享人类登录态 | ✅ | ❌ 独立 profile | ✅ 同一浏览器 profile |
| 同一屏协作 | — | — | ✅ 租约（人类可抢占） |
| 审批 / 域策略 / 脱敏 | — | — | ✅ 跳转/上传/对话框/eval + 密码令牌脱敏 |
| 独立进程出口 | — | ✅ | ✅ MCP stdio server |

## 结构

```
dsh-agent-browser/
├── lib/
│   ├── cdp.js        零依赖 CDP 传输：pipe（stdio fd3/fd4）/ WebSocket 双模 + CdpClient + 进程树清理
│   ├── snapshot.js   AX 树 + DOMSnapshot 混合快照：跨 iframe 引用、坐标换算、脱敏、STALE_REF 签名
│   ├── engine.js     浏览器会话：起进程、screencast、快照、ref 动作、对话框、上传、导航策略钩子
│   ├── policy.js     纯函数策略：域名黑白名单 / 审批判定 / 脱敏 / 敏感字段
│   ├── ws.js         零依赖 RFC6455 WebSocket 服务端（帧中转）
│   ├── lease.js      租约：单写者 + 人类抢占 + TTL（agent 30s / 人类 120s）
│   ├── index.js      host 半：HTTP 路由 + WS upgrade + 14 个工具 + prompt + 审批/审计
│   ├── mcp.js        MCP stdio server（同一批工具，独立进程）
│   ├── embedded.js   嵌入模式：把 <webview> 包装成与引擎同接口的会话
│   └── client.js     client 半：右栏 tab 像素流/审批卡/工具卡（手写 ModuleLoader bundle，只依赖 react）
├── package.json
└── cordis.patch.yml
```

数据流（像素流模式）：`Chrome --CDP over pipe--> host(engine) --WS 二进制帧--> client <img>`；人的点击/滚动 → `POST /agent-browser/api/command` → CDP；agent → 工具 → 同一个 engine。

## 工具

| 工具 | 作用 | 租约 |
|---|---|---|
| `browser_open(url)` | 打开网页并返回快照（先过域名策略） | 获取 |
| `browser_snapshot()` | 读当前页面（地址/标题/正文/交互元素，含 iframe） | 不占 |
| `browser_navigate(url)` | 跳转（跨域/高危要审批） | 获取 |
| `browser_click(ref \| x,y)` | 按引用点击真实鼠标事件 | 获取 |
| `browser_type(ref, text, submit?)` | 聚焦并输入（中文走 `Input.insertText`） | 获取 |
| `browser_press(key)` | Enter/Tab/Escape/方向键等 | 获取 |
| `browser_scroll(deltaY, ref?)` | 滚动（可滚到某个元素） | 获取 |
| `browser_screenshot(full_page?)` | 截图存盘，返回路径（不把图片塞进模型上下文） | 获取 |
| `browser_wait_for(selector? \| text?, timeout_ms?)` | 等元素/文本出现；超时返回 `found=false` 而不是报错 | 不占 |
| `browser_tabs(action, url?, tab_id?)` | `list` / `new` / `select` / `close` 标签页（不许关最后一个） | 写操作获取 |
| `browser_upload(ref, files[])` | 给 `<input type=file>` 选择本地文件（默认要审批） | 获取 |
| `browser_dialog(action, prompt_text?)` | `list` / `accept` / `dismiss` 页面对话框（accept/dismiss 要审批） | 获取 |
| `browser_eval(expression)` | 在页面执行 JS。**默认关闭**；开启后每次都要批准 + 写审计 | 获取 |
| `browser_release()` | 释放租约 | 释放 |

元素引用形如 `f0e12`：`f0` 是主文档，`f1/f2…` 是 iframe（含跨进程 iframe）。页面导航后旧引用会失效，工具会抛 `STALE_REF` 并附带一份新快照；按新引用重试即可。

租约被占时工具**不会**硬失败重试，而是返回中文提示（谁在占用、可以先 snapshot 观察），避免两个 agent 互相打断。

### 审批与审计

以下动作默认都需要右侧栏点「允许」（`approveUploads` / `approveDangerousNavigate` 设为 true 可预批准，不建议）：

| kind | 触发条件 |
|---|---|
| `navigate` | agent 跨域导航、或目标像可执行/压缩文件（`.exe/.msi/.zip/.bat…`）；页面自己发起的跨域跳转同样拦 |
| `upload` | `browser_upload` 给文件输入框选择文件 |
| `dialog` | `browser_dialog` 的 `accept` / `dismiss` |
| `eval` | `browser_eval`（且 `allowEval` 必须为 true 才存在） |

流程：host 通过 WS 广播 `{type:"approval", id, kind, title, detail}` → 右栏 pane 弹出遮罩卡（按 kind 显示中文副标题）→ 用户点允许/拒绝 → 结果回到 host；拒绝/超时（`evalTimeoutMs`）/没有打开的客户端 → 抛错给模型。**没有客户端时导航审批自动放行但写审计**（`no-client-auto-allow`），其余审批直接失败，避免静默执行高危动作。

审计不是只管审批：每一次工具调用（`kind:"tool"`）、每一次人类命令（`kind:"command"`）、每一次租约变更（`kind:"lease"`）、浏览器启停（`kind:"session"`）、导航拦截（`kind:"navigation-blocked"`）、对话框/上传/审批（`kind:"dialog"/"upload"/"eval"/"navigation"`）都会写入同一份 `audit.jsonl`（默认 `profileDir/../audit.jsonl`）。

## MCP 出口

同一批工具可以作为独立 MCP server 跑给任何支持 MCP 的客户端（Claude Desktop / Codex / DSH 的 mcp-client 等）：

```powershell
node lib/mcp.js
```

stdio 逐行 JSON-RPC；stdout 只有协议数据，日志全部走 stderr；浏览器懒启动，stdin EOF / SIGINT 时自动关闭。配置用环境变量 `AGENT_BROWSER_CONFIG`（JSON）覆盖 `headless / profileDir / executablePath / viewportWidth / viewportHeight / dpr / allowedHosts / allowEval / startUrl / screenshotDir`。细节与示例配置见 [`docs/mcp.md`](docs/mcp.md)。

## 安装

插件是一个普通 npm 包（host 半 + client 半 + 自带 patch），装进 DSH 的 profile 并登记到 `dsh.profile.bundles` 后才会被加载：

1. 取得插件目录：`git clone` 本仓库，或 `npm pack` 后解包。
2. 让 profile 能解析到它——link 到 profile 的 `node_modules`（或用你惯用的包管理方式安装）：
   ```powershell
   $prof = "<DSH_HOME>\profiles\<profile>"
   New-Item -ItemType Junction -Path "$prof\node_modules\dsh-agent-browser" -Target "<本仓库路径>"
   ```
3. 把包名加进该 profile 的 `package.json` 的 `dsh.profile.bundles`：
   ```json
   "dsh": { "profile": { "bundles": [ "...", "dsh-agent-browser" ] } }
   ```
   （保存为 UTF-8 无 BOM；profile manifest 的 `JSON.parse` 对 BOM 敏感。）
4. 重启 DSH（host 半改动需重启；client 半改动刷新页面即可）。
5. 右栏 `+` 里出现「Agent 浏览器」。

> 也可以 `dsh plugin --profile web add link:<插件绝对路径>` 走官方 dev 安装；bundle 会自动追加 `cordis.patch.yml`，并热启用。

### 卸载

从 `dsh.profile.bundles` 里删掉 `"dsh-agent-browser"`，移除 profile `node_modules` 里的链接，重启 DSH。浏览器 profile、截图与审计日志在 `profileDir` 下，卸载不会自动删除。

## 配置（cordis.patch.yml 的 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `transport` | `pipe` | CDP 传输：`pipe`（stdio，不监听端口）或 `ws`（localhost 随机调试端口，需回退时用） |
| `nativeWindow` | `false` | **原生窗口模式**：浏览器跑在独立原生窗口里，人直接操作 = 零像素流延迟；右栏变成控制台，需要时再开「实时镜像」。设为 true 时忽略 `headless` 与 `autoViewport` |
| `embedded` | `false` | 嵌入模式（右栏 `<webview>`）。true 时也要等客户端上报 `capability` 才真正启用；没有 webviewTag 补丁自动回退像素流 |
| `mirrorFps` | 6 | 原生窗口模式下「实时镜像」的帧率上限（关着镜像时完全不出帧，不占 CPU/带宽） |
| `viewportWidth` / `viewportHeight` | 1280 / 800 | 兜底视口（没有客户端上报尺寸时用这个）。像素流模式下有右栏 pane 时按面板实际尺寸自动跟随 |
| `autoViewport` | `true` | 像素流模式下是否跟随右栏 pane 尺寸调整浏览器视口；关掉就固定用 `viewportWidth/Height` |
| `headless` | `true` | 无头（像素流模式）。`nativeWindow: true` 时自动改为有头 |
| `executablePath` | 自动探测 | Chrome/Edge 路径；自动探测不到时填 |
| `profileDir` | `%LOCALAPPDATA%\dsh-agent-browser\profile` | 浏览器用户目录（登录态存这里） |
| `frameQuality` / `maxFps` | 60 / 30 | 像素流质量与帧率上限（超过丢旧帧；实测滚动可出 40+ fps） |
| `hdOnIdle` / `hdIdleMs` / `hdQuality` | `true` / `400` / `80` | 画面静止约 400ms 后补一张按 `devicePixelRatio` 抓的高清帧（高分屏不发糊） |
| `idleCloseMs` | 600000 | 无人连接时自动关浏览器 |
| `agentLeaseMs` / `humanLeaseMs` | 30000 / 120000 | 租约 TTL |
| `leaseWaitMs` | 0 | agent 拿不到租约时排队等待上限（0 = 立即返回 busy；多 agent 建议 2000–5000） |
| `yieldOnContention` | `true` | 有人在排队时，当前 agent 每次操作完主动让出租约 |
| `allowedHosts` | `[]` | 允许访问的域名（空 = 不限制）；支持 `host:port`、`*.example.com`（不含 apex） |
| `blockedHosts` | `[]` | 禁止访问的域名，优先于 `allowedHosts` |
| `approveUploads` | `false` | true = 上传不再逐次审批（预批准，**不建议**） |
| `approveDangerousNavigate` | `false` | true = 跨域/高危导航不再逐次审批（**不建议**） |
| `redactPatterns` | `[]` | 额外的脱敏正则（替换成 `[REDACTED:custom-N]`）；非法正则忽略 |
| `allowEval` | `false` | 是否允许 `browser_eval`；打开后每次调用仍需右栏批准 |
| `evalTimeoutMs` | 60000 | 等用户批准的超时 |
| `auditLog` | 空 | 审计日志路径；空则写 `profileDir/../audit.jsonl` |

## 安全边界

- 只允许 `http://` / `https://`（含 loopback），拒绝 `file:`、`data:`、内嵌凭据 URL；`allowedHosts`/`blockedHosts` 在 host 侧强制执行，页面内跳转由 `Fetch.requestPaused` 闸门二次拦截。
- **CDP 默认走 pipe（stdio）**，不监听 TCP 端口，本机其它进程无法 attach；只有显式 `transport: ws` 才回退到 localhost 随机调试端口。
- 浏览器是**独立进程 + 独立 profile**，不是 DSH 的 Electron 窗口，页面 JS 碰不到 DSH 的 origin。
- HTTP 路由与 WS upgrade 都先过 `ctx.connection.requestRejection(req)`（DSH 的会话认证）。
- 快照默认脱敏：密码框值置 `[REDACTED]`（AX 本身也只给圆点），页面文本里的 token/邮箱/卡号等按内置规则替换；自定义规则走 `redactPatterns`。
- `browser_screenshot` 只写插件自己的 shots 目录，不把图片塞进模型上下文。
- `browser_eval` 默认关闭；上传/对话框/危险跳转逐次审批；所有动作写审计。
- MCP 进程没有右栏审批：策略（域名/脱敏）仍生效，但 eval 只受 `allowEval` 开关控制，`browser_release` 为 no-op。

## 已知限制

- iframe 内元素可读可点（含跨进程 iframe），但 `browser_wait_for` 的 selector 只在主框架求值；同一页面里被 3D/Canvas 渲染的内容只能按坐标点击。
- 页面里的 `beforeunload` 对话框会挂起导航，直到 `browser_dialog(accept/dismiss)` 或人处理。
- 首帧要等浏览器进程冷启动（约 1–3s）。
- `browser_wait_for` 轮询间隔 150ms，超时上限 60s；审批只在右栏 pane 打开时可用（否则除导航外直接报"没有客户端"）。
- MCP 出口与插件共用工具名，但**不共享**租约/审批/审计（独立进程、独立 profile，除非把 `profileDir` 指到同一个）。
- 视口默认跟随右栏 pane：窄栏时页面按窄布局重排，点 ⛶ 或让 pane 自动全屏后变成桌面宽度。

## 排错

- host 半日志在 DSH 的 `harness.log`，关键字 `agent-browser:`。
- 右栏 tab 不出现：确认 client 半 bundle 已被加载（刷新页面后仍无则重启 DSH）。
- 浏览器起不来：检查 `executablePath`；pipe 模式下若浏览器版本过旧不支持 `--remote-debugging-pipe`，把 `transport` 改成 `ws`。
- 工具卡不显示或显示成「浏览器操作」：确认 client 半是新版本（刷新页面），以及工具名确实是 `browser_*`。

## 开发与测试

离线测试**不需要安装 DSH、也不需要 Chrome**（脚本会自己生成 `@deepseek-ai/*` 的测试 shim，仅用于解析 import）：

```powershell
node test/run.mjs            # 租约 + 排队 + WebSocket + 插件契约，期望 27/27
node test/policy-check.mjs   # 域名策略 / 审批判定 / 脱敏 / 敏感字段，期望 111
node test/mcp-check.mjs      # MCP JSON-RPC 协议（假工具，不启动浏览器），期望 15/15
node test/run.mjs --unit     # 只跑纯 JS 单测
```

需要真实浏览器的测试（会启动本机 Chrome/Edge）：

```powershell
node test/stress.mjs                 # 多 agent 并发压测：1/2/4 agent 争用 + 人类抢占 + TTL，约 25s
node ..\spike\engine-smoke.mjs       # pipe 传输 + AX 快照 + iframe 点击 + 对话框 + 上传 + 截图，期望 17/17
node ..\spike\native-test.mjs        # 原生窗口：真窗口、视口随窗口、focus、人类输入探针、镜像启停
node ..\spike\native-host-test.mjs   # host 层：nativeWindow 状态、镜像开关出帧/停帧、focus 消息
```

## 许可证

Apache-2.0，见 [LICENSE](./LICENSE)。