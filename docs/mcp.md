# MCP 出口（把浏览器工具给任何 MCP 客户端）

`lib/mcp.js` 把与 DSH 插件同一批 `browser_*` 工具暴露成一个 **stdio MCP server**。它不需要 DSH 在跑，也不依赖任何第三方 npm 包：`node lib/mcp.js` 即可。

## 快速开始

```powershell
# 最小启动（浏览器懒启动：第一次调用工具时才拉起 Chrome/Edge）
node lib/mcp.js
```

客户端配置（以通用 MCP stdio 配置为例）：

```json
{
  "mcpServers": {
    "agent-browser": {
      "command": "node",
      "args": ["D:\\插件\\dsh-agent-browser\\lib\\mcp.js"],
      "env": {
        "AGENT_BROWSER_CONFIG": "{\"headless\":true,\"allowedHosts\":[\"example.com\"]}"
      }
    }
  }
}
```

Windows 上如果客户端不会解析 `node`，把 `command` 换成 `C:\\Program Files\\nodejs\\node.exe` 的绝对路径。

## 配置

全部通过环境变量 `AGENT_BROWSER_CONFIG`（一段 JSON）传入：

| 键 | 默认 | 说明 |
|---|---|---|
| `headless` | `true` | 无头运行 |
| `profileDir` | `%LOCALAPPDATA%\dsh-agent-browser\mcp-profile` | 浏览器用户目录。想共享 DSH 插件的登录态就指到插件的 `profileDir` |
| `executablePath` | 自动探测 | Chrome/Edge 路径 |
| `viewportWidth` / `viewportHeight` | 1280 / 800 | 视口尺寸 |
| `dpr` | 1 | 设备像素比 |
| `allowedHosts` | `[]` | 允许访问的域名（空 = 不限制）；支持 `host:port`、`*.example.com` |
| `allowEval` | `false` | 是否允许 `browser_eval` |
| `startUrl` | `about:blank` | 启动后先打开的地址 |
| `screenshotDir` | `profileDir\..\shots` | 截图输出目录 |

示例：

```powershell
$env:AGENT_BROWSER_CONFIG = '{"headless":false,"allowedHosts":["example.com","*.github.com"],"profileDir":"C:\\Users\\me\\AppData\\Local\\dsh-agent-browser\\profile"}'
node lib/mcp.js
```

## 协议

- 传输：逐行 LF 分隔的 JSON-RPC 2.0（MCP stdio 规范），没有 `Content-Length` 头。
- stdout **只写协议 JSON**；所有日志写 stderr。任何东西误写 stdout 都会污染传输。
- 方法：`initialize`、`notifications/initialized`、`tools/list`、`tools/call`、`ping`。
- 参数错误返回 `-32602`；未知方法 `-32601`；坏 JSON `-32700`；通知（无 `id`）一律不响应。
- 工具执行失败返回 `isError: true` 的文本结果，而不是 JSON-RPC 错误（模型能看到失败原因并重试）。
- 退出：stdin EOF、SIGINT、SIGTERM 都会先 `session.close()` 关掉浏览器再退出；2 秒兜底强退。

## 工具对照

`tools/list` 返回 14 个工具，名字与插件一致（`browser_upload` / `browser_dialog` 在 MCP 里也可用）。与插件端的差异：

| 能力 | DSH 插件 | MCP 出口 |
|---|---|---|
| 实时画面 / 租约 / 审批卡 | ✅ | ❌（无人可见，所以也没有审批往返） |
| 域名策略 | ✅ host 侧 | ✅ 只拦 `browser_open` / `browser_navigate` / `browser_tabs(new)` / `startUrl` 的显式 URL |
| 页面内跳转拦域名 | ✅ `Fetch.requestPaused` 闸门 | ❌ 暂未接入 |
| 密码/令牌脱敏 | ✅ | ✅（快照仍按默认规则脱敏） |
| 审计日志 | ✅ | ❌ |
| `browser_release` | 释放租约 | no-op（独立进程没有租约） |

## 验证

```powershell
node test/mcp-check.mjs   # 15/15：initialize / tools/list / tools/call / 错误码 / 通知 / EOF 关闭
```

也可以手工喂一行协议试一下：

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' | node lib/mcp.js
```