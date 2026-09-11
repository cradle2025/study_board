/**
 * 渲染层打点。
 *
 * 用 `performance.mark` 而不是自己攒时间戳，理由：
 *  - 它进的是浏览器自己的 timeline，将来接 DevTools 的 Performance 面板能直接看；
 *  - 开销极低，条目数量也有上限，不会成为长期的内存负担；
 *  - 只有基准脚本会去读，正常运行没有任何人消费这些数据。
 */

export function mark(name: string): void {
  try {
    performance.mark(name)
  } catch {
    /* 极老的 Chromium 上没有 performance.mark，忽略即可 */
  }
}

/**
 * 打点条数的上限。
 *
 * 正常情况下一次会话只有几十条（每次进出页面几条）。
 * 但万一有人把 mark 放进高频路径，这里兜一道，避免长会话里
 * performance 缓冲区无限增长——打点是诊断手段，不该反过来吃掉内存。
 */
const MAX_MARKS = 600
let markCount = 0

/** 与 mark 相同，但只在还有配额时记录；用于可能被高频调用的位置 */
export function markLimited(name: string): void {
  if (markCount >= MAX_MARKS) return
  markCount += 1
  mark(name)
}

export interface PerfMark {
  name: string
  ms: number
}

/** 读出所有 sb: 前缀的打点，时间基准是页面导航开始 */
export function collectMarks(prefix = 'sb:'): PerfMark[] {
  try {
    return performance
      .getEntriesByType('mark')
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => ({ name: entry.name, ms: Math.round(entry.startTime * 100) / 100 }))
  } catch {
    return []
  }
}
