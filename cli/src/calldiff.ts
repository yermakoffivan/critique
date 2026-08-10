// Call-stack diff integration for the experimental --calldiff option.
// Translates critique's Git comparisons and groups calldiff entry trees by displayed file.

import child_process from "child_process"
import type { DiffTreeResult } from "@xmorse/calldiff"

export interface CallDiffTree {
  entry: string
  ascii: string
}

export type CallDiffByFile = Record<string, CallDiffTree[]>

export interface CallDiffFile {
  path: string
  oldPath?: string
}

export interface CreateCallDiffOptions {
  cwd?: string
  base?: string
  head?: string
  commit?: string
  files: CallDiffFile[]
}

function runGit(cwd: string, args: string[]): string {
  return child_process.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function getMergeBase(options: { cwd: string; base: string; head: string }): string {
  return runGit(options.cwd, ["merge-base", options.base, options.head])
}

function getCommitParent(cwd: string, commit: string): string {
  const revision = runGit(cwd, ["rev-list", "--parents", "-n", "1", commit])
  const [, parent] = revision.split(/\s+/)
  if (!parent) {
    throw new Error(`Cannot generate a call-stack diff for root commit ${commit}`)
  }
  return parent
}

function resolveCallDiffRefs(
  options: CreateCallDiffOptions,
  cwd: string,
): { from?: string; to?: string } {
  if (options.commit) {
    return {
      from: getCommitParent(cwd, options.commit),
      to: options.commit,
    }
  }

  if (options.base && options.head) {
    return {
      from: getMergeBase({ cwd, base: options.base, head: options.head }),
      to: options.head,
    }
  }

  if (options.base) {
    const threeDot = options.base.match(/^(.+)\.\.\.(.+)$/)
    if (threeDot) {
      const [, base, head] = threeDot
      return {
        from: getMergeBase({ cwd, base: base!, head: head! }),
        to: head,
      }
    }

    const twoDot = options.base.match(/^(.+)\.\.(.+)$/)
    if (twoDot) {
      return {
        from: twoDot[1],
        to: twoDot[2],
      }
    }

    return { from: options.base }
  }

  return {}
}

function normalizePath(filePath: string): string {
  return filePath.replace(/^\.\//, "")
}

function groupTreesByFile(
  trees: DiffTreeResult[],
  files: CallDiffFile[],
): CallDiffByFile {
  const displayedPathBySourcePath = new Map<string, string>()
  for (const file of files) {
    const displayedPath = normalizePath(file.path)
    displayedPathBySourcePath.set(displayedPath, displayedPath)
    if (file.oldPath) {
      displayedPathBySourcePath.set(normalizePath(file.oldPath), displayedPath)
    }
  }

  const callDiffByFile: CallDiffByFile = {}
  for (const result of trees) {
    if (!result.tree.file) continue
    const displayedPath = displayedPathBySourcePath.get(normalizePath(result.tree.file))
    if (!displayedPath) continue
    const fileTrees = callDiffByFile[displayedPath] ?? []
    fileTrees.push({ entry: result.entry, ascii: result.ascii })
    callDiffByFile[displayedPath] = fileTrees
  }
  return callDiffByFile
}

export async function createCallDiff(
  options: CreateCallDiffOptions,
): Promise<CallDiffByFile> {
  if (options.files.length === 0) return {}

  const cwd = options.cwd ?? process.cwd()
  const refs = resolveCallDiffRefs(options, cwd)
  const paths = [
    ...new Set(options.files.flatMap((file) =>
      file.oldPath ? [file.path, file.oldPath] : [file.path],
    )),
  ]
  const { runDiff } = await import("@xmorse/calldiff")
  const result = runDiff({
    cwd,
    ...refs,
    paths,
    maxDepth: 6,
    color: false,
    locs: false,
  })

  return groupTreesByFile(result.trees, options.files)
}
