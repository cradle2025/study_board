import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

import { CHANNELS, EVENT_CHANNELS, type ChannelName } from '@shared/channels'
import type { CourseImagePickResult, StudyBoardApi } from '@shared/api'
import type {
  AppInfo,
  AppSettings,
  AiCompleteRequest,
  AiCompleteResult,
  CourseCard,
  CourseCardInput,
  CourseStatusInput,
  ExportNoteRequest,
  ExportNoteResult,
  IpcResult,
  LibraryChangedEvent,
  MaterialImportInput,
  MaterialImportResult,
  MaterialInboxCandidate,
  MaterialItem,
  NoteDoc,
  NoteGroup,
  NoteMeta,
  NoteWriteInput,
  NotionPullResult,
  NotionPushResult,
  NotionResolveInput,
  NotionResolveResult,
  NotionTestResult,
  PortalSite,
  PortalSiteInput,
  SettingsPatch,
  TimetableData,
  TimetableImageImportResult,
  TimetableSaveInput,
  TimetableSetCellInput
} from '@shared/types'

/**
 * 渲染层与主进程之间唯一的桥。
 *
 * 安全约定：
 *  - 渲染层拿不到 ipcRenderer 本体，只能调用下面这些具名方法；
 *  - 通道名在这里写死，渲染层无法自行拼接；
 *  - 事件订阅必须在 EVENT_CHANNELS 白名单内；
 *  - 所有调用都返回 IpcResult，永远不抛异常到渲染层。
 */

async function invoke<T>(channel: ChannelName, payload?: unknown): Promise<IpcResult<T>> {
  try {
    const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>
    return result
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '主进程调用失败'
    }
  }
}

function subscribe<T>(channel: ChannelName, listener: (payload: T) => void): () => void {
  if (!EVENT_CHANNELS.includes(channel)) {
    throw new Error(`未登记的事件通道：${channel}`)
  }
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api = {
  app: {
    info: () => invoke<AppInfo>(CHANNELS.APP_INFO),
    openExternal: (url: string) => invoke<null>(CHANNELS.APP_OPEN_EXTERNAL, url),
    openPath: (path: string) => invoke<null>(CHANNELS.APP_OPEN_PATH, path),
    revealPath: (path: string) => invoke<null>(CHANNELS.APP_REVEAL_PATH, path),
    relaunch: () => invoke<null>(CHANNELS.APP_RELAUNCH)
  },

  settings: {
    get: () => invoke<AppSettings>(CHANNELS.SETTINGS_GET),
    patch: (patch: SettingsPatch) => invoke<AppSettings>(CHANNELS.SETTINGS_PATCH, patch),
    chooseLibrary: () => invoke<AppSettings>(CHANNELS.SETTINGS_CHOOSE_LIBRARY),
    resetLibrary: () => invoke<AppSettings>(CHANNELS.SETTINGS_RESET_LIBRARY)
  },

  secrets: {
    setAiKey: (key: string) => invoke<boolean>(CHANNELS.SECRET_SET_AI_KEY, key),
    clearAiKey: () => invoke<boolean>(CHANNELS.SECRET_CLEAR_AI_KEY),
    setNotionToken: (token: string) => invoke<boolean>(CHANNELS.SECRET_SET_NOTION_TOKEN, token),
    clearNotionToken: () => invoke<boolean>(CHANNELS.SECRET_CLEAR_NOTION_TOKEN)
  },

  dialog: {
    pickImages: () => invoke<CourseImagePickResult>(CHANNELS.DIALOG_PICK_IMAGES)
  },

  timetable: {
    get: () => invoke<TimetableData>(CHANNELS.TIMETABLE_GET),
    save: (input: TimetableSaveInput) => invoke<TimetableData>(CHANNELS.TIMETABLE_SAVE, input),
    setCell: (input: TimetableSetCellInput) =>
      invoke<TimetableData>(CHANNELS.TIMETABLE_SET_CELL, input),
    addImages: (paths: string[]) =>
      invoke<TimetableImageImportResult>(CHANNELS.TIMETABLE_ADD_IMAGES, paths),
    removeImage: (id: string) => invoke<TimetableData>(CHANNELS.TIMETABLE_REMOVE_IMAGE, id)
  },

  portal: {
    list: () => invoke<PortalSite[]>(CHANNELS.PORTAL_LIST),
    upsert: (site: PortalSiteInput) => invoke<PortalSite[]>(CHANNELS.PORTAL_UPSERT, site),
    remove: (id: string) => invoke<PortalSite[]>(CHANNELS.PORTAL_DELETE, id),
    fetchIcon: (id: string) => invoke<PortalSite[]>(CHANNELS.PORTAL_FETCH_ICON, id)
  },

  cards: {
    list: () => invoke<CourseCard[]>(CHANNELS.CARDS_LIST),
    upsert: (card: CourseCardInput) => invoke<CourseCard[]>(CHANNELS.CARDS_UPSERT, card),
    remove: (id: string) => invoke<CourseCard[]>(CHANNELS.CARDS_DELETE, id),
    reorder: (ids: string[]) => invoke<CourseCard[]>(CHANNELS.CARDS_REORDER, ids),
    setStatus: (input: CourseStatusInput) =>
      invoke<CourseCard[]>(CHANNELS.CARDS_SET_STATUS, input)
  },

  materials: {
    list: () => invoke<MaterialItem[]>(CHANNELS.MATERIALS_LIST),
    import: (input: MaterialImportInput) =>
      invoke<MaterialImportResult>(CHANNELS.MATERIALS_IMPORT, input),
    importInbox: (input: { fileNames: string[]; courseCardId: string; title?: string }) =>
      invoke<MaterialImportResult>(CHANNELS.MATERIALS_IMPORT_INBOX, input),
    rename: (input: { id: string; title: string }) =>
      invoke<MaterialItem[]>(CHANNELS.MATERIALS_RENAME, input),
    remove: (id: string) => invoke<MaterialItem[]>(CHANNELS.MATERIALS_REMOVE, id),
    setCard: (input: { id: string; courseCardId: string }) =>
      invoke<MaterialItem[]>(CHANNELS.MATERIALS_SET_CARD, input),
    open: (id: string) => invoke<null>(CHANNELS.MATERIALS_OPEN, id),
    unregistered: () => invoke<MaterialInboxCandidate[]>(CHANNELS.MATERIALS_UNREGISTERED),
    claim: (input: { fileName: string; courseCardId: string }) =>
      invoke<MaterialImportResult>(CHANNELS.MATERIALS_CLAIM, input),
    openInbox: () => invoke<null>(CHANNELS.MATERIALS_OPEN_INBOX),
    pickFiles: () =>
      invoke<{ canceled: boolean; paths: string[] }>(CHANNELS.DIALOG_PICK_MATERIALS)
  },

  notes: {
    list: () => invoke<NoteMeta[]>(CHANNELS.NOTES_LIST),
    read: (id: string) => invoke<NoteDoc>(CHANNELS.NOTES_READ, id),
    write: (input: NoteWriteInput) => invoke<NoteDoc>(CHANNELS.NOTES_WRITE, input),
    create: (title: string | { title: string; groupId?: string }) =>
      invoke<NoteDoc>(CHANNELS.NOTES_CREATE, title),
    remove: (id: string) => invoke<null>(CHANNELS.NOTES_DELETE, id),
    rename: (payload: { id: string; title: string }) =>
      invoke<NoteDoc>(CHANNELS.NOTES_RENAME, payload),
    backup: (id: string) => invoke<string>(CHANNELS.NOTES_BACKUP, id),

    groups: () => invoke<NoteGroup[]>(CHANNELS.NOTES_GROUPS),
    createGroup: (payload: { name: string; parentId?: string }) =>
      invoke<NoteGroup[]>(CHANNELS.NOTES_GROUP_CREATE, payload),
    renameGroup: (payload: { id: string; name: string }) =>
      invoke<NoteGroup[]>(CHANNELS.NOTES_GROUP_RENAME, payload),
    removeGroup: (id: string) => invoke<NoteGroup[]>(CHANNELS.NOTES_GROUP_REMOVE, id),
    moveGroup: (payload: { id: string; parentId: string }) =>
      invoke<NoteGroup[]>(CHANNELS.NOTES_GROUP_MOVE, payload),
    setGroup: (payload: { id: string; groupId: string }) =>
      invoke<NoteMeta[]>(CHANNELS.NOTES_SET_GROUP, payload)
  },

  exporter: {
    note: (request: ExportNoteRequest) => invoke<ExportNoteResult>(CHANNELS.EXPORT_NOTE, request)
  },

  ai: {
    test: () => invoke<{ model: string; ok: boolean }>(CHANNELS.AI_TEST),
    complete: (request: AiCompleteRequest) =>
      invoke<AiCompleteResult>(CHANNELS.AI_COMPLETE, request)
  },

  notion: {
    test: () => invoke<NotionTestResult>(CHANNELS.NOTION_TEST),
    push: (noteIds: string[]) => invoke<NotionPushResult>(CHANNELS.NOTION_PUSH, noteIds),
    pull: () => invoke<NotionPullResult>(CHANNELS.NOTION_PULL),
    resolve: (input: NotionResolveInput) =>
      invoke<NotionResolveResult>(CHANNELS.NOTION_RESOLVE, input),
    preview: (noteId: string) =>
      invoke<{ title: string; content: string }>(CHANNELS.NOTION_PREVIEW, noteId)
  },

  events: {
    onLibraryChanged: (listener: (payload: LibraryChangedEvent) => void) =>
      subscribe<LibraryChangedEvent>(CHANNELS.EVENT_LIBRARY_CHANGED, listener),
    onSettingsChanged: (listener: (payload: AppSettings) => void) =>
      subscribe<AppSettings>(CHANNELS.EVENT_SETTINGS_CHANGED, listener),
    onMaterialsInbox: (listener: (payload: { files: MaterialInboxCandidate[] }) => void) =>
      subscribe<{ files: MaterialInboxCandidate[] }>(CHANNELS.EVENT_MATERIALS_INBOX, listener)
  },

  /**
   * 拖拽文件的真实路径换算。
   *
   * 浏览器沙箱里的 File 对象只有名字和大小，路径是 Electron 的私有信息；
   * `webUtils.getPathForFile` 是官方给沙箱渲染层留的唯一正门（老的 file.path 已废弃）。
   * 渲染层把 File 对象传进来，这里逐个换算，拿不到路径的（比如从网页拖来的图）返回空串被过滤。
   */
  pathsFromDrop: (files: File[]): string[] => {
    const paths: string[] = []
    for (const file of files) {
      try {
        const path = webUtils.getPathForFile(file)
        if (path && path.length > 0) paths.push(path)
      } catch {
        /* 拿不到路径（非本地文件），跳过 */
      }
    }
    return paths
  }
} satisfies StudyBoardApi

contextBridge.exposeInMainWorld('studyBoard', Object.freeze(api))
