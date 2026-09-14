/**
 * IPC 通道白名单。
 *
 * 这里是主进程与渲染层之间唯一的通道清单：
 *  - preload 只会把这些通道暴露给渲染层，渲染层无法自行拼接通道名；
 *  - 主进程启动时会校验：任何不在本清单内的 ipcMain.handle 注册都会抛错，
 *    避免后续新增功能时绕过安全审查随手开一个通道。
 */
export const CHANNELS = {
  /* 应用级 */
  APP_INFO: 'app:info',
  APP_OPEN_EXTERNAL: 'app:open-external',
  APP_OPEN_PATH: 'app:open-path',
  APP_REVEAL_PATH: 'app:reveal-path',
  APP_RELAUNCH: 'app:relaunch',

  /* 设置 */
  SETTINGS_GET: 'settings:get',
  SETTINGS_PATCH: 'settings:patch',
  SETTINGS_CHOOSE_LIBRARY: 'settings:choose-library',
  SETTINGS_RESET_LIBRARY: 'settings:reset-library',
  /**
   * 切换便携模式。
   *
   * 单独开一条通道而不是并进 `SETTINGS_PATCH`：这不是改一个字段，
   * 而是**搬整个数据目录**——有前置校验、可能失败、需要重启才生效。
   * 混在通用 patch 里，调用方会以为它和「改主题」一样是一次原子写入。
   */
  SETTINGS_SET_PORTABLE: 'settings:set-portable',

  /* 密钥（写入后再也不回读，只回布尔） */
  SECRET_SET_AI_KEY: 'secret:set-ai-key',
  SECRET_CLEAR_AI_KEY: 'secret:clear-ai-key',
  SECRET_SET_NOTION_TOKEN: 'secret:set-notion-token',
  SECRET_CLEAR_NOTION_TOKEN: 'secret:clear-notion-token',

  /* 对话框 */
  DIALOG_PICK_IMAGES: 'dialog:pick-images',

  /* 课程表 */
  TIMETABLE_GET: 'timetable:get',
  TIMETABLE_SAVE: 'timetable:save',
  TIMETABLE_SET_CELL: 'timetable:set-cell',
  TIMETABLE_ADD_IMAGES: 'timetable:add-images',
  TIMETABLE_REMOVE_IMAGE: 'timetable:remove-image',

  /* 网站门户 */
  PORTAL_LIST: 'portal:list',
  PORTAL_UPSERT: 'portal:upsert',
  PORTAL_DELETE: 'portal:delete',
  /* 图标字节不走 IPC，而是通过 sb-asset://icon/<file> 读，与课表图片同一套机制 */
  PORTAL_FETCH_ICON: 'portal:fetch-icon',

  /* 课程卡片 */
  CARDS_LIST: 'cards:list',
  CARDS_UPSERT: 'cards:upsert',
  CARDS_DELETE: 'cards:delete',
  CARDS_REORDER: 'cards:reorder',
  CARDS_SET_STATUS: 'cards:set-status',

  /* 课程资料 */
  MATERIALS_LIST: 'materials:list',
  MATERIALS_IMPORT: 'materials:import',
  MATERIALS_IMPORT_INBOX: 'materials:import-inbox',
  MATERIALS_RENAME: 'materials:rename',
  MATERIALS_REMOVE: 'materials:remove',
  MATERIALS_SET_CARD: 'materials:set-card',
  MATERIALS_OPEN: 'materials:open',
  MATERIALS_UNREGISTERED: 'materials:unregistered',
  MATERIALS_CLAIM: 'materials:claim',
  MATERIALS_OPEN_INBOX: 'materials:open-inbox',
  DIALOG_PICK_MATERIALS: 'dialog:pick-materials',

  /* 笔记 */
  NOTES_LIST: 'notes:list',
  NOTES_READ: 'notes:read',
  NOTES_WRITE: 'notes:write',
  NOTES_CREATE: 'notes:create',
  NOTES_DELETE: 'notes:delete',
  NOTES_RENAME: 'notes:rename',
  /* 切到富文本模式前留一份原文件：md 表达不了的东西互转时会退化 */
  NOTES_BACKUP: 'notes:backup',

  NOTES_GROUPS: 'notes:groups',
  NOTES_GROUP_CREATE: 'notes:group-create',
  NOTES_GROUP_RENAME: 'notes:group-rename',
  NOTES_GROUP_REMOVE: 'notes:group-remove',
  NOTES_GROUP_MOVE: 'notes:group-move',
  NOTES_SET_GROUP: 'notes:set-group',

  /* 导出 */
  EXPORT_NOTE: 'export:note',

  /* AI */
  AI_TEST: 'ai:test',
  AI_COMPLETE: 'ai:complete',

  /* Notion */
  NOTION_TEST: 'notion:test',
  NOTION_PUSH: 'notion:push',
  NOTION_PULL: 'notion:pull',
  /** 用户为某一条冲突选了「以哪边为准」之后回到主进程 */
  NOTION_RESOLVE: 'notion:resolve',
  /** 拉取时预览远端那篇的内容（用户决定保留哪边之前得先看得见） */
  NOTION_PREVIEW: 'notion:preview',

  /* 主进程 -> 渲染层 事件 */
  EVENT_LIBRARY_CHANGED: 'event:library-changed',
  EVENT_SETTINGS_CHANGED: 'event:settings-changed',
  /** 收件箱里出现了新的候选资料，渲染层弹归属对话框 */
  EVENT_MATERIALS_INBOX: 'event:materials-inbox'
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]

/** 允许渲染层订阅的主进程事件（白名单） */
export const EVENT_CHANNELS: readonly ChannelName[] = [
  CHANNELS.EVENT_LIBRARY_CHANGED,
  CHANNELS.EVENT_SETTINGS_CHANGED,
  CHANNELS.EVENT_MATERIALS_INBOX
] as const
