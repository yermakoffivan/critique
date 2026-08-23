// End-to-end tests for call-stack analysis against real Git repositories.
// Uses the published calldiff library and snapshots the per-file integration data.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import child_process from "child_process"
import fs from "fs"
import path from "path"
import dedent from "string-dedent"
import stripAnsi from "strip-ansi"
import { createCallDiff, type CallDiffByFile } from "./calldiff.js"

const TEMP_ROOT = path.join(import.meta.dir, ".test-calldiff-tmp")
const CLI_PATH = path.join(import.meta.dir, "cli.tsx")

function runGit(cwd: string, args: string[]): string {
  return child_process.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function writeSource(options: { repoPath: string; filePath: string; source: string }): void {
  const absolutePath = path.join(options.repoPath, options.filePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, options.source)
}

function createExampleRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(TEMP_ROOT, "example-"))
  runGit(repoPath, ["init"])
  runGit(repoPath, ["config", "user.name", "Critique Tests"])
  runGit(repoPath, ["config", "user.email", "tests@critique.local"])

  writeSource({ repoPath, filePath: "src/session.ts", source: dedent`

    import { createAuth, createCodingTools, getServices } from "./services"

    export function createAgentSession() {
      createAuth()
      createCodingTools()
    }

  ` })
  writeSource({ repoPath, filePath: "src/services.ts", source: dedent`

    export function createAuth() {}
    export function createCodingTools() {}
    function createSettings() {}

    export function getServices() {
      createAuth()
      createCodingTools()
    }

  ` })
  runGit(repoPath, ["add", "."])
  runGit(repoPath, ["commit", "-m", "initial call flow"])

  writeSource({ repoPath, filePath: "src/session.ts", source: dedent`

    import { getServices } from "./services"

    export function createAgentSession() {
      getServices()
    }

  ` })
  writeSource({ repoPath, filePath: "src/services.ts", source: dedent`

    export function createAuth() {}
    export function createCodingTools() {}
    function createSettings() {}

    export function getServices() {
      createAuth()
      createSettings()
      createCodingTools()
    }

  ` })

  return repoPath
}

function createDeepCallRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(TEMP_ROOT, "deep-"))
  runGit(repoPath, ["init"])
  runGit(repoPath, ["config", "user.name", "Critique Tests"])
  runGit(repoPath, ["config", "user.email", "tests@critique.local"])

  const helpers = Array.from({ length: 8 }, (_, index) => {
    const level = index + 1
    const nextCall = level < 8 ? `level${level + 1}()` : ""
    return `function level${level}() { ${nextCall} }`
  }).join("\n")
  writeSource({ repoPath, filePath: "src/flow.ts", source: dedent`

    export function start() {}

    ${helpers}

  ` })
  runGit(repoPath, ["add", "."])
  runGit(repoPath, ["commit", "-m", "initial deep flow"])

  writeSource({ repoPath, filePath: "src/flow.ts", source: dedent`

    export function start() { if (ready) level1() }

    ${helpers}

  ` })
  return repoPath
}

function formatCallDiff(callDiff: CallDiffByFile): string {
  return Object.entries(callDiff)
    .flatMap(([filePath, trees]) => [filePath, ...trees.map((tree) => tree.ascii)])
    .join("\n\n")
}

describe("createCallDiff", () => {
  beforeAll(() => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true })
  })

  afterAll(() => {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true })
  })

  test("groups added calls under their source files", async () => {
    const repoPath = createExampleRepo()
    const callDiff = await createCallDiff({
      cwd: repoPath,
      files: [
        { path: "src/services.ts" },
        { path: "src/session.ts" },
      ],
    })

    expect(formatCallDiff(callDiff)).toMatchInlineSnapshot(`
      "src/session.ts

        createAgentSession()
      + └─ getServices()

      src/services.ts

        getServices()
      + └─ createSettings()"
    `)
  })

  test("uses the merge base for PR-style two-ref comparisons", async () => {
    const repoPath = createExampleRepo()
    runGit(repoPath, ["checkout", "-b", "feature"])
    runGit(repoPath, ["add", "."])
    runGit(repoPath, ["commit", "-m", "rewire service creation"])

    const callDiff = await createCallDiff({
      cwd: repoPath,
      base: "main",
      head: "feature",
      files: [
        { path: "src/services.ts" },
        { path: "src/session.ts" },
      ],
    })

    expect(formatCallDiff(callDiff)).toMatchInlineSnapshot(`
      "src/session.ts

        createAgentSession()
      + └─ getServices()

      src/services.ts

        getServices()
      + └─ createSettings()"
    `)
  })

  test("shows only direct function and method calls", async () => {
    const repoPath = createDeepCallRepo()
    const callDiff = await createCallDiff({
      cwd: repoPath,
      files: [{ path: "src/flow.ts" }],
    })
    const ascii = callDiff["src/flow.ts"]![0]!.ascii

    expect(`\n${ascii}`).toMatchInlineSnapshot(`
      "
        start()
      + └─ level1()"
    `)
  })

  test("renders the example when CRITIQUE_CALLDIFF is enabled", () => {
    const repoPath = createExampleRepo()
    const output = child_process.execFileSync(
      "bun",
      [CLI_PATH, "--scrollback", "--cols", "100"],
      {
        cwd: repoPath,
        encoding: "utf8",
        env: { ...process.env, CRITIQUE_CALLDIFF: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const normalized = stripAnsi(output)
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim()

    expect(`\n${normalized}`).toMatchInlineSnapshot(`
      "
      └── src
                                             ├── services.ts (+1)
                                             │     getServices()
                                             │   + └─ createSettings()
                                             └── session.ts (+2,-3)
                                                   createAgentSession()
                                                 + └─ getServices()


       src/services.ts +1-0

        2   export function createAuth() {}
        3   export function createCodingTools() {}
        4   function createSettings() {}
        5
        6   export function getServices() {
        7     createAuth()
        8 +   createSettings()
        9     createCodingTools()
       10   }


       src/session.ts +2-3

       1
       2 - import { createAuth, createCodingTools, getServices } from "./services"
       2 + import { getServices } from "./services"
       3
       4   export function createAgentSession() {
       5 -   createAuth()
       6 -   createCodingTools()
       5 +   getServices()
       6   }"
    `)
  }, 30000)
})
