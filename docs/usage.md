# Agent 浏览器 · 使用说明

> 插件位置：`D:\插件\dsh-agent-browser\`　｜　已装进 live profile（junction + `dsh.profile.bundles`）
> 状态：P0 + P1 验收 9/9 通过（`docs/p0-status.md`）；`browser_eval` 默认关闭。

---

## 1. 它是什么

右侧栏里的一台**真浏览器**（本机 Chrome/Edge，headless），你和 agent 看的是**同一块画面、同一个页面**：

- 你不用复制链接给 agent，agent 也不用截图给你看；
- 你随时可以**上手接管**（点画面就等于你在操作），agent 会被礼貌挡住；
- agent 的操作你也可以全程看着，出问题按「释放」交还或直接接管。

它不是 iframe、不是无头爬虫：页面在独立 Chrome 进程里渲染，支持登录、表单、弹窗、下载限制、中文输入。浏览器 profile 独立（不碰你日常 Chrome 的书签/密码）。

---

## 2. 打开与关闭

**打开**：右侧栏 → 顶部 `+`（或空面板里的入口列表）→ 点 **「Agent 浏览器」**。

**关掉画面**：右栏 tab 上的 `×`（浏览器进程会在空闲 10 分钟后自动关闭）。

> 画面 tab 不打开也能用工具，但：① 你看不到 agent 在做什么；② `browser_eval` 的审批卡只在右栏弹，没开 tab 就无法批准。
> 所以正常用法是**先把右栏 tab 开着**。

---

## 3. 日常怎么用（直接说人话）

不用记工具名，直接对 agent 提要求即可。下面是可以照抄的说法：

| 你想做的事 | 就这么说 |
|---|---|
| 看一个网页并总结 | 「打开 https://xxx ，把正文要点列给我」 |
| 查资料 + 多页对比 | 「在这两个页面里各找一下价格，列成表对比」 |
| 登录后操作 | 「打开 https://后台地址 ，用我待会发给你的账号密码登录，进去把订单导出」 |
| 填表 / 提交 | 「打开这个表单页，姓名填张三、备注写『周五前回复』，然后提交并把结果页截给我」 |
| 边看边解释 | 「打开这个文档页，你滚动，我看到哪里你解释到哪里」 |
| 保存页面内容 | 「把这个页面正文存成 D:\插件\tmp\page.md，再截一张整页图」 |
| 卡在验证码 | 「停，我来点」→ 你点画面 → 「好了，接着做」 |
| 让它等页面加载 | 「点完等结果出来再继续（用 browser_wait_for）」 |

agent 实际调用的 12 个工具（了解即可，不必手动调）：
`browser_open` `browser_snapshot` `browser_navigate` `browser_click` `browser_type` `browser_press` `browser_scroll` `browser_screenshot` `browser_wait_for` `browser_tabs` `browser_release` `browser_eval`

快照返回的是**可交互元素树**（`[e3] button "提交" @x,y` 这种），不是整页 HTML，所以 agent 不会烧掉几十万 token 去读源码。

---

## 4. 人机共处（最重要的一节）

| 你做什么 | 会发生什么 |
|---|---|
| **在画面上点一下 / 打字** | 你立刻拿到「人类租约」（`你在操作`）。agent 的点击/输入会被挡，并收到中文提示「浏览器当前由「用户」占用…不要重试」 |
| 点 **「释放」** | 交还给 agent，徽标回到 `空闲` |
| 点 **「接管」** | 从 agent 手里抢回来（agent 下次写操作会被挡） |
| 什么都不点 | 人类租约 120 秒后自动过期；agent 租约 30 秒不续期也会过期 |
| 点 **「重连」** | WS 断了（画面不动）时手动重连；平时会自动指数退避重连 |

**典型节奏**：agent 跑到滑块/登录验证 → 它说「需要你操作」→ 你点两下 → 点「释放」→ 跟 agent 说「继续」。

---

## 5. 多标签

底部**标签条**显示所有页面：点标签切换（`*` 是当前），`×` 关闭（最后一个不能关）。

agent 也能自己开/切/关（`browser_tabs`），它开新标签时你的标签条会同步出现。切标签时画面帧流会跟过去，视口按右栏 pane 当前尺寸保持。

---

## 6. 截图与文件

- 右栏画面是**实时像素流**，不是截图。
- 要留存证据就说「截个图」，agent 调 `browser_screenshot`，落盘到：
  `C:\Users\Aphlita\AppData\Local\dsh-agent-browser\shots\shot-<时间戳>.jpg`
- 整页截图：`browser_screenshot(full_page=true)`（超长页会裁到 4000×8000 上限）。

---

## 7. `browser_eval`（执行页面 JS）——默认关闭

这是唯一「能跑任意脚本」的口子，所以按你之前拍板做成**默认关闭 + 每次审批 + 审计**。

- **现在 live 里是开着的**（验收时临时打开），**下次重启自动回到关闭**。
- 想长期用：把 `D:\插件\dsh-agent-browser\cordis.patch.yml` 里 `allowEval: false` 改成 `true`，重启 DSH Desktop；之后每次调用都会在右栏弹卡，点「允许执行」才跑。
- 审计（每条批准/拒绝都记）：`C:\Users\Aphlita\AppData\Local\dsh-agent-browser\audit.jsonl`，字段 `{at, kind, owner, expression, approved, reason}`。
- 关闭状态下调用会返回：「browser_eval 已被配置关闭（allowEval=false）…」。

---

## 8. 想看见真窗口？（可选）

默认 `headless: true`——浏览器无可见窗口，只有右栏画面。想调试或做需要真窗口的操作，改 `cordis.patch.yml`：

```yaml
        headless: false
```

重启 DSH Desktop 后会弹出一个 Chrome 窗口（尺寸跟随当前视口，默认 1280×800），和右栏画面同步（右栏仍然可用）。

## 9. 视口大小（桌面布局）

- 视口会跟随右栏 pane 的**实际尺寸**：窄栏时页面按窄布局重排，全屏后就是真实桌面宽度。
- 首次打开自动全屏一次（只做一次，不会反复抢屏）；想切回窄栏点面板标题栏的「还原」，或 pane 里工具栏的 `⛶`。
- 状态栏会显示当前尺寸（例如 `实时 · 1440×812`），点画面时坐标按这个尺寸换算。
- 想固定尺寸：`autoViewport: false` + `viewportWidth` / `viewportHeight`（默认 1280×800，范围 320–2400 × 240–1800）。
- **高分屏模糊**：滚动/动画时是流式帧（按 CSS 像素抓，1x），静止约 0.4 秒后会自动补一张按 `devicePixelRatio` 抓的高清帧，文字变锐；再次滚动会回到流式帧。相关开关：`hdOnIdle`（默认 true）、`hdIdleMs`（400）、`hdQuality`（80）。

其他可调项：`frameQuality`（60）、`maxFps`（30）、`idleCloseMs`（600000）、`agentLeaseMs`（30000）、`humanLeaseMs`（120000）、`executablePath`（指定 Chrome/Edge 路径）、`profileDir`（浏览器 profile 目录）。

---

## 10. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 右栏找不到「Agent 浏览器」 | **刷新 GUI 页面**（client 半改动只需刷新，不需重启）；仍没有就看 `harness.log` 有没有 `dsh-agent-browser` 报错 |
| 画面黑 / 一直「等待首帧」 | 点「重连」；还不行说明浏览器进程挂了，让 agent 调一次 `browser_open` 会重新起 |
| 工具报「浏览器当前由「用户」占用」 | 你手上有租约：点「释放」，或等 120s 自动过期 |
| 工具报「未获批准：右侧栏没有打开客户端」 | 右栏 tab 没开，审批送不到 |
| 工具报「未获批准：等待用户批准超时」 | 60s 内没点审批卡 |
| 百度/Cloudflare 出滑块 | 站点反爬，正常；人类接管点掉即可（这正是共享浏览器的价值） |
| 截图里看到「美观输出 □」 | Chrome 自带 JSON 查看器的勾选框，页面内容，不是插件浮层 |
| agent 说页面元素找不到 | 让 agent 先 `browser_snapshot` 看当前 `[eN]`；跨页/滚动后引用会变 |

---

## 11. 停用 / 回滚

1. 编辑 `C:\Users\Aphlita\AppData\Roaming\dsh-desktop\harness\profiles\web\package.json`，从 `dsh.profile.bundles` 里删掉 `"dsh-agent-browser"`；
2. 删 junction：`Remove-Item "...\profiles\web\node_modules\dsh-agent-browser"`（只删链接，不动 `D:\插件\dsh-agent-browser` 源码）；
3. 重启 DSH Desktop。

卸载不删：`D:\插件\dsh-agent-browser\`（源码）、`%LOCALAPPDATA%\dsh-agent-browser\`（profile / shots / audit.jsonl）。

---

## 12. 现在就能试的最小闭环

```text
1) 右栏 + → 「Agent 浏览器」
2) 对 agent 说：打开 https://example.com，把标题和页面第一段告诉我
3) 画面里你自己点一下链接 → 观察徽标变「你在操作」
4) 点「释放」→ 对 agent 说：接着把 Learn more 那页的正文给我
```

跑顺了再试复杂任务（登录后台、填表、多页对比）。