import assert from "node:assert/strict";
import test from "node:test";
import { guardDecision } from "../lib/protocol.js";

const cwd = "D:\\Workspace\\Demo";
const contract = { files: ["src/app.ts"], hash: "h" };
const config = {
	shellTools: ["bash", "pwsh", "powershell", "shell"],
	mcpReadOnlyTools: ["mcp__search*"],
	denyTools: [],
	denyPrefixes: [],
	strictBash: false
};

function denied(input) {
	return typeof guardDecision({ cwd, config, ...input }) === "string";
}

test("read-only modes reject writes and allow plain shell", () => {
	assert.equal(denied({ mode: "RESEARCH", name: "write", args: { file_path: "a.ts" } }), true);
	assert.equal(denied({ mode: "PLAN", name: "edit", args: { file_path: "a.ts" } }), true);
	assert.equal(denied({ mode: "REVIEW", name: "apply_patch", args: { input: "*** Add File: a.ts" } }), true);
	assert.equal(denied({ mode: "RESEARCH", name: "bash", args: {} }), false);
	assert.equal(denied({ mode: "RESEARCH", name: "run_code", args: {}, sandboxMode: "read-only" }), false);
	assert.equal(denied({ mode: "RESEARCH", name: "run_code", args: {}, sandboxMode: "workspace-write" }), true);
});

test("shell escalation and strictBash cover pwsh as well as bash", () => {
	assert.equal(denied({ mode: "RESEARCH", name: "pwsh", args: { sandbox_permissions: "danger-full-access" } }), true);
	assert.equal(denied({ mode: "RESEARCH", name: "pwsh", args: { sandbox_permissions: "workspace-write" } }), true);
	assert.equal(denied({ mode: "RESEARCH", name: "pwsh", args: {} }), false);
	assert.equal(denied({ mode: "RESEARCH", name: "pwsh", args: {}, config: { ...config, strictBash: true } }), true);
	assert.equal(denied({ mode: "RESEARCH", name: "bash", args: {}, config: { ...config, strictBash: true } }), true);
});

test("terminal read tools stay available, terminal mutations do not", () => {
	assert.equal(denied({ mode: "PLAN", name: "terminal_list", args: {} }), false);
	assert.equal(denied({ mode: "PLAN", name: "terminal_read", args: {} }), false);
	assert.equal(denied({ mode: "PLAN", name: "terminal_send", args: {} }), true);
	assert.equal(denied({ mode: "PLAN", name: "terminal_signal", args: {} }), true);
	assert.equal(denied({ mode: "PLAN", name: "terminal_close", args: {} }), true);
});

test("MCP is denied by default and allowed only by the read-only whitelist", () => {
	assert.equal(denied({ mode: "PLAN", name: "mcp__search__web", args: {} }), false);
	assert.equal(denied({ mode: "PLAN", name: "mcp__write__file", args: {} }), true);
	assert.equal(denied({ mode: "PLAN", name: "mcp__search__web", args: {}, config: { ...config, mcpReadOnlyTools: [] } }), true);
});

test("plugin manager and worktree mutations are EXECUTE-only", () => {
	assert.equal(denied({ mode: "PLAN", name: "plugin_manager", args: { action: "list_plugins" } }), false);
	assert.equal(denied({ mode: "PLAN", name: "plugin_manager", args: { action: "set_plugin" } }), true);
	assert.equal(denied({ mode: "PLAN", name: "create_worktree", args: {} }), true);
	assert.equal(denied({ mode: "EXECUTE", name: "create_worktree", args: {}, planApproved: true, planId: "p1", contract }), false);
});

test("uninitialized sessions are fail-closed for mutation, command, and management tools", () => {
	assert.equal(denied({ mode: null, name: "read", args: { file_path: "a.ts" } }), false);
	assert.equal(denied({ mode: null, name: "write", args: { file_path: "a.ts" } }), true);
	assert.equal(denied({ mode: null, name: "bash", args: {} }), true);
	assert.equal(denied({ mode: null, name: "pwsh", args: {} }), true);
	assert.equal(denied({ mode: null, name: "terminal_list", args: {} }), true);
	assert.equal(denied({ mode: null, name: "mcp__search__web", args: {} }), true);
	assert.equal(denied({ mode: null, name: "plugin_manager", args: { action: "list_plugins" } }), true);
});

test("EXECUTE admits only contract files under an approved plan", () => {
	const base = { mode: "EXECUTE", planApproved: true, planId: "p1", contract };
	assert.equal(denied({ ...base, name: "write", args: { file_path: "src/app.ts" } }), false);
	assert.equal(denied({ ...base, name: "write", args: { file_path: "src/evil.ts" } }), true);
	assert.equal(denied({ ...base, name: "apply_patch", args: { input: "*** Update File: src/app.ts" } }), false);
	assert.equal(denied({ ...base, name: "apply_patch", args: { input: "*** Update File: src/evil.ts" } }), true);
	assert.equal(denied({ mode: "EXECUTE", name: "write", args: { file_path: "src/app.ts" } }), true);
	assert.equal(denied({ ...base, name: "bash", args: {} }), false);
	assert.equal(denied({ ...base, name: "terminal_send", args: {} }), false);
});

test("OFF leaves tools alone except the explicit deny lists", () => {
	assert.equal(denied({ mode: "OFF", name: "write", args: { file_path: "a.ts" } }), false);
	assert.equal(denied({ mode: "OFF", name: "bash", args: { sandbox_permissions: "danger-full-access" } }), false);
	assert.equal(denied({ mode: "OFF", name: "write", args: { file_path: "a.ts" }, config: { ...config, denyTools: ["write"] } }), true);
	assert.equal(denied({ mode: "OFF", name: "mcp__write__file", args: {}, config: { ...config, denyPrefixes: ["mcp__"] } }), true);
});

test("refusals name the real reason without the misleading prefix", () => {
	const verdict = guardDecision({ cwd, config, mode: "PLAN", name: "write", args: { file_path: "a.ts" } });
	assert.equal(typeof verdict, "string");
	assert.equal(verdict.includes("请先进入规划模式并获批准"), false);
	assert.equal(verdict.includes("属于写入类操作"), true);
	assert.equal(verdict.includes("/mode plan"), true);
});
