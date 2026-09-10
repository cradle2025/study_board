import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { CHANNELS, EVENT_CHANNELS, type ChannelName } from '@shared/channels'
import type { CourseImagePickResult, StudyBoardApi } from '@shared/api'
import type {
  AppInfo,
  AppSettings,
  AiCompleteRequest,
  AiCompleteResult,
  CourseCard,
  CourseCardInput,
  ExportNoteRequest,
  ExportNoteResult,
  IpcResult,
  LibraryChangedEvent,
  NoteDoc,
  NoteMeta,
  NoteWriteInput,
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
    reorder: (ids: string[]) => invoke<CourseCard[]>(CHANNELS.CARDS_REORDER, ids)
  },

  notes: {
    list: () => invoke<NoteMeta[]>(CHANNELS.NOTES_LIST),
    read: (id: string) => invoke<NoteDoc>(CHANNELS.NOTES_READ, id),
    write: (input: NoteWriteInput) => invoke<NoteDoc>(CHANNELS.NOTES_WRITE, input),
    create: (title: string) => invoke<NoteDoc>(CHANNELS.NOTES_CREATE, title),
    remove: (id: string) => invoke<null>(CHANNELS.NOTES_DELETE, id),
    rename: (payload: { id: string; title: string }) =>
      invoke<NoteDoc>(CHANNELS.NOTES_RENAME, payload)
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
    test: () => invoke<{ ok: boolean; name: string }>(CHANNELS.NOTION_TEST),
    push: (noteIds: string[]) => invoke<{ pushed: number }>(CHANNELS.NOTION_PUSH, noteIds),
    pull: () => invoke<{ pulled: number }>(CHANNELS.NOTION_PULL)
  },

  events: {
    onLibraryChanged: (listener: (payload: LibraryChangedEvent) => void) =>
      subscribe<LibraryChangedEvent>(CHANNELS.EVENT_LIBRARY_CHANGED, listener),
    onSettingsChanged: (listener: (payload: AppSettings) => void) =>
      subscribe<AppSettings>(CHANNELS.EVENT_SETTINGS_CHANGED, listener)
  }
} satisfies StudyBoardApi

contextBridge.exposeInMainWorld('studyBoard', Object.freeze(api))
