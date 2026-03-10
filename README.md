# @soleone/pi-tasks

Task management extension for the [pi coding agent](https://github.com/badlogic/pi-mono), designed for pluggable task backends.

<img width="2373" height="1305" alt="image" src="https://github.com/user-attachments/assets/af210b63-f993-447d-9668-3308874d493c" />

## Quick start

1. Installation: `pi install npm:@soleone/pi-tasks`
2. Toggle the Tasks UI with `ctrl + x`, or use `/tasks`.

## Usage

- Navigate up with `w` and `s` (arrows also work)
- `space` to change status
- `0` to `4` to change priority
- `t` to change task type
- `f` for keyword search (title, description)
- `q` or `Esc` to go back

### List view

- `e` to edit a task
- `Enter` to work off a task
- `Tab` to insert task details in prompt and close Tasks UI
- `[` / `]` to cycle task sources when available
- `o` to open the selected source in a tmux popup
- `c` to create a new task

When a backend provides task sources (for example `sq` file/text/diff sources), the preview pane shows the selected source, `Enter` / `Tab` include those sources in the generated context, and `o` opens the currently selected source in a tmux popup.

### Edit view

- `Tab` to switch focus between inputs
- `Enter` to save

## Backend selection

By default, the extension auto-detects the first applicable backend. If none are applicable, it falls back to `todo-md`.

Set `PI_TASKS_BACKEND` to explicitly choose a backend implementation.
Currently supported values:

- `beads`
- `sq`
- `todo-md`

### Sift Queue (`sq`) backend

The `sq` backend integrates with [sift-queue](https://crates.io/crates/sift-queue) and reads/writes queue items through the `sq` CLI.

When queue items include `sq` sources, Tasks can preview them in the list view, include them automatically in Work / Tab-insert actions, and open the selected source in a tmux popup.

You can override the default queue file path with:

- `PI_TASKS_SQ_QUEUE_PATH` — path to a specific queue JSONL file (passed to `sq --queue`)

Optional source viewer env vars for tmux popups:

- `PI_TASKS_SOURCE_VIEWER` — default shell command template used to open file-like sources
- `PI_TASKS_SOURCE_VIEWER_<EXT>` — extension-specific override, for example `PI_TASKS_SOURCE_VIEWER_MD='glow -p {path}'`
- `PI_TASKS_SOURCE_VIEWER_TEXT` / `PI_TASKS_SOURCE_VIEWER_DIFF` / `PI_TASKS_SOURCE_VIEWER_DIRECTORY` — source-type overrides

Templates receive shell-quoted placeholders: `{path}`, `{title}`, `{type}`, `{ext}`.

### TODO.md backend

The `todo-md` backend reads/writes a markdown task file (default: `TODO.md`; if `todo.md` already exists, it is used).

Optional env var:

- `PI_TASKS_TODO_PATH` — override the TODO file path
