/**
 * 基准对比工具：把新旧两份报告按同一套指标聚合，输出中位数与区间。
 *
 * 用法：node scripts/compare-bench.mjs <旧报告目录> <新报告目录>
 * 两份报告都是 scripts/smoke.mjs bench 产出的 JSON 数组（bench-N.json）。
 *
 * 为什么用中位数而不是平均值：这类测量的尾部噪声很大（GC、系统调度），
 * 平均值会被单次异常拖走，中位数才反映"平时是什么体验"。
 * 同时把 min~max 区间打出来——两组区间不重叠，结论才算立得住。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [, , beforeDir, afterDir] = process.argv
if (!beforeDir || !afterDir) {
  console.error('用法：node scripts/compare-bench.mjs <旧报告目录> <新报告目录>')
  process.exit(1)
}

function loadRuns(dir, prefix) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    console.error(`读不到报告目录：${dir}`)
    console.error('先各跑几次基准：npm run bench（报告默认落在 .preview/ 下）')
    console.error('对比自己的两次改动时，把旧报告改名成 before-N.json、新的叫 after-N.json 放在同一目录即可。')
    process.exit(1)
  }
  return names
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf-8')))
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const processOf = (report, type) =>
  (report.memory?.processes ?? []).find((item) => item.type === type) ?? {}

const METRICS = [
  ['保存单元格 p50 (ms)', (r) => r.renderer.save.p50Ms],
  ['保存单元格 平均 (ms)', (r) => r.renderer.save.avgMs],
  ['保存单元格 p95 (ms)', (r) => r.renderer.save.p95Ms],
  ['保存单元格 最慢 (ms)', (r) => r.renderer.save.maxMs],
  ['冷导航到就绪 (ms)', (r) => r.renderer.navToReadyMs],
  ['热导航到就绪 (ms)', (r) => r.renderer.warmNavMs],
  ['首屏 DOM 节点数', (r) => r.renderer.dom.idleNodes],
  ['压测后 DOM 节点数', (r) => r.renderer.dom.nodesAfterSaves],
  ['残留提示条', (r) => r.renderer.dom.toasts],
  ['渲染进程内存 (MB)', (r) => processOf(r, 'Tab').workingSetMB],
  ['整应用内存 (MB)', (r) => r.memory.totalWorkingSetMB],
  ['主进程 RSS (MB)', (r) => r.memory.mainProcess.rssMB],
  ['我方初始化耗时 (ms)', (r) => r.startup?.ourInitMs],
  ['窗口到首帧 (ms)', (r) => r.startup?.windowToFirstPaintMs]
]

const before = loadRuns(beforeDir, 'before')
const after = loadRuns(afterDir, 'after')

if (before.length === 0 || after.length === 0) {
  console.error(`没有找到报告：before=${before.length} 份，after=${after.length} 份`)
  process.exit(1)
}

const pad = (text, width) => String(text).padStart(width)
const padEnd = (text, width) => String(text).padEnd(width)

console.log(`样本：旧 ${before.length} 次 / 新 ${after.length} 次\n`)
console.log(
  padEnd('指标', 22) + pad('旧(中位)', 10) + pad('新(中位)', 10) + pad('变化', 10) + '  旧区间 / 新区间'
)
console.log('-'.repeat(96))

for (const [label, read] of METRICS) {
  const a = before.map(read).filter((v) => typeof v === 'number')
  const b = after.map(read).filter((v) => typeof v === 'number')
  if (a.length === 0 || b.length === 0) continue

  const ma = median(a)
  const mb = median(b)
  const delta = mb - ma
  const percent = ma === 0 ? 0 : (delta / ma) * 100
  const sign = delta >= 0 ? '+' : ''
  const range = (values) => `${Math.min(...values).toFixed(1)}~${Math.max(...values).toFixed(1)}`

  console.log(
    padEnd(label, 22) +
      pad(ma.toFixed(2), 10) +
      pad(mb.toFixed(2), 10) +
      pad(`${sign}${percent.toFixed(1)}%`, 10) +
      `  ${range(a)} / ${range(b)}`
  )
}

console.log('\n注：区间是指标在多次运行中的最小~最大值。两组区间不重叠时，差异才算稳定可信。')
