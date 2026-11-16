export {};

const WEBHOOK_URL = "https://tg-translator.oliinyk.dev/telegram/webhook";
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
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error("Set TELEGRAM_WEBHOOK_SECRET to the value stored with wrangler");
  await call("setWebhook", {
    url: WEBHOOK_URL,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: flags.includes("--drop-pending"),
  });
} else if (command === "delete") {
  await call("deleteWebhook", { drop_pending_updates: false });
} else {
  throw new Error("Usage: bun run webhook [info|set [--drop-pending]|delete]");
}
