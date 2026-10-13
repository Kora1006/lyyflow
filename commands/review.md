---
description: 代码审核——默认通过 codex-plugin-cc 调度 Codex CLI 交叉审查；简单改动可由 Jev(TypeSafe AI)做轻校验节省 Codex 配额
argument-hint: <spec 编号或名称>
---

# /lyyflow:review —— 代码审核阶段（codex + Jev 分层）

本阶段按 **3 层路由**执行审核：

| Tier | 触发条件 | 审核方式 | 何时用 |
|------|---------|---------|--------|
| **A** core | 命中鉴权/支付/契约/并发等高风险关键词，或 spec 强制 core | Codex review + adversarial review（最严） | 核心功能改动 |
| **B** standard | 普通功能改动 | Codex review（仅 Step 1，跳过对抗） | 一般功能改动 |
| **C** trivial | 纯重构/typo/重命名/样式，无高风险命中 | **Jev 轻校验**（不走 Codex） | 简单改动，省配额 |

- **Tier A/B**：调用 OpenAI Codex CLI（由 `codex-plugin-cc` 插件调度）做交叉审查，重点发现**需求偏差**和**逻辑错误**。
- **Tier C**：调用 Jev（TypeSafe AI 的 System One 决策模型）做结构化校验——Noul 检查"未声明变量/明显拼写错误/接口契约漂移"，Score 评估整体清晰度。
- 本会话模型负责**路由、编排、汇总结论、更新 spec 状态**。

> **架构说明**：`codex-plugin-cc` 是 **OpenAI 官方出品的 Claude Code 插件**，源码在 `https://github.com/openai/codex-plugin-cc`，通过 Claude Code 插件市场分发。它让你在 Claude Code 会话内直接调用 Codex CLI 进行代码审查和任务委派。`/codex:*` 系列 slash 命令**在 Claude Code 会话内直接有效**，无需切换到其他终端。

## 前置条件：安装 codex-plugin-cc

> ⚠️ **重要**：本审核流程**强依赖 Codex CLI**，不支持回退到会话模型自查。请确保在使用本命令前完成插件安装和配置。若未安装，将提示用户先完成安装。

### 安装步骤（在 Claude Code 会话内执行）

```
/plugin marketplace add openai/codex-plugin-cc   # 1. 添加 OpenAI 插件市场
/plugin install codex@openai-codex                # 2. 安装插件
/reload-plugins                                   # 3. 重载插件使其生效
/codex:setup                                      # 4. 自动检测环境并完成配置
```

`/codex:setup` 会自动检测 Codex CLI 是否已安装；如未安装，会引导执行：

```bash
npm install -g @openai/codex        # 安装 Codex CLI
!codex login                        # 登录 Codex（ChatGPT 账号或 API Key）
```

### 验证安装

安装成功后，Claude Code 会话内可用以下 slash 命令：

| 命令 | 用途 |
|---|---|
| `/codex:review` | 常规正确性审查（只读） |
| `/codex:adversarial-review` | 设计/风险质疑审查（只读） |
| `/codex:rescue` | 任务委派（bug 调查、修复等，可写） |
| `/codex:setup` | 环境检查与配置向导 |
| `/codex:status [job-id]` | 查看后台任务进度 |
| `/codex:result [job-id]` | 获取已完成任务的结果 |
| `/codex:cancel [job-id]` | 取消后台任务 |

> 若 `/codex:setup` 提示 `Unknown skill: codex:setup`，检查 `~/.claude/settings.json` 确保 `"enabledPlugins": { "codex@openai-codex": true }` 已启用，然后再次 `/reload-plugins`。

## 输入
`$ARGUMENTS` 指定要审核的 spec（如 `spec-001`）。若为空，列出所有「待 review」/「待修复」spec 让用户选择。

## 准备
1. 读取目标 spec 的【详细需求】【验收标准】【技术方案】【实现记录】，以及 `specs/overview.md`。
2. 读取 **`.lyyflow-local/lessons-learned.md`（主路径，本地教训,优先读）+ `specs/lessons-learned.md`（公开快照，兜底）**，评审时核对改动有没有重蹈这些坑。
3. 定位本次改动范围：`git diff`（未提交改动）或 `git diff <base>..HEAD`（相对基线分支）。多端项目**分别在各自仓库**内审查。

## 前置条件（可选）：Jev 启用 Tier C

> Tier C（Jev 轻校验）**是可选的**。未启用时所有 spec 自动按 Tier A 处理，不影响 review 流程。

### 启用步骤

```
# 1. 在 console.typesafe.ai/settings/keys 申请 TYPESAFE_API_KEY
export TYPESAFE_API_KEY="<your-key>"

# 2. （可选）装 jev CLI（手工调试时用；自动化流程直接用 curl 即可）
brew install shaharia-lab/tap/jev
# 或:curl -fsSL https://raw.githubusercontent.com/shaharia-lab/jev-cli/main/install.sh | sh
```

> 建议把 `export TYPESAFE_API_KEY="..."` 写入 `~/.zshrc` 或项目 `.env.local`（不入 git）。

### 降级策略

- `TYPESAFE_API_KEY` 未设置 / Jev HTTP 调用失败 / 限流（429 重试 2 次后仍失败）→ 自动按 **Tier A（Codex 全套）** 处理
- 不可用时在 spec「审核结论」记录 `tier-fallback: jev-unavailable`

### Key 加载顺序（agent 在调 Jev 前自动尝试）

> agent 在每次调 Jev API 之前，按以下顺序尝试加载 key，**找到就停**。三处皆无 → 视为 Jev 不可用（走上面"降级策略"）。

| 优先级 | 位置 | 说明 |
|---|---|---|
| 1 | 环境变量 `$TYPESAFE_API_KEY` | 会话级，最快 |
| 2 | `~/.bashrc` 里的 `export` | Git Bash 启动时已自动 source（已写入） |
| 3 | `<projectDir>/.lyyflow-local/secrets/.env` | 项目本地，**已进 `.git/info/exclude`**（双重保险不入 git） |
| 4 | `~/.typesafe/.env` | 用户全局 fallback（任意项目通用） |

**agent 在 Bash 里跑的加载命令**（放在所有 Jev curl 之前）：

```bash
# 若 env 未设,尝试 source 项目本地
[ -n "$TYPESAFE_API_KEY" ] || [ -f .lyyflow-local/secrets/.env ] && source .lyyflow-local/secrets/.env
# 仍未设,尝试 source 用户全局 fallback
[ -n "$TYPESAFE_API_KEY" ] || [ -f ~/.typesafe/.env ] && source ~/.typesafe/.env
# 都未找到 → Jev 不可用,自动按 Tier A 走
[ -z "$TYPESAFE_API_KEY" ] && echo "[lyyflow:review] TYPESAFE_API_KEY 未找到,降级 Tier A" && export JEV_DEGRADED=1
```

> `.bashrc` 末尾已追加一段自动 source 逻辑，所以下次开新 bash **不需要手动 export**。

### 三类问题（TypeSafe System One）

- `noul`：布尔概率（yes/no + probability）
- `choice`：多选（options + 选中项）
- `score`：评分（min-max + 分值）

API 文档参考：`https://api.typesafe.ai/v1/systemone`（POST，Bearer token）。

## Step 0：路由判定（Tier A / B / C）

> 在调 Codex 之前，先决定走哪一层。

### 0.1 读取用户覆写（如有）

读目标 spec 文件，找 `## 审核策略` 章节（由 `/lyyflow:specs` 阶段在 spec 模板里可填）：
- 若填了 `期望层级: core | standard | trivial` → **强制使用该 tier**，跳过 0.2
- 若未填 → 进入 0.2 让 Jev 判定

### 0.2 Jev Choice 自动判定

仅在 **Jev 已启用**且 spec 未填 `## 审核策略` 时执行。

调用 Jev Choice：

```bash
curl -s https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jev-latest",
    "state": {
      "spec_title": "<spec 标题>",
      "spec_summary": "<一句话需求>",
      "diff_files": <改动文件数>,
      "diff_lines": <改动行数>,
      "risk_keywords_hit": ["auth","payment","contract","race","permission","crypto",...]
    },
    "questions": {
      "review_tier": {
        "type": "choice",
        "options": ["core","standard","trivial"],
        "instructions": "基于 spec 类型/规模/风险关键词命中情况,决定需要哪种深度的审核。命中鉴权/支付/契约/并发/安全等高风险关键词 → core;普通功能改动 → standard;纯重构/typo/重命名/样式 → trivial。"
      }
    }
  }'
```

从响应里取 `questions.review_tier.choice` 作为 tier。

### 0.3 路由分支

| tier | 走向 |
|------|------|
| `core` | Step 1（Codex review）+ Step 2（Codex adversarial review）|
| `standard` | Step 1（Codex review，跳过 Step 2）|
| `trivial` | Step 5（Tier C 轻校验，跳过 Codex）|

在 spec「审核结论」追加 `tier: <tier>`, `tier-source: <manual|auto-jev>`。

## P0 问题分级标准

> 借鉴自 `yd-ai-wf.js` 的 P0 当场修复机制。

**P0（Critical）**：不修就不能交的问题，必须当场修复：
- 功能缺失或完全不可用
- 安全漏洞（鉴权绕过、SQL 注入、XSS 等）
- 数据丢失或损坏风险
- 接口契约严重不符（字段缺失、类型错误）
- 阻塞核心业务流程

**非 P0**：可以后续优化或冒泡给人工处理：
- 代码风格问题
- 性能优化建议
- 非关键路径的边界情况
- 可读性改进

## 执行审核（调用 Codex）

> 本节命令**直接在 Claude Code 会话内执行**；调用时务必把**该 spec 的需求 + 验收标准 + 涉及端/接口契约**作为聚焦语带入，确保 Codex 按本功能点审查而非泛泛而谈。

### 步骤一：常规正确性审查 → `/codex:review`

核对实现是否符合需求、有无明显逻辑错误。多文件改动建议后台跑：
```
/codex:review --background
/codex:review --base main --background
```
随后 `/codex:status` 看进度，`/codex:result <job-id>` 取结论。

**重要**：从 Codex 结果中提取 P0 问题：
- 识别标记为 `P0` / `Critical` / `不修就不能交` 的问题
- 这些问题会被当场修复，描述要具体到 `文件:行 + 问题本身`

### 步骤二：设计/风险质疑 → `/codex:adversarial-review`

发版前挑战方案选型、边界、竞态、鉴权、数据安全等高风险点（可带聚焦语）：
```
/codex:adversarial-review --base main 重点检查鉴权与并发，并对照 spec-001 验收标准
/codex:adversarial-review --background 检查竞态条件、错误处理和数据一致性
```

### 步骤三：P0 当场修复

> 借鉴自 `yd-ai-wf.js`：P0 问题当场派修复 agent 修复，修复职责与评审职责分离。

**如果 Codex review 报了 P0 问题**：

1. **立即修复**：不要等用户确认，直接调用 `/lyyflow:ai <spec>` 修复
2. **只修 P0**：不要顺手重构或改其他问题
3. **修复后自检**：能跑的话编译/测试过一遍
4. **修复结果记录**：
   - 修复成功 → P0 从阻塞项移除
   - 修复失败 → 标记为 `p0-unfixed`，冒泡给人工处理

**修复流程**：
```
检测到 P0 问题后：
1. 在 spec 的「审核结论」中记录 P0 问题
2. 调用 /lyyflow:ai <spec> --fix-p0 "<P0问题描述>"
3. 修复完成后重新跑 /codex:review 验证
4. 更新审核结论
```

**修复职责分离**：
- Review agent：只读、只判、不修（避免评审者改自己评的东西）
- Fix agent：专门负责修复，与 reviewer 分开

### 步骤四：非 P0 问题处理

**非 P0 问题**：
- 不当场修复
- 写入 spec 的「审核结论」→「建议项」
- 写入 `specs/overview.md` 的「Blockers」章节，类型标记为 `review`
- 冒泡给人工决定是否处理

### 步骤五：Tier C 轻校验流程（仅当 Step 0 路由到 trivial 时执行）

> Tier C **不调 Codex**，改调 Jev（TypeSafe AI System One）做结构化校验。零幻觉概率输出比 Codex 文本生成更适合"分类 + 校验"。

#### 5.1 每个改动文件做 3 项 Noul 检查

对 `git diff` 列出的每个改动文件调用一次 Jev：

```bash
curl -s https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jev-latest",
    "state": {
      "file_path": "<相对路径>",
      "file_content": "<读取文件全文>"
    },
    "questions": {
      "undeclared_var_ref": {
        "type": "noul",
        "instructions": "此文件是否有调用未声明的变量或函数（拼写误、未 import、作用域外引用）？"
      },
      "obvious_typo": {
        "type": "noul",
        "instructions": "此文件是否存在明显拼写错误（变量名/函数名/字符串字面量）？"
      },
      "contract_drift": {
        "type": "noul",
        "instructions": "此文件对外暴露的接口（参数名/类型/返回结构）是否与 spec 描述的接口契约不一致？"
      }
    }
  }'
```

#### 5.2 每个 spec 做 1 项 Score 评估

```bash
curl -s https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "jev-latest",
    "state": {
      "spec_title": "<spec 标题>",
      "changed_files": ["<path1>", "<path2>"]
    },
    "questions": {
      "code_clarity": {
        "type": "score",
        "min": 1, "max": 5,
        "instructions": "整体代码可读性与一致性 1-5 分（基于命名/格式/复用现有模式）"
      }
    }
  }'
```

#### 5.3 通过 / 升级 / 失败判定

| 条件 | 结果 |
|------|------|
| 所有 Noul 都 false（或概率 ≤ 0.7 为 true）+ Score ≥ 3 + 全部 confidence > 0.5 | **通过**（verdict=pass） |
| 任一 Noul 的 `probability > 0.7` 为 true | **升级到 Tier B**（自动改用 Codex review，跳过 adversarial）；在审核结论写 `tier-escalated: trivial→standard` |
| Score < 3 | **升级到 Tier B**（同上） |
| 升级后 Tier B 仍失败 | 走正常 Codex P0 / 修复 / 冒泡流程 |

#### 5.4 Jev 调用失败处理

- 单次 curl 退出码非 0 / 响应非 JSON / HTTP 429 重试 2 次后仍失败 → 视为 Jev 不可用
- Jev 不可用 → **降级到 Tier A**（Codex 全套），在审核结论写 `tier-fallback: jev-unavailable→core`

#### 5.5 审计追溯

Tier C 通过的 spec 在 `specs/overview.md` 的 spec 列表里加标记 `tier-c-jev-passed (YYYY-MM-DD, jev-latest)`，人工可随时回查。

## 汇总结论

拿到 Codex 结果后，结合下列维度归类整理（Codex 已覆盖大部分，会话模型补漏）：
1. **需求符合性**：是否覆盖 spec 每条需求与验收标准，有无遗漏/过度实现。埋点实现是否符合技术方案的「埋点方案」，key / pageId / 触发时机是否一致。
2. **方案一致性**：是否按技术方案实现，偏离处是否有合理理由。
3. **正确性**：边界、空值、异常分支、异步/并发/时序、接口字段与契约、**多端一致性**。
4. **工程质量**：复用组件/工具、命名规范、无重复、符合项目模式。
5. **风险**：回归、兼容性、性能、安全（鉴权/校验/越权）。
6. **埋点完整性**：是否按方案实现了所有埋点事件，参数（key/pageId/触发时机）是否正确，守卫判断（if (!qt) return）是否到位，多端埋点是否一致。

然后：
- 在 spec 文件追加 `## 审核结论`（见下模板）。
- 据结论更新状态：无阻塞 → `已完成`；有阻塞 → `待修复`，提示用 `/lyyflow:ai <spec>` 修复后重审。
- 同步 `specs/overview.md` 状态看板和「当前进度」章节。
- **更新完成标记**：在 `specs/overview.md` 的 spec 列表中，将完成的 spec 标记为 `[x]`。

## 审核结论章节模板

### Tier A / B（Codex 路径）

```
## 审核结论
- tier: <core|standard>（tier-source: <manual|auto-jev>）
- 审查方：OpenAI Codex（/codex:review | /codex:adversarial-review）+ 会话模型交叉核对
- 结论：通过 / 有条件通过 / 不通过
- P0 问题（已当场修复）：
  1. [文件:行] 问题描述 → 修复方案
- P0 问题（未能修复）：
  1. [文件:行] 问题描述 → 需人工处理
- 阻塞项（必须改）：
  1. [文件:行] 问题描述 → 修复建议
  2. [文件:行] 埋点缺失或参数不符（key/pageId/触发时机与方案不一致） → 修复建议
- 建议项（可选）：
  1. [文件:行] 问题描述 → 修复建议
- Codex job-id：<若有，便于 /codex:result 追查>
```

### Tier C（Jev 轻校验路径）

```
## 审核结论
- tier: trivial（tier-source: <manual|auto-jev>）
- 审查方：TypeSafe Jev（System One: noul × 3 + score × 1）+ 会话模型交叉核对
- 结论：通过 / 不通过
- Jev 检查结果：
  | 文件 | undeclared_var_ref | obvious_typo | contract_drift | file_clarity |
  |------|--------------------|--------------|-----------------|--------------|
  | path/to/a.ts | false (p=0.05) | false (p=0.12) | false (p=0.08) | - |
  | path/to/b.ts | false (p=0.20) | false (p=0.15) | false (p=0.10) | - |
  | 整体 code_clarity | - | - | - | 4 / 5 |
- 升级记录（如有）：tier-escalated: trivial→standard（原因：Noul contract_drift p=0.82 > 0.7）
- 阻塞项（必须改）：
  1. [文件:行] 问题描述 → 修复建议
- 建议项（可选）：
  1. [文件:行] 问题描述 → 修复建议
- Jev 调用元数据：model=jev-latest, 调用次数=<N>, 429 重试=<M>
```

## 教训沉淀

> 借鉴自 `yd-ai-wf.js` 的自学习闭环机制。

审核完成后，如果发现了有价值的问题（尤其是 P0）：

1. 分析「为什么会犯这个错误」
2. 提炼「以后怎么避免」的经验
3. 追加到 **`.lyyflow-local/lessons-learned.md`（主路径,本地私有,Source of Truth）+ `specs/lessons-learned.md`（公开快照,同步副本,由用户决定哪些可发布）**：
   ```markdown
   ## [spec-XXX] <问题简述>
   - **触发场景**：<什么情况下会踩这个坑>
   - **问题根因**：<为什么会犯这个错误>
   - **解决方案**：<怎么修复的>
   - **预防措施**：<以后怎么避免>
   - **关联文件**：<涉及的文件>
   ```

## 异常流转

### Codex 不可用
如果检测到 Codex 插件未安装或配置未完成：
1. 提示用户必须先完成 `/codex:setup`
2. 提供安装步骤指引
3. **不执行审核**，等待用户完成配置后重试

> **Jev 不可用不影响流程**：Jev 不可用时 Tier C 自动降级为 Tier A（Codex 全套），仍能完成审核；在审核结论记录 `tier-fallback: jev-unavailable→core`。Codex 仍是必需依赖。

### Jev 不可用（Tier C 降级）
如果 Step 0 路由到 Tier C 但 Jev 调用失败（`TYPESAFE_API_KEY` 未设置 / HTTP 4xx 5xx / 429 重试 2 次仍失败）：
1. 当前 spec 自动按 **Tier A** 处理（调 Codex review + adversarial review）
2. 在 spec「审核结论」追加 `tier-fallback: jev-unavailable→core`
3. **不阻塞 review 流程**——继续走 Step 1-4
4. 在 `specs/overview.md` 加一条 Blockers：`[external] jev-unavailable,本次 spec 已降级到 Tier A,请考虑装 jev 或填入 TYPESAFE_API_KEY 以享受轻校验`

### Tier C 升级到 Tier B
如果 Tier C 校验中触发升级条件（Noul probability > 0.7 为 true 或 Score < 3）：
1. 自动改用 Tier B（仅 Codex review，跳过 adversarial）
2. 在「审核结论」记录 `tier-escalated: trivial→standard` + 升级原因
3. 后续走正常 Codex P0 / 修复 / 冒泡流程

### 审核发现方案问题
如果审核发现的是方案层面的问题（而非实现问题）：
1. 在 spec 的「备注」章节记录方案问题
2. 状态改为「方案待修正」
3. 建议运行 `/lyyflow:specs <spec>` 修正方案后再实现

### 需要修复后重审
如果存在阻塞项（非 P0 或 P0 修复失败）：
1. 状态改为「待修复」
2. 更新 `specs/overview.md` 的 Blockers 章节：
   | spec | 类型 | 阻塞描述 | 状态 |
   |------|------|----------|------|
   | spec-001 | review/p0-unfixed | <问题描述> | 待处理 |
3. 更新「当前进度」：
   ```
   ## 当前进度
   - 最后更新：YYYY-MM-DD HH:mm
   - 正在执行：spec-XXX（待修复）
   - 阻塞项：<简述问题>
   - 下一步：运行 `/lyyflow:ai spec-XXX` 修复后重审
   ```
4. 提示用户运行 `/lyyflow:ai <spec>` 修复后，再次运行 `/lyyflow:review` 重审

## Blocker 分类冒泡

> 借鉴自 `yd-ai-wf.js` 的 blocker 分类机制。

审核完成后，将阻塞项分类写入 `specs/overview.md`：

| 类型 | 说明 | 处理方式 |
|------|------|----------|
| `task` | spec 开发过程中遇到的阻塞 | 冒泡给人工 |
| `review` | review 发现的问题（非 P0） | 冒泡给人工决定是否处理 |
| `p0-unfixed` | P0 问题修复失败 | 冒泡给人工紧急处理 |
| `external` | 外部依赖未就绪 | 冒泡给人工协调 |

**已修复的 P0 不冒泡**：一个 P0 如果已当场修复成功，不再写入 Blockers 章节。

## 注意
- `/codex:review` 和 `/codex:adversarial-review` 只读不改；`/codex:rescue` 有写入权限，谨慎使用。修复优先走 `/lyyflow:ai`。
- 多端改动：**每端各自**进入对应仓库分别跑 `/codex:review`；涉及接口契约时确认所有调用方同步更新。
- 聚焦「明显且高价值」的问题，避免风格之争。
- Codex 调用消耗 Codex 配额（ChatGPT 订阅或 API Key 额度），大规模使用时注意用量。Tier C 路由是**省 Codex 配额**的关键——typo/重构类改动走 Jev 不消耗 Codex。
- **Codex 仍是必需依赖**（Tier A/B 必须），Jev **只是可选加速器**。Jev 不可用不影响流程，会自动降级到 Tier A。
- **Tier C 的零幻觉不等于零风险**：Jev 只做结构化校验，不审架构正确性。Tier C 通过 ≠ 实现完全正确，复杂改动应通过 spec `## 审核策略` 强制走 Tier A/B。
- **本流程不支持回退到会话模型自查**，必须使用 Codex 或 Jev 做交叉审查，确保客观性。
- **P0 当场修复**：不要让用户等，发现问题立即修复。
- **修复职责分离**：评审者和修复者分开，避免自己改自己评。
- **Tier C 不调修复 agent**：Jev 校验出问题一律升级到 Tier B 后再走修复流程，避免轻校验后立刻进入 P0 修复的职责混乱。