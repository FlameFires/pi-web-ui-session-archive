import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import plugin, { DAY_MS, normalizePathKey } from "../index.mjs";

/**
 * 服务端边界测试：只覆盖 activate 后才成立的行为（授权 / 到期删除 / 标题回读 / 越界拒绝 / 载入迁移）。
 * 打桩风格与 test/activate.test.mjs 一致：零依赖，只实现插件真正用到的 host 面，但把
 * requestAccess / removePath / broadcast 的调用都记下来，用来断言「不该发生的事没发生」。
 */
function createHost(dataDir, options = {}) {
	const routes = new Map();
	const schedules = [];
	const broadcasts = [];
	const logs = [];
	const notifications = [];
	const calls = { access: 0, remove: 0, removed: [], accessDirs: [] };
	const settings = {
		defaultDays: 7,
		showActiveRowButton: false,
		autoDeleteOnExpiry: false,
		...(options.settings ?? {}),
	};
	const authorized = [...(options.authorizedDirs ?? [])];
	return {
		dataDir,
		dir: dataDir,
		cwd: dataDir,
		getSettings: () => ({ ...settings }),
		onSettingsChanged: () => () => {},
		route(method, path, handler) {
			const key = `${method.toUpperCase()} ${path}`;
			routes.set(key, handler);
			return () => routes.delete(key);
		},
		schedule(spec, fn) {
			schedules.push({ spec, fn });
			return () => {};
		},
		effect() {
			return () => {};
		},
		log(level, ...rest) {
			logs.push({ level, message: String(rest[0] ?? "") });
		},
		notify(level, message) {
			notifications.push({ level, message: String(message ?? "") });
		},
		broadcast(payload) {
			broadcasts.push(payload);
		},
		fs: {
			requestAccess: async (dir) => {
				calls.access += 1;
				calls.accessDirs.push(dir);
				return options.grantAccess !== false;
			},
			authorizedDirs: () => authorized.slice(),
			removePath: async (abs) => {
				calls.remove += 1;
				calls.removed.push(abs);
				if (options.removePathError) throw new Error(options.removePathError);
				rmSync(abs, { force: true });
			},
		},
		__routes: routes,
		__schedules: schedules,
		__broadcasts: broadcasts,
		__logs: logs,
		__notifications: notifications,
		__calls: calls,
		__settings: settings,
		__authorized: authorized,
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

function statePathOf(dataDir) {
	return join(dataDir, "session-archive", "state.json");
}

function writeStateFile(dataDir, records) {
	const file = statePathOf(dataDir);
	mkdirSync(join(dataDir, "session-archive"), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ version: 1, records }, null, "\t")}\n`);
	return file;
}

function readStateFile(dataDir) {
	return JSON.parse(readFileSync(statePathOf(dataDir), "utf8"));
}

/** 把磁盘上所有记录改成「已到期」，用来触发 sweep 而不必真的等 7 天。 */
function expiresAllToPast(dataDir) {
	const state = readStateFile(dataDir);
	const past = new Date(Date.now() - 60_000).toISOString();
	for (const record of state.records) record.expiresAt = past;
	writeFileSync(statePathOf(dataDir), `${JSON.stringify(state, null, "\t")}\n`);
}

function legacyRecord(id, path, extra = {}) {
	return {
		id,
		path,
		key: normalizePathKey(path),
		title: `记录 ${id}`,
		extension: ".jsonl",
		days: 7,
		archivedAt: new Date(1_000).toISOString(),
		updatedAt: new Date(1_000).toISOString(),
		expiresAt: null,
		status: "archived",
		deletedAt: null,
		lastError: null,
		...extra,
	};
}

/**
 * 每个用例自己的沙箱：临时 root + 临时 sessions 根目录 + 自动清理。
 * 绝不碰真实 ~/.pi/agent/sessions 与真实插件数据目录。
 */
async function withSandbox(fn) {
	const root = mkdtempSync(join(tmpdir(), "sa-server-edge-"));
	const sessions = join(root, "sessions");
	const cwdDir = join(sessions, "c--ws");
	mkdirSync(cwdDir, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
	process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
	const cleanups = [];
	const sandbox = {
		root,
		sessions,
		cwdDir,
		dataDir: (name) => join(root, name),
		makeSession(name, content = '{"type":"session"}\n') {
			const file = join(cwdDir, name);
			writeFileSync(file, content);
			return file;
		},
		activate(host) {
			const dispose = plugin.activate(host);
			cleanups.push(() => dispose?.());
			return dispose;
		},
	};
	try {
		return await fn(sandbox);
	} finally {
		for (const cleanup of cleanups.reverse()) {
			try {
				cleanup();
			} catch {
				/* 清理失败不影响断言结果 */
			}
		}
		if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
}

const purgedBroadcasts = (host) => host.__broadcasts.filter((b) => b?.type === "purged");

describe("到期 sweep 的授权边界", () => {
	it("autoDeleteOnExpiry=true 且目录已授权 → 真的删文件、标 deleted、发 purged", async () => {
		await withSandbox(async (sb) => {
			const file = sb.makeSession("2026-02-01_a.jsonl");
			const dataDir = sb.dataDir("data1");
			const archiveHost = createHost(dataDir, {
				settings: { autoDeleteOnExpiry: true },
				authorizedDirs: [sb.cwdDir],
			});
			sb.activate(archiveHost);
			const archived = await call(archiveHost, "POST /archive", { path: file, title: "到期删除", days: 1 });
			assert.equal(archived.status, 200);
			assert.equal(archiveHost.__calls.access, 0, "归档本身不申请授权");

			expiresAllToPast(dataDir);

			const host = createHost(dataDir, {
				settings: { autoDeleteOnExpiry: true },
				authorizedDirs: [sb.cwdDir],
			});
			sb.activate(host);
			const swept = await call(host, "POST /sweep");

			assert.equal(swept.status, 200);
			assert.equal(swept.body.deleted, 1);
			assert.equal(swept.body.expired, 0);
			assert.equal(existsSync(file), false, "授权后到期必须真的删除文件");
			assert.equal(host.__calls.access, 0, "sweep 绝不申请授权");
			assert.deepEqual(host.__calls.removed.map(normalizePathKey), [normalizePathKey(file)]);
			assert.equal(purgedBroadcasts(host).length, 1, "删除成功要发 purged 广播");
			assert.deepEqual(purgedBroadcasts(host)[0].paths.map(normalizePathKey), [normalizePathKey(file)]);
			assert.ok(
				host.__notifications.some((n) => n.message.includes("已删除")),
				"删除后要 notify",
			);
			assert.deepEqual((await call(host, "GET /state")).body.records, [], "deleted 记录不再出现在面板");

			const onDisk = readStateFile(dataDir);
			assert.equal(onDisk.records.length, 1);
			assert.equal(onDisk.records[0].status, "deleted");
		});
	});

	it("autoDeleteOnExpiry=true 但未授权 → 不删、标 expired、不申请授权", async () => {
		await withSandbox(async (sb) => {
			const file = sb.makeSession("2026-02-02_b.jsonl");
			const dataDir = sb.dataDir("data2");
			const archiveHost = createHost(dataDir, { settings: { autoDeleteOnExpiry: true } });
			sb.activate(archiveHost);
			await call(archiveHost, "POST /archive", { path: file, title: "未授权", days: 1 });
			expiresAllToPast(dataDir);

			const host = createHost(dataDir, { settings: { autoDeleteOnExpiry: true }, authorizedDirs: [] });
			sb.activate(host);
			const swept = await call(host, "POST /sweep");

			assert.equal(swept.body.deleted, 0);
			assert.equal(swept.body.expired, 1);
			assert.equal(existsSync(file), true, "没有授权就不能删文件");
			assert.equal(host.__calls.access, 0, "没授权也不能为了删去弹授权框");
			assert.equal(host.__calls.remove, 0, "连 removePath 都不该调用");
			assert.equal(purgedBroadcasts(host).length, 0);
			assert.equal(swept.body.records.length, 1);
			assert.equal(swept.body.records[0].status, "expired");
			assert.match(swept.body.records[0].lastError, /未获得会话目录访问授权/);

			const onDisk = readStateFile(dataDir);
			assert.equal(onDisk.records[0].status, "expired");
			assert.equal(onDisk.records[0].deletedAt, null);
		});
	});

	it("autoDeleteOnExpiry=false → 到期只标 expired，文件仍在，无授权动作", async () => {
		await withSandbox(async (sb) => {
			const file = sb.makeSession("2026-02-03_c.jsonl");
			const dataDir = sb.dataDir("data3");
			const archiveHost = createHost(dataDir, { authorizedDirs: [sb.cwdDir] });
			sb.activate(archiveHost);
			await call(archiveHost, "POST /archive", { path: file, title: "只标记", days: 1 });
			expiresAllToPast(dataDir);

			// 目录是「已授权」的，但自动删除关闭 → 仍然不许删
			const host = createHost(dataDir, { settings: { autoDeleteOnExpiry: false }, authorizedDirs: [sb.cwdDir] });
			sb.activate(host);
			const swept = await call(host, "POST /sweep");

			assert.equal(swept.body.deleted, 0);
			assert.equal(swept.body.expired, 1);
			assert.equal(existsSync(file), true);
			assert.equal(host.__calls.access, 0);
			assert.equal(host.__calls.remove, 0);
			assert.equal(purgedBroadcasts(host).length, 0);
			assert.equal(swept.body.records[0].status, "expired");
			assert.match(swept.body.records[0].lastError, /等待你确认删除/);
		});
	});
});

describe("归档的只读边界", () => {
	it("/archive 不申请授权、不调用 removePath、不改会话目录", async () => {
		await withSandbox(async (sb) => {
			const file = sb.makeSession("2026-02-04_d.jsonl");
			const before = readdirSync(sb.cwdDir);
			const contentBefore = readFileSync(file, "utf8");
			const dataDir = sb.dataDir("data4");
			const host = createHost(dataDir, { authorizedDirs: [] });
			sb.activate(host);

			const archived = await call(host, "POST /archive", { path: file, title: "只记录", days: 7 });

			assert.equal(archived.status, 200);
			assert.equal(archived.body.created, true);
			assert.equal(host.__calls.access, 0, "归档绝不申请目录授权");
			assert.equal(host.__calls.remove, 0, "归档绝不删除文件");
			assert.deepEqual(host.__calls.removed, []);
			assert.deepEqual(readdirSync(sb.cwdDir), before, "归档不能在会话目录里留下任何文件");
			assert.equal(readFileSync(file, "utf8"), contentBefore, "会话内容一字不动");
			assert.equal(purgedBroadcasts(host).length, 0);
			assert.ok(host.__broadcasts.some((b) => b?.type === "state"), "状态变更要广播 state");
			assert.equal(existsSync(statePathOf(dataDir)), true, "记录落在插件自己的数据目录里");
		});
	});
});

describe("标题回读 .jsonl", () => {
	it("脏标题取 session_info 名字，其次首条用户消息，尾部的也能读到", async () => {
		await withSandbox(async (sb) => {
			const named = sb.makeSession(
				"named.jsonl",
				[
					'{"type":"session"}',
					JSON.stringify({ type: "message", message: { role: "user", content: "hello 世界" } }),
					JSON.stringify({ type: "session_info", name: "我的会话" }),
				].join("\n") + "\n",
			);
			const unnamed = sb.makeSession(
				"unnamed.jsonl",
				[
					'{"type":"session"}',
					JSON.stringify({ type: "message", message: { role: "user", content: "hello 世界" } }),
				].join("\n") + "\n",
			);
			const filler = `${JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(900) } })}\n`;
			const big = sb.makeSession(
				"big.jsonl",
				`{"type":"session"}\n${JSON.stringify({
					type: "message",
					message: { role: "user", content: "开头提问" },
				})}\n${filler.repeat(300)}${JSON.stringify({ type: "session_info", name: "尾部真名" })}\n`,
			);
			const plain = sb.makeSession("plain.jsonl");
			assert.ok(statSync(big).size > 200 * 1024, "大文件用例本身要超过 200KB");

			const host = createHost(sb.dataDir("data5"));
			sb.activate(host);

			const withName = await call(host, "POST /archive", { path: named, current: true, days: 7 });
			assert.equal(withName.body.record.title, "我的会话", "session_info 名字优先于用户消息");

			const withoutName = await call(host, "POST /archive", { path: unnamed, title: "当前 12:30", days: 7 });
			assert.equal(withoutName.body.record.title, "hello 世界", "没有 session_info 时用首条用户消息");

			const tailOnly = await call(host, "POST /archive", { path: big, title: "运行中", days: 7 });
			assert.equal(tailOnly.body.record.title, "尾部真名", ">200KB 的文件也要读到尾部 session_info");

			const clean = await call(host, "POST /archive", { path: plain, title: "用户起的名字", days: 7 });
			assert.equal(clean.body.record.title, "用户起的名字", "非脏标题原样保留，不回读文件");

			assert.equal(host.__calls.access, 0, "回读标题是纯只读，不申请授权");
		});
	});
});

describe("路径安全边界", () => {
	it("/archive 与 /purge 都拒绝会话根目录之外或非 .jsonl 的路径", async () => {
		await withSandbox(async (sb) => {
			const outside = join(sb.root, "notes.jsonl");
			writeFileSync(outside, '{"type":"session"}\n');
			const notJsonl = sb.makeSession("plain.txt", "not a session\n");
			const dataDir = sb.dataDir("data6");

			const host = createHost(dataDir);
			sb.activate(host);
			const outsideArchive = await call(host, "POST /archive", { path: outside, title: "越界", days: 7 });
			assert.equal(outsideArchive.status, 400);
			const txtArchive = await call(host, "POST /archive", { path: notJsonl, title: "非会话", days: 7 });
			assert.equal(txtArchive.status, 400);
			const emptyArchive = await call(host, "POST /archive", { path: "", days: 7 });
			assert.equal(emptyArchive.status, 400);
			assert.deepEqual((await call(host, "GET /state")).body.records, []);

			// 历史遗留 / 被篡改的 state.json 里可能已经有越界记录，/purge 必须自己再校验一次
			writeStateFile(dataDir, [legacyRecord("r_out", outside), legacyRecord("r_txt", notJsonl)]);
			const purgeHost = createHost(dataDir);
			sb.activate(purgeHost);

			const outPurge = await call(purgeHost, "POST /purge", { id: "r_out" });
			// 边界校验提前到授权之前 → 400（修 bug 后行为变了：不该先弹授权再拒绝）
			assert.equal(outPurge.status, 400);
			assert.equal(outPurge.body.ok, false);
			assert.match(outPurge.body.error, /会话目录内/);
			assert.equal(existsSync(outside), true, "越界文件绝不能删");
			assert.equal(purgeHost.__calls.remove, 0, "校验失败时连 removePath 都不该调用");

			const txtPurge = await call(purgeHost, "POST /purge", { id: "r_txt" });
			assert.equal(txtPurge.status, 400);
			assert.equal(existsSync(notJsonl), true, "非 .jsonl 文件绝不能删");
			assert.equal(purgeHost.__calls.remove, 0);
			assert.equal(purgeHost.__calls.access, 0, "越界路径在申请授权之前就被拒了，不该弹授权框");

			const records = (await call(purgeHost, "GET /state")).body.records;
			assert.deepEqual(records.map((r) => r.status), ["archived", "archived"], "拒绝删除后仍是归档状态");
			assert.ok(records.every((r) => /会话目录内/.test(r.lastError)), "拒绝原因要留痕");
			assert.equal(purgedBroadcasts(purgeHost).length, 0, "没删成就不该发 purged");
		});
	});
});

describe("记录生命周期", () => {
	it("同一路径 归档→恢复→再归档：只有 1 条记录，状态翻回 archived", async () => {
		await withSandbox(async (sb) => {
			const file = sb.makeSession("2026-02-05_e.jsonl");
			const host = createHost(sb.dataDir("data7"));
			sb.activate(host);

			const first = await call(host, "POST /archive", { path: file, title: "第一轮", days: 7 });
			assert.equal(first.body.created, true);
			const id = first.body.record.id;

			const restored = await call(host, "POST /restore", { id });
			assert.equal(restored.status, 200);
			assert.deepEqual(restored.body.records, [], "恢复后不再出现在面板");
			assert.equal(readStateFile(sb.dataDir("data7")).records[0].status, "restored");

			const again = await call(host, "POST /archive", { path: file, title: "第二轮", days: 30 });
			assert.equal(again.status, 200);
			assert.equal(again.body.created, false, "同路径视为更新，不新建");
			assert.equal(again.body.record.id, id);

			const listed = (await call(host, "GET /state")).body.records;
			assert.equal(listed.length, 1, "/state 只能有一条");
			assert.equal(listed[0].status, "archived");
			assert.equal(listed[0].title, "第二轮");
			assert.equal(listed[0].days, 30);
			assert.ok(listed[0].expiresAt);
			assert.equal(readStateFile(sb.dataDir("data7")).records.length, 1);
		});
	});

	it("载入迁移：state.json 里的重复记录被去重并回写磁盘", async () => {
		await withSandbox(async (sb) => {
			const file = sb.makeSession("dup.jsonl");
			const other = sb.makeSession("other.jsonl");
			const dataDir = sb.dataDir("data8");
			writeStateFile(dataDir, [
				legacyRecord("r1", file, { archivedAt: new Date(1_000).toISOString() }),
				legacyRecord("r2", file, { archivedAt: new Date(2_000).toISOString(), status: "expired" }),
				legacyRecord("r3", file, { archivedAt: new Date(3_000).toISOString() }),
				legacyRecord("r4", other, { archivedAt: new Date(1_500).toISOString() }),
			]);

			const host = createHost(dataDir);
			sb.activate(host);

			const onDisk = readStateFile(dataDir);
			assert.equal(onDisk.records.length, 2, "载入时就要把重复记录回写清理");
			assert.deepEqual(onDisk.records.map((r) => r.id).sort(), ["r3", "r4"], "同路径保留 archivedAt 最新的一条");

			const listed = (await call(host, "GET /state")).body.records;
			assert.equal(listed.length, 2);
			assert.equal(new Set(listed.map((r) => normalizePathKey(r.path))).size, 2, "/state 里路径唯一");
			assert.ok(
				host.__logs.some((entry) => entry.message.includes("清理了 2 条重复记录")),
				"迁移要留日志",
			);
		});
	});

	it("sweep 幂等：同一批到期记录第二次不重复删除、不重复广播", async () => {
		await withSandbox(async (sb) => {
			const one = sb.makeSession("2026-02-06_f.jsonl");
			const two = sb.makeSession("2026-02-06_g.jsonl");
			const dataDir = sb.dataDir("data9");
			const archiveHost = createHost(dataDir, { settings: { autoDeleteOnExpiry: true } });
			sb.activate(archiveHost);
			await call(archiveHost, "POST /archive", { path: one, title: "F", days: 1 });
			await call(archiveHost, "POST /archive", { path: two, title: "G", days: 1 });
			expiresAllToPast(dataDir);

			const host = createHost(dataDir, {
				settings: { autoDeleteOnExpiry: true },
				authorizedDirs: [sb.cwdDir],
			});
			sb.activate(host);

			const firstSweep = await call(host, "POST /sweep");
			assert.equal(firstSweep.body.deleted, 2);
			assert.equal(firstSweep.body.expired, 0);
			assert.equal(host.__calls.remove, 2);
			assert.equal(purgedBroadcasts(host).length, 2);

			const secondSweep = await call(host, "POST /sweep");
			assert.equal(secondSweep.body.deleted, 0, "已删除的不再重复处理");
			assert.equal(secondSweep.body.expired, 0);
			assert.equal(host.__calls.remove, 2, "removePath 调用次数不能长");
			assert.equal(purgedBroadcasts(host).length, 2, "不能重复广播 purged");
			assert.deepEqual(secondSweep.body.records, []);
			assert.equal(existsSync(one), false);
			assert.equal(existsSync(two), false);
			assert.ok(DAY_MS > 0);
		});
	});
});

describe("/state 的 settings", () => {
	it("settings 里带布尔 autoDeleteOnExpiry，非 true 一律归一为 false", async () => {
		await withSandbox(async (sb) => {
			const host = createHost(sb.dataDir("data10"), { settings: { autoDeleteOnExpiry: true } });
			sb.activate(host);

			const on = (await call(host, "GET /state")).body.settings;
			assert.equal(typeof on.autoDeleteOnExpiry, "boolean");
			assert.equal(on.autoDeleteOnExpiry, true);
			assert.equal(on.defaultDays, 7);
			assert.equal(on.showActiveRowButton, false);

			host.__settings.autoDeleteOnExpiry = false;
			const off = (await call(host, "GET /state")).body.settings;
			assert.equal(off.autoDeleteOnExpiry, false);
			assert.equal(typeof off.autoDeleteOnExpiry, "boolean");

			host.__settings.autoDeleteOnExpiry = "yes";
			const coerced = (await call(host, "GET /state")).body.settings;
			assert.equal(coerced.autoDeleteOnExpiry, false, "只有真正的 true 才算开启");
		});
	});
});
