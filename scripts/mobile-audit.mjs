#!/usr/bin/env node
/**
 * 移动端验收探针。
 *
 * 为什么要有这个脚本：样式改动没有单元测试能兜住 —— 出问题的方式是「某些宽度下
 * 内容被裁掉了」，而这只有真渲染出来量一次才知道。所以这里用 CDP 起一个真实
 * Chromium，注入 Tauri invoke 的 mock（否则界面停在「正在载入目录…」的空态，
 * 表格和数据相关的布局根本不会被渲染），然后在 9 个宽度上量几何、点交互、截图。
 *
 * 用法：
 *   pnpm dev            # 另开一个终端把 dev server 跑在 1420
 *   node scripts/mobile-audit.mjs
 *
 * 退出码非 0 表示有断言失败。截图与 JSON 报告默认写到 /tmp/asim-audit/。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHROME = process.env.CHROME_PATH
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_URL = process.env.AUDIT_URL || "http://localhost:1420/";
const OUT_DIR = process.env.AUDIT_OUT || "/tmp/asim-audit";
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT || 9444);

/** 手机竖屏、平板、桌面窗口。mobile 决定是否走移动端 viewport 语义 + (hover: none)。 */
const VIEWPORTS = [
  { name: "320", w: 320, h: 568, mobile: true },
  { name: "375", w: 375, h: 667, mobile: true },
  { name: "390", w: 390, h: 844, mobile: true },
  { name: "430", w: 430, h: 932, mobile: true },
  { name: "640", w: 640, h: 900, mobile: true },
  { name: "768", w: 768, h: 1024, mobile: true },
  { name: "900", w: 900, h: 700, mobile: false },
  { name: "1080", w: 1080, h: 820, mobile: false },
  { name: "1440", w: 1440, h: 900, mobile: false },
];

/**
 * Tauri invoke 的 mock。
 *
 * set_targets 必须真的按传入的 targets 生成快照：添加/删除监控的交互测试要依赖
 * 它 —— 返回 null 会让 store 把 rows 置成 null 然后渲染直接崩掉。
 */
const MOCK = String.raw`
(() => {
  const stores = [
    { number: "R479", name: "南京东路", title: "Apple 南京东路" },
    { number: "R581", name: "浦东", title: "Apple 浦东" },
    { number: "R683", name: "环球港", title: "Apple 环球港" },
    // 第 4 家故意没有对应的快照行：添加监控的交互测试拿它组成新组合，
    // 否则 12 条 mock 正好覆盖 3 门店 × 4 型号，按钮会直接变成「已在列表中」。
    { number: "R700", name: "三里屯", title: "Apple 三里屯" },
  ];
  const products = [
    { partNumber: "MGDM4CH/A", category: "iphone", family: "iPhone 17 Pro Max", capacity: "256GB", color: "深蓝色", title: "iPhone 17 Pro Max 256GB 深蓝色" },
    { partNumber: "MGDR4CH/A", category: "iphone", family: "iPhone 17 Pro", capacity: "512GB", color: "星宇橙色", title: "iPhone 17 Pro 512GB 星宇橙色" },
    { partNumber: "MGDT4CH/A", category: "iphone", family: "iPhone Air", capacity: "1TB", color: "天蓝色", title: "iPhone Air 1TB 天蓝色" },
    { partNumber: "MXF14CH/A", category: "mac", family: "MacBook Pro 14", capacity: "1TB", color: "深空黑色", title: "MacBook Pro 14 英寸 M5 Pro 1TB 深空黑色" },
  ];
  const availabilities = [
    { kind: "in_stock" },
    { kind: "out_of_stock" },
    { kind: "unknown", reason: "rate_limited" },
    { kind: "unknown", reason: "no_pickup_data", store_number: "R479" },
  ];
  let rows = [];
  // 数据行只取前 3 家：门店数与型号数相同的话，两个同步取模会让 12 条退化成
  // 4 个唯一组合 —— 重复 key 会让 React 更新时 DOM 累积（实测 13 条数据渲染出 19 行）。
  const dataStores = stores.slice(0, 3);
  for (let i = 0; i < 12; i += 1) {
    const store = dataStores[i % dataStores.length];
    const product = products[i % products.length];
    rows.push({
      target: { locale: "zh_CN", storeNumber: store.number, storeTitle: store.title, partNumber: product.partNumber, productName: product.title },
      availability: availabilities[i % availabilities.length],
      pickupDetails: i % 3 === 0 ? { pickupDisplay: "今天", pickupQuote: "今天可取", saleReason: null, saleMessage: null } : undefined,
      lastCheckedMs: Date.now() - i * 3000,
      consecutiveFailures: i % 4,
    });
  }
  const settings = { locale: "zh_CN", targets: [], intervalSeconds: 30, barkUrl: "https://api.day.app/verylongkeyxxxxxxxxxxxxxxxxxxxxxx", soundEnabled: true, openOnHit: "bag" };
  const responses = {
    list_regions: [{ title: "中国大陆", locale: "zh_CN" }, { title: "中国香港", locale: "zh_HK" }],
    list_categories: [{ value: "iphone", title: "iPhone" }, { value: "ipad", title: "iPad" }, { value: "mac", title: "Mac" }, { value: "watch", title: "Apple Watch" }],
    get_settings: settings,
    is_running: false,
    list_stores: stores,
    list_products: products,
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) {
      const id = Math.floor(Math.random() * 1e9);
      window["_" + id] = cb;
      return id;
    },
    async invoke(cmd, args) {
      if (!window.__invokeLog) window.__invokeLog = [];
      window.__invokeLog.push({ cmd, n: args && args.targets ? args.targets.length : null, at: Date.now() });
      if (cmd === "set_targets") {
        const targets = (args && args.targets) || [];
        const previous = new Map(rows.map((r) => [r.target.locale + "|" + r.target.storeNumber + "|" + r.target.partNumber, r]));
        rows = targets.map((t) => previous.get(t.locale + "|" + t.storeNumber + "|" + t.partNumber)
          || { target: t, availability: { kind: "out_of_stock" }, lastCheckedMs: Date.now(), consecutiveFailures: 0 });
        return JSON.parse(JSON.stringify(rows));
      }
      if (cmd === "get_snapshot") return JSON.parse(JSON.stringify(rows));
      if (cmd in responses) return JSON.parse(JSON.stringify(responses[cmd]));
      if (cmd.startsWith("plugin:event|")) return 1;
      if (cmd === "plugin:updater|check") return null;
      return null;
    },
    convertFileSrc: (p) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
})();
`;

/** 在页面里跑的几何探针：所有断言都基于它返回的原始值，不在页面里做判定。 */
const PROBE = `(() => {
  const de = document.documentElement;
  const vw = window.innerWidth;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // 表格容器内部的元素由 overflow:auto 自己管理，横向能滑到就不算「内容丢失」；
    // 文档级溢出另有 scrollWidth 断言把守。
    if (el.closest('[data-slot="table-container"]')) continue;
    if (r.right > vw + 1 || r.left < -1) {
      let d = 0, p = el;
      while (p.parentElement) { d += 1; p = p.parentElement; }
      clipped.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 80), l: Math.round(r.left), r: Math.round(r.right), depth: d });
    }
  }
  clipped.sort((a, b) => a.depth - b.depth);

  const h1 = document.querySelector("h1");
  const formGrid = document.querySelector('section[aria-labelledby="create-monitor-title"] .grid');
  const metricGrid = document.querySelector('[aria-label="监控概览"]');
  const tbody = document.querySelector("tbody");
  const firstRow = tbody ? (tbody.querySelector("tr:not([data-empty])") || tbody.querySelector("tr")) : null;
  const thead = document.querySelector("thead");
  const container = document.querySelector('[data-slot="table-container"]');
  const del = document.querySelector('button[aria-label="删除这条监控"]');
  const productLink = document.querySelector('tbody button[aria-label^="打开商品页"]');

  const smallTargets = [];
  for (const el of document.querySelectorAll('button, [role="combobox"], [role="switch"], a')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // 命中区看最近的可点祖先（排除自身）：Switch 视觉尺寸只有 18×32，但它所在的整行 label 才是真正落点。
    const holder = el.parentElement ? el.parentElement.closest("label, button, a") : null;
    const hit = (holder || el).getBoundingClientRect();
    if (hit.width < 44 && hit.height < 44) smallTargets.push({ label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 16), w: Math.round(r.width), h: Math.round(r.height), hitW: Math.round(hit.width), hitH: Math.round(hit.height) });
  }

  const popovers = [...document.querySelectorAll('[data-slot="popover-content"]')].map((el) => ({
    rect: rect(el),
    itemHeights: [...el.querySelectorAll("[cmdk-item], fieldset label")].slice(0, 3).map((i) => Math.round(i.getBoundingClientRect().height)),
  }));

  return {
    innerWidth: vw,
    scrollWidth: de.scrollWidth,
    scrollHeight: de.scrollHeight,
    hasOverflowX: de.scrollWidth > vw + 1,
    clippedCount: clipped.length,
    clippedTop: clipped.slice(0, 8),
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    h1: h1 ? { text: h1.textContent.trim(), clientWidth: h1.clientWidth, scrollWidth: h1.scrollWidth } : null,
    formGridCols: formGrid ? getComputedStyle(formGrid).gridTemplateColumns : null,
    metricGridCols: metricGrid ? getComputedStyle(metricGrid).gridTemplateColumns : null,
    rowDisplay: firstRow ? getComputedStyle(firstRow).display : null,
    rowCount: document.querySelectorAll("tbody tr").length,
    tbodyCount: document.querySelectorAll("tbody").length,
    tableCount: document.querySelectorAll("table").length,
    widthChain: (() => {
      const w = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().width) : null; };
      return {
        container: w('[data-slot="table-container"]'), table: w("table"), tbody: w("tbody"),
        tr: w("tbody tr"), td: w("tbody td"), panel: w('[aria-labelledby="monitor-list-title"]'),
      };
    })(),
    theadDisplay: thead ? getComputedStyle(thead).display : null,
    container: container ? {
      clientW: container.clientWidth, scrollW: container.scrollWidth,
      clientH: container.clientHeight, scrollH: container.scrollHeight,
      overflowX: getComputedStyle(container).overflowX, overflowY: getComputedStyle(container).overflowY,
    } : null,
    headerRect: document.querySelector("header") ? rect(document.querySelector("header")) : null,
    smallTargetCount: smallTargets.length,
    smallTargets: smallTargets.slice(0, 8),
    deleteButtonOpacity: del ? getComputedStyle(del).opacity : null,
    productLinkDecoration: productLink ? getComputedStyle(productLink).textDecorationLine : null,
    statusDetailVisible: !!document.querySelector('tbody [class~="sm:hidden"]'),
    containerOverflow: (() => {
      const c = document.querySelector('[data-slot="table-container"]');
      if (!c) return null;
      const cr = c.getBoundingClientRect();
      const out = [];
      for (const el of c.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > cr.right + 1) out.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 60), r: Math.round(r.right), w: Math.round(r.width), sw: el.scrollWidth, cw: el.clientWidth });
      }
      return { containerRight: Math.round(cr.right), count: out.length, top: out.slice(0, 6) };
    })(),
    invokeLog: (window.__invokeLog || []).slice(-12),
    hoverMediaMatches: matchMedia("(hover: hover)").matches,
    popovers,
  };
})()`;

const delays = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = delays;

// ---------- CDP ----------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) {
      throw new Error("evaluate failed: " + JSON.stringify(res.result.exceptionDetails).slice(0, 300));
    }
    return res.result?.result?.value;
  }
  async shot(file) {
    const res = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    if (res.result?.data) fs.writeFileSync(file, Buffer.from(res.result.data, "base64"));
  }
}

async function waitForCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error("Chrome DevTools 端口未就绪：" + port);
}

// ---------- 断言 ----------

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

async function measure(cdp, vp) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: vp.mobile,
    screenWidth: vp.w, screenHeight: vp.h,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile, maxTouchPoints: 5 }).catch(() => {});
  await cdp.send("Page.navigate", { url: PAGE_URL });
  await sleep(1200);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: vp.mobile,
    screenWidth: vp.w, screenHeight: vp.h,
  });
  await cdp.send("Page.reload", {});
  await sleep(2500);
  return cdp.eval(PROBE);
}

/** 打开一个下拉并测量弹出层；返回 false 表示没能打开。 */
async function openPopover(cdp, selector, index = 0) {
  const opened = await cdp.eval(`(() => {
    const list = document.querySelectorAll(${JSON.stringify(selector)});
    const btn = list[${index}];
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!opened) return false;
  await sleep(600);
  return true;
}

/** 四个下拉的定位器。地区/品类是单选 Combobox（无 aria-label，只有 role），门店/型号带 aria-label。 */
const TRIGGERS = [
  ["地区", 'button[role="combobox"]', 0],
  ["品类", 'button[role="combobox"]', 1],
  ["门店", 'button[aria-label^="选择自提门店"]', 0],
  ["型号", 'button[aria-label^="选择型号"]', 0],
];

async function run() {
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", `--user-data-dir=${path.join(OUT_DIR, "chrome-profile")}`,
    `--remote-debugging-port=${CDP_PORT}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  const report = { generatedAt: new Date().toISOString(), page: PAGE_URL, viewports: [], interactions: [], checks };
  try {
    const wsUrl = await waitForCdp(CDP_PORT);
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    cdp = new Cdp(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });

    // ---- 1. 多视口几何 ----
    for (const vp of VIEWPORTS) {
      const m = await measure(cdp, vp);
      report.viewports.push({ name: vp.name, mobile: vp.mobile, ...m });
      await cdp.shot(path.join(OUT_DIR, `vp-${vp.name}.png`));

      const tag = `[${vp.name}px]`;
      check(`${tag} 无横向溢出`, !m.hasOverflowX, `scrollWidth=${m.scrollWidth} innerWidth=${m.innerWidth}`);
      check(`${tag} 无越界元素`, m.clippedCount === 0, `越界 ${m.clippedCount} 个: ${JSON.stringify(m.clippedTop.slice(0, 3))}`);
      check(`${tag} 界面已载入数据`, m.rowCount > 0, `tbody 行数 ${m.rowCount}`);

      if (vp.w < 768) {
        check(`${tag} 列表为卡片`, m.rowDisplay === "flex", `tr display=${m.rowDisplay}`);
        check(`${tag} 表头隐藏`, m.theadDisplay === "none", `thead display=${m.theadDisplay}`);
        // 表单列数与触控尺寸的分界是 640（手机 vs 平板/桌面），列表卡片的分界才是 768。
        check(`${tag} 表单列数符合断点`, (m.formGridCols || "").split(" ").length === (vp.w < 640 ? 1 : 2), `cols=${m.formGridCols}`);
        check(`${tag} 指标卡列数符合断点`, (m.metricGridCols || "").split(" ").length === (vp.w < 640 ? 2 : 4), `cols=${m.metricGridCols}`);
        check(`${tag} 标题不被截断`, m.h1 && m.h1.scrollWidth <= m.h1.clientWidth + 1, JSON.stringify(m.h1));
        if (vp.w < 640) {
          check(`${tag} 触控目标无小于 44x44`, m.smallTargetCount === 0, `${m.smallTargetCount} 个: ${JSON.stringify(m.smallTargets.slice(0, 4))}`);
        }
        check(`${tag} 删除按钮常显`, m.deleteButtonOpacity === "1", `opacity=${m.deleteButtonOpacity}`);
        check(`${tag} 触屏媒体生效`, m.hoverMediaMatches === false, `(hover:hover)=${m.hoverMediaMatches}`);
        check(`${tag} 卡片内容不溢出容器`, (m.containerOverflow?.count ?? 0) === 0, JSON.stringify(m.containerOverflow).slice(0, 200));
      } else {
        check(`${tag} 列表为表格`, m.rowDisplay === "table-row", `tr display=${m.rowDisplay}`);
        check(`${tag} 表头可见`, m.theadDisplay === "table-header-group", `thead display=${m.theadDisplay}`);
        check(`${tag} 表格无需横向滚动`, m.container != null && m.container.scrollW <= m.container.clientW + 1, JSON.stringify(m.container));
      }
      if (vp.w >= 900) {
        check(`${tag} 桌面窗宽下 main 不超 1180`, (m.headerRect?.w ?? 0) <= 1180, `header w=${m.headerRect?.w}`);
      }
    }

    // ---- 2. 窄屏交互：四个下拉 + 弹出层边界 + 触控行高 ----
    for (const w of [320, 390]) {
      const vp = VIEWPORTS.find((v) => v.w === w);
      await measure(cdp, vp);
      for (const [label, selector, index] of TRIGGERS) {
        const ok = await openPopover(cdp, selector, index);
        if (!ok) { check(`[${w}px] ${label} 可打开`, false, "找不到触发器"); continue; }
        const m = await cdp.eval(PROBE);
        const pop = m.popovers[0];
        check(`[${w}px] ${label} 弹出层在视口内`, !!pop && pop.rect.l >= -1 && pop.rect.r <= m.innerWidth + 1, JSON.stringify(pop?.rect));
        check(`[${w}px] ${label} 选项行高 ≥44`, !!pop && pop.itemHeights.length > 0 && pop.itemHeights.every((h) => h >= 43), JSON.stringify(pop?.itemHeights));
        report.interactions.push({ viewport: w, action: `open:${label}`, popover: pop });
        await cdp.shot(path.join(OUT_DIR, `popover-${w}-${label}.png`));
        await cdp.eval(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
        await cdp.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
        await sleep(400);
      }
    }

    // ---- 3. 390px 完整操作路径：选门店+型号 → 添加 → 删除 ----
    const vp390 = VIEWPORTS.find((v) => v.w === 390);
    await measure(cdp, vp390);
    const before = (await cdp.eval(PROBE)).rowCount;    await openPopover(cdp, 'button[aria-label^="选择自提门店"]');
    // 门店选最后一个（R700 三里屯，mock 里它没有快照行），保证和型号组成新组合。
    await cdp.eval(`(() => { const ls = document.querySelectorAll('[data-slot="popover-content"] fieldset label'); const l = ls[ls.length - 1]; if (l) l.click(); })()`);
    await sleep(400);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(300);
    await openPopover(cdp, 'button[aria-label^="选择型号"]');
    await cdp.eval(`(() => { const l = document.querySelector('[data-slot="popover-content"] fieldset label'); if (l) l.click(); })()`);
    await sleep(400);
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(300);
    const added = await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("添加"));
      if (!btn) return "no-button";
      if (btn.disabled) return "disabled";
      btn.click();
      await new Promise((r) => setTimeout(r, 1000));
      return "clicked";
    })()`);
    const afterAdd = await cdp.eval(PROBE);
    check("[390px] 添加监控后列表新增", afterAdd.rowCount > before, `before=${before} after=${afterAdd.rowCount} (${added})`);
    report.interactions.push({ viewport: 390, action: "add-monitor", before, after: afterAdd.rowCount });

    const removed = await cdp.eval(`(async () => {
      const btn = document.querySelector('button[aria-label="删除这条监控"]');
      if (!btn) return "no-button";
      btn.click();
      await new Promise((r) => setTimeout(r, 900));
      return "clicked";
    })()`);
    const afterRemove = await cdp.eval(PROBE);
    check("[390px] 删除监控后列表减少", afterRemove.rowCount < afterAdd.rowCount, `after=${afterRemove.rowCount} (${removed})`);
    report.interactions.push({ viewport: 390, action: "remove-monitor", after: afterRemove.rowCount });

    // ---- 4. 桌面 sticky 表头（改造前是失效的） ----
    const vp1080 = VIEWPORTS.find((v) => v.w === 1080);
    await measure(cdp, vp1080);
    const sticky = await cdp.eval(`(() => {
      const c = document.querySelector('[data-slot="table-container"]');
      if (!c) return { ok: false, reason: "no container" };
      c.scrollTop = 200;
      const th = document.querySelector("thead th");
      const cr = c.getBoundingClientRect();
      const tr = th.getBoundingClientRect();
      return { ok: Math.abs(tr.top - cr.top) < 6, containerTop: Math.round(cr.top), thTop: Math.round(tr.top), scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight };
    })()`);
    check("[1080px] sticky 表头生效", sticky.ok === true, JSON.stringify(sticky));
    report.interactions.push({ viewport: 1080, action: "sticky-header", result: sticky });
    await cdp.shot(path.join(OUT_DIR, "desktop-1080-scrolled.png"));

    // ---- 5. 控制台错误 ----
    const errors = await cdp.eval(`window.__auditErrors || []`);
    check("页面无未捕获错误", !errors || errors.length === 0, JSON.stringify(errors));

    fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    chrome.kill("SIGKILL");
  }

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n检查项：${passed}/${checks.length} 通过`);
  if (failures.length > 0) {
    console.log("\n失败项：");
    for (const f of failures) console.log("  ✗ " + f);
  }
  console.log(`\n报告：${path.join(OUT_DIR, "report.json")}`);
  console.log(`截图：${OUT_DIR}/vp-*.png, popover-*.png`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}

run().catch((err) => {
  console.error("探针执行失败：", err);
  process.exitCode = 2;
});
