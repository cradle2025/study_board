/**
 * StudyBoard 资料收件箱 · 浏览器扩展（MV3）
 *
 * 只做一件事：监听下载，凡是「资料类文件」（PDF / PPT / Word / Excel），
 * 就把保存位置建议改为「默认下载目录 / StudyBoard收件箱 / 干净文件名」。
 * 学习看板监控这个目录，发现新文件会弹一次归属选择——你从此不用再手动搬文件、改文件名。
 *
 * 两个约定（与主进程 shared/materials.ts 保持一致，改动要两边同步）：
 *  - 子目录名固定为 StudyBoard收件箱
 *  - 文件名只保留 URL 里的最后一段，并把 Windows 非法字符洗掉
 *
 * 不采集任何数据、不上传任何内容：这是一个纯本地的事件改写器。
 */

const INBOX_DIR = 'StudyBoard收件箱'

const MATERIAL_EXTS = ['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx']

/** 开关放在扩展自己的存储里，工具栏弹窗或扩展管理页可改；默认开启 */
async function isEnabled() {
  const stored = await chrome.storage.local.get('enabled')
  return stored.enabled !== false
}

/** URL → 干净文件名。去掉查询串与锚点，只留最后一段，洗掉 Windows 不允许的字符 */
function cleanName(url, fallbackName) {
  let name = fallbackName || 'download'
  try {
    const parsed = new URL(url)
    const fromPath = decodeURIComponent(parsed.pathname.split('/').pop() || '')
    if (fromPath.length > 0) name = fromPath
  } catch {
    /* 相对地址等异常情况直接用浏览器给的名字 */
  }
  const cleaned = name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned : 'download'
}

function isMaterial(name) {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return MATERIAL_EXTS.includes(name.slice(dot + 1).toLowerCase())
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  void (async () => {
    if (!(await isEnabled())) {
      suggest()
      return
    }
    const name = cleanName(downloadItem.url || '', downloadItem.filename)
    if (!isMaterial(name)) {
      suggest()
      return
    }
    // conflictAction uniquify：同名下载自动加 (1) (2)，与看板的去重行为互补
    suggest({ filename: `${INBOX_DIR}/${name}`, conflictAction: 'uniquify' })
  })()
  // 返回 true 表示这是异步决定（要等 storage 读开关）
  return true
})
