/**
 * 启动阶段打点。
 *
 * 只在 STUDY_BOARD_BENCH=1 时收集数据。其它情况下每个 mark() 就是一次
 * 字符串比较后立即返回——不分配对象、不注册监听、不留任何全局引用，
 * 所以它既不会影响正常启动，也不会成为长期的内存负担。
 *
 * 时间基准取本模块求值的那一刻，近似等于「主进程 JS 开始执行」。
 */

const enabled = process.env['STUDY_BOARD_BENCH'] === '1'
const origin = process.hrtime.bigint()

export interface PhaseMark {
  name: string
  /** 相对主进程 JS 起点的毫秒数 */
  ms: number
}

const marks: PhaseMark[] = []

export function mark(name: string): void {
  if (!enabled) return
  marks.push({ name, ms: Number(process.hrtime.bigint() - origin) / 1e6 })
}

export function benchEnabled(): boolean {
  return enabled
}

/** 保留两位小数，避免报告里出现一串无意义的小数位 */
export function marksReport(): PhaseMark[] {
  return marks.map((item) => ({ name: item.name, ms: Math.round(item.ms * 100) / 100 }))
}
