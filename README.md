# 古船模型 · 帆索张力方案评审台

在既有帆索校准原型之上扩展的组内工艺方案评审台。建模师逐根帆索提交张力方案
（初始张力、安全区间、材料、调试步骤、风险），评审人逐项通过或退回；全部通过后锁定为执行基准。

## 运行

```bash
npm install          # 安装 Playwright（仅测试用，运行时零依赖）
npm start            # http://localhost:3038
```

- `/`：工艺方案评审台（数据 `data/process-review.json`，重启后保留）
- `/calibration`：原有帆索校准原型（数据 `data/model-rigging-calibration.json`，行为不变）

## 评审规则

- **角色**：右上角切换身份。建模师（周宁/林远）只能提交、编辑自己的草稿、修订、复制；
  评审人（沈砚/何岚）只能逐项评审、锁定。**提交人不能自评**，建模师不能代评。
- **版本**：草稿可原地编辑；一旦提交评审，任何改动都通过“修订”生成新版本（旧评审结论不继承）。
  新版本提交后，旧版本自动变为“已过期”，过期版本上的评审/修订/锁定一律拒绝。
- **逐项评审**：每根帆索单独“通过/退回”，退回必须写明理由；出现退回即整体阻塞，退回项与理由
  展示在详情页和侧栏；评审人可改判。全部逐项通过后才能锁定，锁定后不可改动。
- **复制**：只能从已锁定方案复制为独立的新方案草稿，重新走评审；**不继承评审结论与执行记录**，
  复制方案后续的任何操作都不影响原方案的既有执行记录。
- **并发与一致性**：进程内写互斥 + 每方案 `rev` 乐观锁。并发同名提交只有一个成功（其余 409）；
  基于过期版本的评审/编辑返回 409，不会覆盖他人改动；落盘为临时文件 + rename 原子写。

## HTTP API

身份通过请求头 `X-User-Id`（`zhou`/`lin`/`shen`/`he`）声明。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/review/team` | 成员名册 |
| GET | `/api/review/overview` | 评审进度、待处理项、阻塞原因、执行记录数 |
| GET | `/api/review/schemes` | 方案列表（含版本与进度） |
| POST | `/api/review/schemes` | 建模师创建草稿 |
| GET | `/api/review/schemes/:id` | 方案详情 |
| PUT | `/api/review/schemes/:id` | 提交人编辑草稿（带 `baseRev`） |
| POST | `/api/review/schemes/:id/submit` | 提交评审（带 `baseRev`） |
| POST | `/api/review/schemes/:id/decisions` | 逐项 `approved`/`returned`（退回必填 `reason`，带 `baseRev`） |
| POST | `/api/review/schemes/:id/lock` | 全部通过后锁定（带 `baseRev`） |
| POST | `/api/review/schemes/:id/revise` | 生成新版本草稿 |
| POST | `/api/review/schemes/:id/copy` | 从已锁定方案复制独立新方案 |
| POST | `/api/review/schemes/:id/executions` | 锁定方案登记执行记录 |

拒绝类响应：`401 unknown_user`、`403 modeler_only/reviewer_only/self_review_forbidden/not_submitter`、
`409 duplicate_name/stale_rev/version_superseded/scheme_locked/cannot_lock/copy_requires_locked/...`、
`400` 字段校验。

## 测试

```bash
npm test             # 19 个 node:test API 测试（工作流/权限/并发/重名/过期/持久化）
npm run test:e2e     # Playwright 真实 Chromium：自动 npm start 走通浏览器评审
npm run test:all     # 全部
```

无 root 的 Linux 环境若 chromium 缺系统库，可运行 `npm run browser:libs`
（用 `apt-get download` 解包到本地目录，E2E 启动时自动加入 `LD_LIBRARY_PATH`）；
有 root 时直接 `npx playwright install --with-deps chromium`。
