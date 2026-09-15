import type { TimetableCell, TimetableData } from '@shared/types'

import { t, tm } from '../lib/i18n'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { confirmAction } from '../lib/overlay'
import { markLimited } from '../lib/perf'
import { createTimetablePanel, type RenderHint, type TimetablePanelHandle } from './timetable-panel'

/**
 * 课表的读写控制器。
 *
 * 概览页与编辑页都需要「加载 / 保存单元格 / 加图片 / 换图片 / 删图片」这一整套动作，
 * 抽到这里，两个页面只负责决定「长什么样」，不重复实现业务逻辑。
 */

export interface TimetableControllerOptions {
  editable: boolean
  /** 每次数据变化后回调，方便视图更新自己的附属信息（如统计文案） */
  onData?(data: TimetableData): void
  /** 出错时的提示语前缀 */
  errorPrefix?: string
}

export interface TimetableController {
  panel: TimetablePanelHandle
  /** 当前数据快照 */
  current(): TimetableData | null
  load(): Promise<TimetableData | null>
  /** 不重新请求，直接用已有数据重绘（例如设置变更后） */
  refresh(): Promise<TimetableData | null>
  dispose(): void
}

export function createTimetableController(options: TimetableControllerOptions): TimetableController {
  const prefix = options.errorPrefix ?? t('nav.timetable')

  let data: TimetableData | null = null
  // 面板在下面才创建，但 apply 会被面板自己的回调用到，所以先声明后赋值
  let panel: TimetablePanelHandle

  const apply = (next: TimetableData, hint?: RenderHint): TimetableData => {
    data = next
    panel.render(next, hint)
    options.onData?.(next)
    return next
  }

  async function load(): Promise<TimetableData | null> {
    try {
      markLimited('sb:tt:load:start')
      const snapshot = await unwrap(bridge().timetable.get())
      markLimited('sb:tt:load:ipc-done')
      const applied = apply(snapshot)
      markLimited('sb:tt:load:rendered')
      return applied
    } catch (error) {
      toast(t('timetable.loadFailed', { what: prefix, reason: tm(formatError(error)) }), 'error')
      return null
    }
  }

  panel = createTimetablePanel({
    editable: options.editable,

    async onSaveCell(key: string, cell: TimetableCell | null): Promise<void> {
      try {
        // 一次只动一个格子，告诉面板走单格重绘而不是整表重建。
        // setCell 按 id 落在**一门课**上，同格其它周次的课不受影响
        apply(await unwrap(bridge().timetable.setCell({ key, cell })), { kind: 'cell', key })
        toast(t(cell ? 'timetable.saved' : 'timetable.cleared'), 'success')
      } catch (error) {
        toast(t('timetable.saveFailed', { reason: tm(formatError(error)) }), 'error')
        // 保存失败时回滚界面，避免显示的内容和磁盘不一致
        if (data) panel.render(data)
      }
    },

    async onRemoveCell(key: string, id: string): Promise<void> {
      try {
        apply(await unwrap(bridge().timetable.removeCell({ key, id })), { kind: 'cell', key })
        toast(t('timetable.courseRemoved'), 'success')
      } catch (error) {
        toast(t('timetable.saveFailed', { reason: tm(formatError(error)) }), 'error')
        if (data) panel.render(data)
      }
    },

    async onCopyPrevious(key: string, source: TimetableCell[]): Promise<void> {
      try {
        const existing = data?.cells[key] ?? []
        /**
         * 复制过来的课一律**清空 id**，让主进程重新分配。
         *
         * id 是「这一格里那一门课」的身份。沿用来源课的 id 会让这一格里
         * 出现两个同 id 的课，之后按 id 删除 / 编辑会打到错误的那一门上。
         */
        const copies = source.map((course) => ({ ...course, id: '' }))
        // 整格一次写回：多门课逐个 setCell 会变成多次整文件重写
        const next = [...existing, ...copies]
        apply(await unwrap(bridge().timetable.setCells({ cells: { [key]: next } })), {
          kind: 'cell',
          key
        })
        toast(t('timetable.copiedPrev', { count: copies.length }), 'success')
      } catch (error) {
        toast(t('timetable.saveFailed', { reason: tm(formatError(error)) }), 'error')
        if (data) panel.render(data)
      }
    },

    async onAddImages(): Promise<void> {
      try {
        const picked = await unwrap(bridge().dialog.pickImages())
        if (picked.canceled || picked.paths.length === 0) return

        const result = await unwrap(bridge().timetable.addImages(picked.paths))
        apply(result.timetable)

        if (result.added > 0) toast(t('timetable.imported', { count: result.added }), 'success')
        for (const message of result.errors.slice(0, 4)) toast(message, 'error')
        if (result.errors.length > 4) {
          toast(t('timetable.importPartial', { count: result.errors.length - 4 }), 'error')
        }
      } catch (error) {
        toast(t('timetable.importFailed', { reason: tm(formatError(error)) }), 'error')
      }
    },

    async onRemoveImage(id: string): Promise<void> {
      const target = data?.images.find((image) => image.id === id)
      const confirmed = await confirmAction({
        title: t('timetable.removePhotoTitle'),
        message: target ? t('timetable.removePhotoBody', { name: target.sourceName }) : undefined,
        confirmText: t('common.delete'),
        danger: true
      })
      if (!confirmed) return

      try {
        apply(await unwrap(bridge().timetable.removeImage(id)))
        toast(t('common.deleted'), 'success')
      } catch (error) {
        toast(t('timetable.removeFailed', { reason: tm(formatError(error)) }), 'error')
      }
    },

    async onReplaceImage(id: string): Promise<void> {
      try {
        // 先让用户选，选好了再删旧的——中途取消不会把已有照片弄丢
        const picked = await unwrap(bridge().dialog.pickImages())
        if (picked.canceled || picked.paths.length === 0) return

        await unwrap(bridge().timetable.removeImage(id))
        const result = await unwrap(bridge().timetable.addImages(picked.paths))
        apply(result.timetable)

        if (result.added > 0) toast(t('timetable.replaced', { count: result.added }), 'success')
        for (const message of result.errors.slice(0, 4)) toast(message, 'error')
      } catch (error) {
        toast(t('timetable.replaceFailed', { reason: tm(formatError(error)) }), 'error')
      }
    }
  })

  return {
    panel,
    current: () => data,
    load,
    async refresh() {
      return load()
    },
    dispose() {
      panel.dispose()
    }
  }
}
