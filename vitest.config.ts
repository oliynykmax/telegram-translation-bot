import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("migrations"),
          TELEGRAM_BOT_TOKEN: "test-bot-token",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
          DEEPL_API_KEY: "test-deepl-key:fx",
          CHANNEL_ID: "-1001000000001",
          DISCUSSION_GROUP_ID: "-1001000000002",
        },
      },
    }),
  ],
}));
