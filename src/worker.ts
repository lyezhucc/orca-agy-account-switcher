// 插件 Worker 入口（红队加固版）：
// - 递归 setTimeout + pollGeneration 防异步双定时器与 deactivate 后僵尸轮询；
// - 保存全部 Disposable 并在 deactivate 统一释放；
// - 全链路 .catch() 兜底，杜绝 unhandledRejection 打崩 Worker。
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import './protocol'
import { SwitcherService } from './switcher'
import { RealSystemAdapter, type SystemAdapter } from './system'

let activeService: SwitcherService | null = null
let activeDisposables: Disposable[] = []
let pollTimer: ReturnType<typeof setTimeout> | null = null
let workspaceDebounceTimer: ReturnType<typeof setTimeout> | null = null
let pollGeneration = 0

function unrefTimer(timer: unknown): void {
  const t = timer as { unref?: () => void } | null
  t?.unref?.()
}

function clearAllTimers(): void {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (workspaceDebounceTimer) {
    clearTimeout(workspaceDebounceTimer)
    workspaceDebounceTimer = null
  }
}

export function createWorker(
  orca: OrcaWorkerApi,
  adapter: SystemAdapter,
  disposables: Disposable[] = []
): SwitcherService {
  const service = new SwitcherService(orca, adapter)

  disposables.push(
    orca.panels.handle('switcher.getState', async (input) => {
      return service.getSnapshot(input)
    }),
    orca.panels.handle('switcher.switchAll', async (input) => {
      return service.switchAll(input)
    }),
    orca.panels.handle('switcher.switchBest', async (input) => {
      return service.switchBest(input?.workingPolicy)
    }),
    orca.panels.handle('switcher.syncToCurrent', async (input) => {
      return service.syncToCurrent(input?.workingPolicy)
    }),
    orca.panels.handle('switcher.restartOne', async (input) => {
      return service.restartOne(input)
    }),
    orca.panels.handle('switcher.forceDrainQueue', async () => {
      return service.forceDrainQueue()
    }),
    orca.panels.handle('switcher.killExternal', async (input) => {
      return service.killExternalProcess(input.pid, input.startedAtText)
    }),
    orca.panels.handle('switcher.cancelQueue', async () => {
      return service.cancelQueue()
    }),
    orca.panels.handle('switcher.focusTerminal', async (input) => {
      return service.focusTerminal(input.terminalId)
    }),
    orca.panels.handle('switcher.setPolicy', async (input) => {
      return service.setWorkingPolicy(input.workingPolicy)
    }),
    orca.commands.register('agy-switcher.quickSync', async () => {
      return service.quickSyncCommand()
    }),
    orca.commands.register('agy-switcher.syncToCurrent', async () => {
      const snap = await service.syncToCurrent()
      return snap.lastOperation?.message ?? '已同步旧号终端'
    }),
    orca.commands.register('agy-switcher.switchBest', async () => {
      const snap = await service.switchBest()
      return snap.lastOperation?.message ?? '已切换到最空闲账号'
    }),
    orca.commands.register('agy-switcher.refresh', async () => {
      const snap = await service.refreshSnapshot({ refreshAccounts: true })
      const totalOutdated = snap.outdatedCount + snap.externalOutdatedCount + snap.acpOutdatedCount
      return `当前账号：${snap.currentEmail ?? '未知'}（运行中 ${snap.terminals.length} 个，旧号 ${totalOutdated} 个）`
    }),
    orca.commands.register('agy-switcher.cancelQueue', async () => {
      await service.cancelQueue()
      return '已清空等待换号队列'
    }),
    orca.events.on('agent.status.changed', async (event) => {
      await service.handleAgentStatusChanged({
        terminalId: event.terminalId,
        state: event.state
      })
    }),
    // 切工作区只做 1s 防抖后的本地快通道刷新，且在 busy 时跳过
    orca.events.on('workspace.changed', () => {
      if (service.isDisposed() || service.isBusy()) return
      if (workspaceDebounceTimer) clearTimeout(workspaceDebounceTimer)
      workspaceDebounceTimer = setTimeout(() => {
        workspaceDebounceTimer = null
        if (service.isDisposed() || service.isBusy()) return
        void service
          .refreshSnapshot({ refreshAccounts: false, fromBackground: true })
          .catch((err) =>
            orca.log(
              `workspace.changed refresh failed: ${err instanceof Error ? err.message : String(err)}`
            )
          )
      }, 1000)
      unrefTimer(workspaceDebounceTimer)
    })
  )

  return service
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  // 防御重复 activate
  deactivate()
  const gen = ++pollGeneration
  const disposables: Disposable[] = []
  const service = createWorker(orca, new RealSystemAdapter(), disposables)
  activeService = service
  activeDisposables = disposables

  const scheduleNextTick = async (expectedGen: number): Promise<void> => {
    if (expectedGen !== pollGeneration || service.isDisposed()) return
    const settings = await service.readSettings()
    if (expectedGen !== pollGeneration || service.isDisposed()) return

    if (pollTimer) clearTimeout(pollTimer)
    const intervalMs = settings.processPollIntervalSec * 1000
    pollTimer = setTimeout(() => {
      pollTimer = null
      if (expectedGen !== pollGeneration || service.isDisposed()) return
      void service
        .drainAnyIdleQueued()
        .catch((err) =>
          orca.log(`poll drainAnyIdleQueued failed: ${err instanceof Error ? err.message : String(err)}`)
        )
        .then(() => service.refreshSnapshot({ refreshAccounts: false, fromBackground: true }))
        .catch((err) =>
          orca.log(`poll refreshSnapshot failed: ${err instanceof Error ? err.message : String(err)}`)
        )
        .finally(() => {
          void scheduleNextTick(expectedGen).catch((err) =>
            orca.log(`scheduleNextTick failed: ${err instanceof Error ? err.message : String(err)}`)
          )
        })
    }, intervalMs)
    unrefTimer(pollTimer)
  }

  disposables.push(
    orca.settings.onDidChange(({ key }) => {
      if (service.isDisposed()) return
      if (key === 'processPollIntervalSec' || key === 'quotaPollIntervalSec') {
        const nextGen = ++pollGeneration
        void scheduleNextTick(nextGen).catch((err) =>
          orca.log(`reschedule poll failed: ${err instanceof Error ? err.message : String(err)}`)
        )
      } else {
        void service
          .refreshSnapshot({ refreshAccounts: false, fromBackground: true })
          .catch((err) =>
            orca.log(`settings refresh failed: ${err instanceof Error ? err.message : String(err)}`)
          )
      }
    })
  )

  await service.refreshSnapshot({ refreshAccounts: true }).catch((err) => {
    orca.log(`initial refreshSnapshot failed: ${err instanceof Error ? err.message : String(err)}`)
  })
  // 若激活期间已被 deactivate，绝不启动僵尸轮询
  if (gen === pollGeneration && !service.isDisposed()) {
    await scheduleNextTick(gen)
  }
}

export function deactivate(): void {
  pollGeneration += 1
  clearAllTimers()
  for (const d of activeDisposables) {
    try {
      d.dispose()
    } catch {
      // ignore
    }
  }
  activeDisposables = []
  activeService?.dispose()
  activeService = null
}
