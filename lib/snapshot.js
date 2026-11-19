// AX 树 + DOMSnapshot 混合快照：语义角色/名称/状态来自 Accessibility，几何与属性来自 DOMSnapshot。
// 支持 OOPIF（跨进程 iframe）：对每个 auto-attach 的子会话单独取快照，按 frame 树合并；ref 跨帧稳定。
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch",
  "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem",
  "gridcell", "columnheader", "rowheader",
]);
const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY", "OPTION", "DETAILS"]);
const INPUT_ROLE = { text: "textbox", email: "textbox", tel: "textbox", url: "textbox", search: "searchbox", number: "spinbutton", password: "textbox", checkbox: "checkbox", radio: "radio", range: "slider", color: "button", file: "button", submit: "button", reset: "button", image: "button", button: "button" };

// 默认敏感字段判定：即使调用方没传 policy（例如 MCP 出口、直接 new BrowserSession 的脚本），
// 也不能把密码/验证码的值回传出去。policy.isSensitiveField 可以在此基础上扩展。
const DEFAULT_SENSITIVE_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"];
const DEFAULT_SENSITIVE_NAME_RE = /pass|pwd|secret|token|otp|验证码|密码|口令/i;
function defaultIsSensitiveField(field) {
  if (!field || typeof field !== "object") return false;
  const type = typeof field.type === "string" ? field.type.trim().toLowerCase() : "";
  if (type === "password") return true;
  const autocomplete = typeof field.autocomplete === "string" ? field.autocomplete.toLowerCase() : "";
  if (autocomplete && DEFAULT_SENSITIVE_AUTOCOMPLETE.some((token) => autocomplete.includes(token))) return true;
  for (const key of ["name", "placeholder", "role"]) {
    if (typeof field[key] === "string" && DEFAULT_SENSITIVE_NAME_RE.test(field[key])) return true;
  }
  return false;
}

function decodeTable(snapshot) {
  const strings = snapshot?.strings ?? [];
  return (value) => {
    if (typeof value === "number" && strings[value] !== undefined) return strings[value];
    return value;
  };
}

function nodeAttributes(attrs, decode) {
  const out = {};
  if (!Array.isArray(attrs)) return out;
  for (let index = 0; index + 1 < attrs.length; index += 2) {
    const name = decode(attrs[index]);
    if (typeof name !== "string") continue;
    out[name] = decode(attrs[index + 1]);
  }
  return out;
}

function axState(axNode) {
  const props = {};
  for (const entry of axNode?.properties ?? []) {
    if (entry?.name) props[entry.name] = entry.value?.value;
  }
  return props;
}

function visible(rect) {
  return Array.isArray(rect) && rect.length === 4 && rect[2] > 2 && rect[3] > 2;
}

/** 收集主帧与 auto-attach 子会话的 frame 树，DFS 编号。 */
export async function collectFrames(client, mainSessionId, iframeSessions = null) {
  const frames = [];
  const children = new Map();
  const parentOf = new Map();
  const urlOf = new Map();
  const sessionOf = new Map();

  const walk = (frameTree, sessionId, parentFrameId) => {
    const frame = frameTree?.frame;
    if (!frame?.id) return;
    if (!urlOf.has(frame.id)) {
      urlOf.set(frame.id, frame.url ?? "");
      parentOf.set(frame.id, parentFrameId ?? null);
      sessionOf.set(frame.id, sessionId);
    }
    const kids = frameTree.childFrames ?? [];
    children.set(frame.id, kids.map((kid) => kid.frame?.id).filter(Boolean));
    for (const kid of kids) walk(kid, sessionId, frame.id);
  };

  let mainTree = null;
  try { mainTree = await client.send("Page.getFrameTree", {}, mainSessionId); } catch {}
  if (mainTree) walk(mainTree.frameTree, mainSessionId, null);

  for (const iframe of iframeSessions ?? client.iframeSessions()) {
    const sessionId = typeof iframe === "string" ? iframe : iframe.sessionId;
    if (sessionId === mainSessionId) continue;
    try {
      const tree = await client.send("Page.getFrameTree", {}, sessionId);
      const rootId = tree?.frameTree?.frame?.id;
      if (rootId) walk(tree.frameTree, sessionId, parentOf.get(rootId) ?? null);
    } catch {}
  }

  const seen = new Set();
  const visit = (frameId) => {
    if (!frameId || seen.has(frameId)) return;
    seen.add(frameId);
    frames.push({
      index: frames.length,
      frameId,
      parentFrameId: parentOf.get(frameId) ?? null,
      url: urlOf.get(frameId) ?? "",
      sessionId: sessionOf.get(frameId) ?? mainSessionId,
      ownerBackend: null,
      offsetX: 0,
      offsetY: 0,
    });
    for (const kid of children.get(frameId) ?? []) visit(kid);
  };
  visit(mainTree?.frameTree?.frame?.id);
  for (const frameId of urlOf.keys()) {
    if (seen.has(frameId)) continue;
    seen.add(frameId);
    frames.push({ index: frames.length, frameId, parentFrameId: parentOf.get(frameId) ?? null, url: urlOf.get(frameId) ?? "", sessionId: sessionOf.get(frameId) ?? mainSessionId, ownerBackend: null, offsetX: 0, offsetY: 0 });
  }
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  return { frames, frameById, mainFrameId: mainTree?.frameTree?.frame?.id ?? null };
}

async function captureSessionDocument(client, sessionId, framesInfo) {
  try { await client.send("Page.enable", {}, sessionId); } catch {}
  try { await client.send("DOM.enable", {}, sessionId); } catch {}
  try { await client.send("Accessibility.enable", {}, sessionId); } catch {}

  const [snapshotResult, axResult] = await Promise.all([
    client.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }, sessionId).catch(() => ({ documents: [], strings: [] })),
    client.send("Accessibility.getFullAXTree", {}, sessionId).catch(() => ({ nodes: [] })),
  ]);
  const snapshot = snapshotResult ?? { documents: [], strings: [] };
  const decode = decodeTable(snapshot);
  const axByBackend = new Map();
  for (const axNode of axResult?.nodes ?? []) {
    if (!axNode || axNode.ignored) continue;
    if (typeof axNode.backendDOMNodeId === "number") axByBackend.set(axNode.backendDOMNodeId, axNode);
  }

  const documents = [];
  for (const doc of snapshot.documents ?? []) {
    const frameId = decode(doc.frameId);
    const frame = framesInfo.frameById.get(frameId);
    const nodes = doc.nodes ?? {};
    const names = (nodes.nodeName ?? []).map(decode);
    const values = (nodes.nodeValue ?? []).map(decode);
    const backends = nodes.backendNodeId ?? [];
    const types = nodes.nodeType ?? [];
    const parentIndexes = nodes.parentIndex ?? [];
    const layoutByNode = new Map();
    if (doc.layout?.nodeIndex && doc.layout?.bounds) {
      for (let index = 0; index < doc.layout.nodeIndex.length; index += 1) {
        const nodeIndex = doc.layout.nodeIndex[index];
        const bounds = doc.layout.bounds[index];
        if (typeof nodeIndex === "number" && Array.isArray(bounds)) layoutByNode.set(nodeIndex, bounds);
      }
    }
    const textOfIndex = new Map();
    parentIndexes.forEach((parent, index) => {
      if (types[index] !== 3) return;
      if (typeof parent !== "number" || parent < 0) return;
      if (!textOfIndex.has(parent)) textOfIndex.set(parent, []);
      textOfIndex.get(parent).push(String(values[index] ?? ""));
    });

    for (let index = 0; index < names.length; index += 1) {
      const tag = names[index];
      if (typeof tag !== "string") continue;
      if (types[index] !== undefined && types[index] !== 1) continue;
      documents.push({
        frameId,
        frameIndex: frame?.index ?? 0,
        sessionId: frame?.sessionId ?? null,
        tag: tag.toUpperCase(),
        backend: typeof backends[index] === "number" ? backends[index] : null,
        attributes: nodeAttributes(nodes.attributes?.[index], decode),
        rect: layoutByNode.get(index) ?? null,
        text: (textOfIndex.get(index) ?? []).join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
      });
    }
  }
  return { documents, axByBackend, decode };
}

function computeOffsets(framesInfo, documents) {
  const byBackend = new Map();
  for (const doc of documents) {
    if (doc.backend !== null) byBackend.set(`${doc.frameId}:${doc.backend}`, doc);
  }
  const compute = (frame, guard = 0) => {
    if (!frame || guard > 16) return { x: 0, y: 0 };
    if (frame.offsetX || frame.offsetY) return { x: frame.offsetX, y: frame.offsetY };
    const parent = frame.parentFrameId ? framesInfo.frameById.get(frame.parentFrameId) : null;
    const parentOffset = parent ? compute(parent, guard + 1) : { x: 0, y: 0 };
    let relX = 0;
    let relY = 0;
    if (parent && frame.ownerBackend !== null) {
      const owner = byBackend.get(`${parent.frameId}:${frame.ownerBackend}`);
      if (owner?.rect) { relX = owner.rect[0]; relY = owner.rect[1]; }
    }
    frame.offsetX = parentOffset.x + relX;
    frame.offsetY = parentOffset.y + relY;
    return { x: frame.offsetX, y: frame.offsetY };
  };
  for (const frame of framesInfo.frames) compute(frame);
}

/** 采集整页快照（含 iframe）。 */
export async function collectSnapshot(client, mainSessionId, options = {}) {
  const { maxElements = 300, textLimit = 4000, redact = null, isSensitiveField = null, iframeSessions = null } = options;

  const framesInfo = await collectFrames(client, mainSessionId, iframeSessions);
  const sessions = new Set([mainSessionId, ...(iframeSessions ?? client.iframeSessions().map((session) => session.sessionId)).map((session) => (typeof session === "string" ? session : session.sessionId))]);
  const documents = [];
  const axBySession = new Map();
  for (const sessionId of sessions) {
    try {
      const captured = await captureSessionDocument(client, sessionId, framesInfo);
      for (const doc of captured.documents) documents.push({ ...doc, sessionId: doc.sessionId ?? sessionId });
      axBySession.set(sessionId, captured.axByBackend);
    } catch (error) {
      if (sessionId === mainSessionId) throw error;
    }
  }
  // iframe 的 owner 元素（父帧文档中的 IFRAME 节点）→ 用于把子帧坐标换算到主视口。
  for (const frame of framesInfo.frames) {
    if (!frame.parentFrameId) continue;
    const parent = framesInfo.frameById.get(frame.parentFrameId);
    if (!parent) continue;
    try {
      const result = await client.send("DOM.getFrameOwner", { frameId: frame.frameId }, parent.sessionId);
      if (result?.backendNodeId) frame.ownerBackend = result.backendNodeId;
    } catch {}
  }
  computeOffsets(framesInfo, documents);

  const viewport = await client.send("Runtime.evaluate", {
    expression: "({url: location.href, title: document.title, text: document.body ? document.body.innerText : '', width: innerWidth, height: innerHeight, dpr: devicePixelRatio})",
    returnByValue: true,
  }, mainSessionId).then((result) => result?.result?.value ?? {}).catch(() => ({}));

  const seen = new Set();
  const elements = [];
  for (const doc of documents) {
    const sessionId = doc.sessionId;
    const axNode = doc.backend !== null ? axBySession.get(sessionId)?.get(doc.backend) : undefined;
    const role = axNode?.role?.value;
    const tag = doc.tag;
    const inputType = String(doc.attributes.type ?? "text").toLowerCase();
    const interactive = (typeof role === "string" && INTERACTIVE_ROLES.has(role)) ||
      INTERACTIVE_TAGS.has(tag) ||
      String(doc.attributes.role ?? "").toLowerCase() === "button" ||
      doc.attributes.contenteditable === "true";
    if (!interactive || !visible(doc.rect)) continue;
    const key = `${sessionId}:${doc.backend}`;
    if (doc.backend !== null && seen.has(key)) continue;
    if (doc.backend !== null) seen.add(key);

    const frame = framesInfo.frameById.get(doc.frameId);
    const offsetX = frame?.offsetX ?? 0;
    const offsetY = frame?.offsetY ?? 0;
    const state = axState(axNode);
    const sensitive = Boolean((isSensitiveField ?? defaultIsSensitiveField)({ type: inputType, name: doc.attributes.name, autocomplete: doc.attributes.autocomplete, placeholder: doc.attributes.placeholder, role }));
    let value = axNode?.value?.value;
    if (value === undefined || value === null || value === "") value = doc.attributes.value;
    if (value !== undefined && sensitive) value = "[REDACTED]";
    const name = String(axNode?.name?.value ?? doc.attributes["aria-label"] ?? doc.attributes.alt ?? doc.attributes.title ?? doc.attributes.placeholder ?? doc.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    const ref = `f${doc.frameIndex}e${doc.backend ?? elements.length}`;
    const element = {
      ref,
      role: role ?? INPUT_ROLE[inputType] ?? (tag === "A" ? "link" : tag === "INPUT" || tag === "TEXTAREA" ? "textbox" : tag === "SELECT" ? "combobox" : "button"),
      name,
      value: value === undefined || value === null || value === "" ? undefined : String(value).slice(0, 200),
      href: doc.attributes.href,
      frameIndex: doc.frameIndex,
      frameId: doc.frameId,
      sessionId,
      backendNodeId: doc.backend,
      rect: [Math.round(doc.rect[0] + offsetX), Math.round(doc.rect[1] + offsetY), Math.round(doc.rect[2]), Math.round(doc.rect[3])],
      disabled: Boolean(state.disabled) || doc.attributes.disabled !== undefined,
      checked: typeof state.checked === "boolean" ? state.checked : doc.attributes.checked !== undefined ? true : undefined,
      expanded: typeof state.expanded === "boolean" ? state.expanded : undefined,
      required: Boolean(state.required) || doc.attributes.required !== undefined,
      readonly: Boolean(state.readonly) || doc.attributes.readonly !== undefined,
      inputType: tag === "INPUT" ? inputType : undefined,
      sensitive,
    };
    elements.push(element);
  }

  elements.sort((a, b) => (a.frameIndex - b.frameIndex) || (a.rect[1] - b.rect[1]) || (a.rect[0] - b.rect[0]));
  const truncated = elements.length > maxElements;
  const limited = (truncated ? elements.slice(0, maxElements) : elements).map((element) => {
    const { backendNodeId, sessionId, frameId, ...rest } = element;
    return rest;
  });
  const refs = new Map();
  for (const element of truncated ? elements.slice(0, maxElements) : elements) {
    refs.set(element.ref, {
      ref: element.ref,
      sessionId: element.sessionId,
      backendNodeId: element.backendNodeId,
      frameId: element.frameId,
      frameIndex: element.frameIndex,
      role: element.role,
      name: element.name,
    });
  }

  let text = String(viewport.text ?? "");
  if (redact) {
    // 兼容两种 redact 契约：返回字符串（policy.redact(...).text 包装）或返回 {text} 对象。
    const redacted = redact(text);
    text = typeof redacted === "string" ? redacted : String(redacted?.text ?? text);
  }
  text = text.slice(0, textLimit);

  return {
    url: viewport.url ?? "",
    title: viewport.title ?? "",
    viewport: { width: viewport.width ?? 0, height: viewport.height ?? 0, dpr: viewport.dpr ?? 1 },
    text,
    elements: limited,
    frameCount: framesInfo.frames.length,
    frames: framesInfo.frames.map((frame) => ({ index: frame.index, frameId: frame.frameId, url: frame.url, parentFrameId: frame.parentFrameId })),
    truncated,
    refs,
    collectedAt: Date.now(),
    ...(elements.length === 0 ? { warning: "no-interactive-elements" } : {}),
  };
}

/** STALE_REF 自愈：按 (role, name, frameIndex) 在最近一次快照里重新找元素。 */
export function findRefBySignature(snapshot, signature) {
  if (!snapshot || !signature) return null;
  const candidates = snapshot.elements.filter((element) => {
    if (signature.role && element.role !== signature.role) return false;
    if (typeof signature.frameIndex === "number" && element.frameIndex !== signature.frameIndex) return false;
    if (signature.name && element.name !== signature.name) return false;
    return true;
  });
  return candidates[0] ?? null;
}

export function describeRef(snapshot, ref) {
  return snapshot?.elements?.find((element) => element.ref === ref) ?? null;
}

export const __test = { decodeTable, nodeAttributes, axState };