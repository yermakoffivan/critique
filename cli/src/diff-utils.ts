// Shared utilities for git diff processing across CLI commands.
// Builds git commands, parses diff files, detects filetypes for syntax highlighting,
// and provides helpers for unified/split view mode selection.

import { execSync, execFileSync } from "child_process"
import { buildDirectoryTree } from "./directory-tree.js"

/**
 * Check if the current directory is inside a git repository.
 * If not, print a friendly error message and exit.
 */
export function ensureGitRepo(): void {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "pipe" })
  } catch {
    console.error("fatal: not a git repository (or any parent up to mount point /)")
    console.error("")
    console.error("Run critique inside a git repository.")
    process.exit(128)
  }
}

/**
 * Strip submodule status lines from git diff output.
 * git diff --submodule=diff adds various status lines that the diff parser doesn't understand:
 * - "Submodule name hash1..hash2:" (header before submodule diff)
 * - "Submodule name contains modified content"
 * - "Submodule name contains untracked content"
 * - "Submodule name (new commits)"
 * - "Submodule name (commits not present)"
 */
export function stripSubmoduleHeaders(diffOutput: string): string {
  return diffOutput
    .split("\n")
    .filter((line) => {
      // Match lines like "Submodule errore 1bf6fc8..d746b25:"
      if (line.match(/^Submodule \S+ [a-f0-9]+\.\.[a-f0-9]+:?$/)) return false;
      // Match lines like "Submodule unframer contains modified content"
      if (line.match(/^Submodule \S+ contains (modified|untracked) content$/))
        return false;
      // Match lines like "Submodule name (new commits)" or "(commits not present)"
      if (line.match(/^Submodule \S+ \(.*\)$/)) return false;
      return true;
    })
    .join("\n");
}

/**
 * Metadata extracted from git diff rename/copy headers.
 * git diff -M adds these headers which the `diff` npm package silently skips.
 */
export interface RenameInfo {
  type: "rename" | "copy"
  from: string
  to: string
  similarity: number
}

/**
 * Preprocess raw git diff output to handle rename/copy detection.
 *
 * The `diff` npm package's parsePatch does not understand git's rename/copy
 * headers (similarity index, rename from/to, copy from/to). For pure renames
 * (100% similarity, no content changes), it produces broken entries because
 * there are no ---/+++ or @@ lines for it to parse.
 *
 * This function:
 * 1. Injects synthetic --- and +++ headers for pure renames/copies so parsePatch
 *    creates proper entries with correct filenames
 * 2. Extracts rename/copy metadata (type, from, to, similarity) for each file section
 *
 * @returns processedDiff: diff string safe for parsePatch, renameInfo: metadata per file index
 */
export function preprocessDiff(rawDiff: string): {
  processedDiff: string
  renameInfo: Map<number, RenameInfo>
} {
  const renameInfo = new Map<number, RenameInfo>()

  // Split into per-file sections at "diff --git" boundaries
  const lines = rawDiff.split("\n")
  const sections: { startIdx: number; lines: string[] }[] = []
  let currentSection: string[] | null = null

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (currentSection) {
        sections.push({ startIdx: sections.length, lines: currentSection })
      }
      currentSection = [line]
    } else if (currentSection) {
      currentSection.push(line)
    }
    // Lines before the first "diff --git" (e.g. commit metadata from git show) are ignored
  }
  if (currentSection) {
    sections.push({ startIdx: sections.length, lines: currentSection })
  }

  // Some callers may pass patch text produced by `diff`'s formatPatch(), which
  // uses "Index:" headers instead of "diff --git". In that case, do not
  // drop the whole payload: return it as-is so parsePatch can still parse hunks.
  if (sections.length === 0) {
    return {
      processedDiff: rawDiff,
      renameInfo,
    }
  }

  const outputSections: string[] = []

  for (let sectionIdx = 0; sectionIdx < sections.length; sectionIdx++) {
    const section = sections[sectionIdx]!
    const sectionLines = section.lines

    // Extract rename/copy metadata from this section
    let renameFrom: string | undefined
    let renameTo: string | undefined
    let copyFrom: string | undefined
    let copyTo: string | undefined
    let similarity: number | undefined
    let hasFileHeaders = false

    for (const line of sectionLines) {
      if (line.startsWith("--- ")) hasFileHeaders = true
      const renameFromMatch = line.match(/^rename from (.+)$/)
      if (renameFromMatch) renameFrom = renameFromMatch[1]
      const renameToMatch = line.match(/^rename to (.+)$/)
      if (renameToMatch) renameTo = renameToMatch[1]
      const copyFromMatch = line.match(/^copy from (.+)$/)
      if (copyFromMatch) copyFrom = copyFromMatch[1]
      const copyToMatch = line.match(/^copy to (.+)$/)
      if (copyToMatch) copyTo = copyToMatch[1]
      const similarityMatch = line.match(/^similarity index (\d+)%$/)
      if (similarityMatch) similarity = parseInt(similarityMatch[1]!, 10)
    }

    // Store rename/copy metadata
    if (renameFrom && renameTo) {
      renameInfo.set(sectionIdx, {
        type: "rename",
        from: renameFrom,
        to: renameTo,
        similarity: similarity ?? 100,
      })
    } else if (copyFrom && copyTo) {
      renameInfo.set(sectionIdx, {
        type: "copy",
        from: copyFrom,
        to: copyTo,
        similarity: similarity ?? 100,
      })
    }

    // For pure renames/copies (no --- +++ headers), inject synthetic headers
    // so parsePatch creates a proper entry with filenames
    if (!hasFileHeaders && (renameFrom && renameTo)) {
      outputSections.push([...sectionLines, `--- ${renameFrom}`, `+++ ${renameTo}`].join("\n"))
    } else if (!hasFileHeaders && (copyFrom && copyTo)) {
      outputSections.push([...sectionLines, `--- ${copyFrom}`, `+++ ${copyTo}`].join("\n"))
    } else {
      outputSections.push(sectionLines.join("\n"))
    }
  }

  return {
    processedDiff: outputSections.join("\n"),
    renameInfo,
  }
}

/**
 * Parse git diff output with rename/copy detection support.
 * Preprocesses the diff for pure renames, delegates to parsePatch from the `diff` package,
 * and enriches results with rename metadata.
 *
 * Use this instead of calling parsePatch directly when processing git diff -M output.
 *
 * Generic to preserve the concrete type returned by parsePatch (e.g. StructuredPatch).
 */
export function parseGitDiffFiles<T>(
  rawDiff: string,
  parsePatch: (diff: string) => T[],
): (T & { renameFrom?: string; renameTo?: string; similarity?: number })[] {
  const { processedDiff, renameInfo } = preprocessDiff(rawDiff)
  const files = parsePatch(processedDiff)

  type Enriched = T & { renameFrom?: string; renameTo?: string; similarity?: number }

  // Enrich files with rename metadata
  return files.map((file, index): Enriched => {
    const info = renameInfo.get(index)
    if (!info) return file as Enriched
    return {
      ...file,
      renameFrom: info.from,
      renameTo: info.to,
      similarity: info.similarity,
    } as Enriched
  })
}

export const IGNORED_FILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
  "snapshot.json",
  "worker-configuration.d.ts",
];

export interface ParsedFile {
  oldFileName?: string;
  newFileName?: string;
  oldHeader?: string;
  newHeader?: string;
  hunks: Array<{ lines: string[] }>;
  rawDiff?: string;
  /** Set when this file was renamed (git diff -M) */
  renameFrom?: string;
  renameTo?: string;
  /** Similarity percentage for renames/copies (0-100) */
  similarity?: number;
}

/** Default number of context lines around each diff hunk */
export const DEFAULT_CONTEXT_LINES = 6;

export interface GitCommandOptions {
  staged?: boolean;
  commit?: string;
  base?: string;
  head?: string;
  context?: string | number;
  filter?: string | string[];
  positionalFilters?: string[];
}

/**
 * Normalize file filter patterns from both --filter and positional args after --.
 */
export function getFilterPatterns(
  options: Pick<GitCommandOptions, "filter" | "positionalFilters">,
): string[] {
  const filterOptions = options.filter
    ? Array.isArray(options.filter)
      ? options.filter
      : [options.filter]
    : [];
  const positionalFilters = options.positionalFilters || [];
  return [...new Set([...filterOptions, ...positionalFilters].filter((pattern) => pattern.length > 0))];
}

/**
 * Check whether a filepath matches any user-provided file filter glob.
 * No patterns means "match everything".
 */
export function matchesFileFilters(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;

  return patterns.some((rawPattern) => {
    const pattern = rawPattern.startsWith("./") ? rawPattern.slice(2) : rawPattern;
    if (pattern === "." || pattern === "") return true;

    // Keep compatibility with existing git pathspec behavior for plain paths:
    // - "src" should match "src/**"
    // - "src/" should match descendants under src/
    // - "src/file.ts" should match that exact file
    const hasGlobMagic = /[*?[\]{}!]/.test(pattern);
    if (!hasGlobMagic) {
      if (pattern.endsWith("/")) {
        return filePath.startsWith(pattern);
      }
      return filePath === pattern || filePath.startsWith(pattern + "/");
    }

    const glob = new Bun.Glob(pattern);
    return glob.match(filePath);
  });
}

/**
 * Apply critique --filter globs to already-parsed diff files.
 * This is used after appending submodule diffs, where git pathspec filters are
 * no longer sufficient.
 */
export function filterParsedFilesByPatterns<T extends ParsedFile>(
  files: T[],
  options: Pick<GitCommandOptions, "filter" | "positionalFilters">,
): T[] {
  const patterns = getFilterPatterns(options);
  if (patterns.length === 0) return files;

  return files.filter((file) => matchesFileFilters(getFileName(file), patterns));
}

/**
 * If --commit contains range syntax (A..B or A...B), treat it as a base ref instead.
 * git show with ranges outputs commit metadata interleaved with diffs that parsePatch
 * cannot parse. Redirecting to base reuses the existing range handling.
 *
 * buildGitCommand and resolveCommitRange must agree on this rewrite, otherwise the
 * printed commit list would describe a different range than the rendered diff.
 */
function normalizeRangeOptions(options: GitCommandOptions): GitCommandOptions {
  if (options.commit?.includes("..")) {
    return { ...options, base: options.commit, commit: undefined };
  }
  return options;
}

/** Split "A...B" or "A..B" into its two refs. Returns null for a plain ref. */
function splitRangeRef(ref: string): { base: string; head: string; dots: ".." | "..." } | null {
  const threeDots = ref.match(/^(.+)\.\.\.(.+)$/);
  if (threeDots) return { base: threeDots[1]!, head: threeDots[2]!, dots: "..." };
  const twoDots = ref.match(/^(.+)\.\.(.+)$/);
  if (twoDots) return { base: twoDots[1]!, head: twoDots[2]!, dots: ".." };
  return null;
}

export interface CommitInfo {
  hash: string;
  subject: string;
}

export interface CommitRange {
  /** Ref the diff starts from, shown as a trailing "base:" line */
  baseRef?: string;
  /** Ref the diff ends at. Paired with baseRef to detect diverged histories. */
  headRef?: string;
  /**
   * True when git compares two trees directly (`git diff A..B`, `git diff <ref>`).
   * A tree comparison also reverses the changes of commits that exist only on the
   * base side, so the commit list is incomplete unless base is an ancestor of head.
   */
  treeComparison: boolean;
  /** True when the diff also contains uncommitted working tree changes */
  includesWorkingTree: boolean;
  /** Set for `--commit <ref>`, where the diff holds exactly one commit */
  singleCommit?: string;
}

/**
 * Resolve which commits a diff contains, mirroring buildGitCommand's branching.
 * Returns null when the diff has no commits at all (working tree, staged, stdin).
 *
 * Why this exists: a rebased branch can carry commits replayed from a sibling branch,
 * so `critique <merge-base>` silently publishes work you did not write. Listing the
 * commits makes that visible before the URL is shared.
 */
export function resolveCommitRange(options: GitCommandOptions): CommitRange | null {
  const opts = normalizeRangeOptions(options);

  // Staged and working-tree diffs contain no commits
  if (opts.staged) return null;

  // A single commit: `git show <ref>`
  if (opts.commit) {
    return { singleCommit: opts.commit, treeComparison: false, includesWorkingTree: false };
  }

  // Two refs: buildGitCommand uses three-dot, so the diff starts at the merge base
  // and holds exactly the commits reachable from head but not base.
  if (opts.base && opts.head) {
    return {
      baseRef: opts.base,
      headRef: opts.head,
      treeComparison: false,
      includesWorkingTree: false,
    };
  }

  if (opts.base) {
    const range = splitRangeRef(opts.base);
    if (range) {
      return {
        baseRef: range.base,
        headRef: range.head,
        // Two-dot compares the two trees directly. Three-dot starts at the merge base.
        treeComparison: range.dots === "..",
        includesWorkingTree: false,
      };
    }

    // Single ref: `git diff <base>` compares the ref tree to the working tree, so the
    // diff holds every commit since <base> plus any uncommitted changes.
    return {
      baseRef: opts.base,
      headRef: "HEAD",
      treeComparison: true,
      includesWorkingTree: true,
    };
  }

  return null;
}

/**
 * Upper bound on commits fetched in one `git log`. Ranges this long are pathological,
 * but the exact total still comes from `git rev-list --count`, so the printed count is
 * never a lie.
 */
export const COMMIT_FETCH_CAP = 5000;

export interface RangeCommits {
  /** Commits added by head, newest first */
  added: CommitInfo[];
  /**
   * Commits that exist only on the base side. Non-empty only for a tree comparison
   * between diverged refs, where the diff reverses their changes.
   */
  reversed: CommitInfo[];
  /** Exact number of added commits, even when the fetched list was capped */
  addedTotal: number;
  /** Exact number of reversed commits */
  reversedTotal: number;
  /** Commit the diff actually starts from. For three-dot this is the merge base. */
  base?: CommitInfo;
}

/**
 * Collect the commits a diff contains. Never throws: returns null when a ref is
 * unknown, the repo has no commits yet, or git fails for any other reason. A failed
 * lookup must never block the diff itself.
 */
export function listCommits(range: CommitRange): RangeCommits | null {
  if (range.singleCommit) {
    const commit = getCommitInfo(range.singleCommit);
    if (!commit) return null;
    // No base line: `git show <ref>` already scopes the diff to that one commit
    return { added: [commit], reversed: [], addedTotal: 1, reversedTotal: 0 };
  }

  if (!range.baseRef || !range.headRef) return null;

  const added = gitLog([`${range.baseRef}..${range.headRef}`]);
  if (!added) return null;

  // A tree comparison between diverged refs also undoes every commit that exists only
  // on the base side. Those commits are part of the diff, so they must be listed.
  // merge-base --is-ancestor exits 0 when the histories are linear, so a non-null
  // result means nothing is reversed
  const linear =
    runGit(["merge-base", "--is-ancestor", range.baseRef, range.headRef]) !== null;
  const reversed =
    range.treeComparison && !linear
      ? (gitLog([`${range.headRef}..${range.baseRef}`]) ?? { commits: [], total: 0 })
      : { commits: [], total: 0 };

  return {
    added: added.commits,
    reversed: reversed.commits,
    addedTotal: added.total,
    reversedTotal: reversed.total,
    base: resolveBaseCommit(range) ?? undefined,
  };
}

/**
 * Find the commit the diff actually starts from.
 *
 * A three-dot diff starts at the merge base, not at the named ref, so naming the ref
 * would point at a commit whose changes are not in the diff. A tree comparison really
 * does start at the ref itself.
 */
function resolveBaseCommit(range: CommitRange): CommitInfo | null {
  if (!range.baseRef) return null;
  if (range.treeComparison || !range.headRef) return getCommitInfo(range.baseRef);

  const mergeBase = runGit(["merge-base", range.baseRef, range.headRef]);
  if (!mergeBase) return getCommitInfo(range.baseRef);
  return getCommitInfo(mergeBase.trim());
}

/**
 * Run `git log` for a range. Returns the fetched commits plus the exact total, which
 * can be larger than the fetched list when the range exceeds COMMIT_FETCH_CAP.
 */
function gitLog(revArgs: string[]): { commits: CommitInfo[]; total: number } | null {
  const output = runGit([
    "log",
    // Tab separator: subjects can contain anything except a newline or a tab
    "--format=%h%x09%s",
    `--max-count=${COMMIT_FETCH_CAP}`,
    ...revArgs,
  ]);
  if (output === null) return null;

  const commits = parseCommitLines(output);
  if (commits.length < COMMIT_FETCH_CAP) {
    return { commits, total: commits.length };
  }

  // Hit the cap, so the true total needs a separate count
  const counted = runGit(["rev-list", "--count", ...revArgs]);
  const total = counted ? Number.parseInt(counted.trim(), 10) : Number.NaN;
  return { commits, total: Number.isNaN(total) ? commits.length : total };
}

/** Look up a single ref. Returns null on failure. */
export function getCommitInfo(ref: string): CommitInfo | null {
  const output = runGit(["log", "-1", "--format=%h%x09%s", ref]);
  if (output === null) return null;
  return parseCommitLines(output)[0] ?? null;
}

/**
 * Run git with an argument array. Returns null when git exits non-zero.
 * execFileSync, not execSync: refs are user input and must never reach a shell.
 */
function runGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function parseCommitLines(output: string): CommitInfo[] {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      if (tab === -1) return { hash: line, subject: "" };
      return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

/**
 * Check whether tracked files have uncommitted changes.
 *
 * Untracked files are excluded on purpose: `git diff <base>` never includes them,
 * so counting them would claim the diff holds work that is not in it.
 */
export function hasUncommittedChanges(): boolean {
  const output = runGit(["status", "--porcelain", "--untracked-files=no"]);
  return output !== null && output.trim().length > 0;
}

/**
 * Commits printed before the list is truncated.
 *
 * The list is newest first, and a rebase replays a foreign commit right above the
 * base, so the oldest entries are the ones most likely to be a mistake. Truncation
 * therefore keeps a tail of the oldest commits instead of cutting them off.
 */
export const MAX_LISTED_NEWEST = 12;
export const MAX_LISTED_OLDEST = 5;

export interface CommitSummaryInput {
  commits: RangeCommits;
  fileCount: number;
  additions: number;
  deletions: number;
  /** Adds a note that uncommitted work is part of the diff */
  includesWorkingTree?: boolean;
  /** Ref names used in the diverged-history warning */
  baseRef?: string;
  headRef?: string;
  maxNewest?: number;
  maxOldest?: number;
}

/**
 * Format the commit summary block printed before a diff.
 * Plain text on purpose: no colors, so it stays snapshot-testable and pipes cleanly.
 */
export function formatCommitSummary(input: CommitSummaryInput): string {
  const {
    commits,
    fileCount,
    additions,
    deletions,
    includesWorkingTree,
    baseRef,
    headRef,
    maxNewest = MAX_LISTED_NEWEST,
    maxOldest = MAX_LISTED_OLDEST,
  } = input;
  const baseCommit = commits.base;

  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;

  const diverged = commits.reversedTotal > 0;
  const headline = diverged
    ? `${plural(commits.addedTotal, "commit")} added, ${plural(commits.reversedTotal, "commit")} reversed`
    : plural(commits.addedTotal, "commit");

  const lines: string[] = [
    `${headline}, ${plural(fileCount, "file")}, +${additions} -${deletions}`,
    "",
  ];

  const hashWidth = Math.max(
    ...commits.added.map((c) => c.hash.length),
    ...commits.reversed.map((c) => c.hash.length),
    baseCommit?.hash.length ?? 0,
    1,
  );
  const indent = diverged ? "    " : "  ";
  const formatCommit = (commit: CommitInfo) =>
    `${indent}${commit.hash.padEnd(hashWidth)}  ${commit.subject}`;

  if (diverged) {
    lines.push(`  added by ${headRef ?? "head"}:`);
  }
  for (const line of truncateCommits({
    commits: commits.added,
    total: commits.addedTotal,
    maxNewest,
    maxOldest,
  })) {
    lines.push(typeof line === "string" ? `${indent}${line}` : formatCommit(line));
  }

  if (diverged) {
    lines.push("");
    lines.push(`  reversed from ${baseRef ?? "base"}:`);
    for (const line of truncateCommits({
      commits: commits.reversed,
      total: commits.reversedTotal,
      maxNewest,
      maxOldest,
    })) {
      lines.push(typeof line === "string" ? `${indent}${line}` : formatCommit(line));
    }
    lines.push("");
    lines.push(
      `  ! ${baseRef ?? "base"} and ${headRef ?? "head"} have diverged, so this diff also undoes the commits above.`,
    );
  } else if (baseCommit) {
    lines.push(`  base: ${baseCommit.hash.padEnd(hashWidth)}  ${baseCommit.subject}`);
  }

  if (includesWorkingTree) {
    lines.push("");
    lines.push("  + uncommitted working tree changes");
  }

  return lines.join("\n");
}

/**
 * Pick which commits to print. Keeps the newest and the oldest, because a replayed
 * commit sits next to the base and must never be the entry that gets cut.
 * String entries are literal separator lines.
 */
export function truncateCommits(input: {
  commits: CommitInfo[];
  total: number;
  maxNewest?: number;
  maxOldest?: number;
}): (CommitInfo | string)[] {
  const {
    commits,
    total,
    maxNewest = MAX_LISTED_NEWEST,
    maxOldest = MAX_LISTED_OLDEST,
  } = input;
  const hidden = total - commits.length;

  if (commits.length <= maxNewest + maxOldest) {
    if (hidden === 0) return commits;
    // The fetch cap dropped the oldest commits, so no tail can be shown
    return [...commits, `… ${hidden} more commit${hidden === 1 ? "" : "s"} not shown`];
  }

  const skipped = commits.length - maxNewest - maxOldest + hidden;
  return [
    ...commits.slice(0, maxNewest),
    `… ${skipped} more commit${skipped === 1 ? "" : "s"}`,
    ...commits.slice(commits.length - maxOldest),
  ];
}

/**
 * Build git command string based on options
 */
export function buildGitCommand(options: GitCommandOptions): string {
  const contextArg = `-U${options.context ?? DEFAULT_CONTEXT_LINES}`;
  // Show full submodule diffs instead of just commit hashes
  const submoduleArg = "--submodule=diff";
  // Detect renames instead of showing full delete+add
  const renameArg = "-M";
  // Force standard unified diff output even when user has diff.external or
  // GIT_EXTERNAL_DIFF configured (e.g. difftastic). Without this flag git
  // delegates to the external program and emits non-unified output that our
  // parser cannot handle. See https://github.com/remorses/critique/issues/45
  const noExtDiffArg = "--no-ext-diff";

  // Combine --filter options with positional args after --
  const filters = getFilterPatterns(options);
  // Use single quotes to prevent shell expansion of $ in paths like d.$owner.$repo.$.tsx
  const filterArg =
    filters.length > 0
      ? `-- ${filters.map((f: string) => `'${f}'`).join(" ")}`
      : "";

  options = normalizeRangeOptions(options);

  if (options.staged) {
    return `git diff --cached ${noExtDiffArg} --no-prefix ${renameArg} ${submoduleArg} ${contextArg} ${filterArg}`.trim();
  }
  if (options.commit) {
    return `git show ${options.commit} ${noExtDiffArg} --no-prefix ${renameArg} ${submoduleArg} ${contextArg} ${filterArg}`.trim();
  }
  // Two refs: compare base...head (three-dot, shows changes since branches diverged, like GitHub PRs)
  if (options.base && options.head) {
    return `git diff ${options.base}...${options.head} ${noExtDiffArg} --no-prefix ${renameArg} ${submoduleArg} ${contextArg} ${filterArg}`.trim();
  }
  // Detect range syntax in single base argument (e.g., "origin/main...HEAD" or "main..feature")
  if (options.base && !options.head) {
    const range = splitRangeRef(options.base);
    if (range) {
      return `git diff ${range.base}${range.dots}${range.head} ${noExtDiffArg} --no-prefix ${renameArg} ${submoduleArg} ${contextArg} ${filterArg}`.trim();
    }
  }
  // Single ref: compare ref to working tree (like git diff)
  if (options.base) {
    return `git diff ${options.base} ${noExtDiffArg} --no-prefix ${renameArg} ${submoduleArg} ${contextArg} ${filterArg}`.trim();
  }
  // Default (no args): ignore submodules here — dirty submodule diffs are fetched
  // separately via buildSubmoduleDiffCommand() to avoid showing committed submodule
  // ref changes that have no actual uncommitted content.
  return `git add -N . && git diff ${noExtDiffArg} --no-prefix ${renameArg} --ignore-submodules=all ${contextArg} ${filterArg}`.trim();
}

/**
 * Get submodule paths that have dirty working trees (uncommitted changes).
 * Returns only submodules with actual uncommitted modifications, not those
 * that merely point to a different commit than what the parent repo recorded.
 *
 * Uses `git submodule status` which prefixes each line with:
 * - ' ' (space): submodule matches recorded commit and is clean
 * - '+': submodule is at a different commit than recorded
 * - '-': submodule is not initialized
 * - 'U': submodule has merge conflicts
 *
 * A submodule with '+' prefix AND a trailing dirty marker (e.g. " (modified content)")
 * or one where `git status --porcelain` inside it is non-empty has dirty changes.
 */
export function getDirtySubmodulePaths(): string[] {
  try {
    // git submodule foreach runs a command in each initialized submodule.
    // We check if the submodule has any uncommitted changes (modified, staged, or untracked).
    // $displaypath gives us the relative path from the parent repo root.
    const output = execSync(
      `git submodule foreach --quiet 'if [ -n "$(git status --porcelain)" ]; then echo "$displaypath"; fi'`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    )
    return output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
  } catch {
    // No submodules, or git command failed — return empty
    return []
  }
}

/**
 * Build a git diff command that only shows diffs for specific submodule paths.
 * Used to get the actual file-level diffs inside dirty submodules.
 */
export function buildSubmoduleDiffCommand(
  submodulePaths: string[],
  options: Pick<GitCommandOptions, "context">,
): string {
  const contextArg = `-U${options.context ?? DEFAULT_CONTEXT_LINES}`
  const renameArg = "-M"
  const submoduleArg = "--submodule=diff"
  const pathArgs = submodulePaths.map((p) => `'${p}'`).join(" ")
  return `git diff --no-ext-diff --no-prefix ${renameArg} ${submoduleArg} ${contextArg} -- ${pathArgs}`.trim()
}

/**
 * Get file status from parsed diff file
 * - added: oldFileName is /dev/null (new file)
 * - deleted: newFileName is /dev/null (removed file)
 * - renamed: file has renameFrom/renameTo metadata, or oldFileName !== newFileName
 *   (with --no-prefix, different filenames means rename since there's no a/ b/ prefix)
 * - modified: both files exist with same name (changed file)
 */
export function getFileStatus(file: {
  oldFileName?: string;
  newFileName?: string;
  renameFrom?: string;
  renameTo?: string;
}): "added" | "modified" | "deleted" | "renamed" {
  const oldName = file.oldFileName;
  const newName = file.newFileName;

  if (!oldName || oldName === "/dev/null") return "added";
  if (!newName || newName === "/dev/null") return "deleted";
  // Explicit rename metadata from preprocessDiff
  if (file.renameFrom && file.renameTo) return "renamed";
  // With --no-prefix, different filenames means rename
  if (oldName !== newName) return "renamed";
  return "modified";
}

/**
 * Get filename from parsed diff file, handling /dev/null for new/deleted files.
 * For renames, returns the new name (destination).
 */
export function getFileName(file: {
  oldFileName?: string;
  newFileName?: string;
  renameTo?: string;
}): string {
  // For renames, prefer the renameTo metadata (always clean, no prefix)
  if (file.renameTo) return file.renameTo;

  const newName = file.newFileName;
  const oldName = file.oldFileName;

  // Filter out /dev/null which appears for new/deleted files
  if (newName && newName !== "/dev/null") return newName;
  if (oldName && oldName !== "/dev/null") return oldName;

  return "unknown";
}

/**
 * Get the old filename for display purposes (e.g., "old-name.ts -> new-name.ts").
 * Returns undefined if the file was not renamed.
 */
export function getOldFileName(file: {
  oldFileName?: string;
  newFileName?: string;
  renameFrom?: string;
  renameTo?: string;
}): string | undefined {
  if (file.renameFrom && file.renameTo) return file.renameFrom;
  const oldName = file.oldFileName;
  const newName = file.newFileName;
  if (oldName && newName && oldName !== newName && oldName !== "/dev/null" && newName !== "/dev/null") {
    return oldName;
  }
  return undefined;
}

/**
 * Count additions and deletions from hunks
 */
export function countChanges(hunks: Array<{ lines: string[] }>): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      if (line.startsWith("-")) deletions++;
    }
  }

  return { additions, deletions };
}

/**
 * Determine view mode based on changes and terminal width
 * @param splitThreshold - minimum cols for split view (default 100 for TUI, 150 for web)
 */
export function getViewMode(
  additions: number,
  deletions: number,
  cols: number,
  splitThreshold: number = 100,
): "split" | "unified" {
  // Use unified view for fully added or fully deleted files (one side would be empty in split view)
  const isFullyAdded = additions > 0 && deletions === 0;
  const isFullyDeleted = deletions > 0 && additions === 0;
  const useUnifiedForFile = isFullyAdded || isFullyDeleted;

  if (useUnifiedForFile) return "unified";
  return cols >= splitThreshold ? "split" : "unified";
}

/**
 * Filter and sort parsed diff files, add rawDiff
 */
export function processFiles<T extends ParsedFile>(
  files: T[],
  formatPatch: (file: T) => string,
): (T & { rawDiff: string })[] {
  const filteredFiles = files.filter((file) => {
    const fileName = getFileName(file);
    const baseName = fileName.split("/").pop() || "";

    if (IGNORED_FILES.includes(baseName) || baseName.endsWith(".lock")) {
      return false;
    }

    const totalLines = file.hunks.reduce(
      (sum, hunk) => sum + hunk.lines.length,
      0,
    );
    return totalLines <= 6000;
  });

  const treeFiles = filteredFiles.map((file, index) => {
    const { additions, deletions } = countChanges(file.hunks)
    return {
      path: getFileName(file),
      status: getFileStatus(file),
      additions,
      deletions,
      fileIndex: index,
    }
  })

  const treeFileOrder = buildDirectoryTree(treeFiles)
    .filter((node) => node.isFile && node.fileIndex !== undefined)
    .map((node) => node.fileIndex!)

  const seenIndexes = new Set<number>()
  const sortedFiles: T[] = []

  for (const index of treeFileOrder) {
    if (seenIndexes.has(index)) continue
    const file = filteredFiles[index]
    if (!file) continue
    seenIndexes.add(index)
    sortedFiles.push(file)
  }

  // Defensive fallback: keep any unmatched files in original order.
  // This should be rare, but avoids dropping files if tree metadata and
  // parsed file list ever diverge.
  for (let index = 0; index < filteredFiles.length; index++) {
    if (seenIndexes.has(index)) continue
    const file = filteredFiles[index]
    if (!file) continue
    sortedFiles.push(file)
  }

  // Add rawDiff for each file
  return sortedFiles.map((file) => ({
    ...file,
    rawDiff: formatPatch(file),
  }));
}

/**
 * Detect filetype from filename for syntax highlighting
 * Maps to tree-sitter parsers available in @opentuah/core and parsers-config.ts
 */
export function detectFiletype(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    // TypeScript parser handles TS, TSX, JS, JSX (it's a superset)
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "mts":
    case "cts":
      return "typescript";
    case "json":
    case "jsonc":
    case "json5":
      return "json";
    case "md":
    case "mdx":
    case "mkd":
    case "mkdn":
    case "mdown":
    case "markdown":
      return "markdown";
    case "zig":
      return "zig";
    // Languages from parsers-config.ts
    case "py":
    case "pyw":
    case "pyi":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hxx":
    case "hh":
    case "tpp":
    case "ipp":
    case "inl":
    case "h":
      return "cpp";
    case "cs":
      return "csharp";
    case "sh":
    case "bash":
    case "zsh":
    case "ksh":
      return "bash";
    case "c":
      return "c";
    case "java":
      return "java";
    case "rb":
    case "rake":
    case "gemspec":
      return "ruby";
    case "php":
      return "php";
    case "scala":
    case "sc":
      return "scala";
    case "html":
    case "htm":
    case "xhtml":
    case "xml":
    case "svg":
      return "html";
    case "yaml":
    case "yml":
      return "yaml";
    case "hs":
    case "lhs":
      return "haskell";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "jl":
      return "julia";
    case "ml":
    case "mli":
      return "ocaml";
    case "clj":
    case "cljs":
    case "cljc":
    case "edn":
      return "clojure";
    case "swift":
      return "swift";
    case "nix":
      return "nix";
    case "prisma":
      return "prisma";
    default:
      return undefined;
  }
}
