import { DynamicBorder, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent"
import { Container, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui"
import { toKebabCase, type Task, type TaskStatus } from "../../models/task.ts"
import type { TaskUpdate } from "../../backend/api.ts"
import { DESCRIPTION_PART_SEPARATOR, buildListRowModel, decodeDescription, stripAnsi } from "../../models/list-item.ts"
import { buildListPrimaryHelpText, buildListSecondaryHelpText, resolveListIntent } from "../../controllers/list.ts"
import { KEYBOARD_HELP_PADDING_X, formatKeyboardHelp } from "../components/keyboard-help.ts"
import { MinHeightContainer } from "../components/min-height.ts"
import { SelectListWithColumns } from "../components/select-list-with-columns.ts"
import { taskHasSources, type TaskSourcePreview } from "../../lib/task-sources.ts"

const LIST_PAGE_CONTENT_MIN_HEIGHT = 20
const TASK_LIST_ROW_LAYOUT = {
  valueMaxWidth: 60,
  valueColumnWidth: 62,
}
const PREVIEW_BODY_LINES = 6

export interface ListPageConfig {
  title: string
  subtitle?: string
  tasks: Task[]
  allowPriority?: boolean
  allowSearch?: boolean
  filterTerm?: string
  priorities: string[]
  priorityHotkeys?: Record<string, string>
  closeKey: string
  cycleStatus: (status: TaskStatus) => TaskStatus
  cycleTaskType: (current: string | undefined) => string
  onUpdateTask: (ref: string, update: TaskUpdate) => Promise<void>
  onWork: (task: Task) => void | Promise<void>
  onInsert: (task: Task) => void | Promise<void>
  onEdit: (ref: string, task: Task | undefined) => Promise<{ updatedTask: Task | null; closeList: boolean }>
  onCreate: () => Promise<Task | null>
  onOpenSource?: (task: Task, index: number) => void | Promise<void>
  loadSourcePreview?: (task: Task, index: number) => Promise<TaskSourcePreview>
}

function truncateDescription(desc: string | undefined, maxLines: number): string[] {
  if (!desc || !desc.trim()) return ["(no description)"]
  const allLines = desc.split(/\r?\n/)
  const lines = allLines.slice(0, maxLines)
  if (allLines.length > maxLines) lines.push("...")
  return lines
}

function matchesFilter(task: Task, term: string): boolean {
  const lower = term.toLowerCase()
  return (
    task.title.toLowerCase().includes(lower) ||
    (task.description ?? "").toLowerCase().includes(lower) ||
    (task.id ?? "").toLowerCase().includes(lower) ||
    toKebabCase(task.status).includes(lower)
  )
}

function buildHeaderText(
  theme: any,
  title: string,
  subtitle: string | undefined,
  searching: boolean,
  searchBuffer: string,
  filterTerm: string,
): string {
  if (searching) return theme.fg("muted", theme.bold(`Search: ${searchBuffer}_`))
  if (filterTerm) return theme.fg("muted", theme.bold(`${title} [filter: ${filterTerm}]`))

  const subtitlePart = subtitle ? theme.fg("dim", ` • ${subtitle}`) : ""
  return `${theme.fg("muted", theme.bold(title))}${subtitlePart}`
}

function wrapText(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = []
  const safeWidth = Math.max(1, width)

  if (text.length === 0) return [""]

  const words = text.split(" ")
  let currentLine = ""

  const flushLine = () => {
    if (lines.length < maxLines) lines.push(currentLine)
    currentLine = ""
  }

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word

    if (stripAnsi(candidate).length <= safeWidth) {
      currentLine = candidate
      continue
    }

    if (currentLine) {
      flushLine()
      if (lines.length >= maxLines) break
    }

    let remaining = word
    while (stripAnsi(remaining).length > safeWidth) {
      const chunk = remaining.slice(0, safeWidth)
      if (lines.length < maxLines) lines.push(chunk)
      if (lines.length >= maxLines) break
      remaining = remaining.slice(safeWidth)
    }
    if (lines.length >= maxLines) break
    currentLine = remaining
  }

  if (currentLine && lines.length < maxLines) lines.push(currentLine)
  return lines.slice(0, maxLines)
}

function buildPreviewText(lines: string[], width: number, maxLines: number): string {
  const wrappedLines: string[] = []
  for (const line of lines) {
    const wrapped = wrapText(line, width, maxLines - wrappedLines.length)
    wrappedLines.push(...wrapped)
    if (wrappedLines.length >= maxLines) break
  }
  while (wrappedLines.length < maxLines) wrappedLines.push("")
  return wrappedLines.join("\n")
}

export async function showTaskList(ctx: ExtensionCommandContext, config: ListPageConfig): Promise<void> {
  const { title, subtitle, tasks, allowPriority = true, allowSearch = true } = config

  const displayTasks = [...tasks]
  let filterTerm = config.filterTerm || ""
  let rememberedSelectedRef: string | undefined
  const selectedSourceIndexByRef = new Map<string, number>()

  while (true) {
    const visible = filterTerm
      ? displayTasks.filter(i => matchesFilter(i, filterTerm))
      : displayTasks

    if (visible.length === 0 && filterTerm) {
      ctx.ui.notify(`No matches for "${filterTerm}"`, "warning")
      filterTerm = ""
      continue
    }

    const getMaxLabelWidth = () => Math.max(0, ...displayTasks.map(i =>
      stripAnsi(buildListRowModel(i).label).length
    ))

    let selectedRef: string | undefined
    const result = await ctx.ui.custom<"cancel" | "select" | "create">((tui: any, theme: any, _kb: any, done: any) => {
      const container = new Container()
      let searching = false
      let searchBuffer = ""
      let previewScroll = 0
      let previewVersion = 0
      let currentPreviewLines: string[] = []

      const headerContainer = new Container()
      const listAreaContainer = new Container()
      const footerContainer = new Container()
      const paddedListAreaContainer = new MinHeightContainer(listAreaContainer, LIST_PAGE_CONTENT_MIN_HEIGHT)

      container.addChild(headerContainer)
      container.addChild(paddedListAreaContainer)
      container.addChild(footerContainer)

      const titleText = new Text("", 1, 0)

      const META_SUMMARY_SEPARATOR = " "
      const accentMarker = "__ACCENT_MARKER__"
      const accentedMarker = theme.fg("accent", accentMarker)
      const markerIndex = accentedMarker.indexOf(accentMarker)
      const accentPrefix = markerIndex >= 0 ? accentedMarker.slice(0, markerIndex) : ""
      const accentSuffix = markerIndex >= 0 ? accentedMarker.slice(markerIndex + accentMarker.length) : "\x1b[0m"
      const applyAccentWithAnsi = (text: string) => {
        const normalized = text.replaceAll(DESCRIPTION_PART_SEPARATOR, META_SUMMARY_SEPARATOR)
        if (!accentPrefix) return theme.fg("accent", normalized)
        return `${accentPrefix}${normalized.replace(/\x1b\[0m/g, `\x1b[0m${accentPrefix}`)}${accentSuffix}`
      }

      const styleDescription = (text: string) => {
        const { meta, summary } = decodeDescription(text)
        if (!summary) return theme.fg("muted", meta)
        return `${theme.fg("muted", meta)}${META_SUMMARY_SEPARATOR}${summary}`
      }

      const getItems = () => {
        const filtered = filterTerm
          ? displayTasks.filter(i => matchesFilter(i, filterTerm))
          : displayTasks
        const maxLabelWidth = getMaxLabelWidth()
        return filtered.map((task) => {
          const row = buildListRowModel(task, { maxLabelWidth })
          return {
            value: row.ref,
            label: row.label,
            description: row.description,
          }
        })
      }

      const selectListTheme = {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => applyAccentWithAnsi(t),
        description: (t: string) => styleDescription(t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      }

      let items = getItems()
      let selectList = new SelectListWithColumns(items, Math.min(items.length, 10), selectListTheme, TASK_LIST_ROW_LAYOUT)

      if (rememberedSelectedRef) {
        const rememberedIndex = items.findIndex(i => i.value === rememberedSelectedRef)
        if (rememberedIndex >= 0) selectList.setSelectedIndex(rememberedIndex)
      }

      const previewTitleText = new Text("", 0, 0)
      const previewSourceText = new Text("", 0, 0)
      const previewBodyText = new Text(buildPreviewText([], 80, PREVIEW_BODY_LINES), 0, 0)
      const itemPreviewContainer = new Container()
      itemPreviewContainer.addChild(previewTitleText)
      itemPreviewContainer.addChild(previewSourceText)
      itemPreviewContainer.addChild(previewBodyText)

      let lastWidth = 80

      const getSelectedTask = (): Task | undefined => {
        const selected = selectList.getSelectedItem()
        if (!selected) return undefined
        rememberedSelectedRef = selected.value
        return displayTasks.find(i => i.ref === selected.value)
      }

      const getCurrentSourceIndex = (task: Task): number => {
        const sourceCount = task.sources?.length ?? 0
        if (sourceCount === 0) return 0

        const current = selectedSourceIndexByRef.get(task.ref) ?? 0
        const normalized = ((current % sourceCount) + sourceCount) % sourceCount
        if (normalized !== current) selectedSourceIndexByRef.set(task.ref, normalized)
        return normalized
      }

      const renderVisiblePreview = () => {
        const allWrapped: string[] = []
        for (const line of currentPreviewLines) {
          const wrapped = wrapText(line, lastWidth, 100)
          allWrapped.push(...wrapped)
        }

        const maxScroll = Math.max(0, allWrapped.length - PREVIEW_BODY_LINES)
        if (previewScroll > maxScroll) previewScroll = maxScroll
        if (previewScroll < 0) previewScroll = 0

        const visible = allWrapped.slice(previewScroll, previewScroll + PREVIEW_BODY_LINES)
        while (visible.length < PREVIEW_BODY_LINES) visible.push("")
        previewBodyText.setText(visible.join("\n"))
      }

      const setPreviewBody = (lines: string[]) => {
        currentPreviewLines = lines
        renderVisiblePreview()
      }

      const updatePreview = async () => {
        const task = getSelectedTask()
        const requestVersion = ++previewVersion

        if (!task) {
          previewTitleText.setText("")
          previewSourceText.setText("")
          setPreviewBody([])
          return
        }

        previewScroll = 0
        previewTitleText.setText(theme.fg("accent", theme.bold(task.title)))

        if (!taskHasSources(task) || !config.loadSourcePreview) {
          previewSourceText.setText(theme.fg("muted", "Description"))
          const descLines = truncateDescription(task.description, 100)
          setPreviewBody(descLines)
          return
        }

        const sourceCount = task.sources?.length ?? 0
        const sourceIndex = getCurrentSourceIndex(task)
        previewSourceText.setText(theme.fg("muted", `Source ${sourceIndex + 1}/${sourceCount} • loading…`))
        setPreviewBody(["Loading source preview…"])
        container.invalidate()
        tui.requestRender()

        const preview = await config.loadSourcePreview(task, sourceIndex)
        if (requestVersion !== previewVersion) return

        previewSourceText.setText(theme.fg("muted", `Source ${sourceIndex + 1}/${sourceCount} • ${preview.title}`))
        const previewLines = preview.content.split(/\r?\n/)
        setPreviewBody(previewLines)
      }

      selectList.onSelectionChange = () => {
        const selected = selectList.getSelectedItem()
        if (selected) rememberedSelectedRef = selected.value
        void updatePreview().finally(() => tui.requestRender())
      }
      selectList.onSelect = () => {
        const sel = selectList.getSelectedItem()
        if (sel) {
          selectedRef = sel.value
          rememberedSelectedRef = sel.value
        }
        done("select")
      }
      selectList.onCancel = () => {
        if (filterTerm) {
          filterTerm = ""
          rebuildAndRender()
        } else {
          done("cancel")
        }
      }

      const renderListArea = () => {
        while (listAreaContainer.children.length > 0) {
          listAreaContainer.removeChild(listAreaContainer.children[0])
        }
        listAreaContainer.addChild(selectList)
        listAreaContainer.addChild(new Spacer(1))
        listAreaContainer.addChild(itemPreviewContainer)
      }

      headerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))
      headerContainer.addChild(titleText)

      const helpText = new Text("", KEYBOARD_HELP_PADDING_X, 0)
      const shortcutsText = new Text("", KEYBOARD_HELP_PADDING_X, 0)

      footerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))
      footerContainer.addChild(helpText)
      footerContainer.addChild(shortcutsText)
      footerContainer.addChild(new DynamicBorder((s: string) => theme.fg("dim", s)))

      renderListArea()

      const refreshDisplay = () => {
        const selectedTask = getSelectedTask()
        const hasSelectedTaskSources = !!selectedTask && taskHasSources(selectedTask) && !!config.loadSourcePreview
        const canOpenSelectedTaskSource = !!selectedTask && taskHasSources(selectedTask) && !!config.onOpenSource

        titleText.setText(buildHeaderText(theme, title, subtitle, searching, searchBuffer, filterTerm))
        helpText.setText(formatKeyboardHelp(theme, buildListPrimaryHelpText({
          searching,
          filtered: !!filterTerm,
          allowPriority,
          allowSearch,
          closeKey: config.closeKey,
          priorities: config.priorities,
          priorityHotkeys: config.priorityHotkeys,
          hasSelectedTaskSources,
          canOpenSelectedTaskSource,
        })))
        shortcutsText.setText(formatKeyboardHelp(theme, buildListSecondaryHelpText(hasSelectedTaskSources, canOpenSelectedTaskSource)))
      }
      refreshDisplay()
      if (items[0]) void updatePreview()

      const moveSelection = (delta: number) => {
        if (items.length === 0) return
        const selected = selectList.getSelectedItem()
        const currentIndex = selected ? items.findIndex(i => i.value === selected.value) : 0
        const normalizedIndex = currentIndex >= 0 ? currentIndex : 0
        const nextIndex = (normalizedIndex + delta + items.length) % items.length
        selectList.setSelectedIndex(nextIndex)
        refreshDisplay()
        void updatePreview().finally(() => {
          container.invalidate()
          tui.requestRender()
        })
      }

      const withSelectedTask = (run: (task: Task) => void): void => {
        const task = getSelectedTask()
        if (!task) return
        run(task)
      }

      const rebuildAndRender = () => {
        items = getItems()
        const prevSelected = selectList.getSelectedItem()

        selectList = new SelectListWithColumns(items, Math.min(items.length, 10), selectListTheme, TASK_LIST_ROW_LAYOUT)

        selectList.onSelectionChange = () => {
          const selected = selectList.getSelectedItem()
          if (selected) rememberedSelectedRef = selected.value
          refreshDisplay()
          void updatePreview().finally(() => tui.requestRender())
        }
        selectList.onSelect = () => {
          const sel = selectList.getSelectedItem()
          if (sel) {
            selectedRef = sel.value
            rememberedSelectedRef = sel.value
          }
          done("select")
        }
        selectList.onCancel = () => {
          if (filterTerm) {
            filterTerm = ""
            rebuildAndRender()
          } else {
            done("cancel")
          }
        }

        renderListArea()

        if (prevSelected) {
          const newIdx = items.findIndex(i => i.value === prevSelected.value)
          if (newIdx >= 0) selectList.setSelectedIndex(newIdx)
        }

        refreshDisplay()
        void updatePreview().finally(() => {
          container.invalidate()
          tui.requestRender()
        })
      }

      const scrollPreview = (_task: Task, delta: number) => {
        const allWrapped: string[] = []
        for (const line of currentPreviewLines) {
          const wrapped = wrapText(line, lastWidth, 100)
          allWrapped.push(...wrapped)
        }

        const maxScroll = Math.max(0, allWrapped.length - PREVIEW_BODY_LINES)
        if (delta > 0 && previewScroll < maxScroll) {
          previewScroll++
        } else if (delta < 0 && previewScroll > 0) {
          previewScroll--
        }

        renderVisiblePreview()
        container.invalidate()
        tui.requestRender()
      }

      return {
        render: (w: number) => {
          if (lastWidth !== w) {
            lastWidth = w
            renderVisiblePreview()
          }
          return container.render(w).map((l: string) => truncateToWidth(l, w))
        },
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          const selectedTask = getSelectedTask()
          const intent = resolveListIntent(data, {
            searching,
            filtered: !!filterTerm,
            allowSearch,
            allowPriority,
            closeKey: config.closeKey,
            priorities: config.priorities,
            priorityHotkeys: config.priorityHotkeys,
            hasSelectedTaskSources: !!selectedTask && taskHasSources(selectedTask) && !!config.loadSourcePreview,
            canOpenSelectedTaskSource: !!selectedTask && taskHasSources(selectedTask) && !!config.onOpenSource,
          })

          switch (intent.type) {
            case "cancel":
              done("cancel")
              return

            case "searchStart":
              searching = true
              searchBuffer = ""
              refreshDisplay()
              container.invalidate()
              tui.requestRender()
              return

            case "searchCancel":
              searching = false
              searchBuffer = ""
              refreshDisplay()
              container.invalidate()
              tui.requestRender()
              return

            case "searchApply":
              filterTerm = searchBuffer.trim()
              searching = false
              rebuildAndRender()
              refreshDisplay()
              return

            case "searchBackspace":
              searchBuffer = searchBuffer.slice(0, -1)
              refreshDisplay()
              container.invalidate()
              tui.requestRender()
              return

            case "searchAppend":
              searchBuffer += intent.value
              refreshDisplay()
              container.invalidate()
              tui.requestRender()
              return

            case "moveSelection":
              moveSelection(intent.delta)
              return

            case "work":
              withSelectedTask((task) => {
                done("cancel")
                void config.onWork(task)
              })
              return

            case "edit":
              withSelectedTask((task) => {
                selectedRef = task.ref
                done("select")
              })
              return

            case "toggleStatus":
              withSelectedTask((task) => {
                const newStatus = config.cycleStatus(task.status)
                task.status = newStatus
                void config.onUpdateTask(task.ref, { status: newStatus })
                rebuildAndRender()
              })
              return

            case "setPriority":
              withSelectedTask((task) => {
                if (task.priority === intent.priority) return
                task.priority = intent.priority
                void config.onUpdateTask(task.ref, { priority: intent.priority })
                rebuildAndRender()
              })
              return

            case "scrollDescription":
              withSelectedTask((task) => scrollPreview(task, intent.delta))
              return

            case "cycleSource":
              withSelectedTask((task) => {
                const sourceCount = task.sources?.length ?? 0
                if (sourceCount === 0) return
                const nextIndex = (getCurrentSourceIndex(task) + intent.delta + sourceCount) % sourceCount
                selectedSourceIndexByRef.set(task.ref, nextIndex)
                previewScroll = 0
                refreshDisplay()
                void updatePreview().finally(() => {
                  container.invalidate()
                  tui.requestRender()
                })
              })
              return

            case "openSource":
              withSelectedTask((task) => {
                if (!config.onOpenSource) return
                const sourceIndex = getCurrentSourceIndex(task)
                void Promise.resolve(config.onOpenSource(task, sourceIndex)).catch((error) => {
                  ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
                })
              })
              return

            case "toggleType":
              withSelectedTask((task) => {
                const newType = config.cycleTaskType(task.taskType)
                task.taskType = newType
                void config.onUpdateTask(task.ref, { taskType: newType })
                rebuildAndRender()
              })
              return

            case "create":
              done("create")
              return

            case "insert":
              withSelectedTask((task) => {
                done("cancel")
                void config.onInsert(task)
              })
              return

            case "delegate":
              selectList.handleInput(data)
              tui.requestRender()
              return
          }
        },
      }
    })

    if (result === "cancel") return

    if (result === "create") {
      const createdTask = await config.onCreate()
      if (createdTask) {
        displayTasks.unshift(createdTask)
        rememberedSelectedRef = createdTask.ref
      }
      continue
    }

    if (result === "select" && selectedRef) {
      rememberedSelectedRef = selectedRef
      const currentTask = displayTasks.find(i => i.ref === selectedRef)
      const editResult = await config.onEdit(selectedRef, currentTask)
      if (editResult.updatedTask) {
        const idx = displayTasks.findIndex(i => i.ref === selectedRef)
        if (idx !== -1) displayTasks[idx] = editResult.updatedTask
      }
      if (editResult.closeList) return
    }
  }
}
