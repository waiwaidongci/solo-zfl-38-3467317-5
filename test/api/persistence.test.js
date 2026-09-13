import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../server.js";
import { http, schemeInput, rope, ZHOU, SHEN, HE } from "./helpers.js";

function listen(server) {
  return new Promise(resolve => server.listen(0, resolve));
}

describe("重启后数据保留", () => {
  test("进程重启：方案、版本、评审结论、锁定状态与执行记录全部保留", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-persist-"));
    const reviewDb = join(dir, "review.json");
    const calDb = join(dir, "cal.json");
    let server = createServer({ reviewDb, calDb });
    await listen(server);
    let base = `http://127.0.0.1:${server.address().port}`;

    // 第一轮：建草稿 → 退回 → v2 → 全过锁定 → 执行记录
    let r = await http(base, "POST", "/api/review/schemes", { user: ZHOU, body: schemeInput({ ropes: [rope()] }) });
    const v1 = r.data.id;
    await http(base, "POST", `/api/review/schemes/${v1}/submit`, { user: ZHOU, body: { baseRev: r.data.rev } });
    let s = (await http(base, "GET", `/api/review/schemes/${v1}`)).data;
    await http(base, "POST", `/api/review/schemes/${v1}/decisions`, {
      user: SHEN, body: { ropeId: s.ropes[0].id, verdict: "returned", reason: "v1 退回理由要持久化", baseRev: s.rev }
    });
    const v2 = (await http(base, "POST", `/api/review/schemes/${v1}/revise`, { user: ZHOU })).data;
    await http(base, "POST", `/api/review/schemes/${v2.id}/submit`, { user: ZHOU, body: { baseRev: v2.rev } });
    s = (await http(base, "GET", `/api/review/schemes/${v2.id}`)).data;
    const d = await http(base, "POST", `/api/review/schemes/${v2.id}/decisions`, {
      user: HE, body: { ropeId: s.ropes[0].id, verdict: "approved", baseRev: s.rev }
    });
    await http(base, "POST", `/api/review/schemes/${v2.id}/lock`, { user: SHEN, body: { baseRev: d.data.rev } });
    await http(base, "POST", `/api/review/schemes/${v2.id}/executions`, { user: ZHOU, body: { note: "重启前登记的执行记录" } });

    // 落盘文件是合法 JSON
    const onDisk = JSON.parse(await readFile(reviewDb, "utf8"));
    assert.ok(onDisk.rev > 0);
    assert.equal(onDisk.schemes.length, 2);

    await new Promise(resolve => server.close(resolve));

    // —— 模拟重启：新建 server 指向同一数据文件 ——
    server = createServer({ reviewDb, calDb });
    await listen(server);
    base = `http://127.0.0.1:${server.address().port}`;

    const list = await http(base, "GET", "/api/review/schemes");
    assert.equal(list.data.schemes.length, 2);
    const v1After = list.data.schemes.find(x => x.id === v1);
    const v2After = list.data.schemes.find(x => x.id === v2.id);
    assert.equal(v1After.status, "superseded", "过期状态保留");
    assert.equal(v2After.status, "locked", "锁定状态保留");
    assert.equal(v2After.version, 2);
    assert.equal(v2After.progress.approved, 1);
    assert.equal(v2After.blockers.length, 0);
    assert.equal(v2After.executions.length, 1);
    assert.equal(v2After.executions[0].note, "重启前登记的执行记录");
    assert.equal(v1After.blockers[0].reason, "v1 退回理由要持久化");
    assert.ok(v2After.lockedAt);

    // 重启后锁定方案依然不可改动
    const edit = await http(base, "PUT", `/api/review/schemes/${v2.id}`, {
      user: ZHOU, body: { ...schemeInput({ name: v2After.name }), baseRev: v2After.rev }
    });
    assert.equal(edit.status, 409);

    // 概览统计也从磁盘恢复
    const overview = await http(base, "GET", "/api/review/overview");
    assert.equal(overview.data.byStatus.locked, 1);
    assert.equal(overview.data.byStatus.superseded, 1);
    assert.equal(overview.data.executionCount, 1);

    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
});
