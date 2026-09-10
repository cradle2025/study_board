import type { TimetableCell, TimetableData } from '@shared/types'

import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { confirmAction } from '../lib/overlay'
import { createTimetablePanel, type TimetablePanelHandle } from './timetable-panel'

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
  const prefix = options.errorPrefix ?? '课表'

  let data: TimetableData | null = null
  // 面板在下面才创建，但 apply 会被面板自己的回调用到，所以先声明后赋值
  let panel: TimetablePanelHandle

  const apply = (next: TimetableData): TimetableData => {
    data = next
    panel.render(next)
    options.onData?.(next)
    return next
  }

  async function load(): Promise<TimetableData | null> {
    try {
      return apply(await unwrap(bridge().timetable.get()))
    } catch (error) {
      toast(`${prefix}加载失败：${formatError(error)}`, 'error')
      return null
    }
  }

  panel = createTimetablePanel({
    editable: options.editable,

    async onSaveCell(key: string, cell: TimetableCell | null): Promise<void> {
      try {
        apply(await unwrap(bridge().timetable.setCell({ key, cell })))
        toast(cell ? '已保存' : '已清空', 'success')
      } catch (error) {
        toast(`保存失败：${formatError(error)}`, 'error')
        // 保存失败时回滚界面，避免显示的内容和磁盘不一致
        if (data) panel.render(data)
      }
    },

    async onAddImages(): Promise<void> {
      try {
        const picked = await unwrap(bridge().dialog.pickImages())
        if (picked.canceled || picked.paths.length === 0) return

        const result = await unwrap(bridge().timetable.addImages(picked.paths))
        apply(result.timetable)

        if (result.added > 0) toast(`已导入 ${result.added} 张课表照片`, 'success')
        for (const message of result.errors.slice(0, 4)) toast(message, 'error')
        if (result.errors.length > 4) {
          toast(`另有 ${result.errors.length - 4} 张未能导入`, 'error')
        }
      } catch (error) {
        toast(`导入失败：${formatError(error)}`, 'error')
      }
    },

    async onRemoveImage(id: string): Promise<void> {
      const target = data?.images.find((image) => image.id === id)
      const confirmed = await confirmAction({
        title: '删除这张课表照片？',
        message: target ? `「${target.sourceName}」将从本地移除，此操作不可撤销。` : undefined,
        confirmText: '删除',
        danger: true
      })
      if (!confirmed) return

      try {
        apply(await unwrap(bridge().timetable.removeImage(id)))
        toast('已删除', 'success')
      } catch (error) {
        toast(`删除失败：${formatError(error)}`, 'error')
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

        if (result.added > 0) toast(`已替换为 ${result.added} 张照片`, 'success')
        for (const message of result.errors.slice(0, 4)) toast(message, 'error')
      } catch (error) {
        toast(`替换失败：${formatError(error)}`, 'error')
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
