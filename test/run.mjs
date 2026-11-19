#!/usr/bin/env node
/**
 * 无 DSH、无 Chrome 的离线测试入口。
 *
 *   node test/run.mjs            # 全部（租约 / WS / 契约）
 *   node test/run.mjs --unit     # 只跑纯 JS 单测
 *
 * 说明：插件的 host 半 import 了 @deepseek-ai/dsh-tools 与 @deepseek-ai/schemastery，
 * 这两个包由 DSH 宿主在运行时提供。为了让「贡献者不装 DSH 也能跑测试」，
 * 本脚本会在 package 内生成最小 shim（node_modules 已被 .gitignore 忽略）。
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail ?? "") });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? `  ${String(detail).slice(0, 120)}` : ""}`);
}

/* ---------- 0. 生成 shim ---------- */

const DSH_TOOLS_SHIM = `export function defineTool(tool) { return tool; }
export function textRender(fn) { return (_args, value) => [{ type: "text", text: fn(value) }]; }
`;

const SCHEMASTERY_SHIM = `const chain = () => {
  const o = {};
  o.default = (v) => { o.value = v; return o; };
  o.min = () => o;
  o.max = () => o;
  o.description = () => o;
  return o;
};
const z = {
  string: () => chain(),
  number: () => chain(),
  boolean: () => chain(),
  array: () => chain(),
  object: (spec) => ({ type: "object", spec }),
  union: () => chain(),
};
export default z;
export { z };
`;

async function ensureShim(pkg, files) {
  const dir = path.join(ROOT, "node_modules", "@deepseek-ai", pkg);
  try {
    await access(path.join(dir, "index.js"));
    return;
  } catch {}
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }
}

await ensureShim("dsh-tools", {
  "package.json": JSON.stringify({ name: "@deepseek-ai/dsh-tools", version: "0.0.0-test-shim", type: "module", main: "index.js" }, null, 2),
  "index.js": DSH_TOOLS_SHIM,
});
await ensureShim("schemastery", {
  "package.json": JSON.stringify({ name: "@deepseek-ai/schemastery", version: "0.0.0-test-shim", type: "module", main: "index.js" }, null, 2),
  "index.js": SCHEMASTERY_SHIM,
});

/* ---------- 1. 租约 ---------- */

const { LeaseManager, LEASE_EVENT } = await import("../lib/lease.js");

{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lease = new LeaseManager({ agentTtlMs: 120, humanTtlMs: 300 });
  const events = [];
  lease.onEvent((e) => events.push(e.type ?? e));

  const a = lease.acquire({ ownerId: "agent:a", kind: "agent", label: "agent A" });
  check("agent 首次拿租约成功", a.ok === true && a.lease?.ownerId === "agent:a");
  check("状态为 holder", lease.status().free === false && lease.status().holder?.ownerId === "agent:a");

  const b = lease.acquire({ ownerId: "agent:b", kind: "agent", label: "agent B" });
  check("第二个 agent 被挡且拿到 holder 信息", b.ok === false && b.reason === "busy" && b.holder?.ownerId === "agent:a");

  const same = lease.acquire({ ownerId: "agent:a", kind: "agent", label: "agent A" });
  check("同 owner 再次 acquire 视为续期", same.ok === true);

  const human = lease.acquire({ ownerId: "human", kind: "human", label: "用户" });
  check("人类无条件抢占", human.ok === true && lease.status().holder?.kind === "human");
  check("被抢占方收到 PREEMPTED 事件", events.some((e) => String(e).includes(LEASE_EVENT.PREEMPTED) || e === LEASE_EVENT.PREEMPTED));

  const back = lease.acquire({ ownerId: "agent:a", kind: "agent", label: "agent A" });
  check("agent 抢不回人类的租约", back.ok === false && back.reason === "busy");

  lease.release("human");
  check("释放后回到 free", lease.status().free === true);

  const c = lease.acquire({ ownerId: "agent:c", kind: "agent", label: "agent C" });
  check("释放后其他 agent 可拿", c.ok === true);
  await sleep(1400); // sweep 间隔 1s
  const afterExpire = lease.status();
  check("TTL 到期自动释放", afterExpire.free === true && events.some((e) => String(e).includes(LEASE_EVENT.EXPIRED) || e === LEASE_EVENT.EXPIRED));

  // 排队申请（acquireAsync）：被挡住时等待，释放后拿到；超时则返回 busy
  const q1 = lease.acquire({ ownerId: "agent:q1", kind: "agent", label: "queue 1" });
  check("排队测试：q1 先拿到", q1.ok === true);
  setTimeout(() => lease.release("agent:q1"), 300);
  const waitStart = Date.now();
  const queued = await lease.acquireAsync({ ownerId: "agent:q2", kind: "agent", label: "queue 2", waitMs: 3000 });
  check("排队等待后在释放时拿到租约", queued.ok === true && queued.waitedMs >= 250 && Date.now() - waitStart >= 250, `waitedMs=${queued.waitedMs}`);
  const blocked = await lease.acquireAsync({ ownerId: "agent:q3", kind: "agent", label: "queue 3", waitMs: 200 });
  check("排队超时返回 busy", blocked.ok === false && blocked.reason === "busy" && blocked.waitedMs >= 180, `waitedMs=${blocked.waitedMs}`);
  lease.release("agent:q2");
  check("排队测试后回到 free", lease.status().free === true);
  lease.dispose?.();
}

if (process.argv.includes("--unit")) {
  report();
}

/* ---------- 2. 自研 WebSocket ---------- */

{
  const { WsServer } = await import("../lib/ws.js");
  const wss = new WsServer({ path: "/ws" });
  const received = [];
  wss.onConnection((ws) => {
    ws.on("message", (data, kind) => {
      received.push({ data, kind });
      ws.send(kind === "text" ? "echo:" + String(data) : data);
    });
  });

  const http = createServer((req, res) => res.writeHead(200).end("ok"));
  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head);
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const port = http.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.binaryType = "arraybuffer";
  const opened = await new Promise((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("error", () => resolve(false), { once: true });
    setTimeout(() => resolve(false), 3000);
  });
  check("WS 握手成功", opened === true);

  const textReplies = [];
  const binReplies = [];
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") textReplies.push(ev.data);
    else binReplies.push(ev.data);
  });

  ws.send("hello");
  const textOk = await waitFor(() => textReplies.includes("echo:hello"));
  check("文本往返", textOk);

  const payload = new Uint8Array(64 * 1024).fill(7);
  ws.send(payload);
  const binOk = await waitFor(() => binReplies.some((b) => b instanceof ArrayBuffer && b.byteLength === payload.byteLength));
  check("64KB 二进制往返", binOk);

  ws.close();
  await waitFor(() => wss.clients.size === 0);
  check("关闭后服务端清理连接", wss.clients.size === 0, `${wss.clients.size} 个连接`);
  http.close();
  wss.closeAll?.();
}

if (process.argv.includes("--unit")) {
  report();
}

/* ---------- 3. 契约：fake ctx 下 apply 注册了什么 ---------- */

{
  const tools = new Map();
  const httpRoutes = [];
  const upgrades = [];
  const effects = [];
  const systemPromptSections = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, label) {
      effects.push(label ?? "");
      const dispose = fn();
      return () => dispose?.();
    },
    webServer: {
      register(route) {
        httpRoutes.push(route);
        return () => {};
      },
      registerUpgrade(spec) {
        upgrades.push(spec);
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
    systemPrompt: {
      section(spec) {
        systemPromptSections.push(spec);
        return () => {};
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => {};
      },
    },
  };

  const mod = await import("../lib/index.js");
  check("导出 name / inject / Config / apply", mod.name === "dsh-agent-browser" && Array.isArray(mod.inject) && Boolean(mod.Config) && typeof mod.apply === "function");
  check("inject 声明 systemPrompt", mod.inject.includes("systemPrompt"));
  // 契约测试不启动浏览器，profileDir 只是占位。放在系统临时目录，
  // 避免插件安装器把仓库整包复制进 generation 时带上测试痕迹。
  mod.apply(ctx, { profileDir: path.join(os.tmpdir(), "dsh-agent-browser-contract"), headless: true, allowEval: false });

  const expected = [
    "browser_open", "browser_snapshot", "browser_navigate", "browser_click", "browser_type", "browser_press",
    "browser_scroll", "browser_screenshot", "browser_release", "browser_tabs", "browser_wait_for", "browser_eval",
    "browser_upload", "browser_dialog",
  ];
  check("注册 14 个工具", tools.size === 14, `${tools.size}: ${[...tools.keys()].join(",")}`);
  check("工具名齐全", expected.every((n) => tools.has(n)), expected.filter((n) => !tools.has(n)).join(","));
  check(
    "每个工具有描述 / 参数 / execute / output.render",
    [...tools.values()].every((t) => t.description && t.parameters && typeof t.execute === "function" && typeof t.output?.render === "function"),
  );
  check("注册 HTTP 前缀路由 /agent-browser/api", httpRoutes.some((r) => r.kind === "prefix" && r.path === "/agent-browser/api"));
  check("注册 WS upgrade /agent-browser/ws", upgrades.some((u) => u.path === "/agent-browser/ws"));
  check("注入 prompt section", systemPromptSections.some((s) => s.name === "tool:agent-browser" && String(s.text ?? "").includes("browser_snapshot")), `sections=${systemPromptSections.length}`);
  check("用 ctx.effect 管理生命周期", effects.length >= 2, effects.join(" | ").slice(0, 80));
}

report();

/* ---------- 工具函数 ---------- */

function waitFor(predicate, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      let hit = false;
      try {
        hit = predicate();
      } catch {}
      if (hit) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function report() {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n总结：${pass}/${results.length} 通过，${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
  else process.exit(0);
}