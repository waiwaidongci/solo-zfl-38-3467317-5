// 评审组名册：建模师负责提交/修订，评审人负责逐项评审与锁定。
// 评审人不能评审自己提交的方案（防止自评）。
export const TEAM = [
  { id: "zhou", name: "周宁", role: "modeler", title: "建模师" },
  { id: "lin", name: "林远", role: "modeler", title: "建模师" },
  { id: "shen", name: "沈砚", role: "reviewer", title: "评审人" },
  { id: "he", name: "何岚", role: "reviewer", title: "评审人" }
];

export function findMember(id) {
  return TEAM.find(m => m.id === id) || null;
}

export function isModeler(id) {
  return findMember(id)?.role === "modeler";
}

export function isReviewer(id) {
  return findMember(id)?.role === "reviewer";
}
