// Polls ngrok's local inspection API until a tunnel is available,
// then prints a clear message with the URL to paste into Slack.

async function main() {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch("http://localhost:4040/api/tunnels");
      if (res.ok) {
        const data = (await res.json()) as {
          tunnels: Array<{ public_url: string }>;
        };
        if (data.tunnels && data.tunnels.length > 0) {
          const url = data.tunnels[0].public_url;
          const slackUrl = `${url}/api/slack`;
          const line = "─".repeat(70);
          console.log(`\n\x1b[32m${line}`);
          console.log(`  ✓ NGROK TUNNEL READY`);
          console.log(`${line}\x1b[0m`);
          console.log(`\n  Public URL:  \x1b[36m${url}\x1b[0m`);
          console.log(`  Slack URL:   \x1b[36m\x1b[1m${slackUrl}\x1b[0m\n`);
          console.log(`  \x1b[33m→ Paste the Slack URL into your Slack app:\x1b[0m`);
          console.log(`     api.slack.com/apps → your app → Event Subscriptions → Request URL`);
          console.log(`\n\x1b[32m${line}\x1b[0m\n`);
          return;
        }
      }
    } catch {
      // ngrok not up yet, keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("\n\x1b[31m[print-ngrok-url] Timed out waiting for ngrok tunnel\x1b[0m");
  process.exit(1);
}

main();
