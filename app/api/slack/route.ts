import { NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { waitUntil } from "@vercel/functions";
import crypto from "crypto";
import { handleSlackMessage } from "@/lib/slack-handler";

// Vercel: allow the function up to 60s (Hobby max). Upgrade to Pro for 300s.
export const maxDuration = 60;

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBasestring)
      .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(signature)
  );
}

export async function POST(request: Request) {
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") || "";
  const signature = request.headers.get("x-slack-signature") || "";

  // Verify signature
  if (!verifySlackSignature(body, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(body);

  // Handle Slack URL verification challenge
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Handle events
  if (payload.type === "event_callback") {
    const event = payload.event;

    // Only handle messages and app_mentions, ignore bot messages
    if (
      (event.type === "message" || event.type === "app_mention") &&
      !event.bot_id &&
      !event.subtype
    ) {
      // Respond to Slack within 3 seconds, process async
      waitUntil(
        handleSlackMessage(
          {
            text: event.text || "",
            channel: event.channel,
            ts: event.ts,
            user: event.user,
          },
          slackClient
        )
      );
    }
  }

  // Always respond with 200 quickly
  return NextResponse.json({ ok: true });
}
