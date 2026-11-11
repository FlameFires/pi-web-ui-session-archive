/**
 * 会话归档（session-archive）浏览器侧入口。
 *
 * 两条腿：
 * 1. 注入：往左栏每个会话行里塞一个归档按钮（宿主 slot 的会话行条目拿不到行 target，只能自己碰 DOM）。
 * 2. 隐藏：把已归档的会话行藏起来 —— 文件还在盘上，只是侧边栏看不见、点不进去。
 *
 * 需要 manifest 的 `dom` 权限；用户在「设置 → 插件」里点一次「授权 DOM 访问」才会下发本 bundle。
 */

const PLUGIN_ID = "session-archive";
const ACTION_OPEN = "session-archive:open";
const DAY_MS = 86_400_000;
const ROW_ATTR = "data-sa-archived";
const BTN_CLASS = "lp-sa-btn";
const POLL_MS = 30_000;
const RESCAN_MS = 1_500;

const ICON_ARCHIVE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M9.5 12.5h5"/></svg>`;

const RETENTION_OPTIONS = [
	{ days: 1, label: "1 天后删除" },
	{ days: 7, label: "7 天后删除" },
	{ days: 30, label: "30 天后删除" },
	{ days: 0, label: "永不删除" },
];

const state = {
	records: [],
	paths: new Set(),
	defaultDays: 7,
	showActiveRowButton: false,
	panelOpen: false,
	busy: false,
};

let observer = null;
let scanTimer = null;
let pollTimer = null;
let dialogEl = null;
let panelEl = null;
let toastEl = null;
let started = false;

/* ---------------------------------------------------------------- 基础设施 */

function apiBase() {
	try {
		const root = new URL("../../../", import.meta.url);
		const base = root.pathname.replace(/\/+$/, "");
		return `${base}/plugins-api/${PLUGIN_ID}`;
	} catch {
		return `/plugins-api/${PLUGIN_ID}`;
	}
}

function normPath(p) {
	return String(p ?? "")
		.trim()
		.replace(/\\/g, "/")
		.toLowerCase();
}

function formatDay(iso) {
	if (!iso) return "永不到期";
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "永不到期";
	const left = t - Date.now();
	const days = Math.ceil(left / DAY_MS);
	const text = new Date(t).toLocaleString();
	if (days <= 0) return `即将删除（${text}）`;
	return `${days} 天后删除（${text}）`;
}

async function request(pathname, init) {
	const res = await fetch(`${apiBase()}${pathname}`, {
		headers: { "Content-Type": "application/json" },
		...init,
	});
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (!res.ok) {
		const message = body?.error || `请求失败（HTTP ${res.status}）`;
		throw new Error(message);
	}
	return body ?? {};
}

function applyRecords(records) {
	state.records = Array.isArray(records) ? records : [];
	state.paths = new Set(state.records.map((r) => normPath(r.path)));
	if (panelEl) renderPanel();
}

async function refresh() {
	try {
		const data = await request("/state");
		state.defaultDays = Number.isFinite(Number(data?.settings?.defaultDays))
			? Number(data.settings.defaultDays)
			: 7;
		state.showActiveRowButton = data?.settings?.showActiveRowButton === true;
		applyRecords(data?.records);
		scan();
	} catch (err) {
		console.warn("[session-archive] 读取归档状态失败：", err);
	}
}

/* ---------------------------------------------------------------- 样式 */

function ensureStyles() {
	if (document.getElementById("sa-style")) return;
	const style = document.createElement("style");
	style.id = "sa-style";
	style.textContent = `
[${ROW_ATTR}="1"]{display:none!important}
/* 归档按钮复用宿主 .lp-del 的定位口径：删除 6px、重命名 32px，归档排到 58px。 */
.lp-row > .lp-sa-btn.lp-del{right:58px;color:var(--accent,#5b8cff)}
.lp-row > .lp-sa-btn.lp-del:hover{color:var(--accent,#5b8cff);background:color-mix(in srgb,var(--accent,#5b8cff) 22%,var(--bg-elev2,#1c1f28))}
.lp-del-group > .lp-sa-btn.lp-del{position:static;right:auto;transform:none}
.lp-sa-btn svg{pointer-events:none}
.sa-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9500;display:flex;align-items:center;justify-content:center}
.sa-card{background:var(--bg-elev,#1f2127);color:var(--text,#e8e8ea);border:1px solid var(--border,#3a3d45);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.45);width:min(440px,calc(100vw - 32px));padding:16px 18px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.sa-card h3{margin:0 0 4px;font-size:15px;font-weight:600}
.sa-sub{opacity:.65;font-size:12px;word-break:break-all;margin-bottom:12px}
.sa-options{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.sa-opt{border:1px solid var(--border,#3a3d45);background:transparent;color:inherit;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:13px}
.sa-opt[data-active="1"]{border-color:var(--accent,#5b8cff);background:color-mix(in srgb,var(--accent,#5b8cff) 18%,transparent)}
.sa-actions{display:flex;justify-content:flex-end;gap:8px}
.sa-btn{border-radius:8px;padding:6px 14px;cursor:pointer;font-size:13px;border:1px solid var(--border,#3a3d45);background:transparent;color:inherit}
.sa-btn.primary{background:var(--accent,#5b8cff);border-color:var(--accent,#5b8cff);color:var(--accent-contrast,#fff)}
.sa-btn.danger{color:#ff8080;border-color:#ff808055}
.sa-btn:disabled{opacity:.5;cursor:not-allowed}
.sa-panel{position:fixed;right:16px;top:64px;bottom:16px;width:min(460px,calc(100vw - 32px));background:var(--bg-elev,#1f2127);color:var(--text,#e8e8ea);border:1px solid var(--border,#3a3d45);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.45);z-index:9400;display:flex;flex-direction:column;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
.sa-panel header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border,#3a3d45)}
.sa-panel header h3{margin:0;font-size:14px;font-weight:600;flex:1}
.sa-panel .sa-count{opacity:.6;font-size:12px}
.sa-list{flex:1;overflow:auto;padding:8px}
.sa-item{border:1px solid var(--border,#3a3d45);border-radius:10px;padding:10px;margin-bottom:8px}
.sa-item-title{font-weight:600;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-item-meta{opacity:.65;font-size:11.5px;word-break:break-all}
.sa-item-row{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap}
.sa-item-row select{background:transparent;color:inherit;border:1px solid var(--border,#3a3d45);border-radius:6px;padding:3px 6px;font-size:12px}
.sa-empty{padding:24px 12px;text-align:center;opacity:.6}
.sa-toast{position:fixed;right:16px;bottom:16px;z-index:9600;background:var(--bg-elev,#1f2127);color:var(--text,#e8e8ea);border:1px solid var(--border,#3a3d45);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.45);padding:10px 12px;display:flex;align-items:center;gap:10px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:min(420px,calc(100vw - 32px))}
.sa-toast button{border:0;background:transparent;color:var(--accent,#5b8cff);cursor:pointer;font-size:13px}
.sa-close{border:0;background:transparent;color:inherit;cursor:pointer;opacity:.7;font-size:16px;line-height:1}
`;
	document.head.appendChild(style);
}

/* ---------------------------------------------------------------- 行处理 */

function rowSessionPath(row) {
	const el = row.querySelector(".session-item[title]");
	const title = el?.getAttribute("title")?.trim() ?? "";
	return /\.jsonl$/i.test(title) ? title : "";
}

function rowLabel(row) {
	const el = row.querySelector(".session-item");
	const text = (el?.textContent ?? "").replace(/\s+/g, " ").trim();
	return text.slice(0, 80);
}

function rowIsActive(row) {
	return Boolean(row.querySelector(".session-item.active"));
}

function rowDeleteButton(row) {
	const buttons = [...row.querySelectorAll("button.lp-del")];
	return buttons.find((b) => !b.classList.contains("lp-rename") && !b.classList.contains(BTN_CLASS)) ?? null;
}

function hideRow(row) {
	row.setAttribute(ROW_ATTR, "1");
}

function showRow(row) {
	if (row.hasAttribute(ROW_ATTR)) row.removeAttribute(ROW_ATTR);
}

function makeArchiveButton(row, path) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = `lp-del ${BTN_CLASS}`;
	btn.title = "归档这个对话（不删除，可设到期时间）";
	btn.setAttribute("aria-label", "归档这个对话");
	btn.innerHTML = ICON_ARCHIVE;
	btn.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openArchiveDialog(path, rowLabel(row));
	});
	return btn;
}

function scan() {
	if (!document.body) return;
	for (const row of document.querySelectorAll(".lp-row")) {
		const path = rowSessionPath(row);
		if (!path) continue;
		if (state.paths.has(normPath(path))) {
			hideRow(row);
			continue;
		}
		showRow(row);
		if (row.querySelector(`.${BTN_CLASS}`)) continue;
		const active = rowIsActive(row);
		const deleteBtn = rowDeleteButton(row);
		if (!deleteBtn && !(active && state.showActiveRowButton)) continue;
		if (active && !state.showActiveRowButton) continue;
		const btn = makeArchiveButton(row, path);
		if (deleteBtn) deleteBtn.before(btn);
		else row.appendChild(btn);
	}
}

function scheduleScan() {
	if (scanTimer) return;
	scanTimer = window.setTimeout(() => {
		scanTimer = null;
		scan();
	}, 120);
}

/* ---------------------------------------------------------------- 对话框 */

function closeArchiveDialog() {
	dialogEl?.remove();
	dialogEl = null;
}

function openArchiveDialog(path, title) {
	closeArchiveDialog();
	ensureStyles();
	let days = Number.isFinite(state.defaultDays) ? state.defaultDays : 7;
	if (!RETENTION_OPTIONS.some((o) => o.days === days)) days = 7;

	const backdrop = document.createElement("div");
	backdrop.className = "sa-backdrop";
	backdrop.dataset.saUi = "1";
	const card = document.createElement("div");
	card.className = "sa-card";
	card.innerHTML = `
		<h3>归档这个对话？</h3>
		<div class="sa-sub">${escapeHtml(title || path)}</div>
		<div class="sa-options"></div>
		<div class="sa-actions">
			<button type="button" class="sa-btn" data-act="cancel">取消</button>
			<button type="button" class="sa-btn primary" data-act="ok">归档</button>
		</div>`;
	const optionsWrap = card.querySelector(".sa-options");
	const buttons = [];
	const renderOptions = () => {
		optionsWrap.innerHTML = "";
		for (const option of RETENTION_OPTIONS) {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "sa-opt";
			b.dataset.active = option.days === days ? "1" : "0";
			b.textContent = option.label;
			b.addEventListener("click", () => {
				days = option.days;
				renderOptions();
			});
			optionsWrap.appendChild(b);
			buttons.push(b);
		}
	};
	renderOptions();

	card.addEventListener("click", async (event) => {
		const act = event.target?.closest?.("button")?.dataset?.act;
		if (!act) return;
		if (act === "cancel") {
			closeArchiveDialog();
			return;
		}
		const ok = card.querySelector('[data-act="ok"]');
		ok.disabled = true;
		ok.textContent = "归档中…";
		try {
			const result = await request("/archive", {
				method: "POST",
				body: JSON.stringify({ path, title, days }),
			});
			closeArchiveDialog();
			if (Array.isArray(result.records)) applyRecords(result.records);
			else await refresh();
			scan();
			toast(
				days > 0 ? `已归档「${title || path}」，${days} 天后自动删除` : `已归档「${title || path}」，不会自动删除`,
				result.record?.id,
			);
		} catch (err) {
			ok.disabled = false;
			ok.textContent = "归档";
			toast(`归档失败：${err instanceof Error ? err.message : String(err)}`);
		}
	});

	backdrop.addEventListener("click", (event) => {
		if (event.target === backdrop) closeArchiveDialog();
	});
	backdrop.appendChild(card);
	document.body.appendChild(backdrop);
	dialogEl = backdrop;
	card.querySelector('[data-act="ok"]')?.focus();
}

/* ---------------------------------------------------------------- 管理面板 */

function closePanel() {
	panelEl?.remove();
	panelEl = null;
	state.panelOpen = false;
}

function renderPanel() {
	if (!panelEl) return;
	const list = panelEl.querySelector(".sa-list");
	const count = panelEl.querySelector(".sa-count");
	if (!list) return;
	if (count) count.textContent = `${state.records.length} 条`;
	list.innerHTML = "";
	if (state.records.length === 0) {
		list.innerHTML = `<div class="sa-empty">还没有归档的对话。<br/>在左栏任意会话行上点 🗄 图标即可归档。</div>`;
		return;
	}
	for (const record of state.records) {
		const item = document.createElement("div");
		item.className = "sa-item";
		item.dataset.saUi = "1";
		item.innerHTML = `
			<div class="sa-item-title" title="${escapeAttr(record.title || record.path)}">${escapeHtml(record.title || "(未命名对话)")}</div>
			<div class="sa-item-meta">${escapeHtml(formatDay(record.expiresAt))}</div>
			<div class="sa-item-meta" title="${escapeAttr(record.path)}">${escapeHtml(shortPath(record.path))}</div>
			${record.lastError ? `<div class="sa-item-meta" style="color:#ff8080">${escapeHtml(record.lastError)}</div>` : ""}
			<div class="sa-item-row">
				<select data-role="retention">
					${RETENTION_OPTIONS.map(
						(o) =>
							`<option value="${o.days}"${Number(record.days) === o.days ? " selected" : ""}>${o.label}</option>`,
					).join("")}
				</select>
				<button type="button" class="sa-btn" data-role="restore">恢复</button>
				<button type="button" class="sa-btn danger" data-role="purge">立即删除</button>
			</div>`;
		item.querySelectorAll("button").forEach((button) => {
			button.addEventListener("click", async () => {
				const role = button.dataset.role;
				button.disabled = true;
				try {
					if (role === "restore") {
						const result = await request("/restore", {
							method: "POST",
							body: JSON.stringify({ id: record.id }),
						});
						applyRecords(result.records);
						scan();
						toast(`已恢复「${record.title || record.path}」，侧边栏刷新后可见`);
					} else if (role === "purge") {
						if (!window.confirm(`立即删除会话文件？此操作不可恢复。\n\n${record.path}`)) return;
						const result = await request("/purge", {
							method: "POST",
							body: JSON.stringify({ id: record.id }),
						});
						applyRecords(result.records);
						toast("已删除该会话文件");
					}
				} catch (err) {
					toast(`操作失败：${err instanceof Error ? err.message : String(err)}`);
				} finally {
					button.disabled = false;
				}
			});
		});
		const select = item.querySelector('select[data-role="retention"]');
		select?.addEventListener("change", async () => {
			try {
				const result = await request("/retention", {
					method: "POST",
					body: JSON.stringify({ id: record.id, days: Number(select.value) }),
				});
				applyRecords(result.records);
			} catch (err) {
				toast(`改期失败：${err instanceof Error ? err.message : String(err)}`);
			}
		});
		list.appendChild(item);
	}
}

function openPanel() {
	if (panelEl) {
		closePanel();
		return;
	}
	ensureStyles();
	const panel = document.createElement("div");
	panel.className = "sa-panel";
	panel.dataset.saUi = "1";
	panel.innerHTML = `
		<header>
			<h3>🗄️ 会话归档</h3>
			<span class="sa-count"></span>
			<button type="button" class="sa-close" title="关闭">✕</button>
		</header>
		<div class="sa-list"></div>`;
	panel.querySelector(".sa-close")?.addEventListener("click", closePanel);
	document.body.appendChild(panel);
	panelEl = panel;
	state.panelOpen = true;
	renderPanel();
	void refresh();
}

/* ---------------------------------------------------------------- 提示条 */

function toast(message, recordId) {
	ensureStyles();
	toastEl?.remove();
	const el = document.createElement("div");
	el.className = "sa-toast";
	el.dataset.saUi = "1";
	el.innerHTML = `<span>${escapeHtml(message)}</span>`;
	if (recordId) {
		const undo = document.createElement("button");
		undo.type = "button";
		undo.textContent = "撤销";
		undo.addEventListener("click", async () => {
			try {
				const result = await request("/restore", {
					method: "POST",
					body: JSON.stringify({ id: recordId }),
				});
				applyRecords(result.records);
				scan();
				toast("已撤销归档");
			} catch (err) {
				toast(`撤销失败：${err instanceof Error ? err.message : String(err)}`);
			}
		});
		el.appendChild(undo);
	}
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "✕";
	close.addEventListener("click", () => el.remove());
	el.appendChild(close);
	document.body.appendChild(el);
	toastEl = el;
	window.setTimeout(() => {
		if (el.isConnected) el.remove();
		if (toastEl === el) toastEl = null;
	}, 12_000);
}

/* ---------------------------------------------------------------- 工具 */

function escapeHtml(value) {
	return String(value ?? "").replace(
		/[&<>"']/g,
		(ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
	);
}

function escapeAttr(value) {
	return escapeHtml(value);
}

function shortPath(path) {
	const text = String(path ?? "");
	return text.length <= 72 ? text : `…${text.slice(-70)}`;
}

/* ---------------------------------------------------------------- 启动 */

function init() {
	if (started) return;
	started = true;
	ensureStyles();
	void refresh();

	observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			const target = mutation.target;
			if (target instanceof Element && target.closest("[data-sa-ui='1']")) continue;
			scheduleScan();
			return;
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });

	scanTimer = window.setTimeout(() => {
		scanTimer = null;
		scan();
	}, RESCAN_MS);
	pollTimer = window.setInterval(() => {
		if (document.visibilityState === "hidden") return;
		void refresh();
	}, POLL_MS);

	window.addEventListener("pi-web-ui:plugin-data", (event) => {
		if (event?.detail?.pluginId !== PLUGIN_ID) return;
		const payload = event.detail.payload;
		if (payload?.type === "state") {
			applyRecords(payload.records);
			scan();
		}
	});

	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (dialogEl) {
			event.stopPropagation();
			closeArchiveDialog();
		}
	});

	const host = window.__piWebUiHost;
	if (host && typeof host.onUiAction === "function") {
		host.onUiAction(ACTION_OPEN, () => openPanel());
	} else if (typeof host?.onTopbarAction === "function") {
		host.onTopbarAction(ACTION_OPEN, () => openPanel());
	}
}

function dispose() {
	observer?.disconnect();
	observer = null;
	if (scanTimer) window.clearTimeout(scanTimer);
	scanTimer = null;
	if (pollTimer) window.clearInterval(pollTimer);
	pollTimer = null;
	closeArchiveDialog();
	closePanel();
	toastEl?.remove();
	toastEl = null;
	for (const btn of document.querySelectorAll(`.${BTN_CLASS}`)) btn.remove();
	for (const row of document.querySelectorAll(`.lp-row[${ROW_ATTR}]`)) row.removeAttribute(ROW_ATTR);
	started = false;
}

if (typeof window !== "undefined") {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init, { once: true });
	} else {
		init();
	}
}

export default { dispose };
