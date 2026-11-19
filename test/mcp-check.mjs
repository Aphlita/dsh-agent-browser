#!/usr/bin/env node
/**
 * MCP 出口（lib/mcp.js）离线测试：不启动浏览器、不装任何依赖。
 *
 *   node test/mcp-check.mjs
 *
 * 用假 callTool + 2 个工具驱动 createMcpServer，覆盖 initialize / notifications、
 * tools/list、tools/call 成功与失败、未知工具、未知方法、坏 JSON、通知无响应等。
 */
import { createMcpServer } from "../lib/mcp.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${String(detail).slice(0, 160)}` : ""}`);
}

/* ---------------------------- 假工具与假 callTool ---------------------------- */

const tools = [
  {
    name: "fake_echo",
    description: "回显输入文本（正常返回）",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
  },
  {
    name: "fake_boom",
    description: "总是抛错（验证 isError:true）",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const calls = [];
async function callTool(name, args) {
  calls.push({ name, args });
  if (name === "fake_echo") return { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] };
  if (name === "fake_boom") throw new Error("boom!");
  throw new Error(`假 callTool 不认识：${name}`);
}

const server = createMcpServer({ tools, callTool, log: () => {} });

/** 发一行请求，返回解析后的响应对象。 */
async function request(payload) {
  const line = typeof payload === "string" ? payload : JSON.stringify(payload);
  const out = await server.handle(line);
  if (out === null) throw new Error(`期望有响应，实际是通知：${line.slice(0, 80)}`);
  return JSON.parse(out);
}

/* ---------------------------------- 断言 ---------------------------------- */

/* 1. initialize */
{
  const res = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-check", version: "0.0.0" } },
  });
  const info = res.result?.serverInfo ?? {};
  check(
    "initialize 返回 protocolVersion/capabilities/serverInfo",
    res.jsonrpc === "2.0"
      && res.id === 1
      && res.result?.protocolVersion === "2024-11-05"
      && res.result?.capabilities?.tools && typeof res.result.capabilities.tools === "object"
      && info.name === "dsh-agent-browser"
      && info.version === "0.3.0",
    JSON.stringify(res.result),
  );
}

/* 2. notifications/initialized 无响应 */
{
  const out = await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  check("notifications/initialized 不产生响应", out === null);
}

/* 3. tools/list */
{
  const res = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = res.result?.tools ?? [];
  check(
    "tools/list 返回 2 个工具且带 inputSchema",
    list.length === 2
      && list.every((tool) => typeof tool.name === "string" && tool.name && typeof tool.description === "string")
      && list.every((tool) => tool.inputSchema && tool.inputSchema.type === "object"),
    list.map((tool) => tool.name).join(","),
  );
}

/* 4. tools/call 成功 */
{
  const res = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "fake_echo", arguments: { text: "hi" } },
  });
  check(
    "tools/call 成功返回 text 内容",
    res.result?.content?.[0]?.type === "text"
      && res.result.content[0].text === "echo:hi"
      && res.result.isError !== true,
    JSON.stringify(res.result),
  );
}

/* 5. tools/call 抛错 → isError:true（仍是成功响应，不是 JSON-RPC error） */
{
  const res = await request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fake_boom", arguments: {} } });
  check(
    "tools/call 抛错转成 isError:true",
    !res.error
      && res.result?.isError === true
      && res.result.content?.[0]?.type === "text"
      && String(res.result.content[0].text).includes("boom"),
    JSON.stringify(res.result),
  );
}

/* 6. 未知工具 → -32602 tool not found，且不会调用 callTool */
{
  const before = calls.length;
  const res = await request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
  check(
    "未知工具 → -32602 tool not found",
    res.error?.code === -32602 && /not found/i.test(String(res.error.message)),
    JSON.stringify(res.error),
  );
  check("未知工具不会触发 callTool", calls.length === before);
}

/* 7. 未知方法 → -32601 */
{
  const res = await request({ jsonrpc: "2.0", id: 6, method: "resources/list" });
  check("未知方法 → -32601", res.error?.code === -32601 && /Method not found/.test(res.error.message), JSON.stringify(res.error));
}

/* 8. 坏 JSON → -32700 */
{
  const out = await server.handle("{这不是 JSON");
  const res = JSON.parse(out);
  check("坏 JSON → -32700", res.error?.code === -32700 && res.id === null, JSON.stringify(res));
}

/* 9. ping */
{
  const res = await request({ jsonrpc: "2.0", id: "p-1", method: "ping" });
  check(
    "ping 返回空结果并保留 id",
    res.jsonrpc === "2.0" && res.id === "p-1" && res.result && Object.keys(res.result).length === 0,
    JSON.stringify(res),
  );
}

/* 10. 请求缺 id → 按通知处理，无响应 */
{
  const out = await server.handle(JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }));
  check("缺省 id 的请求按通知处理（无响应）", out === null);
}

/* 11. 空行 / CRLF 容错 */
{
  const blank = await server.handle("");
  const crlf = await server.handle('{"jsonrpc":"2.0","id":9,"method":"ping"}\r\n');
  check("空行忽略、CRLF 容错", blank === null && JSON.parse(crlf).result !== undefined);
}

/* 12. tools/call 缺 name → -32602 */
{
  const res = await request({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { arguments: {} } });
  check("tools/call 缺 name → -32602", res.error?.code === -32602, JSON.stringify(res.error));
}

/* 13. tools/call 不带 arguments 时按 {} 处理 */
{
  const res = await request({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "fake_echo" } });
  check("tools/call 缺 arguments 时传 {}", res.result?.content?.[0]?.text === "echo:", JSON.stringify(res.result));
}

/* 14. close() 后不再响应，且可重复调用 */
{
  server.close();
  const out = await server.handle(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "ping" }));
  let twiceOk = true;
  try { server.close(); } catch { twiceOk = false; }
  check("close() 后 handle 返回 null 且可重复 close", out === null && twiceOk);
}

/* ---------------------------------- 汇总 ---------------------------------- */

const pass = results.filter((item) => item.ok).length;
const fail = results.length - pass;
console.log(`\nPASS ${pass}/${results.length}`);
if (fail > 0) {
  console.log(`FAIL ${fail} 项`);
  process.exitCode = 1;
}