import assert from "node:assert/strict";
import test from "node:test";
const cwd = "D:\\Workspace\\Demo";

import {
	contractAllows,
	createPlanId,
	parseFileTokens,
	resolveModePhrase,
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

test("a verification section written as a fenced command block still counts", () => {
	const text = plan([
		"# Fix the plugin",
		"## 目标",
		"Keep the plan valid.",
		"## 步骤",
		"1. do the work",
		"## 验证方式",
		fence + "bash",
		"node --test",
		fence,
		"[更改规划]",
		"- 文件：a.ts"
	]);
	assert.deepEqual(validatePlan(text).files, ["a.ts"]);
});

test("a change block does not lend content to an empty goal section", () => {
	const text = plan([
		"# Fix the plugin",
		"## 目标",
		"[更改规划]",
		"- 文件：a.ts",
		"## 步骤",
		"1. do the work",
		"## 验证方式",
		"node --test"
	]);
	assert.throws(() => validatePlan(text), /## 目标/u);
});

test("steps restarting at 1 are rejected", () => {
	const text = plan([
		"# Plan",
		"## 目标",
		"goal",
		"## 步骤",
		"1. first",
		"2. second",
		"1. restarted",
		"## 验证方式",
		"check",
		"[更改规划]",
		"- 文件：a.ts"
	]);
	assert.throws(() => validatePlan(text), /连续/u);
});

test("an indented sub-list is not counted as a top-level step", () => {
	const text = plan([
		"# Plan",
		"## 目标",
		"goal",
		"## 步骤",
		"1. install the dependency",
		"   1. run the installer",
		"   2. confirm the version",
		"2. run the tests",
		"## 验证方式",
		"check",
		"[更改规划]",
		"- 文件：a.ts"
	]);
	assert.deepEqual(validatePlan(text).files, ["a.ts"]);
});

test("the change marker may be written as a heading", () => {
	const text = plan([
		"# Plan",
		"## 目标",
		"goal",
		"## 步骤",
		"1. do the work",
		"## 验证方式",
		"check",
		"## [更改规划]",
		"- 文件：a.ts"
	]);
	assert.deepEqual(validatePlan(text).files, ["a.ts"]);
});

test("the change marker may end with a colon", () => {
	const text = plan([
		"# Plan",
		"## 目标",
		"goal",
		"## 步骤",
		"1. do the work",
		"## 验证方式",
		"check",
		"[更改规划]：",
		"- 文件：a.ts"
	]);
	assert.deepEqual(validatePlan(text).files, ["a.ts"]);
});

test("an inline annotation is stripped from a file token", () => {
	assert.deepEqual(parseFileTokens("src/a.ts（新建）、src/b.ts"), ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(parseFileTokens("src/a.ts (generated)"), ["src/a.ts"]);
});

test("a file line before the first heading is still rejected", () => {
	const text = plan([
		"# Plan",
		"- 文件：a.ts",
		"## 目标",
		"goal",
		"## 步骤",
		"1. do the work",
		"## 验证方式",
		"check",
		"[更改规划]",
		"- 文件：b.ts"
	]);
	assert.throws(() => validatePlan(text), /更改规划/u);
});

test("the plan sentence advances to PLAN", () => {
	assert.equal(resolveModePhrase("进入规划模式"), "PLAN");
});

test("the execute and review sentences advance to their modes", () => {
	assert.equal(resolveModePhrase("进入执行模式"), "EXECUTE");
	assert.equal(resolveModePhrase("进入审查模式"), "REVIEW");
});

test("trailing punctuation and surrounding whitespace still match", () => {
	assert.equal(resolveModePhrase("  进入规划模式。 "), "PLAN");
	assert.equal(resolveModePhrase("进入执行模式！"), "EXECUTE");
	assert.equal(resolveModePhrase("进入审查模式."), "REVIEW");
});

test("a negation or extra words keep the sentence a normal request", () => {
	assert.equal(resolveModePhrase("不要进入执行模式"), null);
	assert.equal(resolveModePhrase("我想进入规划模式看看"), null);
	assert.equal(resolveModePhrase("进入规划模式后呢？"), null);
});

test("an empty or unknown sentence resolves to no mode", () => {
	assert.equal(resolveModePhrase(""), null);
	assert.equal(resolveModePhrase("   "), null);
	assert.equal(resolveModePhrase(null), null);
	assert.equal(resolveModePhrase("继续"), null);
});
