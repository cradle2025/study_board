import { app } from 'electron'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'

import type { AppPaths } from '@shared/types'
import { MATERIALS_DIRNAME } from '@shared/materials'

/**
 * 所有本地路径的唯一出口。
 *
 * 设计要点：
 *  - 默认全部落在系统标准用户目录（Windows 的 %APPDATA%、macOS 的 Application Support），
 *    避免安装到 Program Files / /Applications 后没有写权限；
 *  - 「便携模式」把数据放到可执行文件同级目录，方便塞进 U 盘；
 *  - 任何来自渲染层的相对路径都必须经过 safeJoin 校验，禁止路径穿越。
 */

let cachedUserDataOverride: string | null = null

export function setUserDataOverride(dir: string | null): void {
  cachedUserDataOverride = dir
}

export function userDataRoot(): string {
  return cachedUserDataOverride ?? app.getPath('userData')
}

/** 便携模式下的数据根目录：可执行文件同级的 study-board-data */
export function portableRoot(): string {
  return join(dirname(app.getPath('exe')), 'study-board-data')
}

export function dataRoot(portable: boolean): string {
  return portable && app.isPackaged ? portableRoot() : userDataRoot()
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 便携模式的判定不能依赖配置文件（配置文件本身就在数据目录里，会死循环）。
 * 因此改为看标记：可执行文件同级的 study-board-data 目录里存在
 * portable.flag 或 config.json，就当便携模式启动。
 */
export function detectPortableMode(): boolean {
  if (!app.isPackaged) return false
  const root = portableRoot()
  return existsSync(join(root, 'portable.flag')) || existsSync(join(root, 'config.json'))
}

/** 写入便携模式标记文件 */
export function writePortableFlag(portable: boolean): void {
  const root = portableRoot()
  const flag = join(root, 'portable.flag')
  if (portable) {
    ensureDir(root)
    writeFileSync(flag, 'portable\n', 'utf-8')
  } else if (existsSync(flag)) {
    rmSync(flag, { force: true })
  }
}

export function configFile(portable: boolean): string {
  return join(dataRoot(portable), 'config.json')
}

export function secretsFile(portable: boolean): string {
  return join(dataRoot(portable), 'secrets.bin')
}

export function defaultNotesLibraryDir(portable: boolean): string {
  return join(dataRoot(portable), 'notes_library')
}

export function timetableImagesDir(portable: boolean): string {
  return join(dataRoot(portable), 'timetable_images')
}

/** 课表内容（每节时间、单元格、图片索引） */
export function timetableFile(portable: boolean): string {
  return join(dataRoot(portable), 'timetable.json')
}

export function iconsCacheDir(portable: boolean): string {
  return join(dataRoot(portable), 'icons_cache')
}

/** 网站门户（快捷方式列表） */
export function portalFile(portable: boolean): string {
  return join(dataRoot(portable), 'portal.json')
}

/** 课程卡片 */
export function cardsFile(portable: boolean): string {
  return join(dataRoot(portable), 'cards.json')
}

export function tempDir(portable: boolean): string {
  return join(dataRoot(portable), 'temp')
}

/**
 * 运行日志目录。
 *
 * 出问题时用户手里得有个能交出来的现场——打包后的应用没有控制台，
 * 光在终端里打日志等于没打。放数据目录下面，跟「打开数据目录」那个按钮对得上。
 */
export function logsDir(portable: boolean): string {
  return join(dataRoot(portable), 'logs')
}

export function resolveAppPaths(portable: boolean, notesLibraryDir: string): AppPaths {
  return {
    userData: dataRoot(portable),
    notesLibrary: notesLibraryDir,
    timetableImages: timetableImagesDir(portable),
    iconsCache: iconsCacheDir(portable),
    materials: materialsDir(notesLibraryDir),
    logs: logsDir(portable)
  }
}

/**
 * 课程资料目录：**跟笔记库走**，放在库内的 attachments/ 下。
 *
 * 为什么不放 dataRoot：资料要和笔记待在一起——Obsidian 原生能预览库里的 PDF，
 * 备份/同步也只管一个文件夹。用户换笔记库目录时，资料目录跟着换
 * （context.ts 的 refreshBuckets 负责跟着重建）。
 */
export function materialsDir(notesLibraryDir: string): string {
  return join(notesLibraryDir, MATERIALS_DIRNAME)
}

/** 资料索引文件。跟资料目录走，换库时各自成套 */
export function materialsFile(notesLibraryDir: string): string {
  return join(materialsDir(notesLibraryDir), '.materials.json')
}

/**
 * 把不受信任的相对路径安全地拼到 base 下。
 * 拒绝绝对路径、盘符、`..` 穿越，以及 Windows 下的 UNC 前缀。
 */
export function safeJoin(base: string, relative: string): string {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('路径不能为空')
  }
  if (relative.includes('\0')) {
    throw new Error('路径包含非法字符')
  }
  if (isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.startsWith('\\\\')) {
    throw new Error(`拒绝绝对路径：${relative}`)
  }

  const normalizedBase = resolve(normalize(base))
  const target = resolve(normalizedBase, relative)

  if (target !== normalizedBase && !target.startsWith(normalizedBase + sep)) {
    throw new Error(`路径越界：${relative}`)
  }
  return target
}

/** 生成一个不依赖外部库的 uuid，用于所有实体 id */
export function newId(): string {
  return crypto.randomUUID()
}
