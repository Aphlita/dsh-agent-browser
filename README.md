# dsh-agent-browser

[![test](https://github.com/Aphlita/dsh-agent-browser/actions/workflows/test.yml/badge.svg)](https://github.com/Aphlita/dsh-agent-browser/actions/workflows/test.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

给 DSH 加一个「agent 可共用」的浏览器：模型通过 `browser_*` 工具操作一个真实 Chrome/Edge 页面，人能看见、也能随时接手。人和 agent 看到的是同一屏、同一份登录态。显示层有两种模式：**像素流**（右栏内嵌画面）和**原生窗口**（独立窗口零延迟，右栏当控制台）。

> **怎么用**：[`docs/usage.md`](docs/usage.md)。host 半 + client 半 + 引擎 + 自研 WebSocket / 租约全部在本仓库内实现，运行时零第三方依赖。

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

原生窗口模式下降级提示：Linux 无窗口管理器时 `--window-position` 可能无效；窗口最小化后 screencast/镜像仍工作，但人看不到画面。

## 它和内置 Browser tab / Playwright MCP 的区别

| | 内置 Browser tab | Playwright MCP | 本插件 |
|---|---|---|---|
| 人能看见 | ✅ | ❌ | ✅ 右栏实时画面 |
| agent 能读页面 | ❌ | ✅ | ✅ 快照（e1..eN 引用） |
| 共享人类登录态 | ✅ | ❌ 独立 profile | ✅ 同一浏览器 profile |
| 同一屏协作 | — | — | ✅ 租约（人类可抢占） |

## 结构

```
dsh-agent-browser/
├── lib/
│   ├── engine.js    零依赖 CDP 客户端：起浏览器、screencast、快照、点击/输入/滚轮/截图
│   ├── ws.js        零依赖 RFC6455 WebSocket 服务端（帧中转）
│   ├── lease.js     租约：单写者 + 人类抢占 + TTL（agent 30s / 人类 120s）
│   ├── index.js     host 半：HTTP 路由 + WS upgrade + 12 个工具
│   └── client.js    client 半：右栏 tab（手写 ModuleLoader bundle，只依赖 react）
├── package.json
└── cordis.patch.yml
```

数据流（像素流模式）：`Chrome --CDP--> host(engine) --WS 二进制帧--> client <img>`；人的点击/滚动 → `POST /agent-browser/api/command` → CDP；agent → 工具 → 同一个 engine。
原生窗口模式：浏览器直接画在自己的窗口里，host 只在右栏开镜像时才转发帧；人在窗口里点击/敲键盘会被探针识别并自动把租约切给「用户」。

## 工具

| 工具 | 作用 | 租约 |
|---|---|---|
| `browser_open(url)` | 打开网页并返回快照 | 获取 |
| `browser_snapshot()` | 读当前页面（地址/标题/正文/交互元素 eN） | 不占 |
| `browser_navigate(url)` | 跳转 | 获取 |
| `browser_click(ref \| x,y)` | 按 eN 引用或视口坐标点击 | 获取 |
| `browser_type(ref, text, clear?, submit?)` | 聚焦并输入（中文走 `Input.insertText`） | 获取 |
| `browser_press(key)` | Enter/Tab/Escape/方向键等 | 获取 |
| `browser_scroll(deltaY)` | 滚动 | 获取 |
| `browser_screenshot(full_page?)` | 截图存盘，返回路径 | 获取 |
| `browser_wait_for(selector? \| text?, timeout_ms?)` | 等元素/文本出现；超时返回 `found=false` 而不是报错 | 不占 |
| `browser_tabs(action, url?, tab_id?)` | `list` / `new` / `select` / `close` 标签页（不许关最后一个） | 写操作获取 |
| `browser_eval(expression)` | 在页面执行 JS。**默认关闭**；开启后每次都要右栏批准 + 写审计 | 获取 |
| `browser_release()` | 释放租约 | 释放 |

租约被占时工具**不会**硬失败重试，而是返回中文提示（谁在占用、可以先 snapshot 观察），避免两个 agent 互相打断。

### 审批与审计

`browser_eval` 默认 `allowEval: false`（工具存在但调用会直接报「已被配置关闭」）。显式打开后：

1. agent 调用 → host 通过 WS 广播 `{type:"approval", id, title, detail}`；
2. 右栏 pane 弹出遮罩卡片（标题 + 等宽字体显示待执行表达式），用户点「允许执行」或「拒绝」；
3. 结果回到 host：允许 → 在页面求值；拒绝/超时（`evalTimeoutMs`）/没有打开的客户端 → 抛错给模型；
4. 无论批准与否都追加一行 JSON 审计：`{at, kind:"eval", owner, expression, approved, reason}`，默认 `profileDir/../audit.jsonl`。

审计不是只管 eval：每一次工具调用（`kind:"tool"`：工具名 / owner / 耗时 / 入参摘要 / 失败原因）、每一次人类命令（`kind:"command"`）、每一次租约变更（`kind:"lease"`：acquired / preempted / expired / released）、浏览器启停（`kind:"session"`）都会写入同一份 `audit.jsonl`。

## 安装

插件是一个普通 npm 包（host 半 + client 半），装进 DSH 的 profile 并登记到 `dsh.profile.bundles` 后才会被加载：

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

### 卸载

从 `dsh.profile.bundles` 里删掉 `"dsh-agent-browser"`，移除 profile `node_modules` 里的链接，重启 DSH。浏览器 profile、截图与审计日志在 `profileDir` 下，卸载不会自动删除。

## 配置（cordis.patch.yml 的 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `nativeWindow` | `false` | **原生窗口模式**：浏览器跑在独立原生窗口里，人直接操作 = 零像素流延迟；右栏变成控制台（地址栏/标签/租约/审计），需要时再开「实时镜像」。设为 true 时忽略 `headless` 与 `autoViewport` |
| `mirrorFps` | 6 | 原生窗口模式下「实时镜像」的帧率上限（关着镜像时完全不出帧，不占 CPU/带宽） |
| `viewportWidth` / `viewportHeight` | 1280 / 800 | 兜底视口（没有客户端上报尺寸时用这个）。像素流模式下有右栏 pane 时按面板实际尺寸自动跟随，点击坐标按当前视口换算 |
| `autoViewport` | `true` | 像素流模式下是否跟随右栏 pane 尺寸调整浏览器视口；关掉就固定用 `viewportWidth/Height` |
| `headless` | `true` | 无头（像素流模式）。`nativeWindow: true` 时自动改为有头 |
| `executablePath` | 自动探测 | Chrome/Edge 路径；自动探测不到时填 |
| `profileDir` | `%LOCALAPPDATA%\dsh-agent-browser\profile` | 浏览器用户目录（登录态存这里） |
| `frameQuality` / `maxFps` | 60 / 30 | 像素流质量与帧率上限（超过丢旧帧；实测滚动可出 40+ fps，30 为清晰度/带宽平衡点） |
| `hdOnIdle` / `hdIdleMs` / `hdQuality` | `true` / `400` / `80` | 画面静止约 400ms 后补一张按 `devicePixelRatio` 抓的高清帧（高分屏不发糊）；一有运动帧就回到流式 |
| `idleCloseMs` | 600000 | 无人连接时自动关浏览器 |
| `agentLeaseMs` / `humanLeaseMs` | 30000 / 120000 | 租约 TTL |
| `leaseWaitMs` | 0 | agent 拿不到租约时排队等待上限（0 = 立即返回 busy，由 agent 自己重试；多 agent 场景建议 2000–5000） |
| `yieldOnContention` | `true` | 有人在排队时，当前 agent 每次操作完主动让出租约（避免长任务饿死别人） |
| `allowEval` | `false` | 是否允许 `browser_eval`；打开后每次调用仍需右栏批准 |
| `evalTimeoutMs` | 60000 | 等用户批准的超时 |
| `auditLog` | 空 | 审计日志路径；空则写 `profileDir/../audit.jsonl` |

## 安全边界

- 只允许 `http://` / `https://`（含 loopback），拒绝 `file:`、`data:`、内嵌凭据 URL。
- 浏览器是**独立进程 + 独立 profile**，不是 DSH 的 Electron 窗口，页面 JS 碰不到 DSH 的 origin。
- HTTP 路由与 WS upgrade 都先过 `ctx.connection.requestRejection(req)`（DSH 的会话认证）。
- `browser_screenshot` 只写插件自己的 shots 目录。
- `browser_eval` 默认关闭；开启后每表达式都要用户点「允许执行」，并写审计（表达式 + 批准结果 + 谁发起的）。

## 已知限制

- 视口默认跟随右栏 pane：窄栏时页面按窄布局重排，点 ⛶ 或让 pane 自动全屏后变成桌面宽度（1280+）。不是"把桌面页缩放进窄栏"。
- 页面若在 iframe 内部，快照脚本只覆盖主框架。
- 首帧要等浏览器进程冷启动（约 1–3s）。
- `browser_wait_for` 轮询间隔 150ms，超时上限 60s；`browser_eval` 审批只在右栏 pane 打开时可用（否则直接报"没有客户端"）。

## 排错

- host 半日志在 DSH 的 `harness.log`，关键字 `agent-browser:`。
- 右栏 tab 不出现：确认 client 半 bundle 已被加载（刷新页面后仍无则重启 DSH）。
- 浏览器起不来：检查 `executablePath`；残留的 `DevToolsActivePort` 会在启动前被清掉。

## 开发与测试

离线测试**不需要安装 DSH、也不需要 Chrome**（脚本会自己生成 `@deepseek-ai/*` 的测试 shim，仅用于解析 import）：

```powershell
node test/run.mjs          # 租约 + 排队 + WebSocket + 插件契约，期望 25/25
node test/run.mjs --unit   # 只跑纯 JS 单测
```

需要真实浏览器的测试（会启动本机 Chrome/Edge）：

```powershell
node test/stress.mjs   # 多 agent 并发压测：1/2/4 agent 争用 + 人类抢占 + TTL，约 25s
```

原生窗口模式（会在屏幕上短暂打开一个浏览器窗口）：

```powershell
node ..\spike\native-test.mjs       # 引擎层：真窗口、视口随窗口、focus、人类输入探针、镜像启停，期望 7/7
node ..\spike\native-host-test.mjs  # host 层：nativeWindow 状态、镜像开关出帧/停帧、focus 消息，期望 8/8
```

## 许可证

Apache-2.0，见 [LICENSE](./LICENSE)。