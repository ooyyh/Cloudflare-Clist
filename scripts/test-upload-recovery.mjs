/**
 * 刷新恢复逻辑回归测试（node 直接跑打包后的 upload-manager）
 *
 * 用法（先打包再运行，约 45 秒）：
 *   npx esbuild app/lib/upload-manager.ts --bundle --format=esm --alias:~=./app --outfile=scripts/.um-bundle.mjs
 *   node scripts/test-upload-recovery.mjs
 *
 * 验证三个场景（每个场景用独立模块实例，query string 绕过 import 缓存）：
 *  A. 上传中刷新（无其他标签页）→ 10s 内任务从"检测中"转为可恢复，不死锁在 remote
 *  B. 其他标签页真的在跑 → 判为 remote 只读；对方停止心跳后 → 看门狗转为可恢复
 *  C. 心跳早已过期 → 立即恢复显示为可恢复
 */
// --- 浏览器 API stub ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  key: (i) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
globalThis.window = { addEventListener: () => {} };
globalThis.indexedDB = { open: () => { throw new Error("no idb in test"); } };

const STORE_KEY = "clist-uploads-v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${msg}`);
  if (!cond) failed++;
};

const freshManager = async (caseTag) => {
  const { uploadManager } = await import(`./.um-bundle.mjs?case=${caseTag}`);
  return uploadManager;
};

const makeStore = (status, heartbeatAgeMs, extra = {}) => ({
  version: 1,
  heartbeat: Date.now() - heartbeatAgeMs,
  ...(extra.unloadedAtAgeMs !== undefined ? { unloadedAt: Date.now() - extra.unloadedAtAgeMs } : {}),
  tasks: [{
    id: "t1", name: "big.iso", size: 500 * 1024 * 1024,
    storageId: 1, dirPath: "docs", uploadPath: "docs/big.iso",
    contentType: "application/octet-stream", chunkSize: 10 * 1024 * 1024,
    mode: "multipart", status, hasHandle: false, addedAt: Date.now() - 60_000,
    uploadId: "upload-xyz",
    completedParts: [{ partNumber: 1, etag: "a1" }, { partNumber: 2, etag: "a2" }],
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "unloadedAtAgeMs")),
  }],
});

const waitNotify = async (um, pred, timeoutMs) => {
  const start = Date.now();
  let last = um.getSnapshot();
  while (Date.now() - start < timeoutMs) {
    await sleep(300);
    last = um.getSnapshot();
    if (pred(last)) return last;
  }
  return last;
};

// ===== 场景 C：心跳早已过期（>8s）→ 立即可恢复 =====
mem.clear();
mem.set(STORE_KEY, JSON.stringify(makeStore("uploading", 30_000)));
{
  const um = await freshManager("c");
  const snap = um.getSnapshot();
  assert(snap.length === 1 && snap[0].status === "waiting-file",
    `C1: 过期心跳 → 立即 waiting-file (实际: ${snap.map((t) => t.status).join(",")})`);
  assert(snap[0]?.currentPart === 2, `C2: 已完成分片数恢复为 2 (实际: ${snap[0]?.currentPart})`);
}

// ===== 场景 A：上传中刷新（心跳 2s 前写入，无其他标签页续写）=====
mem.clear();
mem.set(STORE_KEY, JSON.stringify(makeStore("uploading", 2_000)));
{
  const um = await freshManager("a");
  const snap0 = um.getSnapshot();
  assert(snap0.length === 1 && snap0[0].status === "checking",
    `A1: 刷新后先显示"检测中" (实际: ${snap0.map((t) => t.status).join(",")})`);
  const snap = await waitNotify(um, (s) => s[0]?.status === "waiting-file", 12_000);
  assert(snap[0]?.status === "waiting-file",
    `A2: 10s 后自动转可恢复 waiting-file，不死锁 remote (实际: ${snap[0]?.status})`);
}

// ===== 场景 B：真的有另一个标签页在跑 =====
mem.clear();
mem.set(STORE_KEY, JSON.stringify(makeStore("uploading", 2_000)));
{
  const um = await freshManager("b");
  um.getSnapshot(); // 触发 init → checking
  const beat = setInterval(() => {
    const raw = mem.get(STORE_KEY);
    if (raw) { const d = JSON.parse(raw); d.heartbeat = Date.now(); mem.set(STORE_KEY, JSON.stringify(d)); }
  }, 4_000);
  const snapRemote = await waitNotify(um, (s) => s[0]?.status === "remote", 12_000);
  assert(snapRemote[0]?.status === "remote",
    `B1: 其他标签页心跳存活 → 只读 remote (实际: ${snapRemote[0]?.status})`);
  clearInterval(beat); // 对方标签页被杀
  const snapStuck = await waitNotify(um, (s) => s[0]?.status === "waiting-file", 30_000);
  assert(snapStuck[0]?.status === "waiting-file",
    `B2: 对方心跳停止 → 看门狗转可恢复 (实际: ${snapStuck[0]?.status})`);
}

// ===== 场景 D：干净卸载标记（刷新）→ 立即恢复，不经过"检测中" =====
mem.clear();
mem.set(STORE_KEY, JSON.stringify(makeStore("uploading", 0, { unloadedAtAgeMs: 0 })));
{
  const um = await freshManager("d");
  const snap = um.getSnapshot();
  assert(snap[0]?.status === "waiting-file",
    `D: 刷新(带卸载标记) → 立即可恢复，无需等 10s (实际: ${snap[0]?.status})`);
}

// ===== 场景 E：卸载标记之后又有其他标签页写心跳 → 仍按"可能有其他页"走检测 =====
mem.clear();
mem.set(STORE_KEY, JSON.stringify(makeStore("uploading", 0, { unloadedAtAgeMs: 6000 })));
{
  const um = await freshManager("e");
  const snap = um.getSnapshot();
  assert(snap[0]?.status === "checking",
    `E: 卸载后仍有别的标签页心跳 → 先检测，不误恢复 (实际: ${snap[0]?.status})`);
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 个断言失败`);
process.exit(failed === 0 ? 0 : 1);
