// End-to-end tests for the commit list printed before a diff.
// Uses a real git repository and real CLI invocations, because the whole point of
// the feature is that the printed range matches the diff git actually produced.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import child_process from "child_process"
import fs from "fs"
import path from "path"
import stripAnsi from "strip-ansi"

const TEMP_ROOT = path.join(import.meta.dir, ".test-commit-list-e2e-tmp")
const CLI_PATH = path.join(import.meta.dir, "cli.tsx")

function runGit(cwd: string, args: string[]): string {
  return child_process.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  })
}

function runCritique(cwd: string, args: string[]): string {
  const output = child_process.execFileSync("bun", [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  })
  return stripAnsi(output).replace(/\r/g, "")
}

/**
 * Repo shaped like the bug report: a base commit, then a commit that a rebase
 * replayed from a sibling branch, then the author's own commits.
 */
function createFixtureRepo(testName: string): { repoPath: string; baseSha: string; replayedSha: string } {
  const slug = testName.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  const repoPath = fs.mkdtempSync(path.join(TEMP_ROOT, `${slug}-`))

  runGit(repoPath, ["init"])
  runGit(repoPath, ["config", "user.name", "Critique Tests"])
  runGit(repoPath, ["config", "user.email", "tests@critique.local"])

  const write = (name: string, content: string) => {
    fs.writeFileSync(path.join(repoPath, name), content)
    runGit(repoPath, ["add", "."])
  }

  write("style.ts", "export const style = 1\n")
  runGit(repoPath, ["commit", "-m", "Reclaim the style table when the tree shrinks"])
  const baseSha = runGit(repoPath, ["rev-parse", "--short", "HEAD"]).trim()

  write("window.ts", "export const focus = false\n")
  runGit(repoPath, ["commit", "-m", "Launch a window without stealing focus"])
  const replayedSha = runGit(repoPath, ["rev-parse", "--short", "HEAD"]).trim()

  write("identity.ts", "export const identity = 'gpui'\n")
  runGit(repoPath, ["commit", "-m", "Give every element a stable GPUI identity"])

  write("events.ts", "export const events = true\n")
  runGit(repoPath, ["commit", "-m", "Fire the events img, svg and anchored already declare"])

  return { repoPath, baseSha, replayedSha }
}

describe("e2e: commit list", () => {
  beforeAll(() => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true })
  })

  afterAll(() => {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true })
  })

  test("merge base includes a replayed commit the author did not write", () => {
    const { repoPath, baseSha } = createFixtureRepo("merge-base")
    const output = runCritique(repoPath, [baseSha, "--scrollback"])

    expect(output).toContain("3 commits")
    expect(output).toContain("Launch a window without stealing focus")
    expect(output).toContain("Give every element a stable GPUI identity")
    expect(output).toContain("Fire the events img, svg and anchored already declare")
    // The base itself is shown separately, so it is never mistaken for included work
    expect(output).toContain(`base: ${baseSha}`)
    expect(output).toContain("Reclaim the style table when the tree shrinks")
  }, 120000)

  test("passing the first own commit as base excludes the replayed commit", () => {
    const { repoPath, replayedSha } = createFixtureRepo("own-base")
    const output = runCritique(repoPath, [replayedSha, "--scrollback"])

    expect(output).toContain("2 commits")
    expect(output).toContain("Give every element a stable GPUI identity")
    // The replayed commit is now the base, so it is not a listed commit and its
    // file no longer appears in the diff
    expect(output).toContain(`base: ${replayedSha}`)
    expect(output).not.toMatch(/^ {2}[0-9a-f]{7} {2}Launch a window/m)
    expect(output).not.toContain("window.ts")
  }, 120000)

  test("--commit lists only that commit", () => {
    const { repoPath } = createFixtureRepo("single-commit")
    const output = runCritique(repoPath, ["--commit", "HEAD", "--scrollback"])

    expect(output).toContain("1 commit,")
    expect(output).toContain("Fire the events img, svg and anchored already declare")
    expect(output).not.toContain("Give every element a stable GPUI identity")
    expect(output).not.toContain("base:")
  }, 120000)

  test("two refs list the commits between them", () => {
    const { repoPath, baseSha } = createFixtureRepo("two-refs")
    const output = runCritique(repoPath, [baseSha, "HEAD", "--scrollback"])

    expect(output).toContain("3 commits")
    expect(output).toContain(`base: ${baseSha}`)
  }, 120000)

  test("--no-commit-list silences the summary", () => {
    const { repoPath, baseSha } = createFixtureRepo("silenced")
    const output = runCritique(repoPath, [baseSha, "--no-commit-list", "--scrollback"])

    expect(output).not.toContain("commits,")
    expect(output).not.toContain("base:")
    // The diff itself still renders
    expect(output).toContain("identity.ts")
  }, 120000)

  test("uncommitted work is flagged, because a single base ref diffs the working tree", () => {
    const { repoPath, baseSha } = createFixtureRepo("dirty-tree")
    fs.writeFileSync(path.join(repoPath, "style.ts"), "export const style = 2\n")

    const output = runCritique(repoPath, [baseSha, "--scrollback"])
    expect(output).toContain("+ uncommitted working tree changes")
  }, 120000)

  test("truncation keeps the oldest commits, where a replayed commit sits", () => {
    const { repoPath, baseSha } = createFixtureRepo("truncation")
    // Push the replayed commit far past the truncation cut with 25 later commits
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(repoPath, `later-${i}.ts`), `export const later${i} = ${i}\n`)
      runGit(repoPath, ["add", "."])
      runGit(repoPath, ["commit", "-m", `Later change ${i}`])
    }

    const output = runCritique(repoPath, [baseSha, "--scrollback"])

    expect(output).toContain("28 commits")
    expect(output).toContain("more commits")
    // The whole point: the replayed commit is oldest, so it must survive truncation
    expect(output).toContain("Launch a window without stealing focus")
    // Newest commits are kept too
    expect(output).toContain("Later change 24")
  }, 120000)

  test("untracked files do not claim uncommitted work, because git diff excludes them", () => {
    const { repoPath, baseSha } = createFixtureRepo("untracked")
    fs.writeFileSync(path.join(repoPath, "never-added.ts"), "export const nope = true\n")

    const output = runCritique(repoPath, [baseSha, "--scrollback"])
    expect(output).not.toContain("uncommitted working tree changes")
    expect(output).not.toContain("never-added.ts")
  }, 120000)

  test("three-dot shows the merge base, not the named ref", () => {
    const { repoPath } = createFixtureRepo("merge-base-line")
    // Diverge: main gets a commit that HEAD does not have
    runGit(repoPath, ["checkout", "-q", "-b", "sibling"])
    fs.writeFileSync(path.join(repoPath, "sibling.ts"), "export const sibling = true\n")
    runGit(repoPath, ["add", "."])
    runGit(repoPath, ["commit", "-m", "Only on the sibling branch"])
    const mergeBase = runGit(repoPath, ["rev-parse", "--short", "HEAD~1"]).trim()

    const output = runCritique(repoPath, ["HEAD~1...HEAD", "--scrollback"])
    // A three-dot diff starts at the merge base, so naming the ref would point at a
    // commit whose changes are not in the diff
    expect(output).toContain(`base: ${mergeBase}`)
  }, 120000)

  test("a diverged tree comparison lists the commits it reverses", () => {
    const { repoPath } = createFixtureRepo("diverged")
    // Build two branches that diverged from the same commit
    runGit(repoPath, ["checkout", "-q", "-b", "left", "HEAD~2"])
    fs.writeFileSync(path.join(repoPath, "left.ts"), "export const left = true\n")
    runGit(repoPath, ["add", "."])
    runGit(repoPath, ["commit", "-m", "Only on left"])

    runGit(repoPath, ["checkout", "-q", "-b", "right", "HEAD~1"])
    fs.writeFileSync(path.join(repoPath, "right.ts"), "export const right = true\n")
    runGit(repoPath, ["add", "."])
    runGit(repoPath, ["commit", "-m", "Only on right"])

    // `git diff left..right` is a tree comparison, so it also undoes "Only on left"
    const output = runCritique(repoPath, ["left..right", "--scrollback"])

    expect(output).toContain("1 commit added, 1 commit reversed")
    expect(output).toContain("added by right:")
    expect(output).toContain("Only on right")
    expect(output).toContain("reversed from left:")
    expect(output).toContain("Only on left")
    expect(output).toContain("have diverged")
    // The reversal is real: the diff deletes the file that commit added
    expect(output).toContain("left.ts")
  }, 120000)

  test("three-dot on the same diverged branches reverses nothing", () => {
    const { repoPath } = createFixtureRepo("diverged-three-dot")
    runGit(repoPath, ["checkout", "-q", "-b", "left", "HEAD~2"])
    fs.writeFileSync(path.join(repoPath, "left.ts"), "export const left = true\n")
    runGit(repoPath, ["add", "."])
    runGit(repoPath, ["commit", "-m", "Only on left"])

    runGit(repoPath, ["checkout", "-q", "-b", "right", "HEAD~1"])
    fs.writeFileSync(path.join(repoPath, "right.ts"), "export const right = true\n")
    runGit(repoPath, ["add", "."])
    runGit(repoPath, ["commit", "-m", "Only on right"])

    const output = runCritique(repoPath, ["left...right", "--scrollback"])

    expect(output).toContain("1 commit,")
    expect(output).not.toContain("reversed")
    expect(output).not.toContain("left.ts")
  }, 120000)

  test("working tree and staged diffs print no commit list", () => {
    const { repoPath } = createFixtureRepo("no-range")
    fs.writeFileSync(path.join(repoPath, "style.ts"), "export const style = 3\n")

    const unstaged = runCritique(repoPath, ["--scrollback"])
    expect(unstaged).not.toContain("commits,")
    expect(unstaged).toContain("style.ts")

    runGit(repoPath, ["add", "."])
    const staged = runCritique(repoPath, ["--staged", "--scrollback"])
    expect(staged).not.toContain("commits,")
    expect(staged).toContain("style.ts")
  }, 120000)
})
