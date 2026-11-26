#!/usr/bin/env node
/**
 * Repair DSH JSONL session logs poisoned by dsh-riper5 ≤ 0.2.0.
 *
 * Those versions appended `riper/*` session events. DSH's reader refuses a
 * whole session when it meets an event type it does not know, unless the
 * event's envelope carries `ignorable: true` — and `Session.append()` has no
 * way to set that marker. The log therefore has to be repaired out of band.
 *
 * This tool marks every event whose type matches `--prefixes` (default
 * `riper/`) as ignorable, so the reader retains-and-skips it. Nothing else is
 * touched:
 *
 *   - the log is a concatenation of independent Zstandard frames;
 *   - only frames containing a matching event are re-compressed, every other
 *     frame is copied byte for byte;
 *   - the rebuilt log is verified (frame count, header, seq contiguity) before
 *     the original is replaced;
 *   - the original is copied aside first, and the replacement is atomic.
 *
 * Usage:
 *   node repair-session-log.mjs <log> [--apply] [--prefixes riper/,other/]
 *   node repair-session-log.mjs --scan [<root>]
 *
 * `--scan` (default root: ~/.dsh/sessions) only reports which logs carry
 * non-ignorable foreign events; it writes nothing.
 *
 * Node ≥ 24 is required for the built-in Zstandard API.
 */
import { closeSync, copyFileSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const FRAME_MAGIC = 0xfd2fb528;
const CHECKSUM_PARAM = zlibConstants.ZSTD_c_checksumFlag;
const ENVELOPE_KEYS = new Set(["type", "seq", "time", "data", "sourceEventSeqs", "surfaceOp", "ignorable"]);

/**
 * Read the byte length of the Zstandard frame starting at `start`.
 *
 * @param {Buffer} buffer - Frame container.
 * @param {number} start - Frame offset.
 * @returns {{end: number, checksum: boolean}} Frame end offset and checksum flag.
 */
function frameBounds(buffer, start) {
	if (start + 4 > buffer.length) throw new Error(`truncated frame magic at ${start}`);
	const magic = buffer.readUInt32LE(start);
	if (magic !== FRAME_MAGIC) throw new Error(`no zstd frame magic at ${start} (0x${magic.toString(16)})`);
	let pos = start + 4;
	const descriptor = buffer[pos];
	pos += 1;
	const fcsFlag = descriptor >> 6;
	const singleSegment = ((descriptor >> 5) & 1) === 1;
	const checksum = ((descriptor >> 2) & 1) === 1;
	const dictionaryFlag = descriptor & 3;
	if (!singleSegment) pos += 1;
	pos += [0, 1, 2, 4][dictionaryFlag];
	pos += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
	for (;;) {
		if (pos + 3 > buffer.length) throw new Error(`truncated block header at ${pos}`);
		const header = buffer[pos] | (buffer[pos + 1] << 8) | (buffer[pos + 2] << 16);
		pos += 3;
		const last = (header & 1) === 1;
		const type = (header >> 1) & 3;
		const size = header >> 3;
		if (type === 3) throw new Error(`reserved block type at ${pos - 3}`);
		pos += type === 1 ? 1 : size;
		if (last) break;
	}
	if (checksum) pos += 4;
	if (pos > buffer.length) throw new Error(`truncated frame at ${start}`);
	return { end: pos, checksum };
}

/** @returns {{start: number, end: number, checksum: boolean}[]} Every frame. */
function splitFrames(buffer) {
	const frames = [];
	let pos = 0;
	while (pos < buffer.length) {
		const bounds = frameBounds(buffer, pos);
		frames.push({ start: pos, ...bounds });
		pos = bounds.end;
	}
	return frames;
}

/** @returns {string} One frame's decoded JSONL text. */
function decodeFrame(buffer, frame) {
	const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8");
	if (text !== "" && !text.endsWith("\n")) throw new Error(`frame at ${frame.start} does not end with a newline`);
	return text;
}

/**
 * Mark one frame's matching events ignorable.
 *
 * @param {string} text - Decoded frame text.
 * @param {string[]} prefixes - Event-type prefixes to mark.
 * @returns {{fixed: number, text: string}} Fixed count and rewritten text.
 */
function repairFrame(text, prefixes) {
	const rows = [];
	let fixed = 0;
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const row = JSON.parse(line);
		const foreign = row !== null && typeof row === "object" && typeof row.type === "string"
			&& prefixes.some((prefix) => row.type.startsWith(prefix));
		if (foreign && row.ignorable !== true) {
			rows.push(JSON.stringify({ ...row, ignorable: true }));
			fixed += 1;
			continue;
		}
		rows.push(line);
	}
	return { fixed, text: rows.length === 0 ? "" : `${rows.join("\n")}\n` };
}

/**
 * Verify a rebuilt log: same frame count, one session header, contiguous seq.
 *
 * @param {Buffer} buffer - Rebuilt container.
 * @param {number} frameCount - Expected frame count.
 * @returns {number} Event count.
 */
function verify(buffer, frameCount) {
	const frames = splitFrames(buffer);
	if (frames.length !== frameCount) throw new Error(`frame count changed: ${frameCount} -> ${frames.length}`);
	let seq = 0;
	let header = null;
	for (const frame of frames) {
		for (const line of decodeFrame(buffer, frame).split("\n")) {
			if (line === "") continue;
			const row = JSON.parse(line);
			if (header === null) {
				if (row.type !== "session") throw new Error("first row is not the session header");
				header = row;
				continue;
			}
			if (row.seq !== seq) throw new Error(`seq gap: expected ${seq}, got ${row.seq}`);
			for (const key of Object.keys(row)) {
				if (typeof row.type === "string" && !ENVELOPE_KEYS.has(key)) throw new Error(`seq ${seq}: unexpected envelope key "${key}"`);
			}
			seq += 1;
		}
	}
	if (header === null) throw new Error("log has no session header");
	return seq;
}

/** Repair one log file. @returns {boolean} Whether the file needed a repair. */
function repairFile(file, prefixes, apply) {
	const buffer = readFileSync(file);
	const frames = splitFrames(buffer);
	const chunks = [];
	let changedFrames = 0;
	let fixed = 0;
	frames.forEach((frame, index) => {
		const repaired = repairFrame(decodeFrame(buffer, frame), prefixes);
		if (repaired.fixed === 0) {
			chunks.push(buffer.subarray(frame.start, frame.end));
			return;
		}
		if (index === 0) throw new Error("the header frame must never be polluted");
		changedFrames += 1;
		fixed += repaired.fixed;
		chunks.push(zstdCompressSync(Buffer.from(repaired.text, "utf8"), { params: { [CHECKSUM_PARAM]: 1 } }));
	});
	if (fixed === 0) {
		process.stdout.write(`${file}\n  clean (${frames.length} frames)\n`);
		return false;
	}
	const rebuilt = Buffer.concat(chunks);
	const events = verify(rebuilt, frames.length);
	process.stdout.write(`${file}\n  frames=${frames.length} changed=${changedFrames} marked=${fixed} events=${events} bytes ${buffer.length} -> ${rebuilt.length}\n`);
	if (!apply) {
		process.stdout.write("  dry run: pass --apply to write\n");
		return true;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backup = `${file}.riper-backup-${stamp}`;
	copyFileSync(file, backup);
	const temp = `${file}.riper-tmp`;
	const handle = openSync(temp, "w");
	try {
		writeSync(handle, rebuilt);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	try {
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	process.stdout.write(`  backup: ${backup}\n  repaired: ${file}\n`);
	return true;
}

/** Walk a sessions root and report or repair every affected log. */
function scanRoot(root, prefixes, apply) {
	let logs = 0;
	let affected = 0;
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/^session(\.[^.]+)?\.jsonl(\.zstd)?$/.test(entry.name)) {
				logs += 1;
				try {
					if (repairFile(full, prefixes, apply)) affected += 1;
				} catch (error) {
					process.stdout.write(`${full}\n  FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
				}
			}
		}
	};
	walk(root);
	process.stdout.write(`\nscanned ${logs} logs, affected ${affected}\n`);
}

function main() {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const prefixIndex = args.indexOf("--prefixes");
	const prefixes = prefixIndex >= 0 ? String(args[prefixIndex + 1] ?? "riper/").split(",").filter(Boolean) : ["riper/"];
	const positional = args.filter((arg, index) => !arg.startsWith("--") && index !== prefixIndex + 1);
	if (args.includes("--scan") || positional.length === 0) {
		const root = args[args.indexOf("--scan") + 1];
		scanRoot(root !== undefined && !root.startsWith("--") ? root : join(homedir(), ".dsh", "sessions"), prefixes, apply);
		return;
	}
	for (const file of positional) repairFile(file, prefixes, apply);
}

main();
