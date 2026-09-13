import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startServer, http, createAndSubmit, schemeInput, rope, ZHOU, SHEN, HE } from "./helpers.js";

describe("并发提交", () => {
  let srv;
  beforeEach(async () => { srv = await startServer(); });
  afterEach(async () => { await srv.stop(); });

  test("10 个并发同名提交：恰好 1 个成功，其余 409 重名", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        http(srv.base, "POST", "/api/review/schemes", { user: ZHOU, body: schemeInput({ name: "并发撞名方案" }) })
      )
    );
    const ok = results.filter(r => r.status === 201);
    const dup = results.filter(r => r.status === 409 && r.data.error === "duplicate_name");
    assert.equal(ok.length, 1, "只有一个提交落库");
    assert.equal(dup.length, 9);
    const list = await http(srv.base, "GET", "/api/review/schemes");
    assert.equal(list.data.schemes.filter(s => s.name === "并发撞名方案").length, 1);
  });

  test("并发逐项评审基于同一 rev：只有第一次生效，其余拒绝陈旧版本", async () => {
    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "并发评审方案", ropes: [rope()] }));
    const s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    const ropeId = s.ropes[0].id;
    const payload = { ropeId, verdict: "approved", reason: "", baseRev: s.rev };
    const results = await Promise.all([
      http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, { user: SHEN, body: payload }),
      http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, { user: HE, body: payload }),
      http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, { user: HE, body: payload })
    ]);
    const ok = results.filter(r => r.status === 200);
    const stale = results.filter(r => r.status === 409 && r.data.error === "stale_rev");
    assert.equal(ok.length, 1);
    assert.equal(stale.length, 2);
    const after = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    assert.equal(after.progress.approved, 1);
    assert.equal(after.decisions.length, 1, "没有重复评审记录");
  });

  test("并发执行登记不会丢记录（互斥串行）", async () => {
    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "并发执行方案", ropes: [rope()] }));
    let s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    const d = await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: SHEN, body: { ropeId: s.ropes[0].id, verdict: "approved", baseRev: s.rev }
    });
    await http(srv.base, "POST", `/api/review/schemes/${id}/lock`, {
      user: HE, body: { baseRev: d.data.rev }
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        http(srv.base, "POST", `/api/review/schemes/${id}/executions`, { user: ZHOU, body: { note: `执行记录 #${i}` } })
      )
    );
    assert.equal(results.filter(r => r.status === 201).length, 8);
    const after = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    assert.equal(after.executions.length, 8);
    const notes = after.executions.map(e => e.note).sort();
    assert.deepEqual(notes, Array.from({ length: 8 }, (_, i) => `执行记录 #${i}`).sort());
  });
});
