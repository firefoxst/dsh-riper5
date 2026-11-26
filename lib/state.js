/**
 * RIPER-5 session state: plugin-owned, not log-derived.
 *
 * Why the state does not live in the session log: a stored event whose type a
 * reader does not know makes the whole session unreadable unless its envelope
 * carries `ignorable: true`, and live `Session.append()` cannot set that
 * marker. A plugin event type is therefore never safe to append — the session
 * would refuse to reopen ("contains event type ... unknown to this harness").
 * The plugin keeps one plain-JSON record per session in the Harness storage
 * domain instead: synchronous reads from memory, durable writes, no session
 * event vocabulary.
 *
 * @module dsh-riper5/state
 */

import { MODES, SEVERITIES } from "./protocol.js";

/** Fresh, never-initialized state: a session that has not engaged RIPER-5. */
export function initialState() {
	return {
		mode: null,
		planId: null,
		planApproved: false,
		contract: null,
		sandboxBefore: null,
		blockers: 0,
		conclusion: null,
		reviewOf: null,
		planText: null,
		reviewer: null,
		/** How many plans were submitted in the current PLAN engagement. */
		planSubmissions: 0,
		/** Bounded copy of the most recent review findings, safe to show in prompts. */
		lastFindings: [],
		/** "plan" | "implementation" | null for the most recent review. */
		lastReviewKind: null,
		/** One user-visible hint, cleared by the next plan/review/OFF. */
		notice: null,
		/** Epoch milliseconds of the last durable write, for diagnostics. */
		updatedAt: null,
		/** Bounded audit trail of the records that used to be session events. */
		audit: []
	};
}

/** Largest audit trail kept per session (most recent last). */
export const AUDIT_LIMIT = 20;
/** Largest findings list kept in the state record and prompt. */
export const FINDINGS_LIMIT = 20;
/** Largest evidence string kept in a compact finding. */
export const EVIDENCE_LIMIT = 500;

/** @returns {object|null} A contract `{files, hash}`, or null when unusable. */
function normalizeContract(value) {
	if (value === null || typeof value !== "object" || !Array.isArray(value.files)) return null;
	return { files: value.files.filter((file) => typeof file === "string"), hash: String(value.hash ?? "") };
}

/** @returns {object|null} A `{planId, hash, files}` review binding, or null. */
function normalizeReviewOf(value) {
	if (value === null || typeof value !== "object" || typeof value.planId !== "string") return null;
	return {
		planId: value.planId,
		hash: typeof value.hash === "string" ? value.hash : null,
		files: Array.isArray(value.files) ? value.files.filter((file) => typeof file === "string") : []
	};
}

/** @returns {object|null} A `{agentId, provider, model}` reviewer, or null. */
function normalizeReviewer(value) {
	if (value === null || typeof value !== "object" || typeof value.agentId !== "string") return null;
	return {
		agentId: value.agentId,
		provider: typeof value.provider === "string" ? value.provider : "unknown",
		model: typeof value.model === "string" ? value.model : null
	};
}

/**
 * Keep only the fields a prompt or audit needs, blockers first, with a hard
 * bound so a verbose reviewer cannot bloat the state record.
 *
 * @param {unknown} value - Raw findings array.
 * @returns {{severity: string, file: string|null, line: number|null, evidence: string, expected: string|null}[]}
 */
export function compactFindings(value) {
	if (!Array.isArray(value)) return [];
	const findings = value
		.filter((finding) => finding !== null && typeof finding === "object" && !Array.isArray(finding))
		.map((finding) => {
			const severity = SEVERITIES.includes(finding.severity) ? finding.severity : "info";
			const evidence = typeof finding.evidence === "string" ? finding.evidence.trim().slice(0, EVIDENCE_LIMIT) : "";
			return {
				severity,
				file: typeof finding.file === "string" && finding.file.trim() !== "" ? finding.file.trim() : null,
				line: Number.isSafeInteger(finding.line) ? finding.line : null,
				evidence,
				expected: typeof finding.expected === "string" && finding.expected.trim() !== "" ? finding.expected.trim() : null
			};
		});
	findings.sort((left, right) => (left.severity === "blocker" ? 0 : 1) - (right.severity === "blocker" ? 0 : 1));
	return findings.slice(0, FINDINGS_LIMIT);
}

/**
 * Coerce one stored record into a complete, shape-stable state. Used as the
 * storage domain's record schema: it never throws, so one damaged record can
 * never make the whole domain unreadable.
 *
 * @param {unknown} value - Stored record.
 * @returns {ReturnType<typeof initialState>} Normalized state.
 */
export function normalizeState(value) {
	const state = initialState();
	if (value === null || typeof value !== "object" || Array.isArray(value)) return state;
	state.mode = typeof value.mode === "string" && MODES.includes(value.mode) ? value.mode : null;
	state.planId = typeof value.planId === "string" ? value.planId : null;
	state.planApproved = value.planApproved === true;
	state.contract = normalizeContract(value.contract);
	state.sandboxBefore = typeof value.sandboxBefore === "string" ? value.sandboxBefore : null;
	state.blockers = Number.isSafeInteger(value.blockers) && value.blockers >= 0 ? value.blockers : 0;
	state.conclusion = typeof value.conclusion === "string" ? value.conclusion : null;
	state.reviewOf = normalizeReviewOf(value.reviewOf);
	state.planText = typeof value.planText === "string" ? value.planText : null;
	state.reviewer = normalizeReviewer(value.reviewer);
	state.planSubmissions = Number.isSafeInteger(value.planSubmissions) && value.planSubmissions >= 0 ? value.planSubmissions : 0;
	state.lastFindings = compactFindings(value.lastFindings);
	state.lastReviewKind = value.lastReviewKind === "plan" || value.lastReviewKind === "implementation" ? value.lastReviewKind : null;
	state.notice = typeof value.notice === "string" && value.notice.trim() !== "" ? value.notice : null;
	state.updatedAt = Number.isSafeInteger(value.updatedAt) && value.updatedAt > 0 ? value.updatedAt : null;
	state.audit = Array.isArray(value.audit)
		? value.audit.filter((entry) => entry !== null && typeof entry === "object").slice(-AUDIT_LIMIT)
		: [];
	return state;
}

/** Storage-domain record schema: the domain only needs `parse`. */
export const stateRecordSchema = { parse: normalizeState };

/**
 * Fold one committed mode transition into a new state.
 *
 * @param {ReturnType<typeof initialState>} state - Current state.
 * @param {Record<string, unknown>} data - Transition payload.
 * @returns {ReturnType<typeof initialState>} Next state.
 */
export function applyMode(state, data) {
	const mode = typeof data.mode === "string" ? data.mode : state.mode;
	return {
		...state,
		mode,
		planId: typeof data.planId === "string" ? data.planId : null,
		planApproved: data.planApproved === true,
		contract: data.contract ?? null,
		// OFF ends an engagement: drop the snapshot so the next engagement
		// captures the sandbox as it is then. Other transitions keep it.
		sandboxBefore: mode === "OFF"
			? null
			: typeof data.sandboxBefore === "string" ? data.sandboxBefore : state.sandboxBefore,
		// Entering PLAN from another mode starts a new plan engagement.
		planSubmissions: mode === "PLAN" && state.mode !== "PLAN" ? 0 : state.planSubmissions,
		// Entering REVIEW from EXECUTE binds the report to the plan that was
		// just executed, even though the mode change clears the live approval.
		reviewOf: mode === "REVIEW" && state.mode === "EXECUTE" && typeof state.planId === "string"
			? {
				planId: state.planId,
				hash: state.contract?.hash ?? null,
				files: Array.isArray(state.contract?.files) ? [...state.contract.files] : []
			}
			: state.reviewOf,
		// A mode transition starts a new gate; the reviewer identity and the
		// last plan text belong to the previous gate. OFF also drops the text.
		reviewer: null,
		planText: mode === "OFF" ? null : state.planText,
		notice: mode === "OFF" ? null : state.notice,
		lastFindings: mode === "OFF" ? [] : state.lastFindings,
		lastReviewKind: mode === "OFF" ? null : state.lastReviewKind
		// `blockers` and `conclusion` survive a mode change: they describe
		// the last review until the next plan supersedes it.
	};
}

/**
 * Fold one submitted plan into a new state.
 *
 * @param {ReturnType<typeof initialState>} state - Current state.
 * @param {Record<string, unknown>} data - Plan payload.
 * @returns {ReturnType<typeof initialState>} Next state.
 */
export function applyPlan(state, data) {
	return {
		...state,
		planId: typeof data.planId === "string" ? data.planId : null,
		planApproved: false,
		contract: Array.isArray(data.files) ? { files: [...data.files], hash: String(data.hash ?? "") } : null,
		blockers: 0,
		conclusion: null,
		reviewOf: null,
		planText: typeof data.text === "string" ? data.text : null,
		reviewer: null,
		planSubmissions: (Number.isSafeInteger(state.planSubmissions) ? state.planSubmissions : 0) + 1,
		lastFindings: [],
		lastReviewKind: null,
		notice: null
	};
}

/**
 * Fold one plan-review verdict into a new state and the audit trail.
 *
 * @param {ReturnType<typeof initialState>} state - Current state.
 * @param {Record<string, unknown>} data - Review payload.
 * @returns {ReturnType<typeof initialState>} Next state.
 */
export function applyPlanReview(state, data) {
	const findings = compactFindings(data.findings);
	const blockers = Number.isSafeInteger(data.blockers) ? data.blockers : findings.filter((finding) => finding.severity === "blocker").length;
	const next = {
		...state,
		blockers,
		lastFindings: findings,
		lastReviewKind: "plan",
		reviewer: normalizeReviewer(data.reviewer)
	};
	return appendAudit(next, {
		kind: "plan-review",
		hash: typeof data.hash === "string" ? data.hash : null,
		blockers,
		accepted: data.accepted === true,
		reviewer: normalizeReviewer(data.reviewer)
	});
}

/**
 * Fold one implementation review into a new state and the audit trail.
 *
 * @param {ReturnType<typeof initialState>} state - Current state.
 * @param {Record<string, unknown>} data - Review payload.
 * @returns {ReturnType<typeof initialState>} Next state.
 */
export function applyReview(state, data) {
	const findings = compactFindings(data.findings);
	const next = {
		...state,
		blockers: Number.isSafeInteger(data.blockers) ? data.blockers : findings.filter((finding) => finding.severity === "blocker").length,
		conclusion: typeof data.conclusion === "string" ? data.conclusion : null,
		reviewOf: typeof data.planId === "string"
			? {
				planId: data.planId,
				hash: typeof data.hash === "string" ? data.hash : null,
				files: Array.isArray(data.files) ? [...data.files] : state.reviewOf?.files ?? []
			}
			: state.reviewOf,
		reviewer: normalizeReviewer(data.reviewer),
		lastFindings: findings,
		lastReviewKind: "implementation"
	};
	return appendAudit(next, {
		kind: "review",
		planId: typeof data.planId === "string" ? data.planId : null,
		blockers: next.blockers,
		conclusion: next.conclusion,
		reviewer: next.reviewer
	});
}

/**
 * Store or clear the one user-visible notice.
 *
 * @param {ReturnType<typeof initialState>} state - Current state.
 * @param {Record<string, unknown> | null} value - `{text}` or null.
 * @returns {ReturnType<typeof initialState>} Next state.
 */
export function applyNotice(state, value) {
	const text = value !== null && typeof value === "object" && typeof value.text === "string" ? value.text.trim() : "";
	return { ...state, notice: text === "" ? null : text };
}

/**
 * Append one audit entry, keeping the trail bounded.
 *
 * @param {ReturnType<typeof initialState>} state - Current state.
 * @param {Record<string, unknown>} entry - Audit entry.
 * @returns {ReturnType<typeof initialState>} Next state.
 */
export function appendAudit(state, entry) {
	const audit = [...state.audit, { ...entry, at: Date.now() }].slice(-AUDIT_LIMIT);
	return { ...state, audit };
}

/**
 * Whether a committed state still carries a usable approval.
 *
 * @param {ReturnType<typeof initialState>} state - Folded state.
 * @returns {boolean} True when planId, approval, and contract are all present.
 */
export function hasApprovedPlan(state) {
	return state.mode === "EXECUTE" && state.planApproved === true && typeof state.planId === "string" && state.contract !== null && Array.isArray(state.contract.files);
}

/** Every selectable mode token, re-exported for the record normalizer's callers. */
export const SELECTABLE_MODES = new Set(MODES);
