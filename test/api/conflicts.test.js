import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startServer, http, createAndSubmit, schemeInput, rope, ZHOU, LIN, SHEN, HE } from "./helpers.js";

describe("重名、版本与过期保护", () => {
  let srv;
  beforeEach(async () => { srv = await startServer(); });
  afterEach(async () => { await srv.stop(); });

  test("方案重名拒绝（包括不同提交人）", async () => {
    const a = await http(srv.base, "POST", "/api/review/schemes", { user: ZHOU, body: schemeInput({ name: "同名张力方案" }) });
    assert.equal(a.status, 201);
    const b = await http(srv.base, "POST", "/api/review/schemes", { user: LIN, body: schemeInput({ name: "同名张力方案" }) });
    assert.equal(b.status, 409);
    assert.equal(b.data.error, "duplicate_name");
    // 同族修订允许沿用原名
    await http(srv.base, "POST", `/api/review/schemes/${a.data.id}/submit`, { user: ZHOU, body: { baseRev: a.data.rev } });
    const submitted = (await http(srv.base, "GET", `/api/review/schemes/${a.data.id}`)).data;
    await http(srv.base, "POST", `/api/review/schemes/${a.data.id}/decisions`, {
      user: SHEN, body: { ropeId: submitted.ropes[0].id, verdict: "returned", reason: "退回触发修订", baseRev: submitted.rev }
    });
    const revise = await http(srv.base, "POST", `/api/review/schemes/${a.data.id}/revise`, { user: ZHOU });
    assert.equal(revise.status, 200);
    assert.equal(revise.data.name, "同名张力方案");
    // 复制时默认“原名 副本”不撞名，显式撞名则拒绝
    const v2 = await http(srv.base, "POST", `/api/review/schemes/${revise.data.id}/submit`, {
      user: ZHOU, body: { baseRev: revise.data.rev }
    });
    let cur = v2.data;
    for (const r of cur.ropes) {
      const d = await http(srv.base, "POST", `/api/review/schemes/${cur.id}/decisions`, {
        user: SHEN, body: { ropeId: r.id, verdict: "approved", baseRev: cur.rev }
      });
      cur = d.data;
    }
    await http(srv.base, "POST", `/api/review/schemes/${cur.id}/lock`, { user: SHEN, body: { baseRev: cur.rev } });
    const dupCopy = await http(srv.base, "POST", `/api/review/schemes/${cur.id}/copy`, {
      user: LIN, body: { name: "同名张力方案" }
    });
    assert.equal(dupCopy.status, 409);
  });

  test("过期版本（superseded）拒绝评审与修订", async () => {
    const input = schemeInput({ name: "过期版本方案", ropes: [rope()] });
    const id = await createAndSubmit(srv, ZHOU, input);
    let s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    // 评审退回
    await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: SHEN, body: { ropeId: s.ropes[0].id, verdict: "returned", reason: "需要补充", baseRev: s.rev }
    });
    // 生成 v2 草稿并提交 → v1 过期
    const v2 = await http(srv.base, "POST", `/api/review/schemes/${id}/revise`, { user: ZHOU });
    await http(srv.base, "POST", `/api/review/schemes/${v2.data.id}/submit`, { user: ZHOU, body: { baseRev: v2.data.rev } });

    const old = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    assert.equal(old.status, "superseded");
    const decideOld = await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: SHEN, body: { ropeId: old.ropes[0].id, verdict: "approved", baseRev: old.rev }
    });
    assert.equal(decideOld.status, 409);
    assert.equal(decideOld.data.error, "version_superseded");
    const reviseOld = await http(srv.base, "POST", `/api/review/schemes/${id}/revise`, { user: ZHOU });
    assert.equal(reviseOld.status, 409);
    const lockOld = await http(srv.base, "POST", `/api/review/schemes/${id}/lock`, {
      user: SHEN, body: { baseRev: old.rev }
    });
    assert.equal(lockOld.status, 409);
  });

  test("锁定后不可改动、不可评审、不可修订，只能复制；锁定前不能登记执行", async () => {
    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "锁定保护方案", ropes: [rope()] }));
    let s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: SHEN, body: { ropeId: s.ropes[0].id, verdict: "approved", baseRev: s.rev }
    });
    s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;

    const execBefore = await http(srv.base, "POST", `/api/review/schemes/${id}/executions`, {
      user: ZHOU, body: { note: "抢先执行" }
    });
    assert.equal(execBefore.status, 409);
    assert.equal(execBefore.data.error, "execution_requires_locked");

    await http(srv.base, "POST", `/api/review/schemes/${id}/lock`, { user: SHEN, body: { baseRev: s.rev } });
    const locked = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;

    const edit = await http(srv.base, "PUT", `/api/review/schemes/${id}`, {
      user: ZHOU, body: { ...schemeInput({ name: "锁定保护方案" }), baseRev: locked.rev }
    });
    assert.equal(edit.status, 409, JSON.stringify(edit.data));
    const decide = await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: HE, body: { ropeId: locked.ropes[0].id, verdict: "approved", baseRev: locked.rev }
    });
    assert.equal(decide.status, 409);
    const revise = await http(srv.base, "POST", `/api/review/schemes/${id}/revise`, { user: ZHOU });
    assert.equal(revise.status, 409);
    assert.equal(revise.data.error, "locked_use_copy");
    const lockAgain = await http(srv.base, "POST", `/api/review/schemes/${id}/lock`, {
      user: SHEN, body: { baseRev: locked.rev }
    });
    assert.equal(lockAgain.status, 409);
  });

  test("只能复制已锁定的方案；在审版本复制被拒绝", async () => {
    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "复制门槛方案", ropes: [rope()] }));
    const inReview = await http(srv.base, "POST", `/api/review/schemes/${id}/copy`, {
      user: LIN, body: { name: "借鉴在审方案" }
    });
    assert.equal(inReview.status, 409);
    assert.equal(inReview.data.error, "copy_requires_locked");
  });

  test("陈旧 rev（过期读改写）拒绝而不是覆盖", async () => {
    const created = await http(srv.base, "POST", "/api/review/schemes", { user: ZHOU, body: schemeInput({ name: "并发编辑方案" }) });
    const id = created.data.id;
    // 第一次编辑成功
    const first = await http(srv.base, "PUT", `/api/review/schemes/${id}`, {
      user: ZHOU, body: { ...schemeInput({ name: "并发编辑方案", summary: "第一次" }), baseRev: created.data.rev }
    });
    assert.equal(first.status, 200);
    // 用旧 rev 再写 → 拒绝
    const stale = await http(srv.base, "PUT", `/api/review/schemes/${id}`, {
      user: ZHOU, body: { ...schemeInput({ name: "并发编辑方案", summary: "第二次（陈旧）" }), baseRev: created.data.rev }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error, "stale_rev");
    assert.equal(stale.data.details.currentRev, first.data.rev);
    const now = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    assert.equal(now.summary, "第一次", "陈旧写入未覆盖新数据");
  });

  test("草稿字段校验：名称、逐根六项必填", async () => {
    const noName = await http(srv.base, "POST", "/api/review/schemes", {
      user: ZHOU, body: schemeInput({ name: "  " })
    });
    assert.equal(noName.status, 400);
    assert.equal(noName.data.error, "name_required");
    const emptyRopes = await http(srv.base, "POST", "/api/review/schemes", {
      user: ZHOU, body: schemeInput({ ropes: [] })
    });
    assert.equal(emptyRopes.status, 400);
    assert.equal(emptyRopes.data.error, "ropes_required");
    const badRope = await http(srv.base, "POST", "/api/review/schemes", {
      user: ZHOU, body: schemeInput({ ropes: [rope({ safeRange: "" })] })
    });
    assert.equal(badRope.status, 400);
    assert.equal(badRope.data.error, "rope_field_required");
    assert.equal(badRope.data.details.field, "safeRange");
  });
});
