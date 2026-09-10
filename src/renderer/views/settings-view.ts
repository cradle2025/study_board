import type { ThemeMode, UiLanguage, NoteEditorMode } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'

/** 设置页：骨架阶段已经全部接通真实设置读写 */
export function createSettingsView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">设置</h1>
        <p class="sb-view__desc">所有配置都保存在本地 config.json，不联网同步。</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="reveal">打开数据目录</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">外观</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field" style="max-width:320px">
          <label for="set-theme">主题</label>
          <select id="set-theme" class="sb-select">
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
        <div class="sb-field" style="max-width:320px">
          <label for="set-language">界面语言</label>
          <select id="set-language" class="sb-select">
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </div>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">数据位置</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field">
          <label>笔记库目录</label>
          <div class="sb-inline">
            <input id="set-library" class="sb-input" type="text" readonly />
            <button class="sb-btn" type="button" data-action="choose-library">选择…</button>
            <button class="sb-btn" type="button" data-action="reset-library">恢复默认</button>
          </div>
        </div>
        <label class="sb-check">
          <input id="set-portable" type="checkbox" />
          <span>便携模式：把数据放在程序同级目录，方便随 U 盘携带（需重启生效）</span>
        </label>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">笔记</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field" style="max-width:320px">
          <label for="set-editor">默认编辑器</label>
          <select id="set-editor" class="sb-select">
            <option value="markdown">Markdown</option>
            <option value="richtext">富文本</option>
          </select>
        </div>
        <p class="sb-hint">笔记始终以 Markdown 文件保存；富文本模式是同一份内容的一种编辑视图。</p>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">AI 助手</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field" style="max-width:420px">
          <label for="set-ai-base">接口地址（OpenAI 兼容）</label>
          <input id="set-ai-base" class="sb-input" type="text" placeholder="https://api.openai.com/v1" />
        </div>
        <div class="sb-field" style="max-width:420px">
          <label for="set-ai-model">模型</label>
          <input id="set-ai-model" class="sb-input" type="text" placeholder="gpt-4o-mini" />
        </div>
        <div class="sb-field" style="max-width:420px">
          <label for="set-ai-key">API Key</label>
          <div class="sb-inline">
            <input id="set-ai-key" class="sb-input" type="password" placeholder="留空表示不修改" autocomplete="off" />
            <button class="sb-btn" type="button" data-action="save-ai-key">保存</button>
            <button class="sb-btn" type="button" data-action="clear-ai-key">清除</button>
          </div>
        </div>
        <p class="sb-hint" data-role="ai-state"></p>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">关于</h2></div>
      <div class="sb-card" style="padding:16px">
        <dl class="sb-kv" data-role="about"></dl>
      </div>
    </section>
  `

  const $ = <T extends HTMLElement>(id: string): T | null => element.querySelector<T>(id)

  function renderAbout(): void {
    const info = ctx.getInfo()
    const about = $('[data-role="about"]')
    if (!about || !info) return
    about.innerHTML = [
      ['版本', `v${info.version}`],
      ['Electron', info.electron],
      ['Chromium', info.chrome],
      ['Node', info.node],
      ['平台', `${info.platform} / ${info.arch}`],
      ['数据目录', info.paths.userData],
      ['笔记库', info.paths.notesLibrary],
      ['数据库', info.paths.database]
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(String(v))}</dd></div>`)
      .join('')
  }

  function renderForm(): void {
    const settings = ctx.getSettings()
    const theme = $<HTMLSelectElement>('#set-theme')
    const language = $<HTMLSelectElement>('#set-language')
    const editor = $<HTMLSelectElement>('#set-editor')
    const library = $<HTMLInputElement>('#set-library')
    const portable = $<HTMLInputElement>('#set-portable')
    const aiBase = $<HTMLInputElement>('#set-ai-base')
    const aiModel = $<HTMLInputElement>('#set-ai-model')
    const aiState = $('[data-role="ai-state"]')

    if (theme) theme.value = settings.theme
    if (language) language.value = settings.language
    if (editor) editor.value = settings.editorMode
    if (library) library.value = settings.notesLibraryDir
    if (portable) portable.checked = settings.portableMode
    if (aiBase) aiBase.value = settings.ai.baseUrl
    if (aiModel) aiModel.value = settings.ai.model
    if (aiState) {
      aiState.textContent = settings.ai.hasApiKey
        ? `已保存密钥（仅存于本机钥匙串，界面不回读）· 当前模型 ${settings.ai.model}`
        : '尚未配置密钥，AI 相关功能不可用。'
    }
    renderAbout()
  }

  async function patch(payload: Parameters<Window['studyBoard']['settings']['patch']>[0]): Promise<void> {
    try {
      await unwrap(bridge().settings.patch(payload))
      await ctx.reloadSettings()
      renderForm()
    } catch (error) {
      toast(`保存失败：${formatError(error)}`, 'error')
      renderForm()
    }
  }

  $<HTMLSelectElement>('#set-theme')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value as ThemeMode
    void patch({ theme: value })
  })

  $<HTMLSelectElement>('#set-language')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value as UiLanguage
    void patch({ language: value })
  })

  $<HTMLSelectElement>('#set-editor')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value as NoteEditorMode
    void patch({ editorMode: value })
  })

  $<HTMLInputElement>('#set-portable')?.addEventListener('change', async (event) => {
    const checked = (event.target as HTMLInputElement).checked
    await patch({ portableMode: checked })
    if (ctx.getInfo() && checked !== ctx.getSettings().portableMode) return
    toast('便携模式已修改，重启后生效', 'info')
  })

  $<HTMLInputElement>('#set-ai-base')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLInputElement).value.trim()
    void patch({ ai: { baseUrl: value } })
  })

  $<HTMLInputElement>('#set-ai-model')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLInputElement).value.trim()
    void patch({ ai: { model: value } })
  })

  element.querySelector('[data-action="choose-library"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().settings.chooseLibrary())
      await ctx.reloadSettings()
      renderForm()
      toast('笔记库目录已更新', 'success')
    } catch (error) {
      toast(`选择目录失败：${formatError(error)}`, 'error')
    }
  })

  element.querySelector('[data-action="reset-library"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().settings.resetLibrary())
      await ctx.reloadSettings()
      renderForm()
      toast('已恢复默认笔记库位置', 'success')
    } catch (error) {
      toast(`恢复失败：${formatError(error)}`, 'error')
    }
  })

  element.querySelector('[data-action="reveal"]')?.addEventListener('click', async () => {
    const info = ctx.getInfo()
    if (!info) return
    try {
      await unwrap(bridge().app.openPath(info.paths.userData))
    } catch (error) {
      toast(`打开失败：${formatError(error)}`, 'error')
    }
  })

  element.querySelector('[data-action="save-ai-key"]')?.addEventListener('click', async () => {
    const input = $<HTMLInputElement>('#set-ai-key')
    const value = input?.value.trim() ?? ''
    if (!value) {
      toast('请输入 API Key', 'error')
      return
    }
    try {
      await unwrap(bridge().secrets.setAiKey(value))
      if (input) input.value = ''
      await ctx.reloadSettings()
      renderForm()
      toast('密钥已保存到系统钥匙串', 'success')
    } catch (error) {
      toast(`保存失败：${formatError(error)}`, 'error')
    }
  })

  element.querySelector('[data-action="clear-ai-key"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().secrets.clearAiKey())
      await ctx.reloadSettings()
      renderForm()
      toast('密钥已清除', 'success')
    } catch (error) {
      toast(`清除失败：${formatError(error)}`, 'error')
    }
  })

  renderForm()

  return {
    element,
    onEnter: async () => {
      await ctx.reloadSettings()
      renderForm()
    }
  }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}
