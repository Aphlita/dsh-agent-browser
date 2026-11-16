/**
 * 多 agent 并发压测（需要本机 Chrome / Edge；不需要 DSH）。
 *
 * 目的：验证插件最核心的主张——「多个 agent 和人类共用同一个已登录浏览器会话，
 * 靠单写者租约轮流操作」。量三个指标：
 *   1) 冲突率：写操作第一次就撞上 busy 的比例（其余靠排队/重试消化）；
 *   2) 平均等待：从发起操作到真正拿到租约的时长；
 *   3) 被抢占 / 到期后的 recover 时长：人类接管释放或租约过期后，agent 多久能重新操作。
 *
 * 用法：node test/stress.mjs            （约 25-40s）
 *       node test/stress.mjs --quick    （每场景操作数减半）
 *
 */
import http from "node:http";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const PORT = 39199;
const QUICK = process.argv.includes("--quick");
const OPS = QUICK ? 6 : 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>并发压测页</title>
<style>body{font-family:sans-serif;padding:16px}button{font-size:16px;padding:8px 14px;margin-right:8px}
#n{font-size:20px;color:#06c;margin-top:12px}</style></head><body>
<h1>多 agent 租约压测</h1>
<button id="inc">+1</button><button id="reset">重置</button>
<div id="n">0</div>
<script>
let n = 0; const out = document.getElementById('n');
document.getElementById('inc').onclick = () => { out.textContent = String(++n); };
document.getElementById('reset').onclick = () => { n = 0; out.textContent = '0'; };
let hue = 0; (function tick(){ hue = (hue + 3) % 360; document.body.style.background = 'hsl(' + hue + ' 60% 97%)'; requestAnimationFrame(tick); })();
</script></body></html>`;

/* ---------------- 假 context：把 host 半挂到本地 http 服务器 ---------------- */
const routes = [];
const upgrades = [];
const tools = new Map();
const effects = [];
const logger = { info() {}, warn() {}, error() {} };
const ctx = {
  logger,
  effect(fn, label) { const dispose = fn(); effects.push({ label, dispose }); return () => dispose?.(); },
  connection: { requestRejection: () => undefined },
  webServer: {
    register(route) { routes.push(route); return () => {}; },
    registerUpgrade(route) { upgrades.push(route); return () => {}; },
  },
  tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } },
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  if (pathname === "/") {
    const body = Buffer.from(PAGE, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
    res.end(body);
    return;
  }
  const route = routes.find((r) => pathname.startsWith(r.path));
  if (route) { route.handler(req, res); return; }
  res.writeHead(404); res.end("not found");
});
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  const route = upgrades.find((r) => r.path === pathname);
  if (!route) { socket.destroy(); return; }
  route.handler(req, socket, head);
});

const api = async (route, init) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/agent-browser/api${route}`, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text };
};
const postJson = (route, body) => api(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* ---------------- 工具调用 / 带重试的操作 ---------------- */
const execOf = (sessionId) => ({ agent: { session: { id: sessionId } }, signal: new AbortController().signal });
const callTool = (name, args, sessionId) => tools.get(name).execute(args, execOf(sessionId));

const isBusy = (error) => /占用/.test(String(error?.message ?? error));

/** 一次写操作：撞上 busy 就每 100ms 重试，直到成功或超时。返回等待/冲突明细。 */
async function opWithRetry(sessionId, name, args, maxMs = 30_000) {
  const started = Date.now();
  let attempts = 0;
  let busy = 0;
  for (;;) {
    attempts += 1;
    try {
      const value = await callTool(name, args, sessionId);
      return { ok: true, attempts, busy, waitMs: Date.now() - started, value };
    } catch (error) {
      if (!isBusy(error)) return { ok: false, attempts, busy, waitMs: Date.now() - started, error: String(error?.message ?? error) };
      busy += 1;
      if (Date.now() - started >= maxMs) return { ok: false, attempts, busy, waitMs: Date.now() - started, error: "timeout" };
      await sleep(100);
    }
  }
}

const pct = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
};
const avg = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
const round = (value, digits = 1) => Number(Number(value).toFixed(digits));

const scenarios = [];

/* ---------------- 场景 1/2：并发争用 ---------------- */
async function contention(agents, opsPerAgent) {
  const startedAt = Date.now();
  const agentStats = await Promise.all(
    Array.from({ length: agents }, (_, index) =>
      (async () => {
        const sessionId = `stress-${agents}-${index}`;
        const results = [];
        for (let k = 0; k < opsPerAgent; k += 1) {
          const op = k % 4 === 0
            ? await opWithRetry(sessionId, "browser_scroll", { deltaY: 120 })
            : await opWithRetry(sessionId, "browser_click", { ref: k % 2 === 0 ? "e1" : "e2" });
          results.push(op);
        }
        return { sessionId, results };
      })(),
    ),
  );
  const wallMs = Date.now() - startedAt;
  const ops = agentStats.flatMap((agent) => agent.results);
  const totalAttempts = ops.reduce((sum, op) => sum + op.attempts, 0);
  const busyAttempts = ops.reduce((sum, op) => sum + op.busy, 0);
  const okOps = ops.filter((op) => op.ok);
  const waits = okOps.map((op) => op.waitMs);
  const perAgent = agentStats.map((agent) => ({
    agent: agent.sessionId,
    ops: agent.results.length,
    ok: agent.results.filter((op) => op.ok).length,
    waitMaxMs: round(Math.max(...agent.results.map((op) => op.waitMs))),
    waitAvgMs: round(avg(agent.results.map((op) => op.waitMs))),
  }));
  const summary = {
    agents,
    opsPerAgent,
    totalOps: ops.length,
    okOps: okOps.length,
    failedOps: ops.length - okOps.length,
    totalAttempts,
    busyAttempts,
    conflictRate: round(busyAttempts / Math.max(1, totalAttempts), 3),
    firstTryConflictRate: round(ops.filter((op) => op.busy > 0).length / Math.max(1, ops.length), 3),
    waitAvgMs: round(avg(waits)),
    waitP50Ms: round(pct(waits, 50)),
    waitP95Ms: round(pct(waits, 95)),
    waitMaxMs: round(Math.max(...waits)),
    wallMs,
    throughputOpsPerSec: round((okOps.length / Math.max(1, wallMs)) * 1000, 2),
    perAgent,
  };
  console.log(`\n=== ${agents} agent × ${opsPerAgent} 写操作 ===`);
  console.log(`  成功 ${summary.okOps}/${summary.totalOps}  墙钟 ${wallMs}ms  吞吐 ${summary.throughputOpsPerSec} ops/s`);
  console.log(`  尝试 ${totalAttempts} 次，其中撞 busy ${busyAttempts} 次 → 冲突率 ${(summary.conflictRate * 100).toFixed(1)}%（首次即冲突的操作占 ${(summary.firstTryConflictRate * 100).toFixed(1)}%）`);
  console.log(`  等待：平均 ${summary.waitAvgMs}ms  p50 ${summary.waitP50Ms}ms  p95 ${summary.waitP95Ms}ms  max ${summary.waitMaxMs}ms`);
  for (const agent of perAgent) console.log(`    ${agent.agent}: ${agent.ok}/${agent.ops} 成功，等待平均 ${agent.waitAvgMs}ms / max ${agent.waitMaxMs}ms`);
  scenarios.push({ name: `contention-${agents}`, ...summary });
  return summary;
}

/** 清空租约：以「人类接管 + 释放」把租约归零（测试脚本没有别的强制释放通道）。 */
async function freeLease() {
  await postJson("/lease", { action: "takeover" });
  await postJson("/lease", { action: "release" });
}

/* ---------------- 场景 3：人类抢占 → 释放后的 recover ---------------- */
async function preemption(holdMs = 1200) {
  const sessionId = "stress-preempt";
  const timeline = [];
  let stop = false;
  let humanHeldAt = 0;
  let releasedAt = 0;
  const worker = (async () => {
    while (!stop) {
      const startedAt = Date.now();
      try {
        await callTool("browser_click", { ref: "e1" }, sessionId);
        timeline.push({ at: startedAt, ok: true, ms: Date.now() - startedAt });
      } catch (error) {
        timeline.push({ at: startedAt, ok: false, busy: isBusy(error), error: String(error?.message ?? error), ms: Date.now() - startedAt });
      }
      await sleep(150);
    }
  })();

  await sleep(900); // 先让 agent 稳定在写循环里
  const takeover = await postJson("/command", { type: "click", x: 120, y: 260 });
  humanHeldAt = Date.now();
  const holder = takeover.json?.lease?.holder;
  if (holder?.kind !== "human") throw new Error(`人类接管失败：${JSON.stringify(takeover.json)}`);
  await sleep(holdMs);
  await postJson("/lease", { action: "release" });
  releasedAt = Date.now();
  await sleep(1200);
  stop = true;
  await worker;

  const during = timeline.filter((item) => item.at >= humanHeldAt && item.at < releasedAt);
  const after = timeline.filter((item) => item.at >= releasedAt);
  const firstOkAfter = after.find((item) => item.ok);
  const recover = {
    humanHoldMs: releasedAt - humanHeldAt,
    agentOpsDuringHold: during.length,
    // 人类持租期间发起、被排队挡住的尝试（拿不到租约）
    agentBlockedDuringHold: during.filter((item) => item.ok === false).length,
    // 人类持租期间发起、释放后才完成的尝试（说明是排队而不是失败）
    agentQueuedDuringHold: during.filter((item) => item.ok === true).length,
    agentMaxWaitDuringHoldMs: round(Math.max(0, ...during.map((item) => item.ms))),
    recoverMs: firstOkAfter ? firstOkAfter.at - releasedAt : null,
    opsAfter: after.length,
    okAfter: after.filter((item) => item.ok).length,
  };
  console.log(`\n=== 人类抢占（持租 ${recover.humanHoldMs}ms） ===`);
  console.log(`  抢占期间 agent 发起 ${recover.agentOpsDuringHold} 次操作：被挡失败 ${recover.agentBlockedDuringHold} 次，排队到释放后完成 ${recover.agentQueuedDuringHold} 次，单次最长等待 ${recover.agentMaxWaitDuringHoldMs}ms`);
  console.log(`  人类释放后 agent recover：${recover.recoverMs}ms（之后 ${recover.okAfter}/${recover.opsAfter} 成功）`);
  scenarios.push({ name: "preemption", ...recover });
  return recover;
}

/* ---------------- 场景 4：租约到期（TTL）后的 recover ---------------- */
async function ttlRecover(ttlMs) {
  const holder = "stress-ttl-holder";
  const waiter = "stress-ttl-waiter";
  await callTool("browser_click", { ref: "e1" }, holder); // 拿到租约后不再续期
  const startedAt = Date.now();
  const got = await opWithRetry(waiter, "browser_click", { ref: "e1" }, ttlMs + 15_000);
  const waitedMs = Date.now() - startedAt;
  const summary = {
    agentLeaseMs: ttlMs,
    waitedMs,
    ok: got.ok,
    attempts: got.attempts,
    busyAttempts: got.busy,
    deltaFromTtlMs: waitedMs - ttlMs,
  };
  console.log(`\n=== 租约到期（TTL ${ttlMs}ms，持租方不续期） ===`);
  console.log(`  另一个 agent 等待 ${waitedMs}ms 后拿到租约（相对 TTL ${summary.deltaFromTtlMs >= 0 ? "+" : ""}${summary.deltaFromTtlMs}ms）`);
  scenarios.push({ name: "ttl-recover", ...summary });
  return summary;
}

/* ---------------- 主流程 ---------------- */
let exitCode = 0;
try {
  await rm(path.join(ROOT, ".test-profile"), { recursive: true, force: true }).catch(() => {});
  const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
  const AUDIT = path.join(ROOT, ".test-profile", "audit.jsonl");
  mod.apply(ctx, {
    headless: true,
    maxFps: 8,
    idleCloseMs: 0,
    leaseWaitMs: 2_500,
    yieldOnContention: true,
    agentLeaseMs: 4_000,
    humanLeaseMs: 30_000,
    auditLog: AUDIT,
    profileDir: path.join(ROOT, ".test-profile", "profile"),
  });

  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const open = await callTool("browser_open", { url: `http://127.0.0.1:${PORT}/` }, "stress-setup");
  console.log(`浏览器：${open.title}（${open.url}）`);
  const refs = [...String(open.snapshot ?? "").matchAll(/\[(e\d+)\] button "([^"]*)"/g)].map((m) => ({ ref: m[1], label: m[2] }));
  if (refs.length < 2) throw new Error(`测试页没有找到两个按钮：${open.snapshot}`);
  console.log(`按钮引用：${refs.map((r) => `${r.ref}=${r.label}`).join(" / ")}`);
  await callTool("browser_release", {}, "stress-setup");

  await contention(1, OPS);        // 基线
  await freeLease();
  await contention(2, OPS);
  await freeLease();
  await contention(4, OPS);
  await freeLease();
  await preemption(1200);
  await freeLease();
  await ttlRecover(4_000);

  // 审计覆盖：读压测期间写出的 audit.jsonl，确认工具 / 命令 / 租约 / 会话都被记录
  const auditLines = (await readFile(AUDIT, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  const auditSummary = { total: auditLines.length, byKind: {}, tools: {} };
  for (const entry of auditLines) {
    auditSummary.byKind[entry.kind] = (auditSummary.byKind[entry.kind] ?? 0) + 1;
    if (entry.kind === "tool") auditSummary.tools[entry.tool] = (auditSummary.tools[entry.tool] ?? 0) + 1;
  }
  console.log(`\n=== 审计覆盖 ===`);
  console.log(`  共 ${auditSummary.total} 条：${Object.entries(auditSummary.byKind).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`  工具：${Object.entries(auditSummary.tools).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  const report = {
    at: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, quick: QUICK },
    scenarios,
    audit: auditSummary,
  };
  await mkdir(path.dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n结果已写入：${OUT_JSON}`);
} catch (error) {
  exitCode = 1;
  console.error("\n压测失败：", error);
} finally {
  for (const effect of effects.reverse()) { try { await effect.dispose?.(); } catch {} }
  await sleep(500);
  server.close();
  process.exit(exitCode);
}