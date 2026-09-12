import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  findAiProvider,
  isLoopbackBaseUrl
} from '@shared/aiProviders'
import type { AppSettings, ThemeMode, UiLanguage, NoteEditorMode } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { describePlatform } from '../lib/platform'

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
          <label for="set-ai-provider">服务商</label>
          <select id="set-ai-provider" class="sb-select"></select>
        </div>
        <div class="sb-field" style="max-width:420px">
          <label for="set-ai-base">接口地址（OpenAI 兼容）</label>
          <input id="set-ai-base" class="sb-input" type="text" placeholder="https://api.deepseek.com/v1" />
        </div>
        <div class="sb-field" style="max-width:420px">
          <label for="set-ai-model">模型</label>
          <input id="set-ai-model" class="sb-input" type="text" list="set-ai-models" placeholder="deepseek-chat" />
          <datalist id="set-ai-models"></datalist>
        </div>
        <div class="sb-field" style="max-width:420px" data-role="ai-key-field">
          <label for="set-ai-key">API Key</label>
          <div class="sb-inline">
            <input id="set-ai-key" class="sb-input" type="password" placeholder="留空表示不修改" autocomplete="off" />
            <button class="sb-btn" type="button" data-action="save-ai-key">保存</button>
            <button class="sb-btn" type="button" data-action="clear-ai-key">清除</button>
          </div>
        </div>
        <p class="sb-hint" data-role="ai-note"></p>
        <div class="sb-inline" style="margin-top:12px">
          <button class="sb-btn" type="button" data-action="test-ai">测试连接</button>
          <span class="sb-hint" data-role="ai-state"></span>
        </div>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">课程资料</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field">
          <label for="set-materials-inbox">资料收件箱</label>
          <div class="sb-inline">
            <input class="sb-input" id="set-materials-inbox" data-role="inbox" type="text"
                   style="flex:1 1 auto" placeholder="留空 = 下载目录/StudyBoard收件箱" />
            <button class="sb-btn" type="button" data-action="open-inbox">打开目录</button>
          </div>
          <p class="sb-hint">
            浏览器扩展会把学校网站下载的 PDF / PPT 改存到这里，看板发现新文件会弹一次归属选择。
            想用扩展，请在浏览器扩展管理页以开发者模式加载仓库的 extension/ 目录。
          </p>
        </div>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">关于</h2></div>
      <div class="sb-card" style="padding:16px">
        <dl class="sb-kv" data-role="about"></dl>
        <p class="sb-hint" data-role="about-note"></p>
      </div>
    </section>
  `

  const $ = <T extends HTMLElement>(id: string): T | null => element.querySelector<T>(id)

  const aiProvider = $<HTMLSelectElement>('#set-ai-provider')
  const aiKeyField = element.querySelector<HTMLElement>('[data-role="ai-key-field"]')
  const aiModelList = $<HTMLDataListElement>('#set-ai-models')
  const aiNote = element.querySelector<HTMLElement>('[data-role="ai-note"]')
  const aiStateEl = element.querySelector<HTMLElement>('[data-role="ai-state"]')

  /** 抽掉末尾斜杠再比：用户手抄地址时常常会多写一个 `/`，那不叫「换了服务商」 */
  function normalizeUrl(value: string): string {
    return value.trim().replace(/\/+$/, '').toLowerCase()
  }

  /**
   * 把服务商预设灌进下拉框。
   *
   * 最后一项「自定义」是留给不在清单里的服务商（自建网关、中转站、公司内网），
   * 也是唯一一个不会去动地址与模型两个输入框的选项。
   */
  function renderProviderOptions(): void {
    if (!aiProvider) return
    aiProvider.innerHTML = [
      ...AI_PROVIDERS.map((item) => `<option value="${escape(item.id)}">${escape(item.label)}</option>`),
      `<option value="${CUSTOM_PROVIDER_ID}">自定义（自己填地址与模型）</option>`
    ].join('')
  }

  /**
   * 服务商相关的联动：模型候选、密钥栏、以及下方那句提示。
   *
   * 这些都要跟着 `settings.ai.provider` 走，所以每次重绘表单都要重算一遍——
   * 只在下拉框 change 时算的话，切页面回来就会退化成上一次的样子。
   */
  function renderAiPanel(settings: AppSettings): void {
    const preset = findAiProvider(settings.ai.provider)
    // 要不要密钥，判据是**地址是不是本机**，不是预设 id：
    // 预设里的地址用户随时能改，跟着 id 走就会出现「界面说不用密钥、
    // 但地址其实在公网」的错配
    const local = isLoopbackBaseUrl(settings.ai.baseUrl)

    if (aiModelList) {
      // 候选值而不是白名单：各家的型号几个月换一批，写死只会让人以为自己填错了
      aiModelList.innerHTML = (preset?.models ?? [])
        .map((model) => `<option value="${escape(model)}"></option>`)
        .join('')
    }

    // 本机地址不校验密钥，那一栏就别摆出来占地方
    if (aiKeyField) aiKeyField.hidden = local

    if (aiNote) {
      const bits: string[] = []
      if (preset?.note) bits.push(escape(preset.note))
      if (preset?.keyUrl && !preset.keyOptional) {
        bits.push(
          `<button class="sb-btn sb-btn--ghost" type="button" data-action="open-key-url" data-url="${escape(preset.keyUrl)}">去哪里申请密钥</button>`
        )
      }
      aiNote.innerHTML = bits.join(' · ')
    }

    if (!aiStateEl) return
    if (settings.ai.hasApiKey) {
      aiStateEl.textContent = '已保存密钥（加密存放，界面不回读）'
    } else if (local) {
      aiStateEl.textContent = '本机地址不需要密钥'
    } else {
      aiStateEl.textContent = '尚未配置密钥，AI 功能不可用'
    }
  }

  function renderAbout(): void {
    const info = ctx.getInfo()
    const about = $('[data-role="about"]')
    if (!about || !info) return
    about.innerHTML = [
      ['版本', `v${info.version}`],
      ['Electron', info.electron],
      ['Chromium', info.chrome],
      ['Node', info.node],
      ['运行平台', describePlatform(info.platform, info.arch)],
      ['数据目录', info.paths.userData],
      ['笔记库', info.paths.notesLibrary],
      ['运行日志', info.paths.logs]
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(String(v))}</dd></div>`)
      .join('')

    // 把「适配哪些系统」写清楚。进程自己只能知道「我跑在什么上」，
    // 安装包提供哪些架构是打包时定的，所以这句是固定文案而不是读出来的
    const note = $('[data-role="about-note"]')
    if (note) {
      note.textContent =
        '安装包：Windows 只有 64 位（x64）版本；macOS 提供 Apple 芯片（arm64）与 Intel（x64）两个版本。'
    }
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

    if (theme) theme.value = settings.theme
    if (language) language.value = settings.language
    if (editor) editor.value = settings.editorMode
    if (library) library.value = settings.notesLibraryDir
    if (portable) portable.checked = settings.portableMode
    // 存的是预设 id；认不出来（自定义 / 旧版本留下的值）就落到「自定义」那一项，
    // 而不是硬塞成清单里的第一个——那会让界面显示的地址和实际存的不一致
    if (aiProvider) aiProvider.value = findAiProvider(settings.ai.provider)?.id ?? CUSTOM_PROVIDER_ID
    if (aiBase) aiBase.value = settings.ai.baseUrl
    if (aiModel) aiModel.value = settings.ai.model
    const inbox = $<HTMLInputElement>('[data-role="inbox"]')
    if (inbox) inbox.value = settings.materials.inboxDir
    renderAiPanel(settings)
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

  // 收件箱路径：失焦即存。留空表示用默认位置（下载目录/StudyBoard收件箱）
  $<HTMLInputElement>('[data-role="inbox"]')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLInputElement).value.trim()
    void patch({ materials: { inboxDir: value } })
  })

  element.querySelector('[data-action="open-inbox"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().materials.openInbox())
    } catch (error) {
      toast(`打不开目录：${formatError(error)}`, 'error')
    }
  })

  $<HTMLSelectElement>('#set-ai-provider')?.addEventListener('change', (event) => {
    const id = (event.target as HTMLSelectElement).value
    if (id === CUSTOM_PROVIDER_ID) {
      // 只换标签，地址与模型原样留着——用户手里填的那些值才是他要的
      void patch({ ai: { provider: CUSTOM_PROVIDER_ID } })
      return
    }
    const preset = findAiProvider(id)
    if (!preset) return
    // 选预设 = 接受它这一套默认值。地址和模型一起写下去，
    // 否则「切到 DeepSeek」但地址还指着上一家，报错会让人摸不着头脑
    void patch({ ai: { provider: preset.id, baseUrl: preset.baseUrl, model: preset.model } })
  })

  $<HTMLInputElement>('#set-ai-base')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLInputElement).value.trim()
    // 地址是判断「还在不在某家预设上」的依据：地址被改掉就转成自定义，
    // 免得顶上挂着别家的名字、底下的地址却指向另一个地方
    const matched = AI_PROVIDERS.find((item) => normalizeUrl(item.baseUrl) === normalizeUrl(value))
    void patch({
      ai: { baseUrl: value, provider: matched ? matched.id : CUSTOM_PROVIDER_ID }
    })
  })

  $<HTMLInputElement>('#set-ai-model')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLInputElement).value.trim()
    // 换型号不算换服务商：同一家提供好几个型号是常态，
    // 这一改要是也转成「自定义」，密钥是否必需之类的判断就跟着丢了
    void patch({ ai: { model: value } })
  })

  // 提示里那个「去哪里申请密钥」的按钮是每次重绘才生成的，
  // 绑不到具体元素上，所以走事件委托
  element.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-action="open-key-url"]'
    )
    const url = button?.dataset['url']
    if (!url) return
    void unwrap(bridge().app.openExternal(url)).catch((error) => {
      toast(`打开失败：${formatError(error)}`, 'error')
    })
  })

  element.querySelector('[data-action="test-ai"]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    if (aiStateEl) aiStateEl.textContent = '正在测试…'
    try {
      const result = await unwrap(bridge().ai.test())
      if (aiStateEl) aiStateEl.textContent = `连接正常 · 实际模型 ${result.model}`
      toast('连接正常', 'success')
    } catch (error) {
      if (aiStateEl) aiStateEl.textContent = ''
      toast(`测试失败：${formatError(error)}`, 'error')
    } finally {
      button.disabled = false
    }
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

  renderProviderOptions()
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
