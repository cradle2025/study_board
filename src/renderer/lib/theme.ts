import type { ThemeMode } from '@shared/types'

const media = window.matchMedia('(prefers-color-scheme: dark)')

/** 把偏好落到 <html data-theme>，CSS 里按这个属性切换令牌 */
export function applyTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode
  document.documentElement.setAttribute('data-theme', resolved)
}

/** 订阅系统主题变化；返回取消订阅函数 */
export function watchSystemTheme(onChange: () => void): () => void {
  const handler = (): void => onChange()
  media.addEventListener('change', handler)
  return () => media.removeEventListener('change', handler)
}
