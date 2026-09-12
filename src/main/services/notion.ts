import { NOTION_API_ORIGIN, NOTION_HASH_KEY, NOTION_ID_KEY, NOTION_VERSION, compactNotionId, notionTitle, parseNotionId, pushFingerprint } from '@shared/notion'
import { MAX_NOTION_BATCH, MAX_NOTION_CONFLICTS, MAX_NOTION_PUSH_BYTES, NOTION_TIMEOUT_MS } from '@shared/limits'
import type {
  NotionConflict,
  NotionPullResult,
  NotionPushResult,
  NotionResolveInput,
  NotionResolveResult
} from '@shared/types'

import { context } from '../context'

/**
 * Notion 双向同步。
 *
 * 几条定死的规矩：
 *
 * 1. **请求只在主进程发**。理由与 `services/ai.ts` 完全一样：token 只活在主进程，
 *    渲染层的 CSP 又是 `connect-src 'self'`，本来也发不出去。
 * 2. **note ↔ page 的对应关系写在笔记 frontmatter 的 `notionId` 里**，
 *    不去猜标题。标题是用户随时会改的东西，拿它当主键，改个标题就会
 *    「删一篇 + 加一篇」——这正是笔记库对账那一课学到的教训。
 * 3. **拉取遇到冲突一律不自动处理**。同一个 notionId 两边都有、内容还不一样时，
 *    「以哪边为准」会直接改掉用户写的东西。这个决定必须由用户来做，
 *    所以 `pull()` 只把冲突报上去，真正落盘发生在 `resolve()`。
 */

/** 响应体上限：挡住对面吐一个超大 JSON 把内存打爆 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

interface NotionRichText {
  plain_text?: unknown
  text?: { content?: unknown }
  type?: unknown
}

interface NotionBlock {
  id?: unknown
  type?: unknown
  has_children?: unknown
  paragraph?: { rich_text?: NotionRichText[] }
  heading_1?: { rich_text?: NotionRichText[] }
  heading_2?: { rich_text?: NotionRichText[] }
  heading_3?: { rich_text?: NotionRichText[] }
  bulleted_list_item?: { rich_text?: NotionRichText[] }
  numbered_list_item?: { rich_text?: NotionRichText[] }
  quote?: { rich_text?: NotionRichText[] }
  code?: { rich_text?: NotionRichText[] }
  child_page?: { title?: unknown }
  child_database?: { title?: unknown }
}

interface NotionPage {
  id?: unknown
  url?: unknown
  last_edited_time?: unknown
  archived?: unknown
  properties?: Record<string, unknown>
  parent?: Record<string, unknown>
  title?: unknown
}

/* ------------------------------------------------------------------ 端点与请求 */

function requireToken(): string {
  const store = context().secrets
  const token = store.get('notionToken')
  if (token) return token
  if (!store.available) throw new Error('系统钥匙串当前不可用，读不到 Notion Token')
  throw new Error('还没配置 Notion Token（设置 → Notion 同步）')
}

function requireTargetId(): string {
  const raw = context().settings.get().notion.targetId
  const id = parseNotionId(raw)
  if (!id) {
    throw new Error('还没配置目标数据库或页面（设置 → Notion 同步）')
  }
  return id
}

/**
 * 统一的请求封装：超时、响应上限、错误翻译都在这里，调用点只管业务。
 *
 * `describeStatus` 把 Notion 的状态码翻译成人话——它返回的 JSON 里
 * `message` 字段本身是可读的，直接透出去比我们编一句更准确。
 */
async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = requireToken()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NOTION_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${NOTION_API_ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': NOTION_VERSION,
        'content-type': 'application/json'
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时（超过 ${NOTION_TIMEOUT_MS / 1000} 秒）`)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`连不上 Notion：${message}`)
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('Notion 返回的内容过大，已中止')

  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    if (!response.ok) throw new Error(`Notion 请求失败（HTTP ${response.status}）`)
    throw new Error('Notion 返回的不是合法 JSON')
  }

  if (!response.ok) {
    const detail = typeof data['message'] === 'string' ? data['message'] : ''
    throw new Error(describeNotionError(response.status, String(data['code'] ?? ''), detail))
  }

  return data as T
}

function describeNotionError(status: number, code: string, detail: string): string {
  const suffix = detail ? `：${detail.slice(0, 200)}` : ''
  if (status === 401) return `Notion Token 无效${suffix}`
  if (status === 403) return `这个集成没有权限访问目标页面——记得在 Notion 里把它「连接」到该页面${suffix}`
  if (status === 404) return `找不到目标页面或数据库，检查一下 id，以及集成是否被授权${suffix}`
  if (status === 429) return `请求过于频繁，稍后再试${suffix}`
  if (code === 'validation_error') return `Notion 拒绝了这次的请求${suffix}`
  if (status >= 500) return `Notion 服务端出错（HTTP ${status}）${suffix}`
  return `Notion 请求被拒绝（HTTP ${status}）${suffix}`
}

/* ------------------------------------------------------------------ 富文本 ↔ Markdown */

/**
 * 把一段富文本拼回纯文本。
 *
 * Notion 把一句话切成若干 rich_text 片段（加粗、链接、代码各是一个片段），
 * 这里只取 `plain_text`：我们同步的是**内容**，不做双向的样式映射。
 * 样式在两边各有各的表示法，硬做映射只会得到一堆对不上的噪音。
 */
function richTextToPlain(items: NotionRichText[] | undefined): string {
  if (!Array.isArray(items)) return ''
  return items
    .map((item) => {
      if (typeof item?.plain_text === 'string') return item.plain_text
      const inner = item?.text?.content
      return typeof inner === 'string' ? inner : ''
    })
    .join('')
}

/**
 * Markdown 正文 → Notion 的块数组。
 *
 * 只认最常见的几种（标题 1–3、列表、引用、代码块、段落）。刻意**不做完整
 * 的 Markdown 解析**：Notion 的块模型与 Markdown 本来就不是一一对应，
 * 硬凑一个完整的转换器，维护成本和出错面积都会失控。
 * 认不出来的行一律当段落——内容不丢，这是底线。
 *
 * 每块上限 2000 字符（Notion 单块 rich_text 的硬限制），超长的段落切开，
 * 而不是让整次推送因为一块太长而失败。
 */
function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
  const BLOCK_LIMIT = 1900
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks: Array<Record<string, unknown>> = []
  let codeBuffer: string[] | null = null

  const pushParagraph = (text: string): void => {
    if (!text.trim()) return
    for (let i = 0; i < text.length; i += BLOCK_LIMIT) {
      blocks.push(paragraphBlock(text.slice(i, i + BLOCK_LIMIT)))
    }
  }

  for (const line of lines) {
    // 代码块：整段包成一块 code，中间的 # - 之类不当成标记
    if (/^\s*```/.test(line)) {
      if (codeBuffer === null) {
        codeBuffer = []
      } else {
        blocks.push(codeBlock(codeBuffer.join('\n')))
        codeBuffer = null
      }
      continue
    }
    if (codeBuffer !== null) {
      codeBuffer.push(line)
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = (heading[1] ?? '').length
      const text = (heading[2] ?? '').trim()
      if (text) blocks.push(headingBlock(level, text))
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      blocks.push(listBlock('bulleted_list_item', (bullet[1] ?? '').trim()))
      continue
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      blocks.push(listBlock('numbered_list_item', (ordered[1] ?? '').trim()))
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      blocks.push(quoteBlock((quote[1] ?? '').trim()))
      continue
    }

    pushParagraph(line)
  }

  if (codeBuffer !== null && codeBuffer.length > 0) blocks.push(codeBlock(codeBuffer.join('\n')))
  // Notion 不接受空 children；整篇空内容时至少给一个空段落
  if (blocks.length === 0) blocks.push(paragraphBlock(''))
  return blocks
}

function textOf(content: string): NotionRichText[] {
  return [{ type: 'text', text: { content } }]
}

function paragraphBlock(content: string): Record<string, unknown> {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: textOf(content) } }
}

function headingBlock(level: number, content: string): Record<string, unknown> {
  const type = `heading_${level}`
  return { object: 'block', type, [type]: { rich_text: textOf(content) } }
}

function listBlock(type: string, content: string): Record<string, unknown> {
  return { object: 'block', type, [type]: { rich_text: textOf(content) } }
}

function quoteBlock(content: string): Record<string, unknown> {
  return { object: 'block', type: 'quote', quote: { rich_text: textOf(content) } }
}

function codeBlock(content: string): Record<string, unknown> {
  return {
    object: 'block',
    type: 'code',
    code: { rich_text: textOf(content.slice(0, 1900)), language: 'plain text' }
  }
}

/** Notion 块 → Markdown。拉取方向只做最基本的还原，与上面的映射对称 */
function blockToMarkdown(block: NotionBlock): string {
  const type = String(block.type ?? '')
  switch (type) {
    case 'heading_1':
      return `# ${richTextToPlain(block.heading_1?.rich_text)}`
    case 'heading_2':
      return `## ${richTextToPlain(block.heading_2?.rich_text)}`
    case 'heading_3':
      return `### ${richTextToPlain(block.heading_3?.rich_text)}`
    case 'bulleted_list_item':
      return `- ${richTextToPlain(block.bulleted_list_item?.rich_text)}`
    case 'numbered_list_item':
      return `1. ${richTextToPlain(block.numbered_list_item?.rich_text)}`
    case 'quote':
      return `> ${richTextToPlain(block.quote?.rich_text)}`
    case 'code': {
      const body = richTextToPlain(block.code?.rich_text)
      return `\`\`\`\n${body}\n\`\`\``
    }
    case 'paragraph':
      return richTextToPlain(block.paragraph?.rich_text)
    default:
      return ''
  }
}

/* ------------------------------------------------------------------ 页面读写 */

/** 从页面对象里取出标题：数据库行的标题在 properties 里，普通页面在顶层 */
function pageTitle(page: NotionPage): string {
  if (typeof page.title === 'string' && page.title) return page.title

  const properties = page.properties
  if (properties && typeof properties === 'object') {
    for (const value of Object.values(properties)) {
      const prop = value as { type?: unknown; title?: NotionRichText[] }
      if (prop?.type === 'title') {
        const text = richTextToPlain(prop.title)
        if (text) return text
      }
    }
  }
  // 子页面：父页面看到的标题字段名不一样
  const child = page as { child_page?: { title?: unknown } }
  if (typeof child.child_page?.title === 'string') return child.child_page.title

  return ''
}

function pageEditedAt(page: NotionPage): string {
  return typeof page.last_edited_time === 'string' ? page.last_edited_time : ''
}

/**
 * 拉一个页面的全部块。
 *
 * 必须翻页：Notion 单次最多给 100 块，一篇长笔记轻易就超了。
 * 不翻页的话表现是「同步回来的内容莫名少了一半」，最难查的那种。
 */
async function listAllBlocks(pageId: string): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = []
  let cursor = ''

  for (let page = 0; page < 100; page += 1) {
    const query = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : '?page_size=100'
    const data = await request<{ results?: NotionBlock[]; has_more?: unknown; next_cursor?: unknown }>(
      `/v1/blocks/${compactNotionId(pageId)}/children${query}`
    )
    for (const block of data.results ?? []) blocks.push(block)

    if (data.has_more !== true) break
    cursor = typeof data.next_cursor === 'string' ? data.next_cursor : ''
    if (!cursor) break
  }

  return blocks
}

async function readPage(pageId: string): Promise<{ title: string; content: string; editedAt: string }> {
  const page = await request<NotionPage>(`/v1/pages/${compactNotionId(pageId)}`)
  const blocks = await listAllBlocks(pageId)

  const lines: string[] = []
  for (const block of blocks) {
    // 子页面只记一行标题：递归抓整棵树会让一次同步变成几十上百个请求，
    // 而「别人挂在你页面下的子页」本来就该留在 Notion 里
    const type = String(block.type ?? '')
    if (type === 'child_page') {
      lines.push(`### ${String((block.child_page?.title as string) ?? '子页面')}`)
      continue
    }
    lines.push(blockToMarkdown(block))
  }

  // 连续空行收成一个：块之间反正是分开的，多留空行只会让 Markdown 变脏
  const content = lines.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  return { title: pageTitle(page), content, editedAt: pageEditedAt(page) }
}

/**
 * 把一篇笔记推上去。
 *
 * 已有 notionId 就更新页面（先清空再写块），没有就新建。
 * 「清空 + 重写」而不是「逐块 diff」是有意的取舍：逐块 diff 要在本地维护
 * 一份远端块结构镜像，一旦对不上就会写出错乱的内容；整页重写虽然浪费一点
 * 请求，但结果是**可预测**的——推完之后远端必然等于本地。
 */
async function pushNote(
  noteId: string,
  parentId: string
): Promise<{ pushed: boolean; skipped: boolean; pageId: string }> {
  const notes = context().notes
  const doc = notes.read(noteId)
  const title = notionTitle(doc.title)
  const content = String(doc.content ?? '').slice(0, MAX_NOTION_PUSH_BYTES)

  const fingerprint = pushFingerprint(title, content)
  const known = parseNotionId(doc.frontmatter[NOTION_ID_KEY])
  const lastHash = String(doc.frontmatter[NOTION_HASH_KEY] ?? '')

  // 内容与标题都没动过，且上次推成功过 —— 跳过。省配额，也避免在远端
  // 堆一串无意义的版本记录
  if (known && lastHash === fingerprint) {
    return { pushed: false, skipped: true, pageId: known }
  }

  const blocks = markdownToBlocks(content)

  if (known) {
    await request(`/v1/pages/${compactNotionId(known)}`, {
      method: 'PATCH',
      body: {
        properties: { title: { title: textOf(title) } }
      }
    })
    // 先删掉现有的块，再写新的：Notion 的 append 是「追加」，
    // 不清空的话每同步一次内容就多一份
    const existing = await listAllBlocks(known)
    for (const block of existing) {
      const id = typeof block.id === 'string' ? block.id : ''
      if (!id) continue
      await request(`/v1/blocks/${compactNotionId(id)}`, { method: 'DELETE' })
    }
    await appendBlocks(known, blocks)
  } else {
    const created = await request<NotionPage>('/v1/pages', {
      method: 'POST',
      body: {
        parent: parentBody(parentId),
        properties: { title: { title: textOf(title) } },
        children: blocks.slice(0, 100)
      }
    })
    const pageId = typeof created.id === 'string' ? created.id : ''
    if (!pageId) throw new Error('Notion 没有返回新页面的 id')
    // 超出的块追加进去（create 一次最多 100 块）
    if (blocks.length > 100) await appendBlocks(pageId, blocks.slice(100))
    writeBackFrontmatter(noteId, pageId, fingerprint)
    return { pushed: true, skipped: false, pageId }
  }

  writeBackFrontmatter(noteId, known, fingerprint)
  return { pushed: true, skipped: false, pageId: known }
}

/** 每次追加最多 100 块，超了要分批 */
async function appendBlocks(pageId: string, blocks: Array<Record<string, unknown>>): Promise<void> {
  for (let i = 0; i < blocks.length; i += 100) {
    const chunk = blocks.slice(i, i + 100)
    if (chunk.length === 0) continue
    await request(`/v1/blocks/${compactNotionId(pageId)}/children`, {
      method: 'PATCH',
      body: { children: chunk }
    })
  }
}

/** 目标是一个数据库还是普通页面，决定 parent 怎么写 */
function parentBody(targetId: string): Record<string, unknown> {
  const kind = context().settings.get().notion.targetKind
  if (kind === 'page') return { type: 'page_id', page_id: compactNotionId(targetId) }
  return { type: 'database_id', database_id: compactNotionId(targetId) }
}

/**
 * 把远端页面的 id 与指纹写回笔记的 frontmatter。
 *
 * 走 `notes.write()` 而不是直接改文件：写笔记这件事只该有一个入口，
 * 绕过它就会漏掉索引更新与「自己写盘」的指纹登记——后者漏了的话，
 * 文件监听会把这次写入当成外部改动推给渲染层。
 */
function writeBackFrontmatter(noteId: string, pageId: string, fingerprint: string): void {
  const notes = context().notes
  const doc = notes.read(noteId)
  notes.write({
    id: noteId,
    content: doc.content,
    title: doc.title,
    extra: { [NOTION_ID_KEY]: parseNotionId(pageId) || pageId, [NOTION_HASH_KEY]: fingerprint }
  })
}

/* ------------------------------------------------------------------ 对外接口 */

/** 连通性自检：能不能读到目标对象、它叫什么 */
export async function notionTest(): Promise<{ ok: boolean; name: string }> {
  const targetId = requireTargetId()
  const kind = context().settings.get().notion.targetKind

  const page = await request<NotionPage>(`/v1/${kind === 'page' ? 'pages' : 'databases'}/${compactNotionId(targetId)}`)

  // 标题在两种对象上的落点不一样：页面在 properties / title，数据库在 title 数组
  let name = pageTitle(page)
  if (!name) {
    const db = page as unknown as { title?: NotionRichText[] }
    name = richTextToPlain(db.title)
  }

  return { ok: true, name: name || '（未命名）' }
}

/**
 * 推送。
 *
 * 逐篇独立处理：一篇失败不影响其余的，最后把失败原因汇总报出来。
 * 「全有全无」在这里是错的——用户推 20 篇，不该因为第 7 篇有个字符
 * Notion 不收就全部白干。
 */
export async function notionPush(noteIds: unknown): Promise<NotionPushResult> {
  const targetId = requireTargetId()
  const ids = Array.isArray(noteIds) ? noteIds.map((id) => String(id ?? '')).filter(Boolean) : []
  if (ids.length === 0) throw new Error('没有选中要推送的笔记')
  if (ids.length > MAX_NOTION_BATCH) {
    throw new Error(`一次最多推送 ${MAX_NOTION_BATCH} 篇，请分批进行`)
  }

  let pushed = 0
  let skipped = 0
  const failures: string[] = []

  for (const id of ids) {
    try {
      const result = await pushNote(id, targetId)
      if (result.skipped) skipped += 1
      else pushed += 1
    } catch (error) {
      const note = context().notes.find(id)
      const label = note ? note.title : id
      failures.push(`${label}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (pushed > 0 || skipped > 0) {
    context().settings.markNotionSynced()
  }

  // 有失败就抛，但把成功的那部分也说清楚——用户得知道哪些已经上去了
  if (failures.length > 0) {
    const head = failures.slice(0, 3).join('；')
    const rest = failures.length > 3 ? `；另有 ${failures.length - 3} 篇失败` : ''
    throw new Error(`${failures.length} 篇没能推送（成功 ${pushed} 篇）：${head}${rest}`)
  }

  return { pushed, skipped }
}

/**
 * 拉取。
 *
 * 规则：
 * - 远端有、本地没有对应 notionId 的 → 新建（这一类没有歧义，直接做）；
 * - 两边都有且内容一致 → 不动；
 * - 两边都有但内容不一致 → **报为冲突，不自动处理**，等 `resolve()`。
 *
 * 冲突之所以不自动选一边：这可能覆盖用户自己写的东西。多问一句的代价是
 * 一次点击，猜错的代价是一篇笔记。
 */
export async function notionPull(): Promise<NotionPullResult> {
  const targetId = requireTargetId()
  const kind = context().settings.get().notion.targetKind
  const notes = context().notes

  // 本地已认领的 notionId → 笔记 id
  const claimed = new Map<string, string>()
  for (const meta of notes.list()) {
    try {
      const doc = notes.read(meta.id)
      const remoteId = parseNotionId(doc.frontmatter[NOTION_ID_KEY])
      if (remoteId) claimed.set(remoteId, meta.id)
    } catch {
      /* 读不到的跳过，不让一篇坏文件挡住整次同步 */
    }
  }

  const remotePages = await listRemotePages(targetId, kind)
  const conflicts: NotionConflict[] = []
  let pulled = 0
  let deferred = 0

  for (const page of remotePages.slice(0, MAX_NOTION_BATCH)) {
    const rawId = typeof page.id === 'string' ? page.id : ''
    const remoteId = parseNotionId(rawId)
    if (!remoteId) continue

    const remote = await readPage(remoteId)
    const localNoteId = claimed.get(remoteId)

    if (!localNoteId) {
      // 本地没有：直接建。新文件不会覆盖任何东西，所以不用问
      const created = notes.create(remote.title || '来自 Notion 的笔记', remote.content)
      writeBackFrontmatter(created.id, remoteId, pushFingerprint(remote.title, remote.content))
      pulled += 1
      continue
    }

    const local = notes.read(localNoteId)
    // 内容一致就没事。比的是「推上去的那份」与「远端现在这份」：
    // 用本地当前内容去比会把「本地自己改过还没推」也算成冲突，那是另一个方向的事
    const localHash = String(local.frontmatter[NOTION_HASH_KEY] ?? '')
    const remoteHash = pushFingerprint(remote.title, remote.content)
    if (localHash && localHash === remoteHash) continue

    // 本地从没推过（没有指纹）却带着 notionId：当成冲突而不是"直接覆盖"，
    // 因为「谁更新」这件事我们并不知道
    if (conflicts.length >= MAX_NOTION_CONFLICTS) {
      deferred += 1
      continue
    }

    conflicts.push({
      noteId: localNoteId,
      noteTitle: local.title,
      remoteTitle: remote.title,
      remoteEditedAt: remote.editedAt
    })
  }

  if (remotePages.length > MAX_NOTION_BATCH) deferred += remotePages.length - MAX_NOTION_BATCH
  if (pulled > 0) context().settings.markNotionSynced()

  return { pulled, conflicts, deferred }
}

/** 列远端页面：数据库走 query，普通页面走 children */
async function listRemotePages(targetId: string, kind: string): Promise<NotionPage[]> {
  if (kind === 'page') {
    const blocks = await listAllBlocks(targetId)
    return blocks
      .filter((block) => String(block.type ?? '') === 'child_page' && typeof block.id === 'string')
      .map((block) => ({ id: block.id, child_page: block.child_page }))
  }

  const pages: NotionPage[] = []
  let cursor = ''
  for (let i = 0; i < 100; i += 1) {
    const body: Record<string, unknown> = { page_size: 100 }
    if (cursor) body['start_cursor'] = cursor
    const data = await request<{ results?: NotionPage[]; has_more?: unknown; next_cursor?: unknown }>(
      `/v1/databases/${compactNotionId(targetId)}/query`,
      { method: 'POST', body }
    )
    for (const page of data.results ?? []) {
      if (page.archived === true) continue
      pages.push(page)
    }
    if (data.has_more !== true) break
    cursor = typeof data.next_cursor === 'string' ? data.next_cursor : ''
    if (!cursor) break
  }
  return pages
}

/**
 * 用户为一条冲突选定了「以哪边为准」。
 *
 * 选 remote 才动本地文件；选 local 只是把远端那篇标记成「按本地为准」——
 * 具体做法是把本地内容重新推上去，让两边重新一致（下一轮 pull 就不会再报这条）。
 */
export async function notionResolve(input: unknown): Promise<NotionResolveResult> {
  const payload = (input ?? {}) as Partial<NotionResolveInput>
  const noteId = String(payload.noteId ?? '')
  const choice = payload.choice === 'remote' ? 'remote' : 'local'
  if (!noteId) throw new Error('缺少要处理的笔记')

  const notes = context().notes
  const local = notes.read(noteId)
  const remoteId = parseNotionId(local.frontmatter[NOTION_ID_KEY])
  if (!remoteId) throw new Error('这篇笔记没有对应的 Notion 页面')

  if (choice === 'local') {
    // 以本地为准 = 把它推上去，覆盖远端
    const targetId = requireTargetId()
    await pushNote(noteId, targetId)
    return { applied: 0 }
  }

  const remote = await readPage(remoteId)
  // 以远端为准：正文与标题都换成远端那份。frontmatter 里的 notionId 原样保留，
  // 否则下一次 pull 会把这篇当成「本地新笔记」再建一遍
  notes.write({
    id: noteId,
    content: remote.content,
    title: remote.title || local.title,
    extra: { [NOTION_ID_KEY]: remoteId }
  })
  writeBackFrontmatter(noteId, remoteId, pushFingerprint(remote.title || local.title, remote.content))
  context().settings.markNotionSynced()
  return { applied: 1 }
}

/** 用户决定之前先看看远端那篇长什么样 */
export async function notionPreview(noteId: unknown): Promise<{ title: string; content: string }> {
  const id = String(noteId ?? '')
  const local = context().notes.read(id)
  const remoteId = parseNotionId(local.frontmatter[NOTION_ID_KEY])
  if (!remoteId) throw new Error('这篇笔记没有对应的 Notion 页面')
  const remote = await readPage(remoteId)
  return { title: remote.title, content: remote.content }
}
