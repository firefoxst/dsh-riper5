/**
 * dsh-riper5 — RIPER-5 as a durable session state machine for DeepSeek Harness.
 *
 * The plugin contributes three gates around one folded state:
 *
 * 1. a sandbox gate: only EXECUTE runs with a write-capable sandbox,
 * 2. a tool guard: non-EXECUTE modes reject every mutating tool, and EXECUTE
 *    only admits writes to the approved plan's contract files,
 * 3. a system-prompt section: the current mode's obligations and the contract.
 *
 * The state is plugin-owned and persisted through the Harness storage domain
 * (`ctx.storageDomain`), one record per session: reads are synchronous from
 * memory, writes are durable, so resume and restart reload it and compaction
 * leaves it untouched. A plugin must not append its own session event type — a
 * reader that does not know the type refuses to reopen the session — so nothing
 * here touches the event vocabulary (only the Harness-native `sandbox/mode`).
 * A fork starts a new session id with no stored record, so it never inherits an
 * approval.
 *
 * @module dsh-riper5
 */

import {
	APPROVAL_ID,
	APPROVE_LABEL,
	CONCLUSION_DEVIATION,
	CONCLUSION_MATCH,
	KEEP_PLANNING_LABEL,
	MODES,
	createPlanId,
	guardDecision,
	isApprovalText,
	resolveModePhrase,
	resolveModeToken,
	validatePlan,
	withinRoot
} from "./protocol.js";
import { REVIEW_SCHEMA, buildReviewPrompt, normalizeReviewFindings, reviewerToolDenied } from "./review.js";
import { appendAudit, applyMode, applyNotice, applyPlan, applyPlanReview, applyReview, hasApprovedPlan, initialState, normalizeState, stateRecordSchema } from "./state.js";

/**
 * Storage-domain declaration for the per-session RIPER-5 records.
 *
 * Declared inline rather than through `defineDomain` so the plugin keeps
 * resolving with zero package imports: `defineDomain` only validates these
 * fields and returns the same object, and `domainTable` only wraps a schema.
 */
const STATE_DOMAIN = {
	name: "riper5",
	version: 1,
	/** One document per session (`<storage root>/riper5/sessions/<session id>.json`). */
	layout: "per-record",
	/** One damaged record must not disable persistence for every other session. */
	invalidRecords: "backup-and-skip",
	tables: { sessions: { valueSchema: stateRecordSchema } }
};

/** The plugin's registered name. */
export const name = "dsh-riper5";

/** Default deployment configuration; every key is overridable by the patch entry. */
const DEFAULT_CONFIG = {
	/** Write the session sandbox event that enforces each mode. */
	manageSandbox: true,
	/** Deny `bash` outright in every mode except EXECUTE. */
	strictBash: false,
	/** `workspace-write` for EXECUTE, or `restore` to reuse the pre-engagement mode. */
	executeMode: "workspace-write",
	/** Plain user sentences such as "同意" approve a plan that is under review. */
	autoApproveText: true,
	/** Whole sentences such as "进入规划模式" advance the mode from the text lane. */
	textModeSwitch: true,
	/** Exact tool names always denied. */
	denyTools: [],
	/** Tool-name prefixes always denied. */
	denyPrefixes: [],
	/** Subagent provider used for independent review; must be a spawn-like provider. */
	reviewProvider: "spawn",
	/** Maximum time to wait for one independent review. */
	reviewTimeoutMs: 600_000,
	/** Optional agent preset for the reviewer; requires an independent provider. */
	reviewAgentPreset: null,
	/** Optional provider/model/reasoningEffort/maxTokens override for the reviewer. */
	reviewAgentOptions: null,
	/** Allow a context-inheriting provider (fork) as reviewer; off by default. */
	allowContextInheritingReviewer: false,
	/** Extra tool names treated as shell commands (guard treats these as command tools). */
	shellTools: ["bash", "pwsh", "powershell", "shell"],
	/** MCP tool names/prefixes that are read-only and may run outside EXECUTE. */
	mcpReadOnlyTools: [],
	/** Kill descendants' jobs and close their terminals when leaving EXECUTE. */
	revokeRunningWork: true
};

/** Per-mode obligations injected into the system prompt. */
const MODE_SECTIONS = {
	RESEARCH: [
		"### RESEARCH（研究）",
		"- 只读模式：禁止写入、打补丁、改配置；工具闸会拒绝这些调用。",
		"- 用 read / glob / grep / 只读 bash 收集事实，每条结论标注证据（文件:行 或命令输出）。",
		"- 输出：已知事实、未知问题、风险点；不要给实现方案，除非用户要求进入下一阶段。",
		"- 结束后由用户 `/mode innovate` 或 `/mode plan` 推进。"
	].join("\n"),
	INNOVATE: [
		"### INNOVATE（方案构思）",
		"- 只读模式：禁止写入。",
		"- 至少比较两个候选方案：做法、优点、缺点、风险、验证方式与成本。",
		"- 给出推荐方案与理由；等待用户选择后再进入 PLAN，不要自行开工。"
	].join("\n"),
	PLAN: [
		"### PLAN（规划）",
		"- 只读模式：禁止写入；本模式的唯一产出是计划文档与 `propose_plan` 调用。",
		"- 计划必须包含：`# 标题`、`## 目标`、`## 步骤`（从 1 连续编号）、`## 验证方式`，以及 `[更改规划]` 段。",
		"- `[更改规划]` 段中每个待改文件单独一行：`- 文件：相对或绝对路径`（可用反引号包裹；可一行多个用顿号分隔）。",
		"- 文件行只放在 `[更改规划]` 段；代码围栏里的示例不会被当成契约。",
		"- 计划要具体到文件与函数、说明失败与回滚处理；不要留 TODO 或“视情况而定”。",
		"- 调用 `propose_plan` 后，宿主先启动全新独立审查员审查计划；blocker 会直接退回，不会进入人工审批。",
		"- 独立审查通过后才向用户弹审批：批准后下一步进入 EXECUTE；用户要求继续完善时，吸收反馈后重新提交。",
		"- 未获批准前不要尝试任何写入。"
	].join("\n"),
	EXECUTE: [
		"### EXECUTE（执行）",
		"- 只允许修改已批准契约清单中的文件；工具闸按绝对路径精确匹配，越界会被拒绝。",
		"- 契约只约束 write/edit/apply_patch；shell 写入不受契约约束，需自行克制。",
		"- 按计划顺序实施，每个文件完成后报告：文件 → 改动摘要 → 验证命令与结果。",
		"- 不要扩大范围、不要顺手重构；发现必须偏离计划时，停止修改并在回复中写明偏离点与 blocker。",
		"- 完成后请用户执行 `/mode review`，然后在 REVIEW 模式调用 `submit_review`。"
	].join("\n"),
	REVIEW: [
		"### REVIEW（审查）",
		"- 只读模式：禁止任何写入。",
		"- 不要自行判断通过或填写 findings；调用 `submit_review` 启动全新独立审查员。",
		"- 独立审查员会对照计划逐项核验：改动文件、行为、测试与验证命令；每个发现必须带证据（命令输出或 文件:行）。",
		"- 插件按审查员的 `blocker` 计算结论：有 blocker 时提交后自动回到 PLAN 并作废 planId；没有 blocker 时结论为 “实施与规划完全匹配”。",
		"- `submit_review` 只接受可选的 `focus`；不要试图用参数代替审查员的证据。"
	].join("\n")
};

/**
 * Validate and freeze the deployment config. Unknown keys fail at load so a
 * typo cannot silently disable a gate.
 *
 * @param {unknown} raw - Raw plugin config.
 * @returns {typeof DEFAULT_CONFIG} Validated config.
 */
export function resolveConfig(raw) {
	const config = raw ?? {};
	if (typeof config !== "object" || Array.isArray(config)) throw new Error("dsh-riper5 配置必须是对象");
	const unknown = Object.keys(config).filter((key) => !Object.hasOwn(DEFAULT_CONFIG, key));
	if (unknown.length > 0) throw new Error(`dsh-riper5 配置包含未知键：${unknown.join(", ")}（可用：${Object.keys(DEFAULT_CONFIG).join(", ")}）`);
	const merged = { ...DEFAULT_CONFIG, ...config };
	for (const key of ["manageSandbox", "strictBash", "autoApproveText", "textModeSwitch", "revokeRunningWork"]) {
		if (typeof merged[key] !== "boolean") throw new Error(`dsh-riper5 配置 ${key} 必须是布尔值`);
	}
	if (merged.executeMode !== "workspace-write" && merged.executeMode !== "restore") {
		throw new Error('dsh-riper5 配置 executeMode 只能是 "workspace-write" 或 "restore"');
	}
	for (const key of ["denyTools", "denyPrefixes", "shellTools", "mcpReadOnlyTools"]) {
		if (!Array.isArray(merged[key]) || merged[key].some((entry) => typeof entry !== "string")) {
			throw new Error(`dsh-riper5 配置 ${key} 必须是字符串数组`);
		}
		merged[key] = merged[key].filter((entry) => entry !== "");
	}
	if (typeof merged.reviewProvider !== "string" || merged.reviewProvider.trim() === "") throw new Error("dsh-riper5 配置 reviewProvider 必须是非空字符串");
	if (!Number.isSafeInteger(merged.reviewTimeoutMs) || merged.reviewTimeoutMs <= 0 || merged.reviewTimeoutMs > 2_147_483_647) throw new Error("dsh-riper5 配置 reviewTimeoutMs 必须是 1..2147483647 的整数");
	if (merged.reviewAgentPreset !== null && (typeof merged.reviewAgentPreset !== "string" || merged.reviewAgentPreset.trim() === "")) {
		throw new Error("dsh-riper5 配置 reviewAgentPreset 必须是 null 或非空字符串");
	}
	if (typeof merged.allowContextInheritingReviewer !== "boolean") throw new Error("dsh-riper5 配置 allowContextInheritingReviewer 必须是布尔值");
	if (merged.reviewAgentOptions !== null) {
		const options = merged.reviewAgentOptions;
		if (typeof options !== "object" || Array.isArray(options)) throw new Error("dsh-riper5 配置 reviewAgentOptions 必须是 null 或对象");
		const allowed = ["provider", "model", "reasoningEffort", "maxTokens"];
		const unknownOptions = Object.keys(options).filter((key) => !allowed.includes(key));
		if (unknownOptions.length > 0) throw new Error(`dsh-riper5 配置 reviewAgentOptions 包含未知键：${unknownOptions.join(", ")}（可用：${allowed.join(", ")}）`);
		for (const key of ["provider", "model", "reasoningEffort"]) {
			if (options[key] !== undefined && (typeof options[key] !== "string" || options[key].trim() === "")) throw new Error(`dsh-riper5 配置 reviewAgentOptions.${key} 必须是非空字符串`);
		}
		if (options.provider !== undefined && options.provider !== merged.reviewProvider) {
			throw new Error("dsh-riper5 配置 reviewAgentOptions.provider 必须与 reviewProvider 一致；独立审查只允许一个 provider，避免用 agentOptions 绕开独立检查");
		}
		if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) throw new Error("dsh-riper5 配置 reviewAgentOptions.maxTokens 必须是正整数");
	}
	return merged;
}

/**
 * Read a user message's plain text.
 *
 * @param {{content?: unknown}} message - Inbox message.
 * @returns {string} Concatenated text blocks.
 */
function messageText(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

/** The plugin entry point. */
export default {
	name,
	async apply(ctx, rawConfig) {
		const cfg = resolveConfig(rawConfig);
		/** Sessions whose initial/fork state has been reconciled once. */
		const initialized = new WeakSet();
		/** session id → plan-approval waiter (one at a time). */
		const approvalWaiters = new Map();
		/** Child session ids currently acting as independent reviewers. */
		const reviewerSessions = new Set();
		/** Session id → committed state; hydrated from storage before any listener runs. */
		const states = new Map();
		/** Session id → tail of the durable write chain, so puts keep their order. */
		const writeChains = new Map();
		/** Session id → last storage write error, shown in status instead of being swallowed. */
		const persistErrors = new Map();
		/**
		 * Disposers for every service registration. The services bind registrations
		 * to their own context, so without explicit release a plugin reload would
		 * duplicate guards/sections/tools (or fail on a reserved name).
		 */
		const disposers = [];
		ctx.effect(() => () => {
			for (const dispose of disposers.splice(0).reverse()) {
				try {
					const result = dispose();
					if (result !== null && typeof result?.then === "function") result.catch(() => {});
				} catch {
					// best-effort: a failing disposer must not block the rest
				}
			}
		}, "riper5:dispose");

		await ctx.inject(["tools", "systemPrompt", "sandboxPolicy", "agents"], async (inner) => {
			/**
			 * Open the per-session state domain and hydrate the in-memory map, so
			 * every read below is synchronous and every later write is durable.
			 * Storage is optional: without it the gates still work from memory, and
			 * a restart simply re-engages at RESEARCH (read-only), never fail-open.
			 */
			const storageDomain = inner.get("storageDomain");
			let store = null;
			if (storageDomain === undefined) {
				inner.logger.warn("dsh-riper5: 当前部署没有 storageDomain 服务，模式状态只在内存中保存，重启后会话回到 RESEARCH。");
			} else {
				try {
					const domain = await storageDomain.open(STATE_DOMAIN);
					store = domain.table("sessions");
					for (const [key, value] of store.entries()) states.set(String(key), normalizeState(value));
					disposers.push(() => Promise.allSettled([...writeChains.values()]).then(() => domain.close()));
				} catch (error) {
					inner.logger.warn("dsh-riper5: 打开状态存储失败，本次运行只在内存中保存模式状态：%o", error);
				}
			}

			/** @returns {ReturnType<typeof initialState>} The committed state. */
			const stateOf = (session) => states.get(String(session.id)) ?? initialState();

			/** A short, user-visible description of the storage path. */
			const storageStatus = () => {
				if (store === null) return "仅内存（重启回到 RESEARCH）";
				const errors = [...persistErrors.values()];
				return errors.length === 0 ? "持久化" : `写入失败：${errors.at(-1)}`;
			};

			/** Commit one next state: memory now, storage in write order. */
			const commitState = (session, next) => {
				const id = String(session.id);
				const record = { ...next, updatedAt: Date.now() };
				states.set(id, record);
				if (store !== null) {
					const previous = writeChains.get(id) ?? Promise.resolve();
					const write = previous.then(() => store.put(id, record)).then(
						() => {
							persistErrors.delete(id);
						},
						(error) => {
							persistErrors.set(id, error instanceof Error ? error.message : String(error));
							inner.logger.warn("dsh-riper5: 持久化会话状态失败：%o", error);
						}
					);
					writeChains.set(id, write.catch(() => {}));
				}
				return record;
			};

			/** Fold one transition into a session's state and commit it. */
			const transact = (session, fold, data) => commitState(session, fold(stateOf(session), data));

			/** The committed mode of one session. */
			const selectedMode = (session) => stateOf(session).mode;

			const sessionCwd = (session) => session?.header?.cwd ?? inner.sandboxPolicy.workspaceRoot;

			const resolveSandbox = (session) => inner.sandboxPolicy.resolve({ session });

			/** The sandbox value committed before RIPER-5 engaged. */
			const snapshotSandbox = (session) => inner.sandboxPolicy.overrideOf(session) ?? inner.sandboxPolicy.defaultMode;

			/** The sandbox mode a given RIPER mode requires. */
			const expectedSandbox = (mode, sandboxBefore) => {
				if (mode === "EXECUTE") return cfg.executeMode === "restore" ? (sandboxBefore ?? "workspace-write") : "workspace-write";
				if (mode === "OFF") return sandboxBefore ?? inner.sandboxPolicy.defaultMode;
				return "read-only";
			};

			/**
			 * Append `sandbox/mode` only when the session's current value differs.
			 * Unlike the RIPER state this stays a session event: `sandbox/mode` is a
			 * Harness-native type, and the sandbox policy reads it back from the log.
			 *
			 * @returns {boolean} Whether an event was appended.
			 */
			const reconcileSandbox = (session, mode, sandboxBefore) => {
				if (!cfg.manageSandbox || mode === null || mode === "OFF") return false;
				const expected = expectedSandbox(mode, sandboxBefore);
				const current = inner.sandboxPolicy.overrideOf(session) ?? inner.sandboxPolicy.defaultMode;
				if (current === expected) return false;
				session.append("sandbox/mode", { mode: expected });
				return true;
			};

			/** Agents whose live runtime ancestor chain reaches this session. */
			const descendantsOf = (agent) => {
				const rootId = agent.session.id;
				const out = [];
				for (const candidate of inner.agents.list()) {
					let parent = candidate.parentAgent;
					while (parent !== undefined) {
						if (parent.session.id === rootId) {
							out.push(candidate);
							break;
						}
						parent = parent.parentAgent;
					}
				}
				return out;
			};

			/** Close every terminal session owned by an agent (and optionally its children). */
			const closeTerminals = (agent, includeDescendants) => {
				const terminals = inner.get("terminals");
				if (terminals === undefined) return;
				const owners = includeDescendants ? [agent, ...descendantsOf(agent)] : [agent];
				for (const owner of owners) {
					let snapshots;
					try {
						snapshots = terminals.list(owner);
					} catch {
						continue;
					}
					for (const terminal of snapshots) {
						try {
							void terminals.kill(owner, terminal.sessionId, "RIPER-5 会话闸收紧了写权限").catch(() => {});
						} catch {
							// ignore: closing is best-effort
						}
					}
				}
			};

			/** Kill the session's live background jobs. */
			const killJobs = (session) => {
				const jobs = inner.get("jobs");
				if (jobs === undefined) return 0;
				let killed = 0;
				for (const job of jobs.list(session.id)) {
					if (job.status !== "running" && job.status !== "stopping") continue;
					try {
						const outcome = jobs.kill(job.id, session.id, "RIPER-5 已关闭，终止后台任务");
						if (outcome !== null && typeof outcome?.catch === "function") outcome.catch(() => {});
						killed += 1;
					} catch {
						// ignore: the job may have settled concurrently
					}
				}
				return killed;
			};

			/** Pin every live descendant to the parent's new, read-only mode. */
			const pinDescendants = (agent, mode, revoke) => {
				for (const child of descendantsOf(agent)) {
					const childState = stateOf(child.session);
					if (childState.mode === null) continue;
					if (childState.mode === mode && childState.planId === null && childState.contract === null) {
						reconcileSandbox(child.session, mode, childState.sandboxBefore);
					} else {
						transact(child.session, applyMode, {
							mode,
							planId: null,
							planApproved: false,
							contract: null,
							sandboxBefore: childState.sandboxBefore ?? snapshotSandbox(child.session)
						});
						reconcileSandbox(child.session, mode, childState.sandboxBefore ?? null);
					}
					if (revoke) {
						killJobs(child.session);
						closeTerminals(child, false);
					}
				}
			};

			/**
			 * Commit one mode transition: the state first, then the sandbox.
			 *
			 * @param {object} agent - Live agent.
			 * @param {{mode: string, planId?: string|null, planApproved?: boolean, contract?: object|null}} intent - Target mode.
			 * @returns {string} The committed mode.
			 */
			const commitMode = (agent, intent) => {
				const session = agent.session;
				const previous = stateOf(session);
				const sandboxBefore = previous.sandboxBefore ?? snapshotSandbox(session);
				const mode = intent.mode;
				const planId = mode === "EXECUTE" ? (intent.planId ?? null) : null;
				const planApproved = mode === "EXECUTE" ? intent.planApproved === true : false;
				const contract = mode === "EXECUTE" ? (intent.contract ?? null) : null;
				transact(session, applyMode, {
					mode,
					planId,
					planApproved,
					contract,
					sandboxBefore: mode === "OFF" ? null : sandboxBefore
				});
				if (mode === "OFF") {
					if (cfg.manageSandbox && previous.sandboxBefore !== null) {
						session.append("sandbox/mode", { mode: previous.sandboxBefore });
					}
					return mode;
				}
				reconcileSandbox(session, mode, sandboxBefore);
				if (mode !== "EXECUTE") {
					pinDescendants(agent, mode, previous.mode === "EXECUTE" && cfg.revokeRunningWork);
					// Only a downgrade away from a write-capable EXECUTE must stop live
					// terminals; switching among read-only modes must not kill user shells.
					if (previous.mode === "EXECUTE") closeTerminals(agent, false);
				}
				return mode;
			};

			/**
			 * Initialize a never-seen session, or invalidate a fork's inherited
			 * approval. Runs before the first request of the session.
			 */
			const ensureInitialized = (agent) => {
				const session = agent.session;
				if (initialized.has(session)) return stateOf(session);
				const state = stateOf(session);
				const header = session.header ?? {};

				if (state.mode === null) {
					const parent = agent.parentAgent;
					const parentState = parent === undefined ? null : stateOf(parent.session);
					let mode = "RESEARCH";
					let planId = null;
					let planApproved = false;
					let contract = null;
					if (parentState !== null && parentState.mode !== null) {
						if (parentState.mode === "OFF") {
							mode = "OFF";
						} else if (parentState.mode === "EXECUTE") {
							mode = "EXECUTE";
							planId = parentState.planId;
							planApproved = parentState.planApproved;
							contract = parentState.contract;
						} else {
							mode = parentState.mode;
						}
					}
					const sandboxBefore = snapshotSandbox(session);
					const next = transact(session, applyMode, { mode, planId, planApproved, contract, sandboxBefore });
					reconcileSandbox(session, mode, sandboxBefore);
					// Mark only after the commit succeeded: a failed init must be retried
					// on the next step instead of leaving the session in fail-open limbo.
					initialized.add(session);
					return next;
				}

				if (header.isSeeded === true) {
					// A fork normally starts with no record at all; this guard also covers
					// a stored record that still carries an inherited approval.
					if (state.planId !== null || state.planApproved === true || state.contract !== null) {
						const mode = state.mode === "EXECUTE" ? "PLAN" : state.mode;
						transact(session, applyMode, {
							mode,
							planId: null,
							planApproved: false,
							contract: null,
							sandboxBefore: state.sandboxBefore
						});
						reconcileSandbox(session, mode, state.sandboxBefore);
					}
				}
				initialized.add(session);
				return stateOf(session);
			};

			/** Read-only precondition check for a requested mode target. */
			const checkTarget = (session, target) => {
				const state = stateOf(session);
				if (target === "EXECUTE") {
					if (!state.planApproved || typeof state.planId !== "string" || state.contract === null) {
						return "进入 EXECUTE 需要先通过 propose_plan 获得批准：请用 /mode plan 规划并提交计划。";
					}
				}
				if (target === "REVIEW" && state.mode !== "EXECUTE") {
					return "REVIEW 只能从 EXECUTE 进入：请先完成执行，再执行 /mode review。";
				}
				return null;
			};

			/**
			 * Request a target mode: commit now, or queue for the next accepted step
			 * when a turn is open.
			 */
			const requestMode = (agent, target) => {
				const session = agent.session;
				const state = stateOf(session);
				const selected = selectedMode(session);
				if (selected === target) return { ok: true, text: `RIPER-5 已经是 ${target}。` };
				const problem = checkTarget(session, target);
				if (problem !== null) return { ok: false, text: problem };
				const intent = {
					mode: target,
					planId: target === "EXECUTE" ? state.planId : null,
					planApproved: target === "EXECUTE" ? state.planApproved : false,
					contract: target === "EXECUTE" ? state.contract : null,
				};
				const turnOpen = (() => {
					try {
						return inner.agents.turnBoundaryOf(session).openTurnStartSeq !== null;
					} catch {
						return false;
					}
				})();
				if (turnOpen) return { ok: false, text: "当前步骤仍在执行，请在本轮结束后再切换模式。" };
				commitMode(agent, intent);
				const suffix = target === "EXECUTE" && intent.contract !== null ? ` 契约：${intent.contract.files.join("、")}` : "";
				return { ok: true, text: `RIPER-5 已切换到 ${target}。${suffix}` };
			};

			/** Leave RIPER-5: restore the sandbox and stop live work in the whole tree. */
			const disengage = (agent) => {
				const session = agent.session;
				const state = stateOf(session);
				if (state.mode === "OFF") return { ok: true, text: "RIPER-5 已经是关闭状态。" };
				let killed = 0;
				for (const target of [agent, ...descendantsOf(agent)]) {
					const targetSession = target.session;
					const targetState = stateOf(targetSession);
					if (targetState.mode === "OFF") continue;
					const restore = targetState.sandboxBefore;
					killed += killJobs(targetSession);
					transact(targetSession, applyMode, { mode: "OFF", planId: null, planApproved: false, contract: null, sandboxBefore: null });
					if (cfg.manageSandbox && typeof restore === "string") targetSession.append("sandbox/mode", { mode: restore });
				}
				closeTerminals(agent, true);
				const restore = state.sandboxBefore;
				return {
					ok: true,
					text: `RIPER-5 已关闭${killed > 0 ? `，终止了 ${killed} 个后台任务` : ""}；沙箱${cfg.manageSandbox && typeof restore === "string" ? `已还原为 ${restore}` : "保持不变"}。`
				};
			};

			/**
			 * Switch into PLAN or REVIEW from a user sentence. This runs while the
			 * message is admitted, before the turn's first step, so it commits directly
			 * instead of using requestMode's open-turn guard: the sentence is the user's
			 * own instruction and the turn starts after this listener returns. EXECUTE
			 * has its own lane because it needs the plan approval.
			 *
			 * @param {object} agent - Live root agent.
			 * @param {"PLAN"|"REVIEW"} target - Target mode.
			 * @param {object} message - Inbox message that carried the sentence.
			 * @returns {void}
			 */
			const switchFromText = (agent, target, message) => {
				const session = agent.session;
				const problem = checkTarget(session, target);
				if (problem !== null) {
					transact(session, applyNotice, { text: `文本触发未切换到 ${target}：${problem}` });
					return;
				}
				transact(session, appendAudit, { kind: "mode-text", target, messageId: String(message.id ?? "") });
				commitMode(agent, { mode: target, planId: null, planApproved: false, contract: null });
				transact(session, applyNotice, { text: `模式已由用户文本切换到 ${target}，请在本次回复里直接开始该模式的工作。` });
			};

			/**
			 * Approve the stored plan draft from a user sentence and start EXECUTE. A
			 * draft only exists after the user cancelled the approval card or chose
			 * "keep planning", so the sentence carries the intent the card would have
			 * asked for; the audit entry records it as text-sourced.
			 *
			 * @param {object} agent - Live root agent.
			 * @param {object} message - Inbox message that carried the sentence.
			 * @returns {void}
			 */
			const approveDraftFromText = (agent, message) => {
				const session = agent.session;
				const state = stateOf(session);
				if (typeof state.planId !== "string" || state.contract === null) {
					transact(session, applyNotice, { text: "文本触发未切换到 EXECUTE：当前没有已提交的计划草稿，请先在 PLAN 模式提交计划并完成审批。" });
					return;
				}
				const planId = state.planId;
				const contract = state.contract;
				transact(session, appendAudit, {
					kind: "approval",
					planId,
					source: "text",
					messageId: String(message.id ?? ""),
					approvedAt: Date.now()
				});
				commitMode(agent, { mode: "EXECUTE", planId, planApproved: true, contract });
				transact(session, applyNotice, { text: `已按用户文本批准计划 ${planId} 并进入 EXECUTE，请按契约文件实施。` });
			};

			/** Human-readable state summary. */
			const statusReport = (agent) => {
				const session = agent.session;
				const state = stateOf(session);
				const mode = state.mode ?? "未初始化";
				const lines = [`RIPER-5 模式：${mode}`];
				if (state.planId !== null) {
					lines.push(`planId：${state.planId}（${state.planApproved ? "已批准" : "未批准"}）`);
				}
				if (state.contract !== null) lines.push(`契约文件：${state.contract.files.join("、")}`);
				if (state.blockers > 0) lines.push(`最近审查 blocker：${state.blockers}`);
				if (state.reviewer !== null) lines.push(`最近独立审查员：${state.reviewer.agentId}（${state.reviewer.provider}）`);
				lines.push(`状态存储：${storageStatus()}${state.updatedAt === null ? "" : `（updatedAt ${new Date(state.updatedAt).toISOString()}）`}`);
				if (state.notice !== null) lines.push(`提示：${state.notice}`);
				try {
					lines.push(`沙箱：${resolveSandbox(session).mode}（engage 前：${state.sandboxBefore ?? "未知"}）`);
				} catch {
					lines.push("沙箱：未知");
				}
				lines.push("可用切换：" + MODES.map((entry) => entry.toLowerCase()).join(" | ") + "（也支持 研究/创新/规划/执行/评审/关闭）");
				return lines.join("\n");
			};

			// ---------------------------------------------------------------- guard
			/** Resolve the sandbox mode a command tool would run under. */
			const resolveSandboxMode = (session) => {
				try {
					return resolveSandbox(session).mode;
				} catch {
					return null;
				}
			};

			/** The global guard: runs for every tool call of every agent. */
			const guardCall = (agent, name, args) => {
				if (reviewerSessions.has(String(agent.session.id))) {
					const denial = reviewerToolDenied(name);
					if (denial !== null) return denial;
				}
				const state = stateOf(agent.session);
				return guardDecision({
					mode: state.mode,
					planApproved: state.planApproved === true,
					planId: state.planId,
					contract: state.contract,
					name,
					args,
					cwd: sessionCwd(agent.session),
					config: cfg,
					sandboxMode: name === "run_code" ? resolveSandboxMode(agent.session) : null
				});
			};

			disposers.push(inner.tools.guard((exec) => {
				if (exec.agent === undefined) return undefined;
				return guardCall(exec.agent, exec.name, exec.arguments ?? {});
			}));

			// ------------------------------------------------------------ pre-step
			const disposePreStep = inner.on("agent/pre-step", async ({ agent, signal }, next) => {
				try {
					ensureInitialized(agent);
				} catch (error) {
					inner.logger.warn("dsh-riper5: 初始化会话状态失败：%o", error);
				}
				const decision = await next();
				if (decision.kind === "reject" || signal.aborted) return decision;
				try {
					const state = stateOf(agent.session);
					if (state.mode !== null) {
						reconcileSandbox(agent.session, state.mode, state.sandboxBefore);
					}
				} catch (error) {
					inner.logger.warn("dsh-riper5: 提交模式/沙箱状态失败：%o", error);
				}
				return decision;
			});
			if (typeof disposePreStep === "function") disposers.push(disposePreStep);

			// ------------------------------------------------------------- prompt
			disposers.push(inner.systemPrompt.section({
				name: "riper5:policy",
				order: inner.systemPrompt.getSectionOrder("PLAN_POLICY"),
				text: (context) => {
					const agent = context.agent;
					if (agent === undefined) return "";
					try {
						const session = agent.session;
						const state = stateOf(session);
						const mode = state.mode;
						if (mode === null || mode === "OFF") return "";
						const planId = state.planId;
						const contract = state.contract;
						const approved = state.planApproved;
						const lines = [
							`## RIPER-5 会话协议（当前模式：${mode}）`,
							"这是一道部署强制的闸门，优先级高于用户的临时要求；被拒绝的工具调用就是最终结果，不要绕过或重试越权操作。",
							"每轮回复的第一行写 `[MODE: " + mode + "]`。",
							MODE_SECTIONS[mode] ?? ""
						];
						if (mode === "EXECUTE") {
							if (approved === true && contract !== null && hasApprovedPlan({ ...state, mode: "EXECUTE", planApproved: true, planId, contract })) {
								lines.push(`已批准计划：\`${planId}\`（已批准）`);
								lines.push(`契约文件（只允许改这些）：${contract.files.map((file) => `\`${file}\``).join("、")}`);
							} else {
								lines.push("警告：当前没有有效的已批准计划，写入会被拒绝；请先在 PLAN 模式提交计划。");
							}
						}
						if (mode === "PLAN" && planId !== null && contract !== null) {
							lines.push(`已提交计划：\`${planId}\`（等待审批；重新提交会生成新的 planId）。契约文件：${contract.files.map((file) => `\`${file}\``).join("、")}`);
						}
						if (state.blockers > 0) {
							lines.push(`上一轮审查记录了 ${state.blockers} 个 blocker，planId 已作废；请回到 PLAN 修复后重新提交计划。`);
							for (const finding of state.lastFindings.filter((entry) => entry.severity === "blocker").slice(0, 5)) {
								lines.push(`- ${finding.file ?? "未指定文件"}${finding.line === null ? "" : `:${finding.line}`} — ${finding.evidence}`);
							}
						}
						if (state.notice !== null) lines.push(`提示：${state.notice}`);
						if (storageStatus() !== "持久化") lines.push(`状态存储：${storageStatus()}`);
						if (cfg.manageSandbox && mode !== "EXECUTE") lines.push(`沙箱：read-only（engage 前的模式：${state.sandboxBefore ?? "未知"}，可用 /mode off 还原）。`);
						return lines.filter((line) => line !== "").join("\n");
					} catch (error) {
						inner.logger.warn("dsh-riper5: 生成模式提示失败：%o", error);
						return "";
					}
				}
			}));

			// -------------------------------------------------------------- tools
			/** Ask the user (or the text lane) to approve the plan. */
			const askApproval = async (agent, exec, planText) => {
				const interaction = inner.get("userQuestions");
				if (interaction === undefined) {
					throw new Error("当前会话没有可用的用户提问通道，无法完成计划审批；请用户用 /mode execute 在已有批准计划时手动进入执行模式。");
				}
				const waiter = { ac: new AbortController(), approvedBy: null };
				const onAbort = () => waiter.ac.abort();
				if (exec.signal !== undefined) exec.signal.addEventListener("abort", onAbort, { once: true });
				approvalWaiters.set(agent.session.id, waiter);
				let answer;
				try {
					answer = await interaction.ask({
						questions: [{
							id: APPROVAL_ID,
							header: "RIPER-5 计划审批",
							question: "批准这份计划并进入 EXECUTE 吗？批准后立即生效，且只能修改契约文件。",
							detail: planText,
							options: [{
								label: APPROVE_LABEL,
								description: "进入 EXECUTE：沙箱切到 workspace-write，写入限制在契约文件内。"
							}, {
								label: KEEP_PLANNING_LABEL,
								description: "留在 PLAN：反馈会回到模型，用于修订计划。"
							}]
						}],
						agent,
						signal: waiter.ac.signal
					});
				} catch (cause) {
					if (waiter.approvedBy !== null) return { approved: true, approvedBy: waiter.approvedBy };
					if (cause?.code === "ASK_CANCELLED" || cause?.name === "AbortError" || exec.signal?.aborted === true) {
						// Cancellation is a normal outcome: end the turn instead of throwing,
						// otherwise the model re-asks and the cancellation loops.
						return { approved: false, cancelled: true };
					}
					throw cause;
				} finally {
					approvalWaiters.delete(agent.session.id);
					if (exec.signal !== undefined) exec.signal.removeEventListener("abort", onAbort);
				}
				const items = Array.isArray(answer?.answers) ? answer.answers.filter((item) => item?.id === APPROVAL_ID) : [];
				const item = items.length === 1 ? items[0] : undefined;
				if (item?.selected?.length === 1 && item.selected[0] === APPROVE_LABEL && item.custom === undefined) {
					return { approved: true, approvedBy: null };
				}
				const feedback = typeof item?.custom === "string" ? item.custom.trim() : "";
				return { approved: false, feedback, cancelled: false };
			};

			const proposePlan = {
				name: "propose_plan",
				description: "Use only in PLAN mode. Submit the complete implementation plan. A fresh independent reviewer inspects the first plan of a PLAN engagement; any blocker rejects it before a human sees an approval card. Revisions of an already-reviewed plan skip the reviewer unless review=\"always\". The plan must start with a # heading, contain `## 目标`, `## 步骤` with consecutive numbered steps, `## 验证方式`, and a [更改规划] block; name every file it will modify on its own `- 文件：<path>` line inside that block. Fenced examples are ignored. After the reviewer passes, the human approves; then EXECUTE starts immediately and writes are limited to those files. On \"keep planning\", the user's feedback comes back in the tool result: revise and submit again.",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						plan: {
							type: "string",
							description: "The complete plan as markdown: `# 标题`, `## 目标`, `## 步骤` with consecutive numbered steps, `## 验证方式`, and a `[更改规划]` block with one `- 文件：<path>` line per file."
						},
						review: {
							type: "string",
							enum: ["auto", "always", "never"],
							description: "Review policy: auto (default) reviews only the first plan of this PLAN engagement; always forces a fresh independent review; never skips it."
						}
					},
					required: ["plan"]
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							approved: { type: "boolean" },
							planId: { type: "string" },
							files: { type: "array", items: { type: "string" } },
							review: {
								type: "object",
								additionalProperties: false,
								properties: {
									blockers: { type: "integer" },
									findings: { type: "array", items: { type: "object", additionalProperties: true } }
								},
								required: ["blockers", "findings"]
							},
							message: { type: "string" },
							feedback: { type: "string" }
						},
						required: ["approved", "planId", "files", "review", "message", "feedback"]
					},
					render: (_args, value) => [{ type: "text", text: String(value?.message ?? "") }]
				},
				execute: async (args, exec) => {
					const agent = exec.agent;
					if (agent === undefined) throw new Error("propose_plan 需要一个活动会话");
					ensureInitialized(agent);
					const session = agent.session;
					const state = stateOf(session);
					if (state.mode !== "PLAN") {
						throw new Error(`propose_plan 只能在 PLAN 模式调用；当前模式：${state.mode ?? "未初始化"}。请让用户先执行 /mode plan。`);
					}
					const { files, hash, text } = validatePlan(args?.plan);
					const reviewMode = args?.review === "always" || args?.review === "never" ? args.review : "auto";
					const shouldReview = reviewMode === "always" || (reviewMode === "auto" && (state.planSubmissions ?? 0) === 0);
					let review = { findings: [], reviewer: null, skipped: !shouldReview, error: null };
					if (shouldReview) {
						try {
							review = { ...(await runIndependentReview(agent, exec, { kind: "plan", planText: text, hash, files })), skipped: false, error: null };
						} catch (error) {
							const reason = error instanceof Error ? error.message : String(error);
							review = { findings: [], reviewer: null, skipped: false, error: reason };
							transact(session, appendAudit, { kind: "plan-review", hash, error: reason, accepted: false });
						}
					} else {
						transact(session, appendAudit, { kind: "plan-review", hash, skipped: true });
					}
					const planBlockers = review.findings.filter((finding) => finding.severity === "blocker");
					if (review.error === null) {
						transact(session, applyPlanReview, {
							hash,
							findings: review.findings,
							blockers: planBlockers.length,
							reviewer: review.reviewer,
							accepted: planBlockers.length === 0
						});
					}
					if (planBlockers.length > 0) {
						const list = planBlockers.map((blocker, index) => `${index + 1}. ${blocker.file === null ? "未指定文件" : blocker.file}${blocker.line === null ? "" : `:${blocker.line}`} — ${blocker.evidence}`).join("\n");
						throw new Error(`独立审查未通过：${planBlockers.length} 个 blocker，计划未进入人工审批。待修清单：\n${list}`);
					}
					const planId = createPlanId(hash);
					transact(session, applyPlan, { planId, hash, files, text });
					const approvalWarnings = [];
					if (review.skipped) approvalWarnings.push("⚠ 本次修订未重新独立审查（首版已审）。");
					if (review.error !== null) approvalWarnings.push(`⚠ 独立审查不可用：${review.error}。本次批准未经独立审查。`);
					const outsideRoot = files.filter((file) => !withinRoot(file, inner.sandboxPolicy.workspaceRoot, sessionCwd(session)));
					if (outsideRoot.length > 0) approvalWarnings.push(`⚠ ${outsideRoot.length} 个契约文件在工作区外，EXECUTE 沙箱为 workspace-write，写入可能需要宿主提权审批：${outsideRoot.slice(0, 5).join("、")}`);
					const approvalDetail = approvalWarnings.length === 0 ? text : `${approvalWarnings.join("\n")}\n\n${text}`;
					const outcome = await askApproval(agent, exec, approvalDetail);
					if (outcome.cancelled === true) {
						// The user dismissed the approval card; end the turn explicitly so
						// the model does not immediately re-open the same question.
						if (typeof exec.concludeTurn === "function") exec.concludeTurn();
						transact(session, appendAudit, { kind: "approval", planId, source: "cancelled", messageId: null });
						return {
							approved: false,
							planId,
							files,
							review: { blockers: 0, findings: review.findings },
							message: "计划审批已取消：计划草稿已保留，仍在 PLAN；再次提交会生成新 planId 并跳过独立审查（首版已审）。",
							feedback: ""
						};
					}
					if (!outcome.approved) {
						return {
							approved: false,
							planId,
							files,
							review: { blockers: 0, findings: review.findings },
							message: outcome.feedback === ""
								? "用户选择继续完善计划；请修订计划后再次调用 propose_plan。"
								: `用户选择继续完善计划，反馈：${outcome.feedback}`,
							feedback: outcome.feedback
						};
					}
					const approvedAt = Date.now();
					transact(session, appendAudit, {
						kind: "approval",
						planId,
						source: outcome.approvedBy === null ? "card" : "text",
						messageId: outcome.approvedBy === null ? null : outcome.approvedBy.messageId,
						approvedAt
					});
					commitMode(agent, {
						mode: "EXECUTE",
						planId,
						planApproved: true,
						contract: { files, hash }
					});
					const channel = outcome.approvedBy === null ? "审批卡片" : `用户文本「${outcome.approvedBy.text}」`;
					const reviewSummary = review.skipped
						? "本次修订未重新独立审查"
						: review.error !== null
							? `独立审查不可用（${review.error}）`
							: `独立审查员 ${review.reviewer.agentId} 无 blocker`;
					const outsideNote = outsideRoot.length > 0 ? ` 注意：${outsideRoot.length} 个契约文件在工作区外，写入可能需要宿主提权审批。` : "";
					return {
						approved: true,
						planId,
						files,
						review: { blockers: 0, findings: review.findings },
						message: `计划已获批准（${channel}）。${reviewSummary}；EXECUTE 已立即生效，仅可修改契约文件：${files.join("、")}。${outsideNote}`,
						feedback: ""
					};
				}
			};

			/** Render one caught error for a tool result without leaking a stack. */
			const reviewError = (error) => error instanceof Error ? error.message : String(error);

			/**
			 * Spawn a fresh reviewer, wait for its structured verdict, and dispose it.
			 * Every failure path throws: the caller must not fall back to self-review.
			 *
			 * @param {object} agent - The parent agent that owns the gate.
			 * @param {object} exec - Tool execution context (signal/cwd).
			 * @param {object} options - Review target.
			 * @returns {Promise<{findings: object[], reviewer: {agentId: string, provider: string, model: string | null}}>} Verdict.
			 */
			const runIndependentReview = async (agent, exec, options) => {
				const subagents = inner.get("subagents");
				if (subagents === undefined) throw new Error("当前部署没有 subagents 服务，无法启动独立审查员；本次操作失败关闭。");
				const provider = subagents.getProvider(cfg.reviewProvider);
				if (provider === undefined) throw new Error(`独立审查 provider "${cfg.reviewProvider}" 未注册；本次操作失败关闭。`);
				if (provider.inheritsParentContext && !cfg.allowContextInheritingReviewer) {
					throw new Error(`独立审查 provider "${cfg.reviewProvider}" 会继承父上下文，不能作为独立审查员；请改用 spawn，或显式允许。`);
				}
				if (!provider.capabilities.outputSchema) throw new Error(`独立审查 provider "${cfg.reviewProvider}" 不支持 outputSchema，无法取得结构化结论。`);
				if (cfg.reviewAgentPreset !== null && (!provider.capabilities.agentPreset || provider.inheritsParentContext)) {
					throw new Error(`独立审查 provider "${cfg.reviewProvider}" 不支持独立 agentPreset。`);
				}
				if (cfg.reviewAgentOptions !== null && !provider.capabilities.agentOptions) {
					throw new Error(`独立审查 provider "${cfg.reviewProvider}" 不支持 agentOptions 覆盖。`);
				}
				const cwd = sessionCwd(agent.session);
				const prompt = buildReviewPrompt({ ...options, cwd });
				const timeout = AbortSignal.timeout(cfg.reviewTimeoutMs);
				const signal = exec.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout]);
				let activation;
				try {
					// SubagentActivationSpec is flat; do not wrap these fields in `request`.
					activation = await subagents.startActivation({
						provider: cfg.reviewProvider,
						label: `dsh-riper5 ${options.kind} review`,
						cwd,
						prompt: [{ type: "text", text: prompt }],
						parent: agent,
						outputSchema: REVIEW_SCHEMA,
						...(cfg.reviewAgentPreset === null ? {} : { agentPreset: cfg.reviewAgentPreset }),
						...(cfg.reviewAgentOptions === null ? {} : { agentOptions: cfg.reviewAgentOptions }),
						signal,
						delivery: "caller"
					});
				} catch (error) {
					throw new Error(`独立审查员启动失败：${reviewError(error)}`);
				}
				const reviewerId = String(activation.childId);
				reviewerSessions.add(reviewerId);
				try {
					const result = await activation.result;
					if (result.stopReason !== "completed") {
						const diagnostic = typeof result.diagnostic === "string" && result.diagnostic !== "" ? `：${result.diagnostic}` : "";
						throw new Error(`独立审查员未正常完成（stopReason=${result.stopReason}${diagnostic}）`);
					}
					const findings = normalizeReviewFindings(result.structured);
					return {
						findings,
						reviewer: {
							agentId: reviewerId,
							provider: cfg.reviewProvider,
							model: cfg.reviewAgentOptions?.model ?? null
						}
					};
				} catch (error) {
					if (timeout.aborted) throw new Error(`独立审查超时（${cfg.reviewTimeoutMs}ms）。`);
					throw new Error(`独立审查失败：${reviewError(error)}`);
				} finally {
					try {
						await activation.dispose();
					} catch (error) {
						inner.logger.warn("dsh-riper5: 释放独立审查员失败：%o", error);
					} finally {
						reviewerSessions.delete(reviewerId);
					}
				}
			};

			const submitReview = {
				name: "submit_review",
				description: "Use only in REVIEW mode. Launch a fresh independent reviewer to verify the implementation against the approved plan. You cannot pass findings or a conclusion yourself: the reviewer reads the workspace, runs the plan's verification commands, and returns evidence. Any blocker returns the session to PLAN immediately and invalidates the approval; without blockers the reviewer's conclusion is exactly \"实施与规划完全匹配\".",
				parameters: {
					type: "object",
					additionalProperties: false,
					properties: {
						focus: {
							type: "string",
							description: "Optional extra focus for the reviewer (for example a risky file or an unverified claim). It cannot replace the reviewer's own evidence."
						}
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							accepted: { type: "boolean" },
							blockers: { type: "integer" },
							nextMode: { type: "string" },
							findings: { type: "array", items: { type: "object", additionalProperties: true } },
							reviewer: { type: "object", additionalProperties: true },
							message: { type: "string" }
						},
						required: ["accepted", "blockers", "nextMode", "findings", "reviewer", "message"]
					},
					render: (_args, value) => [{ type: "text", text: String(value?.message ?? "") }]
				},
				execute: async (args, exec) => {
					const agent = exec.agent;
					if (agent === undefined) throw new Error("submit_review 需要一个活动会话");
					ensureInitialized(agent);
					const session = agent.session;
					const state = stateOf(session);
					if (state.mode !== "REVIEW") {
						throw new Error(`submit_review 只能在 REVIEW 模式调用；当前模式：${state.mode ?? "未初始化"}。EXECUTE 完成后请让用户执行 /mode review。`);
					}
					const reviewOf = state.reviewOf;
					if (reviewOf === null) throw new Error("没有可审查的已执行计划：请先完成 PLAN → EXECUTE → /mode review。");
					if (typeof state.planText !== "string" || state.planText.trim() === "") {
						throw new Error("计划正文未记录（可能是旧版本事件）：无法让独立审查员对照计划；请重新 propose_plan 并执行后再审查。");
					}
					const focus = typeof args?.focus === "string" ? args.focus.trim() : "";
					const review = await runIndependentReview(agent, exec, {
						kind: "implementation",
						planText: state.planText,
						planId: reviewOf.planId,
						hash: reviewOf.hash ?? undefined,
						files: reviewOf.files ?? [],
						focus
					});
					const findings = review.findings;
					const blockers = findings.filter((finding) => finding.severity === "blocker");
					const effectiveConclusion = blockers.length > 0 ? CONCLUSION_DEVIATION : CONCLUSION_MATCH;
					transact(session, applyReview, {
						conclusion: effectiveConclusion,
						blockers: blockers.length,
						findings,
						planId: reviewOf.planId,
						hash: reviewOf.hash,
						files: reviewOf.files ?? [],
						reviewer: review.reviewer
					});
					if (blockers.length > 0) {
						commitMode(agent, { mode: "PLAN", planId: null, planApproved: false, contract: null });
						const list = blockers.map((blocker, index) => `${index + 1}. ${blocker.file === null ? "未指定文件" : blocker.file}${blocker.line === null ? "" : `:${blocker.line}`} — ${blocker.evidence}`).join("\n");
						return {
							accepted: false,
							blockers: blockers.length,
							nextMode: "PLAN",
							findings,
							reviewer: review.reviewer,
							message: `独立审查员 ${review.reviewer.agentId} 记录了 ${blockers.length} 个 blocker；下一步回到 PLAN，planId 已作废。待修清单：\n${list}\n请修订计划并重新调用 propose_plan 获得批准。`
						};
					}
					return {
						accepted: true,
						blockers: 0,
						nextMode: "REVIEW",
						findings,
						reviewer: review.reviewer,
						message: `独立审查员 ${review.reviewer.agentId} 通过（0 个 blocker）：${effectiveConclusion}。会话保持 REVIEW 只读；如需继续改动，请让用户 /mode plan 重新规划。`
					};
				}
			};

			disposers.push(inner.tools.register(proposePlan, { when: ({ agent }) => agent !== undefined && agent.parentAgent === undefined && selectedMode(agent.session) === "PLAN" }));
			disposers.push(inner.tools.register(submitReview, { when: ({ agent }) => agent !== undefined && agent.parentAgent === undefined && selectedMode(agent.session) === "REVIEW" }));

			// ------------------------------------------------------------ command
			inner.inject(["commands"], (commandCtx) => {
				disposers.push(commandCtx.commands.register({
					name: "mode",
					description: "RIPER-5 模式：显示或切换 research/innovate/plan/execute/review/off",
					input: { hint: "[research|innovate|plan|execute|review|off]" },
					handler: ({ agent, rawInput }) => {
						try {
							if (agent === undefined) return { kind: "error", text: "RIPER-5 需要一个活动会话。" };
							ensureInitialized(agent);
							const token = String(rawInput ?? "").trim();
							if (token === "") return { kind: "success", text: statusReport(agent) };
							const target = resolveModeToken(token);
							if (target === null) {
								return {
									kind: "error",
									text: `RIPER-5 未知模式 "${token}"；可用：${MODES.map((mode) => mode.toLowerCase()).join(", ")}（也支持 研究/创新/规划/执行/评审/关闭）`
								};
							}
							const outcome = target === "OFF" ? disengage(agent) : requestMode(agent, target);
							return outcome.ok ? { kind: "success", text: outcome.text } : { kind: "error", text: `RIPER-5 未切换：${outcome.text}` };
						} catch (error) {
							return { kind: "error", text: `RIPER-5 命令失败：${error instanceof Error ? error.message : String(error)}` };
						}
					}
				}));
			});

			// --------------------------------- text lane (approval + mode advance)
			const disposeInbox = inner.on("agent/inbox/inserted", ({ agent, message }) => {
				try {
					if (message?.source?.kind !== "user") return;
					const text = messageText(message);
					if (text === "") return;
					const waiter = approvalWaiters.get(agent.session.id);
					if (waiter !== undefined && cfg.autoApproveText && isApprovalText(text)) {
						waiter.approvedBy = { text, messageId: String(message.id ?? "") };
						waiter.ac.abort();
						transact(agent.session, applyNotice, { text: "上一条用户文本已作为计划批准消费，不会作为新的需求重复处理。" });
						return;
					}
					// An open approval card keeps the text lane: a mode phrase must not
					// answer the card or switch behind it.
					if (waiter !== undefined) return;
					if (cfg.textModeSwitch !== true) return;
					if (agent.parentAgent !== undefined) return;
					const target = resolveModePhrase(text);
					if (target === null) return;
					if (stateOf(agent.session).mode === target) return;
					if (target === "EXECUTE") approveDraftFromText(agent, message);
					else switchFromText(agent, target, message);
				} catch (error) {
					inner.logger.warn("dsh-riper5: 处理用户文本触发的模式动作失败：%o", error);
				}
			});
			if (typeof disposeInbox === "function") disposers.push(disposeInbox);
		});
	}
};
