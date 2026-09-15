import { Notification, app, BrowserWindow } from 'electron'

import { dueReminders } from '@shared/calendar'
import type { CalendarNotificationInfo, CalendarReminder } from '@shared/types'

import { broadcast } from '../ipc/index'
import { CHANNELS } from '@shared/channels'
import type { CalendarStore } from './calendar'

/**
 * 日程提醒：到点弹系统通知。
 *
 * ## 为什么必须先设 AppUserModelID（实测，不是照文档抄的）
 *
 * Windows 上 toast 通知要求进程有一个**已注册的 AppUserModelID**。
 * 实测四种情况（Electron 44.3.0 / Windows 11，方法见 DECISIONS.md D-012）：
 *
 * | 设置 | Electron 的 show 事件 | 进了系统通知库 |
 * |---|---|---|
 * | 不设 | 不发 | 否 |
 * | 设成 exe 路径 | 不发 | 否 |
 * | 设成一个没注册过的 AUMID | **发了** | **否** |
 * | 设成安装包注册过的 AUMID | 发了 | 是 |
 *
 * 两件事因此必须写进代码：
 *  1. **AUMID 一定要设**，且要与 `electron-builder.yml` 的 `appId` 一致。
 *     安装包会创建带这个 AUMID 的开始菜单快捷方式，Windows 才认账。
 *     不设的话 `show()` 既不报错也不发 `failed`，通知直接消失。
 *  2. **不能拿 `show` 事件当「用户看到了」的证据** —— 第三行证明了它
 *     会在通知根本没被系统收下的时候照样触发。所以下面把「没收到任何
 *     回执」单独记成 `unverified`，界面才能如实说话。
 *
 * 未签名的**安装版**能正常弹（实测通过）；开发态 / 免安装直接跑 exe
 * 时通知会被丢掉，因为那种跑法没有开始菜单快捷方式去注册 AUMID。
 *
 * ## 调度
 *
 * 一个定时器 + 纯函数 `dueReminders`。只发「本次进程启动之后到点」的
 * 提醒：应用没开着的时候错过的提醒**不补发**——补发一堆「三天前的课
 * 要上了」除了打扰没有别的用处。
 */

/** 必须与 electron-builder.yml 的 appId 一致，否则安装版的通知也会被丢掉 */
export const APP_USER_MODEL_ID = 'io.github.studyboard.app'

/** 检查间隔。提醒精度 ±30 秒，对学习日程足够 */
const TICK_MS = 30_000

/** 等多久还没收到系统回执就算「发出去但不知道结果」 */
const RECEIPT_TIMEOUT_MS = 1500

/**
 * 把应用身份告诉操作系统。**越早调越好**，必须在任何通知之前。
 *
 * 只在 Windows 上有意义：`setAppUserModelId` 是 Windows 独有的接口，
 * 别的平台上调用它不报错但也没用。
 */
export function configureAppIdentity(): void {
  if (process.platform !== 'win32') return
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

export class ReminderService {
  #store: CalendarStore
  #timer: NodeJS.Timeout | null = null
  /** 上一次检查的时刻。左开右闭的区间起点，保证同一分钟不重复触发 */
  #lastCheck = Date.now()
  #info: CalendarNotificationInfo = {
    supported: false,
    delivered: 0,
    failed: 0,
    lastAt: null,
    lastTitle: '',
    lastOutcome: 'none',
    lastDetail: ''
  }

  constructor(store: CalendarStore) {
    this.#store = store
  }

  start(): void {
    if (this.#timer) return
    this.#lastCheck = Date.now()
    this.#timer = setInterval(() => this.tick(), TICK_MS)
    // 定时器不该拖着进程不让退出：用户关掉窗口就该结束
    this.#timer.unref?.()
  }

  stop(): void {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  /**
   * 检查一次有没有到点的提醒。
   *
   * `now` 可以注入，自检直接调它就能确定性地验「到点会不会发」，
   * 不必真的等半小时。定时器传的是当前时间。
   */
  tick(now: number = Date.now()): CalendarReminder[] {
    const from = this.#lastCheck
    this.#lastCheck = now
    const events = this.#store.get().events
    const due = dueReminders(events, from, now)
    for (const reminder of due) this.#fire(reminder)
    return due
  }

  /**
   * 立刻发一条测试通知。
   *
   * 存在的理由：通知通不通取决于**用户那台机器**的 AUMID 注册与
   * 勿扰设置，程序猜不出来。与其让用户等一条可能永远不来的提醒，
   * 不如给个按钮当场试一次。
   *
   * 标题用应用名而不是「测试通知」这类中文：主进程拿不到渲染层的
   * 语言，写死中文会让英文界面弹出一条中文通知（D-005 的同一条理由）。
   */
  async test(): Promise<CalendarNotificationInfo> {
    await this.#deliver({
      eventId: 'test',
      title: app.getName(),
      date: '',
      at: new Date().toISOString(),
      location: '',
      start: ''
    })
    return this.info()
  }

  info(): CalendarNotificationInfo {
    let supported = false
    try {
      supported = Notification.isSupported()
    } catch {
      supported = false
    }
    return { ...this.#info, supported }
  }

  #fire(reminder: CalendarReminder): void {
    // 界面里那条兜底提醒先发：它是同步的、一定会到，
    // 系统通知那条则可能被 Windows 静默丢掉
    broadcast(CHANNELS.EVENT_CALENDAR_REMINDER, reminder)
    void this.#deliver(reminder)
  }

  #deliver(reminder: CalendarReminder): Promise<void> {
    this.#info.lastAt = new Date().toISOString()
    this.#info.lastTitle = reminder.title
    // 先清空上一次的结论：留着旧值的话，界面上会出现「刚发出去的这条」
    // 顶着「上一条的结果」，而回执要一两秒后才回来
    this.#info.lastOutcome = 'none'
    this.#info.lastDetail = ''

    let supported = false
    try {
      supported = Notification.isSupported()
    } catch {
      supported = false
    }
    if (!supported) {
      this.#info.lastOutcome = 'unsupported'
      this.#info.lastDetail = ''
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      let settled = false
      const body = [reminder.start, reminder.location].filter((part) => part !== '').join(' · ')

      let notification: Notification
      try {
        notification = new Notification({
          title: reminder.title || app.getName(),
          // 没有时间也没有地点时**不写 body**，而不是填一句中文兜底：
          // 主进程拿不到渲染层的语言，写死中文会让英文界面弹出一条中文通知
          body,
          silent: false
        })
      } catch (error) {
        this.#info.lastOutcome = 'failed'
        this.#info.lastDetail = error instanceof Error ? error.message : String(error)
        this.#info.failed += 1
        resolve()
        return
      }

      notification.on('show', () => {
        settled = true
        this.#info.lastOutcome = 'delivered'
        this.#info.lastDetail = ''
        this.#info.delivered += 1
        resolve()
      })
      notification.on('failed', (_event, error) => {
        settled = true
        this.#info.lastOutcome = 'failed'
        this.#info.lastDetail = String(error)
        this.#info.failed += 1
        resolve()
      })
      notification.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      })

      notification.show()

      // 既没 show 也没 failed：通知交出去了，但系统没有回执。
      // 实测这正是 Windows 上 AUMID 没注册时的形态 —— 不能当成成功
      setTimeout(() => {
        if (settled) return
        this.#info.lastOutcome = 'unverified'
        this.#info.lastDetail = ''
        resolve()
      }, RECEIPT_TIMEOUT_MS)
    })
  }
}
