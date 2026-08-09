import { describe, expect, it } from "vitest";

import {
  findBrandIdentityViolations,
  findVisualBrandAssetViolations,
} from "./check-brand-identity";

// Retired names are written as character codes so this test does not itself
// trip the guard it exercises.
const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const shortName = characters(116, 51);
const firstName = `${shortName}${characters(99, 111, 100, 101)}`;
const firstDisplayName = characters(84, 51, 67, 111, 100, 101);
const secondName = characters(100, 112, 99, 111, 100, 101);
const companyDisplayName = `${characters(84, 51)} ${characters(84, 111, 111, 108, 115)}`;
const upstreamName = characters(83, 121, 110, 97, 114, 97);
const legalNotice = `Copyright (c) 2026 ${companyDisplayName} Inc.`;
const originsAttribution = `Vulcan began as a clean clone of [${upstreamName}](https://github.com/Emanuele-web04/${upstreamName.toLowerCase()}).\n${upstreamName} itself began as a clone of [${firstDisplayName}](https://github.com/pingdotgg/${firstName}).`;

describe("brand identity guard", () => {
  it("detects retired names in paths and text", () => {
    const violations = findBrandIdentityViolations([
      { path: `docs/${firstName}.md`, contents: "Vulcan" },
      { path: "source.ts", contents: `const value = "${secondName}:state";` },
    ]);
    expect(violations).toHaveLength(2);
  });

  it("detects the direct upstream identity", () => {
    expect(
      findBrandIdentityViolations([
        { path: "source.ts", contents: `const home = "~/.${upstreamName.toLowerCase()}";` },
      ]),
    ).toHaveLength(1);
    expect(
      findBrandIdentityViolations([
        { path: `packages/shared/src/${upstreamName.toLowerCase()}Home.ts`, contents: "" },
      ]),
    ).toHaveLength(1);
  });

  it("sees through source escapes that spell the upstream identity", () => {
    const escaped = `${upstreamName.slice(0, 3)}\\u0061${upstreamName.slice(4)}`;
    expect(
      findBrandIdentityViolations([
        { path: "config.ts", contents: `const table = '[mcp_servers."${escaped}"]';` },
      ]),
    ).toHaveLength(1);
    expect(
      findBrandIdentityViolations([
        { path: "config.ts", contents: `const table = '[mcp_servers."vulc\\u0061n"]';` },
      ]),
    ).toEqual([]);
  });

  it("does not match ordinary numeric type names or canonical Vulcan text", () => {
    expect(
      findBrandIdentityViolations([
        { path: "source.ts", contents: "const value = new Uint32Array(); // Vulcan" },
      ]),
    ).toEqual([]);
  });

  it("allows the exact legal attribution once in LICENSE", () => {
    expect(findBrandIdentityViolations([{ path: "LICENSE", contents: legalNotice }])).toEqual([]);
    expect(
      findBrandIdentityViolations([{ path: "docs/license-copy.md", contents: legalNotice }]),
    ).toHaveLength(1);
    expect(
      findBrandIdentityViolations([
        { path: "LICENSE", contents: `${legalNotice}\n${legalNotice}` },
      ]),
    ).toHaveLength(1);
  });

  it("allows attribution prose only inside the README Origins section", () => {
    expect(
      findBrandIdentityViolations([
        { path: "README.md", contents: `## Origins\n\n${originsAttribution}` },
      ]),
    ).toEqual([]);
    expect(
      findBrandIdentityViolations([
        { path: "README.md", contents: `## About\n\n${originsAttribution}` },
      ]),
    ).toHaveLength(2);
    expect(
      findBrandIdentityViolations([
        {
          path: "README.md",
          contents: `## Origins\n\n${originsAttribution}\n\n## Install\n\nLegacy ${firstName}`,
        },
      ]),
    ).toHaveLength(1);
  });

  it("exempts the provenance record entirely but not a copy of it", () => {
    const provenance = `Upstream project | ${upstreamName}\nUpstream revision | ce8728c4`;
    expect(findBrandIdentityViolations([{ path: "PROVENANCE.md", contents: provenance }])).toEqual(
      [],
    );
    expect(
      findBrandIdentityViolations([{ path: "docs/provenance-copy.md", contents: provenance }]),
    ).toHaveLength(1);
  });

  it("requires user-facing raster assets to match a visually approved digest", () => {
    const approvedContents = new TextEncoder().encode("approved Vulcan screenshot");
    const approvedDigest = "727bccfc3096e01fbc976b7a49611e41ef986b01ad0e3defbba20b2aca65ea26";
    const approvedDigests = new Map([["screenshot.jpeg", approvedDigest]]);

    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: approvedContents }],
        approvedDigests,
      ),
    ).toEqual([]);
    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: new TextEncoder().encode("changed") }],
        approvedDigests,
      ),
    ).toHaveLength(1);
    expect(findVisualBrandAssetViolations([], approvedDigests)).toHaveLength(1);
  });
});
