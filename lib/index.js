/**
 * dsh-agent-browser —— host 半插件
 *
 * 一件事：给 agent 和用户一个「共用的浏览器会话」。
 *  - 用户：右侧栏 tab 里看实时画面（像素流），点「接管」可直接操作。
 *  - agent：snapshot / click / type / navigate 等工具，按 ref 操作同一页面。
 *  - 冲突：单写者租约（lib/lease.js），人类可随时抢占。
 *
 * 运行时不依赖任何第三方包：CDP 客户端、WebSocket 服务端都是本包自带。
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BrowserSession, defaultProfileDir } from "./engine.js";
import { LeaseManager, LEASE_EVENT } from "./lease.js";
import { WsServer } from "./ws.js";

export const name = "dsh-agent-browser";
export const inject = ["webServer", "connection", "tools"];

export const Config = z.object({
  /** 兜底视口：没有右栏客户端（如纯工具调用）时使用；有客户端时按右栏实际尺寸自动跟随。 */
  viewportWidth: z.number().min(320).max(2400).default(1280),
  viewportHeight: z.number().min(240).max(1800).default(800),
  /** 是否让右栏把实际尺寸同步给浏览器（打开全屏后就是真实桌面浏览器的尺寸）。 */
  autoViewport: z.boolean().default(true),
  /** 无头浏览器；调试时可设 false 看到真实窗口。 */
  headless: z.boolean().default(true),
  /** 指定 Chrome/Edge 可执行文件；留空自动探测。 */
  executablePath: z.string().default(""),
  /** 浏览器 profile 目录；留空用 %LOCALAPPDATA%\\dsh-agent-browser\\profile（保留登录态）。 */
  profileDir: z.string().default(""),
  /** 帧质量 1-100。 */
  frameQuality: z.number().min(1).max(100).default(60),
  hdOnIdle: z.boolean().default(true),
  hdQuality: z.number().min(1).max(100).default(80),
  hdIdleMs: z.number().min(100).max(5_000).default(400),
  /** 出帧上限帧率（实测 screencast 滚动时可出 40+ fps；30 是清晰度/带宽的平衡点）。 */
  maxFps: z.number().min(1).max(60).default(30),
  /** 空闲多久后关闭浏览器（毫秒，0=不关）。 */
  idleCloseMs: z.number().min(0).default(10 * 60 * 1000),
  /** agent 租约 TTL / 人类租约 TTL（毫秒）。 */
  agentLeaseMs: z.number().min(5_000).default(30_000),
  humanLeaseMs: z.number().min(5_000).default(120_000),
  /** agent 拿不到租约时最多排队等待多久（毫秒；0 = 立即返回 busy，交给 agent 自己重试）。 */
  leaseWaitMs: z.number().min(0).max(60_000).default(0),
  /** 有人在排队时，当前 agent 每次操作完主动让出租约（默认开，避免一个长任务饿死其他 agent）。 */
  yieldOnContention: z.boolean().default(true),
  /** 是否允许 browser_eval 执行页面脚本。默认关闭；打开后每次调用都要用户在右栏批准，并写审计日志。 */
  allowEval: z.boolean().default(false),
  /** browser_eval 等用户批准的超时（毫秒）。 */
  evalTimeoutMs: z.number().min(5_000).default(60_000),
  /** 审计日志文件；留空写 profileDir 同级的 audit.jsonl。 */
  auditLog: z.string().default(""),
});

const WS_PATH = "/agent-browser/ws";
const API_PREFIX = "/agent-browser/api";
const MIME_JSON = "application/json; charset=utf-8";

const log = (ctx, level, ...args) => {
  const fn = ctx.logger?.[level];
  if (typeof fn === "function") fn.call(ctx.logger, ...args);
};

function writeJson(res, status, value) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, { "content-type": MIME_JSON, "content-length": body.length, "cache-control": "no-store" });
  res.end(body);
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 像地址栏一样补全：无协议默认 https，localhost/内网 IP 默认 http。 */
function normalizeAddress(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return text;
  if (text.startsWith("//")) return `https:${text}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
  return `https://${text}`;
}

/** 把快照渲染成给模型看的紧凑文本（token 预算见架构文档 §7）。 */
function formatSnapshot(snap) {
  const lines = [];
  lines.push(`URL: ${snap.url}`);
  lines.push(`Title: ${snap.title || "(无标题)"}`);
  if (snap.viewport) {
    lines.push(`Viewport: ${snap.viewport.w}x${snap.viewport.h}, scrollY=${snap.viewport.scrollY}/${Math.max(0, snap.viewport.scrollH - snap.viewport.h)}`);
  }
  const text = String(snap.text ?? "").replace(/\s+/g, " ").trim();
  if (text) {
    const clip = text.length > 2000 ? `${text.slice(0, 2000)}…（正文已截断）` : text;
    lines.push("", "页面文本:", clip);
  }
  const elements = Array.isArray(snap.elements) ? snap.elements.slice(0, 120) : [];
  if (elements.length > 0) {
    lines.push("", "交互元素:");
    for (const el of elements) {
      const parts = [`[${el.ref}]`, el.role];
      if (el.label) parts.push(JSON.stringify(el.label));
      if (el.value) parts.push(`value=${JSON.stringify(el.value)}`);
      if (el.href) parts.push(`href=${el.href}`);
      if (el.rect) parts.push(`@${el.rect.x},${el.rect.y} ${el.rect.w}x${el.rect.h}`);
      lines.push(parts.join(" "));
    }
  } else {
    lines.push("", "（没有可见的交互元素）");
  }
  return lines.join("\n");
}

// DSH 的 output.render 签名是 (args, value)：第一个参数是工具入参，第二个才是输出值。
const textRender = (fn) => (_args, value) => [{ type: "text", text: fn(value) }];

export function apply(ctx, config) {
  const cfg = config ?? {};
  let viewport = { width: cfg.viewportWidth ?? 1280, height: cfg.viewportHeight ?? 800, dpr: 1 };
  const profileDir = cfg.profileDir || defaultProfileDir();
  const lease = new LeaseManager({ agentTtlMs: cfg.agentLeaseMs ?? 30_000, humanTtlMs: cfg.humanLeaseMs ?? 120_000 });

  /** @type {BrowserSession | null} */
  let session = null;
  let starting = null;
  let lastFrame = null;
  let lastFrameAt = 0;
  let lastAnyFrameAt = 0;
  let lastFrameIsHd = false;
  let hdDirty = false;
  let hdInFlight = false;
  let hdSentAt = 0;
  let lastState = { url: "about:blank", title: "" };
  let idleTimer = null;
  let disposed = false;

  const wss = new WsServer();

  const broadcastText = (payload) => { wss.broadcast(JSON.stringify(payload)); };

  const tabsSnapshot = () => (session?.state === "ready" ? session.listTabs() : []);

  const broadcastState = () => { broadcastText({ type: "state", url: lastState.url, title: lastState.title, tabs: tabsSnapshot(), lease: lease.status(), viewport }); };

  /** 把客户端报告的右栏尺寸夹到合理范围（防止 0 宽或异常值把浏览器搞坏）。 */
  const clampViewport = (msg) => {
    const width = Number(msg?.width);
    const height = Number(msg?.height);
    const dpr = Number(msg?.dpr ?? 1);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return {
      width: Math.round(Math.min(2400, Math.max(320, width))),
      height: Math.round(Math.min(1800, Math.max(240, height))),
      dpr: Math.round(Math.min(2, Math.max(1, Number.isFinite(dpr) ? dpr : 1)) * 10) / 10,
    };
  };

  /**
   * 右栏尺寸变化 → 浏览器视口跟随（全屏时等同于真实桌面浏览器窗口）。
   * 多个客户端同时观看时（同一会话开两个页面/一个页面一个脚本），视口取「最窄的那个」：
   * 窄栏里文字最需要清晰度，宽的那边把画面放大显示还能接受；否则两边互相覆盖，画面会来回跳。
   */
  const applyViewport = (next, from) => {
    if (!next || cfg.autoViewport === false) return;
    if (from) from.viewportReport = next;
    let effective = next;
    try {
      for (const client of wss.clients) {
        const candidate = client.viewportReport;
        if (candidate && candidate.width < effective.width) effective = candidate;
      }
    } catch {}
    if (effective.width === viewport.width && effective.height === viewport.height && effective.dpr === viewport.dpr) return;
    viewport = effective;
    hdDirty = true; // 视口变了 → 静止后补一张匹配新尺寸的高清帧
    const current = session;
    if (current && current.state === "ready") {
      current.setViewport(effective).then(() => broadcastState()).catch((error) => {
        log(ctx, "warn", "agent-browser: 同步视口失败 %s", String(error?.message ?? error));
      });
    }
  };

  /* ---- 审批（browser_eval 用）：host 发请求 → 右栏弹窗 → 等回答 ---- */

  const pendingApprovals = new Map();
  const auditPath = cfg.auditLog || path.join(profileDir, "..", "audit.jsonl");

  const audit = async (entry) => {
    try {
      await mkdir(path.dirname(auditPath), { recursive: true });
      await appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
    } catch (error) {
      log(ctx, "warn", "agent-browser: 审计写入失败 %s", String(error?.message ?? error));
    }
  };

  const requestApproval = ({ title, detail, timeoutMs = cfg.evalTimeoutMs ?? 60_000 }) => {
    if (wss.size === 0) return Promise.resolve({ approved: false, reason: "no-client" });
    const id = `ap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pendingApprovals.delete(id); resolve({ approved: false, reason: "timeout" }); }, timeoutMs);
      timer.unref?.();
      pendingApprovals.set(id, {
        resolve: (approved) => { clearTimeout(timer); pendingApprovals.delete(id); resolve({ approved, reason: "user" }); },
      });
      broadcastText({ type: "approval", id, title, detail, timeoutMs });
    });
  };

  const resetIdleTimer = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const ms = cfg.idleCloseMs ?? 0;
    if (ms <= 0) return;
    idleTimer = setTimeout(() => {
      if (wss.size > 0) return; // 有人看着就不关
      closeSession("idle").catch(() => {});
    }, ms);
    idleTimer.unref?.();
  };

  /**
   * 静止高清帧：screencast 按 CSS 像素出帧，高分屏上会被系统放大而发糊。
   * 画面静止 hdIdleMs 后补一张 captureScreenshot（尊重 deviceScaleFactor，分辨率 = CSS × dpr），
   * 只在一段静止里补一次；下一帧运动画面到达后重新武装。
   */
  const maybeSendHdFrame = () => {
    if (cfg.hdOnIdle === false) return;
    const current = session;
    if (!current || current.state !== "ready") return;
    if (hdInFlight || wss.size === 0 || !hdDirty) return;
    const now = Date.now();
    if (now - lastAnyFrameAt < (cfg.hdIdleMs ?? 400)) return;
    if (now - hdSentAt < 1_000) return;
    hdInFlight = true;
    current.captureHdFrame({ quality: cfg.hdQuality ?? 80 }).then((buffer) => {
      if (!buffer?.length || wss.size === 0) return;
      hdSentAt = Date.now();
      hdDirty = false; // 同一段静止只补一次，避免每秒重发
      lastFrame = buffer; // 新连接也从干净的高清帧开始
      lastFrameIsHd = true;
      broadcastText({ type: "frame", mode: "hd", bytes: buffer.length });
      wss.broadcast(buffer);
    }).catch(() => {}).finally(() => { hdInFlight = false; });
  };

  const hdTimer = setInterval(maybeSendHdFrame, 200);
  hdTimer.unref?.();

  const ensureSession = async () => {
    if (disposed) throw new Error("插件已卸载");
    if (session && session.state === "ready") { resetIdleTimer(); return session; }
    if (starting) return starting;
    starting = (async () => {
      const next = new BrowserSession({
        executablePath: cfg.executablePath || undefined,
        profileDir,
        headless: cfg.headless ?? true,
        viewport,
        startUrl: "about:blank",
      });
      await next.start();
      next.onFrame((frame) => {
        lastFrame = frame.data;
        lastFrameIsHd = false;
        const now = Date.now();
        lastAnyFrameAt = now;
        hdDirty = true; // 有新画面 → 下次静止时重新补一张高清帧
        const minGap = Math.max(0, Math.floor(1000 / Math.max(1, cfg.maxFps ?? 12)) - 1);
        if (now - lastFrameAt < minGap) return; // 丢帧，只保最新
        lastFrameAt = now;
        if (wss.size > 0) wss.broadcast(frame.data);
      });
      next.onNavigated((url) => {
        if (typeof url === "string") {
          lastState = { ...lastState, url, title: "" };
          next.getState().then((state) => {
            lastState = { url: state.url, title: state.title };
            broadcastState();
          }).catch(() => {});
        }
        broadcastState();
      });
      await next.startScreencast({ quality: cfg.frameQuality ?? 60, maxWidth: viewport.width, maxHeight: viewport.height });
      session = next;
      log(ctx, "info", "agent-browser: 浏览器已启动 %s", next.browserVersion ?? "");
      void audit({ kind: "session", event: "started", browser: next.browserVersion ?? null, profileDir });
      resetIdleTimer();
      return next;
    })().finally(() => { starting = null; });
    return starting;
  };

  const closeSession = async (reason) => {
    const current = session;
    session = null;
    lastFrame = null;
    lastState = { url: "about:blank", title: "" };
    if (!current) return;
    log(ctx, "info", "agent-browser: 关闭浏览器（%s）", reason);
    void audit({ kind: "session", event: "closed", reason });
    await current.close().catch(() => {});
  };

  const withLease = async (owner, kind, fn) => {
    const waitMs = kind === "agent" ? cfg.leaseWaitMs ?? 0 : 0;
    const got = waitMs > 0
      ? await lease.acquireAsync({ ownerId: owner.id, kind, label: owner.label, waitMs })
      : lease.acquire({ ownerId: owner.id, kind, label: owner.label });
    if (!got.ok) {
      const waited = got.waitedMs > 0 ? `（已排队等待 ${got.waitedMs}ms）` : "";
      throw new Error(
        got.reason === "busy"
          ? `浏览器当前由「${got.holder.label}」占用（${got.holder.kind === "human" ? "用户正在操作" : "另一个 agent 正在操作"}）${waited}。不要重试点击/输入；可以先 browser_snapshot 观察，或等对方 browser_release。`
          : `无法获得浏览器租约：${got.reason}`,
      );
    }
    try {
      return await fn(await ensureSession());
    } finally {
      if (kind === "agent") {
        lease.renew(owner.id);
        // 有人在排队就主动让出：每个操作之间允许别人插进来，避免一个 agent 长时间独占。
        if ((cfg.yieldOnContention ?? true) && lease.hasWaiters()) lease.release(owner.id, "yield");
      }
    }
  };

  const agentOwner = (exec) => ({
    id: exec?.agent?.session?.id ? `session:${exec.agent.session.id}` : "agent",
    label: "agent",
  });

  /* ---- 审计：默认记录每一次工具调用、人类命令、租约事件、会话生命周期 ---- */

  const truncate = (value, max = 300) => {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    const clipped = String(text ?? "");
    return clipped.length > max ? `${clipped.slice(0, max)}…` : clipped;
  };

  /** 所有工具统一包一层审计：{kind:"tool", tool, owner, ok, ms, args}。 */
  const withAudit = (definition) => {
    const inner = definition.execute;
    return defineTool({
      ...definition,
      execute: async (args, exec) => {
        const owner = agentOwner(exec);
        const started = Date.now();
        try {
          const value = await inner(args, exec);
          await audit({ kind: "tool", tool: definition.name, owner: owner.id, ok: true, ms: Date.now() - started, args: truncate(args) });
          return value;
        } catch (error) {
          await audit({ kind: "tool", tool: definition.name, owner: owner.id, ok: false, ms: Date.now() - started, args: truncate(args), error: truncate(String(error?.message ?? error), 500) });
          throw error;
        }
      },
    });
  };

  /* ------------------------------ HTTP API ------------------------------ */

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      if (ctx.connection.requestRejection(req) !== undefined) { writeJson(res, 403, { ok: false, error: "forbidden" }); return; }
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const route = url.pathname.slice(API_PREFIX.length) || "/";
      try {
        if (route === "/state" && req.method === "GET") {
          const state = session?.state === "ready" ? await session.getState().catch(() => lastState) : lastState;
          writeJson(res, 200, { ok: true, running: session?.state === "ready", browser: session?.browserVersion ?? null, viewport, state, tabs: tabsSnapshot(), lease: lease.status(), clients: wss.size });
          return;
        }
        if (route === "/command" && req.method === "POST") {
          const body = await readJsonBody(req);
          const human = { id: "human", kind: "human", label: "用户" };
          // 人类优先：点击等定向操作一律抢占租约。
          // 例外：滚轮只是「看」，agent 持有租约时不抢占（否则用户一边看 agent 一边被自己打断）。
          const holderNow = lease.status().holder;
          const passive = body.type === "scroll" && holderNow?.kind === "agent";
          if (!passive) lease.acquire({ ownerId: human.id, kind: "human", label: human.label });
          const startedAt = Date.now();
          const target = truncate({ type: body.type, ref: body.ref, x: body.x, y: body.y, url: body.url, key: body.key, text: body.text, tabId: body.tabId, deltaY: body.deltaY });
          try {
            const result = await handleCommand(await ensureSession(), body);
            if (!passive) lease.renew("human");
            await audit({ kind: "command", owner: human.id, op: String(body.type), ok: true, passive, ms: Date.now() - startedAt, target });
            writeJson(res, 200, { ok: true, result, passive, lease: lease.status() });
          } catch (error) {
            if (!passive) lease.release(human.id);
            await audit({ kind: "command", owner: human.id, op: String(body.type), ok: false, passive, ms: Date.now() - startedAt, target, error: truncate(String(error?.message ?? error), 500) });
            writeJson(res, 400, { ok: false, error: String(error?.message ?? error) });
          }
          return;
        }
        if (route === "/lease" && req.method === "POST") {
          const body = await readJsonBody(req);
          if (body.action === "release") {
            lease.release("human");
            writeJson(res, 200, { ok: true, lease: lease.status() });
            return;
          }
          if (body.action === "takeover") {
            lease.takeOver({ ownerId: "human", label: "用户" });
            writeJson(res, 200, { ok: true, lease: lease.status() });
            return;
          }
          writeJson(res, 400, { ok: false, error: "未知 action" });
          return;
        }
        if (route === "/screenshot" && req.method === "GET") {
          const current = await ensureSession();
          const shot = await current.screenshot({ format: "jpeg", quality: 70 });
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": shot.data.length, "cache-control": "no-store" });
          res.end(shot.data);
          return;
        }
        writeJson(res, 404, { ok: false, error: "not-found" });
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }), "dsh-agent-browser: http api");

  /* -------------------------- WebSocket 画面流 -------------------------- */

  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: WS_PATH,
    handler: (req, socket, head) => {
      if (ctx.connection.requestRejection(req) !== undefined) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head);
    },
  }), "dsh-agent-browser: screencast websocket");

  wss.onConnection((ws) => {
    resetIdleTimer();
    ws.send(JSON.stringify({ type: "hello", viewport, lease: lease.status(), tabs: tabsSnapshot(), browser: session?.browserVersion ?? null }));
    if (lastFrame) {
      if (lastFrameIsHd) ws.send(JSON.stringify({ type: "frame", mode: "hd" }));
      ws.send(lastFrame);
    }
    ws.on("message", (data, kind) => {
      if (kind !== "text") return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg?.type === "ping") { ws.send(JSON.stringify({ type: "pong", at: Date.now() })); return; }
      if (msg?.type === "viewport") { applyViewport(clampViewport(msg), ws); return; }
      if (msg?.type === "approval-response") {
        const pending = pendingApprovals.get(String(msg.id));
        if (pending) pending.resolve(Boolean(msg.approved));
        return;
      }
    });
    ws.on("close", () => { resetIdleTimer(); });
    ensureSession().then((current) => {
      ws.send(JSON.stringify({ type: "state", url: lastState.url, title: lastState.title, tabs: tabsSnapshot(), lease: lease.status(), viewport, browser: current.browserVersion ?? null }));
    }).catch((error) => {
      ws.send(JSON.stringify({ type: "error", message: String(error?.message ?? error) }));
    });
  });

  const offLease = lease.onEvent((event) => {
    broadcastText({ type: "lease", event: event.type, lease: event.lease ?? null });
    const ended = event.released ?? event.preempted ?? event.expired ?? null;
    const holder = event.lease ?? ended;
    void audit({
      kind: "lease",
      event: event.type,
      owner: holder?.ownerId ?? null,
      holderKind: holder?.kind ?? null,
      by: event.by ? `${event.by.kind}:${event.by.ownerId}` : null,
      ttlMs: holder?.ttlMs ?? null,
    });
  });

  /* ------------------------------- 命令处理 ------------------------------ */

  async function handleCommand(current, body) {
    const result = await handleCommandInner(current, body);
    hdDirty = true; // 有一次操作 → 静止后补一张高清帧（操作前后画面可能已经变干净）
    return result;
  }

  async function handleCommandInner(current, body) {
    switch (body.type) {
      case "navigate": {
        const url = normalizeAddress(body.url);
        if (!url) throw new Error("地址为空");
        const state = await current.navigate(url);
        lastState = { url: state.url, title: state.title };
        broadcastState();
        return state;
      }
      case "back":
      case "forward": {
        const state = await current.navigateHistory(body.type === "back" ? -1 : 1);
        lastState = { url: state.url, title: state.title };
        broadcastState();
        return state;
      }
      case "click": {
        if (body.ref) return current.clickRef(String(body.ref));
        if (typeof body.x === "number" && typeof body.y === "number") return current.clickAt(body.x, body.y);
        throw new Error("click 需要 ref 或 x/y");
      }
      case "type": {
        if (body.ref) return current.typeRef(String(body.ref), String(body.text ?? ""), { clear: Boolean(body.clear) });
        return current.typeText(String(body.text ?? ""));
      }
      case "press": return current.press(String(body.key));
      case "scroll": return current.scroll({ deltaY: Number(body.deltaY ?? 600) });
      case "reload": return current.navigate(lastState.url || "about:blank");
      case "tab/list": return current.listTabs();
      case "tab/new": {
        await current.newTab(body.url ? String(body.url) : "about:blank");
        const tabs = current.listTabs();
        const active = tabs.find((tab) => tab.active);
        if (active) lastState = { url: active.url, title: active.title };
        broadcastState();
        return tabs;
      }
      case "tab/select": {
        await current.selectTab(String(body.tabId));
        const tabs = current.listTabs();
        const active = tabs.find((tab) => tab.active);
        if (active) lastState = { url: active.url, title: active.title };
        broadcastState();
        return tabs;
      }
      case "tab/close": {
        await current.closeTab(String(body.tabId));
        const tabs = current.listTabs();
        const active = tabs.find((tab) => tab.active);
        if (active) lastState = { url: active.url, title: active.title };
        broadcastState();
        return tabs;
      }
      default: throw new Error(`未知命令：${body.type}`);
    }
  }

  /* --------------------------------- 工具 -------------------------------- */

  const ownerOf = (exec) => agentOwner(exec);

  ctx.tools.register(withAudit({
    name: "browser_open",
    description: "在内嵌浏览器中打开一个网页（http/https），并返回页面快照。用户可以在右侧栏实时看到同一画面。打开后你会拿到浏览器租约，可以继续 click/type；不操作时请 browser_release。",
    parameters: {
      url: { type: "string", required: true, description: "要打开的网址，必须是 http:// 或 https://" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true, description: "最终地址" },
          title: { type: "string", required: true, description: "页面标题" },
          snapshot: { type: "string", required: true, description: "页面快照（可交互元素列表）" },
        },
      },
      render: textRender((v) => v.snapshot),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      const owner = ownerOf(exec);
      return withLease(owner, "agent", async (current) => {
        await current.navigate(normalizeAddress(args.url));
        const snap = await current.snapshot();
        lastState = { url: snap.url, title: snap.title };
        broadcastState();
        return { url: snap.url, title: snap.title, snapshot: formatSnapshot(snap) };
      });
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_snapshot",
    description: "读取当前浏览器的页面快照：地址、标题、可见文本、可交互元素（带 eN 引用）。操作前先 snapshot，引用过期后重新 snapshot。这是只读操作，不需要持有写租约。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true, description: "当前地址" },
          title: { type: "string", required: true, description: "页面标题" },
          snapshot: { type: "string", required: true, description: "快照文本" },
        },
      },
      render: textRender((v) => v.snapshot),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      const current = await ensureSession();
      const snap = await current.snapshot();
      lastState = { url: snap.url, title: snap.title };
      return { url: snap.url, title: snap.title, snapshot: formatSnapshot(snap) };
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_navigate",
    description: "让当前浏览器标签页跳转到另一个 http/https 地址（保留登录态与 profile）。",
    parameters: {
      url: { type: "string", required: true, description: "目标网址" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true, description: "最终地址" },
          title: { type: "string", required: true, description: "页面标题" },
        },
      },
      render: textRender((v) => `已打开 ${v.url}\n标题：${v.title}`),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      return withLease(ownerOf(exec), "agent", async (current) => {
        const state = await current.navigate(normalizeAddress(args.url));
        lastState = { url: state.url, title: state.title };
        broadcastState();
        return { url: state.url, title: state.title };
      });
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_click",
    description: "点击快照中的一个元素（用 eN 引用，例如 e3），或点击视口坐标 (x,y)。使用真实鼠标事件（CDP Input.dispatchMouseEvent）。",
    parameters: {
      ref: { type: "string", description: "快照里的元素引用，如 e3" },
      x: { type: "number", description: "视口坐标 x（不传 ref 时使用）" },
      y: { type: "number", description: "视口坐标 y（不传 ref 时使用）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否已派发点击" },
          detail: { type: "string", required: true, description: "点击位置说明" },
        },
      },
      render: textRender((v) => v.detail),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      return withLease(ownerOf(exec), "agent", async (current) => {
        const at = args.ref ? await current.clickRef(String(args.ref)) : await current.clickAt(Number(args.x), Number(args.y));
        await sleep(120);
        return { ok: true, detail: `已在 (${Math.round(at.x)}, ${Math.round(at.y)}) 点击${args.ref ? ` ${args.ref}` : ""}` };
      });
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_type",
    description: "向快照中的输入元素（eN）输入文本；中文等非 ASCII 文本用 Input.insertText 注入。可选 submit=true 输入后回车。",
    parameters: {
      ref: { type: "string", required: true, description: "输入元素的快照引用" },
      text: { type: "string", required: true, description: "要输入的文本" },
      clear: { type: "boolean", description: "输入前清空原值" },
      submit: { type: "boolean", description: "输入后按 Enter" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否成功" },
          detail: { type: "string", required: true, description: "结果说明" },
        },
      },
      render: textRender((v) => v.detail),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      return withLease(ownerOf(exec), "agent", async (current) => {
        await current.typeRef(String(args.ref), String(args.text), { clear: Boolean(args.clear) });
        if (args.submit) { await current.press("Enter"); }
        await sleep(120);
        return { ok: true, detail: `已向 ${args.ref} 输入 ${JSON.stringify(String(args.text)).slice(0, 120)}${args.submit ? " 并回车" : ""}` };
      });
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_press",
    description: "在当前页面按一个键：Enter、Tab、Escape、Backspace、Delete、ArrowUp/Down/Left/Right、PageUp/PageDown、Home、End。",
    parameters: {
      key: { type: "string", required: true, description: "键名" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否成功" },
          detail: { type: "string", required: true, description: "结果说明" },
        },
      },
      render: textRender((v) => v.detail),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      return withLease(ownerOf(exec), "agent", async (current) => {
        await current.press(String(args.key));
        await sleep(80);
        return { ok: true, detail: `已按键 ${args.key}` };
      });
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_scroll",
    description: "滚动当前页面（正数向下）。",
    parameters: {
      deltaY: { type: "number", required: true, description: "滚动像素，例如 600（向下）、-600（向上）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否成功" },
          detail: { type: "string", required: true, description: "结果说明" },
        },
      },
      render: textRender((v) => v.detail),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      return withLease(ownerOf(exec), "agent", async (current) => {
        await current.scroll({ deltaY: Number(args.deltaY) });
        await sleep(120);
        return { ok: true, detail: `已滚动 ${args.deltaY}px` };
      });
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_screenshot",
    description: "截取当前页面为 JPEG 并保存到本地文件，返回文件路径。用户也能在右侧栏看到实时画面；此工具用于需要存档或精确视觉检查时。",
    parameters: {
      full_page: { type: "boolean", description: "是否截整页（默认只截视口）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true, description: "PNG/JPEG 文件绝对路径" },
          bytes: { type: "number", required: true, description: "文件字节数" },
        },
      },
      render: textRender((v) => `截图已保存：${v.path}（${v.bytes} 字节）`),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      const current = await ensureSession();
      const shot = await current.screenshot({ format: "jpeg", quality: 80, fullPage: Boolean(args.full_page) });
      const dir = path.join(profileDir, "..", "shots");
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `shot-${Date.now()}.jpg`);
      await writeFile(file, shot.data);
      return { path: file, bytes: shot.data.length };
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_release",
    description: "释放浏览器写租约，把控制权交还用户或其它 agent。长时间不操作时请调用，避免阻塞用户。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否释放成功" },
          detail: { type: "string", required: true, description: "说明" },
        },
      },
      render: textRender((v) => v.detail),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      const owner = ownerOf(exec);
      const result = lease.release(owner.id);
      return { ok: result.ok, detail: result.ok ? "已释放浏览器租约" : "当前没有持有租约" };
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_tabs",
    description: "管理浏览器标签页：list 列出全部标签；new 新开一个标签（可带 url）；select 切换当前标签；close 关闭指定标签（不允许关闭最后一个）。tab_id 支持唯一前缀。",
    parameters: {
      action: { type: "string", required: true, description: "list | new | select | close" },
      url: { type: "string", description: "action=new 时要打开的 http/https 地址" },
      tab_id: { type: "string", description: "action=select/close 时的标签 id（可用唯一前缀）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否成功" },
          detail: { type: "string", required: true, description: "结果说明" },
          tabs: { type: "string", required: true, description: "标签列表文本（* 表示当前标签）" },
        },
      },
      render: textRender((v) => `${v.detail}\n${v.tabs}`),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      const action = String(args.action);
      const formatTabs = (tabs) => tabs.map((tab) => `${tab.active ? "*" : " "} ${tab.targetId.slice(0, 8)}  ${tab.title || "(无标题)"}  ${tab.url}`).join("\n") || "(没有标签)";
      if (action === "list") {
        const current = await ensureSession();
        const tabs = current.listTabs();
        return { ok: true, detail: `共 ${tabs.length} 个标签页`, tabs: formatTabs(tabs) };
      }
      return withLease(ownerOf(exec), "agent", async (current) => {
        if (action === "new") await current.newTab(args.url ? String(args.url) : "about:blank");
        else if (action === "select") await current.selectTab(String(args.tab_id ?? ""));
        else if (action === "close") await current.closeTab(String(args.tab_id ?? ""));
        else throw new Error(`未知 action：${action}`);
        const tabs = current.listTabs();
        const active = tabs.find((tab) => tab.active);
        if (active) { lastState = { url: active.url, title: active.title }; broadcastState(); }
        const verb = { new: "新开", select: "切换", close: "关闭" }[action];
        return { ok: true, detail: `已${verb}标签页，现在共 ${tabs.length} 个`, tabs: formatTabs(tabs) };
      });
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_wait_for",
    description: "等待页面出现某个元素（CSS selector）或某段可见文本（text），最多等 timeout_ms。返回 found 布尔值；超时返回 found=false 而不是报错。",
    parameters: {
      selector: { type: "string", description: "CSS 选择器，例如 #result、button.submit" },
      text: { type: "string", description: "页面可见文本片段" },
      timeout_ms: { type: "number", description: "超时毫秒，默认 10000，范围 200-60000" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          found: { type: "boolean", required: true, description: "是否在超时内出现" },
          waited_ms: { type: "number", required: true, description: "实际等待毫秒数" },
          detail: { type: "string", required: true, description: "结果说明" },
        },
      },
      render: textRender((v) => v.detail),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      const selector = args.selector ? String(args.selector) : null;
      const text = args.text ? String(args.text) : null;
      if (!selector && !text) throw new Error("browser_wait_for 需要 selector 或 text");
      const timeout = Math.min(60_000, Math.max(200, Number(args.timeout_ms ?? 10_000)));
      const current = await ensureSession();
      const expression = selector
        ? `!!document.querySelector(${JSON.stringify(selector)})`
        : `(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`;
      const started = Date.now();
      let found = false;
      while (Date.now() - started < timeout) {
        exec.signal?.throwIfAborted?.();
        try { found = Boolean(await current.evaluate(expression)); } catch { found = false; }
        if (found) break;
        await sleep(150);
      }
      const waited = Date.now() - started;
      const what = selector ? `选择器 ${selector}` : `文本 ${JSON.stringify(text)}`;
      return { found, waited_ms: waited, detail: found ? `已等到 ${what}（${waited}ms）` : `等待超时（${waited}ms），未出现 ${what}` };
    },
  }));

  ctx.tools.register(withAudit({
    name: "browser_eval",
    description: "在页面上下文执行一段 JavaScript 表达式并返回结果。默认关闭（allowEval=false）；开启后每次调用都会在右侧栏弹窗请求用户批准，并把表达式写入审计日志。只用于 snapshot/click 无法表达的场景。",
    parameters: {
      expression: { type: "string", required: true, description: "要在页面上下文求值的表达式" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "是否执行成功" },
          result: { type: "string", required: true, description: "结果文本（最多 2000 字）" },
        },
      },
      render: textRender((v) => `执行完成，结果：\n${v.result}`),
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      const expression = String(args.expression);
      if (!cfg.allowEval) throw new Error("browser_eval 已被配置关闭（allowEval=false）。需要用户在插件配置里显式开启，并且由右栏批准每次执行。");
      if (expression.length > 4_000) throw new Error("表达式太长（上限 4000 字符）");
      const owner = ownerOf(exec);
      const approval = await requestApproval({
        title: "允许 agent 在这个页面执行脚本？",
        detail: expression.length > 800 ? `${expression.slice(0, 800)}…` : expression,
      });
      await audit({ kind: "eval", owner: owner.id, expression, approved: approval.approved, reason: approval.reason });
      if (!approval.approved) {
        const reasons = { "no-client": "右侧栏没有打开客户端，无法征求批准", timeout: "等待用户批准超时", user: "用户拒绝了这次执行" };
        throw new Error(`browser_eval 未获批准：${reasons[approval.reason] ?? approval.reason}`);
      }
      return withLease(owner, "agent", async (current) => {
        const value = await current.evaluate(expression);
        const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
        return { ok: true, result: String(text).slice(0, 2_000) };
      });
    },
  }));

  /* ------------------------------- 生命周期 ------------------------------ */

  ctx.effect(() => () => {
    disposed = true;
    if (idleTimer) clearTimeout(idleTimer);
    clearInterval(hdTimer);
    offLease();
    try { wss.closeAll(); } catch {}
    lease.dispose();
    return closeSession("dispose");
  }, "dsh-agent-browser: dispose");

  log(ctx, "info", "agent-browser: 插件已加载（ws %s，api %s）", WS_PATH, API_PREFIX);
}