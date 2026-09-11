import type {
  AiCompleteRequest,
  AiCompleteResult,
  AppInfo,
  AppSettings,
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
} from './types'

/**
 * 渲染层可见的 API 契约。
 *
 * 刻意写成显式接口而不是从 preload 推导：
 *  - 渲染层不需要、也不应该看到 electron 的类型；
 *  - preload 用 satisfies 约束实现，改错了会在编译期报错；
 *  - 任何新增能力都必须先在这里声明，等于强制过一遍安全评审。
 */

export interface CourseImagePickResult {
  canceled: boolean
  paths: string[]
}

export interface StudyBoardApi {
  app: {
    info(): Promise<IpcResult<AppInfo>>
    openExternal(url: string): Promise<IpcResult<null>>
    openPath(path: string): Promise<IpcResult<null>>
    revealPath(path: string): Promise<IpcResult<null>>
    relaunch(): Promise<IpcResult<null>>
  }

  settings: {
    get(): Promise<IpcResult<AppSettings>>
    patch(patch: SettingsPatch): Promise<IpcResult<AppSettings>>
    chooseLibrary(): Promise<IpcResult<AppSettings>>
    resetLibrary(): Promise<IpcResult<AppSettings>>
  }

  secrets: {
    setAiKey(key: string): Promise<IpcResult<boolean>>
    clearAiKey(): Promise<IpcResult<boolean>>
    setNotionToken(token: string): Promise<IpcResult<boolean>>
    clearNotionToken(): Promise<IpcResult<boolean>>
  }

  dialog: {
    pickImages(): Promise<IpcResult<CourseImagePickResult>>
  }

  timetable: {
    get(): Promise<IpcResult<TimetableData>>
    save(input: TimetableSaveInput): Promise<IpcResult<TimetableData>>
    setCell(input: TimetableSetCellInput): Promise<IpcResult<TimetableData>>
    addImages(paths: string[]): Promise<IpcResult<TimetableImageImportResult>>
    removeImage(id: string): Promise<IpcResult<TimetableData>>
  }

  portal: {
    list(): Promise<IpcResult<PortalSite[]>>
    upsert(site: PortalSiteInput): Promise<IpcResult<PortalSite[]>>
    remove(id: string): Promise<IpcResult<PortalSite[]>>
    fetchIcon(id: string): Promise<IpcResult<PortalSite[]>>
  }

  cards: {
    list(): Promise<IpcResult<CourseCard[]>>
    upsert(card: CourseCardInput): Promise<IpcResult<CourseCard[]>>
    remove(id: string): Promise<IpcResult<CourseCard[]>>
    reorder(ids: string[]): Promise<IpcResult<CourseCard[]>>
  }

  notes: {
    list(): Promise<IpcResult<NoteMeta[]>>
    read(id: string): Promise<IpcResult<NoteDoc>>
    write(input: NoteWriteInput): Promise<IpcResult<NoteDoc>>
    create(title: string): Promise<IpcResult<NoteDoc>>
    remove(id: string): Promise<IpcResult<null>>
    rename(payload: { id: string; title: string }): Promise<IpcResult<NoteDoc>>
    /** 备份一篇笔记，返回备份文件的相对路径 */
    backup(id: string): Promise<IpcResult<string>>
  }

  exporter: {
    note(request: ExportNoteRequest): Promise<IpcResult<ExportNoteResult>>
  }

  ai: {
    test(): Promise<IpcResult<{ model: string; ok: boolean }>>
    complete(request: AiCompleteRequest): Promise<IpcResult<AiCompleteResult>>
  }

  notion: {
    test(): Promise<IpcResult<{ ok: boolean; name: string }>>
    push(noteIds: string[]): Promise<IpcResult<{ pushed: number }>>
    pull(): Promise<IpcResult<{ pulled: number }>>
  }

  events: {
    onLibraryChanged(listener: (payload: LibraryChangedEvent) => void): () => void
    onSettingsChanged(listener: (payload: AppSettings) => void): () => void
  }
}

declare global {
  interface Window {
    studyBoard: StudyBoardApi
  }
}
