<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
  drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ content: string; filename: string; readOnly: boolean; wrap: boolean }>()
const emit = defineEmits<{ change: [value: string]; save: [] }>()

const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
const language = new Compartment()
const wrapping = new Compartment()
const editable = new Compartment()

/** Colours come from the interface's own variables, so light and dark themes both fit. */
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--card)', color: 'var(--foreground)' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--card)', color: 'var(--muted-foreground)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in oklab, var(--muted) 60%, transparent)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--primary) 22%, transparent) !important',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklab, var(--code-number) 30%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)', borderColor: 'var(--border)' },
  '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  '.cm-tooltip': { backgroundColor: 'var(--popover)', border: '1px solid var(--border)' },
})

const highlight = HighlightStyle.define([
  { tag: [tags.comment, tags.meta], color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-number)' },
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.variableName)], color: 'var(--code-property)' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.className, tags.tagName], color: 'var(--code-type)' },
  { tag: tags.heading, fontWeight: '600' },
  { tag: tags.invalid, color: 'var(--destructive)' },
])

async function loadLanguage() {
  const name = props.filename.split('/').at(-1) ?? ''
  const found =
    LanguageDescription.matchFilename(languages, name) ??
    (/\.(conf|cnf|cfg|ini|env)$|^\.env/.test(name) ? LanguageDescription.matchLanguageName(languages, 'properties') : null) ??
    (/nginx|sites-(available|enabled)/.test(props.filename) ? LanguageDescription.matchLanguageName(languages, 'nginx') : null) ??
    (/\.(service|timer|socket|mount)$/.test(name) ? LanguageDescription.matchLanguageName(languages, 'properties') : null)
  if (!found || !view) return
  try {
    const support = await found.load()
    view?.dispatch({ effects: language.reconfigure(support) })
  } catch {
    // Plain text is fine.
  }
}

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(highlight),
        theme,
        language.of([]),
        wrapping.of(props.wrap ? EditorView.lineWrapping : []),
        editable.of([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (emit('save'), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('change', update.state.doc.toString())
        }),
      ],
    }),
  })
  void loadLanguage()
  view.focus()
})

watch(
  () => props.wrap,
  (wrap) => view?.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) }),
)
watch(
  () => props.readOnly,
  (readOnly) =>
    view?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }),
)

/** Replaces the whole text, for when the file is reloaded from the server. */
function replace(content: string) {
  view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
}

defineExpose({ replace })
onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div ref="host" class="h-full min-h-0 overflow-hidden" />
</template>
