import { Editor } from '@tiptap/core'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import TextAlign from '@tiptap/extension-text-align'
import StarterKit from '@tiptap/starter-kit'

import { noteImageSrc } from '../asset'
import { promptText } from '../overlay'
import type { EditorCommand, EditorHandle } from './commands'
import { htmlToMarkdown, markdownToHtml } from './convert'

/**
 * 富文本编辑器（TipTap / ProseMirror）。
 *
 * 需求要的是「像 Word 那样」：加粗斜体下划线、标题、列表、引用、代码块、
 * 链接、表格、对齐，以及撤销重做。StarterKit v3 已经把其中大部分包进去了
 * （**包括 link 和 underline**，所以不用另装那两个包），
 * 额外补四个它没有的：高亮、对齐、表格、图片。
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
        /**
         * 标题级别开到 6 级，而不是默认的 1–3。
         *
         * 工具栏只放 H1/H2/H3 三个按钮（一排按钮多了反而难选），
         * 但**schema 必须容得下 4–6 级**：一份从别处拷来的 .md
         * 完全可能带 `####`，而 schema 里没有这个节点时，
         * ProseMirror 会把整个标题拆成一个普通段落——
         * 用户在富文本模式打开一下再存盘，那几级标题就永久没了，
         * 而且全程没有任何提示。
         */
        heading: { levels: [1, 2, 3, 4, 5, 6] },
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
      TableKit.configure({ table: { resizable: false } }),
      /**
       * 图片。
       *
       * `inline: true` 是必须的，不是可选项：Markdown 里的图片是**行内**元素
       * （`![x](y)` 可以和文字同处一段），markdown-it 也把它渲染成
       * `<p><img></p>`。而 TipTap 的 Image 默认是**块级**节点，
       * 块级节点塞不进段落——ProseMirror 会直接把它丢掉，
       * 表现就是「打开笔记时图片全没了，而且不报任何错」。
       *
       * `allowBase64: false`（默认值，这里写出来是为了表明是**有意**的）：
       * 允许 data: 图片意味着可以把一张几兆的图 base64 塞进 .md，
       * 而笔记库是要能当纯文本库用、要能进 git 的。
       */
      Image.configure({
        inline: true,
        allowBase64: false,
        HTMLAttributes: { loading: 'lazy', decoding: 'async' }
      })
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
        //
        // 这里原来用的是 `window.prompt`——**Electron 没实现它**，
        // 打包后点了完全没反应（只在控制台留一句 "prompt() is and will not be supported"）。
        // 开发时在浏览器里试是好的，所以一直没被发现。现在走自建弹层。
        if (editor.isActive('link')) return chain().unsetLink().run()
        const previous = String(editor.getAttributes('link')['href'] ?? '')
        void promptText({
          title: '插入链接',
          label: '链接地址',
          value: previous || 'https://',
          placeholder: 'https://…'
        }).then((url) => {
          if (!url) return
          editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
        })
        // 异步弹层：这里返回 true 表示「命令已被接管」，
        // 工具栏就不会再弹「当前模式不支持」的提示
        return true
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
    // 资料引用是一段 Markdown 语法（![[文件名]]），在富文本里就是普通文字；
    // 插入后由 onChange 走正常的自动保存
    insertText(text) {
      editor.chain().focus().insertContent(text).run()
      return true
    },
    /**
     * 插图片。
     *
     * 注意这里塞进去的是**显示地址**（`sb-asset://notes/...`）而不是相对路径：
     * 富文本编辑器内部是 HTML，DOM 里的 `<img src>` 必须是浏览器能加载的地址。
     * 相对路径会在存盘时由 turndown 规则还原回去（见 convert.ts 的 noteImage），
     * 所以磁盘上的 .md 里仍然是相对路径。
     */
    insertImage(src, alt) {
      const display = noteImageSrc(src) ?? src
      return editor.chain().focus().setImage({ src: display, alt }).run()
    },
    focus: () => editor.commands.focus(),
    /**
     * 跳到第 index 个标题。
     *
     * 富文本这边拿不到「行号」，但拿得到 DOM：正文里的标题元素
     * 与 `parseHeadings` 出来的列表**是同一个顺序**，
     * 所以第 index 个大纲项就对应第 index 个标题元素。
     *
     * 这里刻意**不**重新解析一次 markdown：那要经过
     * `getHTML → turndown → parseHeadings` 一整圈，既慢又可能
     * 因为转换本身的偏差与面板算出的序号错开。直接按 DOM 顺序数最稳。
     */
    revealHeading(index) {
      const headings = element.querySelectorAll('h1, h2, h3, h4, h5, h6')
      const target = headings[index]
      if (!target) return false
      target.scrollIntoView({ block: 'start', behavior: 'smooth' })
      // 顺手把光标放到这个标题里，用户可以直接接着改
      const position = editor.view.posAtDOM(target, 0)
      editor.chain().focus().setTextSelection(position).run()
      return true
    },
    destroy: () => editor.destroy(),
    run,
    isActive
  }
}
