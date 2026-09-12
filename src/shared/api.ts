import type {
  AiCompleteRequest,
  AiCompleteResult,
  AppInfo,
  AppSettings,
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
    /** 归档 / 移回在学 / 加入愿望单；返回完整列表 */
    setStatus(input: CourseStatusInput): Promise<IpcResult<CourseCard[]>>
  }

  materials: {
    list(): Promise<IpcResult<MaterialItem[]>>
    /** 拖拽 / 文件对话框导入（绝对路径），返回整份列表与逐条成败 */
    import(input: MaterialImportInput): Promise<IpcResult<MaterialImportResult>>
    /** 收件箱导入：只传收件箱内的文件名，路径由主进程拼 */
    importInbox(input: {
      fileNames: string[]
      courseCardId: string
      title?: string
    }): Promise<IpcResult<MaterialImportResult>>
    rename(input: { id: string; title: string }): Promise<IpcResult<MaterialItem[]>>
    /** 文件进系统回收站，索引摘除 */
    remove(id: string): Promise<IpcResult<MaterialItem[]>>
    setCard(input: { id: string; courseCardId: string }): Promise<IpcResult<MaterialItem[]>>
    /** 用系统默认程序打开（PDF 阅读器 / Office / WPS） */
    open(id: string): Promise<IpcResult<null>>
    /** 磁盘上有、索引里没有的文件，供「扫描未登记」收编 */
    unregistered(): Promise<IpcResult<MaterialInboxCandidate[]>>
    claim(input: { fileName: string; courseCardId: string }): Promise<IpcResult<MaterialImportResult>>
    /** 打开收件箱目录（资源管理器） */
    openInbox(): Promise<IpcResult<null>>
    /** 系统文件选择对话框（多选） */
    pickFiles(): Promise<IpcResult<{ canceled: boolean; paths: string[] }>>
  }

  /** 非函数成员：preload 上的工具方法（不是 IPC，见 preload/index.ts） */
  pathsFromDrop(files: File[]): string[]

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
    /** 收件箱出现新的候选资料（浏览器扩展的下载落点） */
    onMaterialsInbox(listener: (payload: { files: MaterialInboxCandidate[] }) => void): () => void
  }
}

declare global {
  interface Window {
    studyBoard: StudyBoardApi
  }
}
