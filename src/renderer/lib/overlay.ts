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

/* ------------------------------------------------------------------ 确认框 */

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

/** 居中确认框。返回用户是否点了「确定」。 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = ensureLayer()
    const backdrop = document.createElement('div')
    backdrop.className = 'sb-modal'
    backdrop.innerHTML = `
      <div class="sb-modal__card" role="dialog" aria-modal="true">
        <div class="sb-modal__title"></div>
        <p class="sb-modal__message"></p>
        <div class="sb-modal__actions">
          <button class="sb-btn" type="button" data-role="cancel"></button>
          <button class="sb-btn" type="button" data-role="confirm"></button>
        </div>
      </div>
    `

    const titleEl = backdrop.querySelector<HTMLElement>('.sb-modal__title')
    const messageEl = backdrop.querySelector<HTMLElement>('.sb-modal__message')
    const cancelBtn = backdrop.querySelector<HTMLButtonElement>('[data-role="cancel"]')
    const confirmBtn = backdrop.querySelector<HTMLButtonElement>('[data-role="confirm"]')

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
      backdrop.remove()
      resolve(value)
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      }
    }

    cancelBtn?.addEventListener('click', () => finish(false))
    confirmBtn?.addEventListener('click', () => finish(true))
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish(false)
    })
    document.addEventListener('keydown', onKeyDown, true)

    host.appendChild(backdrop)
    confirmBtn?.focus()
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
