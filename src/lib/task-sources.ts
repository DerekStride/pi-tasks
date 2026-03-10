import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, extname, join, resolve } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { Task, TaskSource } from "../models/task.ts"

const MAX_PREVIEW_CHARS = 8_000
const MAX_PREVIEW_LINES = 120
const MAX_CONTEXT_CHARS = 20_000
const MAX_CONTEXT_LINES = 300
const MAX_DIRECTORY_ENTRIES = 40
const SOURCE_VIEWER_ENV = "PI_TASKS_SOURCE_VIEWER"

export interface TaskSourcePreview {
  title: string
  content: string
}

interface LoadedTaskSource {
  title: string
  content: string
}

interface MaterializedTaskSource {
  title: string
  type: TaskSource["type"]
  path: string
  extension: string
  isDirectory: boolean
}

function normalizeWhitespace(value: string | undefined): string {
  return (value ?? "").trim()
}

function truncateContent(content: string, maxChars: number, maxLines: number): string {
  const normalized = content.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")

  let truncatedLines = lines
  let lineNotice = ""
  if (lines.length > maxLines) {
    truncatedLines = lines.slice(0, maxLines)
    lineNotice = `\n… truncated ${lines.length - maxLines} more lines`
  }

  let truncated = truncatedLines.join("\n")
  if (truncated.length > maxChars) {
    truncated = truncated.slice(0, maxChars)
    return `${truncated}\n… truncated ${normalized.length - maxChars} more characters`
  }

  return `${truncated}${lineNotice}`.trimEnd()
}

function summarizeDirectoryEntries(entries: string[]): string {
  if (entries.length === 0) return "(empty directory)"

  const visibleEntries = entries.slice(0, MAX_DIRECTORY_ENTRIES)
  const lines = visibleEntries.map(entry => `- ${entry}`)

  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    lines.push(`- … ${entries.length - MAX_DIRECTORY_ENTRIES} more entries`)
  }

  return lines.join("\n")
}

function buildSourceLabel(source: TaskSource, index: number): string {
  const type = source.type
  if (source.path) return `${index + 1}. ${type}: ${source.path}`
  if (type === "text") return `${index + 1}. text`
  return `${index + 1}. ${type}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function sanitizeEnvSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()
}

function viewerEnvKeyForExtension(extension: string): string | undefined {
  const normalized = extension.replace(/^\./, "")
  if (!normalized) return undefined

  const suffix = sanitizeEnvSuffix(normalized)
  return suffix.length > 0 ? `${SOURCE_VIEWER_ENV}_${suffix}` : undefined
}

function viewerEnvKeyForType(type: TaskSource["type"]): string {
  return `${SOURCE_VIEWER_ENV}_${sanitizeEnvSuffix(type)}`
}

function substituteViewerTemplate(template: string, materialized: MaterializedTaskSource): string {
  return template
    .replaceAll("{path}", shellQuote(materialized.path))
    .replaceAll("{title}", shellQuote(materialized.title))
    .replaceAll("{type}", shellQuote(materialized.type))
    .replaceAll("{ext}", shellQuote(materialized.extension.replace(/^\./, "")))
}

function defaultDirectoryViewer(path: string): string {
  const quotedPath = shellQuote(path)
  return `(
    if command -v eza >/dev/null 2>&1; then
      eza --color=always -la ${quotedPath}
    elif command -v tree >/dev/null 2>&1; then
      tree -C ${quotedPath}
    else
      ls -la ${quotedPath}
    fi
  ) | less -R`
}

function defaultFileViewer(path: string, extension: string): string {
  const quotedPath = shellQuote(path)
  const normalizedExtension = extension.toLowerCase()

  if (normalizedExtension === ".md" || normalizedExtension === ".markdown" || normalizedExtension === ".mdown") {
    return [
      `if command -v glow >/dev/null 2>&1; then glow -p ${quotedPath}`,
      `elif command -v bat >/dev/null 2>&1; then bat --paging=always --style=plain --color=always -- ${quotedPath}`,
      `else less -R -- ${quotedPath}`,
      "fi",
    ].join("; ")
  }

  if (normalizedExtension === ".diff" || normalizedExtension === ".patch") {
    return [
      `if command -v delta >/dev/null 2>&1; then delta --paging=always ${quotedPath}`,
      `elif command -v bat >/dev/null 2>&1; then bat --paging=always --style=plain --color=always -- ${quotedPath}`,
      `else less -R -- ${quotedPath}`,
      "fi",
    ].join("; ")
  }

  return [
    `if command -v bat >/dev/null 2>&1; then bat --paging=always --style=plain --color=always -- ${quotedPath}`,
    `else less -R -- ${quotedPath}`,
    "fi",
  ].join("; ")
}

async function loadSource(pi: ExtensionAPI, cwd: string, source: TaskSource, index: number): Promise<LoadedTaskSource> {
  if (source.type === "text") {
    return {
      title: buildSourceLabel(source, index),
      content: source.content?.trim() || "(empty text source)",
    }
  }

  if (source.type === "file") {
    if (!source.path) {
      return {
        title: buildSourceLabel(source, index),
        content: "(missing file path)",
      }
    }

    const absolutePath = resolve(cwd, source.path)
    const content = await readFile(absolutePath, "utf8")
    return {
      title: buildSourceLabel(source, index),
      content,
    }
  }

  if (source.type === "diff") {
    if (!source.path) {
      return {
        title: buildSourceLabel(source, index),
        content: "(missing diff path)",
      }
    }

    const result = await pi.exec("git", ["diff", "--no-ext-diff", "--", source.path], { timeout: 10_000 })
    const content = result.code === 0
      ? result.stdout.trim() || `(no diff for ${source.path})`
      : ((result.stderr || result.stdout).trim() || `git diff failed for ${source.path}`)

    return {
      title: buildSourceLabel(source, index),
      content,
    }
  }

  if (source.type === "directory") {
    if (!source.path) {
      return {
        title: buildSourceLabel(source, index),
        content: "(missing directory path)",
      }
    }

    const absolutePath = resolve(cwd, source.path)
    const entries = await readdir(absolutePath, { withFileTypes: true })
    const namedEntries = entries
      .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort((left, right) => left.localeCompare(right))

    return {
      title: buildSourceLabel(source, index),
      content: summarizeDirectoryEntries(namedEntries),
    }
  }

  if (source.path) {
    const absolutePath = resolve(cwd, source.path)
    const fileStat = await stat(absolutePath)
    if (fileStat.isFile()) {
      return {
        title: buildSourceLabel(source, index),
        content: await readFile(absolutePath, "utf8"),
      }
    }
  }

  return {
    title: buildSourceLabel(source, index),
    content: source.content?.trim() || "(unsupported source)",
  }
}

async function pathKind(path: string): Promise<"file" | "directory" | null> {
  try {
    const fileStat = await stat(path)
    if (fileStat.isDirectory()) return "directory"
    if (fileStat.isFile()) return "file"
    return null
  } catch {
    return null
  }
}

async function writeTemporarySourceFile(title: string, extension: string, content: string): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-tasks-source-"))
  const fileName = `${sanitizeEnvSuffix(title).toLowerCase() || "source"}${extension || ".txt"}`
  const filePath = join(tempDirectory, fileName)
  await writeFile(filePath, content, "utf8")
  return filePath
}

function materializedExtension(source: TaskSource): string {
  if (source.path) {
    const fromPath = extname(source.path)
    if (fromPath) return fromPath
  }

  if (source.type === "diff") return ".diff"
  if (source.type === "text") return ".txt"
  return ".txt"
}

export function taskHasSources(task: Pick<Task, "sources">): boolean {
  return (task.sources?.length ?? 0) > 0
}

export function createTaskSourceResolver(pi: ExtensionAPI, cwd: string) {
  const cache = new Map<string, Promise<LoadedTaskSource>>()

  const cacheKey = (task: Task, index: number, source: TaskSource): string => [
    task.ref,
    String(index),
    source.type,
    source.path ?? "",
    source.content ?? "",
  ].join("\u241F")

  async function getLoadedSource(task: Task, index: number): Promise<LoadedTaskSource> {
    const source = task.sources?.[index]
    if (!source) {
      return {
        title: `Source ${index + 1}`,
        content: "(source unavailable)",
      }
    }

    const key = cacheKey(task, index, source)
    let pending = cache.get(key)
    if (!pending) {
      pending = loadSource(pi, cwd, source, index).catch((error) => ({
        title: buildSourceLabel(source, index),
        content: error instanceof Error ? `(${error.message})` : "(failed to load source)",
      }))
      cache.set(key, pending)
    }

    return pending
  }

  async function materializeSource(task: Task, index: number): Promise<MaterializedTaskSource> {
    const source = task.sources?.[index]
    const loaded = await getLoadedSource(task, index)

    if (!source) {
      const temporaryPath = await writeTemporarySourceFile(loaded.title, ".txt", loaded.content)
      return {
        title: loaded.title,
        type: "unknown",
        path: temporaryPath,
        extension: ".txt",
        isDirectory: false,
      }
    }

    if (source.path) {
      const absolutePath = resolve(cwd, source.path)
      const kind = await pathKind(absolutePath)
      if (kind === "directory") {
        return {
          title: loaded.title,
          type: source.type,
          path: absolutePath,
          extension: "",
          isDirectory: true,
        }
      }

      if (kind === "file" && source.type !== "diff" && source.type !== "text") {
        return {
          title: loaded.title,
          type: source.type,
          path: absolutePath,
          extension: extname(absolutePath),
          isDirectory: false,
        }
      }
    }

    const extension = materializedExtension(source)
    const temporaryPath = await writeTemporarySourceFile(loaded.title, extension, loaded.content)
    return {
      title: loaded.title,
      type: source.type,
      path: temporaryPath,
      extension,
      isDirectory: false,
    }
  }

  function resolveViewerCommand(materialized: MaterializedTaskSource): string {
    const extensionEnvKey = materialized.extension ? viewerEnvKeyForExtension(materialized.extension) : undefined
    const template = (
      process.env[extensionEnvKey ?? ""]?.trim() ||
      process.env[viewerEnvKeyForType(materialized.type)]?.trim() ||
      process.env[SOURCE_VIEWER_ENV]?.trim()
    )

    if (template && template.length > 0) {
      return substituteViewerTemplate(template, materialized)
    }

    return materialized.isDirectory
      ? defaultDirectoryViewer(materialized.path)
      : defaultFileViewer(materialized.path, materialized.extension)
  }

  return {
    async getPreview(task: Task, index: number): Promise<TaskSourcePreview> {
      const loaded = await getLoadedSource(task, index)
      return {
        title: loaded.title,
        content: truncateContent(loaded.content, MAX_PREVIEW_CHARS, MAX_PREVIEW_LINES),
      }
    },

    async buildContext(task: Task): Promise<string | undefined> {
      if (!taskHasSources(task)) return undefined

      const description = normalizeWhitespace(task.description)
      const title = normalizeWhitespace(task.title)
      const blocks: string[] = []

      for (const [index, source] of (task.sources ?? []).entries()) {
        const loaded = await getLoadedSource(task, index)
        const normalizedContent = normalizeWhitespace(loaded.content)

        if (source.type === "text" && (normalizedContent === description || normalizedContent === title)) {
          continue
        }

        const content = truncateContent(loaded.content, MAX_CONTEXT_CHARS, MAX_CONTEXT_LINES)
        blocks.push([
          `--- ${loaded.title} ---`,
          content,
          `--- end ${basename(source.path ?? `source-${index + 1}`)} ---`,
        ].join("\n"))
      }

      return blocks.length > 0 ? blocks.join("\n\n") : undefined
    },

    async openInTmuxPopup(task: Task, index: number): Promise<void> {
      if (!process.env.TMUX) {
        throw new Error("Opening sources requires running inside tmux")
      }

      const materialized = await materializeSource(task, index)
      const viewerCommand = resolveViewerCommand(materialized)
      const popupCommand = `sh -lc ${shellQuote(viewerCommand)}`
      const args = ["display-popup"]

      if (process.env.TMUX_PANE) {
        args.push("-t", process.env.TMUX_PANE)
      }

      args.push("-E", popupCommand)

      const result = await pi.exec("tmux", args)

      if (result.code !== 0) {
        const details = (result.stderr || result.stdout || "").trim()
        throw new Error(details || `Failed to open tmux popup for ${materialized.title}`)
      }
    },
  }
}
