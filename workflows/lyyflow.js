// ============================================================
// lyyflow —— lyyflow 多端全链路工作流变排器(参考 yd-ai-wf.js 重构)
// ------------------------------------------------------------
// 一条链路打通「需求拆分 → 技术方案 → 编码实现 → 代码审核 → 归档」,
// 对应 lyyflow 命令行的五个 skill:/lyyflow:prd → /lyyflow:specs → /lyyflow:ai → /lyyflow:review → /lyyflow:archive。
//
//   PRD    : 读需求来源(文件/URL/PDF/文本)→ 拆功能点 spec,生成 specs/overview.md + spec-NNN-*.md +
//            lessons-learned.md;为涉及的每端增量补 CLAUDE-RULE.md(顶部含「项目章程」段);
//            生成「假设清单」(需求歧义点+默认假设)写入 overview.md —— 沙箱无法交互,
//            未确认假设以 [assumption] 前缀冒泡,Specs 按默认假设出方案并标风险。
//            断点续跑:overview.md 里已标 [x] 的 spec 整段跳过。
//   Specs  : 对每个「待方案」spec 定位代码、分析改动点、对照各端 CLAUDE-RULE.md「项目章程」
//            逐条校验方案(constitutionViolations),给可落地技术方案,写进 spec 文件;
//            异常流转(方案待修正/需求待确认/技术不可行/章程冲突)写备注 + 状态机切换,不擅自改需求。
//   Execute: 按 spec 技术方案在对应端实现代码,Schema 强约束返回;自检 lint/test/验收标准;
//            踩坑沉淀进 lessons-learned.md;状态→待 review。
//   Review : 每 spec 完成后派 review agent(走 codex-plugin-cc 的 /codex:review +
//            /codex:adversarial-review 交叉审查);**违反项目章程 = P0**(constitutionViolations
//            单独返回并写进 p0Issues);报 P0 → 另派修复 agent 当场只修 P0(职责分离),
//            修复后复跑 review 验证;非 P0 / 修不掉的 P0 → Blocker 分类冒泡。
//            无人值守:不等审批,有阻塞冒泡到返回值。
//   Archive: 所有 spec「已完成」且审核通过 → 归档到 args.archiveRoot(默认 ~/lyyflow-archives)/<命名>/,spec 中文重命名,
//            生成 archive-meta.md;条件不满足则把未完成项冒泡,不归档。
//
// 设计取舍(沿用 yd-ai-wf.js 的共识 + lyyflow 多端改造):
//   - 全部 I/O 由 agent 完成,脚本只编排(workflow 沙箱无文件系统、无交互)。
//   - 自学习闭环:每 spec 完成(实现/review)把踩的坑/教训**主版本**追加进
//     .lyyflow-local/lessons-learned.md(本地私有,不入 git),同时同步一份公开快照到
//     specs/lessons-learned.md(团队可见,默认是完整版,由用户后续手动编辑决定
//     哪些可发布)。各端 CLAUDE-RULE.md 末尾 @.lyyflow-local/lessons-learned.md
//     引入,后续 agent 开工前都读它(本地沉淀,跨会话复用)。
//   - 本地知识边界(Bootstrap):每个项目根建 .lyyflow-local/,写 .git/info/exclude,
//     自动装 pre-commit hook,git ls-files 安全检查;archive 阶段严格排除
//     .lyyflow-local/(教训留本地,不入归档目录)。详见 runBootstrap()。
//   - 重跑:PRD 读到 [x] 的 spec 跳过;Specs 只处理「待方案/方案待修正」;Execute 只处理「待实现」;
//     Review 只处理「待 review/待修复」。靠 overview.md 的状态看板 + [x] 标记做断点续跑。
//   - 多端:每端各有 CLAUDE-RULE.md 与项目根,Execute/Review 按工种(端)派 subagent,
//     review 时每端各自在对应仓库跑 codex(聚焦语带上 spec 需求 + 接口契约)。
//   - 中途不等用户:需人工确认的 blocker(业务歧义/缺接口/缺设计/破坏性变更)冒泡到返回值;
//     PRD 的接口文档询问因 workflow 沙箱无法交互,改造成「检测到缺接口契约 → 写进 blockers[external]
//     冒泡,Specs 阶段先按假设出方案并在备注标注风险」,用户补完重跑续上。
//   - 显式不做:QA / 人工审批 —— 留给外层 command(同 yd-ai-wf.js)。
//   - 裁剪:传 args.feature 只跑单个 spec 的「Specs→Execute→Review」;不传 feature 只做 PRD 拆分;
//     传 args.archive 且前置满足 → 跳到归档;传 args.skip 可强制跳过 PRD(仅 PRD 可跳,后续有数据依赖)。
//
// 目录模型:projectDir 是项目根(多端场景下 specs/ 统一放 projectDir/specs/,各端代码在各自仓库);
//           specs/overview.md 是中枢(状态看板/执行计划/Blockers/项目环境),spec-NNN-*.md 是单功能点。
//
// 调用:Workflow({ name: 'lyyflow', args: {
//          projectDir: '/abs/project',       // 必填:项目根(specs/ 在此,记忆读各端 CLAUDE-RULE.md)
//          prdSource: '/path/prd.md',        // 可选:需求来源(文件/URL/PDF/文本);传则进入 PRD 段
//          feature: 'spec-001',              // 可选:只处理单个 spec(Specs→Execute→Review)
//          archive: true,                    // 可选:所有 spec 已完成则跳到归档
//          archiveName: '20260721-001',      // 可选:归档命名;不传用默认 YYYYMMDD-序号
//          archiveRoot: 'D:/projectSessions',// 可选:归档根目录;不传默认 ~/lyyflow-archives
//          skip: ['PRD'],                    // 可选:强制跳过的阶段。当前仅 PRD 可跳(Specs/Execute/Review 有数据依赖)
//       }})
// ============================================================

export const meta = {
  name: 'lyyflow',
  description:
    'lyyflow 多端全链路:PRD 拆分 → Specs 技术方案 → ai 编码实现 → review(3 层路由:core=Codex 全套,standard=Codex 仅 review,trivial=Jev 轻校验自动省 Codex 配额)→ archive 归档(blocker 冒泡)',
  phases: [
    {
      title: 'Bootstrap',
      detail:
        '初始化 .lyyflow-local/(本地教训+笔记)+ 写 .git/info/exclude + 装 pre-commit hook + git ls-files 安全检查(本地知识边界)',
    },
    {
      title: 'PRD',
      detail:
        '读需求来源拆 spec,生成 specs/overview.md(含假设清单)+ spec-NNN-*.md + lessons-learned.md,每端增量补 CLAUDE-RULE.md(顶部「项目章程」段),接口/埋点缺口 + 未确认假设冒泡',
    },
    {
      title: 'Specs',
      detail:
        '每个待方案 spec 定位代码、分析改动点、对照 CLAUDE-RULE.md「项目章程」校验方案(constitutionViolations),写可落地技术方案(可填「### 审核策略」强制 review tier);异常流转切状态机',
    },
    {
      title: 'Execute',
      detail: '按方案实现代码,Schema 强约束返回,自检,沉淀教训到 .lyyflow-local/,状态→待 review',
    },
    {
      title: 'Review',
      detail:
        'Step 0 路由(spec 审核策略或 Jev Choice 判 tier)→ 按 tier 跑 codex-plugin-cc 的 /codex:review(+adversarial 或不)+ 必要时调 Jev(TypeSafe System One)Noul/Score 轻校验。trivial 触发升级自动转 standard。违反项目章程=P0(constitutionViolations);P0 当场派修复 agent 只修 P0 并复跑验证;非 P0 / 修不掉的 P0 冒泡;通过则标 [x]',
    },
    { title: 'Archive', detail: '全部 spec 已完成且审核通过 → 归档到 args.archiveRoot(默认 ~/lyyflow-archives;严格排除 .lyyflow-local/)' },
    { title: 'Collect', detail: '汇总产出 + blocker 分类冒泡(含 review tier 分布 / 升级次数 / 降级次数 / 章程违反数)' },
  ],
};

// ---- 主体 ----

const projectDir = (args && args.projectDir) || '';
if (!projectDir) {
  return {
    error:
      '缺少 args.projectDir。示例:Workflow({ name: "lyyflow", args: { projectDir: "/abs/project", prdSource: "/path/prd.md", feature: "spec-001" } })',
  };
}
// specs 统一放 projectDir/specs;各端代码在各自仓库(端路径从 CLAUDE-RULE.md / spec 的「涉及端」推断)。
const specsDir = `${projectDir}/specs`;
// .lyyflow-local/:本地知识沉淀根(教训主版本 + 笔记 + hooks 源文件)。不入 git、不进归档。
const localDir = `${projectDir}/.lyyflow-local`;
const lessonsLocalPath = `${localDir}/lessons-learned.md`; // 教训主版本(本地私有)
const notesDir = `${localDir}/notes`;                     // 会话笔记(开发者自由格式)
const prdSource = (args && args.prdSource) || null;
const feature = (args && args.feature) || null; // 单 spec 处理:只跑该 spec 的 Specs→Execute→Review
const doArchive = !!(args && args.archive);
const archiveName = (args && args.archiveName) || null;
// 归档根目录:可配置;默认 ~/lyyflow-archives(跨平台,不硬编码个人路径)。
const archiveRoot = (args && args.archiveRoot) || '~/lyyflow-archives';

// 跳过阶段:仅 PRD 对后续无数据依赖可被强制跳过(Specs→Execute→Review 串行依赖状态机)。
const rawSkip = (args && args.skip) || [];
const skipSet = new Set(
  (Array.isArray(rawSkip) ? rawSkip : [rawSkip]).map((s) =>
    String(s).toLowerCase(),
  ),
);
const skipPRD = skipSet.has('prd');
const SKIPPABLE = new Set(['prd']);
const ignoredSkips = [...skipSet].filter((s) => !SKIPPABLE.has(s));
if (ignoredSkips.length) {
  log(
    `【skip】忽略不可跳过的阶段 ${ignoredSkips.join(', ')}:Specs/Execute/Review 有数据依赖,只有 PRD 可强制跳过。`,
  );
}

// lyyflow 状态机(对齐 /lyyflow:prd|specs|ai|review 的状态字段):
//   待方案 → 待实现 → 待 review → 已完成
//   异常分支:方案待修正 / 需求待确认 / 待修复 / 待联调 / 阻塞中
const STATUS = {
  pendingPlan: '待方案',
  pendingImpl: '待实现',
  pendingReview: '待 review',
  done: '已完成',
  planFix: '方案待修正',
  reqConfirm: '需求待确认',
  pendingFix: '待修复',
  pendingJoint: '待联调',
  blocked: '阻塞中',
};

// ════════════════════════════════════════════════════════════
// 第零段:Archive 快速通道 —— 用户传 archive=true 且只归档
// ════════════════════════════════════════════════════════════
if (doArchive && !prdSource && !feature) {
  phase('Archive');
  const archiveResult = await runArchive();
  phase('Collect');
  return archiveResult;
}

// ════════════════════════════════════════════════════════════
// 第零段:Bootstrap —— 本地知识边界初始化(.lyyflow-local/ + .git/info/exclude + pre-commit hook + 安全检查)
// ════════════════════════════════════════════════════════════
let bootstrapReport = null;
if (!skipPRD || prdSource || feature) {
  // 仅在需要进入 PRD/Specs/Execute/Review 链路时跑 Bootstrap;
  // 纯 archive 短路(prdSource/feature 都无 + archive=true)跳过,避免对只读归档项目做改动。
  phase('Bootstrap');
  bootstrapReport = await runBootstrap();
  // Bootstrap 若 safetyCheckFailed,继续跑但冒泡;不阻断后续(specs/ 仍可读)。
  if (bootstrapReport && bootstrapReport.blockers && bootstrapReport.blockers.length) {
    log(
      `【Bootstrap】⚠️ 安全检查告警:${bootstrapReport.blockers.join(' | ')}。.lyyflow-local/ 不应进 git,请按提示处理。`,
    );
  } else {
    log('【Bootstrap】✅ .lyyflow-local/ 已就绪 — 本地教训沉淀区可用、git ls-files 安全检查通过。');
  }
}

// ════════════════════════════════════════════════════════════
// 第一段:PRD —— 需求拆分(原 /lyyflow:prd)
// ════════════════════════════════════════════════════════════
let prdReport;
if (skipPRD) {
  phase('PRD');
  log('【PRD】args.skip 含 PRD,强制跳过需求拆分(不读来源、不生成 specs/)。');
  prdReport = { mode: 'skipped-by-arg', specs: [], blockers: [] };
} else if (!prdSource) {
  // 没传 prdSource 且没 skip:不动 PRD,后续靠已存在的 specs/ 续跑。
  phase('PRD');
  log('【PRD】未提供 prdSource,跳过拆分(视为 specs/ 已存在或仅做单 spec 开发)。');
  prdReport = { mode: 'skipped-no-source', specs: [], blockers: [] };
} else {
  prdReport = await runPRD();
  // PRD 若冒泡出「需人工确认」的 blocker(缺接口文档等),但仍可能产出 spec;不阻断后续,
  // 后续 Specs 会按假设出方案并在备注标风险(对齐 /lyyflow:specs 的「接口缺失先标风险」)。
}

// 仅做 PRD(没指定单 spec 开发,也没要求归档)→ 收口。
if (!feature && !doArchive) {
  phase('Collect');
  log('【Collect】仅完成需求拆分。如需开发单 spec 传 args.feature;全部完成后传 args.archive 归档。');
  return {
    mode: 'prd-only',
    projectDir,
    prd: prdReport,
    blockers: prdReport.blockers || [],
  };
}

// ════════════════════════════════════════════════════════════
// 第二段:Specs → Execute → Review(单 spec 链路)
// ════════════════════════════════════════════════════════════

// 单 spec 模式:只处理 args.feature;否则按 overview.md 的并行组处理所有未完成 spec。
// 这里沿用 yd-ai-wf.js 的 pipeline 模式:组间串行、组内并行,每 spec 一完成就触发自己的 review。

phase('Specs');
log(`【Specs】${feature ? `处理单 spec ${feature}` : '按 overview 执行计划处理所有未完成 spec'}…`);

// 读 overview.md → 解析 spec 列表、并行组、状态(断点续跑:已完成的跳过)。
const OVERVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specs', 'groups'],
  properties: {
    specs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'ends', 'deps', 'status', 'done'],
        properties: {
          id: { type: 'string', description: 'spec 编号,如 spec-001' },
          name: { type: 'string', description: '功能名(中文短名)' },
          ends: {
            type: 'array',
            items: { type: 'string' },
            description: '涉及端,如 H5/小程序/后台/服务端',
          },
          deps: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', description: '状态机当前值' },
          done: { type: 'boolean', description: 'overview.md 已标 [x] 为 true' },
          repoPaths: {
            type: 'array',
            items: { type: 'string' },
            description: '各端项目根绝对路径(从 CLAUDE-RULE.md / overview 项目环境推断)',
          },
        },
      },
    },
    groups: {
      type: 'array',
      description: '组间串行、组内并行;只放未完成 spec id',
      items: { type: 'array', items: { type: 'string' } },
    },
  },
};

const overview = feature
  ? // 单 spec 模式:构造一个只含该 spec 的伪 overview(后续 agent 会读真实 spec 文件)。
    {
      specs: [{ id: feature, name: '(单 spec 模式)', ends: [], deps: [], status: STATUS.pendingImpl, done: false }],
      groups: [[feature]],
    }
  : await agent(
      `你在为 lyyflow 解析 specs/overview.md。项目根:${projectDir}

请 Read ${specsDir}/overview.md,提取结构化执行计划:
1. 解析 spec 列表:编号 id、名称、涉及端 ends、依赖 deps、当前状态 status、是否已标 [x](done=true)。
2. repoPaths:从 overview 的「项目环境」表 + 各 spec 的「项目/仓库」推断每端项目根绝对路径(用于后续在对应仓库跑 Execute/Review)。
3. groups:按依赖排并行组(组间串行、组内并行)。只放未完成(done=false 且 status≠已完成)的 spec id。
只读不写。若 overview.md 不存在,返回 specs:[] 与 groups:[]。`,
      { label: 'read:overview', phase: 'Specs', schema: OVERVIEW_SCHEMA, effort: 'low' },
    );

const specById = {};
for (const s of overview.specs || []) specById[s.id] = s;
const pendingSpecs = (overview.specs || []).filter((s) => !s.done && s.status !== STATUS.done);
const doneCount = (overview.specs || []).filter((s) => s.done || s.status === STATUS.done).length;
log(
  `【Specs】共 ${(overview.specs || []).length} 个 spec,已完成跳过 ${doneCount}(断点续跑),待处理 ${pendingSpecs.length},分 ${(overview.groups || []).length} 组`,
);

// ---- Specs 阶段:技术方案(原 /lyyflow:specs)----
const SPECS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specId', 'wrotePlan', 'status', 'constitutionViolations', 'blockers'],
  properties: {
    specId: { type: 'string' },
    wrotePlan: { type: 'boolean', description: '是否成功写入「## 技术方案」章节' },
    status: { type: 'string', description: '切到的新状态(正常→待实现;异常→方案待修正/需求待确认)' },
    ends: { type: 'array', items: { type: 'string' }, description: '本 spec 实际涉及的端(回填)' },
    constitutionViolations: {
      type: 'array',
      items: { type: 'string' },
      description:
        '方案与各端 CLAUDE-RULE.md「## 项目章程」条款冲突点,格式 "[constitution] <章程条款>: <方案哪里冲突>";已通过调整方案规避的冲突不写;无冲突则空数组',
    },
    blockers: {
      type: 'array',
      items: { type: 'string' },
      description:
        '需人工确认(需求待确认/技术不可行/缺接口契约/章程冲突无法规避);无则空数组',
    },
    note: { type: 'string' },
  },
};

function runSpecs(s) {
  // 单 spec 模式下 ends/repoPaths 可能缺,让 agent 自己从 spec 文件读出来。
  return agent(
    `你在执行 /lyyflow:specs 技术方案阶段。项目根:${projectDir}, specs 目录:${specsDir}
目标 spec: ${s.id}(${s.name})

严格按 /lyyflow:specs 流程:
1. 读 ${specsDir}/${s.id}*.md(需求、验收标准)和 ${specsDir}/overview.md(整体依赖 + 假设清单)。
2. 对本 spec 涉及的每个端/项目:确认项目根、若缺 CLAUDE-RULE.md 则增量生成(第一章节必须是「## 项目章程」:≤10 条不可违反原则,含常见默认条目如「API 变更必须向后兼容」「禁止破坏既有埋点」并标注待用户补充;后续章节:项目结构/技术栈/目录命名约定/公共组件/接口请求/状态管理/规范约束,末尾同时引用 ${lessonsLocalPath}(本地教训主版本,优先读)与 ${specsDir}/lessons-learned.md(公开快照,作为兜底)以便后续 agent 开工前能自动加载);已存在则先通读。
3. **章程对照(必须)**:逐条读各端 CLAUDE-RULE.md 的「## 项目章程」,把方案与章程条款对照。能调整方案规避的冲突 → 直接调整,不算 violation;无法规避(需求本身要求违反章程)→ 写进 constitutionViolations,在 spec「备注」记录冲突条款与理由,状态→需求待确认,并写进 blockers("[constitution] 章程 <条款> 与需求冲突,需人工裁决")。
4. **假设清单(必须)**:读 overview.md「假设清单」章节。涉及本 spec 的已确认([x])假设按事实处理;未确认假设按其默认假设出方案,并在「风险与影响」标注「假设 A-NN 未确认,默认按 <假设>,确认后可能需调整」。
5. 用 Glob/Grep 在各端定位相关模块/组件/页面/接口/数据模型/路由/状态。
6. 分析改动点:改/新增哪些文件、接口是否已存在或需新增、数据流/状态/路由变化、多端共享逻辑是否统一。
7. 给可落地技术方案:选型取舍(多方案给推荐+理由)、关键实现思路、对现有功能影响/回归风险、需其他端配合事项。明确标注「不在范围内」。
8. 在 spec 文件追加「## 技术方案」章节(用改动点清单表 + 方案 + 接口契约 + 章程对照结论 + 风险与影响 模板),状态改「待实现」。
9. 同步 ${specsDir}/overview.md 状态看板与「当前进度」。

异常流转:
- 方案待修正:先读 spec 的实现记录/审核结论,更新方案,状态→待实现,清旧实现记录。
- 发现需求问题:在 spec「备注」记录,状态→需求待确认,写进 blockers(冒泡给人工)。
- 技术不可行:在「备注」记录原因+替代建议,状态→需求待确认,写进 blockers。
- 章程冲突无法规避:见步骤 3,写 constitutionViolations + blockers。

接口契约缺口:若 ${specsDir}/api-contracts.md 不存在或本 spec 涉及接口未定义,不要擅自臆造接口 —— 先按合理假设出方案,在 spec「备注」标注「接口契约待补」风险,并写进 blockers(kind=external)。

埋点定义缺口:若 ${specsDir}/tracking-events.md 不存在或本 spec 涉及埋点未定义,不要擅自臆造埋点编码 —— 先按合理假设出方案,在 spec「备注」标注「埋点定义待补」风险,并写进 blockers(kind=external)。

开工前读 ${lessonsLocalPath}(主路径,本地教训)+ ${specsDir}/lessons-learned.md(公开快照,兜底),合并去重,作为项目已知坑避免重蹈。
只做技术方案,不写实现代码。返回 {specId, wrotePlan, status, ends, constitutionViolations, blockers, note}。`,
    { label: `specs:${s.id}`, phase: 'Specs', schema: SPECS_SCHEMA },
  );
}

// ---- Execute 阶段:编码实现(原 /lyyflow:ai)----
const EXECUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specId', 'files', 'verification', 'blockers', 'lessons'],
  properties: {
    specId: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, description: '改动的文件(相对路径)' },
    verification: { type: 'string', description: '自检结果:lint/test/验收标准逐条核对' },
    blockers: {
      type: 'array',
      items: { type: 'string' },
      description: '需人工确认(破坏性变更/业务歧义/PII/外部依赖未就绪);无则空数组',
    },
    lessons: {
      type: 'array',
      items: { type: 'string' },
      description: '本 spec 暴露的教训(为什么踩+怎么避免);无则空数组',
    },
    status: { type: 'string', description: '切到的新状态(正常→待 review;异常→待联调/阻塞中/方案待修正)' },
    note: { type: 'string' },
  },
};

function runExecute(s) {
  return agent(
    `你在执行 /lyyflow:ai 编码实现阶段。项目根:${projectDir}, spec:${specsDir}/${s.id}*.md
严格按 spec 的「## 技术方案」实现,不超出范围、不重构无关代码。

⚠️ 分支确认(必须最先执行):
1. 在每个端的项目根执行 git branch --show-current 获取当前分支名。
2. 如果当前分支是 main/master/develop 等非功能分支,立即停止实现,在 blockers 写 "[branch] 当前在 <分支名>,属于非功能分支,代码不应直接提交到此分支。请先切到正确的开发分支再重跑。"。
3. 如果当前分支看起来是功能分支(如 feature/*, fix/*, spec-*, 或其他非主干分支),继续实现。
4. 实现过程中,每次准备写文件前,再次 git branch --show-current 确认分支未变(防止中途被切走)。若分支变了,立即停止,在 blockers 写 "[branch] 实现过程中分支从 <原分支> 变为 <新分支>,已停止写入。"

开工前加载:
- 本 spec 文件(需求/验收标准/技术方案)
- ${specsDir}/overview.md(整体依赖)
- ${lessonsLocalPath}(本地教训主版本,务必遵守)+ ${specsDir}/lessons-learned.md(公开快照,兜底)
- ${specsDir}/api-contracts.md(如有接口契约)
- ${specsDir}/tracking-events.md(如有埋点定义)
- 各端项目根的 CLAUDE-RULE.md(项目规范:目录/命名/请求/状态管理;末尾会引用 ${lessonsLocalPath})

⚠️ 安全检查(必跑,防 .lyyflow-local/ 误进 git):
1. 执行 git -C ${projectDir} ls-files .lyyflow-local/ | head -5;若有输出 → 立即停止实现,在 blockers 写 "[external] .lyyflow-local/ 已被 git 跟踪,泄露了本地教训。请执行 git rm -r --cached .lyyflow-local/ 后重跑。"
2. 改动时只能 Write/Edit ${lessonsLocalPath} 与 ${notesDir}/**,**严禁** Write/Edit ${specsDir}/lessons-learned.md 之外的 ${localDir} 内容到项目根顶层路径(把 .lyyflow-local/ 内容写到仓库根会导致 git status 误识别)。

实现:
- 按技术方案的改动点清单逐项完成;多端按端依次实现,每端自检一次。
- 先读相邻代码再动手,遵循项目模式。涉及多端共享逻辑(接口契约/常量/类型)统一。
- 按技术方案的「埋点方案」逐项实现埋点调用,遵循项目既有 QTEventTracking 模式(先读相邻代码中的埋点调用,对齐格式和守卫方式)。
- 跑可用 lint/typecheck/test(若存在);逐条对照 spec【验收标准】自查。

异常流转:
- 发现方案根本性问题(接口不存在/依赖缺失/方案设计有误):立即停止,在 spec「备注」记录问题+影响+建议,状态→方案待修正,写进 blockers。不要强行绕过。
- 需求与实际不符/有遗漏:在「备注」记录差异,状态→需求待确认,写进 blockers。
- 外部原因(依赖接口未就绪)只能部分实现:实现记录标注已完成/未完成,状态→待联调,blockers 标 external。

完成:在 spec 追加「## 实现记录」(Schema JSON + 关键决策 + 遗留 TODO),状态→待 review,同步 overview.md 状态看板与「当前进度」。
沉淀教训:踩了新坑就分析「为什么+怎么避免」追加到 ${lessonsLocalPath}(本地主版本,不入 git,去重);同时把同一条目同步一份完整副本到 ${specsDir}/lessons-learned.md(公开快照,由用户后续手动编辑决定哪些可发布;本地版是 Source of Truth)。

返回 {specId, files, verification, blockers, lessons, status, note}。blockers 没有 Kind 字段,把 kind 直接写进描述(如 "[external] 接口未就绪")。`,
    { label: `execute:${s.id}`, phase: 'Execute', schema: EXECUTE_SCHEMA },
  );
}

// ---- Review 阶段(原 /lyyflow:review + Jev 轻校验 tier 路由)----
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specId', 'verdict', 'issues', 'p0Issues'],
  properties: {
    specId: { type: 'string' },
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
      description: 'review 是否通过(codex 或 jev 升级到 codex 后的最终 verdict)',
    },
    issues: {
      type: 'array',
      items: { type: 'string' },
      description: 'review 指出的问题(含 P0);pass 时空数组',
    },
    p0Issues: {
      type: 'array',
      items: { type: 'string' },
      description:
        '本轮实际跑的 review(codex 或 jev 升级到 codex)中明确标为 P0/Critical/「不修就不能交」的问题 + 违反项目章程的问题,原样抠出,具体到 文件:行 + 问题;无则空数组。会被当场派 agent 修复',
    },
    constitutionViolations: {
      type: 'array',
      items: { type: 'string' },
      description:
        '改动违反各端 CLAUDE-RULE.md「## 项目章程」条款的问题,格式 "[constitution] <章程条款>: <文件:行 违反点>";违反章程一律算 P0,必须同时写进 p0Issues;无则空数组',
    },
    summary: { type: 'string' },
    tier: {
      type: 'string',
      enum: ['core', 'standard', 'trivial'],
      description: '本轮实际跑的 tier:Jev 升级后会反映最终实际跑的层(见 tierEscalated)',
    },
    tierSource: {
      type: 'string',
      enum: ['manual', 'auto-jev'],
      description: 'tier 来源:spec「## 审核策略」手工指定 = manual;Jev Choice 判定 = auto-jev',
    },
    tierEscalated: {
      type: 'boolean',
      description: '是否从 trivial 升级到 standard(Jev 触发升级条件时为 true)',
    },
    tierFallback: {
      type: 'string',
      description: '降级记录,如 "jev-unavailable→core";无降级则空字符串',
    },
  },
};

function runReview(execResult, s) {
  if (!execResult) return null;
  const files = (execResult.files || []).join(' ');
  return agent(
    `审查刚完成的 spec ${s.id}(${s.name})。项目根:${projectDir}
改动文件:${files || '(spec 未报告文件)'}
spec 目录:${specsDir}

先读 ${lessonsLocalPath}(主路径,本地教训)+ ${specsDir}/lessons-learned.md(公开快照,兜底),评审时核对有没有重蹈。
再读本 spec 涉及的各端 CLAUDE-RULE.md 顶部「## 项目章程」(若该端缺章程段,视为无章程约束,不要臆造条款)——它是不可违反原则,**违反章程 = P0**。

## Step 0:路由判定(3 层 tier)

支持按 spec 复杂度走不同深度:
- **core**:调 Codex review + adversarial review(原 /lyyflow:review 全套)
- **standard**:仅调 Codex review(跳过 adversarial)
- **trivial**:仅调 Jev(TypeSafe System One)做 Noul/Score 轻校验;触发升级条件自动转 standard

判定流程:
1. Read ${specsDir}/${s.id}*.md,搜「## 审核策略」章节(由 /lyyflow:specs 模板可选生成)。
2. 若填了「期望层级: core|standard|trivial」→ tier = 该值, **tierSource=manual**,跳到对应分支。
3. 若未填 → 按以下顺序尝试加载 \`$TYPESAFE_API_KEY\`,找到就停(agent 在 Bash 里跑):
   \`\`\`bash
   [ -n "$TYPESAFE_API_KEY" ] || [ -f .lyyflow-local/secrets/.env ] && source .lyyflow-local/secrets/.env
   [ -n "$TYPESAFE_API_KEY" ] || [ -f ~/.typesafe/.env ] && source ~/.typesafe/.env
   \`\`\`
   - 都未设置 → tier=core, **tierSource=auto-jev**, **tierFallback="auto-jev-unavailable→core"**(Jev 不可用,自动按 core 跑)
   - 已设置 → 调用 Jev Choice 取 tier(见下方 curl 示例), **tierSource=auto-jev**。

Jev Choice 调用示例(curl + Bearer token):
\`\`\`bash
curl -s https://api.typesafe.ai/v1/systemone \\
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "jev-latest",
    "state": {
      "spec_title": "<spec 标题>",
      "diff_files": <N>,
      "diff_lines": <N>,
      "risk_keywords_hit": ["auth","payment","contract","race","permission","crypto"]
    },
    "questions": {
      "review_tier": {
        "type": "choice",
        "options": ["core","standard","trivial"],
        "instructions": "基于 spec 类型/规模/风险关键词命中,决定需要哪种深度。命中鉴权/支付/契约/并发/安全 → core;普通功能 → standard;纯重构/typo/重命名/样式 → trivial。"
      }
    }
  }'
\`\`\`
从响应取 \`questions.review_tier.choice\` 作为 tier。若 curl 失败 → tier=core, **tierFallback="auto-jev-error→core"**。

## 按 tier 执行

[tier == core]
按原 /lyyflow:review 流程:用 codex-plugin-cc 的 /codex:review(常规正确性)+ /codex:adversarial-review(设计/风险质疑)交叉审查。多端改动**每端各自**进入对应仓库跑 codex(聚焦语带上本 spec 的需求 + 验收标准 + 涉及端/接口契约)。

[tier == standard]
仅 /codex:review(跳过 /codex:adversarial-review)。

[tier == trivial](NEW, 调 Jev 不调 Codex)
1. 先按 Step 0.3 同样的 fallback 链 source \`.lyyflow-local/secrets/.env\` / \`~/.typesafe/.env\`,然后试一个最小 curl 健康检查(GET /v1/models 或一个最简 noul 调用)。失败 → tier=core, **tierFallback="jev-unavailable→core"**,改走 core 分支。
2. 对每个改动文件调 Jev Noul × 3:
   - **undeclared_var_ref**:此文件是否有调用未声明的变量或函数?
   - **obvious_typo**:此文件是否存在明显拼写错误?
   - **contract_drift**:此文件对外接口与 spec 契约是否一致?
   每个文件一次 curl(state.file_content = 文件全文,三项 questions):
   \`\`\`bash
   curl -s https://api.typesafe.ai/v1/systemone \\
     -H "Authorization: Bearer $TYPESAFE_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"model":"jev-latest","state":{"file_path":"<path>","file_content":"<read file>"},"questions":{"undeclared_var_ref":{"type":"noul","instructions":"此文件是否有调用未声明的变量或函数(拼写误、未 import、作用域外引用)?"},"obvious_typo":{"type":"noul","instructions":"此文件是否存在明显拼写错误?"},"contract_drift":{"type":"noul","instructions":"此文件对外接口(参数/类型/返回结构)是否与 spec 契约不一致?"}}}'
   \`\`\`
3. 对整个 spec 调 Jev Score × 1:
   \`\`\`bash
   curl -s https://api.typesafe.ai/v1/systemone \\
     -H "Authorization: Bearer $TYPESAFE_API_KEY" \\
     -H "Content-Type: application/json" \\
     -d '{"model":"jev-latest","state":{"spec_title":"<title>","changed_files":["<p1>","<p2>"]},"questions":{"code_clarity":{"type":"score","min":1,"max":5,"instructions":"整体代码可读性与一致性 1-5 分"}}}'
   \`\`\`
4. 判定:
   - **全 Noul false**(或概率 ≤ 0.7 为 true)**+ Score ≥ 3** + 全部 confidence > 0.5 → **verdict=pass, tier=trivial**
   - 否则 → **自动升级**:tier 改为 standard, **tierEscalated=true**,改用 /codex:review 跑一次,verdict 取 Codex 结果
5. Tier C **不抠 p0Issues**(Jev 无 P0 概念);升级到 standard 后才走 Codex p0Issues 提取

## 评审维度(无论 tier)

需求符合性、方案一致性、正确性(边界/空值/异步并发/接口契约/多端一致)、工程质量、风险(回归/兼容/性能/安全)、埋点完整性(key/pageId/触发时机/守卫判断)、**章程符合性(逐条对照各端「## 项目章程」,无论 tier 都必须人工核对一遍——Tier C 的 Jev 结构化校验不覆盖章程)**。

## 无人值守与降级

- 发现问题不等审批,verdict=fail 时写进 issues 冒泡。
- 把本轮实际跑的 review(无论 tier)中明确标 P0/Critical/「不修就不能交」的问题,原样单独抠进 p0Issues;**违反项目章程的问题也一律写进 p0Issues(=P0)**。描述具体到 文件:行 + 问题本身。
- 若 codex 插件不可用(降级或 standard/core 都涉及):verdict=fail、issues 写「codex-plugin-cc 未安装/未配置,需先 /codex:setup」、p0Issues 为空。
- 若 Jev API 调用失败且 tier=trivial:已自动降级到 core(见上),tierFallback 记录原因。

## 返回

{ specId, verdict, issues, p0Issues, constitutionViolations, summary, tier, tierSource, tierEscalated, tierFallback }。`,
    { label: `review:${s.id}`, phase: 'Review', schema: REVIEW_SCHEMA },
  );
}

// 标记 spec 完成:在 overview.md 把该 spec 的复选框 [ ]→[x](断点续跑靠它)+ spec 文件状态→已完成。
const MARK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specId', 'marked'],
  properties: {
    specId: { type: 'string' },
    marked: { type: 'boolean', description: '是否成功标 [x] 并把状态改已完成' },
    note: { type: 'string' },
  },
};

function markSpecDone(s, reviewResult, fixResult) {
  // 仅在 review 通过且无遗留 P0 时标 [x];否则不标,留给人工/重跑。
  const pass = reviewResult && reviewResult.verdict === 'pass';
  const noRemainingP0 = !(fixResult && (fixResult.remaining || []).length);
  if (!pass || !noRemainingP0) return Promise.resolve({ specId: s.id, marked: false, note: 'review 未通过或仍有 P0 未修,不标记完成' });
  // tier 元数据(用于在 overview.md 和 spec 审核结论里留痕)
  const tier = (reviewResult && reviewResult.tier) || 'unknown';
  const tierSource = (reviewResult && reviewResult.tierSource) || 'unknown';
  const tierEscalated = !!(reviewResult && reviewResult.tierEscalated);
  const tierFallback = (reviewResult && reviewResult.tierFallback) || '';
  const constitutionHits = (reviewResult && reviewResult.constitutionViolations) || [];
  const tierTag = `[tier=${tier}, src=${tierSource}${tierEscalated ? ', escalated' : ''}${tierFallback ? `, fallback=${tierFallback}` : ''}]`;
  return agent(
    `把 spec ${s.id}(${s.name})标记为已完成。本轮 review tier=${tierTag}
章程核对:本轮 constitutionViolations ${constitutionHits.length} 条${constitutionHits.length ? `(${constitutionHits.join('; ')})——已全部修复才允许标完成,把每条「违反→修复方式」写进审核结论` : '(无违反)'}`}
1. 在 ${specsDir}/overview.md 的 spec 列表里:
   - 该 spec 的「完成标记」列 [ ]→[x],状态列→「已完成」
   - 若 tier=trivial 且 review tierSource=auto-jev → 在该行末尾追加 \`tier-c-jev-passed (${new Date().toISOString().slice(0,10)})\` 标记,便于审计追溯
   - 更新「当前进度」与「状态看板」
2. 在 ${specsDir}/${s.id}*.md 追加「## 审核结论」,顶部第一行写 \`- tier: ${tier} (${tierSource}${tierEscalated ? ', escalated' : ''}${tierFallback ? `, ${tierFallback}` : ''})\`,然后按 /lyyflow:review 模板写「审查方 + 结论 + 已修复 P0 + 建议项」。Tier A/B 用 Codex 模板;Tier C 用 Jev 模板(含 Noul/Score 结果表)。最后把文件首部状态字段→「已完成」。
3. 若 tierFallback 含 jev-unavailable → 在 overview.md Blockers 章节追加一条 [external] 提醒装 Jev(便于后续节省 Codex 配额)。
只 Edit 对应行/字段,不重排、不动其它内容。找不到对应行则 marked=false 并 note 说明。
返回 {specId, marked, note}。`,
    { label: `mark:${s.id}`, phase: 'Review', schema: MARK_SCHEMA },
  );
}

// P0 当场修复:reviewer 只读只判;报了 P0 → 另派带 Write/Edit 的修复 agent 只修 P0(职责分离),修复后复跑 review 验证。
const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specId', 'fixed', 'fixedFiles'],
  properties: {
    specId: { type: 'string' },
    fixed: { type: 'boolean', description: '是否已修复全部 P0' },
    fixedFiles: { type: 'array', items: { type: 'string' }, description: '本次修改的文件' },
    remaining: { type: 'array', items: { type: 'string' }, description: '无法当场修复、仍需人工的 P0;全修完则空数组' },
    note: { type: 'string' },
  },
};

function fixP0(execResult, reviewResult, s) {
  const p0 = (reviewResult && reviewResult.p0Issues) || [];
  if (!p0.length) return null;
  const files = (execResult.files || []).join(' ');
  return agent(
    `spec ${s.id}(${s.name})的 codex review 报出了 P0(不修就不能交)。立刻修复这些 P0,只修 P0,不要顺手重构。
项目根:${projectDir}
spec 改动文件:${files || '(未报告)'}
要修的 P0:
${p0.map((x, i) => `${i + 1}. ${x}`).join('\n')}

开工前读 ${lessonsLocalPath}(主路径,本地教训)+ ${specsDir}/lessons-learned.md(公开快照,兜底)与各端 CLAUDE-RULE.md,修复符合项目规范、别重蹈已知坑。
逐条修复并自检(能跑的话编译/测试过一遍)。确实无法当场修(需人工决策/缺设计/缺接口)的留进 remaining 别硬改。
返回 {specId, fixed, fixedFiles, remaining, note}。`,
    { label: `fix-p0:${s.id}`, phase: 'Review', schema: FIX_SCHEMA },
  );
}

// 沉淀教训(自学习闭环):把本 spec 实现与 review 中的教训追加到 lessons-learned.md。
const LEARN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specId', 'appended'],
  properties: {
    specId: { type: 'string' },
    appended: { type: 'boolean', description: '是否追加了教训(无新教训则 false)' },
    lessons: { type: 'array', items: { type: 'string' }, description: '写进去的教训条目;无则空数组' },
  },
};

function learnSpec(execResult, reviewResult, fixResult, s) {
  if (!execResult) return null;
  const issues = ((reviewResult && reviewResult.issues) || []).join('; ');
  const p0 = ((reviewResult && reviewResult.p0Issues) || []).join('; ');
  const blockers = (execResult.blockers || []).join('; ');
  const fixedNote =
    fixResult && fixResult.fixed
      ? `已当场修复(改了 ${(fixResult.fixedFiles || []).join(' ') || '若干文件'})`
      : fixResult
        ? '尝试修复但有遗留'
        : '';
  return agent(
    `把开发 spec ${s.id}(${s.name})的「项目级教训」沉淀到双路径(自学习闭环,供后续 spec 与人类开发者读):
- 主版本(Source of Truth,本地私有):${lessonsLocalPath} — 不入 git,个人经验/项目私有坑/调试复盘都可写
- 公开快照(团队可见,可被 archive 复制):${specsDir}/lessons-learned.md — 默认同步主版本完整副本,由用户后续手动编辑决定哪些可发布

本 spec 改动文件:${(execResult.files || []).join(' ') || '(未报告)'}
本 spec 暴露的 blocker:${blockers || '(无)'}
review 指出的问题:${issues || '(无)'}
其中 codex 报的 P0:${p0 || '(无)'}${fixedNote ? `(${fixedNote})` : ''}
若有 P0 已被当场修复,优先把「为什么会犯这个 P0、以后怎么避免」沉淀成一条教训(最值钱的复用知识)。

只记「对后续开发有复用价值」的:库/接口的坑、易踩错的约定、必须先做的前置步骤、环境/配置陷阱、被 review 反复指出的反模式。
不要记:一次性业务细节、纯属本 spec 的实现描述、已在 CLAUDE-RULE.md 里的通用规范。无值得沉淀的则 appended=false 不硬写。

操作(双路径都按以下流程处理):
1. 用 Read 看 ${lessonsLocalPath} 现状(没有就新建,顶部加 "# 项目踩坑与教训(本地私有版,不入 git)" 标题 + 说明「Source of Truth;公开快照同步在 specs/lessons-learned.md,由用户决定哪些可发布」+ 累计教训计数)。
2. 追加时去重——已有同类条目不重复写。每条带 spec 来源,如 "## [${s.id}] <问题简述>\\n- 触发场景/根因/解决/预防/关联文件"。
3. 写完后,**把同一份追加后的完整内容**同步写到 ${specsDir}/lessons-learned.md(顶部标题改为 "# 项目踩坑与教训(公开快照,主版本在 .lyyflow-local/)"+ 累计教训计数同步)。两者内容一致,后续用户编辑公开快照以决定发布范围。
返回 {specId, appended, lessons, writtenToLocal: bool, writtenToPublic: bool}。
返回 {specId, appended, lessons}。`,
    { label: `learn:${s.id}`, phase: 'Review', schema: LEARN_SCHEMA },
  );
}

// pipeline:spec → Specs(方案) → Execute(实现) → Review(审核 + 标记 + 修 P0 + 沉淀)
//   组间串行保依赖,组内并行:每 spec 一完成 review 就触发后续,不等同组。
async function runSpecPipeline(s) {
  // Specs 阶段:若有 blocker(需求待确认/技术不可行/缺接口)→ 冒泡,不进 Execute。
  const specsRes = await runSpecs(s);
  if (!specsRes || !specsRes.wrotePlan || (specsRes.blockers || []).length) {
    return { spec: s, specs: specsRes, execute: null, review: null, fix: null, marked: false, learned: false };
  }
  // Execute 阶段
  const execRes = await runExecute(s);
  if (!execRes || (execRes.blockers || []).length) {
    // 实现有 blocker(方案待修正/待联调)→ 冒泡,不进 Review。
    return { spec: s, specs: specsRes, execute: execRes, review: null, fix: null, marked: false, learned: false };
  }
  // Review 阶段:review 先跑(后续 fix/learn/mark 都用它的结论)。
  const [rv, learn0] = await parallel([
    () => runReview(execRes, s),
    () => learnSpec(execRes, null, null, s), // 实现阶段先沉淀一次教训(不等 review)
  ]);
  // codex review 报 P0 → 当场派修复 agent 只修 P0,修完复跑 review 验证(一轮)。
  let fix = await fixP0(execRes, rv, s);
  let review = rv;
  if (fix && fix.fixed && (rv.p0Issues || []).length) {
    const reReview = await runReview(execRes, s);
    if (reReview) review = reReview;
  }
  // 修复后补沉淀教训(带上 P0 是怎么修的)。
  const learn1 = await learnSpec(execRes, review, fix, s);
  const learned = !!(learn0 && learn0.appended) || !!(learn1 && learn1.appended);
  // 标记完成(仅 review 通过且无遗留 P0)。
  const mark = await markSpecDone(s, review, fix);
  return { spec: s, specs: specsRes, execute: execRes, review, fix, marked: !!(mark && mark.marked), learned };
}

phase('Review');
const reviewed = [];
for (let g = 0; g < (overview.groups || []).length; g++) {
  const group = (overview.groups[g] || []).map((id) => specById[id]).filter(Boolean);
  if (!group.length) continue;
  log(
    `【Execute】第 ${g + 1}/${overview.groups.length} 组:${group.map((s) => s.id).join(' + ')}（组内并行:Specs→Execute→Review 各自闭环）`,
  );
  const groupReviewed = (await pipeline(group, runSpecPipeline)).filter((x) => x && x.spec);
  for (const x of groupReviewed) reviewed.push(x);
}

// ════════════════════════════════════════════════════════════
// 归档段(原 /lyyflow:archive)—— 全部 spec 已完成且审核通过时执行
// ════════════════════════════════════════════════════════════
let archiveReport = null;
const allDone = (overview.specs || []).length > 0 && (overview.specs || []).every((s) => s.done || s.status === STATUS.done);
const newlyMarked = reviewed.filter((x) => x.marked).length;
const fullyDone = allDone || (reviewed.length > 0 && reviewed.every((x) => x.marked) && pendingSpecs.length === reviewed.length);

if (doArchive && fullyDone) {
  archiveReport = await runArchive();
} else if (doArchive) {
  // 用户想归档但前置不满足:冒泡未完成项,不归档。
  phase('Archive');
  const incomplete = (overview.specs || [])
    .filter((s) => !(s.done || s.status === STATUS.done))
    .map((s) => `${s.id}(${s.status || '未完成'})`);
  log(`【Archive】归档条件不满足,未完成 spec:${incomplete.join(', ') || '(无)'}。不执行归档,详情冒泡。`);
  archiveReport = { mode: 'condition-not-met', incomplete, archivePath: null };
}

// ════════════════════════════════════════════════════════════
// Collect:汇总 + blocker 分类冒泡(沿用 yd-ai-wf.js 的分类)
// ════════════════════════════════════════════════════════════
phase('Collect');

// 冒泡规则(对齐 /lyyflow:review 的 blocker 分类):
//   task:spec 开发自身 blocker(破坏性变更/业务歧义/PII/方案待修正/需求待确认/待联调)
//   branch:分支错误(在非功能分支上开发/实现过程中分支被切走)
//   review:review fail 的非 P0 问题
//   p0-unfixed:修复 agent 修不掉、仍需人工的 P0(含违反项目章程修不掉的)
//   external:外部依赖未就绪(接口契约缺失/设计稿缺失/codex 插件未装)
//   assumption:PRD 假设清单中未经用户确认的假设([assumption] 前缀;用户在 overview.md
//              「假设清单」把对应条目标 [x] 或修改默认假设后重跑即消)
const fixById = {};
for (const x of reviewed) if (x.fix) fixById[x.spec.id] = x.fix;

const allBlockers = [
  // Bootstrap 段冒泡(.lyyflow-local/ 已被 git 跟踪等)
  ...((bootstrapReport && bootstrapReport.blockers) || []).map((b) => ({ specId: '-', kind: 'external', blocker: `[bootstrap] ${b}` })),
  // PRD 段冒泡(接口/埋点文档缺口 external;未确认假设 → assumption)
  ...((prdReport && prdReport.blockers) || []).map((b) => ({
    specId: '-',
    kind: /\[assumption\]|假设/.test(b) ? 'assumption' : 'prd',
    blocker: b,
  })),
  // task blocker(含分支错误 [branch];章程冲突归 task,review 侧另有 constitutionViolations 统计)
  ...reviewed.flatMap((x) =>
    ((x.execute && x.execute.blockers) || []).map((b) => ({
      specId: x.spec.id,
      kind: /external|接口|设计|埋点|tracking/.test(b) ? 'external' : /\[branch\]/.test(b) ? 'branch' : 'task',
      blocker: b,
    })),
  ),
  // specs 段 blocker(需求待确认/技术不可行/章程冲突 → 归 task;缺接口 → external)
  ...reviewed.flatMap((x) =>
    ((x.specs && x.specs.blockers) || []).map((b) => ({
      specId: x.spec.id,
      kind: /接口|external|设计|埋点|tracking/.test(b) ? 'external' : 'task',
      blocker: b,
    })),
  ),
  // review 非 P0 问题
  ...reviewed
    .filter((x) => x.review && x.review.verdict === 'fail')
    .flatMap((x) => {
      const fix = fixById[x.spec.id];
      const p0Set = new Set((x.review.p0Issues || []));
      const resolvedP0 = fix && fix.fixed ? p0Set : new Set();
      const stillOpen = (x.review.issues || []).filter((i) => !resolvedP0.has(i));
      return stillOpen.map((i) => ({ specId: x.spec.id, kind: 'review', blocker: i }));
    }),
  // 修复 agent 修不掉的 P0
  ...reviewed.flatMap((x) =>
    ((x.fix && x.fix.remaining) || []).map((i) => ({ specId: x.spec.id, kind: 'p0-unfixed', blocker: i })),
  ),
];

const failedReviews = reviewed.filter((x) => x.review && x.review.verdict === 'fail').map((x) => x.spec.id);
const markedCount = reviewed.filter((x) => x.marked).length;
const learnedCount = reviewed.filter((x) => x.learned).length;
const p0FixedCount = reviewed.filter((x) => x.fix && x.fix.fixed).length;
const p0SeenCount = reviewed.filter((x) => x.review && (x.review.p0Issues || []).length).length;
const branchBlockers = allBlockers.filter((b) => b.kind === 'branch');
// tier 分布统计(codex 配额节省可视化)
const tierCounts = reviewed.reduce((acc, x) => {
  const t = (x.review && x.review.tier) || 'unknown';
  acc[t] = (acc[t] || 0) + 1;
  return acc;
}, {});
const tierEscCount = reviewed.filter((x) => x.review && x.review.tierEscalated).length;
const tierFbCount = reviewed.filter((x) => x.review && x.review.tierFallback).length;
// 章程违反统计(方案阶段 + review 阶段,去重合并描述)
const constitutionHits = reviewed.flatMap((x) => {
  const fromSpecs = (x.specs && x.specs.constitutionViolations) || [];
  const fromReview = (x.review && x.review.constitutionViolations) || [];
  return [...new Set([...fromSpecs, ...fromReview])].map((v) => ({ specId: x.spec.id, violation: v }));
});
const assumptionBlockers = allBlockers.filter((b) => b.kind === 'assumption');
log(
  `【Collect】本轮处理 ${reviewed.length} 个 spec;已标 [x] 完成 ${markedCount} 个;沉淀教训 ${learnedCount} 个 → lessons-learned.md;review P0 命中 ${p0SeenCount} 个 spec、当场修复 ${p0FixedCount} 个;review 未过 ${failedReviews.length} 个;分支错误 ${branchBlockers.length} 个;章程违反 ${constitutionHits.length} 条;未确认假设 ${assumptionBlockers.length} 条;冒泡 ${allBlockers.length} 个待人工确认的 blocker;review tier 分布 core=${tierCounts.core || 0}/standard=${tierCounts.standard || 0}/trivial=${tierCounts.trivial || 0}/unknown=${tierCounts.unknown || 0}(升级 ${tierEscCount} 个、降级 ${tierFbCount} 个)`,
);

return {
  mode: doArchive && archiveReport && archiveReport.archivePath ? 'full+archive' : 'full',
  projectDir,
  prd: prdReport,
  archive: archiveReport,
  plannedSpecs: (overview.specs || []).length,
  executedSpecs: reviewed.length,
  markedSpecs: markedCount,
  p0Fixed: p0FixedCount,
  reviewTiers: {
    core: tierCounts.core || 0,
    standard: tierCounts.standard || 0,
    trivial: tierCounts.trivial || 0,
    escalated: tierEscCount,
    fallbacks: tierFbCount,
  },
  constitutionViolations: constitutionHits,
  blockers: allBlockers,
  note: 'P0(review 命中 + 违反项目章程)当场派 agent 修复并复跑验证;review tier 路由:trivial 由 Jev(TypeSafe System One)轻校验,standard 仅 Codex review,core Codex review + adversarial。trivial 触发升级条件自动转 standard。未确认假设([assumption])在 overview.md「假设清单」确认后重跑即消。非 P0 / 标记完成 / QA / 审批 / 归档确认 由外层 command 与 Stop hook 门禁处理',
};

// ════════════════════════════════════════════════════════════
// 辅助:Bootstrap 段 —— 本地知识边界初始化(.lyyflow-local/ + .git/info/exclude + pre-commit hook + git ls-files 安全检查)
// ════════════════════════════════════════════════════════════
async function runBootstrap() {
  log(`【Bootstrap】初始化本地知识边界 ${localDir} ……`);

  const BOOTSTRAP_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['localDirReady', 'excludeWritten', 'hookInstalled', 'safetyCheckPassed', 'blockers'],
    properties: {
      localDirReady: {
        type: 'boolean',
        description: '.lyyflow-local/ 目录与子目录(lessons-learned.md + notes/)是否就绪',
      },
      excludeWritten: {
        type: 'boolean',
        description: '.git/info/exclude 是否含 /.lyyflow-local/ 行',
      },
      hookInstalled: {
        type: 'boolean',
        description: '.git/hooks/pre-commit 是否已写入 .lyyflow-local/ 拦截逻辑(幂等)',
      },
      safetyCheckPassed: {
        type: 'boolean',
        description: 'git ls-files .lyyflow-local/ 是否为空(若不为空 → 已被跟踪,failed)',
      },
      excludedRules: {
        type: 'array',
        items: { type: 'string' },
        description: '实际写入 .git/info/exclude 的规则行',
      },
      hookPath: { type: 'string', description: 'pre-commit hook 绝对路径' },
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description: '不可恢复的失败(safetyCheckFailed 等);无则空数组',
      },
    },
  };

  const result = await agent(
    `你在执行 lyyflow 的 Bootstrap 段 —— 为当前项目建立「本地知识沉淀区」,确保它**不进 git 远程**且**不进 archive**。

项目根:${projectDir}
本地沉淀根:${localDir}
本地教训主版本:${lessonsLocalPath}
笔记目录:${notesDir}

⚠️ 幂等性:已存在的不破坏,只补缺失项。

按以下步骤执行(用 Bash + Read + Write/Edit):

1. **建立 .lyyflow-local/ 目录结构**:
   - Bash: mkdir -p "${localDir}/notes" "${localDir}/hooks"
   - 若 ${lessonsLocalPath} 不存在 → Write 新建(顶部标题 "# 项目踩坑与教训(本地私有版,不入 git)" + 说明"Source of Truth;公开快照同步在 specs/lessons-learned.md,由用户决定哪些可发布"+ 累计教训 0 条)
   - 若存在 → 跳过(action=skipped)

2. **写 .git/info/exclude**(本地级 gitignore,**只对这个 clone 生效**,不入仓库):
   - Read ${projectDir}/.git/info/exclude(不存在则新建空文件)
   - 检查是否已含 "/.lyyflow-local/" 这一行(整词匹配);若没有 → Edit 追加(末尾两行): "/.lyyflow-local/" 与 "/specs/lessons-learned.md"
   - 记录实际写入的规则到 excludedRules 数组

3. **装 pre-commit hook**(双保险,防 git add -f 强制添加):
   - Write ${projectDir}/.git/hooks/pre-commit(若已存在 lyyflow 维护的 marker "### lyyflow-managed-block ###" → 幂等替换该段;否则不覆盖,Read 现有内容并 prepend lyyflow 检查段):
     \`\`\`bash
     #!/usr/bin/env bash
     # ### lyyflow-managed-block ###
     # 防止 .lyyflow-local/ 本地知识被强制 git add -f 进仓库
     set -e
     STAGED=$(git diff --cached --name-only --diff-filter=A | grep -E '(^|/)(.lyyflow-local/|.lyyflow-local$|specs/lessons-learned\.md)' || true)
     if [ -n "$STAGED" ]; then
       echo "[lyyflow pre-commit] 检测到本地知识沉淀被加入提交:"
       echo "$STAGED"
       echo "请用 git reset HEAD <file> 撤回,或确认是否真要公开这些内容。"
       exit 1
     fi
     # ### lyyflow-managed-block-end ###
     \`\`\`
   - Bash: chmod +x "${projectDir}/.git/hooks/pre-commit" 2>/dev/null || true(Windows Git Bash 下文件存在即可,执行权限非必需)
   - 记录 hookPath

4. **安全检查(git ls-files)**:
   - Bash: git -C "${projectDir}" ls-files .lyyflow-local/ | head -5
   - 若有输出(safetyCheckPassed=false)→ 在 blockers 写 "[external] .lyyflow-local/ 已被 git 跟踪,本地教训存在泄露风险。请执行: git rm -r --cached .lyyflow-local/ && git commit -m 'chore: untrack .lyyflow-local'"

5. **追加说明到 lessons 主版本顶部**(若还没有 lyyflow 标记):
   - Read ${lessonsLocalPath};若不含 "⚠️ 本文件不进 ${archiveRoot} 归档" → Edit 在说明段加一行注释。

返回 {localDirReady, excludeWritten, hookInstalled, safetyCheckPassed, excludedRules, hookPath, blockers}。
不要修改 ${specsDir}/ 下任何文件(那是 PRD 段的事);不要修改 CLAUDE-RULE.md。`,
    { label: 'bootstrap:init', phase: 'Bootstrap', schema: BOOTSTRAP_SCHEMA },
  );

  return result;
}

// ════════════════════════════════════════════════════════════
// 辅助:PRD 段(原 /lyyflow:prd,workflow 沙箱无交互 → 接口文档缺口改冒泡)
// ════════════════════════════════════════════════════════════
async function runPRD() {
  phase('PRD');
  log(`【PRD】读取需求来源 ${prdSource} 并拆分功能点 spec …`);

  const PRD_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'source', 'ends', 'specs', 'hasApiContracts', 'blockers'],
    properties: {
      title: { type: 'string', description: '需求标题' },
      source: { type: 'string', description: '需求来源类型(file/url/pdf/text)' },
      ends: { type: 'array', items: { type: 'string' }, description: '涉及端(H5/小程序/后台/服务端...)' },
      specs: {
        type: 'array',
        description: '拆分出的功能点 spec',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'name', 'ends', 'deps', 'acceptance'],
          properties: {
            id: { type: 'string', description: 'spec 编号 spec-001' },
            name: { type: 'string', description: '中文短名' },
            ends: { type: 'array', items: { type: 'string' } },
            deps: { type: 'array', items: { type: 'string' } },
            acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准(可核验)' },
            needNewApi: { type: 'boolean', description: '是否涉及新增接口' },
            needTracking: { type: 'boolean', description: '是否涉及新增埋点' },
          },
        },
      },
      groups: {
        type: 'array',
        description: '按依赖排的并行组(组间串行、组内并行)',
        items: { type: 'array', items: { type: 'string' } },
      },
      hasApiContracts: { type: 'boolean', description: 'specs/api-contracts.md 是否已存在且完整' },
      hasTrackingEvents: { type: 'boolean', description: 'specs/tracking-events.md 是否已存在且完整' },
      assumptions: {
        type: 'array',
        description:
          '假设清单:需求中的歧义点/信息缺口/隐含决策点,每条给默认假设(前置澄清,减少事后需求待确认返工)',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'question', 'assumption', 'impact', 'confirmed'],
          properties: {
            id: { type: 'string', description: '假设编号,如 A-001' },
            question: { type: 'string', description: '需求歧义点/缺口(要问什么)' },
            assumption: { type: 'string', description: '默认采用的假设(确认前按此出方案)' },
            impact: { type: 'string', description: '影响的 spec 编号(如 spec-001,spec-003)' },
            confirmed: { type: 'boolean', description: '是否已确认(overview.md 假设清单里已标 [x] / 用户此前明确说过 = true)' },
          },
        },
      },
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description:
          '缺口冒泡:缺接口文档 / 缺设计稿 / 未确认假设(格式 "[assumption] A-NNN <歧义点>,默认按 <假设>,请确认或修改 overview.md 假设清单");无则空数组',
      },
      overviewExists: { type: 'boolean', description: 'specs/overview.md 是否已存在(断点续跑判据)' },
    },
  };

  const analysis = await agent(
    `你在执行 /lyyflow:prd 需求拆分。项目根:${projectDir}, specs 目录:${specsDir}
需求来源:${prdSource}

按来源读取:
- 本地文件(.md/.txt/.docx/.pdf)→ Read(PDF 直接传路径)
- 禅道/网页 URL → WebFetch 抓正文
- 纯文本需求 → 直接作为内容

断点续跑:先看 ${specsDir}/overview.md 是否存在。
- 已存在:读 spec 列表状态,已完成(标 [x])的跳过,只续接「待方案」的;若全部完成,blockers 写「需求已全部完成,如需新增请重跑」。
- 不存在:正常拆分。

执行:
1. 通读需求,提炼背景/目标/用户/业务场景。
2. **假设清单(前置澄清,必须)**:把需求中所有歧义点/信息缺口/隐含决策点列成 assumptions —— 每条一个具体问题 + 一个可执行的默认假设 + 影响的 spec。宁可多列不要漏(漏一个歧义 = 后期一次「需求待确认」返工)。断点续跑时:overview.md「假设清单」里已标 [x] 的条目 confirmed=true,新增歧义补新条目。
3. 识别涉及端(H5/小程序/App/后台/服务端),逐端列改动范围。
4. 拆成多个 spec:单个可独立完成+独立验收,标【涉及端】【依赖】【验收标准(checkbox)】。
5. 按依赖排并行组(无依赖/不同项目→并行;有依赖/改同文件/共享 schema→串行)。
6. 接口文档:检查 ${specsDir}/api-contracts.md。workflow 沙箱无法交互询问用户 —— 若涉及新增接口而文档缺失,hasApiContracts=false 并在 blockers 写「[external] spec-XXX 涉及新增接口但 api-contracts.md 缺失,需人工补充接口定义」(每个缺口一条)。不要擅自臆造接口。
7. 埋点文档:检查 ${specsDir}/tracking-events.md。若涉及新增埋点而文档缺失,hasTrackingEvents=false 并在 blockers 写「[external] spec-XXX 涉及新增埋点但 tracking-events.md 缺失,需人工补充埋点定义」(每个缺口一条)。不要擅自臆造埋点编码。
8. 未确认假设冒泡:confirmed=false 的假设,每条在 blockers 写「[assumption] <id> <歧义点>,默认按 <默认假设>,请在 overview.md「假设清单」确认([ ]→[x])或修正假设后重跑」。
9. lessons-learned.md:双路径处理 —— ${lessonsLocalPath}(主版本,本地私有,Source of Truth)由 Bootstrap 阶段创建并维护;${specsDir}/lessons-learned.md(公开快照,团队可见,默认同步主版本内容,由用户后续手动编辑决定哪些可发布)若不存在则创建(顶部 "# 项目踩坑与教训(公开快照,主版本在 .lyyflow-local/)" + 累计教训 0 条)。

只做需求拆分,不写技术方案、不写代码。返回 {title, source, ends, specs, groups, hasApiContracts, hasTrackingEvents, assumptions, blockers, overviewExists}。`,
    { label: 'analyze:prd', phase: 'PRD', schema: PRD_SCHEMA },
  );

  // 产物生成:overview.md + 各 spec 文件 + 每端 CLAUDE-RULE.md 增量补(并行)。
  const WRITE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'action'],
    properties: {
      path: { type: 'string' },
      action: { type: 'string', enum: ['created', 'appended', 'skipped'] },
      note: { type: 'string' },
    },
  };

  const allEnds = [...new Set((analysis.specs || []).flatMap((s) => s.ends || []))];
  const INCREMENTAL = analysis.overviewExists
    ? `specs/ 已存在。严格遵守增量模式:目标已存在且完整 → action=skipped 不动;缺章节 → 只追加,action=appended;不存在 → 新建,action=created。绝不覆盖已有内容。`
    : `specs/ 不存在,全新初始化,正常新建,action=created。`;

  const prdWriteTasks = [
    () =>
      agent(
        `写/补 ${specsDir}/overview.md(lyyflow 需求总览中枢)。
需求:${analysis.title} | 来源:${analysis.source} | 涉及端:${(analysis.ends || []).join(', ') || '(未识别)'}
${INCREMENTAL}

overview.md 必须含:基本信息(标题/来源/端/创建时间 placeholder)、项目环境表(端|路径|CLAUDE-RULE.md 状态)、**假设清单**(编号 A-NNN|歧义点|默认假设|影响 spec|确认 [ ];已确认的标 [x])、接口文档状态、埋点文档状态(已提供/无新增埋点/待填写)、文档来源、备注、spec 列表表(编号|名称|涉及端|依赖|状态|完成标记 [ ])、依赖关系图、执行计划(并行组表)、状态看板、当前进度、Blockers 表(类型:task/review/p0-unfixed/external/assumption)、教训沉淀计数(指向 lessons-learned.md)。
spec 列表用 ${(analysis.specs || []).map((s) => `${s.id}|${s.name}|${(s.ends || []).join('/')}|${(s.deps || []).join(',') || '无'}|待方案|[ ]`).join(' ; ')} 填。
假设清单用 ${((analysis.assumptions || []).map((a) => `${a.id}|${a.question}|${a.assumption}|${a.impact}|${a.confirmed ? '[x]' : '[ ]'}`).join(' ; ')) || '(无假设)'} 填;断点续跑时已有条目(含已标 [x])保持原样,只追加新条目。
断点续跑:已标 [x] 的保持原样不动。
用 Read 确认现状后 Write/Edit。返回 {path, action, note}。`,
        { label: 'write:overview', phase: 'PRD', schema: WRITE_SCHEMA },
      ),
    ...((analysis.specs || []).map((s) => () =>
      agent(
        `写/补 ${specsDir}/${s.id}-${s.name}.md(单功能点 spec)。
${INCREMENTAL}

spec 文件含:标题 spec-NNN <名称>、元信息(涉及端/项目仓库/依赖/状态:待方案)、背景、详细需求、验收标准(checkbox - [ ])、备注。
本 spec 验收标准:
${(s.acceptance || []).map((a, i) => `${i + 1}. ${a}`).join('\n')}
若 needNewApi 但 ${analysis.hasApiContracts ? 'api-contracts 已有' : 'api-contracts.md 缺失'},在「备注」标注接口契约缺口风险。
用 Read 确认现状后 Write/Edit。返回 {path, action, note}。`,
        { label: `write:${s.id}`, phase: 'PRD', schema: WRITE_SCHEMA },
      ),
    )),
    // 每端 CLAUDE-RULE.md 增量补(端路径需 agent 自行从 overview 项目环境表 / 实际仓库推断)。
    ...allEnds.map((end) => () =>
      agent(
        `为端「${end}」增量补 CLAUDE-RULE.md。项目根:${projectDir}
${INCREMENTAL}

先从 ${specsDir}/overview.md 的「项目环境」表查该端仓库路径;查不到就用 Glob/Grep 在 ${projectDir} 下找该端的项目根。
到该端项目根后:若 CLAUDE-RULE.md 不存在 → 新建(action=created);已存在且完整 → 通读后 action=skipped;缺章节 → 只追加 action=appended。
**第一章节必须是「## 项目章程」**(项目不可违反原则,后续 Specs 方案对照、Review 违反即 P0):若该端 CLAUDE-RULE.md 已有章程段则不动;没有则生成模板 —— ≤10 条编号原则,含按项目技术栈推断的常见默认条目(如「API 变更必须向后兼容,不破坏既有调用方」「禁止移除/改名既有埋点」「禁止引入新的全局可变状态」),每条一句话可核验,末尾标注「⚠️ 以上为自动生成的默认章程,请项目维护者审阅修订」。
后续章节:项目结构、技术栈与版本、目录与命名约定、公共组件/工具、接口请求方式、状态管理、规范/约束,末尾同时引用 @${lessonsLocalPath}(主路径,本地教训,优先读)与 @${specsDir}/lessons-learned.md(公开快照,兜底),实现自学习闭环。
用 Read 确认现状后 Write/Edit。返回 {path, action, note}。`,
        { label: `rule:${end}`, phase: 'PRD', schema: WRITE_SCHEMA },
      ),
    ),
  ];

  const prdWrites = (await parallel(prdWriteTasks)).filter(Boolean);
  const created = prdWrites.filter((w) => w.action === 'created').map((w) => w.path);
  const appended = prdWrites.filter((w) => w.action === 'appended').map((w) => w.path);
  const skipped = prdWrites.filter((w) => w.action === 'skipped').map((w) => w.path);
  const unconfirmedAssumptions = (analysis.assumptions || []).filter((a) => !a.confirmed);
  log(
    `【PRD】完成 — ✅新建 ${created.length} | ➕追加 ${appended.length} | ⚠️跳过 ${skipped.length};拆出 ${(analysis.specs || []).length} 个 spec;假设清单 ${((analysis.assumptions || []).length)} 条(未确认 ${unconfirmedAssumptions.length} 条已冒泡);${(analysis.blockers || []).length ? `冒泡 ${(analysis.blockers || []).length} 个缺口` : '无缺口'}`,
  );

  return {
    mode: analysis.overviewExists ? 'incremental' : 'fresh',
    title: analysis.title,
    ends: analysis.ends,
    specs: (analysis.specs || []).map((s) => ({ id: s.id, name: s.name, ends: s.ends, deps: s.deps })),
    groups: analysis.groups || [],
    hasApiContracts: analysis.hasApiContracts,
    hasTrackingEvents: analysis.hasTrackingEvents,
    assumptions: (analysis.assumptions || []).map((a) => ({ id: a.id, question: a.question, assumption: a.assumption, impact: a.impact, confirmed: a.confirmed })),
    blockers: analysis.blockers || [],
    writes: prdWrites,
  };
}

// ════════════════════════════════════════════════════════════
// 辅助:Archive 段(原 /lyyflow:archive)
// ════════════════════════════════════════════════════════════
async function runArchive() {
  phase('Archive');
  log(`【Archive】检查归档条件 + 打包到 ${archiveRoot} …`);

  const ARCHIVE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['ready', 'specs', 'archiveName', 'archivePath', 'files', 'blockers'],
    properties: {
      ready: { type: 'boolean', description: '是否所有 spec 已完成且审核通过' },
      specs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'name', 'status', 'verdict'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            status: { type: 'string' },
            verdict: { type: 'string', description: '审核结论:通过/有条件通过/不通过' },
          },
        },
      },
      archiveName: { type: 'string', description: '归档命名(YYYYMMDD-序号 或自定义)' },
      archivePath: { type: 'string', description: '归档目录绝对路径;未归档则为空' },
      files: { type: 'array', items: { type: 'string' }, description: '归档文件清单(相对归档目录)' },
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description: '条件不满足的未完成项;ready=true 时空数组',
      },
      zipped: { type: 'boolean', description: '是否已压缩为 zip' },
    },
  };

  // workflow 沙箱无法问用户命名,archiveName 优先用 args.archiveName,否则 agent 用默认格式生成。
  const result = await agent(
    `你在执行 /lyyflow:archive 归档阶段。项目根:${projectDir}, specs 目录:${specsDir}
归档命名:${archiveName || '(用默认 YYYYMMDD-序号,从已有归档目录推断序号)'}

执行:
1. 读 ${specsDir}/overview.md,检查所有 spec 状态是否「已完成」、完成标记是否 [x]。
2. 逐 spec 读「## 审核结论」,确认均为「通过」或「有条件通过」(条件已满足)。
3. 条件不满足:ready=false,把未完成 spec(id+status+审核结论)写进 blockers,archivePath 留空,不归档。
4. 条件满足:
   a. 归档命名:${archiveName || '默认 YYYYMMDD-序号'};归档根目录:${archiveRoot}(扫其下同日前缀目录推断下一个序号)。
   b. spec 文件中文重命名:遍历 ${specsDir}/ 下 spec-*.md,若文件名缺中文短名,从 spec 标题/详细需求提取中文名重命名为 spec-编号-中文短名.md(≤10 汉字,仅汉字/字母/数字/连字符),并更新 overview.md 引用。
   c. 创建 ${archiveRoot}/<命名>/,复制 prd/(若有)、specs/(overview+spec+api-contracts+tracking-events+lessons-learned 公开快照),保留目录结构。⚠️ 严格排除:${localDir}/ 整个目录(含本地教训主版本、会话笔记、hook 源文件)永不进归档,教训留本地。
   d. 生成 archive-meta.md(归档时间 placeholder / 命名 / 位置 / 需求概要 / spec 清单表 / 文件清单 / 备注)。
   e. 不擅自压缩 zip(workflow 沙箱,留 zipped=false 让外层决定)。
   f. 不擅自删原 specs/(留给人工确认)。
返回 {ready, specs, archiveName, archivePath, files, blockers, zipped}。`,
    { label: 'archive', phase: 'Archive', schema: ARCHIVE_SCHEMA },
  );

  log(
    result.ready
      ? `【Archive】已归档到 ${result.archivePath}(命名 ${result.archiveName}),文件 ${result.files.length} 个`
      : `【Archive】条件不满足,未归档;未完成项冒泡:${(result.blockers || []).join('; ') || '(无)'}`,
  );
  return { mode: result.ready ? 'archived' : 'condition-not-met', ...result };
}
