# Screenshot Tool

A Slack bot that finds and screenshots content on websites using natural language.

Ask it something like:

> find copy on this website that explains what type of founders they back — https://axiompartners.vc/

and it will browse the site, read the pages, and reply with a short summary, supporting bullet points, and targeted screenshots of the relevant sections.

---

## How it works

1. **You send a message** in Slack — mention the bot or DM it, describing what you're looking for and which site.
2. **Claude parses your request** to figure out the target URL and what content to find.
3. **A cloud browser** (via BrowserBase + Playwright) visits the site, dismisses cookie banners, and takes full-page screenshots.
4. **Claude Vision analyzes each page** — identifying which sections match your query and which links are worth following next.
5. **Element-level screenshots** are taken of the relevant sections, and the text is extracted.
6. **Claude synthesizes** all findings into a summary + bullet points + a few supporting screenshots.
7. **Results post back to Slack** as a thread under your original message.

---

## Prerequisites

You'll need **your own** API keys / accounts for:

| Service | What it does | Sign up |
|---------|-------------|---------|
| [Anthropic](https://console.anthropic.com) | Claude API (query parsing, vision analysis, synthesis) | Add credits — runs cost ~$0.05-0.10 each |
| [BrowserBase](https://browserbase.com) | Cloud browser sessions | Free tier: 1 browser hour/month |
| [Slack](https://api.slack.com/apps) | Slack bot/app | Free |

Plus:
- Node.js 20+
- A Slack workspace where you can install apps
- (For local dev only) [ngrok](https://ngrok.com) to tunnel Slack webhooks to your machine

---

## Run locally

### 1. Clone and install

```bash
git clone <this-repo-url>
cd screenshot-tool
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env.local
```

Fill in the values in `.env.local`:

```
ANTHROPIC_API_KEY=          # From console.anthropic.com
BROWSERBASE_API_KEY=        # From browserbase.com dashboard
BROWSERBASE_PROJECT_ID=     # From browserbase.com → Settings
SLACK_BOT_TOKEN=            # xoxb-... (see Slack setup below)
SLACK_SIGNING_SECRET=       # From your Slack app's Basic Information page
NGROK_AUTHTOKEN=            # Local dev only — from dashboard.ngrok.com/get-started/your-authtoken
```

Install ngrok (Mac): `brew install ngrok`. Grab your authtoken from [ngrok's dashboard](https://dashboard.ngrok.com/get-started/your-authtoken).

### 3. Create a Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest**
2. Pick your workspace
3. Paste this YAML:

```yaml
display_information:
  name: Screenshot Bot
  description: Find and screenshot content on websites using natural language
features:
  bot_user:
    display_name: Screenshot Bot
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - files:write
      - im:history
      - im:read
      - im:write
      - reactions:write
settings:
  event_subscriptions:
    request_url: https://example.com/api/slack
    bot_events:
      - app_mention
      - message.im
  socket_mode_enabled: false
```

4. Create → **Install to Workspace** → Allow
5. Copy the **Bot User OAuth Token** (starts with `xoxb-`) into `.env.local`
6. Go to **Basic Information** → copy the **Signing Secret** into `.env.local`

### 4. Start the dev server

```bash
npm run dev
```

This starts Next.js **and** the ngrok tunnel together. Look for the `Forwarding` line in the ngrok output — it shows your public URL like `https://abc-123.ngrok-free.dev`. Copy it.

Pressing `Ctrl+C` stops both processes.

### 5. Point Slack at your ngrok URL

1. In your Slack app → **Event Subscriptions**
2. Set **Request URL** to `https://abc-123.ngrok-free.dev/api/slack`
3. Wait for green "Verified ✓" and click **Save Changes**

### 6. Test

In Slack, DM your bot:

> find copy on https://axiompartners.vc about the kind of founders they back

Watch the 👀 reaction appear, then ✅ when done. Results post in a thread.

> **Note:** The ngrok URL changes every time you restart ngrok. For a permanent setup, deploy to Vercel (below).

---

## Deploy to Vercel

Deploying gives you a permanent URL, runs the bot 24/7, and you don't need your laptop on.

### 1. Push to GitHub

```bash
git push origin main
```

### 2. Import into Vercel

1. Go to https://vercel.com/new
2. **Import** your GitHub repo
3. Framework preset will auto-detect as **Next.js**
4. Expand **Environment Variables** and add all 5 from your `.env.local`
5. Click **Deploy**

You'll get a URL like `https://your-project.vercel.app`.

### 3. Update Slack's Event Subscription URL

Replace the ngrok URL with your Vercel URL:

```
https://your-project.vercel.app/api/slack
```

Wait for green "Verified ✓" and **Save Changes**.

### 4. Done

The bot now runs on Vercel. Every push to `main` triggers a new deployment.

### Important: Vercel timeout limits

- **Hobby (free):** 60-second function timeout — the code is configured for this
- **Pro ($20/mo):** up to 300 seconds — useful if you want deeper crawls

Current defaults: 3 pages max, 50-second agent timeout. To crawl deeper, increase `maxPages` in `lib/slack-handler.ts` and `maxDuration` in `app/api/slack/route.ts` — requires Pro.

---

## Project structure

```
screenshot-tool/
├── app/
│   └── api/slack/route.ts   # Slack webhook handler
├── lib/
│   ├── browser-agent.ts     # Core: BrowserBase + Playwright + Claude Vision
│   ├── slack-handler.ts     # Message handling, synthesis, Slack uploads
│   ├── config.ts            # Env var validation
│   └── types.ts             # Shared types
├── scripts/
│   └── test-agent.ts        # CLI: test the agent without Slack
├── CLAUDE.md                # Implementation spec (design doc)
├── .env.example             # Template for required env vars
└── .env.local               # Your keys (gitignored — don't commit)
```

---

## Testing without Slack

You can run the agent directly from the command line to verify your BrowserBase + Anthropic keys work:

```bash
npx tsx scripts/test-agent.ts "https://axiompartners.vc" "what type of founders they back"
```

Screenshots save to `test-output/`.

---

## Cost estimate

Each request to the bot costs roughly **$0.05–0.15**:
- Claude API: ~$0.05 per request (3 pages × ~$0.015 each + synthesis)
- BrowserBase: ~3-5 seconds of browser time per request

Slack and Vercel (Hobby tier) are free.

