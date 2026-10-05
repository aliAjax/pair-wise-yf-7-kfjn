const storageKey = "zfl16-movable-type-workshop";
/** 本页数据（当前版面/设置/选中字模）按标签页隔离，不串到其他标签页。 */
const localKey = "zfl16-movable-type-workshop:local";

const starterInventory = [
  { id: crypto.randomUUID(), char: "山", style: "宋体旧字", size: 30, quantity: 4, wear: "微磨" },
  { id: crypto.randomUUID(), char: "月", style: "宋体旧字", size: 30, quantity: 3, wear: "旧痕" },
  { id: crypto.randomUUID(), char: "风", style: "楷体木刻", size: 28, quantity: 2, wear: "微磨" },
  { id: crypto.randomUUID(), char: "花", style: "楷体木刻", size: 28, quantity: 2, wear: "新" },
  { id: crypto.randomUUID(), char: "茶", style: "黑体铅字", size: 24, quantity: 3, wear: "旧痕" },
  { id: crypto.randomUUID(), char: "雨", style: "仿宋细字", size: 22, quantity: 4, wear: "新" }
];

const defaultSettings = {
  paperSize: "postcard",
  flowMode: "horizontal",
  gridGap: 8,
  workTitle: "晚风小笺"
};

const DRAFT_CAP = 8;
const MAX_COMMIT_ATTEMPTS = 6;

/**
 * state 里混着两类数据：
 *  - 共享（跨标签页同一本账）：inventory / drafts / version，提交走 CAS；
 *  - 本页：selectedTypeId / placements（当前版面，未保存的落字）/ settings。
 */
let state = loadState();

/** 上次保存尝试的候选草稿；失败后点“重试”用它按最新占用重新核对。 */
let pendingSave = null;

const els = {
  paperSize: document.querySelector("#paperSize"),
  flowMode: document.querySelector("#flowMode"),
  gridGap: document.querySelector("#gridGap"),
  workTitle: document.querySelector("#workTitle"),
  stage: document.querySelector("#stage"),
  typeList: document.querySelector("#typeList"),
  typeForm: document.querySelector("#typeForm"),
  charInput: document.querySelector("#charInput"),
  styleInput: document.querySelector("#styleInput"),
  sizeInput: document.querySelector("#sizeInput"),
  quantityInput: document.querySelector("#quantityInput"),
  wearInput: document.querySelector("#wearInput"),
  inventorySearch: document.querySelector("#inventorySearch"),
  styleFilter: document.querySelector("#styleFilter"),
  selectedTypeLabel: document.querySelector("#selectedTypeLabel"),
  shortageBadge: document.querySelector("#shortageBadge"),
  usageList: document.querySelector("#usageList"),
  saveBanner: document.querySelector("#saveBanner"),
  draftList: document.querySelector("#draftList"),
  placedCount: document.querySelector("#placedCount"),
  inventoryCount: document.querySelector("#inventoryCount"),
  saveDraftBtn: document.querySelector("#saveDraftBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  clearBoardBtn: document.querySelector("#clearBoardBtn")
};

const storageIO = {
  getRaw() {
    return localStorage.getItem(storageKey);
  },
  setRaw(expectedVersion, value) {
    const raw = localStorage.getItem(storageKey);
    let current = { version: 0 };
    if (raw) {
      try {
        current = JSON.parse(raw);
      } catch {
        current = { version: 0 };
      }
    }
    if ((current.version || 0) !== expectedVersion) {
      throw new Error("version conflict");
    }
    localStorage.setItem(storageKey, value);
  }
};

function loadState() {
  // 共享账：字模库 + 已存草稿（所有标签页同一本）
  let shared = { version: 0, inventory: structuredClone(starterInventory), drafts: [] };
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      shared = {
        version: parsed.version || 0,
        inventory: Array.isArray(parsed.inventory) ? parsed.inventory : structuredClone(starterInventory),
        drafts: Array.isArray(parsed.drafts) ? parsed.drafts : []
      };
    } catch {
      /* 账损坏时回落到初始字模库 */
    }
  }

  // 本页：当前版面/设置。优先 sessionStorage（按标签页隔离）；
  // 兼容旧版本：老数据只在 localStorage 里，首次读一次后即迁移走。
  let local = null;
  const localSaved = sessionStorage.getItem(localKey);
  if (localSaved) {
    try {
      local = JSON.parse(localSaved);
    } catch {
      local = null;
    }
  } else if (saved) {
    try {
      const legacy = JSON.parse(saved);
      local = {
        selectedTypeId: legacy.selectedTypeId,
        placements: Array.isArray(legacy.placements) ? legacy.placements : [],
        settings: legacy.settings
      };
    } catch {
      local = null;
    }
  }

  return {
    ...shared,
    selectedTypeId: local?.selectedTypeId || shared.inventory[0]?.id || null,
    placements: Array.isArray(local?.placements) ? local.placements : [],
    settings: { ...structuredClone(defaultSettings), ...(local?.settings || {}) }
  };
}

/**
 * 只写本页数据（选中字模/当前版面/设置）到 sessionStorage，与共享账彻底分开，
 * 因此不会覆盖别的标签页，也不会被别的标签页的落字串进来。
 */
function persistLocal() {
  sessionStorage.setItem(
    localKey,
    JSON.stringify({
      selectedTypeId: state.selectedTypeId,
      placements: state.placements,
      settings: state.settings
    })
  );
}

/**
 * 提交一次共享变更（字模增删/改数量、草稿删除等不含额度核对的操作）。
 * 直接带 CAS 重试：即使本标签页还没收到 storage 事件、内存版本落后，
 * 也会拿最新账重新应用 mutate，直到写成功，不会静默失败。
 */
function commitShared(mutate, options = {}) {
  const result = Ledger.commitShared(storageIO, mutate, {
    cap: DRAFT_CAP,
    maxAttempts: MAX_COMMIT_ATTEMPTS,
    ...options
  });
  if (result.status === "committed") {
    state.version = result.shared.version;
    state.inventory = result.shared.inventory;
    state.drafts = result.shared.drafts;
  }
  return result;
}

function getGrid() {
  const size = state.settings.paperSize;
  if (size === "bookmark") return { cols: 7, rows: 18 };
  if (size === "square") return { cols: 12, rows: 12 };
  return { cols: 16, rows: 10 };
}

function placementKey(row, col) {
  return `${row}:${col}`;
}

function getSelectedType() {
  return state.inventory.find((item) => item.id === state.selectedTypeId) || null;
}

function getLedger() {
  return Ledger.buildLedger(state.inventory, state.drafts, state.placements);
}

/** 当前版面“若现在保存”的核对结果，用于实时提示。 */
function getBoardCheck() {
  return Ledger.checkSave(state.inventory, state.drafts, state.placements);
}

function renderSettings() {
  els.paperSize.value = state.settings.paperSize;
  els.flowMode.value = state.settings.flowMode;
  els.gridGap.value = state.settings.gridGap;
  els.workTitle.value = state.settings.workTitle;
}

function renderStyleFilter() {
  const current = els.styleFilter.value || "all";
  const styles = [...new Set(state.inventory.map((item) => item.style))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  els.styleFilter.innerHTML = `<option value="all">全部风格</option>${styles
    .map((style) => `<option value="${escapeHtml(style)}">${escapeHtml(style)}</option>`)
    .join("")}`;
  els.styleFilter.value = styles.includes(current) ? current : "all";
}

function renderInventory() {
  const keyword = els.inventorySearch.value.trim();
  const style = els.styleFilter.value;
  const ledger = getLedger();
  const items = state.inventory.filter((item) => {
    const matchesKeyword = !keyword || `${item.char}${item.style}${item.wear}`.includes(keyword);
    const matchesStyle = style === "all" || item.style === style;
    return matchesKeyword && matchesStyle;
  });

  els.inventoryCount.textContent = `${state.inventory.length}种字模`;
  els.typeList.innerHTML = items
    .map((item) => {
      const row = ledger.rows.get(item.id);
      const selected = item.id === state.selectedTypeId ? "selected" : "";
      const over = row.over > 0;
      const tight = !over && row.remaining <= 0;
      const status = over
        ? `<span class="stock warn">已占${row.draftCount}/${item.quantity} · 超${row.over}枚</span>`
        : `<span class="stock ${tight ? "tight" : ""}">草稿占${row.draftCount}/${item.quantity} · 余${row.remaining}</span>`;
      return `
        <article class="type-card ${selected}" draggable="true" data-type-id="${item.id}">
          <div class="glyph" style="font-size:${Math.min(item.size, 36)}px">${escapeHtml(item.char)}</div>
          <div class="type-meta">
            <strong>${escapeHtml(item.char)} · ${escapeHtml(item.style)}</strong>
            <span>${item.size}px · ${escapeHtml(item.wear)}</span>
            ${status}
          </div>
          <div class="type-controls">
            <div class="qty-stepper" role="group" aria-label="字模数量">
              <button type="button" class="mini-btn" data-qty-dec="${item.id}" aria-label="减少一枚">−</button>
              <span class="qty-num">${item.quantity}</span>
              <button type="button" class="mini-btn" data-qty-inc="${item.id}" aria-label="增加一枚">＋</button>
            </div>
            <button class="mini-btn" title="移走字模（草稿落字保留，先腾空名额）" data-delete-type="${item.id}" type="button">×</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderStage() {
  const { cols, rows } = getGrid();
  const map = new Map(state.placements.map((item) => [placementKey(item.row, item.col), item]));
  els.stage.className = `stage ${state.settings.paperSize}`;
  els.stage.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  els.stage.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  els.stage.style.gap = `${state.settings.gridGap}px`;
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const placement = map.get(placementKey(row, col));
      const type = placement ? state.inventory.find((item) => item.id === placement.typeId) : null;
      const vertical = state.settings.flowMode === "vertical" ? "vertical" : "";
      const missing = placement && !type;
      cells.push(`
        <button class="cell ${type ? "used" : ""} ${missing ? "missing" : ""} ${vertical}" data-row="${row}" data-col="${col}" type="button" aria-label="第${row + 1}行第${col + 1}列${missing ? "（字模已移走）" : ""}">
          ${missing ? "◇" : type ? escapeHtml(type.char) : ""}
        </button>
      `);
    }
  }
  els.stage.innerHTML = cells.join("");
}

function renderUsage() {
  const ledger = getLedger();
  const check = getBoardCheck();
  els.placedCount.textContent = `${state.placements.length}个落字待存`;

  const savedShortages = [...ledger.rows.values()].filter((row) => row.over > 0);
  const missingEntries = [...ledger.missing.entries()];
  const hasProblem = savedShortages.length || missingEntries.length;

  if (hasProblem) {
    const parts = [];
    if (savedShortages.length) {
      parts.push(
        `已存草稿缺字：${savedShortages
          .map((row) => `${row.type.char}缺${row.over}枚`)
          .join("、")}`
      );
    }
    if (missingEntries.length) {
      parts.push(`${missingEntries.reduce((sum, [, n]) => sum + n, 0)}处落字的字模已移走（落字保留，不占名额）`);
    }
    els.shortageBadge.textContent = parts[0];
    els.shortageBadge.className = "badge warn";
    els.shortageBadge.title = parts.join("；");
  } else {
    els.shortageBadge.textContent = check.ok ? "占用充足" : "当前版面超量";
    els.shortageBadge.className = `badge ${check.ok ? "ok" : "warn"}`;
    els.shortageBadge.title = "";
  }

  const selectedType = getSelectedType();
  els.selectedTypeLabel.textContent = selectedType ? `当前：${selectedType.char} · ${selectedType.style}` : "未选择字模";

  const rows = [...ledger.rows.values()]
    .filter((row) => row.draftCount > 0 || row.boardCount > 0)
    .map((row) => {
      const boardHint = row.boardCount > 0 ? `（含本页${row.boardCount}个待存）` : "";
      const cls = row.over > 0 ? "warn" : row.remaining < row.boardCount ? "tight" : "";
      return `
        <div class="usage-item ${cls}">
          <strong>${escapeHtml(row.type.char)} ${escapeHtml(row.type.style)}${boardHint}</strong>
          <span>${row.draftCount + row.boardCount}/${row.type.quantity}</span>
        </div>
      `;
    });

  const missingRows = missingEntries.map(
    ([, count]) => `
      <div class="usage-item warn">
        <strong>字模已移走</strong>
        <span>${count}处落字悬空</span>
      </div>
    `
  );

  els.usageList.innerHTML =
    [...rows, ...missingRows].join("") || `<p class="empty">还没有落字。</p>`;

  renderSaveBanner();
}

function renderSaveBanner() {
  if (!pendingSave) {
    els.saveBanner.hidden = true;
    els.saveBanner.innerHTML = "";
    return;
  }
  const { kind, shortages, message, attempts } = pendingSave;
  if (kind === "success") {
    els.saveBanner.className = "save-banner ok";
    els.saveBanner.innerHTML = `<span>✓ ${escapeHtml(message)}</span>`;
  } else if (kind === "shortage") {
    const detail = Ledger.describeShortages(shortages);
    els.saveBanner.className = "save-banner warn";
    els.saveBanner.innerHTML = `
      <span>保存已停下：${escapeHtml(detail)}。请减少落字、删除占用草稿，或给字模加数量后点重试。</span>
      <button type="button" data-retry-save>重试保存</button>
    `;
  } else if (kind === "busy") {
    els.saveBanner.className = "save-banner warn";
    els.saveBanner.innerHTML = `
      <span>另一标签页正在改占用账（已按最新占用重算${attempts}次仍冲突），本次占用未入账，请重试。</span>
      <button type="button" data-retry-save>重试保存</button>
    `;
  } else {
    els.saveBanner.className = "save-banner warn";
    els.saveBanner.innerHTML = `
      <span>${escapeHtml(message || "保存中途失败")}。这次占用没有留在账上，可直接重试。</span>
      <button type="button" data-retry-save>重试保存</button>
    `;
  }
  els.saveBanner.hidden = false;
}

function draftMissingCount(draft) {
  return draft.placements.filter(
    (placement) => !state.inventory.some((item) => item.id === placement.typeId)
  ).length;
}

function renderDrafts() {
  els.draftList.innerHTML =
    state.drafts
      .map((draft) => {
        const missing = draftMissingCount(draft);
        return `
          <article class="draft-item">
            <strong>${escapeHtml(draft.title)}</strong>
            <span>${draft.placements.length}个落字 · ${new Date(draft.savedAt).toLocaleString("zh-CN")}${
          missing ? ` · <em class="missing-note">${missing}处字模已移走</em>` : ""
        }</span>
            <div class="draft-actions">
              <button type="button" data-load-draft="${draft.id}">载入</button>
              <button type="button" data-delete-draft="${draft.id}">删除（释放名额）</button>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">还没有保存草稿。</p>`;
}

function renderAll() {
  renderSettings();
  renderStyleFilter();
  renderInventory();
  renderStage();
  renderUsage();
  renderDrafts();
}

function placeType(row, col, typeId = state.selectedTypeId) {
  if (!typeId) return;
  const existingIndex = state.placements.findIndex((item) => item.row === row && item.col === col);
  if (existingIndex >= 0) {
    if (state.placements[existingIndex].typeId === typeId) {
      state.placements.splice(existingIndex, 1);
    } else {
      state.placements[existingIndex].typeId = typeId;
    }
  } else {
    state.placements.push({ row, col, typeId });
  }
  pendingSave = null;
  persistLocal();
  renderAll();
}

function addType(event) {
  event.preventDefault();
  const item = {
    id: crypto.randomUUID(),
    char: els.charInput.value.trim(),
    style: els.styleInput.value.trim(),
    size: Number(els.sizeInput.value),
    quantity: Number(els.quantityInput.value),
    wear: els.wearInput.value
  };
  if (!item.char || !item.style) return;
  const result = commitShared((shared) => ({
    inventory: [item, ...shared.inventory],
    drafts: shared.drafts
  }));
  if (result.status === "committed") {
    state.selectedTypeId = item.id;
    els.typeForm.reset();
    els.sizeInput.value = 24;
    els.quantityInput.value = 3;
  }
  persistLocal();
  renderAll();
}

function changeQuantity(typeId, delta) {
  const result = commitShared((shared) => {
    const inventory = shared.inventory.map((item) =>
      item.id === typeId ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item
    );
    return { inventory, drafts: shared.drafts };
  });
  if (result.status !== "committed" && !pendingSave) {
    pendingSave = { kind: "error", message: "占用账正忙，数量未改成，请重试" };
  }
  refreshPendingShortage();
  persistLocal();
  renderAll();
}

function removeType(typeId) {
  // 字模移走：从库中删除即可。草稿里的落字记录保留，但 buildLedger 不再给它计占用；
  // 若它正处于超额状态，名额随之腾空，由账目重算反映。
  const result = commitShared((shared) => ({
    inventory: shared.inventory.filter((item) => item.id !== typeId),
    drafts: shared.drafts
  }));
  if (result.status === "committed") {
    if (state.selectedTypeId === typeId) {
      state.selectedTypeId = state.inventory[0]?.id || null;
    }
  }
  persistLocal();
  renderAll();
}

function makeCandidate() {
  return {
    id: crypto.randomUUID(),
    title: state.settings.workTitle.trim() || "未命名作品",
    settings: structuredClone(state.settings),
    placements: structuredClone(state.placements),
    savedAt: new Date().toISOString()
  };
}

function saveDraft() {
  saveCandidate(makeCandidate());
}

function readShared() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (!parsed) return null;
    return {
      version: parsed.version || 0,
      inventory: parsed.inventory || [],
      drafts: parsed.drafts || []
    };
  } catch {
    return null;
  }
}

function retrySave() {
  if (pendingSave?.candidate) saveCandidate(pendingSave.candidate);
}

function saveCandidate(candidate) {
  els.saveDraftBtn.disabled = true;
  let result;
  try {
    result = Ledger.saveDraftCommit(storageIO, candidate, {
      cap: DRAFT_CAP,
      maxAttempts: MAX_COMMIT_ATTEMPTS
    });
  } catch (error) {
    result = { status: "error", message: error && error.message };
  } finally {
    els.saveDraftBtn.disabled = false;
  }

  if (result.status === "committed") {
    state.version = result.shared.version;
    state.inventory = result.shared.inventory;
    state.drafts = result.shared.drafts;
    pendingSave = { kind: "success", message: `已保存《${candidate.title}》，落字名额已入账` };
  } else if (result.status === "shortage") {
    // 占用未变：storage 未写入。保留候选供“重试保存”按最新占用再核对。
    pendingSave = { kind: "shortage", candidate, shortages: result.shortages };
  } else if (result.status === "busy") {
    pendingSave = { kind: "busy", candidate, attempts: result.attempts };
  } else {
    pendingSave = { kind: "error", candidate, message: result.message || "本地存储不可写" };
  }
  // 同步账上最新数据（可能别的标签页刚提交过），但本页落字不动
  const latest = readShared();
  if (latest) {
    state.version = latest.version;
    state.inventory = latest.inventory;
    state.drafts = latest.drafts;
  }
  persistLocal();
  renderAll();
}

function deleteDraft(draftId) {
  commitShared((shared) => ({
    inventory: shared.inventory,
    drafts: shared.drafts.filter((item) => item.id !== draftId)
  }));
  refreshPendingShortage();
  persistLocal();
  renderAll();
}

/** 账目变化（删草稿/改数量/别的标签页提交）后，重算待存草稿还缺不缺。 */
function refreshPendingShortage() {
  if (!pendingSave?.candidate) return;
  if (pendingSave.kind !== "shortage") return;
  const check = Ledger.checkSave(state.inventory, state.drafts, pendingSave.candidate.placements);
  if (check.ok) {
    pendingSave = {
      ...pendingSave,
      shortages: [],
      kind: "error",
      message: "占用已腾出，现在可以重试保存"
    };
  } else {
    pendingSave = { ...pendingSave, shortages: check.shortages };
  }
}

function loadDraft(draftId) {
  const draft = state.drafts.find((item) => item.id === draftId);
  if (!draft) return;
  state.settings = structuredClone(draft.settings);
  state.placements = structuredClone(draft.placements);
  pendingSave = null;
  persistLocal();
  renderAll();
}

function exportPreview() {
  const { cols, rows } = getGrid();
  const cell = state.settings.paperSize === "bookmark" ? 44 : 56;
  const gap = state.settings.gridGap;
  const margin = 48;
  const width = cols * cell + (cols - 1) * gap + margin * 2;
  const height = rows * cell + (rows - 1) * gap + margin * 2 + 70;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fffaf1";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#2f2921";
  ctx.lineWidth = 4;
  ctx.strokeRect(18, 18, width - 36, height - 36);
  ctx.fillStyle = "#22201c";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText(state.settings.workTitle || "未命名作品", margin, 50);
  ctx.font = "bold 30px serif";
  state.placements.forEach((placement) => {
    const type = state.inventory.find((item) => item.id === placement.typeId);
    if (!type) return;
    const x = margin + placement.col * (cell + gap);
    const y = margin + 45 + placement.row * (cell + gap);
    ctx.fillStyle = "#2f2921";
    ctx.fillRect(x, y, cell, cell);
    ctx.fillStyle = "#fff5df";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `900 ${Math.min(type.size + 8, 42)}px serif`;
    ctx.fillText(type.char, x + cell / 2, y + cell / 2);
  });
  const link = document.createElement("a");
  link.download = `${state.settings.workTitle || "movable-type"}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** 别的标签页提交后，只同步更新的共享账；本页未落字的版面保持不动。 */
window.addEventListener("storage", (event) => {
  if (event.key !== storageKey || !event.newValue) return;
  try {
    const parsed = JSON.parse(event.newValue);
    const incomingVersion = parsed.version || 0;
    // 事件可能在本页自己刚提交之后才到达（携带的是旧快照）：旧版本直接忽略
    if (incomingVersion < state.version) return;
    state.version = incomingVersion;
    state.inventory = parsed.inventory || [];
    state.drafts = parsed.drafts || [];
    refreshPendingShortage();
    renderAll();
  } catch {
    /* 别的标签页写入了无法解析的数据，忽略 */
  }
});

els.paperSize.addEventListener("change", () => {
  state.settings.paperSize = els.paperSize.value;
  const { cols, rows } = getGrid();
  state.placements = state.placements.filter((item) => item.row < rows && item.col < cols);
  persistLocal();
  renderAll();
});

els.flowMode.addEventListener("change", () => {
  state.settings.flowMode = els.flowMode.value;
  persistLocal();
  renderAll();
});

els.gridGap.addEventListener("input", () => {
  state.settings.gridGap = Number(els.gridGap.value);
  persistLocal();
  renderAll();
});

els.workTitle.addEventListener("input", () => {
  state.settings.workTitle = els.workTitle.value;
  persistLocal();
});

els.typeForm.addEventListener("submit", addType);
els.inventorySearch.addEventListener("input", renderInventory);
els.styleFilter.addEventListener("change", renderInventory);
els.saveDraftBtn.addEventListener("click", saveDraft);
els.exportBtn.addEventListener("click", exportPreview);
els.clearBoardBtn.addEventListener("click", () => {
  state.placements = [];
  pendingSave = null;
  persistLocal();
  renderAll();
});

els.typeList.addEventListener("click", (event) => {
  const incButton = event.target.closest("[data-qty-inc]");
  const decButton = event.target.closest("[data-qty-dec]");
  if (incButton) {
    changeQuantity(incButton.dataset.qtyInc, 1);
    return;
  }
  if (decButton) {
    changeQuantity(decButton.dataset.qtyDec, -1);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-type]");
  if (deleteButton) {
    removeType(deleteButton.dataset.deleteType);
    return;
  }
  const card = event.target.closest("[data-type-id]");
  if (!card) return;
  state.selectedTypeId = card.dataset.typeId;
  persistLocal();
  renderAll();
});

els.typeList.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-type-id]");
  if (!card) return;
  event.dataTransfer.setData("text/plain", card.dataset.typeId);
});

els.stage.addEventListener("dragover", (event) => {
  if (event.target.closest(".cell")) event.preventDefault();
});

els.stage.addEventListener("drop", (event) => {
  const cell = event.target.closest(".cell");
  if (!cell) return;
  event.preventDefault();
  placeType(Number(cell.dataset.row), Number(cell.dataset.col), event.dataTransfer.getData("text/plain"));
});

els.stage.addEventListener("click", (event) => {
  const cell = event.target.closest(".cell");
  if (!cell) return;
  placeType(Number(cell.dataset.row), Number(cell.dataset.col));
});

els.saveBanner.addEventListener("click", (event) => {
  if (event.target.closest("[data-retry-save]")) retrySave();
});

els.draftList.addEventListener("click", (event) => {
  const loadButton = event.target.closest("[data-load-draft]");
  const deleteButton = event.target.closest("[data-delete-draft]");
  if (loadButton) loadDraft(loadButton.dataset.loadDraft);
  if (deleteButton) deleteDraft(deleteButton.dataset.deleteDraft);
});

// 首次使用（账上没有任何共享数据）：把初始字模库入账。
// 已有数据时保持账上版本不动，避免老用户每次打开都平白抬一次版本号。
{
  const seeded = readShared();
  const accountEmpty = !seeded || (seeded.version === 0 && seeded.inventory.length === 0);
  if (accountEmpty && state.inventory.length > 0) {
    const result = commitShared(() => ({
      inventory: state.inventory,
      drafts: []
    }));
    if (result.status === "committed") persistLocal();
  }
}

renderAll();
