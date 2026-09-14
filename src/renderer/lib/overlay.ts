/**
 * 浮层基础设施。
 *
 * 为什么不用浏览器原生的 popover / dialog：
 *  - 原生 `<dialog>` 在较早的 Chromium 上行为有差异（尤其 `::backdrop` 与 Esc 处理）；
 *  - Popover API 更是新版本才有。
 * 本项目要求「不依赖会随系统升级而变的东西」，所以统一用最古老的
 * `position: fixed` + div 自己实现，行为在任何 Chromium 上完全一致。
 *
 * 所有浮层都挂在 document.body 上，避免被 `overflow: auto` 的容器裁掉。
 */

const MARGIN = 8

let layer: HTMLElement | null = null

function ensureLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer
  const host = document.createElement('div')
  host.className = 'sb-layer'
  document.body.appendChild(host)
  layer = host
  return host
}

/**
 * 浮层容器按需创建、空了就摘掉。
 *
 * 常驻一个 `position: fixed; inset: 0` 的覆盖层，Chromium 会一直为它保留
 * 一个全屏层，白白占着内存和一次合成。用完了就该还回去。
 *
 * 清理走微任务而不是同步执行：像「关掉悬停预览、紧接着打开编辑弹层」这种
 * 一关一开的连招，同步清理会把容器拆了又建，多一次无谓的 DOM 增删。
 */
function scheduleLayerCleanup(): void {
  queueMicrotask(() => {
    if (layer && layer.childElementCount === 0) {
      layer.remove()
      layer = null
    }
  })
}

/** 把浮层定位到锚点元素旁边，自动避让视口边缘 */
function place(element: HTMLElement, anchor: DOMRect, gap = 6): void {
  const rect = element.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  let top = anchor.bottom + gap
  if (top + rect.height > viewportHeight - MARGIN) {
    const above = anchor.top - gap - rect.height
    top = above >= MARGIN ? above : Math.max(MARGIN, viewportHeight - MARGIN - rect.height)
  }

  let left = anchor.left
  if (left + rect.width > viewportWidth - MARGIN) left = viewportWidth - MARGIN - rect.width
  if (left < MARGIN) left = MARGIN

  element.style.top = `${Math.round(top)}px`
  element.style.left = `${Math.round(left)}px`
}

export interface FloatingOptions {
  className: string
  anchor: DOMRect
  /** 是否点击外部即关闭（编辑表单建议设为 false，防止误触丢输入） */
  closeOnOutsideClick?: boolean
  /** 是否响应 Esc 关闭 */
  closeOnEscape?: boolean
  /** 关闭前的钩子，返回 false 可阻止关闭 */
  onBeforeClose?: () => boolean
  onClose?: () => void
}

export interface FloatingHandle {
  element: HTMLElement
  close(): void
}

export function showFloating(options: FloatingOptions): FloatingHandle {
  const host = ensureLayer()
  const element = document.createElement('div')
  element.className = options.className
  // 内容由调用方填充，填完之前先藏着，避免在错误位置闪一下
  element.style.visibility = 'hidden'
  host.appendChild(element)

  let closed = false
  const close = (): void => {
    if (closed) return
    if (options.onBeforeClose && options.onBeforeClose() === false) return
    closed = true
    element.remove()
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('resize', reposition)
    window.removeEventListener('scroll', reposition, true)
    scheduleLayerCleanup()
    options.onClose?.()
  }

  function reposition(): void {
    if (closed) return
    place(element, options.anchor)
    element.style.visibility = 'visible'
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target as Node | null
    if (target && element.contains(target)) return
    close()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (options.closeOnEscape === false) return
    event.preventDefault()
    close()
  }

  // 内容填好之后再测量定位，尺寸才准
  requestAnimationFrame(reposition)

  if (options.closeOnOutsideClick !== false) {
    // 用捕获阶段，避免被内部元素的 stopPropagation 挡掉
    document.addEventListener('pointerdown', onPointerDown, true)
  }
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('resize', reposition)
  window.addEventListener('scroll', reposition, true)

  return { element, close }
}

/* ------------------------------------------------------------------ 模态卡片 */

export interface ModalCardOptions {
  /** 加在卡片上的额外 class，用于调整宽度等 */
  className?: string
  /** 关闭前的钩子，返回 false 可阻止关闭 */
  onBeforeClose?: () => boolean
  onClose?: () => void
}

export interface ModalCardHandle {
  /** 卡片本体，调用方自己往里填内容 */
  card: HTMLElement
  close(): void
}

/**
 * 居中模态框的骨架：只负责遮罩、Esc、点遮罩关闭，内容由调用方填。
 *
 * 抽这一层是因为「确认框」和「新增站点表单」需要的是同一套行为：
 * 都要挂在 body 上、都要 Esc 关闭、关完都要把空浮层容器摘掉。
 * 各写一份的话，漏掉 `scheduleLayerCleanup()` 这种事迟早会发生。
 */
export function openModalCard(options: ModalCardOptions = {}): ModalCardHandle {
  const host = ensureLayer()
  const backdrop = document.createElement('div')
  backdrop.className = 'sb-modal'

  const card = document.createElement('div')
  card.className = options.className ? `sb-modal__card ${options.className}` : 'sb-modal__card'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  backdrop.appendChild(card)

  let closed = false
  const close = (): void => {
    if (closed) return
    if (options.onBeforeClose && options.onBeforeClose() === false) return
    closed = true
    document.removeEventListener('keydown', onKeyDown, true)
    backdrop.remove()
    scheduleLayerCleanup()
    options.onClose?.()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close()
  })
  // Esc 走捕获阶段：表单里的输入框可能自己吞掉按键
  document.addEventListener('keydown', onKeyDown, true)

  host.appendChild(backdrop)
  return { card, close }
}

/* -------------------------------------------------------------- 提示 / 确认框 */

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

/**
 * 只有一个「知道了」的提示框。
 *
 * 存在的理由：有些事必须让用户读完（比如数据被复制到了哪里），
 * 用 toast 会飘走、也没法选中复制；而 `confirmAction` 固定两个按钮，
 * 拿它来做纯提示会多出一个语义不明的「取消」。
 */
export function showInfo(options: { title: string; message: string; confirmText?: string }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }

    /**
     * 三条关闭路径（按钮、Esc、点遮罩）全都算「读完了」。
     *
     * 纯提示没有「反悔」这个状态，所以不需要像 `confirmAction` 那样
     * 区分用户是怎么关的——这也是它能用 `onClose` 一个钩子兜住的原因。
     */
    const modal = openModalCard({ onClose: () => finish() })
    modal.card.innerHTML = `
      <div class="sb-modal__title"></div>
      <p class="sb-modal__message"></p>
      <div class="sb-modal__actions">
        <button class="sb-btn sb-btn--primary" type="button" data-role="confirm"></button>
      </div>
    `
    const titleEl = modal.card.querySelector<HTMLElement>('.sb-modal__title')
    const messageEl = modal.card.querySelector<HTMLElement>('.sb-modal__message')
    const confirmBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="confirm"]')
    if (titleEl) titleEl.textContent = options.title
    if (messageEl) messageEl.textContent = options.message
    if (confirmBtn) confirmBtn.textContent = options.confirmText ?? '知道了'

    confirmBtn?.addEventListener('click', () => {
      modal.close()
      finish()
    })
  })
}

/** 居中确认框。返回用户是否点了「确定」。 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = openModalCard()
    modal.card.innerHTML = `
      <div class="sb-modal__title"></div>
      <p class="sb-modal__message"></p>
      <div class="sb-modal__actions">
        <button class="sb-btn" type="button" data-role="cancel"></button>
        <button class="sb-btn" type="button" data-role="confirm"></button>
      </div>
    `

    const titleEl = modal.card.querySelector<HTMLElement>('.sb-modal__title')
    const messageEl = modal.card.querySelector<HTMLElement>('.sb-modal__message')
    const cancelBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="cancel"]')
    const confirmBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="confirm"]')

    if (titleEl) titleEl.textContent = options.title
    if (messageEl) {
      messageEl.textContent = options.message ?? ''
      if (!options.message) messageEl.remove()
    }
    if (cancelBtn) cancelBtn.textContent = options.cancelText ?? '取消'
    if (confirmBtn) {
      confirmBtn.textContent = options.confirmText ?? '确定'
      if (options.danger) confirmBtn.classList.add('sb-btn--danger')
      else confirmBtn.classList.add('sb-btn--primary')
    }

    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeyDown, true)
      modal.close()
      resolve(value)
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      }
    }

    cancelBtn?.addEventListener('click', () => finish(false))
    confirmBtn?.addEventListener('click', () => finish(true))
    document.addEventListener('keydown', onKeyDown, true)

    confirmBtn?.focus()
  })
}

/* ------------------------------------------------------------------ 输入框 */

export interface PromptOptions {
  title: string
  label?: string
  /** 初始值（改名场景就是原名） */
  value?: string
  placeholder?: string
  confirmText?: string
  maxLength?: number
  /** 输入框下方的说明 */
  hint?: string
}

/**
 * 单行文本输入框。确定返回输入内容（已 trim），取消返回 null。
 *
 * **不要用 `window.prompt`**。Electron 根本没有实现它——调用会返回 null
 * 并在控制台打一句 "prompt() is and will not be supported"，
 * 于是「插链接」这类功能在开发时的浏览器里能用、打包后一点反应都没有。
 * 这正是本项目「开发能跑、打包才暴露」清单上的一员。
 */
export function promptText(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = openModalCard({ className: 'sb-modal__card--prompt' })
    const maxLength = options.maxLength ?? 200
    modal.card.innerHTML = `
      <div class="sb-modal__title"></div>
      <div class="sb-field">
        <label for="sb-prompt-input"></label>
        <input class="sb-input" id="sb-prompt-input" type="text" />
      </div>
      <p class="sb-hint"></p>
      <div class="sb-modal__actions">
        <button class="sb-btn" type="button" data-role="cancel">取消</button>
        <button class="sb-btn sb-btn--primary" type="button" data-role="confirm"></button>
      </div>
    `

    const titleEl = modal.card.querySelector<HTMLElement>('.sb-modal__title')
    const labelEl = modal.card.querySelector<HTMLLabelElement>('label')
    const input = modal.card.querySelector<HTMLInputElement>('#sb-prompt-input')
    const hintEl = modal.card.querySelector<HTMLElement>('.sb-hint')
    const cancelBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="cancel"]')
    const confirmBtn = modal.card.querySelector<HTMLButtonElement>('[data-role="confirm"]')

    if (titleEl) titleEl.textContent = options.title
    if (labelEl) labelEl.textContent = options.label ?? ''
    if (hintEl) {
      if (options.hint) hintEl.textContent = options.hint
      else hintEl.remove()
    }
    if (input) {
      input.maxLength = maxLength
      input.value = options.value ?? ''
      if (options.placeholder) input.placeholder = options.placeholder
    }
    if (cancelBtn) cancelBtn.textContent = '取消'
    if (confirmBtn) confirmBtn.textContent = options.confirmText ?? '确定'

    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKeyDown, true)
      modal.close()
      resolve(value)
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Enter') return
      event.preventDefault()
      // 空输入按取消处理，别让调用方拿到一个空串还要自己判一遍
      const value = input?.value.trim() ?? ''
      finish(value.length > 0 ? value : null)
    }

    cancelBtn?.addEventListener('click', () => finish(null))
    confirmBtn?.addEventListener('click', () => {
      const value = input?.value.trim() ?? ''
      finish(value.length > 0 ? value : null)
    })
    document.addEventListener('keydown', onKeyDown, true)

    input?.focus()
    // 改名场景：预选原文，用户直接打字就是替换
    input?.select()
  })
}

/* ------------------------------------------------------------------ 图片查看器 */

export interface LightboxImage {
  src: string
  caption: string
}

/** 全屏查看课表照片，支持左右切换 */
export function openLightbox(images: readonly LightboxImage[], startIndex = 0): void {
  if (images.length === 0) return

  const host = ensureLayer()
  const overlay = document.createElement('div')
  overlay.className = 'sb-lightbox'
  overlay.innerHTML = `
    <button class="sb-lightbox__nav sb-lightbox__nav--prev" type="button" aria-label="上一张">‹</button>
    <figure class="sb-lightbox__stage">
      <img alt="" />
      <figcaption></figcaption>
    </figure>
    <button class="sb-lightbox__nav sb-lightbox__nav--next" type="button" aria-label="下一张">›</button>
    <button class="sb-lightbox__close" type="button" aria-label="关闭">✕</button>
  `

  const img = overlay.querySelector<HTMLImageElement>('img')
  const caption = overlay.querySelector<HTMLElement>('figcaption')
  const prev = overlay.querySelector<HTMLButtonElement>('.sb-lightbox__nav--prev')
  const next = overlay.querySelector<HTMLButtonElement>('.sb-lightbox__nav--next')

  let index = Math.min(Math.max(0, startIndex), images.length - 1)

  const paint = (): void => {
    const current = images[index]
    if (!current || !img || !caption) return
    img.src = current.src
    caption.textContent =
      images.length > 1 ? `${current.caption}（${index + 1}/${images.length}）` : current.caption
  }

  const close = (): void => {
    document.removeEventListener('keydown', onKeyDown, true)
    overlay.remove()
    scheduleLayerCleanup()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowLeft' && images.length > 1) {
      index = (index - 1 + images.length) % images.length
      paint()
    } else if (event.key === 'ArrowRight' && images.length > 1) {
      index = (index + 1) % images.length
      paint()
    }
  }

  if (images.length > 1) {
    prev?.addEventListener('click', (event) => {
      event.stopPropagation()
      index = (index - 1 + images.length) % images.length
      paint()
    })
    next?.addEventListener('click', (event) => {
      event.stopPropagation()
      index = (index + 1) % images.length
      paint()
    })
  } else {
    prev?.remove()
    next?.remove()
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.sb-lightbox__close')?.addEventListener('click', close)
  document.addEventListener('keydown', onKeyDown, true)

  paint()
  host.appendChild(overlay)
}
