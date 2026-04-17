# Screenshot Tool — Implementation Spec

## Context

We're building a generic tool that lets non-technical users (e.g., lawyers) send natural language requests like *"get me screenshots of copy on Y Combinator's website which talk about the type of founders they back"* — and it returns the relevant text plus screenshots of those specific sections. Primary interface is a Slack bot. Must be generic — anyone deploys it with their own API keys.

---

## Tech Stack

| Layer | Tool | Package |
|-------|------|---------|
| Runtime | Node.js + TypeScript | `typescript`, `tsx` |
| AI Framework | Vercel AI SDK | `ai`, `@ai-sdk/anthropic` |
| LLM | Claude Sonnet 4 (Anthropic) | via `@ai-sdk/anthropic` |
| Browser automation | BrowserBase + Playwright | `@browserbasehq/sdk`, `playwright-core` |
| Slack bot | Vercel AI SDK Slackbot pattern | `@slack/web-api`, `@slack/events-api` |
| Deployment | Vercel (serverless) | `vercel` |
| Local dev | ngrok | tunnels webhooks to localhost |

Based on the `vercel-labs/ai-sdk-slackbot` template. Uses HTTP webhook mode for Slack (not Socket Mode), with ngrok for local development and Vercel for production deployment.

---

## Project Structure

```
screenshot-tool/
├── app/
│   └── api/
│       └── slack/
│           └── route.ts        # Slack webhook handler (Next.js API route)
├── lib/
│   ├── browser-agent.ts        # Core agent: browse, analyze, screenshot
│   ├── slack-handler.ts        # Slack message processing, file uploads, progress
│   ├── types.ts                # Shared TypeScript interfaces
│   └── config.ts               # Env var validation
├── .env.example                # Template with required env vars
├── .env.local                  # Local env vars (gitignored)
├── package.json
├── tsconfig.json
├── next.config.ts
├── vercel.json
└── .gitignore
```

Uses Next.js App Router for the API route (standard Vercel pattern).

---

## Configuration (Environment Variables)

```
ANTHROPIC_API_KEY=          # From console.anthropic.com
BROWSERBASE_API_KEY=        # From browserbase.com dashboard
BROWSERBASE_PROJECT_ID=     # From browserbase.com dashboard
SLACK_BOT_TOKEN=            # xoxb-... from Slack app
SLACK_SIGNING_SECRET=       # From Slack app settings
```

No Socket Mode tokens needed — uses HTTP webhooks instead.

---

## Core Workflow

```
Slack message (webhook via ngrok/Vercel)
  → Verify Slack signature
  → Acknowledge with 200 (Slack requires response within 3 seconds)
  → Parse query with Claude Sonnet (extract URL + search objective)
  → Create BrowserBase session + connect Playwright
  → Browsing loop (max 5 pages):
      → Navigate to page
      → Dismiss cookie banners/overlays
      → Take full-page screenshot
      → Send screenshot + page text to Claude Sonnet Vision
      → Claude identifies: relevant sections + links to follow
      → For each relevant section: locate element → screenshot it → extract text
      → Queue suggested links (same-domain only, priority-sorted)
  → Close browser session
  → Upload screenshots + text to Slack thread
```

**Important:** Slack webhooks require a 200 response within 3 seconds. The actual processing happens asynchronously after acknowledging. Use `waitUntil` in the Vercel response or fire-and-forget the async work after responding.

---

## File-by-File Breakdown

### 1. `lib/types.ts`

```typescript
interface ParsedQuery {
  targetUrl: string           // "https://ycombinator.com"
  searchObjective: string     // "copy about the type of founders they back"
  maxPages: number            // default 5
}

interface ContentFinding {
  pageUrl: string
  pageTitle: string
  sectionHeading: string      // description of what was found
  extractedText: string       // the actual copy
  screenshotBuffer: Buffer    // PNG of the element
  relevanceScore: number      // 0-1
}

interface BrowseResult {
  query: ParsedQuery
  findings: ContentFinding[]
  pagesVisited: string[]
  errors: string[]
  durationMs: number
}

type ProgressCallback = (message: string) => Promise<void>
```

### 2. `lib/config.ts`

- Reads env vars (Next.js handles loading from `.env.local` automatically)
- Validates all 5 are present, throws with clear message listing missing vars
- Exports a frozen typed `Config` object

### 3. `lib/browser-agent.ts` (core — most complex)

**Exported function:**
```typescript
browseForContent(query: ParsedQuery, onProgress: ProgressCallback): Promise<BrowseResult>
```

Completely independent of Slack — takes structured input, returns structured output.

**AI calls use Vercel AI SDK with Claude Sonnet:**
```typescript
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';

const result = await generateObject({
  model: anthropic('claude-sonnet-4-20250514'),
  schema: pageAnalysisSchema,  // zod schema for structured output
  messages: [
    { role: 'user', content: [
      { type: 'image', image: screenshotBuffer },
      { type: 'text', text: analysisPrompt }
    ]}
  ],
});
```

**Key internal functions:**

**(a) `createBrowserSession()`**
- Creates BrowserBase session
- Connects Playwright via CDP: `chromium.connectOverCDP(session.connectUrl)`
- Returns `{ browser, page, sessionId }`
- Session always cleaned up in `finally` block

**(b) `analyzePageForContent(page, screenshot, query)`**
- Takes full-page screenshot (PNG buffer)
- Extracts page text via `document.body.innerText` (truncated to 4000 chars)
- Gets all links: `{ text, href }` for `<a>` tags
- Sends to Claude Sonnet Vision via `generateObject()` with zod schema
- Returns structured analysis:
  - `relevantSections[]`: each with description, locator strategy, locator value, extracted text, relevance score
  - `linksToFollow[]`: each with URL, reason, priority (1-3)
  - `pageSummary`: brief description for progress updates

**(c) `captureElementScreenshot(page, section)`**
- Locates DOM elements using a **fallback chain** (most reliable first):
  1. Text matching: `page.getByText(value)` — most reliable since Claude reads text accurately
  2. Heading role: `page.getByRole('heading', { name: value })` then screenshot parent container
  3. CSS selector: `page.locator(value)`
  4. Viewport region fallback: scroll to approximate area, take viewport screenshot
- After finding element, walks up DOM to a meaningful container (`<section>`, `<article>`, or `<div>` with reasonable dimensions)
- Caps screenshot height at 2000px
- Returns `{ screenshotBuffer, boundingBox }`

**(d) `browsingLoop()` — the orchestrator**
- Maintains a priority queue of URLs to visit (same-domain only)
- Visits up to `maxPages` (default 5), collects up to 20 findings
- For each page: navigate → dismiss overlays → screenshot → analyze → capture sections → queue links
- Errors for individual sections are caught and logged, don't stop the run
- Total timeout: 3 minutes — returns partial results if exceeded

**(e) `dismissOverlays(page)`**
- Tries to close cookie banners, popups via common selectors
- Each attempt wrapped in try-catch with 1-second timeout
- Best-effort, not exhaustive

### 4. `lib/slack-handler.ts`

Handles Slack-specific logic, separate from the webhook route.

**Key functions:**

**(a) `handleSlackMessage(event, client)`**
1. **Post initial reply** in thread — "Working on it..."
2. **Parse query** — call Claude to extract `ParsedQuery` from message text
3. **Run browser agent** — progress callback updates the Slack message in-place via `client.chat.update()`
4. **Post results** — summary message + screenshot file uploads with extracted text

**(b) `uploadResults(findings, channel, threadTs, client)`**
- Uploads screenshots via `client.files.uploadV2()` with `initial_comment` containing the text
- 1-second spacing between uploads (Slack rate limits)
- Max 8 screenshot uploads per request; remainder summarized as text-only

**Result format in Slack:**
```
[Thread under user's message]
Bot: "Done! Found 5 sections across 3 pages." (final status update)
Bot: [screenshot-1.png]
     Source: https://ycombinator.com/about
     "We fund founders who are working on ambitious problems..."
Bot: [screenshot-2.png]
     ...
```

**Error messages (user-facing):**
- Can't parse query → "Please include a website and describe what you're looking for"
- Site unreachable → "Could not access [url]. Site may be down."
- No content found → "Visited N pages but couldn't find content matching '[objective]'"
- Auth required → "This page requires login. I can only access public pages."
- Timeout → "Timed out. Here are the partial results found so far."

### 5. `app/api/slack/route.ts`

Next.js API route that handles the Slack webhook:

```typescript
export async function POST(request: Request) {
  // 1. Verify Slack request signature
  // 2. Handle URL verification challenge (Slack sends this on setup)
  // 3. Parse event
  // 4. Respond with 200 immediately (Slack's 3-second requirement)
  // 5. Process message asynchronously (fire-and-forget via waitUntil)
}
```

Uses `waitUntil()` from `@vercel/functions` to continue processing after responding with 200.

---

## Claude Prompts Strategy

### Prompt 1: Query Parsing

Uses `generateObject()` with a zod schema for guaranteed structured output.

**Model:** `claude-sonnet-4-20250514`

**Prompt:** "Parse this user request about finding content on a website. Extract the target URL and what they're looking for."

If user says "Y Combinator's website" without URL, Claude infers `https://ycombinator.com`. If truly ambiguous, returns `targetUrl: null` and bot asks for clarification.

### Prompt 2: Page Analysis (Vision)

Uses `generateObject()` with a zod schema + image input.

**Model:** `claude-sonnet-4-20250514`

**Input:** Full-page screenshot (image) + page text (4000 chars) + links list + search objective

**System:** Detailed instructions for identifying relevant sections and suggesting links. Instructs Claude to prefer text-based locators, be selective (not exhaustive), score relevance honestly, and ignore social/login/privacy links.

**Cost estimate:** Claude Sonnet is ~$3/M input, $15/M output. At ~14,500 tokens per request, that's roughly $0.05-0.10 per request.

---

## Error Handling

| Error | Handling |
|-------|----------|
| Site unreachable | Catch in `page.goto`, report to user |
| Page blank/broken | Check `innerText.length < 50`, report |
| Auth required (401/403) | Detect via response status, report |
| Anthropic API error | Retry once with backoff, then report |
| BrowserBase error | Report service unavailable |
| Element not found | Skip silently, add to errors array |
| Slack upload failure | Retry once, fall back to text-only |
| Total timeout (>3min) | Return partial results collected so far |
| Vercel function timeout | Use `maxDuration` config; return partials if hit |

All errors logged server-side with stack traces; user messages are friendly.

---

## Implementation Order

Each step is testable before moving to the next:

1. **Project setup** — `create-next-app`, install deps, configure env vars
2. **`lib/types.ts` + `lib/config.ts`** — foundation
3. **`lib/browser-agent.ts` — session management** — verify BrowserBase connection + basic navigation
4. **`lib/browser-agent.ts` — page analysis** — add Claude Sonnet Vision call via AI SDK, test on a single page
5. **`lib/browser-agent.ts` — element capture** — add fallback locator chain, test screenshots
6. **`lib/browser-agent.ts` — full browsing loop** — wire together with link following
7. **`app/api/slack/route.ts` + `lib/slack-handler.ts`** — Slack webhook + message handling
8. **ngrok setup** — test locally end-to-end
9. **Deploy to Vercel** — production readiness

---

## Local Development

```bash
# Terminal 1: Start Next.js dev server
npm run dev

# Terminal 2: Start ngrok tunnel
ngrok http 3000

# Copy the ngrok HTTPS URL and set it as:
# Slack app → Event Subscriptions → Request URL: https://<ngrok-id>.ngrok.io/api/slack
```

---

## Verification / Testing

1. **Manual smoke test:** Start dev server + ngrok, DM the bot: "get me screenshots of copy on example.com about their purpose"
2. **Real-world test:** "get me screenshots of copy on ycombinator.com about the type of founders they back" — verify screenshots show relevant YC content about founders
3. **Edge cases to test:**
   - Site with heavy JS (SPA)
   - Site with cookie banners
   - Very long pages
   - Site that 404s or is down
   - Query with no clear URL ("what does Stripe say about pricing?")
4. **Verify genericity:** Clone repo fresh, set up own API keys, confirm it works without any code changes
5. **Deploy to Vercel** and test with the production URL

---

## Slack App Setup (for users)

Users need to create a Slack app at api.slack.com/apps:
- **Bot Token Scopes:** `chat:write`, `files:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`
- **Event Subscriptions:** Enable, set Request URL to `https://<your-domain>/api/slack`
  - Subscribe to: `app_mention`, `message.im`
- Install to workspace → generates Bot Token and Signing Secret

---

## Vercel Deployment

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard
# Update Slack Event Subscriptions URL to production Vercel URL
```

Vercel free tier supports serverless functions with up to 60-second execution time. For longer browsing sessions, consider Vercel Pro (300-second limit) or splitting the work.
