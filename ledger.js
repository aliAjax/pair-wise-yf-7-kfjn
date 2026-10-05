/**
 * 字模占用账（纯逻辑，不碰 DOM / localStorage）。
 *
 * 账本分两层：
 *  - 已提交：state.drafts 里各草稿的落字，保存成功才入账；
 *  - 待存：当前版面尚未保存的落字，只用于预览，不计入正式占用。
 *
 * 字模被移走（从 inventory 删除）后，草稿里的落字记录保留，
 * 但其 typeId 在 inventory 中找不到，不再占用名额，按“缺字”单独展示。
 */
(function (global) {
  "use strict";

  function countByType(placements) {
    const counts = new Map();
    for (const placement of placements || []) {
      counts.set(placement.typeId, (counts.get(placement.typeId) || 0) + 1);
    }
    return counts;
  }

  /**
   * 汇总每个字模的占用情况。
   * 返回 Map<typeId, { type, draftCount, boardCount, total, remaining, over }>
   * draftCount 不含 boardCount；total = draftCount + boardCount。
   */
  function buildLedger(inventory, drafts, boardPlacements) {
    const draftUsage = new Map();
    let missingCount = 0;
    for (const draft of drafts || []) {
      for (const [typeId, count] of countByType(draft.placements)) {
        draftUsage.set(typeId, (draftUsage.get(typeId) || 0) + count);
        if (!(inventory || []).some((item) => item.id === typeId)) {
          missingCount += count;
        }
      }
    }
    const boardUsage = countByType(boardPlacements);

    const rows = new Map();
    for (const type of inventory || []) {
      const draftCount = draftUsage.get(type.id) || 0;
      const boardCount = boardUsage.get(type.id) || 0;
      const total = draftCount + boardCount;
      rows.set(type.id, {
        type,
        draftCount,
        boardCount,
        total,
        remaining: type.quantity - draftCount, // 当前版面保存后还要再占 boardCount
        availableForSave: type.quantity - draftCount - boardCount,
        over: Math.max(0, draftCount - type.quantity),
        overWithBoard: Math.max(0, draftCount + boardCount - type.quantity)
      });
    }

    // 已被移走、但草稿/版面里仍留着落字的字模
    const missing = new Map();
    for (const [typeId, count] of draftUsage) {
      if (!rows.has(typeId)) missing.set(typeId, (missing.get(typeId) || 0) + count);
    }
    for (const [typeId, count] of boardUsage) {
      if (!rows.has(typeId)) missing.set(typeId, (missing.get(typeId) || 0) + count);
    }

    return { rows, missing, missingCount, boardUsage, draftUsage };
  }

  /**
   * 保存前核对：把候选落字加到现有草稿占用上，逐枚字模比对登记数量。
   * options.replaceDraftId 存在时表示覆盖保存同名草稿，先剔除它原来的占用。
   * 返回 { ok, shortages: [{ typeId, char, style, quantity, used, deficit }] }。
   */
  function checkSave(inventory, drafts, candidatePlacements, options = {}) {
    const otherDrafts = (drafts || []).filter(
      (draft) => draft.id !== options.replaceDraftId
    );
    const ledger = buildLedger(inventory, otherDrafts, candidatePlacements);
    const shortages = [];
    for (const row of ledger.rows.values()) {
      if (row.overWithBoard > 0) {
        shortages.push({
          typeId: row.type.id,
          char: row.type.char,
          style: row.type.style,
          quantity: row.type.quantity,
          used: row.total,
          deficit: row.overWithBoard
        });
      }
    }
    return { ok: shortages.length === 0, shortages };
  }

  function describeShortages(shortages) {
    return shortages
      .map((item) => `${item.char}（${item.style}）缺${item.deficit}枚`)
      .join("、");
  }

  class StorageFailure extends Error {
    constructor(cause) {
      super("storage write failed");
      this.name = "StorageFailure";
      this.code = "STORAGE_FAILURE";
      this.cause = cause;
    }
  }

  /**
   * 原子提交一次“共享数据”（inventory / drafts）变更。
   *
   * 采用版本号 CAS：读最新 → 应用变更 → 校验 → 版本号对上才写回；
   * 若期间被别的标签页抢先写过，则拿最新数据整体重算重试。
   * 只有 mutate 不抛错、且 setRaw 写成功才算入账，任何一步失败都不留账。
   *
   * @param {object} io { getRaw(), setRaw(value) }，由调用方注入便于测试
   * @param {function} mutate(shared) -> { inventory?, drafts? } 或抛 { code:"SHORTAGE", shortages }
   * @param {object} options { maxAttempts }
   * @returns {object} { status:"committed", shared, attempts }
   *          或 { status:"busy", attempts }（持续冲突）
   *          或 { status:"shortage", shortages }
   */
  function commitShared(io, mutate, options = {}) {
    const maxAttempts = options.maxAttempts || 6;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const raw = io.getRaw();
      const current = raw ? JSON.parse(raw) : { version: 0, inventory: [], drafts: [] };
      const shared = {
        version: current.version || 0,
        inventory: current.inventory || [],
        drafts: current.drafts || []
      };
      const baseVersion = shared.version;

      let next;
      try {
        next = mutate({
          inventory: shared.inventory,
          drafts: shared.drafts
        });
      } catch (error) {
        if (error && error.code === "SHORTAGE") {
          return { status: "shortage", shortages: error.shortages || [] };
        }
        throw error;
      }

      const candidate = {
        version: baseVersion + 1,
        inventory: next.inventory,
        drafts: next.drafts
      };

      try {
        io.setRaw(baseVersion, JSON.stringify(candidate));
      } catch (error) {
        lastError = error;
        continue; // 写失败（如配额/锁冲突）：本轮未入账，重试
      }
      return { status: "committed", shared: candidate, attempts: attempt };
    }
    if (lastError) throw new StorageFailure(lastError);
    return { status: "busy", attempts: maxAttempts };
  }

  /**
   * 保存草稿：核对通过才把候选落字入账。库存与既有草稿一律以 io 中的最新账为准。
   * candidate = { id, title, settings, placements, savedAt }
   */
  function saveDraftCommit(io, candidate, options = {}) {
    const cap = options.cap || 8;
    return commitShared(io, (shared) => {
      const check = checkSave(shared.inventory, shared.drafts, candidate.placements, {
        replaceDraftId: options.replaceDraftId
      });
      if (!check.ok) {
        const error = new Error("shortage");
        error.code = "SHORTAGE";
        error.shortages = check.shortages;
        throw error;
      }
      let draftsNext;
      if (options.replaceDraftId) {
        draftsNext = shared.drafts.map((draft) =>
          draft.id === options.replaceDraftId
            ? { ...draft, ...candidate, id: draft.id }
            : draft
        );
      } else {
        draftsNext = [
          { id: candidate.id, ...candidate },
          ...shared.drafts
        ].slice(0, cap);
      }
      return { inventory: shared.inventory, drafts: draftsNext };
    }, options);
  }

  const api = {
    countByType,
    buildLedger,
    checkSave,
    describeShortages,
    commitShared,
    saveDraftCommit,
    StorageFailure
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.Ledger = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
