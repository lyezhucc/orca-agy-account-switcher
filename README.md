# 反重力多账号一键切换（Orca 插件 v0.2.9）

专为在 Orca 中同时使用多个 Google Antigravity (`agy`) 账号的用户打造的原生插件（插件 ID：`local.agy-account-switcher`）。

## 解决的核心痛点（同时覆盖「对话框」与「终端」）

1. **已打开的对话框/终端换号不生效**：Orca 原生切号只对新开会话生效；若旧「对话框（Chat）」正在回复或因额度耗尽卡住，后台 `agy acp` 进程不会退出，继续发消息仍走旧账号。
2. **后台旧对话刷新 Token 把账号偷改回去（导致新对话报错打不开）**：只要仍有任意旧号对话框（`agy acp`）或终端（`agy`）进程存活，其自动刷新 OAuth Token 时会覆写系统凭证，不仅把账号拉回旧号，还会触发 Orca 的 `The native Antigravity account changed` 启动锁死报错。

> **重要说明**：面板内所有账号切换均由你**手动点击触发并二次确认**（注：若通过 Orca 命令面板直接触发快捷命令则立即执行）——本插件**不会**在额度用完时自行替你选新号切换。界面上的「说完跟进新号」是指：当你手动点切换账号时，正在回复中的窗口会等当前这句说完再自动跟进同步到你刚选的新账号。

## 对 Orca「对话框（原生 Chat）」的无损换号与双通道诊断

Orca 原生 Antigravity 对话存在两套底层登录通道，本插件按 `ORCA_AGENT_SESSION_ID === orcaSessionId` 做 **1-on-1 精确绑定**，并将宿主共号对话框提升为一等公民：

- **共用本机 `agy` 账号池模式（`chatUsesAgy: true`，推荐）**：
  - **未忙对话框立即无损同步**：手动点切换账号后，立即释放未在回复的对话框旧连接（**不关闭聊天标签页、100% 保留聊天记录**），在原对话框直接发下一句话即走已选新账号；
  - **忙中/卡住对话框支持「说完跟进新号」与「单点立即切」**：手动换号遇到正在回复的对话框时，默认等当前这句回复结束就自动跟进同步到已选新号（监听 `paneKey`/`sessionId` 状态秒级响应）；若因旧号额度耗尽卡住，可在「对话」页直接点该对话框右侧的 **`立即切到当前号`** 一键切换；
  - **防旧会话回改锁回保护**：当后台仍在长跑的旧会话刷新登录态覆写了系统凭证时，自动把系统凭证锁回你已选定的账号，彻底杜绝打开新对话框报错。
- **Orca 独立单账号模式（`chatUsesAgy: false` / `agy_acp_server.par` + `acp_token.json`）**：
  - 若电脑未安装/未登录命令行 `agy`，或在 Orca 设置中将 `Antigravity Chat` 设为了独立单账号登录，插件会在**面板最顶部直接弹出醒目设置指引**，一步引导切回多账号共享模式，不再让用户白点半天疑惑为什么对话框没变。
- **后台探活去噪**：自动过滤 Orca 每 5 分钟拉起约 4 秒的短命 `agy acp` 探活进程与命名辅助进程，不在界面制造闪烁鬼影。

## 核心能力与安全交互设计

- **就地确认手动切换（防误触且零跨屏跳转）**：
  - 账号页每张卡片提供直观的 **`切换`** 按钮，点击即在当前卡片正下方就地展开确认条；也可点击顶部的 **`一键选余量最多账号`** 挑出最充裕账号后确认切换（平时不会自动替你换号）。
  - **所有批量换号与更新按钮均先展示影响预览**（立即重启几个空闲终端、运行中终端如何处理；中途切换运行中终端策略会实时刷新预览而不关闭确认框），点击 `确认切换/确认更新` 后才真正执行。
- **全维度额度与异时快照诚实可视化**：
  - `<Tabs>` 分栏收纳 `账号` 与 `终端`；
  - 所有账号严格按独立模型池展示主池（`Gemini 5h` / `Gemini 周` 双进度条 + 精确到分钟的重置倒计时）与副池（`Claude/GPT 5h · 周` 及活跃窗口重置倒计时），绝不因 Orca 顶层跨池汇总产生池间串值，未启用计时的 `0%` 空闲池（`resetsAt: 0`）准确展示为 `0%`；
  - 非当前账号单独标注 `更新于 X小时前` 时效、主/副池已过重置时刻的旧快照自动去红警标明 `已重置（切换后更新）`；尚未读取过额度的新号标为 `未读取` 且与历史报错号均可手动点选切换刷新，同时自动挑号保持“实测未过期 0% 优先于过期推算”；
  - 底部状态栏仅作纯只读展示（不可点击，防误触换号），悬停可查看当前反重力账号、5h/周额度与旧号/漂移提醒，所有操作收口在右侧「反重力换号」面板。
- **跨工作区无损原地换号 + 自动回滚**：
  - 通过 `orca terminal send` 跨任意工作区恢复原 Tab 对话，不受插件 Host API 仅限当前聚焦工作区的限制，也不抢夺屏幕焦点。
  - 遵循 **先停旧进程（复核 PID 启动时间 + `SIGTERM` 等父 Shell 回到提示符）→ 再切全局账号 → 再并行原位拉起（`stty sane; agy ... --conversation <id>`）**；若切号失败则自动回滚恢复已停终端，失败项展示永不截断的手动恢复代码块。
- **白名单命令重构与 Fail-Closed 保护**：
  - 仅重放安全持久标志并补齐 `--conversation <id>`，剥离 `-i`/`--prompt-interactive`/`--new-project` 与非交互子命令，杜绝二次重放初始 Prompt。
  - CLI/`lsof` 故障时 Fail-Closed 绝不误杀 `working` 终端或误清队列；`working`/`blocked`/`unknown` 终端默认安全排队等待空闲后自动补切。
- **快慢双通道巡检与新版本一键升级**：
  - 本地进程快通道默认 15s（使用 `/bin/ps ucomm=` 防 macOS 16 字符截断，并结合 `/usr/sbin/lsof -n -P` 同时追踪 `cli-*.log` 与 `acp-server-*.log`）；
  - 远程额度慢通道默认 120s（存在旧账号进程时自动缩至最高 45s），内置 singleflight 与 `accountMutationEpoch` 防旧缓存倒灌；
  - 后台低频检测 GitHub 最新正式版 Tag，有更新时弹一次桌面提醒并在面板顶部展示 **`立即更新`** 按钮，无需命令行即可一键热升级（若未来版本新增权限则自动展示确认命令）。

## 安装与分享

由于本插件使用 `trusted-worker`（本机独立 Node 进程）并申请工作区与通知等权限，其他人在首次安装时需核对权限指纹并手动加 `--approve <fingerprint>` 确认授权。

### 方式一：从 GitHub 直接安装（最推荐）

在 Orca 已打开的状态下执行：

```bash
# 第一步：先拉取清单并查看授权摘要与指纹（会退出码 3 提示需要 --approve）
orca plugin install lyezhucc/orca-agy-account-switcher

# 第二步：确认权限后，复制上一步提示中的 --approve 命令执行授权安装
orca plugin install lyezhucc/orca-agy-account-switcher --approve <fingerprint>

# 第三步：打开右侧边栏「反重力换号」面板
orca plugin open github.lyezhucc.agy-account-switcher --panel switcher
```

后续发布新版本时，插件会自动弹出新版本提醒，并在「反重力换号」面板顶部显示 **`立即更新`** 按钮，**点击一下即可自动升级生效**（也可随时在终端运行 `orca plugin update --all`）。

### 方式二：从本地目录安装（离线/源码开发）

1. 克隆或解压本目录（注意确保目录内无任何 symlink）。
2. 进入目录运行：

```bash
cd orca-agy-account-switcher
orca plugin install .            # 查看权限并获取指纹
orca plugin install . --approve <fingerprint>
orca plugin open local.agy-account-switcher --panel switcher
```

## 验证与本地热更新

```bash
# 1. 类型检查（0 error；无全局 tsc 时用 npx --yes --package=typescript tsc --noEmit，勿裸跑 npx tsc）
tsc --noEmit

# 2. 校验 / 可打包性检查 / 单测（27 项）/ 3 场景静态检查
orca plugin validate . --json
orca plugin inspect . --json
orca plugin test . --json
orca plugin check . --json

# 3. 权限/命令未变化时热更新升级
orca plugin install . --json
```

## 配置项（Orca 插件设置）

- `processPollIntervalSec`（默认 `15` 秒）：本地进程扫描周期
- `quotaPollIntervalSec`（默认 `120` 秒）：远程额度刷新周期
- `workingPolicy`（默认 `queue`）：手动点切换账号遇到正在回复的对话/终端时的处理方式（等回复完跟进同步到已选新号 / 跳过忙中对话 / 立即中断并换号）
- `autoGuardDrift`（默认 `true`）：旧进程刷新 Token 顶回旧号时自动锁回已选账号并提醒
- `notifyOnComplete`（默认 `true`）：手动换号或忙中对话回复完跟进同步后发送通知

## 配套工具

想在每个 `agy` 终端输入框正下方实时看到上下文进度条、Prompt 缓存过期时刻与 5h/周剩余限额，推荐搭配使用：

- **[agy-statusline](https://github.com/lyezhucc/agy-statusline)** — Antigravity CLI 极简 2 行终端底部 HUD（纯 Python 零依赖，一行命令安装）。
