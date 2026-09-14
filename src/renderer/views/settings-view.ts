import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  findAiProvider,
  isLoopbackBaseUrl
} from '@shared/aiProviders'
import { LANG_LABEL, LANGS } from '@shared/i18n'
import type { AppSettings, ThemeMode, UiLanguage, NoteEditorMode, NotionConflict } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { escapeHtml } from '../lib/html'
import { t, tm } from '../lib/i18n'
import { bridge, formatError, toast, unwrap } from '../lib/ipc'
import { openModalCard, showInfo } from '../lib/overlay'
import { describePlatform } from '../lib/platform'

/* ------------------------------------------------------------ 冲突问询 */

interface ConflictPrompt {
  /** 第几条（从 1 开始），给用户「还剩多少」的实感 */
  index: number
  total: number
  /** 包括本条在内还剩几篇没定 */
  remaining: number
  localTitle: string
  remoteTitle: string
  remoteTime: string
  preview: string
}

interface ConflictAnswer {
  keepLocal: boolean
  /** true = 剩下的都用这个选择，不再逐条问 */
  batch: boolean
}

/**
 * 问一篇冲突「保留哪边」。
 *
 * 为什么不用现成的 `confirmAction`：它有且只有两个按钮，而这里需要第三、第四个
 * 出口（「剩下的都按本地 / 都按远端」）。硬塞进「取消」的位置会让语义拧掉——
 * 用户点「取消」时以为是「先跳过这篇」，实际却会连带跳过后面全部。
 *
 * 返回值三种：`{keepLocal, batch}` 表示选定；`null` 表示用户关掉了对话框
 * （不想继续了），与「选了远端」必须区分开。
 */
function askConflict(prompt: ConflictPrompt): Promise<ConflictAnswer | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: ConflictAnswer | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    // 关掉对话框（Esc、点遮罩、`close()`）= 「我不想继续处理了」。
    // 挂在这里而不是自己再监听一遍键盘：`openModalCard` 有三条关闭路径，
    // 自己再加两条迟早会漏掉第四条，Promise 就那么永远悬着了——
    // 表现是设置页里「冲突处理完」的提示再也不会出现
    const modal = openModalCard({
      className: 'sb-modal__card--conflict',
      onClose: () => finish(null)
    })
    const many = prompt.remaining > 1

    modal.card.innerHTML = `
      <div class="sb-modal__title">
        ${escapeHtml(t('settings.conflict.title'))}
        <span class="sb-conflict__step">${prompt.index} / ${prompt.total}</span>
      </div>
      <p class="sb-modal__message">
        ${escapeHtml(t('settings.conflict.local', { title: prompt.localTitle }))}<br />
        ${escapeHtml(t('settings.conflict.remote', { title: prompt.remoteTitle, time: prompt.remoteTime }))}
      </p>
      <details class="sb-conflict__preview">
        <summary>${escapeHtml(t('settings.conflict.peek'))}</summary>
        <pre class="sb-conflict__pre">${escapeHtml(prompt.preview)}</pre>
      </details>
      <p class="sb-hint">
        ${escapeHtml(t('settings.conflict.explain'))}
      </p>
      <div class="sb-modal__actions sb-modal__actions--stack">
        <button class="sb-btn sb-btn--danger" type="button" data-role="local">
          ${escapeHtml(t('settings.conflict.keepLocal'))}
        </button>
        <button class="sb-btn sb-btn--primary" type="button" data-role="remote">
          ${escapeHtml(t('settings.conflict.keepRemote'))}
        </button>
      </div>
      ${
        many
          ? `<div class="sb-modal__batch">
               <span class="sb-hint">${escapeHtml(t('settings.conflict.remaining', { count: prompt.remaining }))}</span>
               <button class="sb-btn sb-btn--sm" type="button" data-role="all-local">
                 ${escapeHtml(t('settings.conflict.allLocal'))}
               </button>
               <button class="sb-btn sb-btn--sm" type="button" data-role="all-remote">
                 ${escapeHtml(t('settings.conflict.allRemote'))}
               </button>
             </div>`
          : ''
      }
    `

    const on = (role: string, keepLocal: boolean, batch: boolean): void => {
      modal.card
        .querySelector<HTMLButtonElement>(`[data-role="${role}"]`)
        ?.addEventListener('click', () => {
          // 先记下答案再关：`close()` 会同步触发 onClose → finish(null)，
          // 顺序反了的话用户点的选择会被当成「关掉了」
          settled = true
          resolve({ keepLocal, batch })
          modal.close()
        })
    }

    on('local', true, false)
    on('remote', false, false)
    on('all-local', true, true)
    on('all-remote', false, true)

    modal.card.querySelector<HTMLButtonElement>('[data-role="local"]')?.focus()
  })
}

/** 设置页：骨架阶段已经全部接通真实设置读写 */
export function createSettingsView(ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">${escapeHtml(t('settings.title'))}</h1>
        <p class="sb-view__desc">${escapeHtml(t('settings.desc'))}</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="reveal">${escapeHtml(t('settings.openDataDir'))}</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">${escapeHtml(t('settings.appearance'))}</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field" style="max-width:320px">
          <label for="set-theme">${escapeHtml(t('settings.theme'))}</label>
          <select id="set-theme" class="sb-select">
            <option value="system">${escapeHtml(t('settings.theme.system'))}</option>
            <option value="light">${escapeHtml(t('settings.theme.light'))}</option>
            <option value="dark">${escapeHtml(t('settings.theme.dark'))}</option>
          </select>
        </div>
        <div class="sb-field" style="max-width:320px">
          <label for="set-language">${escapeHtml(t('settings.language'))}</label>
          <select id="set-language" class="sb-select">
            ${LANGS.map((code) => `<option value="${code}">${escapeHtml(LANG_LABEL[code])}</option>`).join('')}
          </select>
        </div>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">${escapeHtml(t('settings.dataSection'))}</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field">
          <label>${escapeHtml(t('settings.notesLibrary'))}</label>
          <div class="sb-inline">
            <input id="set-library" class="sb-input" type="text" readonly />
            <button class="sb-btn" type="button" data-action="choose-library">${escapeHtml(t('common.choose'))}</button>
            <button class="sb-btn" type="button" data-action="reset-library">${escapeHtml(t('common.restoreDefault'))}</button>
          </div>
        </div>
        <label class="sb-check">
          <input id="set-portable" type="checkbox" />
          <span>${escapeHtml(t('settings.portable'))}</span>
        </label>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">${escapeHtml(t('settings.notesSection'))}</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field" style="max-width:320px">
          <label for="set-editor">${escapeHtml(t('settings.editor'))}</label>
          <select id="set-editor" class="sb-select">
            <option value="markdown">Markdown</option>
            <option value="richtext">${escapeHtml(t('settings.editor.richtext'))}</option>
          </select>
        </div>
        <p class="sb-hint">${escapeHtml(t('settings.editorHint'))}</p>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">${escapeHtml(t('settings.ai'))}</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field" style="max-width:420px">
          <label for="set-ai-provider">${escapeHtml(t('settings.aiProvider'))}</label>
          <select id="set-ai-provider" class="sb-select"></select>
        </div>
        <div class="sb-field" style="max-width:420px">
          <label for="set-ai-base">${escapeHtml(t('settings.aiBase'))}</label>
          <input id="set-ai-base" class="sb-input" type="text" placeholder="https://api.deepseek.com/v1" />
        </div>
        <div class="sb-field" style="max-width:420px">
          <label for="set-ai-model">${escapeHtml(t('settings.aiModel'))}</label>
          <input id="set-ai-model" class="sb-input" type="text" list="set-ai-models" placeholder="deepseek-chat" />
          <datalist id="set-ai-models"></datalist>
        </div>
        <div class="sb-field" style="max-width:420px" data-role="ai-key-field">
          <label for="set-ai-key">API Key</label>
          <div class="sb-inline">
            <input id="set-ai-key" class="sb-input" type="password" placeholder="${escapeHtml(t('settings.secretPlaceholder'))}" autocomplete="off" />
            <button class="sb-btn" type="button" data-action="save-ai-key">${escapeHtml(t('common.save'))}</button>
            <button class="sb-btn" type="button" data-action="clear-ai-key">${escapeHtml(t('common.clear'))}</button>
          </div>
        </div>
        <p class="sb-hint" data-role="ai-note"></p>
        <div class="sb-inline" style="margin-top:12px">
          <button class="sb-btn" type="button" data-action="test-ai">${escapeHtml(t('settings.testConnection'))}</button>
          <span class="sb-hint" data-role="ai-state"></span>
        </div>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">${escapeHtml(t('settings.notion'))}</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field" style="max-width:420px">
          <label for="set-notion-kind">${escapeHtml(t('settings.notionKind'))}</label>
          <select id="set-notion-kind" class="sb-select">
            <option value="database">${escapeHtml(t('settings.notionKind.database'))}</option>
            <option value="page">${escapeHtml(t('settings.notionKind.page'))}</option>
          </select>
        </div>
        <div class="sb-field">
          <label for="set-notion-target">${escapeHtml(t('settings.notionTarget'))}</label>
          <input id="set-notion-target" class="sb-input" type="text"
                 placeholder="${escapeHtml(t('settings.notionTargetPlaceholder'))}" />
        </div>
        <div class="sb-field" data-role="notion-key-field">
          <label for="set-notion-token">${escapeHtml(t('settings.notionToken'))}</label>
          <div class="sb-inline">
            <input id="set-notion-token" class="sb-input" type="password"
                   placeholder="${escapeHtml(t('settings.secretPlaceholder'))}" autocomplete="off" />
            <button class="sb-btn" type="button" data-action="save-notion-token">${escapeHtml(t('common.save'))}</button>
            <button class="sb-btn" type="button" data-action="clear-notion-token">${escapeHtml(t('common.clear'))}</button>
          </div>
        </div>
        <div class="sb-inline" style="margin-top:12px">
          <button class="sb-btn" type="button" data-action="test-notion">${escapeHtml(t('settings.testConnection'))}</button>
          <span class="sb-hint" data-role="notion-state"></span>
        </div>
        <p class="sb-hint">
          ${escapeHtml(t('settings.notionHint'))}
        </p>
        <div class="sb-inline" style="margin-top:12px">
          <button class="sb-btn" type="button" data-action="pull-notion">${escapeHtml(t('settings.notionPull'))}</button>
        </div>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">${escapeHtml(t('settings.materials'))}</h2></div>
      <div class="sb-card" style="padding:16px">
        <div class="sb-field">
          <label for="set-materials-inbox">${escapeHtml(t('settings.inbox'))}</label>
          <div class="sb-inline">
            <input class="sb-input" id="set-materials-inbox" data-role="inbox" type="text"
                   style="flex:1 1 auto" placeholder="${escapeHtml(t('settings.inboxPlaceholder'))}" />
            <button class="sb-btn" type="button" data-action="open-inbox">${escapeHtml(t('settings.openDir'))}</button>
          </div>
          <p class="sb-hint">
            ${escapeHtml(t('settings.inboxHint'))}
          </p>
        </div>
      </div>
    </section>

    <section class="sb-section">
      <div class="sb-section__head"><h2 class="sb-section__title">${escapeHtml(t('settings.about'))}</h2></div>
      <div class="sb-card" style="padding:16px">
        <p class="sb-banner sb-banner--warn" data-role="data-warning" hidden></p>
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
  const notionStateEl = element.querySelector<HTMLElement>('[data-role="notion-state"]')

  /**
   * Notion 那一栏的状态行。
   *
   * 三件事都要说清楚：有没有 Token、有没有目标、上次什么时候同步过。
   * 缺一个都会让用户点了按钮之后收到一句「还没配置」，却不知道缺的是哪个。
   */
  function renderNotionPanel(settings: AppSettings): void {
    if (!notionStateEl) return
    const bits: string[] = []
    bits.push(t(settings.notion.hasToken ? 'settings.notionStatus.tokenSaved' : 'settings.notionStatus.tokenMissing'))
    bits.push(t(settings.notion.targetId ? 'settings.notionStatus.targetSet' : 'settings.notionStatus.targetMissing'))

    if (settings.notion.lastSyncAt) {
      const when = new Date(settings.notion.lastSyncAt)
      bits.push(t('settings.notionStatus.lastSync', { time: Number.isNaN(when.getTime()) ? (settings.notion.lastSyncAt ?? '') : when.toLocaleString() }))
    }
    notionStateEl.textContent = bits.join(' · ')
  }

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
      `<option value="${CUSTOM_PROVIDER_ID}">${escapeHtml(t('settings.customProvider'))}</option>`
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
          `<button class="sb-btn sb-btn--ghost" type="button" data-action="open-key-url" data-url="${escape(preset.keyUrl)}">${escapeHtml(t('settings.getKey'))}</button>`
        )
      }
      aiNote.innerHTML = bits.join(' · ')
    }

    if (!aiStateEl) return
    if (settings.ai.hasApiKey) {
      aiStateEl.textContent = t('settings.aiState.saved')
    } else if (local) {
      aiStateEl.textContent = t('settings.aiState.local')
    } else {
      aiStateEl.textContent = t('settings.aiState.missing')
    }
  }

  function renderAbout(): void {
    const info = ctx.getInfo()
    const about = $('[data-role="about"]')
    if (!about || !info) return
    about.innerHTML = [
      [t('settings.about.version'), `v${info.version}`],
      [t('settings.about.electron'), info.electron],
      [t('settings.about.chromium'), info.chrome],
      [t('settings.about.node'), info.node],
      [t('settings.about.runtime'), describePlatform(info.platform, info.arch)],
      // 数据格式版本与「这份数据是哪个版本写的」一起显示：
      // 出问题时这两个数字是判断「要不要先备份再降级」的唯一依据
      [
        t('settings.about.dataSchema'),
        info.dataWrittenBy
          ? t('settings.about.dataSchemaWrittenBy', { version: info.dataSchema, app: info.dataWrittenBy })
          : `v${info.dataSchema}`
      ],
      [t('settings.about.dataDir'), info.paths.userData],
      [t('settings.about.notesLibrary'), info.paths.notesLibrary],
      [t('settings.about.logs'), info.paths.logs]
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${escape(String(v))}</dd></div>`)
      .join('')

    /**
     * 数据版本不匹配的提示。**放在最显眼的位置**，而不是只写进日志。
     *
     * 降级这件事必须让用户看到：它接下来每次自动保存都可能抹掉新版写入
     * 的内容，而界面上完全看不出来。程序已经自动备份过一份，
     * 但用户得知道「现在不该继续用」。
     */
    const banner = $('[data-role="data-warning"]')
    if (banner) {
      if (info.dataWarning) {
        banner.textContent = info.dataWarning
        banner.hidden = false
      } else {
        banner.hidden = true
      }
    }

    // 把「适配哪些系统」写清楚。进程自己只能知道「我跑在什么上」，
    // 安装包提供哪些架构是打包时定的，所以这句是固定文案而不是读出来的
    const note = $('[data-role="about-note"]')
    if (note) {
      note.textContent = t('settings.about.packages')
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
    const notionKind = $<HTMLSelectElement>('#set-notion-kind')
    const notionTarget = $<HTMLInputElement>('#set-notion-target')
    if (notionKind) notionKind.value = settings.notion.targetKind
    if (notionTarget) notionTarget.value = settings.notion.targetId
    renderAiPanel(settings)
    renderNotionPanel(settings)
    renderAbout()
  }

  async function patch(payload: Parameters<Window['studyBoard']['settings']['patch']>[0]): Promise<void> {
    try {
      await unwrap(bridge().settings.patch(payload))
      await ctx.reloadSettings()
      renderForm()
    } catch (error) {
      toast(t('settings.saveFailed', { reason: tm(formatError(error)) }), 'error')
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
    const input = event.target as HTMLInputElement
    const checked = input.checked
    try {
      const result = await unwrap(bridge().settings.setPortable(checked))
      if (!result.changed) {
        toast(t('settings.portable.alreadyThere'), 'info')
        return
      }
      /**
       * 成功了要把**两个**路径都告诉用户。
       *
       * 旧目录刻意保留着当兜底，不说清楚的话用户会以为数据被复制了一份
       * 而不敢删；说清楚了他才知道「确认没问题之后可以自己清掉」。
       */
      await showInfo({
        title: t('settings.portable.switched'),
        message: t('settings.portable.message', { target: result.target, previous: result.previous })
      })
    } catch (error) {
      // 失败必须把勾**退回去**：留着一个勾选状态会让人以为已经切过去了
      input.checked = ctx.getSettings().portableMode
      toast(t('settings.portable.failed', { reason: tm(formatError(error)) }), 'error')
    }
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
      toast(t('settings.openDirFailed', { reason: tm(formatError(error)) }), 'error')
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
      toast(t('settings.openFailed', { reason: tm(formatError(error)) }), 'error')
    })
  })

  element.querySelector('[data-action="test-ai"]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    if (aiStateEl) aiStateEl.textContent = t('settings.testing')
    try {
      const result = await unwrap(bridge().ai.test())
      if (aiStateEl) aiStateEl.textContent = t('settings.aiState.connected', { model: result.model })
      toast(t('settings.connected'), 'success')
    } catch (error) {
      if (aiStateEl) aiStateEl.textContent = ''
      toast(t('settings.testFailed', { reason: tm(formatError(error)) }), 'error')
    } finally {
      button.disabled = false
    }
  })

  $<HTMLSelectElement>('#set-notion-kind')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value === 'page' ? 'page' : 'database'
    void patch({ notion: { targetKind: value } })
  })

  // 目标 id：失焦即存。这里**不做格式校验**——用户可能粘的是带参数的完整链接，
  // 解析成 id 是主进程的事。在这拦一道只会让人以为「链接不对」，
  // 而实际上只是我们截得太急
  $<HTMLInputElement>('#set-notion-target')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLInputElement).value.trim()
    void patch({ notion: { targetId: value } })
  })

  element.querySelector('[data-action="save-notion-token"]')?.addEventListener('click', async () => {
    const input = $<HTMLInputElement>('#set-notion-token')
    const value = input?.value.trim() ?? ''
    if (!value) {
      toast(t('settings.needNotionToken'), 'error')
      return
    }
    try {
      await unwrap(bridge().secrets.setNotionToken(value))
      if (input) input.value = ''
      await ctx.reloadSettings()
      renderForm()
      toast(t('settings.tokenSaved'), 'success')
    } catch (error) {
      toast(t('settings.saveFailed', { reason: tm(formatError(error)) }), 'error')
    }
  })

  element.querySelector('[data-action="clear-notion-token"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().secrets.clearNotionToken())
      await ctx.reloadSettings()
      renderForm()
      toast(t('settings.tokenCleared'), 'success')
    } catch (error) {
      toast(t('settings.clearFailed', { reason: tm(formatError(error)) }), 'error')
    }
  })

  element.querySelector('[data-action="test-notion"]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    if (notionStateEl) notionStateEl.textContent = t('settings.testing')
    try {
      const result = await unwrap(bridge().notion.test())
      // 把目标名字带出来：连上了但连的是别的库，是最容易「看着没报错」的错误
      if (notionStateEl) notionStateEl.textContent = t('settings.notionState.connected', { name: result.name })
      toast(t('settings.connected'), 'success')
    } catch (error) {
      if (notionStateEl) notionStateEl.textContent = ''
      toast(t('settings.testFailed', { reason: tm(formatError(error)) }), 'error')
    } finally {
      button.disabled = false
    }
  })

  element.querySelector('[data-action="pull-notion"]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    if (notionStateEl) notionStateEl.textContent = t('settings.pulling')
    try {
      const result = await unwrap(bridge().notion.pull())
      await ctx.reloadSettings()
      renderForm()
      if (result.conflicts.length > 0) {
        // 有冲突：交给用户逐条决定。这里不替他选，
        // 所以只把数量说清楚，具体的问询由下面的流程走
        toast(t('settings.pulledWithConflicts', { pulled: result.pulled, conflicts: result.conflicts.length }), 'info')
        await resolveConflicts(result.conflicts)
      } else if (result.deferred > 0) {
        toast(t('settings.pulledDeferred', { pulled: result.pulled, deferred: result.deferred }), 'info')
      } else {
        toast(t('settings.pulled', { pulled: result.pulled }), 'success')
      }
    } catch (error) {
      if (notionStateEl) notionStateEl.textContent = ''
      toast(t('settings.pullFailed', { reason: tm(formatError(error)) }), 'error')
      renderForm()
    } finally {
      button.disabled = false
    }
  })

  /**
   * 逐条问用户「这一篇保留哪边」。
   *
   * 一条一条来而不是一次列一张表：每条都要看到两边的正文才能决定，
   * 并排摆 20 条只会逼着人选个大概。宁可慢一点。
   *
   * 但「宁可慢」不等于「必须点满 20 次」——冲突上限是 20，真撞满时要重复
   * 20 遍同样的判断，第 15 遍开始人就不看了，那反而更容易点错。
   * 所以从第二条起多给一组「剩下的都按本地 / 都按远端」的出口：
   * 仍然是用户做的决定，只是不必把同一个决定做 20 遍。
   * **默认仍然是逐条问**——批量是用户主动选的，不是我们替他选的。
   */
  async function resolveConflicts(conflicts: NotionConflict[]): Promise<void> {
    let settled = 0
    let failed = 0

    for (let index = 0; index < conflicts.length; index += 1) {
      const conflict = conflicts[index]
      if (!conflict) continue

      const remaining = conflicts.length - index
      const remote = await unwrap(bridge().notion.preview(conflict.noteId)).catch(() => null)
      const preview = remote ? remote.content.slice(0, 800) : t('settings.conflict.noRemote')
      const remoteTime = conflict.remoteEditedAt
        ? new Date(conflict.remoteEditedAt).toLocaleString()
        : t('settings.conflict.unknown')

      const answer = await askConflict({
        index: index + 1,
        total: conflicts.length,
        remaining,
        localTitle: conflict.noteTitle,
        remoteTitle: conflict.remoteTitle,
        remoteTime,
        preview
      })

      // 用户按 Esc / 点遮罩关掉对话框：不是「跳过这一条」，而是「我不想处理了」。
      // 直接停下，别把剩下的当成默认值处理掉——那是最不该替他做的决定
      if (answer === null) break

      // 「剩下的都按 X」：本条按 X 处理，后面所有条目一并按 X 处理
      const batch = answer.batch
      const targets = batch ? conflicts.slice(index) : [conflict]

      for (const target of targets) {
        try {
          await unwrap(
            bridge().notion.resolve({
              noteId: target.noteId,
              choice: answer.keepLocal ? 'local' : 'remote'
            })
          )
          settled += 1
        } catch (error) {
          failed += 1
          toast(t('settings.conflict.failed', { title: target.noteTitle, reason: tm(formatError(error)) }), 'error')
        }
      }

      if (batch) {
        const label = t(answer.keepLocal ? 'settings.conflict.localShort' : 'settings.conflict.remoteShort')
        toast(t('settings.conflict.bulkDone', { count: remaining, side: label }), 'info')
        break
      }
    }

    await ctx.reloadSettings()
    renderForm()

    if (settled === 0) return
    const tail = failed > 0 ? t('settings.conflict.failedTail', { count: failed }) : ''
    toast(t('settings.conflict.settled', { count: settled, tail }), failed > 0 ? 'info' : 'success')
  }

  element.querySelector('[data-action="choose-library"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().settings.chooseLibrary())
      await ctx.reloadSettings()
      renderForm()
      toast(t('settings.libraryUpdated'), 'success')
    } catch (error) {
      toast(t('settings.chooseDirFailed', { reason: tm(formatError(error)) }), 'error')
    }
  })

  element.querySelector('[data-action="reset-library"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().settings.resetLibrary())
      await ctx.reloadSettings()
      renderForm()
      toast(t('settings.libraryReset'), 'success')
    } catch (error) {
      toast(t('settings.resetFailed', { reason: tm(formatError(error)) }), 'error')
    }
  })

  element.querySelector('[data-action="reveal"]')?.addEventListener('click', async () => {
    const info = ctx.getInfo()
    if (!info) return
    try {
      await unwrap(bridge().app.openPath(info.paths.userData))
    } catch (error) {
      toast(t('settings.openFailed', { reason: tm(formatError(error)) }), 'error')
    }
  })

  element.querySelector('[data-action="save-ai-key"]')?.addEventListener('click', async () => {
    const input = $<HTMLInputElement>('#set-ai-key')
    const value = input?.value.trim() ?? ''
    if (!value) {
      toast(t('settings.needApiKey'), 'error')
      return
    }
    try {
      await unwrap(bridge().secrets.setAiKey(value))
      if (input) input.value = ''
      await ctx.reloadSettings()
      renderForm()
      toast(t('settings.apiKeySaved'), 'success')
    } catch (error) {
      toast(t('settings.saveFailed', { reason: tm(formatError(error)) }), 'error')
    }
  })

  element.querySelector('[data-action="clear-ai-key"]')?.addEventListener('click', async () => {
    try {
      await unwrap(bridge().secrets.clearAiKey())
      await ctx.reloadSettings()
      renderForm()
      toast(t('settings.apiKeyCleared'), 'success')
    } catch (error) {
      toast(t('settings.clearFailed', { reason: tm(formatError(error)) }), 'error')
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
