import type { BrowserWindow } from 'electron'

/**
 * 冒烟测试的**生产替身**。
 *
 * 真正的 `smoke.ts` 有一千多行，里面是全部攻击探针与 payload——
 * 它对安全测试很有价值，对用户毫无用处，却在 asar 里躺着。
 * 之前只靠 `STUDY_BOARD_SMOKE=1` 门控，那是**运行期**的开关：
 * 代码本身已经进了包，谁把它解出来都能读到我们的测试用例长什么样。
 *
 * 所以改成**构建期**换掉：`electron.vite.config.ts` 在生产构建里把
 * `./smoke` 这个说明符指向本文件，打包产物里根本不存在探针代码。
 *
 * 本文件必须导出与 `smoke.ts` 同名、同签名的东西，且**行为为空**——
 * 它不是「关掉的测试」，而是「这里没有测试」。
 *
 * 有一件事必须如实说明：这一层替换**只对生产构建生效**。
 * `npm run smoke` 跑的是开发构建（`electron-vite dev` 的产物），
 * 走的仍然是真的 `smoke.ts`；这也正是「跑测试」与「打生产包」能共存的原理。
 */

/** 生产包里永远是 false —— 门控变量在这个版本里根本没被读过 */
export function smokeEnabled(): boolean {
  return false
}

/** 空实现：生产包里没有需要隔离的数据目录 */
export function prepareIsolatedDataDir(): void {
  /* 生产环境不隔离：用户就是要用自己的数据 */
}

/** 空实现：生产包里没有冒烟场景可跑 */
export function runSmokeTestIfRequested(_win: BrowserWindow): void {
  /* no-op */
}

/** 空实现：不需要准备测试数据 */
export async function prepareSmokeDataIfRequested(): Promise<void> {
  /* no-op */
}
