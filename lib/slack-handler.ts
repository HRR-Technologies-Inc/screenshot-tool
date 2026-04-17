import { WebClient } from "@slack/web-api";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { browseForContent } from "./browser-agent";
import type { ParsedQuery, BrowseResult } from "./types";

const parsedQuerySchema = z.object({
  targetUrl: z.string().nullable(),
  searchObjective: z.string(),
  maxPages: z.number().min(1).max(5).default(3),
});

async function parseUserQuery(messageText: string): Promise<ParsedQuery> {
  const result = await generateObject({
    model: anthropic("claude-sonnet-4-20250514"),
    schema: parsedQuerySchema,
    messages: [
      {
        role: "system",
        content: `Parse this user request about finding content on a website.
Extract the target URL and what they're looking for.
If the user mentions a company/product name without a URL, infer the most likely URL (e.g., "Y Combinator" → "https://www.ycombinator.com").
If you truly cannot determine a URL, set targetUrl to null.
Set maxPages to 5 by default, 1 if they only want the homepage, up to 10 if they want a deep search.`,
      },
      { role: "user", content: messageText },
    ],
  });

  return result.object;
}

// Claude occasionally returns arrays as JSON-encoded strings — normalize both shapes.
const stringArray = z.preprocess((val) => {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return val.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  return val;
}, z.array(z.string()));

const synthesisSchema = z.object({
  summary: z.string(),
  bulletPoints: stringArray,
  selectedFindings: z.array(
    z.object({
      findingIndex: z.number(),
      quote: z.string(),
    })
  ),
});

async function synthesizeFindings(
  query: ParsedQuery,
  findings: BrowseResult["findings"]
): Promise<{
  summary: string;
  bulletPoints: string[];
  selected: Array<{ finding: BrowseResult["findings"][number]; quote: string }>;
}> {
  const findingsText = findings
    .map(
      (f, i) =>
        `[${i}] (${f.pageUrl})\n"${f.extractedText.slice(0, 800)}"`
    )
    .join("\n\n");

  const result = await generateObject({
    model: anthropic("claude-sonnet-4-20250514"),
    schema: synthesisSchema,
    messages: [
      {
        role: "system",
        content: `You synthesize findings from a website into a direct, concise answer.

Format your response as:
1. "summary": 1-2 sentences that directly answer the user's question. No preamble. No "Based on the findings..."
2. "bulletPoints": 2-5 short bullet points (each under 20 words) that support the summary. Each bullet should be a specific, concrete detail — not a restatement of the summary. Skip this if the summary already captures everything.
3. "selectedFindings": pick 1-3 findings (by index) whose screenshots best visualize the answer. For each, include a "quote" — a single 1-2 sentence verbatim excerpt. Fewer is better — only include a screenshot if it adds visual value.

Quote verbatim, never paraphrase inside quotes. Skip weak, redundant, or off-topic findings.`,
      },
      {
        role: "user",
        content: `User's question: "${query.searchObjective}"

Findings from ${query.targetUrl}:

${findingsText}`,
      },
    ],
  });

  const selected = result.object.selectedFindings
    .filter((s) => s.findingIndex >= 0 && s.findingIndex < findings.length)
    .map((s) => ({
      finding: findings[s.findingIndex],
      quote: s.quote,
    }));

  return {
    summary: result.object.summary,
    bulletPoints: result.object.bulletPoints,
    selected,
  };
}

async function uploadSelectedFindings(
  selected: Array<{ finding: BrowseResult["findings"][number]; quote: string }>,
  channel: string,
  threadTs: string,
  client: WebClient
): Promise<void> {
  for (let i = 0; i < selected.length; i++) {
    const { finding, quote } = selected[i];

    try {
      await client.files.uploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: finding.screenshotBuffer,
        filename: `screenshot-${i + 1}.png`,
        initial_comment: `> ${quote}\n_${finding.pageUrl}_`,
      });
    } catch {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `> ${quote}\n_${finding.pageUrl}_\n\n_(screenshot upload failed)_`,
      });
    }

    if (i < selected.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function handleSlackMessage(
  event: { text: string; channel: string; ts: string; user?: string },
  client: WebClient
): Promise<void> {
  const { text, channel, ts } = event;

  // Strip bot mention from text (e.g., "<@U123ABC> query" → "query")
  const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!cleanText) {
    await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: "Please include a website and describe what content you're looking for.\n\nExample: _get me screenshots of copy on ycombinator.com about the type of founders they back_",
    });
    return;
  }

  // React with eyes to signal processing has started
  try {
    await client.reactions.add({ channel, timestamp: ts, name: "eyes" });
  } catch {
    // Non-critical — continue even if reaction fails (e.g. missing scope)
  }

  // Post initial status message
  const statusMsg = await client.chat.postMessage({
    channel,
    thread_ts: ts,
    text: "Working on it... parsing your request.",
  });
  const statusTs = statusMsg.ts!;

  const updateStatus = async (message: string) => {
    await client.chat.update({
      channel,
      ts: statusTs,
      text: message,
    });
  };

  const markDone = async () => {
    try {
      await client.reactions.remove({ channel, timestamp: ts, name: "eyes" });
    } catch {}
    try {
      await client.reactions.add({
        channel,
        timestamp: ts,
        name: "white_check_mark",
      });
    } catch {}
  };

  try {
    // Parse the query
    const query = await parseUserQuery(cleanText);

    if (!query.targetUrl) {
      await updateStatus(
        "I couldn't determine which website to visit. Please include a URL or website name.\n\nExample: _get me screenshots of copy on ycombinator.com about the type of founders they back_"
      );
      await markDone();
      return;
    }

    await updateStatus(
      `Parsed request: searching ${query.targetUrl} for "${query.searchObjective}"`
    );

    // Run the browser agent
    const result = await browseForContent(query, updateStatus);

    if (result.findings.length === 0) {
      const errorContext =
        result.errors.length > 0
          ? `\n\nIssues encountered:\n${result.errors.map((e) => `• ${e}`).join("\n")}`
          : "";

      await updateStatus(
        `Visited ${result.pagesVisited.length} page(s) but couldn't find content matching "${query.searchObjective}".${errorContext}`
      );
      await markDone();
      return;
    }

    // Synthesize a direct answer
    await updateStatus(`Synthesizing answer from ${result.findings.length} finding(s)...`);
    const { summary, bulletPoints, selected } = await synthesizeFindings(
      query,
      result.findings
    );

    // Format final response: summary + supporting bullets
    const bulletsText =
      bulletPoints.length > 0
        ? "\n\n" + bulletPoints.map((b) => `• ${b}`).join("\n")
        : "";

    await updateStatus(`${summary}${bulletsText}`);

    // Upload supporting screenshots (up to 3)
    if (selected.length > 0) {
      await uploadSelectedFindings(selected.slice(0, 3), channel, ts, client);
    }

    await markDone();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Error handling Slack message:", e);

    await updateStatus(`Something went wrong: ${msg}`);
  }
}
