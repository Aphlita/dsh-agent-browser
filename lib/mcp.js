/**
 * DSH Agent Browser — MCP 出口（stdio，零第三方依赖）
 *
 * 把与 DSH 插件同一批浏览器工具暴露成一个 MCP server：独立进程通过
 * stdio 与客户端（Claude Desktop / Codex / DSH 的 mcp-client 等）通信。
 *
 * 约定：
 *  - 传输：逐行 LF 分隔的 JSON（MCP stdio 规范），没有 Content-Length 头。
 *  - stdout 只允许协议 JSON；所有日志一律写 stderr，否则会污染传输。
 *  - 浏览器懒启动：第一次真正用到浏览器时才拉起系统 Chrome/Edge。
 *  - 配置：环境变量 AGENT_BROWSER_CONFIG（JSON），例如
 *      AGENT_BROWSER_CONFIG='{"headless":false,"allowedHosts":["example.com"]}' node lib/mcp.js
 *
 * 本文件可被测试直接 import（不会自动启动服务）；只有被 `node lib/mcp.js`
 * 直接运行时才进入 stdio 主循环。
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BrowserSession, defaultProfileDir, sleep } from "./engine.js";
import { createPolicy } from "./policy.js";

/** MCP 协议版本（initialize 时回给客户端）。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** serverInfo（与插件版本保持一致；由 README / package.json 统一维护）。 */
export const MCP_SERVER_INFO = Object.freeze({ name: "dsh-agent-browser", version: "0.3.0" });

/* JSON-RPC 2.0 标准错误码 */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;

const TEXT_LIMIT = 2_000;

/* ------------------------------- 通用小工具 ------------------------------- */

const defaultLog = (level, message) => {
  try { process.stderr.write(`[dsh-agent-browser-mcp] ${level}: ${message}\n`); } catch { /* stderr 不可写时静默 */ }
};

/** 统一把工具返回值包成 MCP 的 content 数组。 */
const textResult = (value) => ({ content: [{ type: "text", text: String(value ?? "") }] });

/** 像地址栏一样补全：无协议默认 https，localhost/内网 IP 默认 http。与 lib/index.js 保持一致。 */
function normalizeAddress(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return text;
  if (text.startsWith("//")) return `https:${text}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
  return `https://${text}`;
}

/** 允许的域名列表：数组或逗号分隔字符串；支持 "example.com" / "*.example.com"。 */
function normalizeHostList(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return list.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/**
 * 校验并补全目标地址：只允许 http(s)，且（配置了 allowedHosts 时）域名必须在白名单内。
 * 返回补全后的完整地址；不合法时抛错（工具层会转成 isError:true）。
 */
function assertAllowedUrl(raw, allowedHosts) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("缺少 url");
  const normalized = normalizeAddress(text);
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new Error(`地址无效：${text}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`只允许 http(s) 地址：${normalized}`);
  }
  if (allowedHosts.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const allowed = allowedHosts.some((pattern) => {
      const rule = String(pattern).trim().toLowerCase();
      if (!rule) return false;
      if (rule.startsWith("*.")) {
        const bare = rule.slice(2);
        return host === bare || host.endsWith(`.${bare}`);
      }
      return host === rule || host.endsWith(`.${rule}`);
    });
    if (!allowed) throw new Error(`域名未授权：${host}（AGENT_BROWSER_CONFIG.allowedHosts 未包含该域名）`);
  }
  return normalized;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
}

/** 把快照渲染成给模型看的紧凑文本（与 lib/index.js 的格式一致，便于同一套提示词复用）。 */
function formatSnapshot(snap) {
  if (!snap || typeof snap !== "object") throw new Error("页面快照获取失败（页面可能仍在加载）");
  const lines = [];
  lines.push(`URL: ${snap.url ?? ""}`);
  lines.push(`Title: ${snap.title || "(无标题)"}`);
  if (snap.viewport) {
    const vw = snap.viewport.w ?? snap.viewport.width ?? 0;
    const vh = snap.viewport.h ?? snap.viewport.height ?? 0;
    const scrollH = snap.viewport.scrollH ?? snap.viewport.scrollHeight ?? vh;
    lines.push(`Viewport: ${vw}x${vh}, scrollY=${snap.viewport.scrollY ?? 0}/${Math.max(0, scrollH - vh)}`);
  }
  const text = String(snap.text ?? "").replace(/\s+/g, " ").trim();
  if (text) {
    const clip = text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…（正文已截断）` : text;
    lines.push("", "页面文本:", clip);
  }
  const elements = Array.isArray(snap.elements) ? snap.elements.slice(0, 120) : [];
  if (elements.length > 0) {
    lines.push("", "交互元素:");
    for (const el of elements) {
      const parts = [`[${el.ref}]`, el.role];
      if (el.name) parts.push(JSON.stringify(el.name));
      if (el.value) parts.push(`value=${JSON.stringify(el.value)}`);
      if (el.href) parts.push(`href=${el.href}`);
      if (Array.isArray(el.rect) && el.rect.length === 4) parts.push(`@${el.rect[0]},${el.rect[1]} ${el.rect[2]}x${el.rect[3]}`);
      const flags = [];
      if (el.frameIndex > 0) flags.push(`iframe f${el.frameIndex}`);
      if (el.disabled) flags.push("disabled");
      if (el.checked) flags.push("checked");
      if (el.sensitive) flags.push("sensitive");
      if (flags.length) parts.push(`(${flags.join(", ")})`);
      lines.push(parts.join(" "));
    }
  } else {
    lines.push("", "（没有可见的交互元素）");
  }
  if (snap.truncated) lines.push("", "（交互元素过多，只列出一部分；用 browser_snapshot 重新取最新快照）");
  return lines.join("\n");
}

function formatTabs(tabs) {
  const list = Array.isArray(tabs) ? tabs : [];
  if (list.length === 0) return "(没有标签页)";
  return list
    .map((tab) => `${tab.active ? "*" : " "} ${String(tab.targetId ?? tab.id ?? "").slice(0, 8)}  ${tab.title || "(无标题)"}  ${tab.url}`)
    .join("\n");
}

/* ----------------------------- MCP server 核心 ----------------------------- */

/**
 * 创建一个 MCP server（与浏览器无关，纯协议层，便于离线测试）。
 *
 * @param {object} options
 * @param {Array<{name:string,description?:string,inputSchema?:object,title?:string}>} [options.tools]
 *        工具清单；inputSchema 是 JSON Schema，原样透传给客户端。
 * @param {(name:string,args:object)=>Promise<object|string>} options.callTool
 *        执行工具；返回 {content:[{type:"text",text}],isError?} 或纯文本。
 *        抛错会被转成 isError:true 的正常结果（MCP 约定，不是 JSON-RPC error）。
 * @param {(level:string,message:string)=>void} [options.log] 日志钩子（默认写 stderr）。
 * @returns {{handle:(line:string)=>Promise<string|null>, close:()=>void, tools:Array<object>}}
 *          handle 返回一行响应 JSON（不含换行）；null 表示通知/已关闭，无需响应。
 */
export function createMcpServer({ tools = [], callTool, log } = {}) {
  if (typeof callTool !== "function") throw new TypeError("createMcpServer 需要 callTool(name, args) 函数");

  const report = (level, message) => {
    try {
      if (typeof log === "function") log(level, message);
      else defaultLog(level, message);
    } catch { /* 日志失败不影响协议 */ }
  };

  const toolList = (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const entry = {
        name: String(tool?.name ?? ""),
        description: String(tool?.description ?? ""),
        inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : { type: "object", properties: {} },
      };
      if (typeof tool?.title === "string" && tool.title) entry.title = tool.title;
      return entry;
    })
    .filter((tool) => tool.name.length > 0);
  const knownTools = new Set(toolList.map((tool) => tool.name));

  let closed = false;

  const reply = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

  /** 把 callTool 的返回值规范成 MCP 结果（字符串/裸对象也能用）。 */
  function normalizeToolResult(result) {
    if (result && Array.isArray(result.content)) {
      const content = result.content.map((item) => {
        if (!item || typeof item !== "object") return { type: "text", text: String(item ?? "") };
        if (item.type === "text") return { ...item, text: String(item.text ?? "") };
        return item; // image 等类型原样透传
      });
      const normalized = { content };
      if (result.isError === true) normalized.isError = true;
      return normalized;
    }
    if (typeof result === "string") return { content: [{ type: "text", text: result }] };
    if (result === undefined || result === null) return { content: [] };
    let text;
    try { text = JSON.stringify(result); } catch { text = String(result); }
    return { content: [{ type: "text", text }] };
  }

  async function handleToolCall(id, params) {
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name) return fail(id, RPC_INVALID_PARAMS, "Invalid params: name (string) is required");
    if (!knownTools.has(name)) return fail(id, RPC_INVALID_PARAMS, `Tool not found: ${name}`);
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    try {
      return reply(id, normalizeToolResult(await callTool(name, args)));
    } catch (error) {
      const message = error?.message !== undefined && error?.message !== null ? String(error.message) : String(error);
      report("warn", `tools/call ${name} 执行失败：${message}`);
      return reply(id, { content: [{ type: "text", text: `工具执行失败：${message}` }], isError: true });
    }
  }

  /** 处理一行 JSON-RPC（不含换行），返回一行响应 JSON 或 null。永不抛错。 */
  async function handle(line) {
    if (closed) return null;
    const raw = typeof line === "string" ? line.trim() : "";
    if (!raw) return null;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (error) {
      report("warn", `JSON 解析失败：${error?.message ?? error}`);
      return fail(null, RPC_PARSE_ERROR, "Parse error");
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return fail(null, RPC_INVALID_REQUEST, "Invalid Request");
    }
    if (msg.jsonrpc !== undefined && msg.jsonrpc !== "2.0") {
      return fail(msg.id ?? null, RPC_INVALID_REQUEST, "Invalid Request: jsonrpc must be \"2.0\"");
    }

    const method = typeof msg.method === "string" ? msg.method : "";
    if (!method) {
      return hasRequestId(msg) ? fail(msg.id, RPC_INVALID_REQUEST, "Invalid Request: missing method") : null;
    }

    // 通知（没有 id，或方法本身就是 notifications/*）一律不响应。
    if (!hasRequestId(msg) || method.startsWith("notifications/")) {
      if (method !== "notifications/initialized") report("info", `忽略通知：${method}`);
      return null;
    }

    const id = msg.id;
    const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : {};

    try {
      switch (method) {
        case "initialize":
          return reply(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { ...MCP_SERVER_INFO },
          });
        case "ping":
          return reply(id, {});
        case "tools/list":
          return reply(id, { tools: toolList });
        case "tools/call":
          return await handleToolCall(id, params);
        default:
          return fail(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    } catch (error) {
      report("error", `处理 ${method} 失败：${error?.stack ?? error}`);
      return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
    }
  }

  function close() {
    closed = true;
  }

  return { handle, close, tools: toolList };
}

function hasRequestId(msg) {
  return Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== undefined && msg.id !== null;
}

/* ------------------------------- 工具清单 ------------------------------- */

/**
 * MCP 工具定义（14 个，与 DSH 插件注册的工具同名同语义）。
 * inputSchema 是标准 JSON Schema，直接透传给客户端。
 */
export const MCP_TOOLS = [
  {
    name: "browser_open",
    description: "打开一个网页（http/https）并返回页面快照（地址、标题、可见文本、带 f0eN 引用的可交互元素）。首次调用会自动启动本机 Chrome/Edge。后续可用 browser_click / browser_type 按引用操作。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "要打开的网址，必须以 http:// 或 https:// 开头" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description: "读取当前页面的快照：地址、标题、可见文本、可交互元素（带 f0eN 引用，iframe 内是 f1eN/f2eN）。操作前先 snapshot，引用过期（stale-ref）后重新 snapshot。只读，不会修改页面。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_navigate",
    description: "让当前标签页跳转到另一个 http/https 地址（保留登录态与 profile）。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "目标网址" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description: "点击快照中的一个元素（用 f0eN 引用，例如 f0e3），或点击视口坐标 (x,y)。使用 CDP 派发真实鼠标事件。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "快照里的元素引用，如 f0e3" },
        x: { type: "number", description: "视口坐标 x（不传 ref 时使用）" },
        y: { type: "number", description: "视口坐标 y（不传 ref 时使用）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "向快照中的输入元素（f0eN）输入文本；中文等非 ASCII 文本用 Input.insertText 注入。可选 submit=true 输入后回车。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "输入元素的快照引用，如 f0e8" },
        text: { type: "string", description: "要输入的文本" },
        clear: { type: "boolean", description: "输入前清空原值" },
        submit: { type: "boolean", description: "输入后按 Enter" },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description: "在当前页面按一个键：Enter、Tab、Escape、Backspace、Delete、ArrowUp/Down/Left/Right、PageUp/PageDown、Home、End。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "键名，例如 Enter" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description: "滚动当前页面（正数向下，负数向上）。",
    inputSchema: {
      type: "object",
      properties: { deltaY: { type: "number", description: "滚动像素，例如 600（向下）、-600（向上）" } },
      required: ["deltaY"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description: "截取当前页面为 JPEG 并保存到本地文件，返回文件路径与字节数。用于存档或精确视觉检查。",
    inputSchema: {
      type: "object",
      properties: { full_page: { type: "boolean", description: "是否截整页（默认只截视口）" } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_release",
    description: "兼容占位：MCP 独立进程不持有租约（没有其他 agent/用户共享这个浏览器实例），调用只返回成功，不做任何操作。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_tabs",
    description: "管理标签页：list 列出全部标签；new 新开一个标签（可带 url）；select 切换当前标签；close 关闭指定标签（不允许关闭最后一个）。tab_id 支持唯一前缀。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "list | new | select | close" },
        url: { type: "string", description: "action=new 时要打开的 http/https 地址" },
        tab_id: { type: "string", description: "action=select/close 时的标签 id（可用唯一前缀）" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait_for",
    description: "等待页面出现某个元素（CSS selector）或某段可见文本（text），最多等 timeout_ms。返回 found 布尔值；超时返回 found=false 而不是报错。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器，例如 #result、button.submit" },
        text: { type: "string", description: "页面可见文本片段" },
        timeout_ms: { type: "number", description: "超时毫秒，默认 10000，范围 200-60000" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_eval",
    description: "在页面上下文执行一段 JavaScript 表达式并返回结果。默认关闭：需要 AGENT_BROWSER_CONFIG 里显式设置 allowEval=true。只用于 snapshot/click 无法表达的场景。",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "要在页面上下文求值的表达式" } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_upload",
    description: "给页面里的 <input type=file> 选择本地文件（ref 指向快照中的文件输入框，如 f0e42）。MCP 独立进程没有右栏审批，校验文件存在后直接执行；文件路径必须是绝对路径。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "快照里 <input type=file> 的引用，如 f0e42" },
        files: { type: "array", items: { type: "string" }, description: "本机文件的绝对路径数组" },
      },
      required: ["ref", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_dialog",
    description: "查看或处理页面弹出的 JavaScript 对话框（alert/confirm/prompt/beforeunload）。action=list 只列出；accept/dismiss 直接处理（MCP 独立进程无审批卡）。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "accept", "dismiss"], description: "list | accept | dismiss" },
        prompt_text: { type: "string", description: "prompt 对话框要填的文本（action=accept 时可传）" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

/* ---------------------------- 独立进程的浏览器运行时 ---------------------------- */

/**
 * 创建独立进程运行时：懒启动 BrowserSession，把工具名映射到 engine.js 的动作方法。
 * @param {ReturnType<typeof loadConfig>} config
 * @param {(level:string,message:string)=>void} report
 */
function createRuntime(config, report) {
  /** @type {BrowserSession | null} */
  let session = null;
  /** @type {Promise<BrowserSession> | null} */
  let starting = null;
  let closed = false;

  // MCP 进程没有右栏审批，但脱敏与域名策略仍然在服务端生效：
  // 敏感字段/页面文本在进入模型上下文之前就被替换，allowedHosts 在 open/navigate 前拦截。
  const policy = createPolicy(config);
  const snapshotOptions = {
    redact: (value) => policy.redact(String(value ?? "")).text,
    isSensitiveField: (field) => policy.isSensitiveField(field),
  };

  const ensureSession = async () => {
    if (closed) throw new Error("MCP 服务已关闭");
    if (session && session.state === "ready") return session;
    if (starting) return starting;
    // 上个会话死了（CDP 断开/浏览器崩溃）：先收尸再重建。
    if (session) {
      const stale = session;
      session = null;
      await stale.close().catch(() => {});
    }
    starting = (async () => {
      report("info", `启动浏览器（headless=${config.headless}，profile=${config.profileDir}）`);
      const next = new BrowserSession({
        executablePath: config.executablePath || undefined,
        profileDir: config.profileDir,
        headless: config.headless,
        viewport: config.viewport,
        startUrl: config.startUrl,
      });
      await next.start();
      session = next;
      report("info", `浏览器已启动：${next.browserVersion ?? "unknown"}`);
      return next;
    })().finally(() => { starting = null; });
    return starting;
  };

  const handlers = {
    async browser_open(args) {
      const url = assertAllowedUrl(args.url, config.allowedHosts);
      const current = await ensureSession();
      await current.navigate(url);
      const snap = await current.snapshot(snapshotOptions);
      return textResult(formatSnapshot(snap));
    },

    async browser_snapshot() {
      const current = await ensureSession();
      return textResult(formatSnapshot(await current.snapshot(snapshotOptions)));
    },

    async browser_navigate(args) {
      const url = assertAllowedUrl(args.url, config.allowedHosts);
      const current = await ensureSession();
      const state = await current.navigate(url);
      return textResult(`已跳转到 ${state?.url ?? url}\n标题：${state?.title || "(无标题)"}`);
    },

    async browser_click(args) {
      const current = await ensureSession();
      const ref = typeof args.ref === "string" && args.ref ? args.ref : "";
      let at;
      if (ref) {
        at = await current.clickRef(ref);
      } else {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("browser_click 需要 ref 或 (x,y)");
        at = await current.clickAt(x, y);
      }
      await sleep(120);
      return textResult(`已在 (${Math.round(at.x)}, ${Math.round(at.y)}) 点击${ref ? ` ${ref}` : ""}`);
    },

    async browser_type(args) {
      const ref = typeof args.ref === "string" ? args.ref : "";
      if (!ref) throw new Error("browser_type 需要 ref");
      const value = args.text === undefined || args.text === null ? "" : String(args.text);
      const current = await ensureSession();
      await current.typeRef(ref, value, { clear: Boolean(args.clear) });
      if (args.submit) await current.press("Enter");
      await sleep(120);
      return textResult(`已向 ${ref} 输入 ${JSON.stringify(value).slice(0, 120)}${args.submit ? " 并回车" : ""}`);
    },

    async browser_press(args) {
      const key = typeof args.key === "string" ? args.key : "";
      if (!key) throw new Error("browser_press 需要 key");
      const current = await ensureSession();
      await current.press(key);
      await sleep(80);
      return textResult(`已按键 ${key}`);
    },

    async browser_scroll(args) {
      const deltaY = Number(args.deltaY);
      if (!Number.isFinite(deltaY)) throw new Error("browser_scroll 需要数值 deltaY");
      const current = await ensureSession();
      await current.scroll({ deltaY });
      await sleep(120);
      return textResult(`已滚动 ${deltaY}px`);
    },

    async browser_screenshot(args) {
      const current = await ensureSession();
      const shot = await current.screenshot({ format: "jpeg", quality: 80, fullPage: Boolean(args.full_page) });
      await mkdir(config.screenshotDir, { recursive: true });
      const ext = shot.format === "png" ? "png" : "jpg";
      const file = path.join(config.screenshotDir, `shot-${Date.now()}.${ext}`);
      await writeFile(file, shot.data);
      return textResult(`截图已保存：${file}（${shot.data.length} 字节）`);
    },

    async browser_release() {
      // 独立进程里没有共享租约：没有别的 agent/用户会抢这个浏览器，直接当无事发生。
      return textResult("MCP 独立进程不持有租约，无需释放（已返回成功）");
    },

    async browser_tabs(args) {
      const action = String(args.action ?? "list");
      const current = await ensureSession();
      if (action === "list") {
        const tabs = current.listTabs();
        return textResult(`共 ${tabs.length} 个标签页\n${formatTabs(tabs)}`);
      }
      if (action === "new") {
        const url = args.url ? assertAllowedUrl(args.url, config.allowedHosts) : "about:blank";
        const tabs = await current.newTab(url);
        return textResult(`已新开标签页，现在共 ${tabs.length} 个\n${formatTabs(tabs)}`);
      }
      if (action === "select") {
        if (!args.tab_id) throw new Error("browser_tabs action=select 需要 tab_id");
        const tabs = await current.selectTab(String(args.tab_id));
        return textResult(`已切换标签页\n${formatTabs(tabs)}`);
      }
      if (action === "close") {
        if (!args.tab_id) throw new Error("browser_tabs action=close 需要 tab_id");
        const tabs = await current.closeTab(String(args.tab_id));
        return textResult(`已关闭标签页，现在共 ${tabs.length} 个\n${formatTabs(tabs)}`);
      }
      throw new Error(`未知 action：${action}（只支持 list | new | select | close）`);
    },

    async browser_wait_for(args) {
      const selector = typeof args.selector === "string" && args.selector ? args.selector : null;
      const text = typeof args.text === "string" && args.text ? args.text : null;
      if (!selector && !text) throw new Error("browser_wait_for 需要 selector 或 text");
      const timeout = Math.min(60_000, Math.max(200, Number(args.timeout_ms ?? 10_000) || 10_000));
      const current = await ensureSession();
      const expression = selector
        ? `!!document.querySelector(${JSON.stringify(selector)})`
        : `(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`;
      const started = Date.now();
      let found = false;
      while (Date.now() - started < timeout) {
        try { found = Boolean(await current.evaluate(expression)); } catch { found = false; }
        if (found) break;
        await sleep(150);
      }
      const waited = Date.now() - started;
      const what = selector ? `选择器 ${selector}` : `文本 ${JSON.stringify(text)}`;
      return textResult(found ? `已等到 ${what}（${waited}ms）` : `等待超时（${waited}ms），未出现 ${what}`);
    },

    async browser_eval(args) {
      if (!config.allowEval) {
        throw new Error("browser_eval 已被配置关闭（AGENT_BROWSER_CONFIG 里设置 allowEval=true 才能用）");
      }
      const expression = String(args.expression ?? "");
      if (!expression) throw new Error("browser_eval 需要 expression");
      if (expression.length > 4_000) throw new Error("表达式太长（上限 4000 字符）");
      const current = await ensureSession();
      const value = await current.evaluate(expression);
      const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
      return textResult(`执行完成，结果：\n${String(text).slice(0, TEXT_LIMIT)}`);
    },

    async browser_upload(args) {
      const ref = typeof args.ref === "string" ? args.ref : "";
      if (!ref) throw new Error("browser_upload 需要 ref");
      const files = Array.isArray(args.files) ? args.files.map((file) => String(file)) : [];
      if (!files.length) throw new Error("browser_upload 需要至少一个文件路径");
      for (const file of files) {
        if (!path.isAbsolute(file)) throw new Error(`必须是绝对路径：${file}`);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) throw new Error(`文件不存在：${file}`);
      }
      const current = await ensureSession();
      await current.uploadFiles(ref, files);
      return textResult(`已选择 ${files.length} 个文件：${files.map((file) => path.basename(file)).join("、")}`);
    },

    async browser_dialog(args) {
      const action = String(args.action ?? "list");
      const current = await ensureSession();
      if (action === "list") {
        const dialogs = current.listDialogs();
        return textResult(dialogs.length ? dialogs.map((dialog) => `[${dialog.type}] ${dialog.message}`).join("\n") : "当前没有挂起的对话框");
      }
      if (action !== "accept" && action !== "dismiss") throw new Error("action 只能是 list/accept/dismiss");
      const result = await current.handleDialog({ accept: action === "accept", promptText: args.prompt_text });
      return textResult(result ? `已${action === "accept" ? "确认" : "关闭"}对话框：${result.type ?? "dialog"}` : "当前没有挂起的对话框");
    },
  };

  const callTool = async (name, args = {}) => {
    const handler = handlers[name];
    if (typeof handler !== "function") throw new Error(`未知工具：${name}`);
    return handler(args && typeof args === "object" ? args : {});
  };

  const close = async () => {
    closed = true;
    const current = session;
    session = null;
    if (current) await current.close().catch(() => {});
    if (starting) await starting.catch(() => {});
  };

  return { callTool, close };
}

/* -------------------------------- 配置读取 -------------------------------- */

/**
 * 从 AGENT_BROWSER_CONFIG（JSON）读取 MCP 独立进程的配置。
 * 未配置时：headless=true，profile 用 %LOCALAPPDATA%\dsh-agent-browser\mcp-profile
 * （与 DSH 插件默认 profile 分开，避免和正在运行的插件抢用户数据目录；
 *  想共享登录态可显式把 profileDir 指到插件那个 profile）。
 */
function loadConfig(report) {
  let raw = {};
  const envText = process.env.AGENT_BROWSER_CONFIG;
  if (envText && envText.trim()) {
    try {
      const parsed = JSON.parse(envText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
      else report("warn", "AGENT_BROWSER_CONFIG 不是 JSON 对象，已忽略");
    } catch (error) {
      report("warn", `AGENT_BROWSER_CONFIG 不是合法 JSON，已忽略：${error?.message ?? error}`);
    }
  }

  const profileDir = typeof raw.profileDir === "string" && raw.profileDir.trim()
    ? path.resolve(raw.profileDir.trim())
    : path.join(path.dirname(defaultProfileDir()), "mcp-profile");

  const allowedHosts = normalizeHostList(raw.allowedHosts);

  let startUrl = typeof raw.startUrl === "string" && raw.startUrl.trim() ? raw.startUrl.trim() : "about:blank";
  if (startUrl !== "about:blank") {
    try { startUrl = assertAllowedUrl(startUrl, allowedHosts); }
    catch (error) {
      report("warn", `startUrl 不合法，已改用 about:blank：${error?.message ?? error}`);
      startUrl = "about:blank";
    }
  }

  return {
    headless: raw.headless !== false,
    profileDir,
    executablePath: typeof raw.executablePath === "string" ? raw.executablePath.trim() : "",
    allowEval: raw.allowEval === true,
    allowedHosts,
    viewport: {
      width: clampInt(raw.viewportWidth, 320, 2400, 1280),
      height: clampInt(raw.viewportHeight, 240, 1800, 800),
      dpr: Math.min(2, Math.max(1, Number(raw.dpr) || 1)),
    },
    startUrl,
    screenshotDir: typeof raw.screenshotDir === "string" && raw.screenshotDir.trim()
      ? path.resolve(raw.screenshotDir.trim())
      : path.resolve(profileDir, "..", "shots"),
  };
}

/* ------------------------------- stdio 主循环 ------------------------------- */

const USAGE = `dsh-agent-browser MCP server（stdio）

用法：
  node lib/mcp.js            # 由 MCP 客户端按 stdio 拉起；stdout 只输出协议 JSON
  node lib/mcp.js --help     # 显示本帮助（写 stderr）

环境变量：
  AGENT_BROWSER_CONFIG   JSON 配置，例如
    {"headless":true,"profileDir":"C:\\\\tmp\\\\profile","viewportWidth":1280,"viewportHeight":800,
     "allowedHosts":["example.com","*.example.org"],"allowEval":false}

配置项：headless、profileDir、executablePath、viewportWidth、viewportHeight、dpr、
        allowedHosts、allowEval、startUrl、screenshotDir。
`;

/**
 * 启动 stdio MCP 服务：逐行读 stdin、逐行写 stdout，日志全部走 stderr。
 * SIGINT/SIGTERM 或 stdin 关闭时先 session.close() 再退出。
 *
 * @param {object} [options]
 * @param {string[]} [options.argv] 命令行参数（默认 process.argv.slice(2)）
 * @returns {Promise<void>} 服务装配完成后 resolve（进程随后靠 stdin/信号存活）
 */
export async function runStdio({ argv = process.argv.slice(2) } = {}) {
  const report = (level, message) => defaultLog(level, message);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(USAGE);
    return;
  }

  const config = loadConfig(report);
  const runtime = createRuntime(config, report);
  const server = createMcpServer({ tools: MCP_TOOLS, callTool: runtime.callTool, log: report });

  let shuttingDown = false;
  let rl = null;

  /** 写一行协议 JSON（等 flush 完成再处理下一行，天然背压）。 */
  const writeLine = (line) => new Promise((resolve) => {
    if (shuttingDown) return resolve();
    try {
      process.stdout.write(`${line}\n`, () => resolve());
    } catch (error) {
      report("warn", `写 stdout 失败：${error?.message ?? error}`);
      resolve();
    }
  });

  const shutdown = async (reason, code = 0) => {
    if (shuttingDown) {
      // 第二次 Ctrl+C 直接退出，避免卡住。
      process.exit(code || 1);
      return;
    }
    shuttingDown = true;
    report("info", `MCP 服务关闭（${reason}）`);
    server.close();
    try { rl?.removeAllListeners("line"); rl?.close(); } catch { /* 已关闭 */ }
    try { await runtime.close(); } catch (error) { report("warn", `关闭浏览器失败：${error?.message ?? error}`); }
    process.exitCode = code;
    // 正常情况事件循环会自然结束；万一还有残留句柄，2 秒后强制退出（unref 不影响自然退出）。
    const force = setTimeout(() => process.exit(code), 2_000);
    force.unref?.();
  };

  rl = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

  let queue = Promise.resolve();
  rl.on("line", (line) => {
    queue = queue
      .then(async () => {
        if (shuttingDown) return;
        const out = await server.handle(line);
        if (out !== null && out !== undefined) await writeLine(out);
      })
      .catch((error) => {
        report("error", `处理输入失败：${error?.stack ?? error}`);
      });
  });
  // stdin EOF 时先把已排队的请求处理完（壳里 `node lib/mcp.js < req.txt` 这类用法要拿到响应）。
  rl.on("close", () => { queue.then(() => shutdown("stdin-eof")); });

  process.stdout.on("error", (error) => {
    report("warn", `stdout 不可写：${error?.message ?? error}`);
    void shutdown("stdout-error", 1);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { void shutdown(signal); });
  }
  process.on("uncaughtException", (error) => {
    report("error", `未捕获异常：${error?.stack ?? error}`);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    report("error", `未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack : reason}`);
    void shutdown("unhandledRejection", 1);
  });

  if (process.stdin.isTTY) {
    report("info", "当前是终端：每行输入一个 JSON-RPC 请求（stdout 只输出协议 JSON）。");
  }
  report("info", `MCP stdio 服务已就绪（${MCP_SERVER_INFO.name}@${MCP_SERVER_INFO.version}，${MCP_TOOLS.length} 个工具）`);
}

/* ------------------------------ 直接运行检测 ------------------------------ */

const SELF_PATH = (() => {
  try { return path.resolve(fileURLToPath(import.meta.url)); } catch { return ""; }
})();

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  let resolved;
  try { resolved = path.resolve(entry); } catch { return false; }
  if (process.platform === "win32") return resolved.toLowerCase() === SELF_PATH.toLowerCase();
  return resolved === SELF_PATH;
}

if (isDirectRun()) {
  runStdio({ argv: process.argv.slice(2) }).catch((error) => {
    try { process.stderr.write(`[dsh-agent-browser-mcp] 启动失败：${error?.stack ?? error}\n`); } catch { /* ignore */ }
    process.exitCode = 1;
  });
}