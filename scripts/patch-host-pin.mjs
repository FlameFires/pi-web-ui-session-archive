/**
 * 宿主侧补丁：置顶会话跨项目串台（pinned session leaks into the wrong project）。
 *
 * 用法：
 *   node scripts/patch-host-pin.mjs            # 打补丁（幂等，已有标记就跳过）
 *   node scripts/patch-host-pin.mjs --revert   # 撤销（从最近一次 .bak-pinpatch 备份还原）
 *   node scripts/patch-host-pin.mjs --check    # 只看当前是否已打
 *
 * 目标文件：<pi-web-ui>/dist/server/agent-service.js
 * 升级 pi-web-ui 后必须重跑一次（升级会覆盖 dist）。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const MARK = "pi-web-pin-cwd-fix";

function resolveHostFile() {
	const explicit = process.env.PI_WEB_HOST_DIR;
	if (explicit) return join(explicit, "dist", "server", "agent-service.js");
	try {
		const pkg = require.resolve("pi-web-ui/package.json");
		return join(dirname(pkg), "dist", "server", "agent-service.js");
	} catch {
		/* 继续找 */
	}
	const candidates = [
		join(process.env.APPDATA ?? "", "npm", "node_modules", "pi-web-ui"),
		join(process.cwd(), "node_modules", "pi-web-ui"),
	];
	for (const dir of candidates) {
		const file = join(dir, "dist", "server", "agent-service.js");
		if (existsSync(file)) return file;
	}
	return "";
}

const PATCHES = [
	{
		name: "pinSession 用会话自身 cwd",
		from: `    async pinSession(path, pinned) {
        const targetPath = resolve(path);
        this.stateStore?.setSessionPinned(this.cwd, targetPath, pinned);`,
		to: `    async pinSession(path, pinned) {
        const targetPath = resolve(path);
        /* ${MARK}: 置顶记到会话自己所属的项目，而不是当前 cwd */
        let pinCwd = this.cwd;
        try {
            const headerCwd = restoreWorkspaceUriFromSessionDir((await readCwdFromSessionHeader(targetPath)) ?? "");
            if (headerCwd)
                pinCwd = headerCwd;
        }
        catch { }
        this.stateStore?.setSessionPinned(pinCwd, targetPath, pinned);`,
	},
	{
		name: "预打开置顶会话时校验归属项目",
		from: `        const pinnedPaths = botExecution ? [] : (cs.stateStore?.getPinnedSessions(cwd) ?? []);
        const maxOpenConversations = getMaxOpenConversations();`,
		to: `        /* ${MARK}: 只预打开真正属于当前项目的置顶会话（历史上跨项目钉的脏数据在这里被过滤掉） */
        const pinnedPaths = [];
        for (const pinnedPath of botExecution ? [] : (cs.stateStore?.getPinnedSessions(cwd) ?? [])) {
            try {
                const owner = restoreWorkspaceUriFromSessionDir((await readCwdFromSessionHeader(resolve(pinnedPath))) ?? "");
                if (!owner || normalizePathKey(owner) === normalizePathKey(cwd))
                    pinnedPaths.push(pinnedPath);
            }
            catch {
                pinnedPaths.push(pinnedPath);
            }
        }
        const maxOpenConversations = getMaxOpenConversations();`,
	},
];

const mode = process.argv.includes("--revert") ? "revert" : process.argv.includes("--check") ? "check" : "apply";
const file = resolveHostFile();
if (!file || !existsSync(file)) {
	console.error("找不到宿主 agent-service.js，可用 PI_WEB_HOST_DIR 指定 pi-web-ui 包目录");
	process.exit(1);
}

if (mode === "check") {
	const text = readFileSync(file, "utf8");
	console.log(`${text.includes(MARK) ? "已打" : "未打"}补丁：${file}`);
	process.exit(0);
}

if (mode === "revert") {
	const dir = dirname(file);
	const backups = readdirSync(dir)
		.filter((name) => name.startsWith("agent-service.js.bak-pinpatch-"))
		.sort();
	const latest = backups.at(-1);
	if (!latest) {
		console.error("没有 .bak-pinpatch-* 备份可还原");
		process.exit(1);
	}
	copyFileSync(join(dir, latest), file);
	console.log(`已从 ${latest} 还原：${file}`);
	process.exit(0);
}

const original = readFileSync(file, "utf8");
if (original.includes(MARK)) {
	console.log(`补丁已存在，跳过：${file}`);
	process.exit(0);
}

let patched = original;
for (const patch of PATCHES) {
	if (!patched.includes(patch.from)) {
		console.error(`锚点未命中（宿主版本可能变了）：${patch.name}`);
		process.exit(2);
	}
	patched = patched.replace(patch.from, patch.to);
}

const backup = join(dirname(file), `agent-service.js.bak-pinpatch-${Date.now()}`);
copyFileSync(file, backup);
writeFileSync(file, patched);
console.log(`已补丁：${file}`);
console.log(`备份  ：${backup}`);
console.log("重启 pi-web-ui 生效。升级宿主后需重跑本脚本。");
