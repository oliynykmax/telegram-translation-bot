import { translateToEnglish } from "./deepl";
import { isEnglish, isUkrainian } from "./language";
import { claimPost, releasePost, settlePost } from "./posts";
import { isStartCommand, parseMessage, reply, type Message } from "./telegram";
import type { Deps } from "./upstream";

export const WEBHOOK_PATH = "/telegram/webhook";
export const START_REPLY =
  "Bot is running! I will automatically translate Ukrainian channel posts to English in the comments.";

const liveDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => scheduler.wait(ms),
  now: () => Math.floor(Date.now() / 1000),
};

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

const text = (status: number, body: string) => new Response(body, { status });

async function secretMatches(provided: string | null, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const a = encoder.encode(provided ?? "");
  const b = encoder.encode(expected);
  if (a.byteLength !== b.byteLength) return !crypto.subtle.timingSafeEqual(b, b);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function translatePost(env: Env, deps: Deps, message: Message, source: string) {
  const ids = { chat_id: message.chat.id, message_id: message.message_id };
  const claim = await claimPost(env.DB, message.chat.id, message.message_id, deps.now());
  if (!claim.claimed) {
    log("post_already_claimed", { ...ids, state: claim.state });
    return claim.state === "pending" ? text(503, "in progress") : text(200, "duplicate");
  }

  const translated = await translateToEnglish(deps, env.DEEPL_API_KEY, source);
  const sent = translated.ok
    ? await reply(deps, env.TELEGRAM_BOT_TOKEN, message, translated.value)
    : translated;

  if (sent.ok) {
    await settlePost(env.DB, message.chat.id, message.message_id, deps.now(), {
      state: "done",
      replyMessageId: sent.value,
    });
    log("translation_posted", { ...ids, reply_message_id: sent.value });
    return text(200, "translated");
  }
  const stage = translated.ok ? "telegram" : "deepl";
  if (sent.transient) {
    await releasePost(env.DB, message.chat.id, message.message_id);
    log("translation_retry", { ...ids, stage, detail: sent.detail });
    return text(503, "retry");
  }
  await settlePost(env.DB, message.chat.id, message.message_id, deps.now(), {
    state: "failed",
    error: `${stage}: ${sent.detail}`,
  });
  log("translation_failed", { ...ids, stage, detail: sent.detail });
  return text(200, "failed");
}

async function handleMessage(env: Env, deps: Deps, message: Message): Promise<Response> {
  if (isStartCommand(message)) {
    const sent = await reply(deps, env.TELEGRAM_BOT_TOKEN, message, START_REPLY);
    if (!sent.ok) log("start_reply_failed", { detail: sent.detail });
    return sent.ok || !sent.transient ? text(200, "start") : text(503, "retry");
  }

  const channelId = Number(env.CHANNEL_ID);
  const groupId = Number(env.DISCUSSION_GROUP_ID);
  if (
    message.chat.type !== "supergroup" ||
    message.chat.id !== groupId ||
    message.sender_chat?.id !== channelId
  ) {
    return text(200, "ignored");
  }

  const maxAge = Number(env.MESSAGE_MAX_AGE_SECONDS);
  if (deps.now() - message.date > maxAge) {
    log("post_too_old", { message_id: message.message_id, age: deps.now() - message.date });
    return text(200, "too old");
  }

  const source = message.text ?? message.caption;
  if (!source) return text(200, "no text");
  if (isEnglish(source)) return text(200, "english");
  if (!isUkrainian(source)) return text(200, "not ukrainian");

  return translatePost(env, deps, message, source);
}

export async function handleRequest(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") return text(200, "ok");
  if (url.pathname !== WEBHOOK_PATH) return text(404, "not found");
  if (request.method !== "POST") return text(405, "method not allowed");

  if (!env.TELEGRAM_WEBHOOK_SECRET || !Number(env.CHANNEL_ID) || !Number(env.DISCUSSION_GROUP_ID)) {
    log("config_error", {
      detail: "TELEGRAM_WEBHOOK_SECRET must be set and CHANNEL_ID, DISCUSSION_GROUP_ID numeric",
    });
    return text(500, "misconfigured");
  }

  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!(await secretMatches(secret, env.TELEGRAM_WEBHOOK_SECRET))) {
    return text(401, "unauthorized");
  }

  const update = await request.json().catch(() => undefined);
  if (update === undefined) return text(400, "invalid json");
  const message = parseMessage(update);
  return message ? handleMessage(env, deps, message) : text(200, "ignored");
}

export default {
  fetch: (request, env) => handleRequest(request, env, liveDeps),
} satisfies ExportedHandler<Env>;
