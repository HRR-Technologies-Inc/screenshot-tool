import { config } from "dotenv";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { browseForContent } from "../lib/browser-agent";

config({ path: ".env.local" });

async function main() {
  const targetUrl = process.argv[2];
  const searchObjective = process.argv[3];

  if (!targetUrl || !searchObjective) {
    console.error(
      'Usage: npx tsx scripts/test-agent.ts "<url>" "<what to look for>"'
    );
    console.error(
      'Example: npx tsx scripts/test-agent.ts "https://example.com" "what this site is about"'
    );
    process.exit(1);
  }

  const outputDir = "test-output";
  await mkdir(outputDir, { recursive: true });

  console.log(`\nQuery: "${searchObjective}"`);
  console.log(`Target: ${targetUrl}\n`);

  const result = await browseForContent(
    {
      targetUrl,
      searchObjective,
      maxPages: 3,
    },
    async (msg) => {
      console.log(`  • ${msg}`);
    }
  );

  console.log(`\n=== Results ===`);
  console.log(`Pages visited: ${result.pagesVisited.length}`);
  console.log(`Findings: ${result.findings.length}`);
  console.log(`Duration: ${Math.round(result.durationMs / 1000)}s`);

  if (result.errors.length > 0) {
    console.log(`\nErrors:`);
    for (const e of result.errors) console.log(`  ! ${e}`);
  }

  console.log(`\n=== Findings ===`);
  for (let i = 0; i < result.findings.length; i++) {
    const f = result.findings[i];
    const filename = join(outputDir, `finding-${i + 1}.png`);
    await writeFile(filename, f.screenshotBuffer);

    console.log(`\n[${i + 1}] ${f.sectionHeading}`);
    console.log(`    Relevance: ${f.relevanceScore}`);
    console.log(`    Source: ${f.pageUrl}`);
    console.log(`    Screenshot: ${filename}`);
    console.log(`    Text: "${f.extractedText.slice(0, 200).replace(/\n/g, " ")}${f.extractedText.length > 200 ? "..." : ""}"`);
  }

  console.log(`\nDone. Screenshots saved to ${outputDir}/\n`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
