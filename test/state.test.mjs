import assert from "node:assert/strict";
import test from "node:test";
import {
	appendAudit,
	applyMode,
	applyNotice,
	applyPlan,
	applyPlanReview,
	applyReview,
	compactFindings,
	hasApprovedPlan,
	initialState,
	normalizeState
} from "../lib/state.js";

test("normalizeState is total and yields the full shape", () => {
	assert.deepEqual(normalizeState(undefined), initialState());
	assert.deepEqual(normalizeState(null), initialState());
	assert.deepEqual(normalizeState("garbage"), initialState());
	assert.equal(normalizeState({ mode: 7 }).mode, null);
});

test("a fresh mode transition records the mode and the pre-engagement sandbox", () => {
	const state = applyMode(initialState(), { mode: "RESEARCH", planId: null, planApproved: false, contract: null, sandboxBefore: "workspace-write" });
	assert.equal(state.mode, "RESEARCH");
	assert.equal(state.sandboxBefore, "workspace-write");
	assert.equal(hasApprovedPlan(state), false);
});

test("a submitted plan clears the approval and keeps the plan text", () => {
	const state = applyPlan(initialState(), { planId: "p1-123", hash: "abc", files: ["a.js"], text: "# plan" });
	assert.equal(state.planId, "p1-123");
	assert.equal(state.planApproved, false);
	assert.deepEqual(state.contract, { files: ["a.js"], hash: "abc" });
	assert.equal(state.planText, "# plan");
});

test("EXECUTE carries the approval, and REVIEW binds the executed plan", () => {
	let state = applyPlan(initialState(), { planId: "p1-123", hash: "abc", files: ["a.js"], text: "# plan" });
	state = applyMode(state, { mode: "EXECUTE", planId: "p1-123", planApproved: true, contract: { files: ["a.js"], hash: "abc" }, sandboxBefore: "workspace-write" });
	assert.equal(hasApprovedPlan(state), true);
	state = applyMode(state, { mode: "REVIEW", planId: null, planApproved: false, contract: null, sandboxBefore: "workspace-write" });
	assert.deepEqual(state.reviewOf, { planId: "p1-123", hash: "abc", files: ["a.js"] });
	assert.equal(hasApprovedPlan(state), false);
});

test("a review records the blockers and the reviewer", () => {
	const state = applyReview(applyMode(initialState(), { mode: "REVIEW" }), {
		conclusion: "实施偏离规划",
		blockers: 2,
		planId: "p1-123",
		hash: "abc",
		files: ["a.js"],
		reviewer: { agentId: "agent-9", provider: "spawn", model: "m" }
	});
	assert.equal(state.blockers, 2);
	assert.equal(state.reviewer.agentId, "agent-9");
	assert.deepEqual(state.reviewOf.files, ["a.js"]);
});

test("OFF drops the sandbox snapshot and the plan text but keeps the last review", () => {
	const reviewed = applyReview(initialState(), { blockers: 2, conclusion: "实施偏离规划", planId: "p1", hash: "h", files: ["a.js"], reviewer: null });
	const off = applyMode({ ...reviewed, planText: "# plan", sandboxBefore: "workspace-write" }, { mode: "OFF", planId: null, planApproved: false, contract: null, sandboxBefore: null });
	assert.equal(off.mode, "OFF");
	assert.equal(off.sandboxBefore, null);
	assert.equal(off.planText, null);
	assert.equal(off.blockers, 2);
});

test("the audit trail is bounded", () => {
	let state = initialState();
	for (let index = 0; index < 25; index += 1) state = appendAudit(state, { kind: "approval", index });
	assert.equal(state.audit.length, 20);
	assert.equal(state.audit.at(-1).index, 24);
	assert.ok(Number.isSafeInteger(state.audit.at(-1).at));
});

test("a stored record round-trips through the record schema", () => {
	const state = applyReview(applyPlan(initialState(), { planId: "p1", hash: "h", files: ["a.js"], text: "# plan" }), { blockers: 1, conclusion: "实施偏离规划", planId: "p1", hash: "h", files: ["a.js"], reviewer: { agentId: "a", provider: "spawn", model: null } });
	assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(state))), state);
});

test("a damaged record degrades to a usable state instead of throwing", () => {
	const damaged = normalizeState({ mode: "EXECUTE", planId: 5, planApproved: "yes", contract: { files: "x" }, blockers: -1, reviewer: {} });
	assert.equal(damaged.mode, "EXECUTE");
	assert.equal(damaged.planId, null);
	assert.equal(damaged.planApproved, false);
	assert.equal(damaged.contract, null);
	assert.equal(damaged.blockers, 0);
	assert.equal(damaged.reviewer, null);
	assert.equal(hasApprovedPlan(damaged), false);
});

test("entering PLAN starts a fresh engagement counter", () => {
	const executing = applyMode(initialState(), { mode: "EXECUTE", planId: "p1", planApproved: true, contract: { files: ["a.js"], hash: "h" }, sandboxBefore: "workspace-write" });
	const planning = applyMode(executing, { mode: "PLAN", planId: null, planApproved: false, contract: null });
	assert.equal(planning.planSubmissions, 0);
	assert.equal(hasApprovedPlan(planning), false);
});

test("applyPlan increments the engagement counter", () => {
	const first = applyPlan(initialState(), { planId: "p1-123", hash: "abc", files: ["a.js"], text: "# plan" });
	assert.equal(first.planSubmissions, 1);
	const second = applyPlan(first, { planId: "p2-456", hash: "def", files: ["b.js"], text: "# plan 2" });
	assert.equal(second.planSubmissions, 2);
});

test("a non-EXECUTE transition clears the approval", () => {
	const executing = applyMode(initialState(), { mode: "EXECUTE", planId: "p1", planApproved: true, contract: { files: ["a.js"], hash: "h" } });
	const planning = applyMode(executing, { mode: "PLAN", planId: null, planApproved: false, contract: null });
	assert.equal(planning.planId, null);
	assert.equal(planning.planApproved, false);
	assert.equal(planning.contract, null);
	assert.equal(hasApprovedPlan(planning), false);
});

test("plan reviews keep bounded findings and a compact audit entry", () => {
	const findings = [
		{ severity: "blocker", file: "a.js", line: 3, evidence: "node --test" },
		{ severity: "info", file: "b.js", evidence: "read b.js:1" }
	];
	const state = applyPlanReview(initialState(), { hash: "h", findings, blockers: 1, reviewer: { agentId: "a", provider: "spawn", model: "m" }, accepted: false });
	assert.equal(state.lastReviewKind, "plan");
	assert.equal(state.blockers, 1);
	assert.equal(state.lastFindings.length, 2);
	assert.equal(state.lastFindings[0].severity, "blocker");
	assert.equal(state.audit.at(-1).kind, "plan-review");
	assert.equal(state.audit.at(-1).findings, undefined);
});

test("implementation reviews replace findings and append a review audit entry", () => {
	const state = applyReview(initialState(), {
		conclusion: "实施偏离规划",
		blockers: 1,
		planId: "p1",
		hash: "h",
		files: ["a.js"],
		findings: [{ severity: "blocker", file: "a.js", line: 1, evidence: "test" }],
		reviewer: { agentId: "r", provider: "spawn", model: null }
	});
	assert.equal(state.lastReviewKind, "implementation");
	assert.equal(state.lastFindings.length, 1);
	assert.equal(state.audit.at(-1).kind, "review");
});

test("notices are stored, survive a mode change, and clear on a new plan or OFF", () => {
	const noticed = applyNotice(initialState(), { text: "上一条消息已被消费" });
	assert.equal(noticed.notice, "上一条消息已被消费");
	const modeChanged = applyMode(noticed, { mode: "RESEARCH" });
	assert.equal(modeChanged.notice, "上一条消息已被消费");
	const planned = applyPlan(modeChanged, { planId: "p1", hash: "h", files: ["a.js"], text: "# plan" });
	assert.equal(planned.notice, null);
	const off = applyMode(noticed, { mode: "OFF" });
	assert.equal(off.notice, null);
});

test("compactFindings caps the list, keeps blockers first, and truncates evidence", () => {
	const findings = Array.from({ length: 25 }, (_, index) => ({ severity: index === 24 ? "blocker" : "info", file: `f${index}.js`, evidence: "x".repeat(600) }));
	const compact = compactFindings(findings);
	assert.equal(compact.length, 20);
	assert.equal(compact[0].severity, "blocker");
	assert.equal(compact[0].evidence.length, 500);
});

test("normalizeState keeps planSubmissions and the notice", () => {
	const state = applyNotice(applyPlan(initialState(), { planId: "p1-123", hash: "abc", files: ["a.js"], text: "# plan" }), { text: "hint" });
	const restored = normalizeState(JSON.parse(JSON.stringify(state)));
	assert.deepEqual(restored, state);
	assert.equal(restored.planSubmissions, 1);
});


test("legacy records carrying approvedAt normalize without any clock", () => {
	const normalized = normalizeState({ mode: "EXECUTE", planApproved: true, planId: "p1", contract: { files: ["a.js"], hash: "h" }, approvedAt: 1 });
	assert.equal("approvedAt" in normalized, false);
	assert.equal(hasApprovedPlan(normalized), true);
});