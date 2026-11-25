export {};

// Public origin of the deployed Worker, e.g. https://tg-translator.<your-subdomain>.workers.dev
const WORKER_URL = process.env.WORKER_URL?.replace(/\/+$/, "");
// Shown on the bot's profile (at most 120 characters) and in an empty chat (at most 512).
const SHORT_DESCRIPTION =
  "Translates Neuromax posts and comments to English. Channel members can DM me to translate.";
const DESCRIPTION = `I translate Ukrainian posts in the Neuromax channel and their comments to English, as one picture per post that updates as people comment.

Members of the channel or its chat can also message me directly: I translate any language to English, and English to Ukrainian.

In a group, reply to a message with @neuromax_translate_bot or /translate to translate it.`;
const [command = "info", ...flags] = process.argv.slice(2);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in the environment or a gitignored .env file");

async function call(method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  console.log(JSON.stringify(await response.json(), null, 2));
}

if (command === "info") {
  await call("getWebhookInfo");
} else if (command === "set") {
  if (!WORKER_URL) throw new Error("Set WORKER_URL to the Worker's public origin");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error("Set TELEGRAM_WEBHOOK_SECRET to the value stored with wrangler");
  await call("setWebhook", {
    url: `${WORKER_URL}/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "edited_message"],
    drop_pending_updates: flags.includes("--drop-pending"),
  });
} else if (command === "describe") {
  await call("setMyShortDescription", { short_description: SHORT_DESCRIPTION });
  await call("setMyDescription", { description: DESCRIPTION });
  await call("setMyCommands", {
    commands: [{ command: "translate", description: "Translate the message you reply to, or the text after it" }],
  });
} else if (command === "delete") {
  await call("deleteWebhook", { drop_pending_updates: false });
} else {
  throw new Error("Usage: bun run webhook [info|set [--drop-pending]|describe|delete]");
}
