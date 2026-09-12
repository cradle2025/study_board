/**
 * Notion 同步的共用规则。
 *
 * 放在 shared 而不是只写在主进程里，是因为**三个地方都要用同一份判断**：
 *
 * - 主进程发请求前要拼端点、校验 id；
 * - 渲染层要在用户粘错东西时立刻给出人话提示，而不是等请求打回来；
 * - 冒烟测试要能独立验「这段地址会被解析成什么」。
 *
 * 三处各写一份迟早会漂，所以规则只在这里定义一次。
 */

/** Notion API 的固定入口。用户配置的只有 token 与目标 id，地址不可改 */
export const NOTION_API_ORIGIN = 'https://api.notion.com'

/** Notion API 版本头。写死在这里，避免各调用点各写一个版本号 */
export const NOTION_VERSION = '2022-06-28'

/**
 * frontmatter 里记录远端页面 id 的键。
 *
 * 用 `notionId` 而不是复用 `id`：`id` 是笔记自己的身份，换台机器同步过来
 * 也该保持不变；把两者混成一个字段，等于让「本地身份」被远端牵着走。
 */
export const NOTION_ID_KEY = 'notionId'

/** 上次推送时的内容指纹，写在 frontmatter 里，用来跳过没改过的篇 */
export const NOTION_HASH_KEY = 'notionHash'

/**
 * 从用户粘进来的东西里取出 Notion 的页面 / 数据库 id。
 *
 * 用户大概率不会规规矩矩只复制那 32 位十六进制，而是把整个地址粘进来
 * （`https://www.notion.so/xxx/StudyBoard-1a2b3c...?v=...`）。所以这里
 * **两种形式都认**，而不是报一句「格式不对」把球踢回去。
 *
 * 返回统一的带连字符形式（`8-4-4-4-12`）：Notion 自己两种都收，
 * 但统一之后比较、去重、写日志都省心。
 */
export function parseNotionId(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''

  // 1. 已经在文本里出现 32 位十六进制（可能带连字符）就直接取。
  //    放在前面是因为「先按 URL 解析」会被不带协议头的裸 id 骗到
  const dashed = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  if (dashed) return dashed[0].toLowerCase()

  const bare = text.match(/[0-9a-fA-F]{32}/)
  if (bare) return hyphenate(bare[0])

  // 2. 退一步：按 URL 处理，从最后一段里再找一次（这一段的匹配与上面相同，
  //    但显式走一遍能让「粘了个地址但 id 藏在 query 里」的情况也覆盖到）
  try {
    const url = new URL(text)
    const blob = `${url.pathname}${url.search}`
    const inUrl = blob.match(/[0-9a-fA-F]{32}/)
    if (inUrl) return hyphenate(inUrl[0])
  } catch {
    // 不是 URL，也不是裸 id —— 交给下面返回空串
  }

  return ''
}

function hyphenate(bare: string): string {
  const hex = bare.toLowerCase()
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-')
}

/** 把带连字符的 id 还原成 Notion API 实际接受的紧凑形式 */
export function compactNotionId(id: string): string {
  return id.replace(/-/g, '')
}

/**
 * 生成「推送状态」的指纹。
 *
 * 用它跳过没改过的篇：内容与标题都没变时没必要再发一次请求——
 * 既省配额，也避免在 Notion 那边堆出一串无意义的版本记录。
 *
 * 用的是便宜且稳定的字符串哈希（FNV-1a 的 32 位变体），不是加密哈希：
 * 这里只需要「变了没有」这个判断，不需要抗碰撞。
 */
export function pushFingerprint(title: string, content: string): string {
  const text = `${title}\u0000${content}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    // imul 做 32 位乘法，避免大数丢精度
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  // 带上长度：极短内容之间的哈希差异会更可信一点（代价几乎为零）
  return `${hash.toString(16)}-${text.length}`
}

/**
 * 笔记标题 → Notion 页面标题。
 *
 * 只做「不能为空」这一件事：标题是用户的，截断或改写都不是我们该干的。
 */
export function notionTitle(rawTitle: unknown): string {
  const title = String(rawTitle ?? '').trim()
  return title || '未命名笔记'
}
