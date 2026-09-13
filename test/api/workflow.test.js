import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startServer, http, createAndSubmit, schemeInput, rope, ZHOU, LIN, SHEN, HE } from "./helpers.js";

describe("完整评审工作流", () => {
  let srv;
  beforeEach(async () => { srv = await startServer(); });
  afterEach(async () => { await srv.stop(); });

  test("提交→逐项评审→退回→修订新版本→通过锁定→执行记录→复制", async () => {
    // 1. 建模师周宁保存草稿
    const created = await http(srv.base, "POST", "/api/review/schemes", { user: ZHOU, body: schemeInput() });
    assert.equal(created.status, 201);
    const v1Id = created.data.id;
    assert.equal(created.data.status, "draft");
    assert.equal(created.data.version, 1);
    assert.equal(created.data.progress.total, 2);
    assert.equal(created.data.progress.pending, 2);

    // 2. 草稿可原地编辑
    const edited = await http(srv.base, "PUT", `/api/review/schemes/${v1Id}`, {
      user: ZHOU,
      body: { ...schemeInput({ summary: "补充概述" }), baseRev: created.data.rev }
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.version, 1, "草稿编辑不产生新版本");
    assert.equal(edited.data.summary, "补充概述");

    // 3. 提交评审
    const submitted = await http(srv.base, "POST", `/api/review/schemes/${v1Id}/submit`, {
      user: ZHOU, body: { baseRev: edited.data.rev }
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.data.status, "in_review");

    // 4. 评审人沈砚逐项通过第一根
    const r1 = submitted.data.ropes[0], r2 = submitted.data.ropes[1];
    const a1 = await http(srv.base, "POST", `/api/review/schemes/${v1Id}/decisions`, {
      user: SHEN, body: { ropeId: r1.id, verdict: "approved", baseRev: submitted.data.rev }
    });
    assert.equal(a1.status, 200);
    assert.equal(a1.data.progress.approved, 1);
    assert.equal(a1.data.progress.pending, 1);
    assert.equal(a1.data.status, "in_review");

    // 5. 第二根退回，必须写理由；方案整体变为已退回并出现阻塞
    const ret = await http(srv.base, "POST", `/api/review/schemes/${v1Id}/decisions`, {
      user: HE, body: { ropeId: r2.id, verdict: "returned", reason: "安全区间上限高于材料推荐值", baseRev: a1.data.rev }
    });
    assert.equal(ret.status, 200);
    assert.equal(ret.data.status, "returned");
    assert.equal(ret.data.blockers.length, 1);
    assert.equal(ret.data.blockers[0].position, r2.position);
    assert.match(ret.data.blockers[0].reason, /材料推荐值/);
    assert.equal(ret.data.blockers[0].reviewerName, "何岚");

    // 概览里有待处理项与阻塞原因
    const overview = await http(srv.base, "GET", "/api/review/overview");
    assert.equal(overview.status, 200);
    assert.ok(overview.data.blockers.some(b => b.schemeId === v1Id));
    assert.equal(overview.data.byStatus.returned, 1);

    // 6. 退回后不能锁定
    const lockBad = await http(srv.base, "POST", `/api/review/schemes/${v1Id}/lock`, {
      user: SHEN, body: { baseRev: ret.data.rev }
    });
    assert.equal(lockBad.status, 409);
    assert.equal(lockBad.data.error, "cannot_lock");
    assert.equal(lockBad.data.details.returned.length, 1);

    // 7. 建模师修订 → 生成 v2 草稿（评审结论不继承）
    const revise = await http(srv.base, "POST", `/api/review/schemes/${v1Id}/revise`, { user: ZHOU });
    assert.equal(revise.status, 200);
    const v2Id = revise.data.id;
    assert.notEqual(v2Id, v1Id);
    assert.equal(revise.data.version, 2);
    assert.equal(revise.data.status, "draft");
    assert.equal(revise.data.decisions.length, 0);
    assert.equal(revise.data.progress.pending, 2);

    // v2 提交后 v1 变为 superseded
    const submit2 = await http(srv.base, "POST", `/api/review/schemes/${v2Id}/submit`, {
      user: ZHOU, body: { baseRev: revise.data.rev }
    });
    assert.equal(submit2.status, 200);
    const oldV1 = await http(srv.base, "GET", `/api/review/schemes/${v1Id}`);
    assert.equal(oldV1.data.status, "superseded");
    assert.equal(oldV1.data.isLatest, false);
    assert.equal(submit2.data.isLatest, true);

    // 8. v2 两根全部通过后锁定
    let cur = submit2.data;
    for (const ropeItem of cur.ropes) {
      const d = await http(srv.base, "POST", `/api/review/schemes/${v2Id}/decisions`, {
        user: SHEN, body: { ropeId: ropeItem.id, verdict: "approved", baseRev: cur.rev }
      });
      assert.equal(d.status, 200, JSON.stringify(d.data));
      cur = d.data;
    }
    assert.equal(cur.progress.approved, 2);
    assert.equal(cur.canLock, true);
    const locked = await http(srv.base, "POST", `/api/review/schemes/${v2Id}/lock`, {
      user: HE, body: { baseRev: cur.rev }
    });
    assert.equal(locked.status, 200);
    assert.equal(locked.data.status, "locked");
    assert.ok(locked.data.lockedAt);

    // 9. 锁定版本登记执行记录，并快照帆索参数
    const exec = await http(srv.base, "POST", `/api/review/schemes/${v2Id}/executions`, {
      user: ZHOU, body: { note: "按 v2 基准完成前桅侧支索张紧，张力计 12N" }
    });
    assert.equal(exec.status, 201);
    assert.equal(exec.data.execution.snapshot.version, 2);
    assert.equal(exec.data.execution.snapshot.ropes.length, 2);
    assert.equal(exec.data.scheme.executions.length, 1);

    // 10. 从已锁定方案复制为独立新方案：不继承评审与执行记录
    const copy = await http(srv.base, "POST", `/api/review/schemes/${v2Id}/copy`, {
      user: LIN, body: { name: "福船 MR-002 借鉴方案" }
    });
    assert.equal(copy.status, 200);
    assert.equal(copy.data.version, 1);
    assert.equal(copy.data.status, "draft");
    assert.equal(copy.data.submitterId, LIN);
    assert.equal(copy.data.decisions.length, 0);
    assert.equal(copy.data.executions.length, 0);
    assert.equal(copy.data.key, locked.data.key === copy.data.key ? "same" : copy.data.key);
    assert.notEqual(copy.data.key, locked.data.key);
    assert.equal(copy.data.ropes.length, 2, "帆索条目内容被复制");
    assert.notEqual(copy.data.ropes[0].id, locked.data.ropes[0].id, "条目 id 重新生成");
    assert.equal(copy.data.copiedFrom.version, 2);

    // 复制方案的任何操作不影响原锁定方案的执行记录
    await http(srv.base, "POST", `/api/review/schemes/${copy.data.id}/submit`, {
      user: LIN, body: { baseRev: copy.data.rev }
    });
    let copyCur = (await http(srv.base, "GET", `/api/review/schemes/${copy.data.id}`)).data;
    for (const ropeItem of copyCur.ropes) {
      const d = await http(srv.base, "POST", `/api/review/schemes/${copy.data.id}/decisions`, {
        user: SHEN, body: { ropeId: ropeItem.id, verdict: "approved", baseRev: copyCur.rev }
      });
      copyCur = d.data;
    }
    await http(srv.base, "POST", `/api/review/schemes/${copy.data.id}/lock`, {
      user: SHEN, body: { baseRev: copyCur.rev }
    });
    await http(srv.base, "POST", `/api/review/schemes/${copy.data.id}/executions`, {
      user: LIN, body: { note: "MR-002 现场执行一次" }
    });
    const originalAgain = await http(srv.base, "GET", `/api/review/schemes/${v2Id}`);
    assert.equal(originalAgain.data.executions.length, 1, "原方案执行记录不受复制方案影响");
    assert.equal(originalAgain.data.status, "locked");
    assert.equal(originalAgain.data.executions[0].note, "按 v2 基准完成前桅侧支索张紧，张力计 12N");

    // 列表中是两个独立方案族
    const list = await http(srv.base, "GET", "/api/review/schemes");
    const keys = new Set(list.data.schemes.map(s => s.key));
    assert.equal(keys.size, 2);
  });

  test("评审人可改判：退回后重新通过则阻塞解除", async () => {
    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "改判测试方案", ropes: [rope()] }));
    let s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    const ropeId = s.ropes[0].id;
    await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: SHEN, body: { ropeId, verdict: "returned", reason: "缺张力计依据", baseRev: s.rev }
    });
    s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    assert.equal(s.status, "returned");
    assert.equal(s.blockers.length, 1);
    const flip = await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: HE, body: { ropeId, verdict: "approved", baseRev: s.rev }
    });
    assert.equal(flip.status, 200);
    assert.equal(flip.data.status, "in_review");
    assert.equal(flip.data.blockers.length, 0);
    assert.equal(flip.data.progress.approved, 1);
    assert.equal(flip.data.canLock, true);
  });
});
