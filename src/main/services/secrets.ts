import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { secretsFile } from '../paths'

/**
 * 密钥存储（AI Key / Notion Token）。
 *
 * 三条不可动摇的规则：
 *
 * 1. **绝不明文落盘**。走 Electron 的 `safeStorage`（Windows 上是 DPAPI，
 *    macOS 上是 Keychain），加密后的字节 base64 后写进 `secrets.bin`；
 *    `config.json` 里**只留一个 `hasApiKey` 布尔**，永远不碰密钥本体。
 * 2. **系统钥匙串不可用时不写**。Linux 上没有 keyring 时
 *    `safeStorage.isEncryptionAvailable()` 会返回 false——这时候**直接拒绝保存**，
 *    而不是退化成明文。少一个功能，好过把用户的密钥摊在磁盘上。
 * 3. **永不回读**。没有「把密钥显示出来」的接口，`get()` 只在主进程内部用，
 *    渲染层能拿到的只有布尔值。
 *
 * 解密后的明文只活在内存里，进程退出即消失。
 */

export type SecretKind = 'aiKey' | 'notionToken'

/** 密钥长度上限：给足余量，同时挡住「把一整篇文档粘进密钥框」这种误操作 */
const MAX_SECRET_LENGTH = 4096

const VERSION = 1

interface SecretsFileShape {
  version: number
  /** base64(safeStorage.encryptString(明文)) */
  values: Partial<Record<SecretKind, string>>
}

function isSecretKind(value: string): value is SecretKind {
  return value === 'aiKey' || value === 'notionToken'
}

export class SecretsStore {
  #file: string
  #values = new Map<SecretKind, string>()
  #available: boolean

  constructor(portable: boolean) {
    this.#file = secretsFile(portable)
    // 要在 app ready 之后取：ready 前 isEncryptionAvailable 在部分平台上不准
    this.#available = safeStorage.isEncryptionAvailable()
    if (!this.#available) {
      console.warn('[secrets] 系统钥匙串不可用，密钥相关功能将拒绝保存')
    }
    this.#load()
  }

  /** 系统钥匙串是否可用。不可用时设置页会直接把存密钥的入口禁掉 */
  get available(): boolean {
    return this.#available
  }

  #load(): void {
    if (!existsSync(this.#file)) return

    let raw = ''
    try {
      raw = readFileSync(this.#file, 'utf-8')
    } catch (error) {
      console.warn('[secrets] 读不到密钥文件：', error)
      return
    }

    try {
      const parsed = JSON.parse(raw) as Partial<SecretsFileShape>
      const values = parsed?.values
      if (!values || typeof values !== 'object') return

      for (const [key, blob] of Object.entries(values)) {
        if (typeof blob !== 'string' || !isSecretKind(key)) continue
        try {
          const plain = safeStorage.decryptString(Buffer.from(blob, 'base64'))
          if (plain) this.#values.set(key, plain)
        } catch {
          // 解不开的常见原因：换了电脑、重装了系统、换过系统账户。
          // 这种情况当「没配过」处理即可——报错阻塞启动反而更糟
          console.warn(`[secrets] ${key} 无法解密（可能来自另一台机器），已忽略`)
        }
      }
    } catch (error) {
      // 文件坏了：留个现场再重建，与其它存储一个套路
      console.error('[secrets] 密钥文件解析失败，将重建：', error)
      try {
        renameSync(this.#file, `${this.#file}.broken`)
      } catch {
        /* 备份失败也不该让应用起不来 */
      }
    }
  }

  #persist(): void {
    const values: Partial<Record<SecretKind, string>> = {}
    for (const [key, plain] of this.#values) {
      values[key] = safeStorage.encryptString(plain).toString('base64')
    }

    const payload: SecretsFileShape = { version: VERSION, values }
    const tmp = `${this.#file}.tmp`
    // 0o600：就算是加密过的，也没必要让同机其它用户读到
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, this.#file)
  }

  has(kind: SecretKind): boolean {
    return this.#values.has(kind)
  }

  /** 只给主进程内部用（发请求时取密钥）。渲染层没有对应的通道 */
  get(kind: SecretKind): string | null {
    return this.#values.get(kind) ?? null
  }

  set(kind: SecretKind, raw: string): void {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) throw new Error('密钥不能为空')
    if (value.length > MAX_SECRET_LENGTH) throw new Error('密钥过长，请检查是否粘贴错了内容')
    if (/[\r\n]/.test(value)) throw new Error('密钥不能包含换行')

    if (!this.#available) {
      throw new Error(
        '当前系统的密钥库不可用，为避免把密钥明文写进磁盘，已拒绝保存。请先配置系统钥匙串后重试。'
      )
    }

    this.#values.set(kind, value)
    this.#persist()
  }

  clear(kind: SecretKind): void {
    if (!this.#values.delete(kind)) return
    // 一个都不剩也照样落一次盘：留着旧密文只会让人以为密钥还在。
    // 写空的 payload（而不是删文件）是为了让「文件存在但里面没东西」
    // 这个状态可预期，不用担心下次启动时文件在不在
    this.#persist()
  }
}
