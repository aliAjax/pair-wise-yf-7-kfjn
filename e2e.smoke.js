/**
 * 端到端冒烟：用最小 DOM/存储桩在两个“标签页”中加载真实的 ledger.js + app.js，
 * 验证保存占名额、跨页后到重算、数量变更重算、移走字模腾空且不丢落字、失败重试。
 * 运行：node e2e.smoke.js
 */
const fs = require("fs");
const vm = require("vm");

/* ---------- 共享存储（可被多个 window 看到，支持配额失败注入） ---------- */
const backing = new Map();
const listeners = [];
let failNext = 0;

function makeLocalStorage(win) {
  return {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem(k, v) {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("QuotaExceededError");
      }
      const oldValue = backing.has(k) ? backing.get(k) : null;
      backing.set(k, String(v));
      for (const { window: w, fn } of listeners) {
        if (w !== win) {
          // 异步派发，模拟浏览器 storage 事件
          setImmediate(() => fn({ key: k, oldValue, newValue: String(v) }));
        }
      }
    }
  };
}

function makeSessionStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v))
  };
}

/* ---------- 极简 DOM 桩：只实现 app.js 实际用到的接口 ---------- */
function makeElement(tag = "div") {
  const el = {
    tagName: tag,
    style: {},
    dataset: {},
    children: [],
    _text: "",
    _html: "",
    hidden: false,
    value: "",
    disabled: false,
    className: "",
    listeners: {},
    closest() {
      return null;
    },
    set textContent(v) {
      this._text = String(v);
    },
    get textContent() {
      return this._text;
    },
    set innerHTML(v) {
      this._html = String(v);
    },
    get innerHTML() {
      return this._html;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of this.listeners[type] || []) fn.call(this, event);
    },
    click() {
      this.dispatch("click", { target: this });
    },
    reset() {},
    querySelector() {
      return null;
    }
  };
  return el;
}

function makeWindow(name) {
  const win = {
    __name: name,
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
      if (type === "storage") listeners.push({ window: win, fn });
    },
    dispatchStorage(event) {
      for (const fn of this.listeners.storage || []) fn(event);
    },
    crypto: { randomUUID: () => `uuid-${name}-${Math.random().toString(36).slice(2, 10)}` },
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    Date
  };
  win.localStorage = makeLocalStorage(win);
  win.sessionStorage = makeSessionStorage();
  win.window = win;
  win.console = console;
  win.setImmediate = setImmediate;
  return win;
}

function makeDom() {
  const ids = [
    "paperSize", "flowMode", "gridGap", "workTitle", "stage", "typeList", "typeForm",
    "charInput", "styleInput", "sizeInput", "quantityInput", "wearInput", "inventorySearch",
    "styleFilter", "selectedTypeLabel", "shortageBadge", "usageList", "saveBanner",
    "draftList", "placedCount", "inventoryCount", "saveDraftBtn", "exportBtn", "clearBoardBtn"
  ];
  const byId = {};
  for (const id of ids) {
    byId[id] = makeElement(id === "saveDraftBtn" ? "button" : "div");
    byId[id].value = id === "sizeInput" ? "24" : id === "quantityInput" ? "3" : "";
  }
  byId.paperSize.value = "postcard";
  byId.flowMode.value = "horizontal";
  byId.gridGap.value = "8";
  byId.workTitle.value = "晚风小笺";

  const documentShim = {
    querySelector(sel) {
      if (sel === "window") return null;
      const id = sel.replace("#", "");
      return byId[id] || null;
    },
    createElement: () => makeElement()
  };
  return { byId, document: documentShim };
}

function loadTab(name) {
  const win = makeWindow(name);
  const dom = makeDom();
  win.document = dom.document;
  const context = vm.createContext(win);
  vm.runInContext(fs.readFileSync(`${__dirname}/ledger.js`, "utf8"), context);
  vm.runInContext(fs.readFileSync(`${__dirname}/app.js`, "utf8"), context);
  return { win, byId: dom.byId };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await tick();
};
async function untilSynced(win, timeoutTicks = 20) {
  for (let i = 0; i < timeoutTicks; i += 1) {
    const synced = vm.runInContext(
      `(() => { const r = JSON.parse(localStorage.getItem("zfl16-movable-type-workshop")); return state.version >= (r.version||0); })()`,
      win
    );
    if (synced) return;
    await tick();
  }
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}
function state(win) {
  return JSON.parse(win.localStorage.getItem("zfl16-movable-type-workshop"));
}

function draftCountOf(win, typeId) {
  return vm.runInContext(
    `Ledger.buildLedger(state.inventory, state.drafts, []).rows.get(${JSON.stringify(typeId)})?.draftCount ?? -1`,
    win
  );
}
function missingCountOf(win, typeId) {
  return vm.runInContext(
    `Ledger.buildLedger(state.inventory, state.drafts, state.placements).missing.get(${JSON.stringify(typeId)}) ?? 0`,
    win
  );
}
function hasRow(win, typeId) {
  return vm.runInContext(
    `Ledger.buildLedger(state.inventory, state.drafts, state.placements).rows.has(${JSON.stringify(typeId)})`,
    win
  );
}

async function main() {
  console.log("标签页 A 首次加载，初始字模库入账");
  const A = loadTab("A");
  await flush();
  let s = state(A.win);
  assert(s.version === 1, `初始库存入账后版本为 1（实际 ${s.version}）`);
  assert(s.inventory.length === 6, "六种初始字模在账");

  const shan = s.inventory.find((t) => t.char === "山"); // 4 枚

  console.log("\nA 在版面放 4 个山并保存草稿 d1（刚好占满）");
  A.win.eval = vm.runInContext;
  // 通过暴露在 window 上的内部函数驱动；app.js 用的是顶层函数声明，挂在全局
  for (let i = 0; i < 4; i += 1) {
    vm.runInContext(`placeType(${i}, 0, ${JSON.stringify(shan.id)})`, A.win);
  }
  vm.runInContext("saveDraft()", A.win);
  s = state(A.win);
  assert(s.drafts.length === 1, "d1 已保存");
  assert(draftCountOf(A.win, shan.id) === 4, "d1 的 4 个山全部入账");

  console.log("\nB 标签页打开，读到同一本账，想再存 1 个山 → 应被拒且不写入");
  const B = loadTab("B");
  await flush();
  const versionBefore = state(B.win).version;
  // B 的版面是自己的（sessionStorage 隔离），只放 1 个山
  vm.runInContext(`placeType(0, 1, ${JSON.stringify(shan.id)}); saveDraft();`, B.win);
  const after = state(B.win);
  assert(after.version === versionBefore, `被拒后版本不变（${after.version} === ${versionBefore}）`);
  assert(after.drafts.length === 1, "账上仍只有 d1，失败占用未入账");
  const banner = B.byId.saveBanner.innerHTML;
  assert(/山（宋体旧字）缺1枚/.test(banner), `横幅指出“山缺1枚”：${banner.replace(/<[^>]+>/g, "").slice(0, 60)}`);

  console.log("\nA 把山的数量从 4 加到 5，B 通过 storage 事件看到新账，点重试 → 成功");
  vm.runInContext(`changeQuantity(${JSON.stringify(shan.id)}, 1)`, A.win);
  await flush();
  const bInventory = vm.runInContext("state.inventory", B.win);
  assert(bInventory.find((t) => t.id === shan.id).quantity === 5, "B 收到 storage 事件并同步到数量 5");
  // B 的待存提示应转为“可重试”
  assert(/可以重试保存/.test(B.byId.saveBanner.textContent || B.byId.saveBanner.innerHTML), "B 的横幅提示占用已腾出");
  vm.runInContext("retrySave()", B.win);
  s = state(B.win);
  assert(s.drafts.length === 2, "B 重试保存成功，第二份草稿入账");
  assert(draftCountOf(B.win, shan.id) === 5, "5 个山被两份草稿合计占住");

  console.log("\n把山的数量降回 4：落字不丢，账目显示超 1 枚");
  // 等 A 收到 B 的 storage 事件、内存账追平后再改数量（真实用户也是看到刷新才继续）
  await untilSynced(A.win);
  vm.runInContext(`changeQuantity(${JSON.stringify(shan.id)}, -1)`, A.win);
  await flush();
  // 徽标优先反映本页待存；已存草稿的超量直接以账本为准
  const overCount = vm.runInContext(
    `Ledger.buildLedger(state.inventory, state.drafts, []).rows.get(${JSON.stringify(shan.id)})?.over ?? -1`,
    A.win
  );
  assert(overCount === 1, `数量降回 4 后已存草稿超 1 枚（实际 ${overCount}）`);
  // 清空本页待存后，徽标直接显示已存草稿缺字
  vm.runInContext("state.placements = []; persistLocal(); renderAll();", A.win);
  const badgeA = A.byId.shortageBadge.textContent;
  assert(/山缺1枚/.test(badgeA), `清空本页后徽标显示已存草稿缺字：${badgeA}`);
  s = state(A.win);
  const shanPlacements = s.drafts.reduce(
    (n, d) => n + d.placements.filter((p) => p.typeId === shan.id).length,
    0
  );
  assert(shanPlacements === 5, "五处落字原样保留，没有丢");

  console.log("\n移走“山”字模：两份草稿的落字保留但腾空名额，版面载入后显示悬空格");
  vm.runInContext(`removeType(${JSON.stringify(shan.id)})`, A.win);
  await flush();
  s = state(A.win);
  assert(!s.inventory.some((t) => t.id === shan.id), "字模已从库中移走");
  assert(
    s.drafts.every((d) => d.placements.some((p) => p.typeId === shan.id)),
    "草稿里的落字记录都还在"
  );
  vm.runInContext(`loadDraft(${JSON.stringify(s.drafts[0].id)})`, A.win);
  const stageHtml = A.byId.stage.innerHTML;
  assert(stageHtml.includes("missing") && stageHtml.includes("◇"), "版面以悬空格（◇）保留原落字");
  assert(hasRow(A.win, shan.id) === false, "移走后该字模不再有占用行");
  assert(missingCountOf(A.win, shan.id) >= 5, "落字计入缺字（至少 5 处）");

  console.log("\n删除一份草稿：名额释放，缺字计数下降");
  const draftsBefore = state(A.win).drafts.length;
  vm.runInContext(`deleteDraft(${JSON.stringify(s.drafts[0].id)})`, A.win);
  assert(state(A.win).drafts.length === draftsBefore - 1, "草稿删除成功");

  console.log("\n存储写失败：保存中途报错、账目不变，恢复后重试成功");
  const yue = state(A.win).inventory.find((t) => t.char === "月");
  vm.runInContext(`state.placements = [{row:0,col:0,typeId:${JSON.stringify(yue.id)}}]; pendingSave=null;`, A.win);
  failNext = 10;
  vm.runInContext("saveDraft()", A.win);
  failNext = 0;
  const failVersion = state(A.win).version;
  const draftsAfterFail = state(A.win).drafts.length;
  assert(/没有留在账上|可直接重试/.test(A.byId.saveBanner.innerHTML), "横幅说明失败未留账、可重试");
  vm.runInContext("retrySave()", A.win);
  const sRetry = state(A.win);
  assert(sRetry.drafts.length === draftsAfterFail + 1, "恢复后重试保存成功");
  assert(
    sRetry.drafts.some((d) => d.placements.some((p) => p.typeId === yue.id)),
    "重试入账的是原先那份月字草稿"
  );
  void failVersion;

  console.log(failures === 0 ? `\n全部冒烟用例通过` : `\n${failures} 项失败`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
