import type { MaterialImportResult, MaterialInboxCandidate, MaterialItem } from '@shared/types'

import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { confirmAction } from '../lib/overlay'
import { createMaterialsGrid, type MaterialGridHandle } from './materials-grid'

/**
 * 课程资料的读写控制器。
 *
 * 与卡片 / 门户同一套结构：控制器管业务与错误处理，视图只管长什么样。
 * 「导入后告诉别的页面刷新」用 window 上的 `sb:materials-changed` 自定义事件——
 * 资料可能在任何页面被拖进来，而各视图自己决定要不要重新加载。
 */

export function notifyMaterialsChanged(): void {
  window.dispatchEvent(new CustomEvent('sb:materials-changed'))
}

export interface MaterialsControllerOptions {
  onData?(items: readonly MaterialItem[]): void
  /** 只看归属这门课的资料（卡片角标跳转用）。null = 全部 */
  filterCardId?: string | null
  /** 点「改归属」时需要课程候选，由视图提供（复用课程卡片的下拉源） */
  courseCards?(): readonly { id: string; courseName: string }[]
}

export interface MaterialsController {
  grid: MaterialGridHandle
  current(): readonly MaterialItem[]
  setFilter(cardId: string | null): void
  load(): Promise<readonly MaterialItem[]>
  importPaths(paths: string[], courseCardId: string, title?: string): Promise<void>
  importInbox(fileNames: string[], courseCardId: string): Promise<void>
  claim(fileName: string, courseCardId: string): Promise<void>
  unregistered(): Promise<MaterialInboxCandidate[]>
  dispose(): void
}

function announceResult(result: MaterialImportResult): void {
  const failed = result.errors.length
  if (result.added > 0 && failed === 0) {
    toast(`已导入 ${result.added} 份资料`, 'success')
  } else if (result.added > 0) {
    toast(`导入 ${result.added} 份，${failed} 份失败：${result.errors[0]}`, 'info')
  } else if (failed > 0) {
    toast(`导入失败：${result.errors[0]}`, 'error')
  }
  notifyMaterialsChanged()
}

export function createMaterialsController(options: MaterialsControllerOptions): MaterialsController {
  let items: readonly MaterialItem[] = []
  let filterCardId: string | null = options.filterCardId ?? null

  const grid: MaterialGridHandle = createMaterialsGrid({
    courseNameOf: (cardId) =>
      options.courseCards?.().find((card) => card.id === cardId)?.courseName ?? '',

    async onOpen(item) {
      try {
        await unwrap(bridge().materials.open(item.id))
      } catch (error) {
        toast(`打不开：${formatError(error)}`, 'error')
      }
    },

    async onRemove(item) {
      const confirmed = await confirmAction({
        title: `删除「${item.title}」？`,
        message: '文件会移入系统回收站，误删了还能捞回来。',
        confirmText: '删除',
        danger: true
      })
      if (!confirmed) return
      try {
        await unwrap(bridge().materials.remove(item.id))
        toast('已删除（文件在回收站里）', 'success')
        notifyMaterialsChanged()
      } catch (error) {
        toast(`删除失败：${formatError(error)}`, 'error')
      }
    },

    async onSetCard(item) {
      const cards = options.courseCards?.() ?? []
      const { openMaterialCourseDialog } = await import('./material-form')
      const next = await openMaterialCourseDialog(item, cards)
      if (next === null) return
      try {
        await unwrap(bridge().materials.setCard({ id: item.id, courseCardId: next }))
        toast(next === '' ? '已设为未归类' : '已改归属', 'success')
        notifyMaterialsChanged()
      } catch (error) {
        toast(`改归属失败：${formatError(error)}`, 'error')
      }
    },

    async onRename(item) {
      const { openMaterialRenameDialog } = await import('./material-form')
      const title = await openMaterialRenameDialog(item)
      if (title === null) return
      try {
        await unwrap(bridge().materials.rename({ id: item.id, title }))
        toast('已重命名', 'success')
        notifyMaterialsChanged()
      } catch (error) {
        toast(`重命名失败：${formatError(error)}`, 'error')
      }
    }
  })

  const apply = (): void => {
    const visible = filterCardId
      ? items.filter((item) => item.courseCardId === filterCardId)
      : items
    grid.render(visible)
    options.onData?.(visible)
  }

  return {
    grid,
    current: () => items,

    setFilter(cardId) {
      filterCardId = cardId
      apply()
    },

    async load() {
      try {
        items = await unwrap(bridge().materials.list())
        apply()
      } catch (error) {
        toast(`资料加载失败：${formatError(error)}`, 'error')
      }
      return items
    },

    async importPaths(paths, courseCardId, title) {
      try {
        const result = await unwrap(
          bridge().materials.import({ paths, courseCardId, title, sourcePolicy: 'keep' })
        )
        items = result.materials
        apply()
        announceResult(result)
      } catch (error) {
        toast(`导入失败：${formatError(error)}`, 'error')
      }
    },

    async importInbox(fileNames, courseCardId) {
      try {
        const result = await unwrap(bridge().materials.importInbox({ fileNames, courseCardId }))
        items = result.materials
        apply()
        announceResult(result)
      } catch (error) {
        toast(`导入失败：${formatError(error)}`, 'error')
      }
    },

    async claim(fileName, courseCardId) {
      try {
        const result = await unwrap(bridge().materials.claim({ fileName, courseCardId }))
        items = result.materials
        apply()
        announceResult(result)
      } catch (error) {
        toast(`收编失败：${formatError(error)}`, 'error')
      }
    },

    async unregistered() {
      try {
        return await unwrap(bridge().materials.unregistered())
      } catch (error) {
        toast(`扫描失败：${formatError(error)}`, 'error')
        return []
      }
    },

    dispose() {
      grid.dispose()
    }
  }
}
