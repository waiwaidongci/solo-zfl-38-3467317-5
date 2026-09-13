import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startServer, http, createAndSubmit, schemeInput, rope, ZHOU, LIN, SHEN, HE } from "./helpers.js";

describe("越权与身份校验", () => {
  let srv;
  beforeEach(async () => { srv = await startServer(); });
  afterEach(async () => { await srv.stop(); });

  test("未选择身份一律拒绝", async () => {
    const r = await http(srv.base, "POST", "/api/review/schemes", { body: schemeInput() });
    assert.equal(r.status, 401);
    assert.equal(r.data.error, "unknown_user");
    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "鉴权方案" }));
    const d = await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      body: { ropeId: "x", verdict: "approved" }
    });
    assert.equal(d.status, 401);
  });

  test("不存在的成员拒绝", async () => {
    const r = await http(srv.base, "POST", "/api/review/schemes", { user: "ghost", body: schemeInput() });
    assert.equal(r.status, 401);
  });

  test("评审人不能提交方案，建模师不能评审/锁定", async () => {
    const asReviewer = await http(srv.base, "POST", "/api/review/schemes", { user: SHEN, body: schemeInput() });
    assert.equal(asReviewer.status, 403);
    assert.equal(asReviewer.data.error, "modeler_only");

    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "角色隔离方案", ropes: [rope()] }));
    let s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    const decideByModeler = await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: LIN, body: { ropeId: s.ropes[0].id, verdict: "approved", baseRev: s.rev }
    });
    assert.equal(decideByModeler.status, 403);
    assert.equal(decideByModeler.data.error, "reviewer_only");

    const lockByModeler = await http(srv.base, "POST", `/api/review/schemes/${id}/lock`, {
      user: ZHOU, body: { baseRev: s.rev }
    });
    assert.equal(lockByModeler.status, 403);
  });

  test("提交人不能自评，也不能由其他建模师代评", async () => {
    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "自评禁止方案", ropes: [rope()] }));
    const s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    const self = await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: ZHOU, body: { ropeId: s.ropes[0].id, verdict: "approved", baseRev: s.rev }
    });
    assert.equal(self.status, 403);
    assert.equal(self.data.error, "self_review_forbidden");
  });

  test("非提交人不能编辑/提交/修订他人草稿", async () => {
    const created = await http(srv.base, "POST", "/api/review/schemes", { user: ZHOU, body: schemeInput({ name: "归属方案" }) });
    const id = created.data.id;
    const other = await http(srv.base, "PUT", `/api/review/schemes/${id}`, {
      user: LIN, body: { ...schemeInput({ name: "归属方案" }), baseRev: created.data.rev }
    });
    assert.equal(other.status, 403);
    assert.equal(other.data.error, "not_submitter");
    const submitOther = await http(srv.base, "POST", `/api/review/schemes/${id}/submit`, {
      user: LIN, body: { baseRev: created.data.rev }
    });
    assert.equal(submitOther.status, 403);
  });

  test("退回不写理由拒绝；非法结论拒绝", async () => {
    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "理由必填方案", ropes: [rope()] }));
    const s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    const noReason = await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: SHEN, body: { ropeId: s.ropes[0].id, verdict: "returned", reason: "  ", baseRev: s.rev }
    });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.data.error, "return_reason_required");
    const bad = await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: SHEN, body: { ropeId: s.ropes[0].id, verdict: "maybe", baseRev: s.rev }
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, "bad_verdict");
  });

  test("未全部逐项通过时锁定被拒绝并列出阻塞", async () => {
    const id = await createAndSubmit(srv, ZHOU, schemeInput({ name: "锁定门槛方案", ropes: [rope(), rope({ position: "后桅支索" })] }));
    const s = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    // 只通过第一根
    await http(srv.base, "POST", `/api/review/schemes/${id}/decisions`, {
      user: SHEN, body: { ropeId: s.ropes[0].id, verdict: "approved", baseRev: s.rev }
    });
    const s2 = (await http(srv.base, "GET", `/api/review/schemes/${id}`)).data;
    const lock = await http(srv.base, "POST", `/api/review/schemes/${id}/lock`, {
      user: HE, body: { baseRev: s2.rev }
    });
    assert.equal(lock.status, 409);
    assert.equal(lock.data.error, "cannot_lock");
    assert.deepEqual(lock.data.details.pending, ["后桅支索"]);
  });
});
