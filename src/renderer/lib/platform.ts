/**
 * 把 `process.platform` / `process.arch` 翻译成人看得懂的说法。
 *
 * 为什么必须翻译：`win32` 是 Node 里的**历史名字**，在 64 位 Windows 上它照样返回
 * `'win32'`——它回答的是「哪个系统」，不是「多少位」。直接把它摆到界面上，
 * 用户合理地会读成「32 位的 Windows」，然后来问「这软件是 32 位的吗」。
 *
 * 位数在 `process.arch` 里（`x64` / `arm64` / `ia32`），两件事必须一起说才不歧义。
 */

const OS_LABEL: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}

const ARCH_LABEL: Record<string, string> = {
  x64: '64 位',
  ia32: '32 位',
  arm64: 'ARM64',
  arm: 'ARM32'
}

/** 短标签：侧栏那种一行放不下几个字的地方用，如「Windows 64 位」 */
export function describeOs(platform: string): string {
  return OS_LABEL[platform] ?? platform
}

export function describeArch(arch: string): string {
  return ARCH_LABEL[arch] ?? arch
}

/**
 * 完整标签，如 `Windows · 64 位（x64）`。
 *
 * 括号里保留原始的 `arch` 记号是有意的：用户去搜索、提 issue、跟别人对配置时
 * 用得上，而「64 位」这种说法在排查时不够精确。
 */
export function describePlatform(platform: string, arch: string): string {
  // macOS 说「Apple 芯片 / Intel」比说「ARM64 / 64 位」更贴近用户自己的认知
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'macOS · Apple 芯片（arm64）'
    if (arch === 'x64') return 'macOS · Intel（x64）'
  }
  return `${describeOs(platform)} · ${describeArch(arch)}（${arch}）`
}
