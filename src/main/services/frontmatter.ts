/**
 * YAML frontmatter 的最小实现。
 *
 * 刻意**不引入 js-yaml**：
 *  - 我们只需要「键值对 + 字符串数组」这一点子集，完整 YAML 规范（锚点、多行折叠、
 *    类型标签…）在这里全是攻击面，而且是永远用不到的攻击面；
 *  - 纯手写约 100 行，没有版本周期，符合项目「运行时依赖越少越好」的取向。
 *
 * 兼容目标：**Obsidian 认得的 frontmatter**。只写简单标量和小数组，
 * 不写嵌套结构、不写多行字符串——凡是 Obsidian 会显示成「复杂对象」的写法都避开。
 *
 * 已知取舍：如果用户在一篇没有 frontmatter 的笔记开头写了一条 `---` 分隔线，
 * 会被当成 frontmatter 的开头。Obsidian 的行为也是如此，这里保持一致。
 */

export type FrontmatterValue = string | number | boolean | string[]
export type Frontmatter = Record<string, FrontmatterValue>

export interface ParsedNote {
  data: Frontmatter
  /** 去掉 frontmatter 之后的正文 */
  content: string
}

const OPEN = '---'

/** 把值收敛成允许的类型；认不出来的一律当字符串 */
function coerce(raw: string): FrontmatterValue {
  const value = raw.trim()
  if (value.length === 0) return ''

  if (value === 'true') return true
  if (value === 'false') return false

  // 引号包起来的，一律当字符串，不再猜类型
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  if (quoted) return quoted[1] ?? ''

  // 行内数组：[a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim().replace(/^["']|["']$/g, ''))
      .filter((item) => item.length > 0)
  }

  if (/^-?\d+$/.test(value)) {
    const n = Number(value)
    if (Number.isSafeInteger(n)) return n
  }

  return value
}

/**
 * 写出去时决定要不要加引号。
 *
 * 重点是**时间戳必须加引号**：不加的话严格 YAML 解析器会把它当成日期对象，
 * 于是同一份文件在不同工具里读出来一个是字符串一个是日期。
 * 我们只要字符串——可预测比"聪明"重要。
 */
function quote(text: string): string {
  if (text.length === 0) return '""'
  if (/^\s|\s$/.test(text)) return `"${text.replace(/"/g, '\\"')}"`
  // ISO 日期 / 时间戳
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return `"${text}"`
  if (/^["'[{#>|*&!%@`,]|[:#]\s|^-?\d+(\.\d+)?$/.test(text)) {
    return `"${text.replace(/"/g, '\\"')}"`
  }
  return text
}

export function parseFrontmatter(raw: string): ParsedNote {
  // 兼容 CRLF 与开头的 BOM——外部编辑器（尤其 Windows 上的）经常带这些
  const text = raw.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)

  if (lines.length === 0 || lines[0]?.trim() !== OPEN) {
    return { data: {}, content: text }
  }

  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === OPEN) {
      end = i
      break
    }
  }
  // 没有闭合的 --- ：不当成 frontmatter，原样返回，避免把正文吃掉
  if (end < 0) return { data: {}, content: text }

  const data: Frontmatter = {}
  let pendingKey: string | null = null

  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue

    const listItem = /^\s*-\s+(.*)$/.exec(line)
    if (listItem && pendingKey) {
      const current = data[pendingKey]
      const item = coerce(listItem[1] ?? '')
      if (Array.isArray(current)) current.push(String(item))
      else data[pendingKey] = [String(item)]
      continue
    }

    const pair = /^([^:\s][^:]*):\s?(.*)$/.exec(line)
    if (!pair) continue

    const key = (pair[1] ?? '').trim()
    const value = pair[2] ?? ''
    if (key.length === 0) continue

    if (value.trim().length === 0) {
      // 后面可能跟着一个缩进列表
      data[key] = []
      pendingKey = key
    } else {
      data[key] = coerce(value)
      pendingKey = null
    }
  }

  return { data, content: lines.slice(end + 1).join('\n').replace(/^\n+/, '') }
}

function serializeValue(value: FrontmatterValue): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return ['[]']
    return value.map((item) => `  - ${quote(String(item))}`)
  }
  if (typeof value === 'boolean') return [value ? 'true' : 'false']
  if (typeof value === 'number') return [String(value)]
  return [quote(value)]
}

export function stringifyFrontmatter(data: Frontmatter, content: string): string {
  const keys = Object.keys(data)
  // 空对象就不写 frontmatter，避免给纯正文的笔记平白加一个空块
  if (keys.length === 0) return content

  const lines: string[] = [OPEN]
  for (const key of keys) {
    const rendered = serializeValue(data[key] as FrontmatterValue)
    if (rendered.length === 1 && !Array.isArray(data[key])) {
      lines.push(`${key}: ${rendered[0]}`)
    } else {
      lines.push(`${key}:`)
      lines.push(...rendered)
    }
  }
  lines.push(OPEN, '')

  return `${lines.join('\n')}\n${content}`
}

/**
 * 把任意值收敛成能安全写进 frontmatter 的标量。
 * 外部传入的东西（比如标题）必须先过这里，别把换行塞进去。
 */
export function scalar(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}
