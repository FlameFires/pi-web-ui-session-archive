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

const ICON_ARCHIVE = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/></svg>`;

const ICON_RESTORE = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>`;


const state = {
	records: [],
	paths: new Set(),
	ids: new Set(),
	// 刚删掉的会话：宿主侧边栏还留着旧渲染，页面会话内继续藏住
	gone: new Set(),
	deleted: [],
	deletedCollapsed: true,
	defaultDays: 7,
	showActiveRowButton: false,
	autoDeleteOnExpiry: false,
	panelOpen: false,
	collapsedGroups: new Set(),
	busy: false,
};

let observer = null;
let scanTimer = null;
let pollTimer = null;
let panelEl = null;
let toastEl = null;
let started = false;
const cleanups = [];

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

/** 会话文件名里带 sessionId：`2026-11-11T07-48-40-971Z_<uuid>.jsonl`。 */
function sessionIdOf(path) {
	const match = String(path ?? "").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
	return match ? match[1].toLowerCase() : "";
}

function formatDay(iso, status) {
	const autoDelete = state.autoDeleteOnExpiry;
	const verb = autoDelete ? "删除" : "提醒";
	if (status === "expired") {
		const at = iso ? new Date(iso).toLocaleString() : "";
		return `已到期（${at}）· 文件未删除`;
	}
	if (!iso) return "永不到期";
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "永不到期";
	const left = t - Date.now();
	const text = new Date(t).toLocaleString();
	if (left <= 0) return `已到期，等待处理（${text}）`;
	const days = Math.ceil(left / DAY_MS);
	const hours = Math.ceil(left / 3_600_000);
	const remain = days >= 1 ? `剩 ${days} 天` : `剩 ${hours} 小时`;
	return `${remain}${verb}（${text}）`;
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

function applyRecords(records, deleted) {
	state.records = Array.isArray(records) ? records : [];
	if (Array.isArray(deleted)) state.deleted = deleted;
	state.paths = new Set([...state.records, ...state.deleted].map((r) => normPath(r.path)));
	state.ids = new Set([...state.records, ...state.deleted].map((r) => sessionIdOf(r.path)).filter(Boolean));
	if (panelEl) renderPanel();
}

async function refresh() {
	try {
		const data = await request("/state");
		state.defaultDays = Number.isFinite(Number(data?.settings?.defaultDays))
			? Number(data.settings.defaultDays)
			: 7;
		state.showActiveRowButton = data?.settings?.showActiveRowButton === true;
		state.autoDeleteOnExpiry = data?.settings?.autoDeleteOnExpiry === true;
		state.deleted = Array.isArray(data?.deleted) ? data.deleted : [];
		applyRecords(data?.records, data?.deleted);
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
.lp-section-actions .lp-slot-btn.sa-header-icon{display:inline-flex;align-items:center;justify-content:center;padding:2px 4px}
.lp-section-actions .lp-slot-btn.sa-header-icon svg{width:14px;height:14px}
.lp-section-actions .lp-slot-btn.sa-header-icon.sa-active{color:var(--accent,#5b8cff);background:color-mix(in srgb,var(--accent,#5b8cff) 18%,transparent)}
.sa-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:999;display:flex;align-items:center;justify-content:center}
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
.sa-panel{position:fixed;right:12px;top:56px;width:264px;max-height:min(560px,calc(100vh - 80px));background:var(--bg-elev,#1f2127);color:var(--text,#e8e8ea);border:1px solid var(--border,#3a3d45);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.45);z-index:1000;display:flex;flex-direction:column;font:12.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
.sa-panel header{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border,#3a3d45)}
.sa-panel header h3{margin:0;font-size:13px;font-weight:600;flex:0 0 auto}
.sa-search{flex:1;min-width:0;background:transparent;color:inherit;border:1px solid var(--border,#3a3d45);border-radius:6px;padding:3px 8px;font-size:12px;outline:none;transition:border-color .12s,box-shadow .12s}
.sa-search::placeholder{color:inherit;opacity:.42}
.sa-search:hover{border-color:color-mix(in srgb,var(--accent,#5b8cff) 45%,var(--border,#3a3d45))}
.sa-search:focus{border-color:var(--accent,#5b8cff);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#5b8cff) 22%,transparent)}
.sa-list{flex:1;overflow:auto;padding:2px 5px 6px}
.sa-group{margin-top:6px}
.sa-group+.sa-group{border-top:1px solid var(--border,#3a3d45)}
.sa-group-h{display:flex;align-items:center;gap:5px;padding:6px 4px 2px;opacity:.72;font-size:11px;font-weight:600;cursor:pointer;user-select:none;border-radius:6px}
.sa-group-h:hover{opacity:1;background:color-mix(in srgb,var(--accent,#5b8cff) 8%,transparent)}
.sa-group-h .sa-caret{flex:0 0 auto;width:10px;height:10px;display:inline-flex;align-items:center;justify-content:center;transition:transform .12s;opacity:.8}
.sa-group-h[data-open="0"] .sa-caret{transform:rotate(-90deg)}
.sa-group-h .sa-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-group-h .sa-group-count{flex:0 0 auto;margin-left:auto;opacity:.8;font-variant-numeric:tabular-nums}
.sa-item{border-radius:8px;padding:5px 6px 5px 7px;margin:1px 0}
.sa-item:hover{background:color-mix(in srgb,var(--accent,#5b8cff) 8%,transparent)}
.sa-item-meta{opacity:.58;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35}
.sa-item-meta.err{color:#ff8080;opacity:1}
.sa-item-head{display:flex;align-items:center;gap:4px;min-width:0}
.sa-item-title{flex:1;min-width:0;font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-item-actions{flex:0 0 auto;display:none;align-items:center;gap:1px}
.sa-item:hover .sa-item-actions,.sa-item:focus-within .sa-item-actions{display:inline-flex}
.sa-iact{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:inherit;opacity:.6;cursor:pointer;border-radius:4px;padding:0;transition:opacity .12s,background .12s,color .12s}
.sa-iact:hover{opacity:1;background:color-mix(in srgb,var(--text,#e8e8ea) 14%,transparent)}
.sa-iact.danger:hover{color:var(--red,#ff6b6b);background:color-mix(in srgb,var(--red,#ff6b6b) 18%,transparent)}
.sa-iact:disabled{opacity:.35;cursor:not-allowed}
.sa-iact svg{pointer-events:none}
.sa-dialog-backdrop{position:fixed;inset:0;z-index:1150;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;animation:saFade .12s ease-out}
@keyframes saFade{from{opacity:0}to{opacity:1}}
@keyframes saPop{from{transform:translateY(4px) scale(.98);opacity:0}to{transform:none;opacity:1}}
.sa-dialog{background:var(--bg-elev,#1f2127);color:var(--text,#e8e8ea);border:1px solid var(--border,#3a3d45);border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.5);width:min(360px,calc(100vw - 32px));padding:14px 16px;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;animation:saPop .14s ease-out}
.sa-dialog h4{margin:0 0 6px;font-size:13.5px;font-weight:600}
.sa-dialog p{margin:0;opacity:.75;font-size:12px;word-break:break-word}
.sa-dialog code{display:block;margin:8px 0 0;padding:6px 8px;border-radius:6px;background:color-mix(in srgb,var(--text,#e8e8ea) 8%,transparent);font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;opacity:.85;max-height:96px;overflow:auto}
.sa-dialog-note{margin:8px 0 0;font-size:11.5px;opacity:.6}
.sa-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.sa-dialog-btn{border-radius:6px;padding:4px 14px;font-size:12px;cursor:pointer;border:1px solid var(--border,#3a3d45);background:transparent;color:inherit;transition:background .12s,border-color .12s,color .12s}
.sa-dialog-btn:hover{background:color-mix(in srgb,var(--text,#e8e8ea) 12%,transparent)}
.sa-dialog-btn.primary{border-color:var(--accent,#5b8cff);color:var(--accent,#5b8cff)}
.sa-dialog-btn.primary:hover{background:color-mix(in srgb,var(--accent,#5b8cff) 18%,transparent)}
.sa-dialog-btn.danger{border-color:color-mix(in srgb,var(--red,#ff6b6b) 55%,transparent);color:var(--red,#ff6b6b)}
.sa-dialog-btn.danger:hover{background:color-mix(in srgb,var(--red,#ff6b6b) 20%,transparent)}
.sa-deleted-group{margin-top:8px;border-top:1px dashed var(--border,#3a3d45)}
.sa-item-deleted{opacity:.6}
.sa-item-deleted .sa-item-title{text-decoration:line-through}
.sa-empty{padding:18px 10px;text-align:center;opacity:.6}
@keyframes saFlash{0%,100%{box-shadow:none;background:transparent}50%{box-shadow:0 0 0 2px var(--accent,#5b8cff);background:color-mix(in srgb,var(--accent,#5b8cff) 18%,transparent)}}
.lp-row.sa-flash{animation:saFlash .9s ease-in-out 3;border-radius:8px}
.sa-toast{position:fixed;right:16px;bottom:16px;z-index:1050;background:var(--bg-elev,#1f2127);color:var(--text,#e8e8ea);border:1px solid var(--border,#3a3d45);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.45);padding:10px 12px;display:flex;align-items:center;gap:10px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:min(420px,calc(100vw - 32px))}
.sa-toast button{border:0;background:transparent;color:var(--accent,#5b8cff);cursor:pointer;font-size:13px}
.sa-close{border:0;background:transparent;color:inherit;cursor:pointer;opacity:.65;font-size:15px;line-height:1;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;transition:background .12s,color .12s,transform .08s}
.sa-close:hover{opacity:1;background:color-mix(in srgb,var(--text,#e8e8ea) 14%,transparent)}
.sa-close:active{transform:scale(.9)}
.sa-close:focus-visible{outline:1px solid var(--accent,#5b8cff);outline-offset:1px}
`;
	document.head.appendChild(style);
}

/* ---------------------------------------------------------------- 行处理 */

function rowSessionPath(row) {
	const el = row.querySelector(".session-item[title]");
	const title = el?.getAttribute("title")?.trim() ?? "";
	if (/\.jsonl$/i.test(title)) return title;
	// 「另一处 / 运行的对话」这几类行的 title 是 cwd + 提示语，但宿主把会话文件路径
	// 归一化后写进了 data-session-key（反斜杠转斜杠 + 全小写）。Windows 路径大小写不敏感，
	// 服务端 resolve() 后照样能读写，所以直接拿它当路径。
	const key = (row.getAttribute("data-session-key") ?? "").trim();
	return /\.jsonl$/i.test(key) ? key : "";
}

/** 行文本 = 标题 + 另一处/运行中 + 时间，展示/存储前先剥掉这些噪音。 */
function cleanRowLabel(text) {
	let value = String(text ?? "")
		.replace(/\s+/g, " ")
		.replace(/(另一处|运行中|别处|elsewhere|running)\s*/gi, " ")
		.replace(/^当前\s*/, "");
	// 行尾的宿主时间戳可能是 18:06 / 11/10 / 2026/11/10 / 2026-11-10，逐个剥掉
	const tail = /\s*(?:\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{1,2}-\d{1,2})\s*$/;
	while (tail.test(value)) value = value.replace(tail, "");
	return value.trim().slice(0, 80);
}

function rowLabel(row) {
	const el = row.querySelector(".session-item");
	return cleanRowLabel(el?.textContent ?? "");
}

/** 这类行的可见文本是「标题 + 另一处 + 时间」拼的，不能当标题用。 */
function rowLabelIsNoisy(row) {
	const el = row.querySelector(".session-item[title]");
	const title = el?.getAttribute("title") ?? "";
	return !/\.jsonl$/i.test(title.trim());
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
		// 宿主可能把同一个 .lp-row 元素复用给别的会话（虚拟列表 / 局部 patch），
		// 所以路径一律在点击时重算，不能用注入时闭包捕获的旧值。
		const livePath = rowSessionPath(row) || path;
		void archiveNow(livePath, rowLabel(row), rowIsActive(row), rowLabelIsNoisy(row));
	});
	return btn;
}

/**
 * 宿主给每行写的 data-session-key 有两条来源：
 *   历史的 .jsonl 路径（Iv(path)：反斜杠转斜杠 + 小写），或会话 id。
 * 「另一处 / 运行的对话」这类行没有 .jsonl 的 title，只能靠这个 key 命中。
 */
function rowIsArchived(row, path) {
	const key = normPath(row.getAttribute("data-session-key") ?? "");
	if (path && state.paths.has(normPath(path))) return true;
	if (key && (state.paths.has(key) || state.ids.has(key))) return true;
	// 已删除但宿主列表还没刷新：页面会话内继续藏
	if (path && state.gone.has(normPath(path))) return true;
	if (key && (state.gone.has(key) || state.gone.has(sessionIdOf(path || key)))) return true;
	return false;
}

async function archiveNow(path, title, current, dirty) {
	const days = Number.isFinite(state.defaultDays) ? state.defaultDays : 30;
	try {
		const result = await request("/archive", {
			method: "POST",
			body: JSON.stringify({ path, title, days, current: current === true, dirty: dirty === true }),
		});
		if (Array.isArray(result.records)) applyRecords(result.records);
		else await refresh();
		scan();
		const label = days > 0 ? `${days} 天后提醒清理` : "永不到期";
		toast(`已归档「${title || path}」· ${label}`, result.record?.id);
	} catch (err) {
		toast(`归档失败：${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * 宿主左栏标题栏的 slot 渲染器只认 icon 字符串（It 助手），不认 iconSvg，
 * 所以拿到 DOM 后把它换成描边 SVG，与旁边的 + / ‹ 同一视觉语言。
 */
function isArchiveHeaderButton(btn) {
	const label = (btn.getAttribute("aria-label") ?? btn.textContent ?? "").trim();
	return label === "归档" || label === "Archive";
}

function upgradeHeaderButtons() {
	for (const btn of document.querySelectorAll(".lp-section-actions .lp-slot-btn")) {
		if (!isArchiveHeaderButton(btn) && btn.dataset.saIcon !== "1") continue;
		if (btn.dataset.saIcon !== "1") {
			btn.dataset.saIcon = "1";
			btn.innerHTML = ICON_ARCHIVE;
			btn.classList.add("sa-header-icon");
		}
		// 面板开着时图标跟着高亮，和宿主 active 按钮一个观感
		btn.classList.toggle("sa-active", state.panelOpen);
	}
}

function scan() {
	if (!document.body) return;
	upgradeHeaderButtons();
	for (const row of document.querySelectorAll(".lp-row")) {
		const path = rowSessionPath(row);
		// 已归档的会话按「会话文件路径」和「sessionId」两条线都隐藏：
		// 同一个会话在「历史对话」里是 .jsonl 路径，在别的分区（运行的对话/分组）里只有 data-session-key。
		if (rowIsArchived(row, path)) {
			hideRow(row);
			continue;
		}
		showRow(row);
		if (!path) continue;
		if (row.querySelector(`.${BTN_CLASS}`)) continue;
		// 「运行的对话」里的行是活会话：归档它没有意义（文件还在写）。
		if (row.querySelector(".session-item.is-running")) continue;
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

/* ---------------------------------------------------------------- 管理面板 */

function closePanel() {
	closeConfirm(false);
	panelEl?.remove();
	panelEl = null;
	state.panelOpen = false;
	upgradeHeaderButtons();
}

/** 从会话路径提取项目文件夹（sessions/<编码后的 cwd>/<file>.jsonl）。 */
function projectFolderOf(path) {
	const match = normPath(path).match(/\/sessions\/([^/]+)\//);
	return match ? match[1] : "";
}

/** 用侧边栏 DOM 里能看到的绝对路径 title 反推编码文件夹的真实项目路径；推不出就回退文件夹名。 */
function projectLabel(folder) {
	if (!folder) return "(未知项目)";
	const target = pathSlug(folder);
	for (const el of document.querySelectorAll("[title]")) {
		const t = el.getAttribute("title") ?? "";
		if (!/^[A-Za-z]:[\\/]/.test(t)) continue;
		if (pathSlug(t) === target) return t.replace(/\\/g, "/");
	}
	const plain = folder.replace(/^-+|-+$/g, "");
	const drive = plain.match(/^([A-Za-z])--(.*)$/);
	return drive ? `${drive[1]}:\\${drive[2].replace(/--/g, "\\")}` : plain;
}

function renderPanel() {
	if (!panelEl) return;
	const list = panelEl.querySelector(".sa-list");
	if (!list) return;
	const query = (panelEl.querySelector(".sa-search")?.value ?? "").trim().toLowerCase();
	const records = state.records.filter((r) =>
		!query ||
		String(r.title ?? "").toLowerCase().includes(query) ||
		String(r.path ?? "").toLowerCase().includes(query),
	);
	list.innerHTML = "";
	if (records.length === 0) {
		list.innerHTML = `<div class="sa-empty">${query ? "没有匹配的归档" : "还没有归档的对话。\n左栏会话行 hover 点 🗄 即可归档。"}</div>`;
		return;
	}
	const groups = new Map();
	for (const record of records) {
		const folder = projectFolderOf(record.path);
		if (!groups.has(folder)) groups.set(folder, []);
		groups.get(folder).push(record);
	}
	for (const [folder, items] of groups) {
		const group = document.createElement("div");
		group.className = "sa-group";
		const head = document.createElement("div");
		head.className = "sa-group-h";
		const label = projectLabel(folder);
		const open = !state.collapsedGroups.has(folder);
		head.dataset.open = open ? "1" : "0";
		head.title = label;
		head.innerHTML = `<span class="sa-caret">▾</span><span class="sa-group-name">${escapeHtml(label.split(/[\\/]/).pop() || label)}</span><span class="sa-group-count">${items.length} 条</span>`;
		head.addEventListener("click", () => {
			if (state.collapsedGroups.has(folder)) state.collapsedGroups.delete(folder);
			else state.collapsedGroups.add(folder);
			renderPanel();
		});
		group.appendChild(head);
		if (open) {
			for (const record of items) group.appendChild(renderPanelItem(record));
		}
		list.appendChild(group);
	}
	if (state.deleted.length > 0) list.appendChild(renderDeletedSection());
}

/** 已删除（文件已不在）的记录：只能看，不能恢复。 */
function renderDeletedSection() {
	const wrap = document.createElement("div");
	wrap.className = "sa-group sa-deleted-group";
	const head = document.createElement("div");
	head.className = "sa-group-h";
	const open = !state.deletedCollapsed;
	head.dataset.open = open ? "1" : "0";
	head.title = "最近删除的归档会话（文件已不存在）";
	head.innerHTML = `<span class="sa-caret">▾</span><span class="sa-group-name">最近删除</span><span class="sa-group-count">${state.deleted.length} 条</span>`;
	head.addEventListener("click", () => {
		state.deletedCollapsed = !state.deletedCollapsed;
		renderPanel();
	});
	wrap.appendChild(head);
	if (open) {
		for (const record of state.deleted) {
			const item = document.createElement("div");
			item.className = "sa-item sa-item-deleted";
			item.dataset.saUi = "1";
			const at = record.deletedAt ? new Date(record.deletedAt).toLocaleString() : "";
			item.innerHTML = `
				<div class="sa-item-head">
					<span class="sa-item-title" title="${escapeAttr(record.path)}">${escapeHtml(cleanRowLabel(record.title) || "(未命名对话)")}</span>
				</div>
				<div class="sa-item-meta">已删除${at ? `（${escapeHtml(at)}）` : ""}</div>`;
			wrap.appendChild(item);
		}
	}
	return wrap;
}

function renderPanelItem(record) {
	const item = document.createElement("div");
	item.className = "sa-item";
	item.dataset.saUi = "1";
	item.dataset.saPath = record.path;
	const expired = record.status === "expired";
	item.innerHTML = `
		<div class="sa-item-head">
			<span class="sa-item-title" title="${escapeAttr(record.title || record.path)}">${escapeHtml(cleanRowLabel(record.title) || "(未命名对话)")}</span>
			<span class="sa-item-actions">
				<button type="button" class="sa-iact" data-role="restore" title="恢复${expired ? "" : "（行还在隐藏中，恢复后闪烁定位）"}">${ICON_RESTORE}</button>
				<button type="button" class="sa-iact danger" data-role="purge" title="删除会话文件（不可恢复）">${ICON_TRASH}</button>
			</span>
		</div>
		<div class="sa-item-meta">${escapeHtml(formatDay(record.expiresAt, record.status))}</div>
		${record.lastError ? `<div class="sa-item-meta err">${escapeHtml(record.lastError)}</div>` : ""}`;
	item.querySelectorAll("button[data-role]").forEach((button) => {
		button.addEventListener("click", async (event) => {
			event.stopPropagation();
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
					await flashRestoredRow(record);
					toast(`已恢复「${record.title || record.path}」`);
				} else if (role === "purge") {
					const ok = await saConfirm({
						title: "删除会话文件？",
						message: "此操作不可恢复，会直接删掉这个 .jsonl 文件。",
						detail: record.path,
						note: "会先向该目录申请一次访问授权。",
						confirmLabel: "删除",
						danger: true,
					});
					if (!ok) {
						button.disabled = false;
						return;
					}
					const result = await request("/purge", {
						method: "POST",
						body: JSON.stringify({ id: record.id }),
					});
					state.gone.add(normPath(record.path));
					const sid = sessionIdOf(record.path);
					if (sid) state.gone.add(sid);
					applyRecords(result.records);
					scan();
					toast("已删除该会话文件（侧边栏该行刷新后消失）");
				}
			} catch (err) {
				toast(`操作失败：${err instanceof Error ? err.message : String(err)}`);
				button.disabled = false;
			}
		});
	});
	return item;
}

/** 恢复后在侧边栏找到那一行：滚动过去 + 闪烁边框；找不到/分区折叠就退回 toast 提示项目名。 */
/** 把路径压成宿主会话目录用的 slug（`E:\Mkmo\pi-web-ui` → `e-mkmo-pi-web-ui`）。 */
function pathSlug(value) {
	return String(value ?? "")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

/** 按会话目录名找到对应项目的左栏行（宿主把项目路径写在 data-project-path 上）。 */
function findProjectHeaderRow(folder) {
	if (!folder) return null;
	const target = pathSlug(folder);
	if (!target) return null;
	for (const el of document.querySelectorAll("[data-project-path]")) {
		const value = el.getAttribute("data-project-path");
		if (value && pathSlug(value) === target) return el.closest(".lp-row") ?? el.parentElement;
	}
	return null;
}

/** 项目行是否处于展开态：宿主用 `.lp-project-head-row` 的 `is-expanded` / `is-collapsed` 表示。 */
function projectRowExpanded(row) {
	if (!row?.classList) return true;
	if (row.classList.contains("is-collapsed")) return false;
	return row.classList.contains("is-expanded") || !row.classList.contains("lp-project-head-row");
}

/**
 * 折叠开关必须点**箭头**：宿主里点项目标题按钮是「切换项目（set_cwd）」，
 * 点 `.lp-project-chevron` 才是 toggleProjectExpand —— 点错会把用户工作区拽到别处。
 */
function projectToggleTarget(row) {
	return row?.querySelector(".lp-project-chevron") ?? row?.querySelector(".lp-project-header-item") ?? row;
}

/** 等下一帧（无布局环境没有 rAF，退回 setTimeout）。 */
function nextFrame() {
	return new Promise((resolve) => {
		const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
		if (raf) raf(() => resolve());
		else window.setTimeout(resolve, 16);
	});
}

async function nextFrames(count = 2) {
	for (let i = 0; i < count; i += 1) await nextFrame();
}

/** 展开某个项目（点它的头部按钮），返回是否真的点过。 */
async function expandProjectForFolder(folder) {
	const row = findProjectHeaderRow(folder);
	if (!row || projectRowExpanded(row)) return false;
	projectToggleTarget(row).click();
	await nextFrames(2);
	return true;
}

/** 向上找折叠容器（项目的 `is-expanded` 或缺省的 `aria-expanded="false"`）并点开。 */
async function ensureRowVisible(row) {
	if (row.getClientRects().length > 0) return true;
	for (let depth = 0; depth < 8; depth += 1) {
		let toggled = false;
		let node = row.parentElement;
		while (node && node !== document.body) {
			const collapsedProject =
				node.classList?.contains("lp-project-head-row") && !projectRowExpanded(node)
					? projectToggleTarget(node)
					: null;
			const collapsedAria =
				node.getAttribute("aria-expanded") === "false"
					? node
					: node.querySelector?.(':scope > .lp-section-header button[aria-expanded="false"], :scope > [aria-expanded="false"]');
			const target = collapsedProject ?? collapsedAria;
			if (target) {
				target.click();
				toggled = true;
				break;
			}
			node = node.parentElement;
		}
		if (!toggled) break;
		await nextFrames(2);
		if (row.getClientRects().length > 0) {
			await new Promise((resolve) => window.setTimeout(resolve, 80));
			return true;
		}
	}
	return row.getClientRects().length > 0;
}

function findRestoredRow(ids) {
	for (const row of document.querySelectorAll(".lp-row")) {
		const path = rowSessionPath(row);
		const key = normPath(row.getAttribute("data-session-key") ?? "");
		const hit = (path && ids.includes(normPath(path))) || (key && ids.includes(key));
		if (hit) return row;
	}
	return null;
}

/** 展开项目是异步渲染：轮询等这一行出现（最多 ~1.6s）。 */
async function waitForRestoredRow(ids, timeoutMs = 1600) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const row = findRestoredRow(ids);
		if (row) return row;
		await new Promise((resolve) => window.setTimeout(resolve, 80));
	}
	return null;
}

let flashTimer = null;

/** 调试开关：localStorage.setItem("sa-debug","1") 后刷新，恢复流程会打印决策日志。 */
function debugLog(...args) {
	try {
		if (window.localStorage?.getItem("sa-debug") === "1") console.info("[session-archive]", ...args);
	} catch {
		/* localStorage 不可用就当没开 */
	}
}

function flashRow(row) {
	// 同一行反复闪会叠动画，先把上一次收干净
	if (flashTimer) window.clearTimeout(flashTimer);
	for (const el of document.querySelectorAll(".lp-row.sa-flash")) el.classList.remove("sa-flash");
	void row.offsetWidth; // 强制重排，让 animation 能重放
	row.classList.add("sa-flash");
	flashTimer = window.setTimeout(() => {
		row.classList.remove("sa-flash");
		flashTimer = null;
	}, 2800);
}

async function flashRestoredRow(record) {
	const ids = [normPath(record.path), sessionIdOf(record.path)].filter(Boolean);
	const folder = projectFolderOf(record.path);
	const fallback = () =>
		toast(`已恢复「${record.title || record.path}」· 所在项目：${projectLabel(folder)}（侧边栏没显示这一行，切到该项目即可见）`);

	let row = findRestoredRow(ids);
	debugLog("restore", {
		path: record.path,
		folder,
		rowFound: !!row,
		projectRows: [...document.querySelectorAll(".lp-project-head-row")].map((r) => ({
			cls: r.className,
			path: r.querySelector("[data-project-path]")?.getAttribute("data-project-path"),
		})),
	});
	if (!row) {
		// 行还没渲染多半是被折叠的项目藏着（宿主折叠时不渲染子树）→ 先展开再等它出现
		const clicked = await expandProjectForFolder(folder);
		debugLog("expand attempt", { clicked });
		row = await waitForRestoredRow(ids);
		debugLog("row after expand", { rowFound: !!row });
	}
	if (!row) {
		fallback();
		return;
	}
	// 行在 DOM 里但不可见：可能是别的折叠层级（分区 / 列被收起）
	const visible = await ensureRowVisible(row);
	debugLog("visible check", { visible, rects: row.getClientRects().length });
	if (!visible) {
		fallback();
		return;
	}
	row = findRestoredRow(ids) ?? row;
	try {
		row.scrollIntoView?.({ block: "center", behavior: "smooth" });
	} catch {
		/* 无布局环境（测试 / 极端视图）下滚动失败不影响闪烁 */
	}
	flashRow(row);
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
			<h3>归档</h3>
			<input type="search" class="sa-search" placeholder="搜索标题 / 路径…" />
			<button type="button" class="sa-close" title="关闭">✕</button>
		</header>
		<div class="sa-list"></div>`;
	panel.querySelector(".sa-close")?.addEventListener("click", closePanel);
	const search = panel.querySelector(".sa-search");
	search?.addEventListener("input", () => renderPanel());
	search?.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			closePanel();
		}
	});
	document.body.appendChild(panel);
	panelEl = panel;
	state.panelOpen = true;
	upgradeHeaderButtons();
	renderPanel();
	void refresh();
}

/* ---------------------------------------------------------------- 提示条 */

let confirmEl = null;

/** 自绘确认框，替代 window.confirm（原生弹窗没法跟主题走）。 */
function saConfirm({ title, message, detail, note, confirmLabel = "确定", danger = false }) {
	return new Promise((resolve) => {
		closeConfirm(false);
		const backdrop = document.createElement("div");
		backdrop.className = "sa-dialog-backdrop";
		backdrop.dataset.saUi = "1";
		const dialog = document.createElement("div");
		dialog.className = "sa-dialog";
		dialog.setAttribute("role", "dialog");
		dialog.setAttribute("aria-modal", "true");
		dialog.innerHTML = `
			<h4>${escapeHtml(title)}</h4>
			${message ? `<p>${escapeHtml(message)}</p>` : ""}
			${detail ? `<code>${escapeHtml(detail)}</code>` : ""}
			${note ? `<div class="sa-dialog-note">${escapeHtml(note)}</div>` : ""}
			<div class="sa-dialog-actions">
				<button type="button" class="sa-dialog-btn" data-act="cancel">取消</button>
				<button type="button" class="sa-dialog-btn ${danger ? "danger" : "primary"}" data-act="ok">${escapeHtml(confirmLabel)}</button>
			</div>`;
		const finish = (value) => {
			document.removeEventListener("keydown", onKey, true);
			backdrop.remove();
			confirmEl = null;
			resolve(value);
		};
		const onKey = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				finish(false);
			} else if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				finish(true);
			}
		};
		backdrop.addEventListener("click", (event) => {
			if (event.target === backdrop) finish(false);
		});
		dialog.addEventListener("click", (event) => {
			const act = event.target?.closest?.("button")?.dataset?.act;
			if (act === "ok") finish(true);
			else if (act === "cancel") finish(false);
		});
		document.addEventListener("keydown", onKey, true);
		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
		confirmEl = { backdrop, finish };
		dialog.querySelector('[data-act="ok"]')?.focus();
	});
}

/** 关掉当前确认框（面板失焦/被强制关闭时用）。 */
function closeConfirm(value = false) {
	const current = confirmEl;
	if (!current) return;
	confirmEl = null;
	current.finish(value);
}

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

/* ---------------------------------------------------------------- 启动 */

function init() {
	if (started) return;
	started = true;
	ensureStyles();
	void refresh();

	const MODAL_SELECTOR = ".modal-backdrop, .modal-dialog, [role='dialog'], .skill-inspect-dialog, .set-plugin-page";
	observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			const target = mutation.target;
			if (target instanceof Element && target.closest("[data-sa-ui='1']")) continue;
			// 聊天流式输出会疯狂改 DOM：只关心左栏行相关/弹窗相关的变动，其余直接跳过
			let relevant = false;
			for (const node of mutation.addedNodes) {
				if (!(node instanceof Element)) continue;
				if (node.matches(".lp-row, .lp-section-actions, .lp-tree-session-item, [data-session-key]")) {
					relevant = true;
					break;
				}
				if (node.querySelector(".lp-row, .lp-slot-btn, [data-sa-menu]")) {
					relevant = true;
					break;
				}
				if (node.matches(MODAL_SELECTOR) || node.querySelector(MODAL_SELECTOR)) {
					relevant = true;
					break;
				}
			}
			if (!relevant && mutation.removedNodes.length === 0) continue;
			// 宿主弹窗/遮罩一出现就让位（用户点了设置、命令面板等）。
			// 必须排除插件自己画的 UI：我们的确认框也带 role="dialog"，否则一弹就把自己关掉。
			if (panelEl) {
				for (const node of mutation.addedNodes) {
					if (!(node instanceof Element)) continue;
					if (node.dataset.saUi === "1" || node.closest("[data-sa-ui='1']")) continue;
					if (node.querySelector("[data-sa-ui='1']") && !node.querySelector(MODAL_SELECTOR + ":not([data-sa-ui='1'])")) continue;
					if (node.matches(MODAL_SELECTOR) || node.querySelector(MODAL_SELECTOR)) {
						closePanel();
						break;
					}
				}
			}
			scheduleScan();
			break;
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
	// 文案里的"剩 N 天"要自己走：只改文本节点，不动 DOM 结构（否则 hover 中的图标会闪）
	const tickTimer = window.setInterval(() => {
		if (!panelEl || document.visibilityState === "hidden") return;
		for (const item of panelEl.querySelectorAll(".sa-item")) {
			const path = item.dataset.saPath;
			const record = state.records.find((r) => r.path === path);
			const meta = item.querySelector(".sa-item-meta");
			if (record && meta) meta.textContent = formatDay(record.expiresAt, record.status);
		}
	}, 60_000);
	cleanups.push(() => window.clearInterval(tickTimer));

	window.addEventListener("pi-web-ui:plugin-data", (event) => {
		if (event?.detail?.pluginId !== PLUGIN_ID) return;
		const payload = event.detail.payload;
		if (payload?.type === "state") {
			applyRecords(payload.records, payload.deleted);
			scan();
		} else if (payload?.type === "purged" && Array.isArray(payload.paths)) {
			for (const path of payload.paths) {
				state.gone.add(normPath(path));
				const sid = sessionIdOf(path);
				if (sid) state.gone.add(sid);
			}
			scan();
		}
	});

	const onEscape = (event) => {
		if (event.key !== "Escape") return;
		if (confirmEl) return; // 确认框自己处理 Esc（捕获阶段已注册）
		if (panelEl) {
			event.stopPropagation();
			closePanel();
		}
	};
	document.addEventListener("keydown", onEscape, true);
	cleanups.push(() => document.removeEventListener("keydown", onEscape, true));

	// 别的窗口/标签页归档后要立刻跟上：广播偶尔丢（比如那一刻页面在后台休眠），切回来时补一次。
	const syncOnFocus = () => {
		if (document.visibilityState === "hidden") return;
		void refresh();
	};
	document.addEventListener("visibilitychange", syncOnFocus);
	window.addEventListener("focus", syncOnFocus);
	cleanups.push(() => {
		document.removeEventListener("visibilitychange", syncOnFocus);
		window.removeEventListener("focus", syncOnFocus);
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
	closeConfirm(false);
	closePanel();
	toastEl?.remove();
	toastEl = null;
	for (const btn of document.querySelectorAll(`.${BTN_CLASS}`)) btn.remove();
	for (const row of document.querySelectorAll(`.lp-row[${ROW_ATTR}]`)) row.removeAttribute(ROW_ATTR);
	for (const fn of cleanups.splice(0)) {
		try {
			fn();
		} catch {
			/* dispose 幂等 */
		}
	}
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
