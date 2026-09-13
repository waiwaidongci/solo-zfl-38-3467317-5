import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server.js";

// 每个用例使用独立的临时数据目录，互不干扰。
export async function startServer() {
  const dir = await mkdtemp(join(tmpdir(), "review-test-"));
  process.env.REVIEW_DB = join(dir, "review.json");
  process.env.CAL_DB = join(dir, "cal.json");
  const server = createServer();
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    dir,
    stop: async () => {
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export async function http(base, method, path, { user, body, raw } = {}) {
  const headers = {};
  if (user) headers["X-User-Id"] = user;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { status: res.status, data, headers: res.headers };
}

export const ZHOU = "zhou"; // 建模师 周宁
export const LIN = "lin";   // 建模师 林远
export const SHEN = "shen"; // 评审人 沈砚
export const HE = "he";     // 评审人 何岚

export function rope(over = {}) {
  return {
    position: "前桅侧支索",
    initialTension: "12 N",
    safeRange: "10–14 N",
    material: "0.8mm 浸蜡麻线",
    steps: "先松半圈，张力计复核至 12N",
    risk: "受潮后伸长约 3%",
    ...over
  };
}

export function schemeInput(over = {}) {
  return {
    name: "福船 MR-001 张力方案",
    modelCode: "MR-001",
    shipType: "福船",
    summary: "首调",
    ropes: [rope(), rope({ position: "后桅升帆索", initialTension: "9 N", safeRange: "8–11 N" })],
    ...over
  };
}

// 创建 → 提交评审 的常用快捷路径。
export async function createAndSubmit(harness, user, input = schemeInput()) {
  const created = await http(harness.base, "POST", "/api/review/schemes", { user, body: input });
  const id = created.data.id;
  await http(harness.base, "POST", `/api/review/schemes/${id}/submit`, { user, body: { baseRev: created.data.rev } });
  return id;
}
