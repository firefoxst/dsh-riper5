import assert from "node:assert/strict";
import test from "node:test";
const cwd = "D:\\Workspace\\Demo";

import {
	contractAllows,
	createPlanId,
	parseFileTokens,
	validatePlan,
	withinRoot
} from "../lib/protocol.js";

const fence = String.fromCharCode(96).repeat(3);

function plan(lines) {
	return lines.join("\n");
}

test("a plan with the required sections yields its contract and steps", () => {
	const text = plan([
		"# Fix the plugin",
		"## 目标",
		"Make the gate predictable.",
		"## 步骤",
		"1. change protocol.js",
		"2. run tests",
		"## 验证方式",
		"node --test",
		"[更改规划]",
		"- 文件：lib/protocol.js"
	]);
	const result = validatePlan(text);
	assert.deepEqual(result.files, ["lib/protocol.js"]);
	assert.match(result.hash, /^[0-9a-f]{64}$/);
});

test("fenced examples do not become contract files or steps", () => {
	const text = plan([
		"# Fix the plugin",
		"## 目标",
		"Keep examples out of the contract.",
		"## 步骤",
		"1. do the work",
		fence + "text",
		"- 文件：evil.ts",
		"1. fake step",
		fence,
		"2. verify",
		"## 验证方式",
		"node --test",
		"[更改规划]",
		"- 文件：a.ts"
	]);
	const result = validatePlan(text);
	assert.deepEqual(result.files, ["a.ts"]);
});

test("a file line outside the change block is rejected", () => {
	const text = plan([
		"# Fix the plugin",
		"## 目标",
		"Reject misplaced file lines.",
		"## 步骤",
		"1. do the work",
		"## 验证方式",
		"- 文件：b.ts",
		"[更改规划]",
		"- 文件：a.ts"
	]);
	assert.throws(() => validatePlan(text), /\[更改规划\]/u);
});

test("missing goal, steps, or verification sections are rejected", () => {
	const base = ["# Plan", "## 步骤", "1. do", "## 验证方式", "check", "[更改规划]", "- 文件：a.ts"];
	assert.throws(() => validatePlan(base.join("\n")), /## 目标/u);
	const noSteps = ["# Plan", "## 目标", "goal", "## 验证方式", "check", "[更改规划]", "- 文件：a.ts"];
	assert.throws(() => validatePlan(noSteps.join("\n")), /## 步骤/u);
	const noVerify = ["# Plan", "## 目标", "goal", "## 步骤", "1. do", "[更改规划]", "- 文件：a.ts"];
	assert.throws(() => validatePlan(noVerify.join("\n")), /## 验证方式/u);
});

test("backticked and plain file tokens are both kept", () => {
	assert.deepEqual(parseFileTokens("`a.ts`、b.ts"), ["a.ts", "b.ts"]);
	assert.deepEqual(parseFileTokens("a.ts、b.ts"), ["a.ts", "b.ts"]);
	assert.deepEqual(parseFileTokens("`a.ts`"), ["a.ts"]);
});

test("withinRoot keeps contract warnings inside the workspace", () => {
	assert.equal(withinRoot("src/app.ts", cwd, cwd), true);
	assert.equal(withinRoot(`${cwd}\\src\\app.ts`, cwd, cwd), true);
	assert.equal(withinRoot("D:\\Other\\app.ts", cwd, cwd), false);
	assert.equal(withinRoot(`${cwd}\\..\\src`, cwd, cwd), false);
	assert.equal(withinRoot(`${cwd.toUpperCase()}\\src\\app.ts`, cwd, cwd), process.platform === "win32");
});

test("createPlanId keeps the plan id shape and its minting time", () => {
	const now = Date.UTC(2026, 0, 1);
	const hash = "0123456789abcdef".repeat(4);
	assert.match(createPlanId(hash, now), /^riper-[0-9a-f]{12}-[0-9a-z]+$/u);
	assert.equal(createPlanId(hash, now), `riper-0123456789ab-${now.toString(36)}`);
});

test("contract matching folds case on Windows", () => {
	const cwd = "D:\\Workspace\\Demo";
	const allowed = contractAllows({ files: ["src/app.ts"] }, "SRC/App.ts", cwd);
	assert.equal(allowed, process.platform === "win32");
	assert.equal(contractAllows({ files: ["src/app.ts"] }, "src/other.ts", cwd), false);
});
