import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DAY_MS,
	archiveRecord,
	dedupeRecords,
	extractUserText,
	readSessionEdges,
	computeExpiresAt,
	dueForDeletion,
	emptyState,
	isInsideSessionsRoot,
	isSessionFile,
	loadState,
	markDeleted,
	markExpired,
	normalizeDays,
	publicRecords,
	purgeStaleRecords,
	restoreRecord,
	saveState,
	setRetention,
} from "../index.mjs";

const ROOT = process.platform === "win32" ? "C:\\Users\\u\\.pi\\agent\\sessions" : "/home/u/.pi/agent/sessions";
const FILE = process.platform === "win32" ? `${ROOT}\\c--x\\2026-01-01_a.jsonl` : `${ROOT}/c--x/2026-01-01_a.jsonl`;

describe("路径与文件校验", () => {
	it("只认会话目录内的 .jsonl", () => {
		assert.equal(isSessionFile(FILE), true);
		assert.equal(isSessionFile(FILE.replace(".jsonl", ".log")), false);
		assert.equal(isInsideSessionsRoot(FILE, ROOT), true);
		assert.equal(isInsideSessionsRoot(`${ROOT}-evil/x.jsonl`, ROOT), false);
		assert.equal(isInsideSessionsRoot(FILE, ROOT.replace(/sessions$/, "sessions2")), false);
	});

	it("空路径一律拒绝", () => {
		assert.equal(isInsideSessionsRoot("", ROOT), false);
		assert.equal(isSessionFile(""), false);
	});
});

describe("到期时间", () => {
	it("0 表示永不删除", () => {
		assert.equal(computeExpiresAt(0, 0), null);
		assert.equal(computeExpiresAt(0, -3), null);
		assert.equal(computeExpiresAt(0, 7), new Date(7 * DAY_MS).toISOString());
	});

	it("天数归一化有上限", () => {
		assert.equal(normalizeDays(undefined, 7), 7);
		assert.equal(normalizeDays("30", 7), 30);
		assert.equal(normalizeDays(-1, 7), 7);
		assert.equal(normalizeDays(9999, 7), 365);
	});
});

describe("归档记录生命周期", () => {
	it("同路径重复归档只更新到期时间", () => {
		const state = emptyState();
		const now = Date.now();
		const first = archiveRecord(state, { path: FILE, title: "A", days: 7, now });
		assert.equal(first.created, true);
		const second = archiveRecord(state, { path: FILE, title: "A2", days: 30, now });
		assert.equal(second.created, false);
		assert.equal(state.records.length, 1);
		assert.equal(second.record.days, 30);
		assert.equal(second.record.title, "A2");
	});

	it("到期判定只看 archived", () => {
		const state = emptyState();
		const now = Date.now();
		const { record } = archiveRecord(state, { path: FILE, title: "A", days: 1, now });
		assert.equal(dueForDeletion(state, now).length, 0);
		assert.equal(dueForDeletion(state, now + 2 * DAY_MS).length, 1);
		restoreRecord(state, record.id, now);
		assert.equal(dueForDeletion(state, now + 2 * DAY_MS).length, 0);
	});

	it("改期与恢复", () => {
		const state = emptyState();
		const { record } = archiveRecord(state, { path: FILE, title: "A", days: 7 });
		assert.ok(setRetention(state, record.id, 0));
		assert.equal(state.records[0].expiresAt, null);
		assert.equal(setRetention(state, record.id, 7)?.days, 7);
		restoreRecord(state, record.id);
		assert.equal(publicRecords(state).length, 0);
		assert.equal(setRetention(state, record.id, 30), null);
	});

	it("删除失败要留错误、不误标成已删除", () => {
		const state = emptyState();
		const { record } = archiveRecord(state, { path: FILE, title: "A", days: 7 });
		markDeleted(state, record.id, { error: "拒绝" });
		assert.equal(state.records[0].status, "archived");
		assert.equal(state.records[0].lastError, "拒绝");
		markDeleted(state, record.id);
		assert.equal(state.records[0].status, "deleted");
	});

	it("到期标记为 expired：不改文件、仍算归档中（行继续隐藏）", () => {
		const state = emptyState();
		const now = Date.now();
		const { record } = archiveRecord(state, { path: FILE, title: "A", days: 1, now });
		markExpired(state, record.id, { now: now + 2 * DAY_MS, note: "已到期，等待你确认删除" });
		assert.equal(state.records[0].status, "expired");
		assert.equal(state.records[0].lastError, "已到期，等待你确认删除");
		assert.equal(publicRecords(state).length, 1, "expired 仍要在面板与隐藏名单里");
		assert.equal(dueForDeletion(state, now + 3 * DAY_MS).length, 0, "已标记的不再重复触发");
	});

	it("expired 还能改期回 archived，也能恢复成 restored", () => {
		const state = emptyState();
		const record = archiveRecord(state, { path: FILE, title: "A", days: 1 }).record;
		markExpired(state, record.id);
		const renewed = setRetention(state, record.id, 7);
		assert.equal(renewed.status, "archived");
		assert.equal(renewed.lastError, null);
		assert.ok(renewed.expiresAt);
		markExpired(state, record.id);
		restoreRecord(state, record.id);
		assert.equal(state.records[0].status, "restored");
		assert.equal(publicRecords(state).length, 0);
	});

	it("陈旧记录会被清理，归档中的不清理", () => {
		const state = emptyState();
		const now = Date.now();
		const archived = archiveRecord(state, { path: FILE, title: "A", days: 0, now }).record;
		const gone = archiveRecord(state, { path: `${FILE}.b`, title: "B", days: 1, now }).record;
		restoreRecord(state, gone.id, now);
		const expiring = archiveRecord(state, { path: `${FILE}.c`, title: "C", days: 1, now }).record;
		markExpired(state, expiring.id, { now });
		assert.equal(purgeStaleRecords(state, now + 31 * DAY_MS), 1, "expired 不该被自动清掉");
		assert.deepEqual(
			state.records.map((r) => r.id),
			[expiring.id, archived.id],
		);
	});
});

describe("标题解析工具", () => {
	it("extractUserText 吃字符串 / 分段数组 / 纯 text", () => {
		assert.equal(extractUserText({ content: " hi  there " }), "hi there");
		assert.equal(extractUserText({ content: [{ type: "text", text: "a" }, { type: "image" }, { text: "b" }] }), "a b");
		assert.equal(extractUserText({ text: "x  y" }), "x y");
		assert.equal(extractUserText({}), "");
	});

	it("readSessionEdges 只读头尾，大文件不会被整读", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "sa-edge-"));
		try {
			const file = join(dir, "big.jsonl");
			const filler = `${JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(500) } })}\n`;
			writeFileSync(file, `{"type":"session"}\n${filler.repeat(200)}${JSON.stringify({ type: "session_info", name: "真名" })}\n`);
			const { head, tail } = readSessionEdges(file, 1024, 512);
			assert.ok(head.length <= 1024, "头部要被截断");
			assert.ok(tail.length <= 512, "尾部要被截断");
			assert.match(tail, /真名/, "尾部要包含最新的 session_info");
			assert.equal(readSessionEdges(join(dir, "missing.jsonl")).head, "", "文件不存在返回空");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("载入去重", () => {
	it("同路径只留最新一条，按 archivedAt 倒序", () => {
		const older = { path: FILE, archivedAt: new Date(1000).toISOString(), status: "restored" };
		const newer = { path: FILE, archivedAt: new Date(2000).toISOString(), status: "archived" };
		const other = { path: `${FILE}.b`, archivedAt: new Date(1500).toISOString(), status: "archived" };
		const list = dedupeRecords([older, newer, other]);
		assert.equal(list.length, 2);
		assert.equal(list[0].status, "archived");
		assert.equal(list[0].archivedAt, newer.archivedAt);
	});
});

describe("落盘", () => {
	it("loadState 能吃坏文件，saveState 能原子写回", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "sa-test-"));
		try {
			const file = join(dir, "state.json");
			assert.equal(loadState(file).records.length, 0);
			writeFileSync(file, "{ broken");
			assert.equal(loadState(file).records.length, 0);
			const state = emptyState();
			archiveRecord(state, { path: FILE, title: "A", days: 7 });
			saveState(file, state);
			assert.equal(loadState(file).records.length, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("脏标题判定（行尾时间戳）", () => {
	const TIME_TAIL = "(?:\\d{1,2}:\\d{2}|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|\\d{4}-\\d{1,2}-\\d{1,2})";
	const NOISE = new RegExp(
		`^当前|^${TIME_TAIL}\\s*$|^(?:另一处|运行中|别处)\\s*$|(?:另一处|运行中|别处)\\s*${TIME_TAIL}\\s*$|${TIME_TAIL}\\s*$`,
	);

	it("行尾时间 / 日期 / 徽标都算脏", () => {
		for (const t of ["say ok11/10", "1另一处18:06", "当前115:51", "115:51", "运行中", "eval 2026/11/10"]) {
			assert.equal(NOISE.test(t), true, `${t} 应判脏`);
		}
	});

	it("正常标题不动（含「运行中」字样、含日期的正文）", () => {
		for (const t of ["监控运行中日志", "monitor", "2026/11/10 修复登录", "微店代理池优化：keepalive + 半死判废"]) {
			assert.equal(NOISE.test(t), false, `${t} 不该判脏`);
		}
	});
});
