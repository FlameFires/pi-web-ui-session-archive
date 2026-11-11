import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * 会话归档（session-archive）服务端入口。
 *
 * 职责边界：
 * - 只在插件自己的数据目录里记「哪些会话被归档了、什么时候到期」，从不改写原生会话内容。
 * - 到期清理只能删除**会话目录内**的 .jsonl 文件，路径校验在 deleteRecordFile() 里做。
 * - 隐藏侧边栏行是浏览器侧的事（client/entry.mjs 注入 DOM）；服务端只提供状态。
 */

export const PLUGIN_ID = "session-archive";
export const DAY_MS = 86_400_000;
export const SWEEP_CRON = "*/10 * * * *";
export const STARTUP_SWEEP_DELAY_MS = 8_000;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 365;
export const RETENTION_CHOICES = [1, 7, 30, 0]; // 0 = 永不
export const MAX_RECORDS = 2_000;
/** 已恢复 / 已删除的记录在面板里保留多久（天）。 */
export const RECORD_PURGE_DAYS = 30;

/** 归一化路径用于比较（Windows 大小写与反斜杠都不敏感）。 */
export function normalizePathKey(p) {
	const raw = String(p ?? "").trim();
	if (!raw) return "";
	try {
		return resolve(raw).replace(/\\/g, "/").toLowerCase();
	} catch {
		return raw.replace(/\\/g, "/").toLowerCase();
	}
}

/** Pi 会话文件根目录：与环境变量、宿主默认布局保持一致。 */
export function sessionsRoot() {
	const flat = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (flat && flat.trim()) return resolve(flat.trim());
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return resolve(join(agentDir, "sessions"));
}

/** 目标是否落在会话根目录内（删除前唯一的安全边界）。 */
export function isInsideSessionsRoot(absPath, root = sessionsRoot()) {
	const p = normalizePathKey(absPath);
	const r = normalizePathKey(root).replace(/\/+$/, "");
	if (!p || !r || p === ".") return false;
	return p === r || p.startsWith(`${r}/`);
}

export function isSessionFile(absPath) {
	return /\.jsonl$/i.test(String(absPath ?? "").trim());
}

/** days <= 0 表示不自动删除，返回 null。 */
export function computeExpiresAt(now, days) {
	const n = Number(days);
	if (!Number.isFinite(n) || n <= 0) return null;
	const capped = Math.min(Math.max(Math.round(n), 1), MAX_DAYS * 10);
	return new Date(now + capped * DAY_MS).toISOString();
}

export function normalizeDays(value, fallback = DEFAULT_DAYS) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	const rounded = Math.round(n);
	if (rounded < 0) return fallback;
	return Math.min(rounded, MAX_DAYS);
}

export function emptyState() {
	return { version: 1, records: [] };
}

export function loadState(file) {
	try {
		if (!existsSync(file)) return emptyState();
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || !Array.isArray(parsed.records)) return emptyState();
		return {
			version: 1,
			records: parsed.records.filter((r) => r && typeof r.path === "string" && r.path),
		};
	} catch {
		return emptyState();
	}
}

/** 原子写：先写临时文件再 rename，避免半写状态。 */
export function saveState(file, state) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

function newId() {
	return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 归档一条会话；同一路径重复归档视为「更新到期时间」，不会产生两条记录。
 * @returns {{record: object, created: boolean}}
 */
export function archiveRecord(state, { path, title, days, extension, now = Date.now() }) {
	const key = normalizePathKey(path);
	const label = String(title ?? "").trim().slice(0, 200);
	const expiresAt = computeExpiresAt(now, days);
	const existing = state.records.find(
		(r) => r.status !== "deleted" && normalizePathKey(r.path) === key,
	);
	if (existing) {
		existing.status = "archived";
		existing.title = label || existing.title;
		existing.expiresAt = expiresAt;
		existing.days = normalizeDays(days, DEFAULT_DAYS);
		existing.updatedAt = new Date(now).toISOString();
		existing.lastError = null;
		return { record: existing, created: false };
	}
	const record = {
		id: newId(),
		path: resolve(String(path)),
		key,
		title: label,
		extension: String(extension ?? "").trim().slice(0, 12),
		days: normalizeDays(days, DEFAULT_DAYS),
		archivedAt: new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
		expiresAt,
		status: "archived",
		deletedAt: null,
		lastError: null,
	};
	state.records.unshift(record);
	if (state.records.length > MAX_RECORDS) state.records.length = MAX_RECORDS;
	return { record, created: true };
}

export function findRecord(state, id) {
	return state.records.find((r) => r.id === id) ?? null;
}

/** 恢复：文件本来就没动过，改状态即可。 */
export function restoreRecord(state, id, now = Date.now()) {
	const record = findRecord(state, id);
	if (!record) return null;
	record.status = "restored";
	record.updatedAt = new Date(now).toISOString();
	record.expiresAt = null;
	return record;
}

export function setRetention(state, id, days, now = Date.now()) {
	const record = findRecord(state, id);
	if (!record || (record.status !== "archived" && record.status !== "expired")) return null;
	record.status = "archived";
	record.days = normalizeDays(days, DEFAULT_DAYS);
	record.expiresAt = computeExpiresAt(now, record.days);
	record.updatedAt = new Date(now).toISOString();
	record.lastError = null;
	return record;
}

export function markExpired(state, id, { now = Date.now(), note = null } = {}) {
	const record = findRecord(state, id);
	if (!record) return null;
	record.status = "expired";
	record.updatedAt = new Date(now).toISOString();
	record.lastError = note ? String(note).slice(0, 300) : null;
	return record;
}

export function markDeleted(state, id, { now = Date.now(), error = null } = {}) {
	const record = findRecord(state, id);
	if (!record) return null;
	if (error) {
		record.lastError = String(error).slice(0, 300);
		record.updatedAt = new Date(now).toISOString();
		return record;
	}
	record.status = "deleted";
	record.deletedAt = new Date(now).toISOString();
	record.updatedAt = record.deletedAt;
	record.expiresAt = record.expiresAt ?? null;
	record.lastError = null;
	return record;
}

/** 刚到期、还没被标记的记录（expiresAt 已过、仍在 archived 状态）。 */
export function dueForDeletion(state, now = Date.now()) {
	return state.records.filter(
		(r) => r.status === "archived" && typeof r.expiresAt === "string" && Date.parse(r.expiresAt) <= now,
	);
}

/** 清掉很早以前的 restored / deleted 记录。 */
export function purgeStaleRecords(state, now = Date.now()) {
	const cutoff = now - RECORD_PURGE_DAYS * DAY_MS;
	const before = state.records.length;
	state.records = state.records.filter((r) => {
		if (r.status === "archived" || r.status === "expired") return true;
		const stamp = Date.parse(r.updatedAt ?? r.archivedAt ?? "");
		if (!Number.isFinite(stamp)) return false;
		return stamp >= cutoff;
	});
	return before - state.records.length;
}

/** 给浏览器的记录视图（不带内部 key 这类噪音）。 */
export function publicRecords(state) {
	return state.records
		.filter((r) => r.status === "archived" || r.status === "expired")
		.map((r) => ({
			id: r.id,
			path: r.path,
			title: r.title,
			extension: r.extension,
			days: r.days,
			status: r.status,
			archivedAt: r.archivedAt,
			expiresAt: r.expiresAt,
			lastError: r.lastError ?? null,
		}));
}

function sendJson(res, status, payload) {
	try {
		res.status(status).json(payload);
	} catch {
		res.statusCode = status;
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.end(JSON.stringify(payload));
	}
}

export default {
	activate(host) {
		const dataDir = join(host.dataDir, PLUGIN_ID);
		const statePath = join(dataDir, "state.json");
		mkdirSync(dataDir, { recursive: true });

		let state = loadState(statePath);
		const settings = () => {
			const values = host.getSettings?.() ?? {};
			return {
				defaultDays: normalizeDays(values.defaultDays, DEFAULT_DAYS),
				showActiveRowButton: values.showActiveRowButton === true,
				autoDeleteOnExpiry: values.autoDeleteOnExpiry === true,
			};
		};

		const persist = () => {
			try {
				saveState(statePath, state);
			} catch (err) {
				host.log("warn", "会话归档状态写入失败", err);
			}
		};

		const publish = () => {
			try {
				host.broadcast?.({ type: "state", records: publicRecords(state), settings: settings() });
			} catch {
				/* 广播失败不影响状态 */
			}
		};

		const requestAccess = async (absFile, reason) => {
			try {
				const dir = dirname(resolve(absFile));
				if (typeof host.fs?.requestAccess !== "function") return false;
				return await host.fs.requestAccess(dir, reason);
			} catch {
				return false;
			}
		};

		const deleteRecordFile = async (record) => {
			if (!isSessionFile(record.path) || !isInsideSessionsRoot(record.path)) {
				markDeleted(state, record.id, { error: "路径不在会话目录内，拒绝删除" });
				return { ok: false, error: "路径不在会话目录内，拒绝删除" };
			}
			try {
				await host.fs.removePath(resolve(record.path));
				markDeleted(state, record.id);
				return { ok: true };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!existsSync(record.path)) {
					markDeleted(state, record.id);
					return { ok: true };
				}
				markDeleted(state, record.id, { error: `删除失败：${message}` });
				return { ok: false, error: message };
			}
		};

		/** 是否已经拿过该会话目录的授权（有就悄悄删，绝不为了删去弹授权框）。 */
		const hasGrant = (absFile) => {
			try {
				const dir = normalizePathKey(dirname(resolve(absFile)));
				const dirs = host.fs?.authorizedDirs?.() ?? [];
				return dirs.some((d) => normalizePathKey(d) === dir);
			} catch {
				return false;
			}
		};

		const sweep = async () => {
			const due = dueForDeletion(state);
			const auto = settings().autoDeleteOnExpiry;
			let changed = false;
			let deleted = 0;
			let expired = 0;
			for (const record of due) {
				changed = true;
				if (!auto) {
					// 默认行为：到期只标记，不删文件，不动任何目录授权。
					markExpired(state, record.id, { note: "已到期，等待你确认删除" });
					expired += 1;
					continue;
				}
				if (!hasGrant(record.path)) {
					// 没授权就不删，也不弹窗：留给你在面板里手动点。
					markExpired(state, record.id, { note: "已到期，但未获得会话目录访问授权，未删除" });
					expired += 1;
					continue;
				}
				const result = await deleteRecordFile(record);
				if (result.ok) {
					deleted += 1;
					host.notify?.("info", `🗄️ 归档到期，已删除会话文件：${record.title || record.path}`);
				} else {
					host.log("warn", `归档到期删除失败：${record.path}`, result.error);
				}
			}
			if (purgeStaleRecords(state) > 0) changed = true;
			if (changed) {
				persist();
				publish();
			}
			return { deleted, expired };
		};

		/**
		 * “当前对话”的侧边栏行文本是「当前 + 时间」，不是会话名。
		 * 标题可疑时读 .jsonl 文件头里的真实名字（纯只读，不申请授权）。
		 */
		const resolveTitle = (absPath, fallback, current) => {
			const label = String(fallback ?? "").trim();
			const suspicious = current === true || /^当前/.test(label) || /^\d{1,2}:\d{2}/.test(label);
			if (!suspicious) return label;
			try {
				const text = existsSync(absPath) ? readFileSync(absPath, "utf8") : "";
				let lastName = null;
				let firstUserText = null;
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;
					let parsed;
					try {
						parsed = JSON.parse(line);
					} catch {
						continue;
					}
					// 宿主改名 = 追加 session_info 条目，取最新的
					if (parsed?.type === "session_info" && typeof parsed.name === "string" && parsed.name.trim()) {
						lastName = parsed.name.trim().slice(0, 200);
						continue;
					}
					if (firstUserText === null && parsed?.type === "message" && parsed.message?.role === "user") {
						const content = parsed.message.content;
						let textPart = "";
						if (typeof content === "string") textPart = content;
						else if (Array.isArray(content)) {
							textPart = content
								.filter((c) => c && (c.type === "text" || typeof c.text === "string"))
								.map((c) => c.text ?? "")
								.join(" ");
						} else if (typeof parsed.message.text === "string") textPart = parsed.message.text;
						textPart = textPart.replace(/\s+/g, " ").trim();
						if (textPart) firstUserText = textPart.slice(0, 80);
					}
				}
				if (lastName) return lastName;
				if (firstUserText) return firstUserText;
			} catch {
				/* 读不到就保留原文本 */
			}
			return label;
		};

		host.route("GET", "/state", (_req, res) => {
			// 旧记录里的「当前…」「HH:MM」标题在这里顺带修一次，不必重新归档。
			let healed = false;
			for (const record of state.records) {
				if (record.status !== "archived" && record.status !== "expired") continue;
				const fixed = resolveTitle(record.path, record.title, true);
				if (fixed && fixed !== record.title) {
					record.title = fixed;
					healed = true;
				}
			}
			if (healed) persist();
			sendJson(res, 200, { ok: true, records: publicRecords(state), settings: settings() });
		});

		host.route("POST", "/archive", async (req, res) => {
			const body = req.body ?? {};
			const rawPath = String(body.path ?? "").trim();
			if (!rawPath || !isSessionFile(rawPath) || !isInsideSessionsRoot(rawPath)) {
				sendJson(res, 400, { ok: false, error: "只能归档会话目录内的 .jsonl 会话文件" });
				return;
			}
			const defaults = settings();
			const days = normalizeDays(body.days ?? defaults.defaultDays, defaults.defaultDays);
			// 归档本身只写记录 + 隐藏行，不碰文件、不申请任何目录授权。
			const { record, created } = archiveRecord(state, {
				path: rawPath,
				title: resolveTitle(rawPath, body.title, body.current === true),
				extension: body.extension,
				days,
			});
			persist();
			publish();
			sendJson(res, 200, { ok: true, created, record: publicRecords({ records: [record] })[0] });
		});

		host.route("POST", "/restore", (req, res) => {
			const record = restoreRecord(state, String(req.body?.id ?? ""));
			if (!record) {
				sendJson(res, 404, { ok: false, error: "找不到这条归档记录" });
				return;
			}
			persist();
			publish();
			sendJson(res, 200, { ok: true, records: publicRecords(state) });
		});

		host.route("POST", "/retention", (req, res) => {
			const record = setRetention(state, String(req.body?.id ?? ""), req.body?.days);
			if (!record) {
				sendJson(res, 404, { ok: false, error: "找不到这条归档记录" });
				return;
			}
			persist();
			publish();
			sendJson(res, 200, { ok: true, records: publicRecords(state) });
		});

		host.route("POST", "/purge", async (req, res) => {
			const record = findRecord(state, String(req.body?.id ?? ""));
			if (!record || (record.status !== "archived" && record.status !== "expired")) {
				sendJson(res, 404, { ok: false, error: "找不到这条归档记录" });
				return;
			}
			await requestAccess(record.path, "立即删除已归档的会话文件");
			const result = await deleteRecordFile(record);
			persist();
			publish();
			sendJson(res, result.ok ? 200 : 500, { ok: result.ok, error: result.error, records: publicRecords(state) });
		});

		host.route("POST", "/sweep", async (_req, res) => {
			const result = await sweep();
			sendJson(res, 200, { ok: true, ...result, records: publicRecords(state) });
		});

		host.schedule(SWEEP_CRON, () => {
			void sweep();
		});

		if (STARTUP_SWEEP_DELAY_MS >= 0) {
			const timer = setTimeout(() => {
				void sweep();
			}, STARTUP_SWEEP_DELAY_MS);
			timer.unref?.();
			host.effect("startup-sweep", () => clearTimeout(timer));
		}

		host.log("info", `会话归档已就绪：${state.records.length} 条记录（${statePath}）`);

		return () => {
			try {
				rmSync(`${statePath}.tmp-${process.pid}-${Date.now()}`, { force: true });
			} catch {
				/* 清理临时文件失败无需处理 */
			}
		};
	},
};
