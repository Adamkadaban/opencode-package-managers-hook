import type { Plugin, PluginModule } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-ecosystem action when a banned command is detected. */
type Mode = "rewrite" | "block" | "off"

export interface PythonOptions {
  /** What to do when pip/pip3/python -m pip is used. Default: "rewrite". */
  mode?: Mode
  /** Rewrite `pip install <pkg>` to this.  Default: "uv pip install". */
  install?: string
  /** Rewrite `pip install --user <pkg>` / `pipx install <pkg>` global installs.  Default: "pipx install". */
  globalInstall?: string
  /** Rewrite `python -m venv` / `virtualenv`.  Default: "uv venv". */
  venv?: string
  /** Rewrite bare `python <script>`.  Default: "uv run python". */
  run?: string
  /** Strip --break-system-packages from any surviving pip command.  Default: true. */
  stripBreakSystemPackages?: boolean
  /** Rewrite `poetry install` / `poetry add` etc.  Default: "off" (leave poetry alone). */
  poetryMode?: Mode
}

export interface NodeOptions {
  /** What to do when npm/npx is used.  Default: "rewrite". */
  mode?: Mode
  /** Rewrite npm subcommands to this tool.  Default: "pnpm". */
  target?: string
  /** Rewrite npx to this.  Default: "pnpm dlx". */
  exec?: string
  /** Rewrite yarn to target too.  Default: true. */
  rewriteYarn?: boolean
}

export interface RubyOptions {
  /** What to do when bare `gem install` is used.  Default: "block". */
  mode?: Mode
  /** Prepend `rbenv exec` to gem/bundle commands.  Default: true. */
  rbenvExec?: boolean
}

export interface Options {
  python?: PythonOptions | false
  node?: NodeOptions | false
  ruby?: RubyOptions | false
  /** Log rewrites to stderr so you can see what changed.  Default: false. */
  verbose?: boolean
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PYTHON: Required<PythonOptions> = {
  mode: "rewrite",
  install: "uv pip install",
  globalInstall: "pipx install",
  venv: "uv venv",
  run: "uv run python",
  stripBreakSystemPackages: true,
  poetryMode: "off",
}

const DEFAULT_NODE: Required<NodeOptions> = {
  mode: "rewrite",
  target: "pnpm",
  exec: "pnpm dlx",
  rewriteYarn: true,
}

const DEFAULT_RUBY: Required<RubyOptions> = {
  mode: "block",
  rbenvExec: true,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether a command is available via `command -v`. */
async function has($: Parameters<Plugin>[0]["$"], cmd: string): Promise<boolean> {
  const out = await $`command -v ${cmd}`.quiet().nothrow().text()
  return out.trim().length > 0
}

/** First token of the (trimmed) command string. */
function firstToken(cmd: string): string {
  return cmd.split(/\s+/)[0]
}

// ---------------------------------------------------------------------------
// Rewriters
// ---------------------------------------------------------------------------

type Rewriter = (cmd: string) => { rewritten: string; blocked?: string } | null

function buildPythonRewriter(opts: Required<PythonOptions>): Rewriter | null {
  if (opts.mode === "off") return null

  return (cmd) => {
    let out = cmd

    // --- strip --break-system-packages everywhere --------------------------
    if (opts.stripBreakSystemPackages) {
      out = out.replace(/\s*--break-system-packages\b/g, "")
    }

    // --- python -m pip ... -------------------------------------------------
    if (/\b(python\d*|py)\s+-m\s+pip\b/i.test(out)) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: "pip (via python -m pip) is blocked. Use `uv pip` or `uv add` instead." }
      }
      // Detect global installs
      if (/\binstall\b/.test(out) && /\s--user\b/.test(out)) {
        out = out.replace(/\b(python\d*|py)\s+-m\s+pip\s+install\s+--user\b/i, opts.globalInstall)
      } else if (/\binstall\b/.test(out)) {
        out = out.replace(/\b(python\d*|py)\s+-m\s+pip\s+install\b/i, opts.install)
      } else {
        out = out.replace(/\b(python\d*|py)\s+-m\s+pip\b/i, "uv pip")
      }
      if (out !== cmd) return { rewritten: out }
    }

    // --- pip / pip3 --------------------------------------------------------
    const pipMatch = out.match(/^(pip\d*)(\s|$)/i)
    if (pipMatch) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: `${pipMatch[1]} is blocked. Use \`uv pip\`, \`uv add\`, or \`pipx install\` instead.` }
      }
      if (/\binstall\b/.test(out) && /\s--user\b/.test(out)) {
        out = out.replace(/^pip\d*\s+install\s+--user\b/i, opts.globalInstall)
      } else if (/\binstall\b/.test(out)) {
        out = out.replace(/^pip\d*\s+install\b/i, opts.install)
      } else {
        out = out.replace(/^pip\d*/i, "uv pip")
      }
      if (out !== cmd) return { rewritten: out }
    }

    // --- pipx (rewrite to globalInstall target if it differs) --------------
    if (/^pipx\s+install\b/i.test(out) && opts.globalInstall !== "pipx install") {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: "pipx is blocked. Use `uv tool install` instead." }
      }
      out = out.replace(/^pipx\s+install\b/i, opts.globalInstall)
      if (out !== cmd) return { rewritten: out }
    }

    // --- python -m venv / virtualenv ---------------------------------------
    if (/\b(python\d*|py)\s+-m\s+venv\b/i.test(out)) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: "python -m venv is blocked. Use `uv venv` instead." }
      }
      out = out.replace(/\b(python\d*|py)\s+-m\s+venv\b/i, opts.venv)
      if (out !== cmd) return { rewritten: out }
    }
    if (/^virtualenv\b/i.test(out)) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: "virtualenv is blocked. Use `uv venv` instead." }
      }
      out = out.replace(/^virtualenv\b/i, opts.venv)
      if (out !== cmd) return { rewritten: out }
    }

    // --- bare python <script> (not python -m, not python -c) ---------------
    if (/^(python\d*|py)\s+(?!-m\s|-c\s)/i.test(out)) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: "Bare python is blocked. Use `uv run python` instead." }
      }
      out = out.replace(/^(python\d*|py)\b/i, opts.run)
      if (out !== cmd) return { rewritten: out }
    }

    // --- poetry ------------------------------------------------------------
    if (opts.poetryMode !== "off" && /^poetry\b/i.test(out)) {
      if (opts.poetryMode === "block") {
        return { rewritten: cmd, blocked: "poetry is blocked. Use `uv add` / `uv sync` instead." }
      }
      // rewrite common poetry subcommands to uv equivalents
      out = out.replace(/^poetry\s+install\b/i, "uv sync")
      out = out.replace(/^poetry\s+add\b/i, "uv add")
      out = out.replace(/^poetry\s+remove\b/i, "uv remove")
      out = out.replace(/^poetry\s+run\b/i, "uv run")
      out = out.replace(/^poetry\s+lock\b/i, "uv lock")
      if (out !== cmd) return { rewritten: out }
    }

    // Nothing matched
    if (out !== cmd) return { rewritten: out }
    return null
  }
}

function buildNodeRewriter(opts: Required<NodeOptions>): Rewriter | null {
  if (opts.mode === "off") return null

  const target = opts.target // e.g. "pnpm"
  const exec = opts.exec     // e.g. "pnpm dlx"

  return (cmd) => {
    const first = firstToken(cmd)
    let out = cmd

    // npx -> pnpm dlx
    if (/^npx$/i.test(first)) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: `npx is blocked. Use \`${exec}\` instead.` }
      }
      out = out.replace(/^npx\b/i, exec)
      if (out !== cmd) return { rewritten: out }
    }

    // npm <subcommand>
    if (/^npm$/i.test(first)) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: `npm is blocked. Use \`${target}\` instead.` }
      }
      out = out.replace(/^npm\b/i, target)
      if (out !== cmd) return { rewritten: out }
    }

    // yarn
    if (opts.rewriteYarn && /^yarn$/i.test(first)) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: `yarn is blocked. Use \`${target}\` instead.` }
      }
      out = out.replace(/^yarn\b/i, target)
      if (out !== cmd) return { rewritten: out }
    }

    return null
  }
}

function buildRubyRewriter(opts: Required<RubyOptions>): Rewriter | null {
  if (opts.mode === "off") return null

  return (cmd) => {
    const first = firstToken(cmd)

    // gem install outside of rbenv/bundle context
    if (/^gem$/i.test(first)) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: "Bare `gem` is blocked. Use `bundle add` or `rbenv exec gem install` instead." }
      }
      if (opts.rbenvExec && !/^rbenv\s+exec\b/.test(cmd)) {
        return { rewritten: `rbenv exec ${cmd}` }
      }
    }

    // bundle without rbenv exec
    if (/^bundle$/i.test(first) && opts.rbenvExec && !/^rbenv\s+exec\b/.test(cmd)) {
      if (opts.mode === "block") {
        return { rewritten: cmd, blocked: "Bare `bundle` is blocked. Use `rbenv exec bundle` instead." }
      }
      return { rewritten: `rbenv exec ${cmd}` }
    }

    return null
  }
}

// ---------------------------------------------------------------------------
// Commands already using preferred tools — skip entirely
// ---------------------------------------------------------------------------

const SKIP_PREFIXES = [
  /^uv\b/i,
  /^pipx\b/i, // pipx pass-through when globalInstall === "pipx install"
  /^pnpm\b/i,
  /^bun\b/i,
  /^bunx\b/i,
  /^rbenv\b/i,
]

function shouldSkip(cmd: string): boolean {
  const trimmed = cmd.trim()
  return SKIP_PREFIXES.some((re) => re.test(trimmed))
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const PackageManagersHook: Plugin = async ({ $ }, userOpts) => {
  const opts = (userOpts ?? {}) as Options

  // Resolve per-ecosystem options (false = disabled)
  const pyOpts =
    opts.python === false ? null : { ...DEFAULT_PYTHON, ...(opts.python ?? {}) }
  const nodeOpts =
    opts.node === false ? null : { ...DEFAULT_NODE, ...(opts.node ?? {}) }
  const rubyOpts =
    opts.ruby === false ? null : { ...DEFAULT_RUBY, ...(opts.ruby ?? {}) }
  const verbose = opts.verbose ?? false

  // Probe which preferred tools exist on the system
  const [hasUv, hasPipx, hasPnpm, hasRbenv] = await Promise.all([
    has($, "uv"),
    has($, "pipx"),
    has($, "pnpm"),
    has($, "rbenv"),
  ])

  // Build rewriter chain — only include ecosystems whose tools are present
  const rewriters: Rewriter[] = []

  if (pyOpts && (hasUv || hasPipx)) {
    const rw = buildPythonRewriter(pyOpts)
    if (rw) rewriters.push(rw)
  }
  if (nodeOpts && hasPnpm) {
    const rw = buildNodeRewriter(nodeOpts)
    if (rw) rewriters.push(rw)
  }
  if (rubyOpts && hasRbenv) {
    const rw = buildRubyRewriter(rubyOpts)
    if (rw) rewriters.push(rw)
  }

  if (rewriters.length === 0) {
    // Nothing to do — none of the preferred tools were found.
    return {}
  }

  return {
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool ?? "").toLowerCase()
      if (tool !== "bash" && tool !== "shell") return

      const args = output?.args as Record<string, unknown> | undefined
      if (!args) return

      const command = args.command
      if (typeof command !== "string" || !command.trim()) return

      const trimmed = command.trim()
      if (shouldSkip(trimmed)) return

      for (const rw of rewriters) {
        const result = rw(trimmed)
        if (!result) continue

        if (result.blocked) {
          throw new Error(result.blocked)
        }

        if (result.rewritten !== trimmed) {
          if (verbose) {
            console.error(`[package-managers-hook] ${trimmed}  ->  ${result.rewritten}`)
          }
          args.command = result.rewritten
          return
        }
      }
    },
  }
}

// Default export for auto-discovery
const plugin: PluginModule & { id: string } = {
  id: "opencode-package-managers-hook",
  server: PackageManagersHook,
}

export default plugin
