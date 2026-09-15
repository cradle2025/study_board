import { normalizeSiteName, normalizeSiteUrl } from '@shared/portal'
import { escapeHtml } from '../lib/html'
import type { PortalSite } from '@shared/types'

import type { ViewContext, ViewInstance } from '../app-shell'
import { createPortalController } from '../components/portal-controller'
import { t } from '../lib/i18n'
import { toast } from '../lib/ipc'
import { confirmAction, openModalCard } from '../lib/overlay'

/**
 * 网站门户管理页。
 *
 * 需求原文：「有一个集成界面便于快捷访问各个学习网站（默认的有慕课、B站、知网），
 * 可以选择添加网站」——输入网址、给它起名、生成快捷方式和图标、点一下就打开。
 *
 * 一个重要取舍：**图标不自动抓**。本应用的默认状态是离线的，
 * 加站点只是往 portal.json 里写一行，不发任何网络请求；
 * 想要图标就点「补齐图标」，那是用户自己的一次明确点击。
 */

interface FormResult {
  name: string
  url: string
  fetchIcon: boolean
}

const FORM_HTML = `
  <div class="sb-modal__title" data-role="title"></div>
  <div class="sb-field">
    <label for="site-name">${escapeHtml(t('portal.name'))}</label>
    <input class="sb-input" id="site-name" data-field="name" type="text" maxlength="40" placeholder="${escapeHtml(t('portal.namePlaceholder'))}" />
  </div>
  <div class="sb-field">
    <label for="site-url">${escapeHtml(t('portal.url'))}</label>
    <input class="sb-input" id="site-url" data-field="url" type="text" placeholder="${escapeHtml(t('portal.urlPlaceholder'))}" />
  </div>
  <label class="sb-portal__check">
    <input type="checkbox" data-field="fetchIcon" />
    <span>${escapeHtml(t('portal.fetchIconNote'))}</span>
  </label>
  <p class="sb-hint" data-role="error" hidden></p>
  <div class="sb-modal__actions">
    <button class="sb-btn" type="button" data-role="cancel">${escapeHtml(t('common.cancel'))}</button>
    <button class="sb-btn sb-btn--primary" type="button" data-role="save">${escapeHtml(t('common.save'))}</button>
  </div>
`

/** 弹出新增 / 编辑表单；用户取消时返回 null */
function openSiteForm(existing: PortalSite | null): Promise<FormResult | null> {
  return new Promise((resolve) => {
    const modal = openModalCard({ className: 'sb-modal__card--form' })
    modal.card.innerHTML = FORM_HTML

    const title = modal.card.querySelector<HTMLElement>('[data-role="title"]')
    const nameInput = modal.card.querySelector<HTMLInputElement>('[data-field="name"]')
    const urlInput = modal.card.querySelector<HTMLInputElement>('[data-field="url"]')
    const iconCheck = modal.card.querySelector<HTMLInputElement>('[data-field="fetchIcon"]')
    const errorEl = modal.card.querySelector<HTMLElement>('[data-role="error"]')
    const cancelBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="cancel"]')
    const saveBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="save"]')

    const isEdit = existing !== null
    if (title) title.textContent = t(isEdit ? 'portal.editSite' : 'portal.addSite')
    if (nameInput && existing) nameInput.value = existing.name
    if (urlInput && existing) urlInput.value = existing.url
    if (saveBtn) saveBtn.textContent = t(isEdit ? 'common.save' : 'common.add')
    // 编辑已有站点时默认不勾：用户只是改个名字的话，不该顺带发一次网络请求
    if (iconCheck) iconCheck.checked = !isEdit

    let settled = false
    const done = (value: FormResult | null): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeyDown, true)
      modal.close()
      resolve(value)
    }

    function showError(message: string): void {
      if (!errorEl) return
      errorEl.textContent = message
      errorEl.hidden = false
    }

    function submit(): void {
      const name = normalizeSiteName(nameInput?.value)
      if (name.length === 0) {
        showError(t('portal.nameRequired'))
        nameInput?.focus()
        return
      }
      const checked = normalizeSiteUrl(urlInput?.value)
      if (!checked.ok) {
        showError(checked.error)
        urlInput?.focus()
        return
      }
      done({ name, url: checked.url, fetchIcon: iconCheck?.checked === true })
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Enter') return
      // 回车提交；但用户在复选框上按回车时让它保持默认行为
      if (document.activeElement === iconCheck) return
      event.preventDefault()
      submit()
    }

    cancelBtn?.addEventListener('click', () => done(null))
    saveBtn?.addEventListener('click', submit)
    document.addEventListener('keydown', onKeyDown, true)

    nameInput?.focus()
    if (nameInput && existing) nameInput.select()
  })
}

export function createPortalView(_ctx: ViewContext): ViewInstance {
  const element = document.createElement('div')
  element.className = 'sb-view'
  element.innerHTML = `
    <div class="sb-view__head">
      <div>
        <h1 class="sb-view__title">${escapeHtml(t('nav.portal'))}</h1>
        <p class="sb-view__desc">${escapeHtml(t('portal.desc'))}</p>
      </div>
      <div class="sb-toolbar">
        <button class="sb-btn" type="button" data-action="fetch-all">${escapeHtml(t('portal.fetchAll'))}</button>
        <button class="sb-btn sb-btn--primary" type="button" data-action="add">${escapeHtml(t('portal.addSite'))}</button>
      </div>
    </div>

    <section class="sb-section">
      <div class="sb-section__head">
        <h2 class="sb-section__title">${escapeHtml(t('portal.all'))}</h2>
        <span class="sb-badge" data-role="meta">${escapeHtml(t('nav.group.module2'))}</span>
      </div>
      <div data-role="grid"></div>
      <p class="sb-hint">
        ${escapeHtml(t('portal.hint'))}
      </p>
    </section>
  `

  const slot = element.querySelector<HTMLElement>('[data-role="grid"]')
  const meta = element.querySelector<HTMLElement>('[data-role="meta"]')

  const controller = createPortalController({
    editable: true,
    onData(list) {
      if (!meta) return
      const hidden = list.filter((site) => site.hidden).length
      meta.textContent = hidden > 0 ? t('portal.countHidden', { total: list.length, hidden }) : t('portal.count', { total: list.length })
    },
    onEdit(site) {
      void openSiteForm(site).then(async (result) => {
        if (!result) return
        try {
          await controller.upsert({ id: site.id, name: result.name, url: result.url })
          if (result.fetchIcon) await controller.refetchIcon({ ...site, name: result.name, url: result.url })
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), 'error')
        }
      })
    }
  })

  slot?.appendChild(controller.grid.element)

  element.querySelector('[data-action="add"]')?.addEventListener('click', () => {
    void openSiteForm(null).then(async (result) => {
      if (!result) return
      try {
        await controller.upsert({ name: result.name, url: result.url })
        if (result.fetchIcon) {
          // 新站点刚加进来，从返回列表里找到它再抓——直接用名字匹配不可靠（可能重名）
          const created = controller
            .current()
            .find((site) => site.url === result.url && site.name === result.name)
          if (created) await controller.refetchIcon(created)
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
      }
    })
  })

  element.querySelector('[data-action="fetch-all"]')?.addEventListener('click', () => {
    const missing = controller.current().filter((site) => !site.iconFile)
    if (missing.length === 0) {
      toast(t('portal.allHaveIcons'), 'info')
      return
    }

    void confirmAction({
      title: t('portal.fetchTitle', { count: missing.length }),
      message: t('portal.fetchBody'),
      confirmText: t('portal.fetchStart')
    }).then((confirmed) => {
      if (!confirmed) return
      // 串行而不是并发：一次只发一个请求，既不给对方站点压力，
      // 也避免十几个超时请求同时堆在内存里
      void (async () => {
        let done = 0
        for (const site of missing) {
          await controller.refetchIcon(site)
          done += 1
        }
        toast(t('portal.fetchDone', { count: done }), 'info')
      })()
    })
  })

  return {
    element,
    async onEnter() {
      await controller.load()
    },
    dispose() {
      controller.dispose()
    }
  }
}
