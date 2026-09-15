import { app } from 'electron'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { mkdirSync, cpSync, existsSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

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

/**
 * 安装程序在更新时会把便携数据目录暂存到 `$TEMP`（见 `build/installer.nsh`），
 * 装完再挪回来。如果安装中途失败，它就会留在那儿 —— 而程序找不到
 * `study-board-data` 时会退回 `%APPDATA%`，用户看到的就是「数据全没了」。
 *
 * 这里做一次兜底：暂存还在、原位却空了，就把它挪回去。
 *
 * **只在原位不存在时恢复**。原位已经有东西的时候把陈旧的暂存挪回去，
 * 等于用旧数据覆盖新的 —— 那比不恢复更糟。
 */
export function rescueStashedPortableData(): string | null {
  if (!app.isPackaged) return null
  const stash = join(tmpdir(), 'StudyBoard-portable-stash')
  if (!existsSync(stash)) return null

  const target = portableRoot()
  if (existsSync(target)) return null

  try {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(stash, target)
    return target
  } catch {
    // 挪不动就留着，下次启动再试。绝不能在这里删它
    return null
  }
}

/** `child` 是否落在 `parent` 里面（含自身）。用来挡住「把目录复制进自己」 */
function isInside(parent: string, child: string): boolean {
  const a = resolve(normalize(parent))
  const b = resolve(normalize(child))
  return b === a || b.startsWith(a + sep)
}

/**
 * 数据根目录搬迁：把数据从「现在住的地方」整份复制到「要搬去的地方」。
 *
 * 三件事按这个顺序做，顺序本身是安全设计：
 *  1. 拒绝「搬进自己里面」——否则复制会无限递归，把磁盘写满；
 *  2. **复制**（而不是移动）到新位置。复制失败时旧数据一个字节都没动，
 *     用户重来一次就行；移动失败则会留下一个「两边都不完整」的烂摊子；
 *  3. 复制**成功之后**才写 / 删标记文件。标记决定下次启动读哪里，
 *     先写标记再复制的话，中途失败就等于把用户指向一个空目录。
 *
 * 刻意**不删旧目录**：它是这次搬迁的兜底。用户确认新位置没问题之后
 * 可以自己删掉，界面上会告诉他旧目录在哪。
 */
export function copyDataRoot(fromPortable: boolean, toPortable: boolean): string {
  const from = dataRoot(fromPortable)
  const to = dataRoot(toPortable)
  if (isInside(from, to)) throw new Error('目标目录在数据目录内部，拒绝搬迁')
  if (isInside(to, from)) throw new Error('数据目录在目标目录内部，拒绝搬迁')
  if (!existsSync(from)) throw new Error('当前数据目录不存在')

  ensureDir(dirname(to))
  // force:true —— 目标目录里可能有上一轮留下的旧文件（比如用户来回切过
  // 便携模式），必须让**当前位置**成为唯一事实来源，否则会读出一个
  // 「新旧混在一起」的数据目录。中途失败也不要紧：标记文件还没写，
  // 下次启动仍然读原位置，而原位置一个字节都没动
  cpSync(from, to, { recursive: true, force: true, errorOnExist: false })

  writePortableFlag(toPortable)
  return to
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

/** 日历 / 日程（含学期开学日与用户自己加的日程） */
export function calendarFile(portable: boolean): string {
  return join(dataRoot(portable), 'calendar.json')
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
