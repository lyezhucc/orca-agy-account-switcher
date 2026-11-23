# 086_Orca反重力账号切换 — 项目协作与红线文档

> 本仓为 Orca 插件根目录，Orca 安全校验硬性禁止目录或 Git 树包含任何 symlink（会报 `symlink not allowed in plugin content`），因此本仓**不建 `CLAUDE.md` 软链**，仅以本 `AGENTS.md` 为唯一指令真源。
> 当前稳定运行版本：**`v0.2.7`**（插件 ID：`local.agy-account-switcher`，最后对齐日期：`2026-11-23`）。

## 项目定位与结构

原生 Orca 插件（`execution: "trusted-worker"`，`ui: "components"`），用于在 Orca 中统一查看多 Antigravity (`agy`) 账号额度、防止后台旧进程刷新 OAuth Token 导致全局账号回跳，实现跨工作区 `agy` 终端无损原地换号，并对 Orca 原生 Chat 对话（区分宿主 `agy` 模式与托管独立账号模式）提供精细 1-on-1 观测而不强杀对话。

| 文件 | 职责 |
|---|---|
| `orca-plugin.json` | Manifest v2 清单：声明 6 项最小权限、面板 `switcher`、状态栏 `agy-account-status`、5 条命令、2 个事件订阅、5 项设置 |
| `src/protocol.ts` | Worker 与 Panel 共享强类型通信协议（`SwitcherSnapshot`、`AccountBucketGroup`、`usageUpdatedAt`、`ChatEngine`、`PluginRequests`） |
| `src/command-builder.ts` | 纯函数模块：邮箱规范化、命令分类（含托管 `agy_acp_server` 识别与后台 `acp` 探活去噪 `shouldIgnoreUnstructuredAcpProbe`）、白名单重启命令重构、窗口过期判定与单号快照龄（`isQuotaWindowExpired`、`formatSnapshotAge`、`formatResetCountdown`）、异时余量比较/最空闲账号选择（`compareAccountsByHeadroom`、`pickBestAccount`）、状态栏计算与切换影响评估（`computeSwitchImpact`） |
| `src/system.ts` | macOS 本机与 Orca CLI 适配层：`orca account/terminal/agent` 调用（透传 `usage.updatedAt`、拆出未读新号 `unfetched`、保留 `orcaSessionId` 与 `chatUsesAgy`）、`/bin/ps`（解析 `ORCA_AGENT_SESSION_ID`/`ORCA_STRUCTURED_SESSION`/`GEMINI_HOME`）与 `/usr/sbin/lsof` 扫描、PID 复用校验、Shell 前台进程组检测 |
| `src/switcher.ts` | 核心换号服务：单次同步互斥锁、`executeSwitchAllLocked` 4 步状态机、失败自动回滚、队列指数退避重试、快慢双通道轮询、`ORCA_AGENT_SESSION_ID === orcaSessionId` 原生 Chat 1-on-1 精确绑定 |
| `src/worker.ts` | Worker 入口：递归 `setTimeout` + `pollGeneration` 防双定时器、事件防抖与统一 `Disposable` 清理 |
| `src/panel.tsx` | 原生 Components 面板：先选账号再点闪电、全量操作影响预览二次确认、Tabs 分栏（「账号 / 终端」）、全账号对称展示 `Gemini` 与 `Claude/GPT` 额度、每卡独立快照龄、过期窗口去假红警与 `unfetched`/异常号手动切入解死锁 |
| `src/panel.check.ts` | `orca plugin check` 的 3 套预览场景（`synced`（含过期快照与时效）/ `outdatedAlert`（含原生 Chat 演示）/ `driftAlert`） |
| `src/worker.test.ts` | Worker 核心状态机、红队攻防、异时快照选号、状态栏只读防误触与多原生 Chat/托管隔离单元测试（16 项） |
| `src/panel.test.tsx` | 面板选号、确认框、防误触、恢复命令、过期去红警与未读新号解死锁交互测试（3 项） |
| `src/node-shims.d.ts` | 轻量 Node 内置模块类型垫片（供无 `@types/node` 环境下严格 `tsc --noEmit` 通过） |

## 架构红线与实测踩坑

1. **禁止改用 Host API `terminal.sendText` 重启跨工作区终端**：
   - Orca 主进程对插件 Host API `terminal.sendText` 强制校验当前聚焦 `active worktree`，跨工作区会报 `terminal is outside the active worktree`。
   - 跨工作区原地重启必须继续走 `trusted-worker` 调用官方 CLI `orca terminal send --terminal <id> --text=... [--enter] --json`。
2. **macOS `ps` / `lsof` / `pgrep` 与宿主 API 长度兼容约束**：
   - `ps -o comm=` 非末列在 macOS 上硬截断，且即使使用 `ucomm=` 处于末列，macOS XNU 内核 `p_comm` 本身也只保留最多 16 字符（实测 18 字符可执行名 `agy_acp_server.par` 在 `ps -o ucomm=` 下会被截断为 `agy_acp_server.p`）。因此首轮 `ucomm=` 筛选必须兼容截断前缀，并在 `-ww args=` 拿到完整命令行后再用 `isManagedAcpCommand` 二次复核。
   - `/usr/sbin/lsof -n -P -p <多PID>` 只要列表中含 1 个刚退出的短命进程就会返回 exit code `1`，但 `stdout` 仍包含其他活进程完整 FD 信息；不可直接按 `code !== 0` 整批丢弃，必须按非空 `stdout` 解析并结合存活 PID 校验。
   - 不可使用 `pgrep` 检测子进程或父 Shell 是否空闲（macOS `pgrep` 会排除自身祖先链）；`waitForShellReady` 仅检查直接子进程是否带有前台进程组 `+` 标记（`stat.includes('+')`）。
   - Orca 宿主对 `statusBar.update` 有严格长度限制（`text <= 64`，`tooltip <= 256`），必须通过 `fitSingleLine` / `fitTooltipLines` 约束，严禁直接拼接长列表导致状态栏静默拒收。
3. **单次独占锁 + 原位回滚 + 永不截断恢复命令**：
   - 所有换号入口（`switchAll` / `switchBest` / `syncToCurrent` / `forceDrainQueue` / `restartOne` / `quickSyncCommand`）必须全程持有单次 `withExclusiveLock` 内部执行 `executeSwitchAllLocked`，严禁锁外预处理或分阶段放锁。
   - 若第 2 步 `selectAntigravityAccount` 失败，必须并发回滚拉起第 1 步已停止的终端；任何无法自动恢复的命令写入 `recoveryCommands` 且面板完整渲染 `Code block`，严禁截断。
4. **交互安全红线（所有批量操作必经影响预览确认）**：
   - 账号列表卡片仅提供零风险「选择/取消选中」状态；顶部闪电主按钮与预警/漂移条按钮点击后一律先弹出影响预览确认卡片（由 `computeSwitchImpact` 与后端过滤口径保持 100% 一致），用户显式确认后才发出切换请求。
   - 面板对每个账号完整展示所有模型池（`Gemini` 5h/周进度条 + `Claude/GPT` 5h/周汇总），不得因 `0%` 隐藏副池。
   - **多账号异时快照诚实展示与未读新号不锁死**：必须保留每账号独立的 `usage.updatedAt`（底栏标注“当前号额度更新于”）；主/副池、确认框与状态栏统一按 `isQuotaWindowExpired` 去假红警（标明“已过重置/上轮 X%”而不伪造实测 `0%`）；新添加未读账号（`usage == null`）映射为 `unfetched`，与历史异常号均开放手动点选切入刷新，而 `pickBestAccount` 仍严格仅选 `status === 'ok'` 且实测 `0%` 优先于过期推算。
   - **底部状态栏只读防误触**：底部状态栏 `agy-account-status` 必须保持纯只读展示（严禁在 `statusBarItems` 上绑定会触发换号或同步的 `command`），且 tooltip 须明确标明“反重力 (AGY)”身份并引导用户至右侧「反重力换号」面板操作，杜绝用户误点直接触发副作用。
5. **插件安装、热更新与禁止 symlink**：
   - **严禁在插件目录或 Git 树内放置任何 symlink（如 `CLAUDE.md -> AGENTS.md`）或 Git submodule**，否则 `orca plugin inspect` / `install` / `release-entry` 会直接拒绝（`symlink not allowed in plugin content`），`validate` 默认不拦截此项，必须同时用 `inspect` 验证！
   - 在不改变 `orca-plugin.json` 中 `capabilities`、`execution`、`commands`、`statusBarItems` 等清单贡献的前提下，执行 `orca plugin install . --json` 可热升级已批准插件（保持 `status: running`）。
   - 若需修改权限/命令，必须产出新 `consentFingerprint` 并由用户明确确认 `--approve`。严禁在开发验证后留下 `dev load` 覆盖层，也不要对用户正在使用的已安装插件随意跑 `dev unload`（会把已安装版本状态重置为 `pending`）。
6. **凭据安全**：
   - 仅从日志 `applyAuthResult: email=...` 提取登录邮箱用于对齐识别；严禁读取、解析或输出任何 OAuth Token、vault、keyring、`.env` 或凭据原值。

## 本仓开发验证流程

每次修改代码、清单或文档后按顺序执行：

```bash
# 1. 类型检查（须 0 error）
npx tsc --noEmit

# 2. Orca 插件校验 + 打包/可分发检查 + 单测 + 3 场景预览（须全绿且 0 warning）
orca plugin validate . --json
orca plugin inspect . --json
orca plugin release-entry . --json   # 针对已提交 HEAD 验证可作为 Git/Catalog 发布
orca plugin test . --json
orca plugin check . --json

# 3. 热安装更新 + 打开面板截图验货
orca plugin install . --json
orca plugin open local.agy-account-switcher --panel switcher --json
```

## 仓库协作规范

- 提交与发布新版本时同步更新 `orca-plugin.json` 版本号并打对应 `vX.Y.Z` tag，方便已安装用户通过 `orca plugin update` 升级。
- 严禁在测试、预览场景或文档中写入任何真实个人邮箱、OAuth 凭据或本机绝对路径。
