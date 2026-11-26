/**
 * Protocol constants and pure helpers for dsh-riper5.
 *
 * Everything here is free of DSH imports so the protocol can be unit-tested
 * and reasoned about on its own: event names kept for reading legacy logs, mode
 * tokens, plan validation, the contract normalizer, and the approval/switch
 * text matchers. The plugin never appends the legacy `riper/*` events: see the
 * note below.
 *
 * @module dsh-riper5/protocol
 */

import { createHash } from "node:crypto";
import { isAbsolute, normalize, resolve, sep } from "node:path";

/**
 * Legacy event names, kept for reading logs written by earlier versions.
 *
 * The plugin no longer appends any of them: a reader that does not know an
 * event type refuses to reconstruct the session unless the envelope marks it
 * `ignorable`, and `Session.append()` cannot set that marker — writing these
 * made the whole session unreadable. State now lives in the Harness storage
 * domain (see `state.js`).
 */
/** Session event that used to record one committed mode transition. */
export const MODE_EVENT = "riper/mode";
/** Session event that used to record a submitted plan (before approval). */
export const PLAN_EVENT = "riper/plan";
/** Session event that used to record the independent reviewer's plan verdict. */
export const PLAN_REVIEW_EVENT = "riper/plan-review";
/** Session event that used to record a review report (non-blocking or blocking). */
export const REVIEW_EVENT = "riper/review";
/** Session event that used to record how a plan approval was given. */
export const APPROVAL_EVENT = "riper/approval";
/** Projection key of the retired `riperMode` session projection. */
export const PROJECTION_KEY = "riperMode";

/** The four working modes plus the terminal REVIEW mode, in order. */
export const WORK_MODES = ["RESEARCH", "INNOVATE", "PLAN", "EXECUTE", "REVIEW"];
/** Every selectable mode token, including the disengaged mode. */
export const MODES = [...WORK_MODES, "OFF"];

/** File-mutating tools that are gated by mode and, in EXECUTE, by contract. */
export const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);
/** Durable-schedule mutation tools: allowed only in EXECUTE. */
export const SCHEDULE_TOOLS = new Set(["schedule_create", "schedule_edit", "schedule_delete"]);
/** Command tools whose write side effects are constrained by the sandbox. */
export const SHELL_TOOLS = new Set(["bash", "pwsh", "powershell", "shell"]);
/** Terminal tools that only read state; allowed in read-only modes. */
export const TERMINAL_READ_TOOLS = new Set(["terminal_list", "terminal_read"]);
/** Plugin-manager actions that only inspect the profile. */
export const PLUGIN_MANAGER_READ_ACTIONS = new Set(["list_plugins", "list_bundles", "list_version_exemptions"]);

/** The only conclusion accepted when a review reports no blocker. */
export const CONCLUSION_MATCH = "实施与规划完全匹配";
/** The conclusion required when blockers exist. */
export const CONCLUSION_DEVIATION = "实施偏离规划";
/** Accepted finding severities, least to most severe. */
export const SEVERITIES = ["info", "warning", "blocker"];

/** The plan-approval question id and option labels. */
export const APPROVAL_ID = "riper-plan-approval";
export const APPROVE_LABEL = "Approve";
export const KEEP_PLANNING_LABEL = "Keep planning";
/** The review-report question id (reserved for host integrations). */
export const REVIEW_ID = "riper-review-report";

/** User texts that approve a plan awaiting approval when auto-approval is enabled. */
const APPROVAL_TEXTS = new Set(["可以", "同意", "按规划执行", "批准", "approve", "approved"]);

/** Alias table for `/mode <token>` and auto-switch phrases. */
const ALIASES = new Map([
	["research", "RESEARCH"],
	["研究", "RESEARCH"],
	["innovate", "INNOVATE"],
	["创新", "INNOVATE"],
	["plan", "PLAN"],
	["规划", "PLAN"],
	["planning", "PLAN"],
	["execute", "EXECUTE"],
	["执行", "EXECUTE"],
	["review", "REVIEW"],
	["评审", "REVIEW"],
	["审查", "REVIEW"],
	["off", "OFF"],
	["关闭", "OFF"],
	["关", "OFF"],
	["退出", "OFF"]
]);

/**
 * Resolve one mode token (English or Chinese alias) to a canonical mode.
 *
 * @param {string} raw - User-typed token, with or without slashes/case.
 * @returns {string | null} Canonical mode, or null when unknown.
 */
export function resolveModeToken(raw) {
	const token = String(raw ?? "").trim().toLowerCase().replace(/^\/+/, "");
	if (token === "") return null;
	return ALIASES.get(token) ?? null;
}

/**
 * Match a plain user sentence that approves a plan awaiting approval when the automatic
 * approval lane is enabled. Matching is strict: no extra words.
 *
 * @param {string} text - The user message text.
 * @returns {boolean} Whether the text approves.
 */
export function isApprovalText(text) {
	const value = String(text ?? "").trim().replace(/[。．.!！]+$/u, "").trim().toLowerCase();
	return APPROVAL_TEXTS.has(value);
}

/** The standard refusal prefix every guarded tool call sees. */
export function denyMessage(mode, detail) {
	const label = mode ?? "RESEARCH";
	const base = `[RIPER-5] 当前模式 ${label} 拒绝该调用。`;
	return detail === undefined || detail === "" ? base : `${base} ${detail}`;
}

/**
 * Whether one tool name is a file-mutating tool.
 *
 * @param {string} name - Tool name.
 * @returns {boolean}
 */
export function isWriteTool(name) {
	return WRITE_TOOLS.has(name);
}

/**
 * Extract every file path an `apply_patch` input touches.
 *
 * @param {unknown} input - The raw patch text.
 * @returns {string[]} Declared paths, deduplicated, in patch order.
 */
export function patchPaths(input) {
	if (typeof input !== "string") return [];
	const paths = [];
	const header = /^\*\*\* (?:Add|Update|Delete) File:[ \t]*(.+?)[ \t]*$/gm;
	const move = /^\*\*\* Move to:[ \t]*(.+?)[ \t]*$/gm;
	let match;
	while ((match = header.exec(input)) !== null) paths.push(match[1]);
	while ((match = move.exec(input)) !== null) paths.push(match[1]);
	return [...new Set(paths)];
}

/**
 * Resolve the paths one mutating tool call would touch.
 *
 * @param {string} name - Tool name.
 * @param {Record<string, unknown>} args - Tool arguments.
 * @returns {string[]} Declared paths (empty when the arguments are unusable).
 */
export function attemptedPaths(name, args) {
	if (name === "write" || name === "edit") {
		return typeof args?.file_path === "string" ? [args.file_path] : [];
	}
	if (name === "apply_patch") return patchPaths(args?.input);
	return [];
}

/**
 * Split one `- 文件：` value into file tokens. Backticked tokens and the
 * remaining text are both kept; the old implementation dropped the unquoted
 * remainder whenever one backticked token existed.
 *
 * @param {string} value - The right-hand side of a file line.
 * @returns {string[]} Trimmed, non-empty, deduplicated file tokens.
 */
export function parseFileTokens(value) {
	const raw = String(value ?? "").trim();
	const quoted = [...raw.matchAll(/`([^`]+)`/gu)].map((match) => match[1].trim()).filter((token) => token !== "");
	const remainder = raw.replace(/`[^`]+`/gu, " ");
	const uncommented = remainder.replace(/[（(][^()（）]*[)）]\s*$/u, "").trim();
	const tokens = uncommented
		.split(/[、,，;；]/u)
		// A trailing parenthetical is an annotation, not part of the path.
		.map((token) => token.replace(/[（(][^()（）]*[)）]\s*$/u, "").trim())
		.filter((token) => token !== "");
	return [...new Set([...quoted, ...tokens])];
}

/** The change-contract section titles a plan may use. */
const CHANGE_MARKERS = new Set(["[更改规划]", "[changes]"]);

/**
 * Normalize one line that may introduce the change contract. A marker line is
 * the bare token, optionally wrapped in emphasis, optionally written as a
 * heading, and optionally followed by a colon: `[更改规划]`, `## [更改规划]`,
 * `**[更改规划]**`, `[changes]:`.
 *
 * @param {string} line - Raw plan line.
 * @returns {string | null} Canonical marker, or null when the line is not one.
 */
function normalizeMarkerLine(line) {
	if (typeof line !== "string") return null;
	const text = line
		.trim()
		.replace(/^#{1,6}\s*/u, "")
		.replace(/[：:]\s*$/u, "")
		.replace(/^\*{1,2}\s*/u, "")
		.replace(/\s*\*{1,2}$/u, "")
		.trim()
		.toLowerCase();
	return CHANGE_MARKERS.has(text) ? text : null;
}

/** @returns {{line: string, fenced: boolean}[]} Lines with fence state. */
function scanLines(text) {
	const out = [];
	let fence = null;
	for (const line of text.split(/\r?\n/u)) {
		const marker = /^\s*(`{3,}|~{3,})/u.exec(line);
		if (marker !== null) {
			const run = marker[1];
			if (fence === null) {
				fence = { char: run[0], length: run.length };
			} else if (run[0] === fence.char && run.length >= fence.length) {
				fence = null;
			}
			out.push({ line, fenced: true });
			continue;
		}
		out.push({ line, fenced: fence !== null });
	}
	return out;
}

/**
 * Split the plan into sections. A level-2 heading and a change-marker line both
 * end the previous section, so the marker block never lends its content to the
 * section above it. Lines before the first heading form an orphan section whose
 * empty title matches no alias.
 *
 * @returns {{title: string, marker: boolean, entries: {line: string, fenced: boolean}[]}[]}
 */
function splitSections(lines) {
	const sections = [{ title: "", marker: false, entries: [] }];
	for (const entry of lines) {
		if (!entry.fenced) {
			const marker = normalizeMarkerLine(entry.line);
			if (marker !== null) {
				sections.push({ title: marker, marker: true, entries: [] });
				continue;
			}
			const heading = /^##\s+(.+?)\s*$/u.exec(entry.line);
			if (heading !== null) {
				sections.push({ title: heading[1].trim(), marker: false, entries: [] });
				continue;
			}
		}
		sections.at(-1).entries.push(entry);
	}
	return sections;
}

/** @returns {object | null} The first section whose title matches an alias. */
function sectionFor(sections, aliases) {
	const wanted = new Set(aliases.map((alias) => alias.toLowerCase()));
	for (const section of sections) {
		if (wanted.has(section.title.toLowerCase())) return section;
	}
	return null;
}

/**
 * @param {{entries: {line: string, fenced: boolean}[]} | null} section - Section.
 * @returns {string} Trimmed section body; fenced lines are content too, so a
 * verification block written as a fence still counts as a non-empty section.
 */
function sectionText(section) {
	if (section === null) return "";
	return section.entries
		.map((entry) => entry.line)
		.join("\n")
		.trim();
}

/**
 * Parse a plan document into steps and a contract. The parser is deliberately
 * small and fence-aware: examples inside fenced code never become contract
 * files or step numbers.
 *
 * @param {unknown} plan - Submitted plan text.
 * @param {number} [maxChars] - Optional length cap.
 * @returns {{files: string[], hash: string, text: string}}
 */
export function parsePlanDocument(plan, maxChars = 60_000) {
	if (typeof plan !== "string") throw new Error("plan 必须是字符串");
	const text = plan.trim();
	if (text === "") throw new Error("plan 不能为空");
	if (text.length > maxChars) throw new Error(`plan 过长（上限 ${maxChars} 字符）`);
	if (!/^#\s+\S/u.test(text)) throw new Error("plan 必须以一级标题（# 标题）开头，例如 `# 修复登录重试`");

	const lines = scanLines(text);
	const sections = splitSections(lines);
	const goal = sectionFor(sections, ["目标", "goals", "goal"]);
	if (goal === null || sectionText(goal) === "") throw new Error("plan 必须包含非空的 `## 目标` 段");
	const steps = sectionFor(sections, ["步骤", "steps", "step"]);
	if (steps === null) throw new Error("plan 必须包含 `## 步骤` 段");
	const verification = sectionFor(sections, ["验证方式", "verification", "verify"]);
	if (verification === null || sectionText(verification) === "") throw new Error("plan 必须包含非空的 `## 验证方式` 段");

	const numbers = [];
	for (const entry of steps.entries) {
		if (entry.fenced) continue;
		// Only a column-zero number counts: an indented sub-list is content.
		const match = /^(\d+)\.\s+\S/u.exec(entry.line);
		if (match !== null) numbers.push(Number(match[1]));
	}
	if (numbers.length === 0) throw new Error("`## 步骤` 必须包含从 1 开始的编号列表（`1. ...`）");
	let expected = 1;
	for (const count of numbers) {
		if (count !== expected) throw new Error(`plan 的编号列表必须从 1 开始且连续（期望 ${expected}，发现 ${count}）`);
		expected += 1;
	}

	if (!sections.some((section) => section.marker === true)) {
		throw new Error("plan 必须包含 `[更改规划]` 段，列出为完成目标需要修改的文件");
	}

	const fileLine = /^\s*[-*]\s*(?:文件|File)\s*[:：]\s*(.+)$/iu;
	const files = [];
	for (const section of sections) {
		for (const entry of section.entries) {
			if (entry.fenced) continue;
			const match = fileLine.exec(entry.line);
			if (match === null) continue;
			if (section.marker !== true) throw new Error("`- 文件：` 行必须放在 `[更改规划]` 段内");
			for (const token of parseFileTokens(match[1])) {
				if (!files.includes(token)) files.push(token);
			}
		}
	}
	if (files.length === 0) throw new Error("plan 必须至少包含一行 `- 文件：<路径>`，声明将被修改的文件");

	return { files, hash: sha256(text), text };
}

/**
 * Validate a RIPER-5 plan document and extract its contract.
 *
 * @param {unknown} plan - The submitted plan text.
 * @param {number} [maxChars] - Optional length cap.
 * @returns {{files: string[], hash: string, text: string}} Validated plan.
 */
export function validatePlan(plan, maxChars = 60_000) {
	return parsePlanDocument(plan, maxChars);
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Mint a plan id that carries its creation time (uniqueness only).
 *
 * @param {string} hash - Plan digest.
 * @param {number} [now] - Epoch milliseconds.
 * @returns {string} Plan id.
 */
export function createPlanId(hash, now = Date.now()) {
	return `riper-${hash.slice(0, 12)}-${now.toString(36)}`;
}

/**
 * Normalize a declared or attempted file path to an absolute path.
 *
 * @param {unknown} value - Path as written in a plan or tool argument.
 * @param {string} cwd - Session working directory.
 * @returns {string | null} Absolute normalized path, or null when unusable.
 */
export function normalizePath(value, cwd) {
	if (typeof value !== "string") return null;
	const path = value.trim();
	if (path === "") return null;
	return isAbsolute(path) ? normalize(path) : resolve(cwd, path);
}

/**
 * Case-folded path key used for contract comparison. Windows paths are
 * case-insensitive, so exact string comparison would reject a legitimate write
 * that differs only in casing.
 *
 * @param {unknown} value - Declared or attempted path.
 * @param {string} cwd - Session working directory.
 * @returns {string | null} Comparable key, or null when unusable.
 */
export function pathKey(value, cwd) {
	const absolute = normalizePath(value, cwd);
	if (absolute === null) return null;
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * Whether one attempted path is covered by an approved contract.
 *
 * @param {{files: string[]} | null | undefined} contract - Approved contract.
 * @param {unknown} candidate - Attempted path.
 * @param {string} cwd - Session working directory.
 * @returns {boolean} Exact-file membership after normalization.
 */
export function contractAllows(contract, candidate, cwd) {
	if (contract === null || contract === undefined) return false;
	const target = pathKey(candidate, cwd);
	if (target === null) return false;
	for (const declared of contract.files) {
		if (pathKey(declared, cwd) === target) return true;
	}
	return false;
}

/**
 * Whether one path lives under a root directory. Windows comparison is
 * case-insensitive and different drives never match.
 *
 * @param {unknown} file - Declared or attempted path.
 * @param {unknown} root - Workspace root.
 * @param {string} [cwd] - Session working directory.
 * @returns {boolean}
 */
export function withinRoot(file, root, cwd = process.cwd()) {
	const target = pathKey(file, cwd);
	const base = pathKey(root, cwd);
	if (target === null || base === null) return false;
	if (target === base) return true;
	return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * Decide whether one tool call is admissible under the current state.
 *
 * This is the pure core of the tool gate: it never reads DSH services, so the
 * decision matrix can be unit-tested. It is fail-closed everywhere the state is
 * ambiguous (uninitialized session, unparsable path, unparsable sandbox).
 *
 * @param {object} input - Decision inputs.
 * @param {"RESEARCH"|"INNOVATE"|"PLAN"|"EXECUTE"|"REVIEW"|"OFF"|null} input.mode - Committed mode.
 * @param {boolean} [input.planApproved] - Approval flag from the stored state.
 * @param {string | null} [input.planId] - Approved plan id.
 * @param {{files: string[], hash?: string} | null} [input.contract] - Approved contract.
 * @param {string} input.name - Tool name.
 * @param {Record<string, unknown>} [input.args] - Tool arguments.
 * @param {string} [input.cwd] - Session working directory for path matching.
 * @param {Record<string, unknown>} [input.config] - Effective plugin config.
 * @param {string | null} [input.sandboxMode] - Resolved sandbox for command tools.
 * @returns {string | undefined} Refusal text, or undefined when allowed.
 */
export function guardDecision(input) {
	const {
		mode = null,
		planApproved = false,
		planId = null,
		contract = null,
		name,
		args = {},
		cwd = process.cwd(),
		config = {},
		sandboxMode = null
	} = input ?? {};
	if (typeof name !== "string" || name === "") return denyMessage(mode, "工具名为空，已按 fail-closed 拒绝。");
	const denyTools = Array.isArray(config.denyTools) ? config.denyTools : [];
	const denyPrefixes = Array.isArray(config.denyPrefixes) ? config.denyPrefixes : [];
	if (denyTools.includes(name) || denyPrefixes.some((prefix) => prefix !== "" && name.startsWith(prefix))) {
		return denyMessage(mode, `工具 ${name} 已被 denyTools/denyPrefixes 拒绝。`);
	}
	if (mode === "OFF") return undefined;

	const shellTools = new Set([...SHELL_TOOLS, ...(Array.isArray(config.shellTools) ? config.shellTools : [])]);
	const isShell = shellTools.has(name);
	const isTerminal = name.startsWith("terminal_");
	const isMcp = name.startsWith("mcp__");
	const mcpPatterns = Array.isArray(config.mcpReadOnlyTools) ? config.mcpReadOnlyTools : [];
	const mcpAllowed = mcpPatterns.some((pattern) => typeof pattern === "string" && (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern));
	const pluginAction = typeof args?.action === "string" ? args.action : null;
	const pluginManagerRead = name === "plugin_manager" && pluginAction !== null && PLUGIN_MANAGER_READ_ACTIONS.has(pluginAction);
	const isManagement = name === "create_worktree" || (name === "plugin_manager" && !pluginManagerRead);

	if (mode === null || mode === undefined) {
		// Fail closed while the first pre-step has not committed the state: the
		// sandbox may still be the pre-engagement, write-capable one.
		const fenced = isWriteTool(name) || SCHEDULE_TOOLS.has(name) || isShell || name === "run_code" || isManagement || name === "plugin_manager" || isTerminal || isMcp;
		if (fenced) return denyMessage("RESEARCH", "会话尚未完成 RIPER-5 初始化，写入类、命令类与管理类工具已按 fail-closed 拒绝。");
		return undefined;
	}

	if (mode === "EXECUTE") {
		// Only file-mutating tools need an approved contract; read-only work is
		// never blocked just because a contract is missing.
		if (!isWriteTool(name)) return undefined;
		const validPlan = planApproved === true && typeof planId === "string" && contract !== null && Array.isArray(contract?.files);
		if (!validPlan) return denyMessage("EXECUTE", "没有有效的已批准计划（planId/contract），禁止写入；请回到 PLAN 重新提交计划。");
		const paths = attemptedPaths(name, args);
		if (paths.length === 0) return denyMessage("EXECUTE", `无法从 ${name} 的参数解析目标文件，已按 fail-closed 拒绝。`);
		for (const path of paths) {
			if (!contractAllows(contract, path, cwd)) {
				return denyMessage("EXECUTE", `路径 ${path} 不在批准契约内（${contract.files.join("、")}）。`);
			}
		}
		return undefined;
	}

	// RESEARCH / INNOVATE / PLAN / REVIEW are read-only.
	if (isWriteTool(name) || SCHEDULE_TOOLS.has(name)) {
		return denyMessage(mode, `工具 ${name} 属于写入类操作；写入需要先 /mode plan 提交计划并获批准。`);
	}
	if (isManagement) {
		return denyMessage(mode, `工具 ${name} 会修改 profile 或工作树，非 EXECUTE 模式不可用。`);
	}
	if (isTerminal && !TERMINAL_READ_TOOLS.has(name)) {
		return denyMessage(mode, `工具 ${name} 属于终端写操作，非 EXECUTE 模式不可用。`);
	}
	if (isMcp && !mcpAllowed) {
		return denyMessage(mode, `工具 ${name} 不在 mcpReadOnlyTools 白名单内，非 EXECUTE 模式不可用。`);
	}
	if (isShell) {
		if (args?.sandbox_permissions !== undefined) {
			return denyMessage(mode, `${name} 的 sandbox_permissions 提权参数在此模式被拒绝。`);
		}
		if (config.strictBash === true) return denyMessage(mode, "strictBash 已开启：非 EXECUTE 模式禁止 shell 命令。");
		return undefined;
	}
	if (name === "run_code") {
		if (typeof sandboxMode !== "string" || sandboxMode === "") {
			return denyMessage(mode, "无法解析当前沙箱，run_code 已按 fail-closed 拒绝。");
		}
		if (sandboxMode !== "read-only") {
			return denyMessage(mode, `当前沙箱为 ${sandboxMode}（非只读），run_code 被拒绝以防绕过只读闸。`);
		}
	}
	return undefined;
}
