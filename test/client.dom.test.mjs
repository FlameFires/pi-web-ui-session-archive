/**
 * session-archive 浏览器侧（client/entry.mjs）的 DOM 测试。
 *
 * entry.mjs 是裸 ESM：模块顶层就碰 `window` / `document`，并且 import 时自动 init()。
 * 所以每个用例都按「先装 jsdom 全局 → 再 dynamic import（带唯一 query 骗过模块缓存）
 * → 拆全局并 dispose()」的方式跑，用例之间不共享模块状态。
 *
 * 宿主（pi-web-ui 侧边栏）的 DOM 约定由行/标题栏夹具模拟：
 *   .lp-row[data-session-key] > .session-item[title] + button.lp-del[.lp-rename]
 *   .lp-section-actions > button.lp-slot-btn[aria-label="归档"]
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { JSDOM } from "jsdom";

const ENTRY = path.resolve(import.meta.dirname, "../client/entry.mjs");
const PLUGIN_ID = "session-archive";
const OPEN_ACTION = "session-archive:open";
const API_MARKER = "/plugins-api/session-archive";

/** entry.mjs 会读这些全局；每个用例装一次、拆一次。 */
const DOM_GLOBALS = [
	"window",
	"document",
	"fetch",
	"confirm",
	"MutationObserver",
	"Element",
	"Node",
	"Event",
	"CustomEvent",
	"KeyboardEvent",
	"HTMLElement",
];

const SESSIONS_ROOT = String.raw`C:\Users\vi\.pi\agent\sessions`;
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const U3 = "33333333-3333-3333-3333-333333333333";
const U4 = "44444444-4444-4444-4444-444444444444";
const U5 = "55555555-5555-5555-5555-555555555555";
const U6 = "66666666-6666-6666-6666-666666666666";
const U7 = "77777777-7777-7777-7777-777777777777";
const U8 = "88888888-8888-8888-8888-888888888888";
const U9 = "99999999-9999-9999-9999-999999999999";
const UA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const UC = "cccccccc-cccc-cccc-cccc-cccccccccccc";

let moduleSeq = 0;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 让 fetch 链和 MutationObserver（微任务）都跑完；不用长 sleep。 */
async function settle(rounds = 6) {
	for (let i = 0; i < rounds; i += 1) await tick();
}

/** 会话文件绝对路径（Windows 风格，和宿主 title 一致）。 */
function sessionFile(folder, uuid, stamp = "2026-11-11T07-48-40-971Z") {
	return `${SESSIONS_ROOT}\\${folder}\\${stamp}_${uuid}.jsonl`;
}

/** 宿主写进 data-session-key 的口径：反斜杠转斜杠 + 全小写。 */
function sessionKey(filePath) {
	return filePath.replace(/\\/g, "/").toLowerCase();
}

/**
 * 左栏会话行夹具。
 * @param {object} spec
 * @param {string} [spec.title] `.session-item[title]`；省略则不渲染 title 属性
 * @param {string} [spec.text]  `.session-item` 文本
 * @param {string} [spec.sessionKey] `data-session-key`
 * @param {boolean} [spec.del] 是否带宿主删除/重命名按钮
 * @param {boolean} [spec.active] `.session-item.active`
 * @param {boolean} [spec.running] `.session-item.is-running`
 */
function rowHtml({ title, text = "", sessionKey: key, del = true, active = false, running = false, id = "" }) {
	const itemClass = ["session-item", active ? "active" : "", running ? "is-running" : ""].filter(Boolean).join(" ");
	const rowAttrs = ['class="lp-row"', key ? `data-session-key="${key}"` : "", id ? `data-testid="${id}"` : ""]
		.filter(Boolean)
		.join(" ");
	const titleAttr = title === undefined ? "" : ` title="${title}"`;
	const buttons = del
		? '<button type="button" class="lp-del" title="删除"></button><button type="button" class="lp-del lp-rename" title="重命名"></button>'
		: "";
	return `<div ${rowAttrs}><div class="${itemClass}"${titleAttr}>${text}</div>${buttons}</div>`;
}

/** 左栏标题栏 slot 按钮容器（manifest 的 leftpanel.*.actions 落到这里）。 */
const SECTION_ACTIONS_HTML = `
	<div class="lp-section-actions">
		<button type="button" class="lp-slot-btn" aria-label="归档" title="归档"><span>归档</span></button>
	</div>`;

/** 服务端 publicRecords() 的形状。 */
function archivedRecord(recordPath, overrides = {}) {
	return {
		id: "rec-1",
		path: recordPath,
		title: "存档会话",
		extension: "",
		days: 7,
		status: "archived",
		archivedAt: "2026-11-01T00:00:00.000Z",
		expiresAt: "2026-11-08T00:00:00.000Z",
		lastError: null,
		...overrides,
	};
}

function stateEvent(window, records) {
	return new window.CustomEvent("pi-web-ui:plugin-data", {
		detail: { pluginId: PLUGIN_ID, payload: { type: "state", records } },
	});
}

/**
 * 装环境 + 导入模块。
 * @param {import("node:test").TestContext} t 用来注册拆卸钩子
 * @param {object} options
 * @param {string} [options.html] body 初始 HTML
 * @param {() => {records: object[], settings?: object}} [options.state] GET /state 的返回来源
 * @param {(call: object, ctx: object) => {body: object, status?: number} | null} [options.onRequest] 其余接口打桩
 */
async function mountDom(t, { html = "", state = () => ({ records: [], settings: {} }), onRequest } = {}) {
	const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: "http://localhost/" });
	const { window } = dom;
	const doc = window.document;
	const calls = [];
	const unexpected = [];
	const actions = new Map();
	const saved = new Map();

	const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

	window.__piWebUiHost = {
		onUiAction(name, fn) {
			actions.set(name, fn);
			return () => actions.delete(name);
		},
	};

	async function fetchStub(rawUrl, init = {}) {
		const method = String(init?.method ?? "GET").toUpperCase();
		const raw = String(rawUrl);
		const at = raw.indexOf(API_MARKER);
		const call = {
			raw,
			base: at < 0 ? "" : raw.slice(0, at + API_MARKER.length),
			path: at < 0 ? null : raw.slice(at + API_MARKER.length),
			method,
			headers: init?.headers ?? null,
			body: init?.body == null ? null : JSON.parse(String(init.body)),
		};
		calls.push(call);

		const snapshot = state() ?? {};
		if (method === "GET" && call.path === "/state") {
			return respond({
				ok: true,
				records: snapshot.records ?? [],
				settings: {
					defaultDays: 7,
					showActiveRowButton: false,
					autoDeleteOnExpiry: false,
					...(snapshot.settings ?? {}),
				},
			});
		}
		const answered = onRequest?.(call, { state, calls });
		if (answered) return respond(answered.body ?? {}, answered.status ?? 200);
		unexpected.push(call);
		return respond({ ok: false, error: `未打桩的请求 ${method} ${call.path}` }, 500);
	}

	for (const key of DOM_GLOBALS) saved.set(key, globalThis[key]);
	globalThis.window = window;
	globalThis.document = doc;
	globalThis.fetch = fetchStub;
	globalThis.MutationObserver = window.MutationObserver;
	globalThis.Element = window.Element;
	globalThis.Node = window.Node;
	globalThis.Event = window.Event;
	globalThis.CustomEvent = window.CustomEvent;
	globalThis.KeyboardEvent = window.KeyboardEvent;
	globalThis.HTMLElement = window.HTMLElement;

	let mod;
	t.after(() => {
		try {
			mod?.default?.dispose?.();
		} catch {
			/* dispose 幂等；清理失败不掩盖断言 */
		}
		for (const [key, value] of saved) {
			if (value === undefined) delete globalThis[key];
			else globalThis[key] = value;
		}
		window.close();
		assert.deepEqual(
			unexpected.map((call) => `${call.method} ${call.path}`),
			[],
			"出现未打桩的插件请求",
		);
	});

	mod = await import(`${pathToFileURL(ENTRY).href}?dom-test=${(moduleSeq += 1)}`);

	return { dom, window, document: doc, mod, calls, actions };
}

/** 通过宿主桥（onUiAction 回调）点标题栏 slot 按钮，模拟用户点「归档」。 */
async function openPanelFromSlot(env) {
	const button = env.document.querySelector('.lp-section-actions .lp-slot-btn[aria-label="归档"]');
	assert.ok(button, "宿主没有渲染归档 slot 按钮");
	const open = env.actions.get(OPEN_ACTION);
	assert.equal(typeof open, "function", `onUiAction 没注册 ${OPEN_ACTION}`);
	// once：重复调用本 helper（关掉再开）时不能叠出多个监听，否则第二次点击会「开→关」
	button.addEventListener("click", () => open(), { once: true });
	button.click();
	await settle();
	const panel = env.document.querySelector(".sa-panel");
	assert.ok(panel, "点 slot 按钮后没有生成 .sa-panel");
	return panel;
}

describe("session-archive 浏览器侧 DOM", () => {
	it("只给可归档的会话行注入归档按钮", async (t) => {
		const okPath = sessionFile("-e--proj", U1);
		const noDeletePath = sessionFile("-e--proj", U2);
		const runningPath = sessionFile("-e--proj", U3);
		const activePath = sessionFile("-e--proj", U4);

		const env = await mountDom(t, {
			html: [
				rowHtml({ id: "ok", title: okPath, text: "普通会话" }),
				rowHtml({ id: "nodel", title: noDeletePath, text: "没有删除按钮", del: false }),
				rowHtml({ id: "running", title: runningPath, text: "正在跑的会话", running: true }),
				rowHtml({ id: "active", title: activePath, text: "当前打开的会话", active: true }),
			].join(""),
		});
		await settle();

		const row = (id) => env.document.querySelector(`[data-testid="${id}"]`);
		const btns = (id) => [...row(id).querySelectorAll("button.lp-sa-btn")];

		assert.equal(env.document.querySelectorAll(".lp-row").length, 4, "夹具应该渲染 4 行");
		assert.equal(btns("ok").length, 1, "普通行应有且只有一个归档按钮");
		assert.equal(btns("nodel").length, 1, "宿主没有 ✏/🗑 的行（运行中）也要注入，只是排到最右");
		assert.equal(btns("running").length, 1, "运行中的行也可以归档（只隐藏，不碰文件）");
		assert.equal(btns("active").length, 0, "默认设置下 .session-item.active 的行不注入");

		// 按钮自身口径 + 插到宿主删除按钮前面（复用 .lp-del 的 hover 定位）
		const button = btns("ok")[0];
		assert.equal(button.type, "button");
		assert.ok(button.classList.contains("lp-del"), "归档按钮应带 .lp-del 复用宿主 hover 样式");
		assert.equal(button.getAttribute("aria-label"), "归档这个对话");
		assert.equal(button.getAttribute("title"), "归档这个对话（不删除，可设到期时间）");
		assert.match(button.innerHTML, /<svg /);

		const children = [...row("ok").children];
		assert.equal(children.indexOf(button), 1, "归档按钮应紧跟 .session-item 插入");
		assert.ok(children[2].classList.contains("lp-del"));
		assert.equal(children[2].classList.contains("lp-rename"), false, "归档按钮插在删除按钮之前");

		assert.ok(env.document.getElementById("sa-style"), "样式应已注入");

		// 重复扫描幂等：再来一次 state 广播不会重复塞按钮
		env.window.dispatchEvent(stateEvent(env.window, []));
		await settle();
		assert.equal(btns("ok").length, 1, "重复扫描不应重复注入");
		assert.equal(env.document.querySelectorAll(".lp-row").length, 4);

		// 只读构建环境：加载阶段只该请求 GET /state
		for (const call of env.calls) assert.equal(`${call.method} ${call.path}`, "GET /state");
		assert.match(env.calls[0].base, /\/plugins-api\/session-archive$/, "API base 应来自 import.meta.url");
	});

	it("showActiveRowButton 打开后 active 行也注入", async (t) => {
		const activePath = sessionFile("-e--proj", U5);
		const env = await mountDom(t, {
			html: rowHtml({ id: "active", title: activePath, text: "当前打开的会话", active: true }),
			state: () => ({ records: [], settings: { showActiveRowButton: true } }),
		});
		await settle();

		const row = env.document.querySelector('[data-testid="active"]');
		assert.equal(row.querySelectorAll("button.lp-sa-btn").length, 1);
	});

	it("title 不是 .jsonl 时用 data-session-key 里的路径注入", async (t) => {
		const elsewherePath = sessionFile("-e--elsewhere", U6);
		const env = await mountDom(t, {
			html: [
				// 「另一处」行：title 是 cwd + 提示语，路径只在 data-session-key 里
				rowHtml({
					id: "elsewhere",
					title: "C:/work/another-folder\n继续昨天的话题",
					text: "历史会话另一处 18:06",
					sessionKey: sessionKey(elsewherePath),
				}),
				// key 只是 sessionId，拿不到 .jsonl 路径 → 不注入
				rowHtml({ id: "no-path", title: "C:/work/another-folder", text: "空行", sessionKey: U7 }),
			].join(""),
		});
		await settle();

		const elsewhere = env.document.querySelector('[data-testid="elsewhere"]');
		assert.equal(elsewhere.querySelectorAll("button.lp-sa-btn").length, 1, "应回退到 data-session-key 里的 .jsonl 路径");
		assert.equal(env.document.querySelector('[data-testid="no-path"]').querySelectorAll("button.lp-sa-btn").length, 0);
	});

	it("已归档记录隐藏行，state 广播清空后恢复并重新注入按钮", async (t) => {
		const archivedPath = sessionFile("-e--proj", U8);
		let records = [archivedRecord(archivedPath, { title: "旧对话" })];

		const env = await mountDom(t, {
			html: rowHtml({ id: "arch", title: archivedPath, text: "旧对话" }),
			state: () => ({ records }),
		});
		await settle();

		const row = env.document.querySelector('[data-testid="arch"]');
		assert.equal(row.getAttribute("data-sa-archived"), "1", "命中已归档路径的行应被标记隐藏");
		assert.equal(row.querySelectorAll("button.lp-sa-btn").length, 0, "隐藏行不需要归档按钮");

		records = [];
		env.window.dispatchEvent(stateEvent(env.window, records));
		await settle();

		assert.equal(row.hasAttribute("data-sa-archived"), false, "恢复后应移除隐藏属性");
		assert.equal(row.querySelectorAll("button.lp-sa-btn").length, 1, "恢复后应重新注入归档按钮");
	});

	it("点行内归档按钮 → POST /archive（path/days/current/dirty）→ 行被隐藏", async (t) => {
		const archivePath = sessionFile("-e--proj", U9);
		const store = { records: [] };

		const env = await mountDom(t, {
			html: rowHtml({ id: "row", title: archivePath, text: "周末计划" }),
			state: () => ({ records: store.records, settings: { defaultDays: 3 } }),
			onRequest(call) {
				if (call.method === "POST" && call.path === "/archive") {
					const record = archivedRecord(call.body.path, {
						id: "rec-archive",
						title: call.body.title,
						days: call.body.days,
					});
					store.records = [record];
					// 服务端 /archive 只回 record（不回 records），客户端会自己再拉一次 /state
					return { body: { ok: true, created: true, record } };
				}
				return null;
			},
		});
		await settle();

		const button = env.document.querySelector('[data-testid="row"] button.lp-sa-btn');
		assert.ok(button, "归档按钮应在行内");
		button.click();
		await settle();

		const archiveCalls = env.calls.filter((call) => call.path === "/archive");
		assert.equal(archiveCalls.length, 1, "应只发一次 /archive");
		const call = archiveCalls[0];
		assert.equal(call.method, "POST");
		assert.match(call.raw, /^\/[A-Za-z]:?\/plugins-api\/session-archive\/archive$|^\/plugins-api\/session-archive\/archive$/);
		assert.equal(call.headers["Content-Type"], "application/json");

		assert.equal(call.body.path, archivePath, "body.path 应是该行的会话文件路径");
		assert.equal(call.body.title, "周末计划");
		assert.equal(call.body.days, 3, "days 应等于 settings.defaultDays");
		assert.equal(call.body.current, false);
		assert.equal(call.body.dirty, false);
		assert.equal(typeof call.body.current, "boolean");
		assert.equal(typeof call.body.dirty, "boolean");

		const row = env.document.querySelector('[data-testid="row"]');
		assert.equal(row.getAttribute("data-sa-archived"), "1", "归档成功后该行应被隐藏");

		const toast = env.document.querySelector(".sa-toast");
		assert.ok(toast, "归档成功应出现提示条");
		assert.match(toast.textContent, /已归档「周末计划」· 3 天后提醒清理/);
	});

	it("行文本 1另一处18:06 会清洗成 1", async (t) => {
		const elsewherePath = sessionFile("-e--elsewhere", UA);
		const key = sessionKey(elsewherePath);
		const store = { records: [] };

		const env = await mountDom(t, {
			html: rowHtml({ id: "noisy", title: "E:/work/dir", text: "1另一处18:06", sessionKey: key }),
			state: () => ({ records: store.records }),
			onRequest(call) {
				if (call.method === "POST" && call.path === "/archive") {
					return { body: { ok: true, created: true, record: archivedRecord(call.body.path) } };
				}
				return null;
			},
		});
		await settle();

		const button = env.document.querySelector('[data-testid="noisy"] button.lp-sa-btn');
		assert.ok(button);
		button.click();
		await settle();

		const call = env.calls.find((item) => item.path === "/archive");
		assert.ok(call, "应发出 /archive");
		assert.equal(call.body.title, "1", "另一处 + 时间戳要从行文本里剥掉");
		assert.equal(call.body.path, key, "路径取自 data-session-key");
		assert.equal(call.body.dirty, true, "title 不是 .jsonl 的行应标成 dirty");
		assert.equal(call.body.current, false);
	});

	it("标题栏 slot 按钮打开面板，Escape 关闭", async (t) => {
		const env = await mountDom(t, { html: SECTION_ACTIONS_HTML });
		await settle();

		const headerButton = env.document.querySelector(".lp-section-actions .lp-slot-btn");
		assert.equal(headerButton.dataset.saIcon, "1", "slot 按钮的图标应被替换");
		assert.ok(headerButton.classList.contains("sa-header-icon"));
		assert.match(headerButton.innerHTML, /<svg /);
		assert.equal(headerButton.classList.contains("sa-active"), false, "面板没开时不该高亮");

		const panel = await openPanelFromSlot(env);
		assert.equal(panel.dataset.saUi, "1");
		assert.equal(panel.querySelector("h3").textContent, "归档");
		assert.ok(panel.querySelector("input.sa-search"));
		assert.equal(headerButton.classList.contains("sa-active"), true, "面板打开时图标高亮");

		env.document.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();

		assert.equal(env.document.querySelector(".sa-panel"), null, "Escape 应移除面板");
		assert.equal(headerButton.classList.contains("sa-active"), false, "关闭后去掉高亮");
	});

	it("宿主弹窗关面板，插件自己的 .sa-dialog-backdrop 不关", async (t) => {
		const env = await mountDom(t, { html: SECTION_ACTIONS_HTML });
		await settle();

		await openPanelFromSlot(env);
		const modal = env.document.createElement("div");
		modal.className = "modal-backdrop";
		env.document.body.appendChild(modal);
		await settle();
		assert.equal(env.document.querySelector(".sa-panel"), null, "宿主 .modal-backdrop 出现应自动关面板");

		modal.remove();
		await settle();

		await openPanelFromSlot(env);
		const ownDialog = env.document.createElement("div");
		ownDialog.className = "sa-dialog-backdrop";
		ownDialog.dataset.saUi = "1";
		ownDialog.innerHTML = '<div class="sa-dialog" role="dialog" aria-modal="true">删除会话文件？</div>';
		env.document.body.appendChild(ownDialog);
		await settle();
		assert.ok(env.document.querySelector(".sa-panel"), "插件自己的弹窗不该把面板关掉");
		assert.ok(env.document.querySelector(".sa-dialog"), "自绘对话框应已挂载");
	});

	it("面板里点 🗑 → 自绘 .sa-dialog（不走 window.confirm）→ 点删除 POST /purge", async (t) => {
		const purgePath = sessionFile("-e--proj", UB);
		const record = archivedRecord(purgePath, { id: "rec-purge", title: "待删除的对话" });
		let records = [record];

		const env = await mountDom(t, {
			html: SECTION_ACTIONS_HTML,
			state: () => ({ records }),
			onRequest(call) {
				if (call.method === "POST" && call.path === "/purge") {
					records = [];
					return { body: { ok: true, records: [] } };
				}
				return null;
			},
		});
		await settle();

		let confirmCalls = 0;
		env.window.confirm = () => {
			confirmCalls += 1;
			throw new Error("不该调用 window.confirm");
		};
		globalThis.confirm = env.window.confirm;

		await openPanelFromSlot(env);
		assert.equal(env.document.querySelectorAll(".sa-item").length, 1);

		const trash = env.document.querySelector(".sa-item .sa-iact.danger");
		assert.ok(trash, "归档条目应带删除按钮");
		trash.click();
		await settle(2);

		const dialog = env.document.querySelector(".sa-dialog");
		assert.ok(dialog, "点删除应弹出自绘 .sa-dialog");
		assert.equal(dialog.getAttribute("role"), "dialog");
		assert.match(dialog.textContent, /删除会话文件？/);
		assert.ok(dialog.textContent.includes(purgePath), "对话框应展示会话路径");
		assert.equal(confirmCalls, 0, "不应使用 window.confirm");
		assert.ok(env.document.querySelector(".sa-panel"), "自绘确认框弹出时面板保留");
		assert.equal(trash.disabled, true, "确认期间按钮应禁用");

		const okButton = dialog.querySelector('[data-act="ok"]');
		assert.equal(okButton.textContent, "删除");
		assert.ok(okButton.classList.contains("danger"));
		okButton.click();
		await settle();

		const purgeCalls = env.calls.filter((call) => call.path === "/purge");
		assert.equal(purgeCalls.length, 1, "应只发一次 /purge");
		assert.equal(purgeCalls[0].method, "POST");
		assert.deepEqual(purgeCalls[0].body, { id: "rec-purge" });
		assert.equal(env.document.querySelector(".sa-dialog"), null, "确认后对话框应关闭");
		assert.ok(env.document.querySelector(".sa-panel .sa-empty"), "删空后列表显示空态");
		assert.equal(confirmCalls, 0);
		assert.match(env.document.querySelector(".sa-toast").textContent, /已删除该会话文件/);
	});

	it("面板搜索过滤 + 分组头折叠", async (t) => {
		const records = [
			archivedRecord(sessionFile("-e--alpha", UA), { id: "a1", title: "Alpha chat" }),
			archivedRecord(sessionFile("-e--alpha", UC), { id: "a2", title: "Beta chat" }),
			archivedRecord(sessionFile("-d--beta", UB), { id: "b1", title: "Gamma notes" }),
		];

		const env = await mountDom(t, {
			html: SECTION_ACTIONS_HTML,
			state: () => ({ records }),
		});
		await settle();

		await openPanelFromSlot(env);

		const count = () => env.document.querySelectorAll(".sa-item").length;
		const items = () => [...env.document.querySelectorAll(".sa-item .sa-item-title")].map((el) => el.textContent);
		const heads = () => [...env.document.querySelectorAll(".sa-group-h")];

		assert.equal(heads().length, 2, "按项目文件夹分组");
		assert.equal(heads()[0].querySelector(".sa-group-name").textContent, "alpha");
		assert.equal(heads()[0].querySelector(".sa-group-count").textContent, "2 条");
		assert.equal(heads()[1].querySelector(".sa-group-name").textContent, "beta");
		assert.deepEqual(items(), ["Alpha chat", "Beta chat", "Gamma notes"]);
		assert.equal(count(), 3, "默认显示全部 3 条（顶部不再有总数，只有分组条数）");

		const search = env.document.querySelector(".sa-search");
		search.value = "gamma";
		search.dispatchEvent(new env.window.Event("input"));
		await settle(2);

		assert.deepEqual(items(), ["Gamma notes"], "搜索框应过滤列表（标题/路径都参与匹配）");
		assert.equal(count(), 1, "搜索后只剩匹配的 1 条");

		search.value = "";
		search.dispatchEvent(new env.window.Event("input"));
		await settle(2);
		assert.equal(items().length, 3, "清空搜索应恢复全部");

		assert.equal(heads()[0].dataset.open, "1");
		heads()[0].click();
		await settle(2);

		assert.equal(heads().length, 2, "折叠后分组头仍在");
		assert.equal(heads()[0].dataset.open, "0");
		assert.deepEqual(items(), ["Gamma notes"], "折叠的分组不渲染条目");
		assert.equal(count(), 1, "折叠的分组不渲染条目，DOM 里只剩另一组的 1 条");

		heads()[0].click();
		await settle(2);
		assert.equal(heads()[0].dataset.open, "1");
		assert.equal(items().length, 3, "再点一次展开");
	});
});

describe("行文本清洗", () => {
	it("行尾日期 say ok11/10 也剥掉（不只是 HH:MM）", async (t) => {
		const path = sessionFile("-e--elsewhere", UB);
		const key = sessionKey(path);
		const env = await mountDom(t, {
			html: rowHtml({ id: "dateTail", title: "E:/work/dir", text: "say ok11/10", sessionKey: key }),
			state: () => ({ records: [] }),
			onRequest: (call) =>
				call.method === "POST" && call.path === "/archive"
					? { body: { ok: true, created: true, record: archivedRecord(call.body.path) } }
					: null,
		});
		await settle();
		env.document.querySelector('[data-testid="dateTail"] button.lp-sa-btn').click();
		await settle();
		const call = env.calls.find((item) => item.path === "/archive");
		assert.ok(call);
		assert.equal(call.body.title, "say ok", "日期尾巴要剥掉");
	});
});

describe("恢复：折叠项目", () => {
	it("行不在 DOM（项目折叠）→ 点开对应项目 → 等行出现 → 闪烁", async (t) => {
		const folder = "--E--work-project-b--";
		const file = sessionFile(folder, U2);
		const html = `
			<div class="lp-row lp-project-head-row" data-session-key="">
				<button type="button" class="lp-project-header-item" data-project-path="E:\\work\\project-b">
					<span class="lp-project-chevron"></span><span>project-b</span>
				</button>
			</div>
			${SECTION_ACTIONS_HTML}`;
		const env = await mountDom(t, {
			html,
			state: () => ({
				records: [archivedRecord(file, { title: "被折叠的会话" })],
				settings: { defaultDays: 30 },
			}),
			onRequest: (call) => (call.path === "/restore" ? { body: { ok: true, records: [] } } : null),
		});

		// 展开前的“宿主”行为：点击项目头 → 渲染出该项目的会话行
		const headRow = env.document.querySelector(".lp-project-head-row");
		const headerBtn = headRow.querySelector(".lp-project-header-item");
		const chevron = headRow.querySelector(".lp-project-chevron");
		let expanded = false;
		let switchedProject = false;
		// 宿主语义：点标题 = 切换项目（set_cwd），点箭头 = 折叠/展开。恢复流程只许点箭头。
		headerBtn.addEventListener("click", () => {
			switchedProject = true;
		});
		chevron.addEventListener("click", (event) => {
			event.stopPropagation();
			expandForTest();
		});
		const expandForTest = () => {
			if (expanded) return;
			expanded = true;
			headRow.classList.add("is-expanded");
			const holder = env.document.createElement("div");
			holder.innerHTML = rowHtml({ title: file, text: "被折叠的会话", del: true });
			const row = holder.firstElementChild;
			// jsdom 没有布局：让「可见性」检查通过
			row.getClientRects = () => [{ width: 100, height: 20 }];
			headRow.after(row);
		};

		await settle();
		await openPanelFromSlot(env);
		const restoreBtn = env.document.querySelector('.sa-item [data-role="restore"]');
		assert.ok(restoreBtn, "面板里应有恢复按钮");
		restoreBtn.click();
		// 恢复流程里有真实的帧/轮询等待（16ms 帧 + 80ms 轮询），这里给到真实时间
		await new Promise((resolve) => setTimeout(resolve, 300));
		await settle();

		assert.equal(expanded, true, "恢复后应自动展开对应项目");
		assert.equal(switchedProject, false, "展开只能点箭头，不能点标题（那样会切换项目）");
		const flashed = env.document.querySelector(".lp-row.sa-flash");
		assert.ok(flashed, "恢复的那一行应带闪烁标记");
	});
});
