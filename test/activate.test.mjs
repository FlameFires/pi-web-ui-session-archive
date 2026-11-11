import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import plugin from "../index.mjs";

/**
 * 极简 host 打桩：只实现本插件真正用到的面（dataDir / fs / route / schedule / notify / log / effect）。
 * 官方 SDK 有 createMockHost，但仓库不带 node_modules，这里保持零依赖。
 */
function createHost(dataDir) {
	const routes = new Map();
	const schedules = [];
	return {
		dataDir,
		dir: dataDir,
		cwd: dataDir,
		getSettings: () => ({ defaultDays: 7, showActiveRowButton: false }),
		onSettingsChanged: () => () => {},
		route(method, path, handler) {
			routes.set(`${method.toUpperCase()} ${path}`, handler);
			return () => routes.delete(`${method.toUpperCase()} ${path}`);
		},
		schedule(spec, fn) {
			schedules.push({ spec, fn });
			return () => {};
		},
		effect() {
			return () => {};
		},
		log() {},
		notify() {},
		broadcast() {},
		fs: {
			requestAccess: async () => true,
			authorizedDirs: () => [],
			removePath: async (abs) => {
				rmSync(abs, { force: true });
			},
		},
		__routes: routes,
		__schedules: schedules,
	};
}

function fakeReq(body) {
	return { body, query: {}, method: "POST" };
}

function fakeRes() {
	const out = { statusCode: 200, payload: null };
	return {
		out,
		status(code) {
			out.statusCode = code;
			return this;
		},
		json(payload) {
			out.payload = payload;
			return this;
		},
		setHeader() {},
		end() {},
	};
}

async function call(host, key, body) {
	const handler = host.__routes.get(key);
	assert.ok(handler, `路由未注册：${key}`);
	const res = fakeRes();
	await handler(fakeReq(body), res);
	return { status: res.out.statusCode, body: res.out.payload };
}

const root = mkdtempSync(join(tmpdir(), "sa-activate-"));
const sessions = join(root, "sessions");
const cwdDir = join(sessions, "c--ws");
mkdirSync(cwdDir, { recursive: true });
const sessionFile = join(cwdDir, "2026-01-01_s1.jsonl");
writeFileSync(sessionFile, '{"type":"session"}\n');
process.env.PI_CODING_AGENT_SESSION_DIR = sessions;

after(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
});

describe("activate 路由", () => {
	it("归档 → 状态可见 → 立即删除真的删文件", async () => {
		const host = createHost(join(root, "data"));
		const dispose = plugin.activate(host);
		try {
			const initial = await call(host, "GET /state");
			assert.equal(initial.status, 200);
			assert.deepEqual(initial.body.records, []);

			const archived = await call(host, "POST /archive", {
				path: sessionFile,
				title: "测试对话",
				days: 7,
			});
			assert.equal(archived.status, 200);
			assert.equal(archived.body.created, true);
			assert.equal(archived.body.record.title, "测试对话");
			assert.ok(archived.body.record.expiresAt);

			const listed = await call(host, "GET /state");
			assert.equal(listed.body.records.length, 1);
			assert.equal(listed.body.settings.defaultDays, 7);

			const purged = await call(host, "POST /purge", { id: archived.body.record.id });
			assert.equal(purged.status, 200);
			assert.equal(purged.body.ok, true);
			assert.equal(existsSync(sessionFile), false);
			assert.deepEqual((await call(host, "GET /state")).body.records, []);

			assert.ok(host.__schedules.some((s) => s.spec === "*/10 * * * *"));
		} finally {
			dispose?.();
		}
	});

	it("拒绝会话目录以外的路径", async () => {
		const host = createHost(join(root, "data2"));
		const dispose = plugin.activate(host);
		try {
			const outside = await call(host, "POST /archive", {
				path: join(root, "notes.jsonl"),
				title: "越界",
				days: 7,
			});
			assert.equal(outside.status, 400);
			const notJsonl = await call(host, "POST /archive", {
				path: join(cwdDir, "a.txt"),
				title: "不是会话",
				days: 7,
			});
			assert.equal(notJsonl.status, 400);
		} finally {
			dispose?.();
		}
	});

	it("恢复后记录从面板消失，sweep 不删已恢复的", async () => {
		const host = createHost(join(root, "data3"));
		const file = join(cwdDir, "2026-01-02_s2.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const dispose = plugin.activate(host);
		try {
			const archived = await call(host, "POST /archive", { path: file, title: "B", days: 1 });
			const restored = await call(host, "POST /restore", { id: archived.body.record.id });
			assert.equal(restored.status, 200);
			assert.deepEqual(restored.body.records, []);
			const sweep = await call(host, "POST /sweep");
			assert.equal(sweep.status, 200);
			assert.equal(existsSync(file), true, "恢复的文件不该被删");
		} finally {
			dispose?.();
		}
	});

	it("改期：0 天 = 永不删除", async () => {
		const host = createHost(join(root, "data4"));
		const file = join(cwdDir, "2026-01-03_s3.jsonl");
		writeFileSync(file, '{"type":"session"}\n');
		const dispose = plugin.activate(host);
		try {
			const archived = await call(host, "POST /archive", { path: file, title: "C", days: 7 });
			const updated = await call(host, "POST /retention", { id: archived.body.record.id, days: 0 });
			assert.equal(updated.status, 200);
			assert.equal(updated.body.records[0].expiresAt, null);
			assert.equal(updated.body.records[0].days, 0);
		} finally {
			dispose?.();
		}
	});
});
