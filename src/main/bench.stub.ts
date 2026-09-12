import type { BrowserWindow } from 'electron'

/**
 * 性能基准的**生产替身**。理由与 `smoke.stub.ts` 完全一致：
 * 基准脚本不属于产品，不该出现在用户下载的安装包里。
 *
 * 详见 `smoke.stub.ts` 顶部的说明。
 */

/** 生产包里永远是 false */
export function benchEnabled(): boolean {
  return false
}

/** 空实现：不需要准备基准数据 */
export async function prepareBenchDataIfRequested(): Promise<void> {
  /* no-op */
}

/** 空实现：生产包里没有基准可跑 */
export function runBenchIfRequested(_win: BrowserWindow): void {
  /* no-op */
}
