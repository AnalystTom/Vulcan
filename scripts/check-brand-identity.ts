// FILE: check-brand-identity.ts
// Purpose: Prevents retired first-party identities from returning to tracked files.
//
// Vulcan inherits this guard from its upstream and extends it. It forbids the
// name of the project Vulcan was cloned from, the name of the project that one
// was in turn cloned from, that project's company name, and two earlier names
// retired further upstream. PROVENANCE.md names them; this file cannot, because
// it would then trip its own check, so they are built from character codes
// below.
//
// Attribution is not the same as branding. MIT requires the upstream copyright
// notices to survive, and honesty requires the origin story to be stated, so a
// small number of places are allowed to name a retired identity. Those places
// are enumerated below. Anything else is a violation, which makes re-introducing
// upstream branding an explicit, reviewed act rather than an accident.
//
// The retired names are written as character codes so that this file — and its
// test — do not themselves trip the guard they implement.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const retiredShortName = characters(116, 51);
const retiredFirstName = `${retiredShortName}${characters(99, 111, 100, 101)}`;
const retiredCompanyName = `${retiredShortName}${characters(116, 111, 111, 108, 115)}`;
const retiredSecondName = characters(100, 112, 99, 111, 100, 101);
const retiredPredecessorName = characters(99, 111, 100, 101, 116, 104, 105, 110, 103);
const retiredUpstreamName = characters(115, 121, 110, 97, 114, 97);
const retiredCompanyDisplayName = `${characters(84, 51)} ${characters(84, 111, 111, 108, 115)}`;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const joinedWithOptionalSeparator = (left: string, right: string): string =>
  `${escapeRegExp(left)}[\\s._/@:-]*${escapeRegExp(right)}`;

/**
 * Matches a name whose characters may each be written literally or as a source
 * escape that denotes the same character — `a`, `\x61`, `\u{61}`, `\141`.
 * The clone rewrite missed exactly one occurrence written that way, and a plain
 * literal search could never have found it, so the guard has to look through
 * escapes rather than trust that branding is always spelled out.
 */
const escapeTolerantPattern = (value: string): string =>
  Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const hex = code.toString(16);
      const alternatives = [
        escapeRegExp(character),
        `\\\\u0*${hex}`,
        `\\\\u\\{0*${hex}\\}`,
        `\\\\x0*${hex}`,
        `\\\\0*${code.toString(8)}`,
      ];
      return `(?:${alternatives.join("|")})`;
    })
    .join("");

const forbiddenPatterns = [
  new RegExp(escapeTolerantPattern(retiredUpstreamName), "i"),
  new RegExp(
    joinedWithOptionalSeparator(retiredShortName, retiredFirstName.slice(retiredShortName.length)),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(
      retiredShortName,
      retiredCompanyName.slice(retiredShortName.length),
    ),
    "i",
  ),
  new RegExp(
    joinedWithOptionalSeparator(retiredSecondName.slice(0, 2), retiredSecondName.slice(2)),
    "i",
  ),
  new RegExp(escapeRegExp(retiredPredecessorName), "i"),
  new RegExp(`@${escapeRegExp(retiredCompanyName)}`, "i"),
  new RegExp(
    `(?:^|[\\s"'\\x60./:@_-])${escapeRegExp(retiredShortName)}(?:$|[\\s"'\\x60./:@_-])`,
    "i",
  ),
] as const;

/**
 * A single line that is permitted to name a retired identity, matched exactly
 * and consumed once. Use this where the surrounding file is product content and
 * only one specific line is attribution — the `LICENSE` copyright notices.
 */
interface ApprovedAttributionLine {
  readonly path: string;
  readonly line: string;
}

/**
 * A markdown section whose every line is permitted to name a retired identity.
 * Use this where attribution is inherently prose that will be reworded and
 * rewrapped — moving the text out of the named section still trips the guard.
 */
interface ApprovedAttributionSection {
  readonly path: string;
  readonly markdownSection: string;
}

const approvedAttributionLines: readonly ApprovedAttributionLine[] = [
  { path: "LICENSE", line: `Copyright (c) 2026 ${retiredCompanyDisplayName} Inc.` },
];

const approvedAttributionSections: readonly ApprovedAttributionSection[] = [
  { path: "README.md", markdownSection: "## Origins" },
  { path: "CHANGELOG.md", markdownSection: "## 0.1.0 - unreleased" },
];

/**
 * Files that exist solely to record provenance. Their entire contents are
 * attribution, so enumerating individual lines would be pure friction. Adding a
 * path here is the reviewed act.
 */
const approvedAttributionFiles: ReadonlySet<string> = new Set(["PROVENANCE.md"]);

// Raster images cannot be searched for embedded text. Keep user-facing artwork
// behind reviewed digests so changing one requires another explicit visual
// identity audit instead of silently bypassing this guard. Vulcan currently
// ships no raster screenshot; entries are added here as artwork lands.
const approvedVisualAssetDigests = new Map<string, string>([]);

export interface BrandIdentityFile {
  readonly path: string;
  readonly contents: string;
}

export interface BrandIdentityViolation {
  readonly path: string;
  readonly line: number | null;
  readonly text: string;
}

export interface BrandIdentityBinaryFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

function containsForbiddenIdentity(value: string): boolean {
  return forbiddenPatterns.some((pattern) => pattern.test(value));
}

function findApprovedAttributionLine(
  path: string,
  line: string,
  consumedAttributions: ReadonlySet<number>,
): number | null {
  const index = approvedAttributionLines.findIndex(
    (attribution, candidateIndex) =>
      !consumedAttributions.has(candidateIndex) &&
      attribution.path === path &&
      attribution.line === line.trim(),
  );
  return index === -1 ? null : index;
}

function isApprovedAttributionSection(path: string, markdownSection: string | null): boolean {
  if (markdownSection === null) return false;
  return approvedAttributionSections.some(
    (attribution) => attribution.path === path && attribution.markdownSection === markdownSection,
  );
}

export function findBrandIdentityViolations(
  files: readonly BrandIdentityFile[],
): BrandIdentityViolation[] {
  const violations: BrandIdentityViolation[] = [];
  for (const file of files) {
    if (containsForbiddenIdentity(file.path)) {
      violations.push({ path: file.path, line: null, text: file.path });
    }
    if (approvedAttributionFiles.has(file.path)) continue;
    const consumedAttributions = new Set<number>();
    let markdownSection: string | null = null;
    for (const [index, line] of file.contents.split(/\r?\n/).entries()) {
      if (/^#{1,2}\s+/.test(line)) markdownSection = line.trim();
      if (!containsForbiddenIdentity(line)) continue;
      if (isApprovedAttributionSection(file.path, markdownSection)) continue;
      const approvedAttribution = findApprovedAttributionLine(
        file.path,
        line,
        consumedAttributions,
      );
      if (approvedAttribution !== null) {
        consumedAttributions.add(approvedAttribution);
        continue;
      }
      violations.push({ path: file.path, line: index + 1, text: line.trim() });
    }
  }
  return violations;
}

export function findVisualBrandAssetViolations(
  files: readonly BrandIdentityBinaryFile[],
  approvedDigests: ReadonlyMap<string, string> = approvedVisualAssetDigests,
): BrandIdentityViolation[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const violations: BrandIdentityViolation[] = [];
  for (const [path, approvedDigest] of approvedDigests) {
    const file = filesByPath.get(path);
    if (!file) {
      violations.push({
        path,
        line: null,
        text: "Required visual brand asset is missing.",
      });
      continue;
    }
    const digest = createHash("sha256").update(file.contents).digest("hex");
    if (digest !== approvedDigest) {
      violations.push({
        path,
        line: null,
        text: "Visual brand asset changed; perform a visual identity review before approving it.",
      });
    }
  }
  return violations;
}

function readTrackedFiles(): BrandIdentityBinaryFile[] {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  return paths.map((path) => ({ path, contents: readFileSync(path) }));
}

function main(): void {
  const trackedFiles = readTrackedFiles();
  const searchableFiles = trackedFiles.map((file) => ({
    path: file.path,
    contents: file.contents.includes(0) ? "" : Buffer.from(file.contents).toString("utf8"),
  }));
  const violations = [
    ...findBrandIdentityViolations(searchableFiles),
    ...findVisualBrandAssetViolations(trackedFiles),
  ];
  if (violations.length === 0) {
    console.log("Vulcan identity check passed.");
    return;
  }

  console.error("Retired first-party identity found:");
  for (const violation of violations) {
    const location =
      violation.line === null ? violation.path : `${violation.path}:${violation.line}`;
    console.error(`- ${location}: ${violation.text}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
