/**
 * 把 `process.platform` / `process.arch` 翻译成人看得懂的说法。
 *
 * 为什么必须翻译：`win32` 是 Node 里的**历史名字**，在 64 位 Windows 上它照样返回
 * `'win32'`——它回答的是「哪个系统」，不是「多少位」。直接把它摆到界面上，
 * 用户合理地会读成「32 位的 Windows」，然后来问「这软件是 32 位的吗」。
 *
 * 位数在 `process.arch` 里（`x64` / `arm64` / `ia32`），两件事必须一起说才不歧义。
 */

import { t } from './i18n'

const OS_LABEL: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}

/**
 * 位数标签。**必须是 key 而不是文案** —— 它渲染在侧栏的版本号里，
 * 也就是每一页都能看到的那一行。
 *
 * ARM64 / ARM32 两种写法两种语言下都一样，所以不走词典，
 * 但为了「表里只有一处真相」还是留在同一张表里。
 */
const ARCH_LABEL: Record<string, string> = {
  x64: 'platform.arch.x64',
  ia32: 'platform.arch.ia32',
  arm64: 'ARM64',
  arm: 'ARM32'
}

/** 表里是 key，取值要过 t()；ARM64 / ARM32 过一遍也无害（词典里查不到就原样返回） */
function archText(arch: string): string {
  return t(ARCH_LABEL[arch] ?? arch)
}

/** 短标签：侧栏那种一行放不下几个字的地方用，如「Windows 64 位」 */
export function describeOs(platform: string): string {
  return OS_LABEL[platform] ?? platform
}

export function describeArch(arch: string): string {
  return archText(arch)
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
    if (arch === 'arm64') return t('platform.macArm', { arch })
    if (arch === 'x64') return t('platform.macIntel', { arch })
  }
  return t('platform.full', { os: describeOs(platform), bits: archText(arch), arch })
}
