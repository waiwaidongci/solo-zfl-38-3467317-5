import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./browser.js";

const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dirname, "..", "..");

let server, browser, page, dataDir;
let nextDialog = null;

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/api/review/team");
      if (res.ok) return;
    } catch { /* 尚未启动 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("npm start 服务未在限定时间内就绪");
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "review-e2e-"));
  server = spawn("npm start", {
    cwd: ROOT,
    shell: true,
    detached: true,
    env: {
      ...process.env,
      PORT: String(PORT),
      REVIEW_DB: join(dataDir, "review.json"),
      CAL_DB: join(dataDir, "cal.json")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", d => process.stdout.write(`[server] ${d}`));
  server.stderr.on("data", d => process.stderr.write(`[server] ${d}`));
  await waitForServer();
  browser = await launchBrowser();
  const context = await browser.newContext();
  page = await context.newPage();
  page.on("console", msg => {
    if (msg.type() === "error") console.log("[browser-console]", msg.text());
  });
  page.on("pageerror", err => console.log("[browser-pageerror]", err.message));
  page.on("dialog", async dialog => {
    if (nextDialog) { const value = nextDialog; nextDialog = null; await dialog.accept(value); }
    else await dialog.dismiss();
  });
});

after(async () => {
  await browser?.close();
  if (server) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* 已退出 */ }
  }
  await rm(dataDir, { recursive: true, force: true });
});

function setDialog(value) { nextDialog = value; }

async function selectUser(id) {
  await page.selectOption("#userSelect", id);
}

async function fillRope(index, values) {
  const box = page.locator(`[data-form-rope="${index}"]`);
  for (const [key, value] of Object.entries(values)) {
    await box.locator(`[data-rk="${key}"]`).fill(value);
  }
}

async function toastSeqNow() {
  const last = page.locator('[data-testid="toast"]').last();
  if (await last.count() === 0) return 0;
  return Number(await last.getAttribute("data-seq")) || 0;
}

async function expectToast(text) {
  const seq = await toastSeqNow();
  const newer = page.locator(`[data-testid="toast"][data-seq="${seq + 1}"]`);
  await newer.waitFor({ state: "visible", timeout: 5000 });
  await assert.match(await newer.textContent(), new RegExp(text));
}

const NAME = "E2E 福船张力方案";

test("真实浏览器走通：提交→逐项通过/退回→阻塞→修订新版本→锁定→执行记录", async () => {
  await page.goto(BASE);
  await assert.match(await page.title(), /评审台/);

  // 未选择身份时看不到建模入口
  assert.equal(await page.locator('[data-testid="new-scheme"]').count(), 0);

  // 建模师周宁提交方案（两根帆索）
  await selectUser("zhou");
  await page.click('[data-testid="new-scheme"]');
  await page.fill('[data-testid="f-name"]', NAME);
  await page.fill('[data-testid="f-code"]', "MR-E2E");
  await page.fill('[data-testid="f-ship"]', "福船");
  await page.click('[data-testid="rope-add"]');
  await fillRope(0, {
    position: "前桅侧支索",
    initialTension: "12 N",
    safeRange: "10–14 N",
    material: "0.8mm 浸蜡麻线",
    steps: "松半圈后张力计复核",
    risk: "受潮伸长"
  });
  await fillRope(1, {
    position: "后桅升帆索",
    initialTension: "9 N",
    safeRange: "8–11 N",
    material: "0.6mm 蜡线",
    steps: "收紧四分之一圈",
    risk: "过紧导致桅杆变形"
  });
  await page.click('[data-testid="form-save"]');
  await expectToast("草稿已创建");
  await page.waitForSelector('[data-testid="detail"]');

  // 提交评审
  await page.click('[data-testid="submit-review"]');
  await expectToast("进入组内评审");
  await page.locator(".pill.in_review", { hasText: "评审中" }).first().waitFor();

  // 提交人自己看不到评审按钮（禁止自评）
  assert.equal(await page.locator('[data-testid="approve"]').count(), 0);

  // 评审人沈砚：通过第 1 根，退回第 2 根并写理由
  await selectUser("shen");
  const ropes = page.locator('[data-testid="rope"]');
  await ropes.nth(0).locator('[data-testid="approve"]').click();
  await expectToast("已通过");
  await ropes.nth(1).locator('[data-testid="return"]').click();
  await page.fill('[data-testid="return-reason"]', "安全区间上限高于材料推荐值");
  await page.click('[data-testid="return-confirm"]');
  await expectToast("已退回");

  // 页面显示退回状态、阻塞原因与侧栏阻塞计数
  await page.locator(".pill.returned", { hasText: "已退回" }).first().waitFor();
  const blockerText = await page.locator('[data-testid="detail-blockers"]').textContent();
  assert.match(blockerText, /安全区间上限高于材料推荐值/);
  const sideBlockers = page.locator('[data-testid="blocker-box"]');
  await sideBlockers.waitFor({ state: "visible" });
  assert.match(await sideBlockers.textContent(), /后桅升帆索/);

  // 存在退回项时没有锁定按钮
  assert.equal(await page.locator('[data-testid="lock"]').count(), 0);

  // 建模师修订生成 v2 草稿
  await selectUser("zhou");
  await page.click('[data-testid="revise"]');
  await expectToast(/v2/);
  await page.locator(".pill", { hasText: "版本 v2" }).waitFor();
  await page.click('[data-testid="submit-review"]');
  await expectToast("进入组内评审");

  // v1 已过期：打开 v1，应看到过期横幅且没有任何操作按钮
  await page.click('[data-testid="back-list"]');
  await page.locator('[data-testid="scheme-card"]').first().click();
  const v1Pill = page.locator('.versions .pill', { hasText: "v1" });
  await v1Pill.click();
  await page.locator('[data-testid="stale-banner"]').waitFor();
  assert.equal(await page.locator('[data-testid="approve"]').count(), 0);
  assert.equal(await page.locator('[data-testid="lock"]').count(), 0);

  // 回到 v2，沈砚逐项通过后锁定
  await page.locator('.versions .pill', { hasText: "v2" }).click();
  await selectUser("shen");
  const v2ropes = page.locator('[data-testid="rope"]');
  const count = await v2ropes.count();
  assert.equal(count, 2);
  for (let i = 0; i < count; i++) {
    await v2ropes.nth(i).locator('[data-testid="approve"]').click();
    await expectToast("已通过");
  }
  await page.click('[data-testid="lock"]');
  await expectToast("已锁定");
  await page.locator(".pill.locked", { hasText: "已锁定" }).first().waitFor();

  // 锁定后登记执行记录
  await page.fill('[data-testid="exec-note"]', "现场按 v2 基准张紧，张力计复核合格");
  await page.click('[data-testid="exec-add"]');
  await expectToast("执行记录已登记");
  await page.locator('[data-testid="exec-list"]', { hasText: "张力计复核合格" }).waitFor();

  // 刷新页面（模拟重开）数据仍在
  await page.reload();
  await page.locator('[data-testid="scheme-card"]', { hasText: NAME }).waitFor();
  await page.locator('[data-testid="scheme-card"]').first().click();
  await page.locator(".pill.locked").first().waitFor();
  await page.locator('[data-testid="exec-list"]', { hasText: "张力计复核合格" }).waitFor();
});

test("拒绝类场景：重名、越权操作被拒；复制产生独立新方案且不带走执行记录", async () => {
  await page.goto(BASE);
  await selectUser("zhou");

  // 重名提交被拒（不刷新页面，toast 即错误反馈）
  await page.click('[data-testid="new-scheme"]');
  await page.fill('[data-testid="f-name"]', NAME);
  await fillRope(0, {
    position: "斜桁索", initialTension: "6 N", safeRange: "5–7 N",
    material: "棉线", steps: "微调", risk: "磨损"
  });
  await page.click('[data-testid="form-save"]');
  await expectToast("名称重复");
  await page.click('[data-testid="form-cancel"]');

  // 从已锁定方案复制为独立新方案（林远，使用 prompt 命名避免重名）
  await page.locator('[data-testid="scheme-card"]', { hasText: NAME }).first().click();
  await selectUser("lin");
  setDialog("E2E 复制借鉴方案");
  await page.click('[data-testid="copy"]');
  await expectToast("未继承");
  await page.locator(".pill", { hasText: "版本 v1" }).waitFor();
  // 复制件没有继承执行记录
  assert.match(await page.locator('[data-testid="exec-list"]').textContent(), /暂无执行记录/);
  // 复制件有 copiedFrom 提示
  await page.locator(".banner.info", { hasText: "复制自" }).waitFor();

  // 复制件提交后评审通过并锁定、登记执行，不影响原方案的执行记录
  await page.click('[data-testid="submit-review"]');
  await expectToast("进入组内评审");
  await selectUser("shen");
  const ropes = page.locator('[data-testid="rope"]');
  const ropeCount = await ropes.count();
  for (let i = 0; i < ropeCount; i++) {
    await ropes.nth(i).locator('[data-testid="approve"]').click();
    await expectToast("已通过");
  }
  await page.click('[data-testid="lock"]');
  await expectToast("已锁定");
  await page.fill('[data-testid="exec-note"]', "复制方案自己的执行记录");
  await page.click('[data-testid="exec-add"]');
  await expectToast("执行记录已登记");

  await page.goto(BASE);
  await page.locator('[data-testid="scheme-card"]', { hasText: NAME }).first().click();
  const execText = await page.locator('[data-testid="exec-list"]').textContent();
  assert.match(execText, /张力计复核合格/);
  assert.doesNotMatch(execText, /复制方案自己的执行记录/);

  // 评审人身份下没有“提交新方案”入口；已锁定方案也没有评审按钮
  await selectUser("shen");
  await page.goto(BASE);
  assert.equal(await page.locator('[data-testid="new-scheme"]').count(), 0);
  await page.locator('[data-testid="scheme-card"]', { hasText: NAME }).first().click();
  assert.equal(await page.locator('[data-testid="approve"]').count(), 0);
  assert.equal(await page.locator('[data-testid="return"]').count(), 0);
});
