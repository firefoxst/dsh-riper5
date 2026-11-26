# dsh-riper5

把 RIPER-5 做成 **会话级状态机** 的 DeepSeek Harness 插件：用三道闸门约束模型和工具，而不是只在系统提示里“请遵守”。

| 闸门 | 位置 | 作用 |
| --- | --- | --- |
| 沙箱闸 | `sandbox/mode` 会话事件 | 只有 EXECUTE 拥有可写沙箱；其余模式物理只读 |
| 工具闸 | `ctx.tools.guard` | 非 EXECUTE 拒绝写入/计划/提权类工具；EXECUTE 按契约白名单放行 |
| 系统提示闸 | `systemPrompt.section`（order = `PLAN_POLICY`） | 注入当前模式职责、契约文件、阻塞项与输出格式 |

状态保存在 Harness 的 storage domain（`ctx.storageDomain`，`per-record` 布局：每个会话一个文档 `~/.dsh/storages/riper5/sessions/<会话id>.json`），读取是内存同步、写入是持久化的，因此 **reconnect / resume / restart 后模式仍在**；**fork 是新的会话 id，没有继承记录，自然作废继承的批准**。

> **为什么不再写会话事件**：DSH 的读路径遇到不认识的事件类型会拒绝重建整个会话（"contains event type ... unknown to this harness"），除非信封带 `ignorable: true`，而 `Session.append()` 没有设置该标记的入口——插件写自定义事件会让会话历史彻底打不开。状态因此改为 storage domain；`sandbox/mode` 仍然写会话事件，因为那是 Harness 原生类型。

## 会话视图（已移除）

旧版本注册过一个 `riperMode` 投影并向客户端暴露 wire 视图（模式卡片）；由于投影只能从会话日志折叠，而插件不再写自定义事件，该投影已移除。当前部署没有客户端消费它，功能不受影响；需要展示模式时请读 `/mode` 命令输出。

## 模式

| 模式 | 沙箱 | 允许做什么 |
| --- | --- | --- |
| `RESEARCH`（默认） | read-only | 只读调查，输出事实与未知项 |
| `INNOVATE` | read-only | 多方案比较，等用户选择 |
| `PLAN` | read-only | 写计划、调用 `propose_plan`；先由独立审查员审查，再等人工批准 |
| `EXECUTE` | workspace-write（可配置） | 只修改契约文件，按计划实施 |
| `REVIEW` | read-only | 调用 `submit_review` 启动独立审查员核验 |
| `OFF` | 还原 engage 前的模式 | 插件不干预（保留 denyTools/denyPrefixes） |

`/mode off` 会还原 engage 时的沙箱模式、终止本会话正在运行的后台任务，并关闭本会话（含子代理）的终端。

## 安装

安装源只有一个：公开 GitHub 仓库 `firefoxst/dsh-riper5`（公开仓库安装免凭据）。包本身既是 bundle（`package.json` 的 `dsh.bundle.patch`）又是插件，所以一次安装同时完成“加 profile 依赖 + 选中 bundle”，不再需要手改 profile 补丁，也不含任何机器相关的绝对路径。

### 装到哪个 profile

- 客户端（Desktop）：`desktop` profile
- 浏览器 GUI（`dsh web`）：`web` profile
- 同一台机器两者都用时，各执行一次；插件状态按会话隔离，互不影响。

### 命令（Windows / Linux 通用）

```bash
# <profile> 取 desktop 或 web；<SHA> 换成 40 位 commit
dsh plugin --profile <profile> add "github:firefoxst/dsh-riper5#<SHA>"
```

`dsh` 不在 PATH 时（例如只装了 Desktop 客户端），用 DSH 自带的 CLI：

```powershell
& "<install-dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:firefoxst/dsh-riper5#<SHA>"
```

`<install-dir>` 指 DSH 安装目录（Windows 在用户级 `Programs` 目录下，Linux 为安装包解出的目录），按本机实际位置填写。安装后重启该 profile 的进程，Plugins 页应出现 RIPER-5 行；校验组合结果：

```bash
dsh --profile <profile> --dump-config | grep -n riper5        # Linux
```

```powershell
& "<install-dir>\...\dsh.cmd" --profile desktop --dump-config | Select-String riper5   # Windows
```

命令行安装会自动选中新 bundle；若使用 Plugins 页或 `plugin_manager`，安装入口同样接受上面的 GitHub spec。

### 钉 commit 与升级

- 安装 spec 必须钉**完整 40 位 commit**：只有这种依赖才拥有 `update` 通道；分支或 tag 依赖会被标为不可更新。
- 升级：每台机器把 `<SHA>` 换成新 commit 重装（或对已装 bundle 执行 update）。回退：换回旧 `<SHA>`。
- 仓库地址 + commit 是唯一版本标识；`package.json` 的 `version` 只用于展示与诊断。

### 与 `dsh-plan-mode` 共存

`web` profile 的 standard preset 自带 `dsh-plan-mode`，它与本插件都会注入规划提示与审批卡。只要不主动启用 plan-mode，两者互不干扰；若要在同一会话里并用，建议二选一：按 DSH 文档覆盖 `preset-standard` 声明，移除其中的 `planning` 组。

### 历史部署（已废弃）

早期用 `@local/dsh-riper5-bundle` + 绝对 file URL + `apply-to-erp.ps1` 复制到固定目录的部署方式与机器绑定，已不再使用，仓库内也不保留这类配置。旧会话状态仍在 `~/.dsh/storages/riper5/sessions/`，升级后照常恢复。

## 配置

```yaml
- insert:
    - id: riper5
      name: dsh-riper5
      config:
        manageSandbox: true       # 写 sandbox/mode 事件，让沙箱与模式一致
        strictBash: false         # true = 非 EXECUTE 模式完全禁用 bash
        executeMode: workspace-write  # 或 "restore"：EXECUTE 沿用 engage 前的沙箱
        autoApproveText: true     # 审批中用户整句说“同意/可以/按规划执行”即视为批准
        reviewProvider: spawn     # 独立审查用的 subagent provider；fork 默认被拒
        reviewTimeoutMs: 600000   # 单次独立审查超时（毫秒）
        reviewAgentPreset: null   # 可选：审查员 agent preset（要求 spawn 类 provider）
        reviewAgentOptions: null  # 可选：{ provider, model, reasoningEffort, maxTokens }；provider 必须等于 reviewProvider
        allowContextInheritingReviewer: false  # 是否允许 fork 类 provider 当审查员
        denyTools: []             # 任何模式下都拒绝的工具名
        denyPrefixes: []          # 任何模式下都拒绝的工具名前缀
        shellTools: ["bash", "pwsh", "powershell", "shell"]  # 统一处理提权与 strictBash
        mcpReadOnlyTools: []      # read-only 模式可用的 MCP 工具名或前缀（如 "mcp__search*"）
        revokeRunningWork: true   # 离开 EXECUTE 时终止子代理 job 并关闭其终端
```

未知配置键会在加载时报错，避免拼写错误静默关闸。`reviewAgentOptions.provider` 必须与 `reviewProvider` 一致，避免用 agentOptions 绕开独立检查。独立审查还需要部署提供 `subagents` 服务。0.6.0 起：`propose_plan` 的独立审查失败**降级为警告**（审批卡标注“未经独立审查”，仍可人工批准），`submit_review` 仍**失败关闭**。

## 使用

```text
/mode               显示当前模式、planId、契约文件、沙箱
/mode research      切换模式（也支持 研究/创新/规划/执行/评审/关闭，大小写不敏感）
/mode execute       仅当存在已批准的契约时可用
/mode review        只能从 EXECUTE 进入
/mode off           退出并还原
```

切模式只认 `/mode` 命令（0.6.0 移除了文本触发，避免口语误伤）；审批卡片等待期间直接回复“同意/可以/按规划执行”视为批准（`autoApproveText`）。

### PLAN：`propose_plan`

计划必须是 markdown，且满足：

1. `# 标题` 开头；
2. 有非空的 `## 目标`、`## 步骤`、`## 验证方式` 段；
3. `## 步骤` 内是从 `1` 开始的连续编号列表（不能跳号）；
4. 有 `[更改规划]` 段，该段中每个待改文件单独一行：`- 文件：相对或绝对路径`（支持反引号，也支持一行多个用顿号分隔）；
5. 文件行只放在 `[更改规划]` 段；代码围栏里的示例不会被当成契约或步骤。

校验通过后**不会立刻弹人工审批**：插件先启动一个全新的独立审查员（默认 `spawn`，不继承父上下文），把计划正文作为数据交给它，只读取 `findings`。任一 `blocker` 把审查结果写入 storage 记录的 `lastFindings` 与 `audit`，并作为工具错误退回，计划不会进入人工审批；没有 blocker 才把计划写入 storage 记录（含文件列表、sha256 摘要和计划正文）并弹出审批：**Approve** 后立即进入 EXECUTE；**Keep planning** 把反馈作为结构化工具结果交还给模型继续修订。批准自批准时刻起长期有效，直到离开 EXECUTE、`/mode off` 或重新提交计划。0.6.0 起独立审查只跑**本次 PLAN 阶段的首版**：修订版默认跳过并在审批卡与工具返回里标注；`propose_plan` 的 `review` 参数可取 `auto|always|never` 覆盖。

审查员被要求只读、不得改文件、不得再委派，也不得调用 `propose_plan` / `submit_review`；父代理不能自己填写审查结论。审查失败、超时、provider 不支持结构化输出时，计划提交失败关闭。

### EXECUTE：契约白名单

`write` / `edit` 按 `file_path`、`apply_patch` 按补丁头（`*** Add File:`、`*** Update File:`、`*** Delete File:`、`*** Move to:`）解析目标路径，与契约文件做 **绝对路径规范化后的精确匹配**（Windows 大小写不敏感）；越界或解析不出路径都会 fail-closed 拒绝。`shell`（bash/pwsh/powershell）的非只读副作用不在此列（见“已知限制”），但非 EXECUTE 模式会拒绝任何 shell 的 `sandbox_permissions`，`strictBash` 也覆盖全部 shell；`terminal_list`/`terminal_read` 和 `mcpReadOnlyTools` 白名单在只读模式可用。契约只锁路径、不锁内容；契约含工作区外文件时，审批卡会提示“EXECUTE 沙箱为 workspace-write，写入可能需要宿主提权审批”。

### REVIEW：`submit_review`

- 你不再传 `conclusion` / `findings`；调用 `submit_review`（可选 `focus`）会启动全新的独立审查员，审查员自己读文件、跑验证命令、给出带证据的 findings；
- 每条 finding 必须有 `evidence`（命令输出或 `文件:行`），`severity` 为 `info|warning|blocker`；
- 任一 blocker：记录审查结果（storage 记录里的审计条目）后回到 PLAN 并作废 planId，返回 `accepted:false`、待修清单和审查员信息；
- 无 blocker：插件按审查员的 blocker 计算结论为 `实施与规划完全匹配`，会话保持 REVIEW 只读；
- 计划正文保存在会话的 storage 记录里；没有正文时 `submit_review` 失败关闭，需重新走 PLAN→EXECUTE。

## 生命周期

- **初始化**：会话第一次 `agent/pre-step` 时写入初始状态（默认 RESEARCH），并记录 engage 前的沙箱模式（`sandboxBefore`）。放在 pre-step 而不是 `agent/created`，是为了和 permission-presets 的初始化顺序解耦。
- **持久化**：每次状态变更同步更新内存，并按会话串行排入 `storageDomain` 的写入链（`~/.dsh/storages/riper5/sessions/`）；`planSubmissions`、`lastFindings`、`notice` 都在记录里。写入失败会在 `/mode` 状态里显示；没有 `storageDomain` 服务时降级为仅内存，重启后回到 RESEARCH（只读，不会放开闸门）。
- **变更时机**：切模式立即生效；turn 正在进行时切换请求会被拒绝并提示“本步结束后再切”（0.6.0 移除了 pending 排队与文本触发）。
- **子代理**：`agent/created` 之后子代理第一步继承父代理当前模式（含 EXECUTE 的 planId/契约）；父代理一旦降级为只读模式，所有存活子代理被钉为只读并清空它们的 planId。
- **fork**：fork 产物是新的会话 id，没有继承的状态记录，第一步就是 RESEARCH；即使万一存在带批准的记录（`isSeeded===true`），EXECUTE 也会降为 PLAN 并清空 planId/契约。

## 验收状态

| # | 场景 | 期望 | 状态 |
| --- | --- | --- | --- |
| 1 | 新会话 | 模式 RESEARCH；`write` 被拒；磁盘无文件 | ✅ 实测 |
| 2 | RESEARCH 下 bash | 写文件失败（沙箱只读，bwrap `--ro-bind / /`） | ✅ 实测 |
| 3 | 系统提示闸 | 注入 `## RIPER-5 会话协议（当前模式：…）` | ◑ 部分（重启前 ✅；2026-11-25 12:55:25 整进程重启后本会话未注入，疑时序问题，见日志“观察”） |
| 4 | 批准计划后 | 立即进入 EXECUTE，沙箱 workspace-write | ✅ 实测（2026-11-25，planId `riper-039e25417029-mwvj6qm3`） |
| 5 | EXECUTE 写契约外文件 | 被拒并说明原因 | ⏳ 待重启后复测 |
| 6 | 无 planId 时 `/mode execute` | 拒绝 | ⏳ 待重启后复测 |
| 7 | REVIEW 下 write | 被拒 | ⏳ 待重启后复测 |
| 8 | 重连/恢复会话 | 模式保持 | ✅ 实测（2026-11-25 12:55:25 整进程重启后仍为 PLAN，`write` 被按 PLAN 拒绝） |
| 9 | fork 会话 | planId 作废 | ⏳ 待重启后复测 |
| 10 | 子代理 | 继承父模式；父降级后只读 | ⏳ 待重启后复测 |
| 11 | `/mode off` | 沙箱还原（含 danger-full-access） | ◑ 部分（2026-11-25：job 已回收、沙箱还原为 workspace-write 已实测；`danger-full-access` 起点未测，终端回收因本部署无 PTY 后端未验） |
| 12 | `node --test`（受限沙箱用 `--test-isolation=none`） | 协议、闸门、状态、审查纯函数测试全绿 | ✅ 37/37（工作区副本，2026-11-25） |
| 13 | 计划含 blocker | 独立审查员先否决；不弹人工审批；无计划记录 | ✅ 实测（2026-11-25 连续 5 次提交各被判 1 个 blocker：`propose_plan` 抛“独立审查未通过”，未进入人工审批、未生成 planId） |
| 14 | 实施审查 | `submit_review` 启动新审查员；父代理不能传结论/findings | ⏳ 待重启后复测 |
| 15 | 审查员越权 | 审查员调用 subagent/propose_plan/submit_review 被拒 | ⏳ 待重启后复测 |
| 16 | 逐句切模式 | “进入规划模式。再给方案”识别为 PLAN | ⏳ 待重启后复测 |
| 17 | pwsh 提权 | 非 EXECUTE 带 `sandbox_permissions` 被拒 | ✅ 实测（2026-11-25：PLAN 下 `pwsh` + `danger-full-access` 被拒，原文“… pwsh 的 sandbox_permissions 提权参数在此模式被拒绝”） |
| 18 | storage 重启恢复 | 切换 PLAN 后重启仍为 PLAN；失败时状态显示仅内存/写入失败 | ✅ 实测（2026-11-25：重启后 storage 仍 `mode=PLAN` 且闸门按 PLAN 拦截，模式来自磁盘记录） |
| 19 | Keep planning | 返回结构化 `approved:false` 与 feedback | ⏳ 待重启后复测 |
| 20 | 批准不再过期（0.5.0） | 批准后在会话内长期有效，仅离开 EXECUTE / `/mode off` / 重新提计划才作废 | ✅ 实测（2026-11-25 16:59:53：批准后 64 分钟仍成功写入契约文件；原 30 分钟窗口本应已于 16:25:14 截止） |

4–11、13–19 需重启 `dsh web` 后按顺序复测，实测记录（命令、输出、时间）保存在本机 `.riper5-work/record/acceptance-log.md`（含真实路径，不入库）；未实测前不得声称通过。

**2026-11-25 轮次**：同一份代码经 `@local/dsh-riper5-bundle` 装进 `desktop` profile 后按 11 项清单复测（EXECUTE → OFF，中途一次整进程重启），逐项命令、输出与结论见本机验收记录同轮次（不入库）。实测通过：第 4、8、12、13、17、18 项；部分通过：第 3、11 项（说明见日志“观察”）；未执行：第 16、19 项。未实测前不打 ✅。

## 与规划（PLAN-v2）的偏差

- 增加 `OFF` 模式：规划里的五模式枚举无法表达“退出插件”，而 `/mode off` 必须有落点。
- **已移除（0.5.0）**：`planId` 仍带创建时间戳（仅用于唯一性与可读性），但不再有任何过期机制；原 `planTtlMs` 配置键一并删除——部署配置里若仍写着它，加载时会报“未知键”。
- 审批使用独立 `AbortController` 而不是 userQuestions 的 `intent`，并额外支持“文字同意”通道；没有注册 presenters，因此不生成专属工具卡片。
- `blockers` / `conclusion` 跨模式变更保留，直到下一次 `propose_plan` 覆盖；规划只要求“记录并回到 PLAN”。
- 状态记录额外携带 `planApproved`（恢复批准与 `/mode execute` 校验必需）。
- `propose_plan` / `submit_review` 只在各自模式注册，别的模式调用得到“工具不存在”，而不是规划 §4.1 的“报错并提示当前模式”；这样模型在只读模式不会看到写入工具。
- `run_code` 比规划 M2 更严：非 EXECUTE 时只要解析到的沙箱不是 `read-only` 就拒绝（此前只拒 `danger-full-access`）。
- 状态记录带 `reviewOf.files`、`planText`、`reviewer`，使 review 绑定 planId/hash，并让实施审查拿到计划正文与审查员身份。
- 独立审查是新增的门禁：`propose_plan` 在人工审批前调用 `spawn` 审查员，`submit_review` 不再接受父代理的 `conclusion`/`findings`；blocker 一票否决。
- 审计（计划审查结论、批准来源 `source: card|text` 与 `messageId`）写在状态记录的 `audit` 数组里（上限 20 条），不再写 `riper/plan-review`、`riper/approval` 会话事件。

## 数据与升级

- 状态文件：`~/.dsh/storages/riper5/sessions/<会话id>.json`（storage domain，域版本 1，`per-record` 布局）。0.4.0 新增 `pending`、`approvedAt`、`lastFindings`、`lastReviewKind`、`notice`、`updatedAt`；`normalizeState` 给旧记录补默认值，域版本保持 1。0.5.0 移除 `approvedAt`（批准不再按时间失效）：旧记录里的该字段会被 `normalizeState` 丢弃，不影响已有批准的有效性；域版本仍为 1。0.6.0 移除 `pending` 与 `autoSwitch`（切模式立即生效、只认 `/mode`），新增 `planSubmissions`（只审首版）；旧记录缺该字段时按 0 处理。
- 从 0.2.0 升级：旧会话日志里的 `riper/*` 事件不再被读取，升级后这些会话回到 RESEARCH（只读）。**如果旧日志里的 `riper/*` 事件缺少 `ignorable: true`，DSH 会拒绝打开整个会话**；修复办法是给这些事件补上该标记（本仓库另附 `tools/repair-session-log.mjs`，见下），或直接删掉这些事件行不可取（会破坏 seq 连续性）。0.4.0 不写任何 `riper/*` 事件，只写 Harness 原生 `sandbox/mode`。
- 存储记录损坏只会让该会话回到 RESEARCH：记录 schema 用宽容的 `parse`，坏记录不会拖垮整个域。

```bash
# 查找并修复被旧版本写坏的会话日志（先 dry-run，再 --apply；会自动备份原文件）
node tools/repair-session-log.mjs "<DSH_HOME>/sessions/<project>/<session-id>/session.v4.jsonl.zstd"
node tools/repair-session-log.mjs "<DSH_HOME>/sessions/<project>/<session-id>/session.v4.jsonl.zstd" --apply
```

## 已知限制

- **独立审查依赖 `subagents`**：部署必须提供 `subagents` 服务和可用的 `reviewProvider`（默认 `spawn`）；缺失或不支持 `outputSchema` 时 `propose_plan` / `submit_review` 失败关闭，不会退回自审。`fork` 会继承父上下文，默认被拒；`allowContextInheritingReviewer: true` 只应在明确接受“非独立”时使用。
- **审查员看不到对话**：它只拿到计划正文、契约文件、cwd 和 `focus`，必须自己读工作区；因此审查质量取决于仓库可读性，且每次审查都会消耗一个子代理。`reviewTimeoutMs` 默认 10 分钟，超时即失败。
- **审查员只读但仍有读权限**：它继承会话的沙箱/文件策略；请用只读或最小权限运行审查，避免把秘密文件暴露给不需要的 reviewer。
- **`shell` 不受契约约束**：契约只校验 `write`/`edit`/`apply_patch`；`bash`/`pwsh`/`powershell` 的写副作用不在契约内（只受沙箱约束）。RESEARCH 下只读来自沙箱；`manageSandbox:false` 或沙箱本身可写时 shell 重定向仍可能落盘。要完全封死请开 `strictBash: true`，或让部署 deny 掉非 EXECUTE 的 shell。
- **契约只锁路径、不锁内容**：批准的是文件名清单，同文件内的任意改动（含整体重写）不会被拦，也没有内容哈希。
- **只读模式会禁掉构建/测试写盘**：`manageSandbox: true` 时非 EXECUTE 的沙箱是 read-only，`npm test` 写快照/coverage 之类会失败；需要时用 `/mode off` 或关掉 `manageSandbox`。
- **契约含工作区外路径**：EXECUTE 沙箱为 `workspace-write`，写工作区外文件仍需宿主提权审批；审批卡会提前提示。
- **状态持久化是尽力而为**：写入按会话串行、失败会显示在 `/mode` 状态里，但没有 WAL；进程被强杀时最后一次写入可能丢失。没有 `storageDomain` 时只保存在内存，重启回到 RESEARCH（只读）。
- **`terminal_list`/`terminal_read` 与 `mcpReadOnlyTools` 白名单**：只读模式可读，`terminal_open/send/signal/close` 仍被拒绝；MCP 默认全拒，白名单需显式配置。
- **`revokeRunningWork`**：默认 true，离开 EXECUTE 时终止子代理 job 并关闭其终端；设为 false 会保留已运行进程，闸门只约束之后的调用。
- **`run_code`**：非 EXECUTE 时只有解析到的真实沙箱为 `read-only` 才放行；`danger-full-access`（以及 `manageSandbox:false` 下的可写沙箱）一律拒绝，防止绕过只读闸。
- **REVIEW 入口限制**：REVIEW 只能从 EXECUTE 进入；插件激活前完成的历史工作无法直接 `submit_review`，只能先走一遍 PLAN→EXECUTE 或以对话形式审查。
- **激活前的存活任务**：工具围栏只约束之后的调用；插件热加载或会话恢复前已在运行的 background job / 终端不会被自动终止，需要 `/mode off` 或手工停止。
- **与 dsh-plan-mode 共存**：web profile 的 preset-standard 同时启用了 `dsh-plan-mode`，两者都会注入提示和审批卡片；建议部署时二选一，或在 preset 中禁用 plan-mode。
- **权限预设读数显示 `custom`**：本插件只写 `sandbox/mode`，不改 `permission/preset`，因此 GUI 的权限预设会显示为自定义；`/mode off` 会还原沙箱但不恢复预设名。
- 计划契约是“文件级”而非符号级：同文件内的越界修改不会被拦截。
- 本插件零外部依赖，`apply_patch` 的路径解析覆盖常见 Codex 补丁头；自定义补丁格式需自行确认。

## 卸载

```bash
# 一条命令移除依赖并取消选中
dsh plugin --profile <profile> remove dsh-riper5

# 校验：应无 riper5 输出
dsh --profile <profile> --dump-config | grep -n riper5
```

用 Plugins 页卸载时选择 Remove。需要彻底清理时，可再删除会话状态目录 `~/.dsh/storages/riper5/`（可选；删除后这些会话回到 RESEARCH）。

## 本机迁移记录（2026-11-26）

- 包结构：`package.json` 增加 `dsh.bundle.patch`；补丁层改为自引用包名，不再包含绝对 file URL；新增 `locale/` 与 `icon.svg`。
- 单元测试：`node --test --test-isolation=none` → 40 passed / 0 failed（受限沙箱跑法）。
- 本机 `desktop` profile：移除旧 `@local/dsh-riper5-bundle` 后，从本地目录安装 `dsh-riper5@0.7.0`，`list_plugins` 中 `riper5` 行为 `enabled / active`，说明自引用包名可解析。
- 会话提示：安装后本会话仍注入 `## RIPER-5 会话协议`，闸门生效。
- 未完成：GitHub 源安装与 `web` profile 安装需在宿主 GUI/CLI 执行（安装动作要求 full access 或人工审批）。
