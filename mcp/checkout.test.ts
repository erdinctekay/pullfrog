import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { acquireNewToken } from "../utils/github.ts";
import { fetchAndFormatPrDiff } from "./checkout.ts";

/**
 * parses TOC entries like "- src/math.ts → lines 7-42" into structured data.
 */
function parseTocEntries(toc: string) {
  const entries: Array<{ filename: string; startLine: number; endLine: number }> = [];
  for (const line of toc.split("\n")) {
    const match = line.match(/^- (.+) → lines (\d+)-(\d+)$/);
    if (match) {
      entries.push({
        filename: match[1],
        startLine: parseInt(match[2], 10),
        endLine: parseInt(match[3], 10),
      });
    }
  }
  return entries;
}

async function getToken(): Promise<string> {
  // prefer explicit GH_TOKEN, fall back to acquiring one via GitHub App credentials
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  return await acquireNewToken();
}

describe("fetchAndFormatPrDiff", () => {
  it(
    "generates accurate TOC line numbers for pullfrog/test-repo#1",
    { timeout: 30000 },
    async () => {
      const token = await getToken();
      const octokit = new Octokit({ auth: token });
      const result = await fetchAndFormatPrDiff({
        octokit,
        owner: "pullfrog",
        repo: "test-repo",
        pullNumber: 1,
      });

      // verify content includes TOC at the start
      expect(result.content.startsWith(result.toc)).toBe(true);

      // parse TOC and validate every entry's line numbers against actual content
      const contentLines = result.content.split("\n");
      const tocEntries = parseTocEntries(result.toc);
      expect(tocEntries.length).toBeGreaterThan(0);

      for (const entry of tocEntries) {
        // line numbers are 1-indexed, arrays are 0-indexed
        const firstLine = contentLines[entry.startLine - 1];
        expect(firstLine).toBeDefined();
        // first line of each file section should be the diff header
        expect(firstLine).toBe(`diff --git a/${entry.filename} b/${entry.filename}`);

        // endLine should be within bounds
        expect(entry.endLine).toBeLessThanOrEqual(contentLines.length);
      }

      // verify adjacent files don't overlap and are contiguous
      for (let i = 1; i < tocEntries.length; i++) {
        const prev = tocEntries[i - 1];
        const curr = tocEntries[i];
        // current file starts right after previous file ends
        expect(curr.startLine).toBe(prev.endLine + 1);
      }

      // snapshot the full output for regression detection
      expect(result.toc).toMatchSnapshot("toc");
      expect(result.content).toMatchSnapshot("content");
    }
  );
});
