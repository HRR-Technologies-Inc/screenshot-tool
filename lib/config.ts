export interface Config {
  anthropicApiKey: string;
  browserbaseApiKey: string;
  browserbaseProjectId: string;
  slackBotToken: string;
  slackSigningSecret: string;
}

export function loadConfig(): Config {
  const required = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    BROWSERBASE_API_KEY: process.env.BROWSERBASE_API_KEY,
    BROWSERBASE_PROJECT_ID: process.env.BROWSERBASE_PROJECT_ID,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join("\n")}\n\nCopy .env.example to .env.local and fill in the values.`
    );
  }

  return Object.freeze({
    anthropicApiKey: required.ANTHROPIC_API_KEY!,
    browserbaseApiKey: required.BROWSERBASE_API_KEY!,
    browserbaseProjectId: required.BROWSERBASE_PROJECT_ID!,
    slackBotToken: required.SLACK_BOT_TOKEN!,
    slackSigningSecret: required.SLACK_SIGNING_SECRET!,
  });
}
