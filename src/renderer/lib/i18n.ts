import { isLang, translate, translateMessage, type Lang, type TParams } from '@shared/i18n'

/**
 * 渲染层的翻译入口。
 *
 * 语言是**模块级状态**而不是逐层传参：界面文案散布在几十个视图与组件里，
 * 逐层传 `lang` 会污染几乎每个函数签名，而收益只是「同一时刻能存在两种
 * 语言的界面」——这个应用不需要那个能力。
 *
 * 代价是**切换语言必须重绘**。谁负责重绘写在各视图的说明里：外壳由
 * `AppShell` 重挂载当前路由（见 `#relocalize`），它会把整套 DOM 重建一遍，
 * 所以不需要每个视图各自订阅语言变化。
 *
 * 默认 `zh-CN`：`setLang` 之前就渲染出来的东西（比如启动瞬间的错误提示）
 * 应该是中文，而不是空字符串。
 */
let current: Lang = 'zh-CN'

export function setLang(lang: unknown): void {
  current = isLang(lang) ? lang : 'zh-CN'
}

export function getLang(): Lang {
  return current
}

/** 取一条界面文案 */
export function t(key: string, params?: TParams): string {
  return translate(current, key, params)
}

/** 把主进程抛过来的中文报错翻成当前语言（翻不到就原样返回） */
export function tm(message: string): string {
  return translateMessage(current, message)
}
