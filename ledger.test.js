const assert = require("assert");
const Ledger = require("./ledger.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function makeType(id, char, quantity) {
  return { id, char, style: "宋体", size: 24, quantity, wear: "新" };
}
function draft(id, placements) {
  return { id, title: id, settings: {}, placements, savedAt: "2026-10-05T00:00:00.000Z" };
}
function placements(...typeIds) {
  return typeIds.map((typeId, i) => ({ row: i, col: 0, typeId }));
}
function candidate(id, list) {
  return {
    id,
    title: id,
    settings: {},
    placements: placements(...list),
    savedAt: "2026-10-05T00:00:00.000Z"
  };
}

/** 模拟 localStorage：只接受版本号严格递增的写入，可注入写失败/并发写入 */
function makeStore(inventory = []) {
  let raw = JSON.stringify({ version: 0, inventory, drafts: [] });
  let failNextWrites = 0;
  let interceptor = null;
  const store = {
    getRaw: () => raw,
    setRaw(expectedVersion, value) {
      if (failNextWrites > 0) {
        failNextWrites -= 1;
        throw new Error("quota exceeded");
      }
      if (interceptor) {
        const hook = interceptor;
        interceptor = null;
        hook();
      }
      const current = JSON.parse(raw);
      if ((current.version || 0) !== expectedVersion) {
        throw new Error("version conflict");
      }
      raw = value;
    },
    state() {
      return JSON.parse(raw);
    },
    failNext(n = 1) {
      failNextWrites = n;
    },
    /** 模拟另一个标签页基于最新账成功提交一次变更 */
    commitOther(updater) {
      const current = JSON.parse(raw);
      const next = { ...current, ...updater(current), version: (current.version || 0) + 1 };
      raw = JSON.stringify(next);
    },
    /** 在下一次 setRaw 做版本校验前，插入另一个标签页的提交 */
    interceptNextWrite(fn) {
      interceptor = () => fn(store);
    }
  };
  return store;
}

console.log("账本汇总");

test("草稿占用跨草稿相加，当前版面只作为待存预览", () => {
  const 山 = makeType("shan", "山", 4);
  const 月 = makeType("yue", "月", 2);
  const inventory = [山, 月];
  const drafts = [
    draft("d1", placements("shan", "shan", "yue")),
    draft("d2", placements("shan", "yue"))
  ];
  const board = placements("shan");
  const ledger = Ledger.buildLedger(inventory, drafts, board);
  assert.strictEqual(ledger.rows.get("shan").draftCount, 3);
  assert.strictEqual(ledger.rows.get("shan").boardCount, 1);
  assert.strictEqual(ledger.rows.get("shan").total, 4);
  assert.strictEqual(ledger.rows.get("yue").draftCount, 2);
  assert.strictEqual(ledger.rows.get("yue").remaining, 0); // 草稿已占满
  const withMoreBoard = Ledger.buildLedger(inventory, drafts, placements("yue"));
  assert.strictEqual(withMoreBoard.rows.get("yue").availableForSave, -1); // 版面再放月就不够
});

test("字模登记数量变少后，账目立即反映超量", () => {
  const 山 = makeType("shan", "山", 4);
  const drafts = [draft("d1", placements("shan", "shan", "shan", "shan"))];
  assert.strictEqual(Ledger.buildLedger([山], drafts, []).rows.get("shan").over, 0);
  const less = { ...山, quantity: 2 };
  const ledger = Ledger.buildLedger([less], drafts, []);
  assert.strictEqual(ledger.rows.get("shan").over, 2);
});

test("字模被移走后落字保留但不再占名额，计入缺字", () => {
  const 月 = makeType("yue", "月", 2);
  const drafts = [draft("d1", placements("shan", "shan", "yue"))];
  const board = placements("shan");
  const ledger = Ledger.buildLedger([月], drafts, board); // 山已从库中移走
  assert.strictEqual(ledger.rows.has("shan"), false);
  assert.strictEqual(ledger.missing.get("shan"), 3);
  assert.strictEqual(ledger.rows.get("yue").draftCount, 1);
});

console.log("保存核对");

test("占用合计超过登记数量时保存被拒，并指出缺哪些字、各缺几枚", () => {
  const inventory = [makeType("shan", "山", 3), makeType("yue", "月", 1)];
  const drafts = [draft("d1", placements("shan", "shan"))];
  const check = Ledger.checkSave(inventory, drafts, placements("shan", "shan", "yue", "yue"));
  assert.strictEqual(check.ok, false);
  const byChar = Object.fromEntries(check.shortages.map((s) => [s.char, s]));
  assert.strictEqual(byChar["山"].used, 4);
  assert.strictEqual(byChar["山"].deficit, 1);
  assert.strictEqual(byChar["月"].used, 2);
  assert.strictEqual(byChar["月"].deficit, 1);
  assert.match(Ledger.describeShortages(check.shortages), /山（宋体）缺1枚/);
  assert.match(Ledger.describeShortages(check.shortages), /月（宋体）缺1枚/);
});

test("数量刚好等于登记数量时可以保存", () => {
  const inventory = [makeType("shan", "山", 3)];
  const drafts = [draft("d1", placements("shan", "shan"))];
  const check = Ledger.checkSave(inventory, drafts, placements("shan"));
  assert.strictEqual(check.ok, true);
});

console.log("提交（原子账）");

test("保存成功后草稿落字入账", () => {
  const store = makeStore([makeType("shan", "山", 3)]);
  const res = Ledger.saveDraftCommit(store, candidate("d1", ["shan", "shan"]));
  assert.strictEqual(res.status, "committed");
  const s = store.state();
  assert.strictEqual(s.drafts.length, 1);
  assert.strictEqual(s.version, 1);
  assert.strictEqual(
    Ledger.buildLedger(s.inventory, s.drafts, []).rows.get("shan").draftCount,
    2
  );
});

test("第二份草稿在第一份占用之上超量时被拒，且不写入任何内容", () => {
  const store = makeStore([makeType("shan", "山", 3)]);
  Ledger.saveDraftCommit(store, candidate("d1", ["shan", "shan"]));
  const before = store.state();
  const res = Ledger.saveDraftCommit(store, candidate("d2", ["shan", "shan"]));
  assert.strictEqual(res.status, "shortage");
  assert.strictEqual(res.shortages[0].deficit, 1);
  assert.deepStrictEqual(store.state(), before); // 没存成，版本与账目不变
});

test("写存储中途失败后重试：最终成功，且失败那次不留账", () => {
  const store = makeStore([makeType("shan", "山", 3)]);
  store.failNext(2); // 前两次写入抛错
  const res = Ledger.saveDraftCommit(store, candidate("d1", ["shan", "shan"]), {
    maxAttempts: 5
  });
  assert.strictEqual(res.status, "committed");
  assert.strictEqual(res.attempts, 3);
  const s = store.state();
  assert.strictEqual(s.version, 1); // 没有产生任何中间版本
  assert.strictEqual(s.drafts.length, 1);
});

test("持续写失败时抛出 StorageFailure，账目不变，可重试", () => {
  const store = makeStore([makeType("shan", "山", 3)]);
  store.failNext(10);
  assert.throws(
    () => Ledger.saveDraftCommit(store, candidate("d1", ["shan"]), { maxAttempts: 3 }),
    (e) => e.code === "STORAGE_FAILURE"
  );
  assert.strictEqual(store.state().version, 0);
  assert.deepStrictEqual(store.state().drafts, []);

  // 恢复后原样重试同一份草稿即可成功（候选草稿未被修改）
  store.failNext(0);
  const res = Ledger.saveDraftCommit(store, candidate("d1", ["shan"]));
  assert.strictEqual(res.status, "committed");
});

test("两个标签页同时保存：后到者按最新占用重算，超量则被拒", () => {
  const store = makeStore([makeType("shan", "山", 3)]);
  // A 落盘前，标签页 B 基于同一版本抢先写入一份草稿（占 2 枚）
  store.interceptNextWrite((s) => {
    s.commitOther((current) => ({
      drafts: [draft("B", placements("shan", "shan")), ...current.drafts]
    }));
  });
  // A 想存 2 枚：独自时够；B 先占了 2 枚，合计 4 > 3
  const res = Ledger.saveDraftCommit(store, candidate("A", ["shan", "shan"]));
  assert.strictEqual(res.status, "shortage");
  assert.strictEqual(res.shortages[0].deficit, 1);
  // A 被拒：账上只有 B
  assert.deepStrictEqual(
    store.state().drafts.map((d) => d.id),
    ["B"]
  );

  // A 减到 1 枚再试，按最新占用重算后通过
  const retry = Ledger.saveDraftCommit(store, candidate("A", ["shan"]));
  assert.strictEqual(retry.status, "committed");
  assert.strictEqual(
    Ledger.buildLedger(store.state().inventory, store.state().drafts, [])
      .rows.get("shan").draftCount,
    3
  );
});

test("无冲突时标签页内保存顺序提交，版本号单调", () => {
  const store = makeStore([makeType("shan", "山", 6)]);
  Ledger.saveDraftCommit(store, candidate("d1", ["shan"]));
  Ledger.saveDraftCommit(store, candidate("d2", ["shan", "shan"]));
  const s = store.state();
  assert.strictEqual(s.version, 2);
  assert.strictEqual(
    Ledger.buildLedger(s.inventory, s.drafts, []).rows.get("shan").draftCount,
    3
  );
});

console.log("字模数量变更（重算占用）");

test("数量下调使已存草稿超量：commit 正常落账，由账本暴露 over", () => {
  const store = makeStore([makeType("shan", "山", 4)]);
  Ledger.saveDraftCommit(store, candidate("d1", ["shan", "shan", "shan"]));
  const res = Ledger.commitShared(store, (shared) => ({
    inventory: shared.inventory.map((t) => ({ ...t, quantity: 2 })),
    drafts: shared.drafts
  }));
  assert.strictEqual(res.status, "committed");
  const s = store.state();
  assert.strictEqual(
    Ledger.buildLedger(s.inventory, s.drafts, []).rows.get("shan").over,
    1
  );
  // 落字没有丢
  assert.strictEqual(s.drafts[0].placements.length, 3);
});

test("数量上调后超量消失，同一份草稿可再保存", () => {
  const store = makeStore([makeType("shan", "山", 2)]);
  Ledger.saveDraftCommit(store, candidate("d1", ["shan", "shan"]));
  Ledger.commitShared(store, (shared) => ({
    inventory: shared.inventory.map((t) => ({ ...t, quantity: 1 })),
    drafts: shared.drafts
  }));
  assert.strictEqual(
    Ledger.buildLedger(store.state().inventory, store.state().drafts, [])
      .rows.get("shan").over,
    1
  );
  Ledger.commitShared(store, (shared) => ({
    inventory: shared.inventory.map((t) => ({ ...t, quantity: 3 })),
    drafts: shared.drafts
  }));
  assert.strictEqual(
    Ledger.buildLedger(store.state().inventory, store.state().drafts, [])
      .rows.get("shan").over,
    0
  );
});

console.log(`\n${passed} 项通过`);
