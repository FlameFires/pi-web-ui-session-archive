# 宿主补丁：置顶会话跨项目串台

> **状态**：已在本机 `pi-web-ui` 的 `dist` 上打补丁并验证语法；上游未修。
> **性质**：这是 **宿主（pi-web-ui）的 bug**，与本仓库的 `session-archive` 插件无关。
> **脚本**：`scripts/patch-host-pin.mjs`（幂等，可 `--check` / `--revert`）。

## 症状

项目 A 的列表里冒出**属于项目 B 的会话**，还带 `当前` 徽标和 📌：

```
▾ Global                      18:30
   自制归档插件                  18:29
   …
 [当前] say ok               📌 11/10     ← 实际属于 E:\tmp\pitest
```

## 证据

1. 会话文件的 header 写明归属：

   ```json
   // ~/.pi/agent/sessions/--E--tmp-pitest--/2026-11-10T09-08-14-810Z_01a1c4b7-….jsonl
   {"type":"session", … , "cwd":"E:\\tmp\\pitest"}
   ```

2. 同一条会话被钉进**两个** cwd 键（`~/.pi-web/client-state.json`）：

   ```json
   "pinnedSessions": {
     "e:\\agent\\pi-web-ui\\global": ["…--E--tmp-pitest--\\…jsonl"],
     "e:\\tmp\\pitest":              ["…--E--tmp-pitest--\\…jsonl"]
   }
   ```

## 根因（`dist/server/agent-service.js`）

写入端按**当前 cwd** 记账，不看会话自己的归属：

```js
async pinSession(path, pinned) {
  const targetPath = resolve(path);
  this.stateStore?.setSessionPinned(this.cwd, targetPath, pinned);   // ← this.cwd
```

读取端**无条件**预打开当前 cwd 的置顶列表，也不校验 header：

```js
const pinnedPaths = botExecution ? [] : (cs.stateStore?.getPinnedSessions(cwd) ?? []);
for (const p of pinnedPaths) { … conv.pinned = true; conv.listed = true; … }
```

两处都不校验 → 别的项目的会话被“搬”进当前项目。
旁证：同文件的 `deleteSession()` 会用 `restoreWorkspaceUriFromSessionDir(await readCwdFromSessionHeader(abs))` 还原真实 cwd，说明宿主**本来就能**读到归属，只是 pin 这条路径没有用。

## 补丁（两处，均带 `pi-web-pin-cwd-fix` 标记）

**1. `pinSession` 用会话自身 cwd**

```js
async pinSession(path, pinned) {
  const targetPath = resolve(path);
  /* pi-web-pin-cwd-fix: 置顶记到会话自己所属的项目，而不是当前 cwd */
  let pinCwd = this.cwd;
  try {
    const headerCwd = restoreWorkspaceUriFromSessionDir((await readCwdFromSessionHeader(targetPath)) ?? "");
    if (headerCwd) pinCwd = headerCwd;
  } catch { }
  this.stateStore?.setSessionPinned(pinCwd, targetPath, pinned);
```

**2. 预打开置顶会话前校验归属**

```js
/* pi-web-pin-cwd-fix: 只预打开真正属于当前项目的置顶会话（历史上跨项目钉的脏数据在这里被过滤掉） */
const pinnedPaths = [];
for (const pinnedPath of botExecution ? [] : (cs.stateStore?.getPinnedSessions(cwd) ?? [])) {
  try {
    const owner = restoreWorkspaceUriFromSessionDir((await readCwdFromSessionHeader(resolve(pinnedPath))) ?? "");
    if (!owner || normalizePathKey(owner) === normalizePathKey(cwd)) pinnedPaths.push(pinnedPath);
  } catch {
    pinnedPaths.push(pinnedPath);
  }
}
```

第 2 条同时**兜住了历史脏数据**：`client-state.json` 里跨项目钉错的记录不再被拉进当前项目，不必手工清理。

## 使用

```bash
# 打补丁（幂等；锚点对不上会报「锚点未命中」，说明宿主改过这段代码，需要重新对照）
PI_WEB_HOST_DIR="/path/to/node_modules/pi-web-ui" node scripts/patch-host-pin.mjs

# 只看状态
PI_WEB_HOST_DIR="…" node scripts/patch-host-pin.mjs --check

# 撤销（从最近一次 agent-service.js.bak-pinpatch-* 还原）
PI_WEB_HOST_DIR="…" node scripts/patch-host-pin.mjs --revert
```

不传 `PI_WEB_HOST_DIR` 时脚本会按 `require.resolve("pi-web-ui/package.json")` → `%APPDATA%/npm` → `./node_modules` 依次找。

- 打完必须 **重启 pi-web-ui**（服务端模块只在启动时 import）。
- **升级 pi-web-ui 会覆盖 `dist`，补丁丢失**，重启后重跑一次即可；`--check` 可确认。
- 备份文件：`dist/server/agent-service.js.bak-pinpatch-<timestamp>`。

## 本机已顺手清理的历史数据

`~/.pi-web/client-state.json` 里的错钉记录被迁移到会话自己所属的项目（已备份 `client-state.json.bak-pinfix-*`、`client-state.json.bak-pinkey-*`）：

```
c:\users\vi\desktop\qiandao        → 1 条（本就正确）
e:\mkmo\self_rusher\千岛\当前模板    → 1 条（本就正确）
E:\tmp\pitest                      → 1 条（从 global 搬回；重复的大小写键已合并）
```

迁移脚本逻辑：按每个会话文件的 header `cwd` 判断归属，错的从当前 cwd 列表移除并挂到正确 cwd；`cwd` 键按规范化路径去重。

## 验证步骤

1. 重启 pi-web-ui，刷新所有窗口
2. Global 项目下不应再出现 `say ok`（🎉 这条就是被错钉的）
3. 把某个属于项目 B 的会话在项目 A 视图下置顶 → 它**不应该**出现在 A 的列表里；切到项目 B 看，它在那里置顶

## 上游 issue 草稿（给 xing-shuyin/pi-web-ui）

> **标题**：置顶会话按当前 cwd 记账，导致别的项目的会话被拉进当前项目
>
> **复现**
> 1. 在项目 A 的视图下打开（或先 pin 住）一条属于项目 B 的会话
> 2. 置顶它
> 3. 刷新 / 重连 → 该会话出现在 A 的项目列表里，带 `当前` 徽标；`client-state.json` 的 `pinnedSessions` 里它同时挂在 A 和 B 的 cwd 键下
>
> **期望**：置顶登记到会话自己所属的项目（按 session header 的 `cwd`），或至少在预打开置顶会话时校验 header cwd 与当前 cwd 一致。
>
> **定位**
> - `server/agent-service.ts` 的 `pinSession()`：`setSessionPinned(this.cwd, …)` 未使用 `readCwdFromSessionHeader()`
> - 同一文件里「预打开置顶会话」的循环（`getPinnedSessions(cwd)` → `for (const p of pinnedPaths)`）未校验归属
> - 参考同文件 `deleteSession()` 已有的 `restoreWorkspaceUriFromSessionDir(await readCwdFromSessionHeader(abs))` 写法
>
> **影响**：跨项目串台、会话被误开（会切 cwd）、脏 pin 记录在多个项目间复制（本次本机就出现同一条会话同时钉在两个 cwd 下，且大小写不同的重复键）。
>
> **临时绕过**：在正确项目视图下取消置顶 → 再到目标项目重新置顶；或直接改 `client-state.json` 的 `pinnedSessions`（需重启宿主）。
