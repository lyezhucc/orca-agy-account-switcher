// 面板交互与红队防误触测试：验证二次确认、永不截断的恢复命令、定位与一键同步。
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { SwitcherSnapshot } from './protocol'

function makeSnapshot(overrides: Partial<SwitcherSnapshot> = {}): SwitcherSnapshot {
  const now = Date.now()
  return {
    updatedAt: now,
    accountsUpdatedAt: now,
    currentEmail: 'alice@example.com',
    activeAccountId: 'acc-2',
    selectedAccountId: 'acc-2',
    desiredEmail: 'alice@example.com',
    accounts: [
      {
        id: 'acc-1',
        email: 'bob@example.com',
        label: null,
        isActive: false,
        isSelected: false,
        status: 'ok',
        sessionUsedPercent: 100,
        sessionResetsAt: now + 3600_000,
        weeklyUsedPercent: 68,
        weeklyResetsAt: now + (5 * 24 + 18) * 3600_000 + 14 * 60_000,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 100,
            sessionResetsAt: now + 3600_000,
            weeklyUsedPercent: 68,
            weeklyResetsAt: now + (5 * 24 + 18) * 3600_000 + 14 * 60_000
          }
        ],
        terminalCount: 1
      },
      {
        id: 'acc-2',
        email: 'alice@example.com',
        label: null,
        isActive: true,
        isSelected: true,
        status: 'ok',
        sessionUsedPercent: 3,
        sessionResetsAt: now + 3 * 3600_000 + 5 * 60_000,
        weeklyUsedPercent: 1,
        weeklyResetsAt: now + 86400_000,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 3,
            sessionResetsAt: now + 3 * 3600_000 + 5 * 60_000,
            weeklyUsedPercent: 1,
            weeklyResetsAt: now + 86400_000
          },
          {
            group: 'Claude and GPT models',
            sessionUsedPercent: 0,
            sessionResetsAt: now + 5 * 3600_000,
            weeklyUsedPercent: 0,
            weeklyResetsAt: now + 6 * 86400_000
          }
        ],
        terminalCount: 1
      }
    ],
    terminals: [
      {
        pid: 16920,
        processKind: 'cli',
        terminalId: 'term_geo',
        worktreeId: 'r::/work/GEO',
        workspaceName: 'GEO',
        title: '继续',
        conversationId: '8ecc012e-da64-42e5-b8ac-3a0affc1213d',
        authEmail: 'bob@example.com',
        commandPreview: 'agy --dangerously-skip-permissions',
        canRestartInPlace: true,
        restartBlockedReason: null,
        isExternal: false,
        agentState: 'idle',
        isOutdated: true,
        queuedTargetEmail: null,
        startedAtText: 'Sat Nov 21 21:37:46 2026'
      }
    ],
    outdatedCount: 1,
    externalOutdatedCount: 0,
    acpOutdatedCount: 0,
    unknownAuthCount: 0,
    queuedCount: 0,
    workingPolicy: 'queue',
    drift: null,
    busy: false,
    busyLabel: null,
    scanDegradedReason: null,
    lastOperation: null,
    error: null,
    ...overrides
  }
}

test('面板支持底部先选账号再点闪电、所有批量换号先预览确认、二次强切与恢复命令', async () => {
  let current = makeSnapshot({ queuedCount: 1 })
  let focusedId: string | null = null
  let forceDrainCalls = 0
  let switchAllCalls = 0
  let lastSwitchTarget: string | null = null

  const host = mockHost({
    requests: {
      'switcher.getState': () => current,
      'switcher.switchAll': (input: { targetAccountId: string }) => {
        switchAllCalls += 1
        lastSwitchTarget = input.targetAccountId
        current = makeSnapshot({
          updatedAt: Date.now() + 10,
          outdatedCount: 0,
          queuedCount: 0,
          terminals: [
            {
              ...current.terminals[0]!,
              authEmail: 'alice@example.com',
              isOutdated: false
            }
          ],
          lastOperation: {
            at: Date.now(),
            targetEmail: 'alice@example.com',
            restartedCount: 1,
            queuedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            rolledBackCount: 0,
            message: '已切到 alice，原地换号 1 个',
            details: ['✓ GEO · 继续（已续接原对话）'],
            recoveryCommands: [
              {
                label: '示例兜底',
                command: 'stty sane; agy --conversation 8ecc012e-da64-42e5-b8ac-3a0affc1213d',
                reason: '测试显示'
              }
            ]
          }
        })
        return current
      },
      'switcher.forceDrainQueue': () => {
        forceDrainCalls += 1
        current = makeSnapshot({ updatedAt: Date.now() + 5, queuedCount: 0, outdatedCount: 1 })
        return current
      },
      'switcher.focusTerminal': (input: { terminalId: string }) => {
        focusedId = input.terminalId
        return { focused: true }
      }
    }
  })

  const view = await mount(panel, { host })

  assert.ok(view.find({ text: '1 旧号' }))
  assert.ok(view.find({ text: /周\s+68%/ }))
  assert.ok(view.find({ text: /5天18时14分/ }))
  assert.ok(view.find({ text: 'Claude/GPT' }))
  assert.ok(view.find({ text: '5h 0% · 周 0%' }))

  // 1) 未选下方账号直接点顶部闪电「自动切最空闲号并同步」：绝不立刻切号，必须先弹出确认框
  await view.press({ text: '自动切最空闲号并同步' })
  assert.equal(switchAllCalls, 0)
  assert.ok(view.find({ text: /确认切换到/ }) || view.find({ text: /确认切到最空闲号/ }))
  // 点取消后零副作用
  await view.press({ text: '取消' })
  assert.equal(switchAllCalls, 0)

  // 2) 在下方先点选账号（点击任意「选择」），仅切换高亮选中态、顶部闪电实时联动，绝不直接开切
  const selectButtons = view.findAll({ type: 'Button', text: '选择' })
  assert.ok(selectButtons.length >= 2)
  await view.press(selectButtons[1]!)
  assert.equal(switchAllCalls, 0)
  assert.ok(view.find({ type: 'Button', text: '已选中' }))
  assert.ok(view.find({ type: 'Button', text: '切到 bob 并同步' }))

  // 点击顶部闪电按钮 -> 先展示确认卡（并提醒 5h 已满），点取消后不执行
  await view.press({ type: 'Button', text: '切到 bob 并同步' })
  assert.equal(switchAllCalls, 0)
  assert.ok(view.find({ text: /5h已满/ }))
  await view.press({ type: 'Button', text: '取消' })
  await view.press({ type: 'Button', text: '已选中' })
  assert.ok(view.find({ type: 'Button', text: '自动切最空闲号并同步' }))

  // 切换到「终端 (1)」Tab 验证终端列表与定位按钮
  await view.select({ label: '视图切换' }, 'terminals')
  assert.ok(view.find({ text: 'GEO' }))

  await view.press({ text: '定位' })
  assert.equal(focusedId, 'term_geo')

  // 破坏性按钮「强制立切排队 (1)」首次点击进入二次确认，不直接触发
  await view.press({ text: '强制立切排队 (1)' })
  assert.equal(forceDrainCalls, 0)
  assert.ok(view.find({ text: '再点确认强切 (1)' }))

  // 二次点击才真正触发
  await view.press({ text: '再点确认强切 (1)' })
  assert.equal(forceDrainCalls, 1)

  // 3) 顶部预警框「一键同步 1 个旧终端到 alice」也必须先预览确认，点「确认同步」才真正执行
  await view.press({ text: '一键同步 1 个旧终端到 alice' })
  assert.equal(switchAllCalls, 0)
  assert.ok(view.find({ text: /确认同步旧终端到 alice/ }))
  await view.press({ text: '确认同步' })

  assert.equal(switchAllCalls, 1)
  assert.equal(lastSwitchTarget, 'acc-2')
  assert.ok(view.find({ text: '已对齐' }))
  assert.ok(view.find({ text: '已切到 alice，原地换号 1 个' }))
  assert.ok(
    view.find({ text: 'stty sane; agy --conversation 8ecc012e-da64-42e5-b8ac-3a0affc1213d' })
  )

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('面板「终端」Tab 精确展示多工作区原生 Chat（区分宿主共号与托管独立号），且绝不显示强杀按钮', async () => {
  const base = makeSnapshot()
  const mixedSnap = makeSnapshot({
    currentEmail: 'bob@example.com',
    activeAccountId: 'acc-1',
    selectedAccountId: 'acc-1',
    desiredEmail: 'bob@example.com',
    accounts: base.accounts.map((a) => ({
      ...a,
      isActive: a.id === 'acc-1',
      isSelected: a.id === 'acc-1'
    })),
    outdatedCount: 0,
    acpOutdatedCount: 1,
    chatBackendMode: 'host-agy',
    terminals: [
      {
        pid: 801,
        processKind: 'acp',
        terminalId: null,
        worktreeId: 'r::/work/GEO',
        workspaceName: 'GEO · master',
        title: '检查页面“最”字',
        conversationId: null,
        authEmail: 'bob@example.com',
        commandPreview: 'agy acp --dangerously-skip-permissions',
        canRestartInPlace: false,
        restartBlockedReason: '原生 Chat 干活中（共用系统账号），需等其空闲或手动重开',
        isExternal: false,
        agentState: 'working',
        isOutdated: true,
        queuedTargetEmail: null,
        startedAtText: 'Sun Nov 22 20:00:00 2026',
        orcaSessionId: 'chat-1',
        chatEngine: 'host-agy'
      },
      {
        pid: 802,
        processKind: 'acp',
        terminalId: null,
        worktreeId: 'r::/work/GEO',
        workspaceName: 'GEO · master',
        title: '独立托管对话',
        conversationId: null,
        authEmail: null,
        commandPreview: 'agy_acp_server.par',
        canRestartInPlace: false,
        restartBlockedReason: 'Orca 托管内置账号（独立于终端池，不受本面板切号影响）',
        isExternal: false,
        agentState: 'done',
        isOutdated: false,
        queuedTargetEmail: null,
        startedAtText: 'Sun Nov 22 20:05:00 2026',
        orcaSessionId: 'chat-2',
        chatEngine: 'orca-managed'
      }
    ]
  })

  const host = mockHost({
    requests: {
      'switcher.getState': () => mixedSnap
    }
  })
  const view = await mount(panel, { host })

  // 先验证确认框准确分化「宿主原生 Chat」和「托管 Chat」提示
  await view.press({ text: '自动切最空闲号并同步' })
  assert.ok(view.find({ text: /另有 1 个宿主原生 Chat 持旧号/ }))
  assert.ok(view.find({ text: /1 个托管 Chat 使用独立账号/ }))
  await view.press({ text: '取消' })

  // 切换到「终端 (2)」Tab
  await view.select({ label: '视图切换' }, 'terminals')
  assert.ok(view.find({ text: '原生 Chat 对话 (2)' }))
  assert.ok(view.find({ text: '检查页面“最”字' }))
  assert.ok(view.find({ text: '独立托管对话' }))
  assert.ok(view.find({ text: '独立凭据' }))
  assert.ok(view.find({ text: '独立托管' }))
  // 路线 A 严格不展示强杀「结束」按钮
  assert.equal(view.findAll({ type: 'Button', text: '结束' }).length, 0)

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('过期旧快照去红警并标注快照时间、副池识别过期、未读新号与异常号均可手动选中切入', async () => {
  const now = Date.now()
  const snap = makeSnapshot({
    updatedAt: now,
    accountsUpdatedAt: now - 30_000,
    outdatedCount: 0,
    terminals: [],
    accounts: [
      {
        id: 'acc-active',
        email: 'alice@example.com',
        label: null,
        isActive: true,
        isSelected: true,
        status: 'ok',
        sessionUsedPercent: 1,
        sessionResetsAt: now + 4 * 3600_000,
        weeklyUsedPercent: 7,
        weeklyResetsAt: now + 6 * 86400_000,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 1,
            sessionResetsAt: now + 4 * 3600_000,
            weeklyUsedPercent: 7,
            weeklyResetsAt: now + 6 * 86400_000
          }
        ],
        terminalCount: 0,
        usageUpdatedAt: now - 30_000
      },
      {
        id: 'acc-expired-100',
        email: 'bob@example.com',
        label: null,
        isActive: false,
        isSelected: false,
        status: 'ok',
        sessionUsedPercent: 100,
        sessionResetsAt: now - 15 * 3600_000,
        weeklyUsedPercent: 68,
        weeklyResetsAt: now + 5 * 86400_000,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 100,
            sessionResetsAt: now - 15 * 3600_000,
            weeklyUsedPercent: 68,
            weeklyResetsAt: now + 5 * 86400_000
          },
          {
            group: 'Claude and GPT models',
            sessionUsedPercent: 100,
            sessionResetsAt: now - 15 * 3600_000,
            weeklyUsedPercent: 50,
            weeklyResetsAt: now + 5 * 86400_000
          }
        ],
        terminalCount: 0,
        usageUpdatedAt: now - 16 * 3600_000
      },
      {
        id: 'acc-unfetched',
        email: 'newbie@gmail.com',
        label: null,
        isActive: false,
        isSelected: false,
        status: 'unfetched',
        sessionUsedPercent: null,
        sessionResetsAt: null,
        weeklyUsedPercent: null,
        weeklyResetsAt: null,
        buckets: [],
        terminalCount: 0,
        usageUpdatedAt: null
      },
      {
        id: 'acc-err',
        email: 'broken@gmail.com',
        label: null,
        isActive: false,
        isSelected: false,
        status: 'error',
        sessionUsedPercent: 10,
        sessionResetsAt: now + 3600_000,
        weeklyUsedPercent: 20,
        weeklyResetsAt: now + 3 * 86400_000,
        buckets: [],
        terminalCount: 0,
        usageUpdatedAt: now - 2 * 3600_000
      }
    ]
  })

  const host = mockHost({
    requests: {
      'switcher.getState': () => snap
    }
  })
  const view = await mount(panel, { host })

  // 1) 主池过期窗口：诚实标注已过重置 + 上轮100% + 单卡快照龄，彻底移除「已可重置」歧义
  assert.ok(view.find({ text: /5h 已过重置/ }))
  assert.ok(view.find({ text: '上轮 100% · 切入刷新' }))
  assert.ok(view.find({ text: '快照 · 16小时前' }))
  assert.equal(view.findAll({ text: /已可重置/ }).length, 0)

  // 2) 副池 Claude/GPT 5h 过期同步识别
  assert.ok(view.find({ text: '5h 已过重置 · 周 50%' }))

  // 3) 未读取新号与异常号：均不锁死，展示清晰 Badge 并全部提供可点击「选择」
  assert.ok(view.find({ text: '未读取' }))
  assert.ok(view.find({ text: '尚未读取额度，切入此账号后自动刷新' }))
  assert.ok(view.find({ text: '额度异常' }))
  assert.equal(view.findAll({ type: 'Button', text: '账号异常' }).length, 0)

  // 3 个非当前账号（过期号、未读取号、异常号）均应提供可点击的「选择」按钮
  const selectButtons = view.findAll({ type: 'Button', text: '选择' })
  assert.equal(selectButtons.length, 3)

  // 4) 选中过期 100% 账号后展开确认框：不误报「⚠ 5h已满」，带快照时间
  await view.press(selectButtons[0]!)
  await view.press({ type: 'Button', text: '切到 bob 并同步' })
  assert.equal(view.findAll({ text: /5h已满/ }).length, 0)
  assert.ok(view.find({ text: /16小时前快照/ }))
  await view.press({ type: 'Button', text: '取消' })
  await view.press({ type: 'Button', text: '已选中' })

  // 5) 选中未读新号并展开确认框：确认框正常提示未读且允许点击「确认换号」
  const refreshedSelectBtns = view.findAll({ type: 'Button', text: '选择' })
  await view.press(refreshedSelectBtns[1]!)
  await view.press({ type: 'Button', text: '切到 newbie 并同步' })
  assert.ok(view.find({ text: /尚未读取额度，切入后自动刷新/ }))
  assert.ok(view.find({ type: 'Button', text: '确认换号' }))
  await view.press({ type: 'Button', text: '取消' })
  await view.press({ type: 'Button', text: '已选中' })

  // 6) 选中异常号并展开确认框：给出异常提示但按钮文案变为「仍要切入」且不被禁用
  const errSelectBtns = view.findAll({ type: 'Button', text: '选择' })
  await view.press(errSelectBtns[2]!)
  await view.press({ type: 'Button', text: '切到 broken 并同步' })
  assert.ok(view.find({ text: /上次读取额度异常/ }))
  assert.ok(view.find({ type: 'Button', text: '仍要切入' }))
  await view.press({ type: 'Button', text: '取消' })

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('跨模型池隔离：顶层汇总为 Claude/GPT 93% 时，Gemini 周与确认框严格展示 Gemini 28% 且副池带重置倒计时', async () => {
  const now = new Date(2026, 10, 24, 23, 0, 0).getTime()
  const gem5hReset = now + (2 * 60 + 35) * 60_000
  const gemWeekReset = now + ((6 * 24 + 5) * 60 + 10) * 60_000
  const claudeWeekReset = now + ((4 * 24 + 16) * 60 + 14) * 60_000
  const claude5hReset = now + 4 * 3600_000

  const snap = makeSnapshot({
    updatedAt: now,
    accountsUpdatedAt: now - 120_000,
    currentEmail: 'alice@example.com',
    activeAccountId: 'acc-active',
    selectedAccountId: 'acc-active',
    desiredEmail: 'alice@example.com',
    outdatedCount: 0,
    terminals: [],
    accounts: [
      {
        id: 'acc-active',
        email: 'alice@example.com',
        label: null,
        isActive: true,
        isSelected: true,
        status: 'ok',
        // 模拟 Orca 顶层跨池取最严汇总：5h 来自 Gemini (48%)，周来自 Claude/GPT (93%)
        sessionUsedPercent: 48,
        sessionResetsAt: gem5hReset,
        weeklyUsedPercent: 93,
        weeklyResetsAt: claudeWeekReset,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 48,
            sessionResetsAt: gem5hReset,
            weeklyUsedPercent: 28,
            weeklyResetsAt: gemWeekReset
          },
          {
            group: 'Claude and GPT models',
            sessionUsedPercent: 0,
            sessionResetsAt: claude5hReset,
            weeklyUsedPercent: 93,
            weeklyResetsAt: claudeWeekReset
          }
        ],
        terminalCount: 2,
        usageUpdatedAt: now - 120_000
      },
      {
        id: 'acc-claude-full',
        email: 'dana@example.com',
        label: null,
        isActive: false,
        isSelected: false,
        status: 'ok',
        // 反向串值测试：顶层 session 为 100%（Claude 5h 满），但 Gemini 5h 仅 18%
        sessionUsedPercent: 100,
        sessionResetsAt: claude5hReset,
        weeklyUsedPercent: 90,
        weeklyResetsAt: claudeWeekReset,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 18,
            sessionResetsAt: gem5hReset,
            weeklyUsedPercent: 22,
            weeklyResetsAt: gemWeekReset
          },
          {
            group: 'Claude and GPT models',
            sessionUsedPercent: 100,
            sessionResetsAt: claude5hReset,
            weeklyUsedPercent: 90,
            weeklyResetsAt: claudeWeekReset
          }
        ],
        terminalCount: 0,
        usageUpdatedAt: now - 600_000
      }
    ]
  })

  const host = mockHost({
    requests: {
      'switcher.getState': () => snap
    }
  })
  const view = await mount(panel, { host })

  // 1) 主池必须严格显示 Gemini 周 28%（6天5时），绝不能把 Claude/GPT 周 93% 错标为 Gemini 周 93%
  assert.ok(view.find({ text: 'Gemini 5h 48%' }))
  assert.ok(view.find({ text: 'Gemini 周 28%' }))
  assert.ok(view.find({ text: /6天5时10分/ }))
  assert.equal(view.findAll({ text: /Gemini 周 93%/ }).length, 0)

  // 2) 副池清晰展示 5h 0% · 周 93% 以及自己的周重置倒计时
  assert.ok(view.find({ text: 'Claude/GPT' }))
  assert.ok(view.find({ text: '5h 0% · 周 93%' }))
  assert.ok(view.find({ text: /周重置\s+4天16时14分/ }))

  // 3) 选中 Claude 5h=100% 但 Gemini 5h=18% 的账号展开确认框：不误报 5h已满，且分别展示主池与副池
  await view.press({ type: 'Button', text: '选择' })
  await view.press({ type: 'Button', text: '切到 dana 并同步' })
  assert.ok(view.find({ text: /Gemini 5h 18% · 周 22%/ }))
  assert.equal(view.findAll({ text: /5h已满/ }).length, 0)
  assert.ok(view.find({ text: /Claude\/GPT 5h 100% · 周 90%/ }))
  await view.press({ type: 'Button', text: '取消' })

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
