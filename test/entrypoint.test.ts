import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("deployed entrypoint", () => {
  it("serves health and rejects unauthenticated webhooks", async () => {
    const health = await exports.default.fetch("https://tg-translator.oliinyk.dev/");
    expect(await health.text()).toBe("ok");
    const webhook = await exports.default.fetch("https://tg-translator.oliinyk.dev/telegram/webhook", {
      method: "POST",
      body: "{}",
    });
    expect(webhook.status).toBe(401);
  });
});
