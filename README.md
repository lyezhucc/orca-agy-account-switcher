# 反重力多账号一键切换（Orca 插件 v0.2.8）

专为在 Orca 中同时使用多个 Google Antigravity (`agy`) 账号的用户打造的原生插件（插件 ID：`local.agy-account-switcher`）。

## 解决的两大痛点

1. **多终端逐个手动换号繁琐**：Orca 原生切号只对新开终端生效，已运行的 `agy` 终端启动时已把旧账号 OAuth 凭证缓存在内存里。
2. **切号后被后台旧进程顶回旧号**：只要仍有任意旧号 `agy` 终端（或以宿主 `agy` 模式运行的原生 Chat `agy acp` 进程）存活，其每小时自动刷新 OAuth Token（`applyAuthResult`）时会覆写全局凭证，将当前账号拉回旧号。

## 对 Orca 原生 Chat 对话的精准识别与能力边界（路线 A）

Orca 原生 Antigravity 对话存在两套底层引擎，本插件按 `ORCA_AGENT_SESSION_ID === orcaSessionId` 做 **1-on-1 精确绑定**（同工作区开多个对话也能分清各自工作区、标题与 `干活中/空闲` 状态，不按路径盲猜），并严格**不强杀任何原生 Chat 进程**：

- **宿主 `agy` 模式（`chatUsesAgy: true`）**：原生 Chat 直接跑本机 `agy acp`，与终端共享系统凭据。在切号时 Orca 主程序会自动尝试释放空闲 Chat；正在 `干活中` 的旧号 Chat 会留在「终端 → 原生 Chat 对话」清单并精确高亮警示，等其空闲或手动重开聊天标签后即可对齐。
- **Orca 托管引擎模式（`agy_acp_server.par` + `acp_token.json`）**：使用 Orca 隔离目录的独立 OAuth 凭据，**不与系统/终端账号共享，既不会顶回终端账号，也不会随本面板切换**。面板中标注为 `独立托管 / 独立凭据`，不计入旧号或未识别邮箱。
- **后台探活去噪**：自动过滤 Orca 每 5 分钟拉起约 4 秒的短命 `agy acp` 探活进程与命名辅助进程，不在界面制造闪烁鬼影。

## 核心能力与安全交互设计

- **先选后切 + 影响预览确认（防误触）**：
  - 账号页每张卡片提供零风险的 **`选择`** 按钮，选中后实时联动顶部闪电按钮；也可不选卡直接点击 **`自动切最空闲号并同步`**。
  - **所有批量换号与一键同步按钮均先展开内联确认卡片**，精确显示目标账号额度与受影响终端数（立即原地重启几个空闲终端、几个干活中终端按策略如何处理），点击 `确认换号/确认同步` 后才真正执行。
- **全维度额度与异时快照诚实可视化**：
  - `<Tabs>` 分栏收纳 `账号` 与 `终端`；
  - 所有账号严格按独立模型池展示主池（`Gemini 5h` / `Gemini 周` 双进度条 + 精确到分钟的重置倒计时）与副池（`Claude/GPT 5h · 周` 及活跃窗口重置倒计时），绝不因 Orca 顶层跨池汇总产生池间串值；
  - 非当前账号单独标注 `快照 · X小时前` 时效、主/副池已过重置窗口自动去红警标明 `已过重置（上轮 X% · 切入刷新）`；尚未切入读过额度的新号标为 `未读取` 且与历史报错号均可手动点选切入刷新，同时自动挑号保持“实测未过期 0% 优先于过期推算”；
  - 底部状态栏仅作纯只读展示（不可点击，防误触换号），悬停可查看当前反重力账号、5h/周额度与旧号/漂移提醒，所有操作收口在右侧「反重力换号」面板。
- **跨工作区无损原地换号 + 自动回滚**：
  - 通过 `orca terminal send` 跨任意工作区恢复原 Tab 对话，不受插件 Host API 仅限当前聚焦工作区的限制，也不抢夺屏幕焦点。
  - 遵循 **先停旧进程（复核 PID 启动时间 + `SIGTERM` 等父 Shell 回到提示符）→ 再切全局账号 → 再并行原位拉起（`stty sane; agy ... --conversation <id>`）**；若切号失败则自动回滚恢复已停终端，失败项展示永不截断的手动恢复代码块。
- **白名单命令重构与 Fail-Closed 保护**：
  - 仅重放安全持久标志并补齐 `--conversation <id>`，剥离 `-i`/`--prompt-interactive`/`--new-project` 与非交互子命令，杜绝二次重放初始 Prompt。
  - CLI/`lsof` 故障时 Fail-Closed 绝不误杀 `working` 终端或误清队列；`working`/`blocked`/`unknown` 终端默认安全排队等待空闲后自动补切。
- **快慢双通道巡检**：
  - 本地进程快通道默认 15s（使用 `/bin/ps ucomm=` 防 macOS 16 字符截断，并结合 `/usr/sbin/lsof -n -P` 同时追踪 `cli-*.log` 与 `acp-server-*.log`）；
  - 远程额度慢通道默认 120s（存在旧号进程时自动缩至最高 45s），内置 singleflight 与 `accountMutationEpoch` 防旧缓存倒灌。

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

后续发布新版本后，一键升级：

```bash
orca plugin update --all
```

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
# 1. 类型检查（0 error）
npx tsc --noEmit

# 2. 校验 / 可打包性检查 / 单测（22 项）/ 3 场景静态检查
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
- `workingPolicy`（默认 `queue`）：遇到 `working` 终端时的处理策略（等空闲自动换号 / 跳过 / 强切）
- `autoGuardDrift`（默认 `true`）：旧进程刷新 Token 顶回旧号时发送桌面告警
- `notifyOnComplete`（默认 `true`）：批量换号或排队自动补切完成后发送通知

## 配套工具

想在每个 `agy` 终端输入框正下方实时看到上下文进度条、Prompt 缓存过期时刻与 5h/周剩余限额，推荐搭配使用：

- **[agy-statusline](https://github.com/lyezhucc/agy-statusline)** — Antigravity CLI 极简 2 行终端底部 HUD（纯 Python 零依赖，一行命令安装）。
