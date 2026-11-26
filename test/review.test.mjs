import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_SCHEMA, buildReviewPrompt, normalizeReviewFindings, reviewerToolDenied } from "../lib/review.js";

test("review findings keep the required evidence and normalize optional fields", () => {
	const findings = normalizeReviewFindings({
		findings: [
			{ severity: "blocker", file: "a.ts", line: 7, evidence: "node --test", expected: "green" },
			{ severity: "info", evidence: "read a.ts:1" }
		]
	});
	assert.equal(findings.length, 2);
	assert.equal(findings[0].severity, "blocker");
	assert.equal(findings[0].file, "a.ts");
	assert.equal(findings[0].line, 7);
	assert.equal(findings[1].file, null);
	assert.equal(findings[1].line, null);
});

test("review findings reject missing evidence, bad severity, and oversized lists", () => {
	assert.throws(() => normalizeReviewFindings({ findings: [{ severity: "info" }] }), /evidence/u);
	assert.throws(() => normalizeReviewFindings({ findings: [{ severity: "fatal", evidence: "x" }] }), /severity/u);
	const tooMany = Array.from({ length: 201 }, () => ({ severity: "info", evidence: "x" }));
	assert.throws(() => normalizeReviewFindings({ findings: tooMany }), /200/u);
});

test("the reviewer prompt carries the plan as data and states the read-only rules", () => {
	const prompt = buildReviewPrompt({
		kind: "plan",
		planText: "# Plan\n\n1. change a file",
		planId: "p1",
		hash: "h",
		files: ["a.ts"],
		cwd: "D:\\Workspace\\Demo",
		focus: "check rollback"
	});
	assert.match(prompt, /独立审查员/u);
	assert.match(prompt, /只读/u);
	assert.match(prompt, /PLAN>>>/u);
	assert.match(prompt, /# Plan/u);
	assert.match(prompt, /a\.ts/u);
	assert.match(prompt, /check rollback/u);
});

test("reviewer tool denials cover delegation and review submission", () => {
	assert.match(reviewerToolDenied("subagent"), /不得调用/u);
	assert.match(reviewerToolDenied("propose_plan"), /不得调用/u);
	assert.match(reviewerToolDenied("submit_review"), /不得调用/u);
	assert.equal(reviewerToolDenied("read"), null);
	assert.equal(reviewerToolDenied("grep"), null);
});

test("the review schema is object-rooted and requires findings", () => {
	assert.equal(REVIEW_SCHEMA.type, "object");
	assert.deepEqual(REVIEW_SCHEMA.required, ["findings"]);
});
