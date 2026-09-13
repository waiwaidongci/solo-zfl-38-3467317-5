// 工艺方案评审台：领域逻辑 + JSON 文件持久化。
// 设计要点：
//  - 方案按“族 (key)”组织，每次改动产生新版本；旧版本不可变，新版本提交后旧版自动变为 superseded。
//  - 通过并锁定 (locked) 后不可改动，只能“复制”为另一个独立的新方案；执行记录挂在具体版本上，复制/修订都带不走。
//  - 进程内互斥串行所有写操作，配合每方案 rev 做乐观并发控制；落盘采用“临时文件 + rename”原子写。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { findMember, isModeler, isReviewer } from "./team.js";

export class ApiError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const SCHEME_STATUSES = ["draft", "in_review", "returned", "superseded", "locked"];
export const STATUS_LABELS = {
  draft: "草稿",
  in_review: "评审中",
  returned: "已退回",
  superseded: "已过期",
  locked: "已锁定"
};

const ROPE_FIELDS = [
  ["position", "索具位置"],
  ["initialTension", "初始张力"],
  ["safeRange", "安全区间"],
  ["material", "材料"],
  ["steps", "调试步骤"],
  ["risk", "风险"]
];

const EMPTY_DB = { rev: 0, schemes: [] };

// 串行写操作：失败也释放锁。
function createMutex() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
}

export class ReviewStore {
  constructor(dbPath, clock = () => new Date().toISOString()) {
    this.dbPath = dbPath;
    this.now = clock;
    this.withLock = createMutex();
  }

  async #load() {
    if (!existsSync(this.dbPath)) {
      await mkdir(dirname(this.dbPath), { recursive: true });
      await writeFile(this.dbPath, JSON.stringify(EMPTY_DB, null, 2));
      return structuredClone(EMPTY_DB);
    }
    const raw = JSON.parse(await readFile(this.dbPath, "utf8"));
    return { rev: raw.rev || 0, schemes: raw.schemes || [] };
  }

  async #save(db) {
    db.rev = (db.rev || 0) + 1;
    const tmp = `${this.dbPath}.tmp-${process.pid}-${db.rev}`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, this.dbPath);
    return db;
  }

  async #mutate(fn) {
    return this.withLock(async () => {
      const db = await this.#load();
      const result = await fn(db);
      await this.#save(db);
      return result;
    });
  }

  #view(scheme, db) {
    const latest = db.schemes
      .filter(s => s.key === scheme.key && s.status !== "superseded")
      .sort((a, b) => b.version - a.version)[0];
    const decisionByRope = new Map();
    for (const d of scheme.decisions) {
      const prev = decisionByRope.get(d.ropeId);
      if (!prev || d.at >= prev.at) decisionByRope.set(d.ropeId, d);
    }
    const approved = [], returned = [], pending = [];
    for (const rope of scheme.ropes) {
      const d = decisionByRope.get(rope.id);
      if (!d) pending.push(rope);
      else if (d.verdict === "approved") approved.push(rope);
      else returned.push(rope);
    }
    const blockers = returned.map(rope => {
      const d = decisionByRope.get(rope.id);
      const member = findMember(d.reviewerId);
      return {
        ropeId: rope.id,
        position: rope.position,
        reason: d.reason,
        reviewerId: d.reviewerId,
        reviewerName: member ? member.name : d.reviewerId,
        at: d.at
      };
    });
    return {
      ...structuredClone(scheme),
      isLatest: latest ? latest.id === scheme.id : true,
      progress: {
        total: scheme.ropes.length,
        approved: approved.length,
        returned: returned.length,
        pending: pending.length
      },
      blockers,
      canLock: scheme.status === "in_review"
        && approved.length === scheme.ropes.length
        && scheme.ropes.length > 0
    };
  }

  async list() {
    const db = await this.#load();
    return db.schemes
      .map(s => this.#view(s, db))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async overview() {
    const db = await this.#load();
    const views = db.schemes.map(s => this.#view(s, db));
    const byStatus = Object.fromEntries(SCHEME_STATUSES.map(s => [s, 0]));
    const pendingItems = [];
    const blockers = [];
    for (const v of views) {
      byStatus[v.status] += 1;
      if (v.isLatest && (v.status === "in_review" || v.status === "returned")) {
        const latestDecision = new Map();
        for (const d of v.decisions) {
          const prev = latestDecision.get(d.ropeId);
          if (!prev || d.at >= prev.at) latestDecision.set(d.ropeId, d);
        }
        for (const rope of v.ropes) {
          const d = latestDecision.get(rope.id);
          if (!d) {
            pendingItems.push({
              schemeId: v.id, name: v.name, version: v.version,
              ropeId: rope.id, position: rope.position
            });
          }
        }
        for (const b of v.blockers) {
          blockers.push({
            schemeId: v.id, name: v.name, version: v.version, ...b
          });
        }
      }
    }
    return {
      byStatus,
      labels: STATUS_LABELS,
      pendingCount: pendingItems.length,
      pendingItems,
      blockers,
      executionCount: views.reduce((n, v) => n + v.executions.length, 0)
    };
  }

  async get(id) {
    const db = await this.#load();
    const scheme = db.schemes.find(s => s.id === id);
    if (!scheme) throw new ApiError(404, "scheme_not_found");
    return this.#view(scheme, db);
  }

  #requireUser(userId) {
    const member = findMember(userId);
    if (!member) throw new ApiError(401, "unknown_user");
    return member;
  }

  #validateRopes(ropes) {
    if (!Array.isArray(ropes) || ropes.length === 0) {
      throw new ApiError(400, "ropes_required");
    }
    return ropes.map((rope, i) => {
      const out = { id: rope.id && typeof rope.id === "string" ? rope.id : randomUUID() };
      for (const [key, label] of ROPE_FIELDS) {
        const value = String(rope[key] ?? "").trim();
        if (!value) throw new ApiError(400, "rope_field_required", { index: i, field: key, label });
        out[key] = value;
      }
      return out;
    });
  }

  #validateMeta(input) {
    const name = String(input.name ?? "").trim();
    if (!name) throw new ApiError(400, "name_required");
    return {
      name,
      modelCode: String(input.modelCode ?? "").trim(),
      shipType: String(input.shipType ?? "").trim(),
      summary: String(input.summary ?? "").trim()
    };
  }

  #checkNameUnique(db, name, familyKey) {
    if (db.schemes.some(s => s.key !== familyKey && s.name === name)) {
      throw new ApiError(409, "duplicate_name", { name });
    }
  }

  // 建模师提交方案（首版草稿，随后可提交评审）。
  async create(actorId, input) {
    const actor = this.#requireUser(actorId);
    if (!isModeler(actor.id)) throw new ApiError(403, "modeler_only");
    const meta = this.#validateMeta(input);
    const ropes = this.#validateRopes(input.ropes);
    return this.#mutate(db => {
      this.#checkNameUnique(db, meta.name, null);
      const at = this.now();
      const scheme = {
        id: randomUUID(),
        key: randomUUID(),
        ...meta,
        version: 1,
        status: "draft",
        submitterId: actor.id,
        createdAt: at,
        updatedAt: at,
        submittedAt: null,
        lockedAt: null,
        rev: 1,
        ropes,
        decisions: [],
        executions: [],
        history: [{ at, by: actor.id, action: "create", note: "创建草稿 v1" }]
      };
      db.schemes.push(scheme);
      return this.#view(scheme, db);
    });
  }

  #findForEdit(db, id, { requireDraft = false } = {}) {
    const scheme = db.schemes.find(s => s.id === id);
    if (!scheme) throw new ApiError(404, "scheme_not_found");
    if (requireDraft && scheme.status !== "draft") {
      throw new ApiError(409, "not_editable", { status: scheme.status });
    }
    return scheme;
  }

  #checkRev(scheme, baseRev) {
    const rev = Number(baseRev);
    if (!Number.isInteger(rev)) throw new ApiError(400, "base_rev_required");
    if (rev !== scheme.rev) throw new ApiError(409, "stale_rev", { currentRev: scheme.rev });
  }

  // 草稿（尚未进入评审的版本）编辑；进入评审后的任何改动只能走新版本。
  async updateDraft(id, actorId, input) {
    const actor = this.#requireUser(actorId);
    if (!isModeler(actor.id)) throw new ApiError(403, "modeler_only");
    const meta = this.#validateMeta(input);
    const ropes = this.#validateRopes(input.ropes);
    return this.#mutate(db => {
      const scheme = this.#findForEdit(db, id, { requireDraft: true });
      if (scheme.submitterId !== actor.id) throw new ApiError(403, "not_submitter");
      this.#checkRev(scheme, input.baseRev);
      this.#checkNameUnique(db, meta.name, scheme.key);
      const at = this.now();
      Object.assign(scheme, meta, { ropes, updatedAt: at, rev: scheme.rev + 1 });
      scheme.history.push({ at, by: actor.id, action: "update_draft", note: "编辑草稿" });
      return this.#view(scheme, db);
    });
  }

  async submit(id, actorId, baseRev) {
    const actor = this.#requireUser(actorId);
    if (!isModeler(actor.id)) throw new ApiError(403, "modeler_only");
    return this.#mutate(db => {
      const scheme = this.#findForEdit(db, id);
      if (scheme.submitterId !== actor.id) throw new ApiError(403, "not_submitter");
      if (scheme.status !== "draft") throw new ApiError(409, "not_submittable", { status: scheme.status });
      this.#checkRev(scheme, baseRev);
      const at = this.now();
      scheme.status = "in_review";
      scheme.submittedAt = at;
      scheme.updatedAt = at;
      scheme.rev += 1;
      scheme.history.push({ at, by: actor.id, action: "submit", note: `提交 v${scheme.version} 进入组内评审` });
      // 同族旧的未锁定版本一律过期。
      for (const old of db.schemes) {
        if (old.key === scheme.key && old.id !== scheme.id
          && (old.status === "in_review" || old.status === "returned")) {
          old.status = "superseded";
          old.updatedAt = at;
          old.rev += 1;
          old.history.push({ at, by: actor.id, action: "superseded",
            note: `v${scheme.version} 提交后本版本过期` });
        }
      }
      return this.#view(scheme, db);
    });
  }

  // 评审人逐项通过 / 退回；退回必须写明理由。
  async decide(id, actorId, input) {
    const actor = this.#requireUser(actorId);
    const ropeId = String(input.ropeId ?? "");
    const verdict = String(input.verdict ?? "");
    if (!ropeId) throw new ApiError(400, "rope_id_required");
    if (!["approved", "returned"].includes(verdict)) throw new ApiError(400, "bad_verdict");
    const reason = String(input.reason ?? "").trim();
    if (verdict === "returned" && !reason) throw new ApiError(400, "return_reason_required");
    return this.#mutate(db => {
      const scheme = db.schemes.find(s => s.id === id);
      if (!scheme) throw new ApiError(404, "scheme_not_found");
      if (scheme.submitterId === actor.id) throw new ApiError(403, "self_review_forbidden");
      if (!isReviewer(actor.id)) throw new ApiError(403, "reviewer_only");
      if (scheme.status === "draft") throw new ApiError(409, "not_in_review");
      if (scheme.status === "superseded") throw new ApiError(409, "version_superseded");
      if (scheme.status === "locked") throw new ApiError(409, "scheme_locked");
      this.#checkRev(scheme, input.baseRev);
      const rope = scheme.ropes.find(r => r.id === ropeId);
      if (!rope) throw new ApiError(404, "rope_not_found");
      const at = this.now();
      scheme.decisions.push({
        id: randomUUID(), ropeId, reviewerId: actor.id,
        verdict, reason: verdict === "returned" ? reason : "", at
      });
      // 汇总当前逐项结论以决定方案整体状态。
      const latest = new Map();
      for (const d of scheme.decisions) {
        const prev = latest.get(d.ropeId);
        if (!prev || d.at >= prev.at) latest.set(d.ropeId, d);
      }
      const hasReturn = [...latest.values()].some(d => d.verdict === "returned");
      scheme.status = hasReturn ? "returned" : "in_review";
      scheme.updatedAt = at;
      scheme.rev += 1;
      scheme.history.push({
        at, by: actor.id,
        action: verdict === "approved" ? "approve_item" : "return_item",
        note: `${rope.position}：${verdict === "approved" ? "通过" : "退回（" + reason + "）"}`
      });
      return this.#view(scheme, db);
    });
  }

  // 全部逐项通过后方可锁定；锁定后不可改。
  async lock(id, actorId, baseRev) {
    const actor = this.#requireUser(actorId);
    if (!isReviewer(actor.id)) throw new ApiError(403, "reviewer_only");
    return this.#mutate(db => {
      const scheme = db.schemes.find(s => s.id === id);
      if (!scheme) throw new ApiError(404, "scheme_not_found");
      if (scheme.status === "superseded") throw new ApiError(409, "version_superseded");
      if (scheme.status === "locked") throw new ApiError(409, "scheme_locked");
      if (scheme.status === "draft") throw new ApiError(409, "not_in_review");
      this.#checkRev(scheme, baseRev);
      const latest = new Map();
      for (const d of scheme.decisions) {
        const prev = latest.get(d.ropeId);
        if (!prev || d.at >= prev.at) latest.set(d.ropeId, d);
      }
      const pending = scheme.ropes.filter(r => !latest.has(r.id)).map(r => r.position);
      const returned = scheme.ropes
        .filter(r => latest.get(r.id)?.verdict === "returned")
        .map(r => ({ position: r.position, reason: latest.get(r.id).reason }));
      if (pending.length || returned.length) {
        throw new ApiError(409, "cannot_lock", { pending, returned });
      }
      const at = this.now();
      scheme.status = "locked";
      scheme.lockedAt = at;
      scheme.updatedAt = at;
      scheme.rev += 1;
      scheme.history.push({ at, by: actor.id, action: "lock", note: `v${scheme.version} 全部通过并锁定` });
      return this.#view(scheme, db);
    });
  }

  // 评审中的改动 -> 新版本草稿；已锁定方案拒绝修订，只能复制。
  async revise(id, actorId) {
    const actor = this.#requireUser(actorId);
    if (!isModeler(actor.id)) throw new ApiError(403, "modeler_only");
    return this.#mutate(db => {
      const source = db.schemes.find(s => s.id === id);
      if (!source) throw new ApiError(404, "scheme_not_found");
      if (source.status === "locked") throw new ApiError(409, "locked_use_copy");
      if (source.status === "draft") throw new ApiError(409, "draft_edit_in_place");
      const family = db.schemes.filter(s => s.key === source.key);
      if (family.some(s => s.status === "draft")) {
        throw new ApiError(409, "draft_revision_exists",
          { version: family.find(s => s.status === "draft").version });
      }
      if (source.id !== family
        .filter(s => s.status !== "superseded")
        .sort((a, b) => b.version - a.version)[0].id) {
        throw new ApiError(409, "version_superseded");
      }
      const at = this.now();
      const nextVersion = Math.max(...family.map(s => s.version)) + 1;
      const draft = {
        id: randomUUID(),
        key: source.key,
        name: source.name,
        modelCode: source.modelCode,
        shipType: source.shipType,
        summary: source.summary,
        version: nextVersion,
        status: "draft",
        submitterId: actor.id,
        createdAt: at,
        updatedAt: at,
        submittedAt: null,
        lockedAt: null,
        rev: 1,
        ropes: source.ropes.map(r => ({ ...r, id: randomUUID() })),
        decisions: [],
        executions: [],
        history: [{ at, by: actor.id, action: "revise",
          note: `基于 v${source.version} 修订，生成 v${nextVersion} 草稿` }]
      };
      db.schemes.push(draft);
      return this.#view(draft, db);
    });
  }

  // 只能从已通过（锁定）方案复制出独立新方案草稿，不继承评审结论与执行记录。
  async copy(id, actorId, input) {
    const actor = this.#requireUser(actorId);
    if (!isModeler(actor.id)) throw new ApiError(403, "modeler_only");
    return this.#mutate(db => {
      const source = db.schemes.find(s => s.id === id);
      if (!source) throw new ApiError(404, "scheme_not_found");
      if (source.status !== "locked") throw new ApiError(409, "copy_requires_locked");
      const name = String(input?.name ?? `${source.name} 副本`).trim();
      if (!name) throw new ApiError(400, "name_required");
      const key = randomUUID();
      this.#checkNameUnique(db, name, key);
      const at = this.now();
      const draft = {
        id: randomUUID(),
        key,
        name,
        modelCode: source.modelCode,
        shipType: source.shipType,
        summary: source.summary,
        version: 1,
        status: "draft",
        submitterId: actor.id,
        createdAt: at,
        updatedAt: at,
        submittedAt: null,
        lockedAt: null,
        rev: 1,
        copiedFrom: { id: source.id, name: source.name, version: source.version, at },
        ropes: source.ropes.map(r => ({ ...r, id: randomUUID() })),
        decisions: [],
        executions: [],
        history: [{ at, by: actor.id, action: "copy",
          note: `从已锁定的 ${source.name} v${source.version} 复制` }]
      };
      db.schemes.push(draft);
      return this.#view(draft, db);
    });
  }

  // 执行记录只允许挂在已锁定版本上，并快照当时的帆索条目。
  async addExecution(id, actorId, input) {
    const actor = this.#requireUser(actorId);
    const note = String(input?.note ?? "").trim();
    if (!note) throw new ApiError(400, "execution_note_required");
    return this.#mutate(db => {
      const scheme = db.schemes.find(s => s.id === id);
      if (!scheme) throw new ApiError(404, "scheme_not_found");
      if (scheme.status !== "locked") throw new ApiError(409, "execution_requires_locked");
      const at = this.now();
      const record = {
        id: randomUUID(),
        at,
        authorId: actor.id,
        note,
        snapshot: {
          version: scheme.version,
          ropes: scheme.ropes.map(r => ({
            position: r.position,
            initialTension: r.initialTension,
            safeRange: r.safeRange,
            material: r.material
          }))
        }
      };
      scheme.executions.push(record);
      scheme.updatedAt = at;
      scheme.rev += 1;
      scheme.history.push({ at, by: actor.id, action: "execute", note });
      return { execution: record, scheme: this.#view(scheme, db) };
    });
  }
}
