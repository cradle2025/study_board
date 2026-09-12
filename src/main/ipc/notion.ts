import { CHANNELS } from '@shared/channels'
import type {
  NotionPullResult,
  NotionPushResult,
  NotionResolveResult,
  NotionTestResult
} from '@shared/types'

import { notionPreview, notionPull, notionPush, notionResolve, notionTest } from '../services/notion'
import { handle } from './index'

/**
 * Notion 同步 IPC。
 *
 * 这几个通道是**唯一会主动向第三方发出笔记内容**的地方之一（另一个是 AI）。
 * 所以它们没有「悄悄跑」的余地：每一个都由用户在界面上亲手点出来，
 * 参数也只传笔记 id —— 正文由主进程自己去笔记库读，
 * 渲染层递不进来任意内容，也就没法把别的东西发出去。
 */
export function registerNotionHandlers(): void {
  handle<unknown, NotionTestResult>(CHANNELS.NOTION_TEST, () => notionTest())

  handle<unknown, NotionPushResult>(CHANNELS.NOTION_PUSH, (raw) => notionPush(raw))

  handle<unknown, NotionPullResult>(CHANNELS.NOTION_PULL, () => notionPull())

  handle<unknown, NotionResolveResult>(CHANNELS.NOTION_RESOLVE, (raw) => notionResolve(raw))

  handle<unknown, { title: string; content: string }>(CHANNELS.NOTION_PREVIEW, (raw) =>
    notionPreview(raw)
  )
}
