import { Editor } from '@tiptap/core'
import Highlight from '@tiptap/extension-highlight'
import { TableKit } from '@tiptap/extension-table'
import TextAlign from '@tiptap/extension-text-align'
import StarterKit from '@tiptap/starter-kit'

import type { EditorCommand, EditorHandle } from './commands'
import { htmlToMarkdown, markdownToHtml } from './convert'

/**
 * 富文本编辑器（TipTap / ProseMirror）。
 *
 * 需求要的是「像 Word 那样」：加粗斜体下划线、标题、列表、引用、代码块、
 * 链接、表格、对齐，以及撤销重做。StarterKit v3 已经把其中大部分包进去了
 * （**包括 link 和 underline**，所以不用另装那两个包），
 * 额外补三个它没有的：高亮、对齐、表格。
 *
 * 对外只吐 Markdown——内部存的是 HTML，但 `getMarkdown()` 会转回 md。
 * 调用方始终只面对「一份 .md 源文件」这个事实。
 */

export interface RichTextEditorOptions {
  value: string
  placeholder?: string
  onChange(): void
}

const PLACEHOLDER_CLASS = 'sb-rt-placeholder'

export function createRichTextEditor(options: RichTextEditorOptions): EditorHandle {
  const element = document.createElement('div')
  element.className = 'sb-rt'

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          // 只放行这三种协议：笔记里不该出现 file: 或自定义协议的可点链接
          protocols: ['http', 'https', 'mailto'],
          HTMLAttributes: { rel: 'noreferrer noopener', target: '_blank' }
        },
        codeBlock: { HTMLAttributes: { class: 'sb-rt__code' } }
      }),
      Highlight,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TableKit.configure({ table: { resizable: false } })
    ],
    content: markdownToHtml(options.value),
    editorProps: {
      attributes: {
        class: 'sb-rt__body',
        spellcheck: 'false'
      }
    },
    onUpdate: () => options.onChange()
  })

  // TipTap 没有内置占位符（要另装 extension-placeholder），
  // 但我们只需要「空的时候显示一句话」，用纯 CSS 就够，不必再加一个依赖
  function syncPlaceholder(): void {
    const empty = editor.isEmpty
    element.classList.toggle(PLACEHOLDER_CLASS, empty)
  }
  syncPlaceholder()

  editor.on('update', syncPlaceholder)
  editor.on('selectionUpdate', syncPlaceholder)

  const placeholder = options.placeholder ?? '在这里写……'
  element.setAttribute('data-placeholder', placeholder)

  function chain(): ReturnType<Editor['chain']> {
    return editor.chain().focus()
  }

  function run(command: EditorCommand): boolean {
    switch (command) {
      case 'undo':
        return editor.commands.undo()
      case 'redo':
        return editor.commands.redo()
      case 'bold':
        return chain().toggleBold().run()
      case 'italic':
        return chain().toggleItalic().run()
      case 'strike':
        return chain().toggleStrike().run()
      case 'code':
        return chain().toggleCode().run()
      case 'underline':
        return chain().toggleUnderline().run()
      case 'highlight':
        return chain().toggleHighlight().run()
      case 'h1':
        return chain().toggleHeading({ level: 1 }).run()
      case 'h2':
        return chain().toggleHeading({ level: 2 }).run()
      case 'h3':
        return chain().toggleHeading({ level: 3 }).run()
      case 'paragraph':
        return chain().setParagraph().run()
      case 'bulletList':
        return chain().toggleBulletList().run()
      case 'orderedList':
        return chain().toggleOrderedList().run()
      case 'blockquote':
        return chain().toggleBlockquote().run()
      case 'codeBlock':
        return chain().toggleCodeBlock().run()
      case 'hr':
        return chain().setHorizontalRule().run()
      case 'link': {
        // 已经有链接就取消，否则问一个地址出来。
        // 用 window.prompt 而不是自建浮层：这个动作太轻，不值得一套弹层基础设施
        if (editor.isActive('link')) return chain().unsetLink().run()
        const previous = String(editor.getAttributes('link')['href'] ?? '')
        const url = window.prompt('链接地址', previous || 'https://')
        if (!url) return false
        return chain().extendMarkRange('link').setLink({ href: url.trim() }).run()
      }
      case 'table':
        return chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
      case 'tableRow':
        return chain().addRowAfter().run()
      case 'tableCol':
        return chain().addColumnAfter().run()
      case 'tableDelete':
        return chain().deleteTable().run()
      case 'alignLeft':
        return chain().setTextAlign('left').run()
      case 'alignCenter':
        return chain().setTextAlign('center').run()
      case 'alignRight':
        return chain().setTextAlign('right').run()
      default:
        return false
    }
  }

  function isActive(command: EditorCommand): boolean {
    switch (command) {
      case 'bold':
        return editor.isActive('bold')
      case 'italic':
        return editor.isActive('italic')
      case 'strike':
        return editor.isActive('strike')
      case 'code':
        return editor.isActive('code')
      case 'underline':
        return editor.isActive('underline')
      case 'highlight':
        return editor.isActive('highlight')
      case 'h1':
        return editor.isActive('heading', { level: 1 })
      case 'h2':
        return editor.isActive('heading', { level: 2 })
      case 'h3':
        return editor.isActive('heading', { level: 3 })
      case 'paragraph':
        return editor.isActive('paragraph')
      case 'bulletList':
        return editor.isActive('bulletList')
      case 'orderedList':
        return editor.isActive('orderedList')
      case 'blockquote':
        return editor.isActive('blockquote')
      case 'codeBlock':
        return editor.isActive('codeBlock')
      case 'link':
        return editor.isActive('link')
      case 'table':
        return editor.isActive('table')
      case 'alignLeft':
        return editor.isActive({ textAlign: 'left' })
      case 'alignCenter':
        return editor.isActive({ textAlign: 'center' })
      case 'alignRight':
        return editor.isActive({ textAlign: 'right' })
      default:
        return false
    }
  }

  return {
    element,
    mode: 'richtext',
    getMarkdown: () => htmlToMarkdown(editor.getHTML()),
    setMarkdown(md) {
      const html = markdownToHtml(md)
      if (editor.getHTML() === html) return
      // emitUpdate: false —— 这是外部灌进来的内容，不该触发「用户编辑了」从而安排自动保存
      editor.commands.setContent(html, { emitUpdate: false })
      syncPlaceholder()
    },
    focus: () => editor.commands.focus(),
    destroy: () => editor.destroy(),
    run,
    isActive
  }
}
