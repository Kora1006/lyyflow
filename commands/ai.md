---
description: 编码实现——按 spec 的技术方案实现功能代码
argument-hint: <spec 编号或名称> [--fix-p0 "<P0问题描述>"]
---

# /lyyflow:ai —— 编码实现阶段

## 输入
`$ARGUMENTS` 指定要实现的 spec（如 `spec-001` 或名称）。若为空，列出所有「待实现」spec 让用户选择。

**特殊参数**：
- `--fix-p0 "<描述>"`：P0 修复模式，只修复指定的 P0 问题，不做其他改动

## 前置
1. **分支确认（必须）**：
   - 执行 `git branch --show-current` 获取当前分支名
   - 向用户展示当前分支，要求确认是否在正确的开发分支上
   - 如果用户表示分支不对，**立即停止**，提示用户先切换到正确分支后再运行
   - 如果当前处于 `main`/`master`/`develop` 等非功能分支，**强烈警告**并要求用户二次确认
   - 确认通过后才继续后续步骤
2. 读取目标 spec 文件，确认其 `## 技术方案` 章节存在。
3. 若该 spec 状态不是「待实现」或没有技术方案，先提示用户运行 `/lyyflow:specs`。
4. **读取项目教训**：读取 `specs/lessons-learned.md`，了解已知坑，避免重蹈。

## 目标
严格按该 spec 的技术方案，在对应的端/项目中实现代码，并对照验收标准自检。

## 实现结果 Schema

> 借鉴自 `yd-ai-wf.js` 的 Schema 强约束机制。

实现完成后，必须返回符合以下 Schema 的结构化结果：

```
{
  specId: string;           // spec 编号，如 "spec-001"
  files: string[];          // 改动的文件列表
  verification: string;     // 自检结果（lint/test/验收标准检查）
  blockers: string[];       // 需人工确认的阻塞点；没有则空数组
  lessons: string[];        // 本 spec 暴露的教训；没有则空数组
}
```

**Schema 强约束说明**：
- `specId`：必须与目标 spec 编号一致
- `files`：必须列出所有改动的文件（相对路径）
- `verification`：必须说明如何自检（跑了什么命令、验收标准逐条核对）
- `blockers`：遇到以下情况必须写进 blockers：
  - 破坏性变更（删除/重命名文件）
  - 业务歧义（需求理解有歧义）
  - PII 无法脱敏（涉及敏感数据）
  - 外部依赖未就绪（接口、设计稿缺失）
  - 埋点定义缺失（tracking-events.md 未填写或本 spec 涉及埋点未定义）
- `lessons`：如果踩了新坑，必须沉淀成教训

## 执行步骤

### 1. 加载上下文

**开工前必须读取**：
- 本 spec 文件（需求、验收标准、技术方案）
- `specs/overview.md`（了解整体依赖关系）
- **`.lyyflow-local/lessons-learned.md`（主路径，本地教训,务必遵守）+ `specs/lessons-learned.md`（公开快照，兜底）**—— 主版本是 Source of Truth
- `specs/api-contracts.md`（如有接口契约）
- `specs/tracking-events.md`（如有埋点定义）
- 项目根目录的 `CLAUDE-RULE.md`（项目规范，末尾会引用 `.lyyflow-local/lessons-learned.md`）

⚠️ **本地知识边界安全检查**（必跑）：
- 执行 `git ls-files .lyyflow-local/` —— 若有结果，说明本地教训已泄露，立即停止实现，提示用户执行 `git rm -r --cached .lyyflow-local/` 后再继续
- 改动时**只** Write/Edit `.lyyflow-local/lessons-learned.md` 和 `specs/lessons-learned.md`（双写）；**严禁** Write/Edit `.lyyflow-local/` 其他内容到仓库根

### 2. 对齐方案

简要复述要改动的文件清单和实现要点，让用户确认后再动手。

**分支二次确认**：在开始写代码前，再次执行 `git branch --show-current` 确认仍在正确分支上（防止前置确认后用户手动切走了分支）。如果分支与前置确认时不一致，**停止并提示**。

**P0 修复模式**：
- 如果传入 `--fix-p0`，只修复指定的 P0 问题
- 不要顺手重构或改其他问题
- 修复后更新 `verification` 说明修复了什么

### 3. 实现

- 遵循所在项目的代码规范、目录结构、命名与已有模式（**先读相邻代码再动手**）
- 按技术方案的改动点清单逐项完成
- 涉及多端时，按端依次实现，每端实现完做一次自检
- 按技术方案的「埋点方案」逐项实现埋点调用，遵循项目既有 QTEventTracking 模式（先读相邻代码中的埋点调用，对齐格式和守卫方式）

### 4. 自检

**必须执行**：
- 跑该项目可用的 lint / typecheck / 测试（若存在）
- 逐条对照 spec 的【验收标准】自查是否满足
- 埋点实现：对照技术方案的「埋点方案」逐条核对，确认每个事件的 key / pageId / 触发时机 / 文件位置是否一致

**自检结果格式**：
```
验收标准检查：
- [x] 标准1：已实现
- [x] 标准2：已实现
- [ ] 标准3：部分实现（原因：xxx）

命令检查：
- lint: 通过
- typecheck: 通过
- test: 跳过（无测试文件）

埋点检查：
- [x] 事件1（key=xxx, pageId=yyy）：已实现，触发时机正确
- [ ] 事件2（key=zzz）：未实现（原因：埋点定义缺失）
```

### 5. 更新 spec

追加 `## 实现记录`（使用 Schema 格式），状态改为「待 review」。

### 6. 沉淀教训（双路径写入）

> 借鉴自 `yd-ai-wf.js` 的自学习闭环机制 + 本地知识边界约定。

如果本 spec 开发过程中踩了新坑：

1. 分析「为什么会踩这个坑」
2. 提炼「以后怎么避免」的经验
3. **双写双路径**：
   - 主路径：**`.lyyflow-local/lessons-learned.md`**（本地私有，Source of Truth,不入 git,可写个人经验/项目私有坑）
   - 公开快照：**`specs/lessons-learned.md`**（默认同步主版本内容,用户后续手动编辑决定哪些可发布给团队）

### 7. 同步状态看板

更新 `specs/overview.md` 的状态看板和「当前进度」章节，并提示用户可运行 `/lyyflow:review <spec>` 审核。

## 实现记录章节模板

```
## 实现记录

### Schema 输出
```json
{
  "specId": "spec-001",
  "files": ["src/a.vue", "pages/b/index", "api/c.ts"],
  "verification": "lint 通过, typecheck 通过, 验收标准 1/2/3 已实现",
  "blockers": [],
  "lessons": ["xxx 接口字段名与文档不符，实际是 userName 而非 username"]
}
```

### 关键决策
<做了哪些取舍>

### 遗留 TODO
<未完成或待联调项，无则写「无」>
```

## 异常流转

### 发现方案不可行

如果在实现过程中发现技术方案存在根本性问题（如接口不存在、依赖缺失、方案设计有误）：

1. **立即停止实现**，不要强行绕过或擅自修改方案
2. 在 spec 的「备注」章节记录：
   - 发现的具体问题
   - 影响范围
   - 建议的解决方案或替代方案
3. 将 spec 状态改为「方案待修正」
4. 更新 `specs/overview.md` 的「当前进度」和 Blockers 章节
5. 通知用户并建议运行 `/lyyflow:specs <spec>` 重新设计方案

### 发现需求变更或遗漏

如果实现过程中发现需求与实际情况不符或有遗漏：

1. 在 spec 的「备注」章节记录差异点
2. 与用户确认是否需要调整需求
3. 如需调整：
   - 状态改为「需求待确认」
   - 确认后回到 `/lyyflow:specs` 更新方案

### 部分完成无法继续

如果因外部原因（如依赖接口未就绪）导致只能部分实现：

1. 在「实现记录」中明确标注已完成/未完成部分
2. 状态改为「待联调」或「阻塞中」
3. 在 `specs/overview.md` 的 Blockers 章节记录阻塞项（类型：`external`）

## 注意
- **不要超出技术方案范围**去重构无关代码。
- 遇到方案与现实冲突（接口不存在、结构不符、依赖缺失等），**停下来与用户确认**，更新 spec 方案后再继续，而不是擅自大改。
- 改动要可被 review：保持原子、可追踪。
- **遇到阻塞立即反馈**，不要强行推进导致返工。
- **Schema 强约束**：必须按格式返回实现结果，便于后续 review 和状态追踪。
- **P0 修复职责**：修复 P0 时只修 P0，不要顺手改其他问题。