import { renderPng } from "./browser";
import { translateToEnglish } from "./deepl";
import { isEnglish, isUkrainian } from "./language";
import { claimPost, releasePost, settlePost } from "./posts";
import { authorOf, isStartCommand, parseMessage, reply, type Message } from "./telegram";
import { syncThreadPhoto } from "./thread-photo";
import {
  getThread,
  rememberName,
  rememberThreadPost,
  saveComment,
  setTranslation,
  type Thread,
} from "./threads";
import type { Deps, Upstream } from "./upstream";

export const WEBHOOK_PATH = "/telegram/webhook";
export const START_REPLY =
  "Bot is running! I translate Ukrainian channel posts and their comments to English, as one picture per post that updates as people comment.";

const liveDeps = (env: Env): Deps => ({
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => scheduler.wait(ms),
  now: () => Math.floor(Date.now() / 1000),
  render: (html) => renderPng(env.BROWSER, html),
});

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

const isUkrainianText = (source: string) => !isEnglish(source) && isUkrainian(source);

/**
 * Runs once per post or comment: `update` writes it into the thread, then the thread's
 * photo is sent or redrawn. Transient failures release the claim so Telegram redelivers.
 */
async function updateThread(
  env: Env,
  deps: Deps,
  message: Message,
  thread: Thread,
  kind: "post" | "comment",
  update: () => Promise<Upstream<void>>,
): Promise<Response> {
  const ids = { kind, chat_id: message.chat.id, message_id: message.message_id };
  const claim = await claimPost(env.DB, message.chat.id, message.message_id, deps.now());
  if (!claim.claimed) {
    log("already_claimed", { ...ids, state: claim.state });
    return claim.state === "pending" ? text(503, "in progress") : text(200, "duplicate");
  }

  const started = Date.now();
  const updated = await update();
  const translated = Date.now();
  const synced = updated.ok
    ? await syncThreadPhoto(env, deps, thread.chatId, thread.postId)
    : updated;
  const timing = {
    // message.date has 1-second resolution, so this is Telegram's delivery delay give or take a second.
    delivery_lag_s: Math.floor(started / 1000) - message.date,
    translate_ms: translated - started,
    photo_ms: Date.now() - translated,
  };

  if (synced.ok) {
    await settlePost(env.DB, message.chat.id, message.message_id, deps.now(), {
      state: "done",
      replyMessageId: synced.value ?? 0,
    });
    log("thread_updated", { ...ids, photo_message_id: synced.value, ...timing });
    return text(200, "translated");
  }
  const stage = updated.ok ? "photo" : "deepl";
  if (synced.transient) {
    await releasePost(env.DB, message.chat.id, message.message_id);
    log("thread_retry", { ...ids, stage, detail: synced.detail });
    return text(503, "retry");
  }
  await settlePost(env.DB, message.chat.id, message.message_id, deps.now(), {
    state: "failed",
    error: `${stage}: ${synced.detail}`,
  });
  log("thread_failed", { ...ids, stage, detail: synced.detail });
  return text(200, "failed");
}

async function handlePost(env: Env, deps: Deps, message: Message, source: string) {
  const chatId = message.chat.id;
  if (message.sender_chat?.title) {
    await rememberName(env.DB, message.sender_chat.id, message.sender_chat.title);
  }
  await rememberThreadPost(env.DB, chatId, message.message_id, source, message.date);
  if (!source) return text(200, "no text");
  if (!isUkrainianText(source)) {
    log("not_ukrainian", { kind: "post", message_id: message.message_id });
    return text(200, "not ukrainian");
  }
  const thread = (await getThread(env.DB, chatId, message.message_id))!;
  return updateThread(env, deps, message, thread, "post", async () => {
    const translated = await translateToEnglish(deps, env.DEEPL_API_KEY, source);
    if (!translated.ok) return translated;
    await setTranslation(env.DB, thread, translated.value);
    return { ok: true, value: undefined };
  });
}

async function handleComment(env: Env, deps: Deps, message: Message, source: string) {
  const postId = message.message_thread_id ?? message.reply_to_message?.message_id;
  const thread = postId === undefined ? undefined : await getThread(env.DB, message.chat.id, postId);
  if (!thread) {
    log("thread_unknown", { message_id: message.message_id, thread_id: postId });
    return text(200, "unknown thread");
  }
  if (!source) return text(200, "no text");
  const author = authorOf(message);
  const save = (english: string) =>
    saveComment(env.DB, thread, {
      messageId: message.message_id,
      authorId: author.id,
      authorName: author.name,
      text: english,
      date: message.date,
    });
  // Other languages are kept as written, but never start a picture on their own. They show up
  // once a Ukrainian comment starts it, so the picture has the whole conversation.
  const ukrainian = isUkrainianText(source);
  if (!ukrainian && !thread.photoMessageId) {
    await save(source);
    log("comment_saved_for_later", { message_id: message.message_id });
    return text(200, "saved");
  }

  return updateThread(env, deps, message, thread, "comment", async () => {
    let english = source;
    if (ukrainian) {
      const translated = await translateToEnglish(
        deps,
        env.DEEPL_API_KEY,
        source,
        commentContext(message, thread),
      );
      if (!translated.ok) return translated;
      english = translated.value;
    }
    await save(english);
    return { ok: true, value: undefined };
  });
}

// A direct comment replies to the post itself. A nested one replies to another comment,
// and Telegram leaves the post out, so it comes from the stored thread.
function commentContext(message: Message, thread: Thread): string | undefined {
  const parent = message.reply_to_message;
  const parentText = parent?.text ?? parent?.caption;
  if (parent?.message_id === thread.postId || !thread.text) return parentText;
  return parentText ? `Post: ${thread.text}\nComment: ${parentText}` : thread.text;
}

async function handleMessage(env: Env, deps: Deps, message: Message): Promise<Response> {
  if (isStartCommand(message)) {
    const sent = await reply(deps, env.TELEGRAM_BOT_TOKEN, message, START_REPLY);
    if (!sent.ok) log("start_reply_failed", { detail: sent.detail });
    return sent.ok || !sent.transient ? text(200, "start") : text(503, "retry");
  }

  const groupId = Number(env.DISCUSSION_GROUP_ID);
  if (message.chat.type !== "supergroup" || message.chat.id !== groupId) {
    return text(200, "ignored");
  }
  // Bots never receive other bots' group messages, so `from.is_bot` only marks anonymous
  // admins (GroupAnonymousBot) and comments sent as the channel. Those are comments too.
  const isPost =
    message.is_automatic_forward === true && message.sender_chat?.id === Number(env.CHANNEL_ID);
  const isComment =
    !isPost && (message.message_thread_id !== undefined || message.reply_to_message !== undefined);
  if (!isPost && !isComment) {
    log("group_message_ignored", { message_id: message.message_id, sender_chat: message.sender_chat?.id });
    return text(200, "ignored");
  }

  const age = deps.now() - message.date;
  if (age > Number(env.MESSAGE_MAX_AGE_SECONDS)) {
    log("too_old", { kind: isPost ? "post" : "comment", message_id: message.message_id, age });
    return text(200, "too old");
  }

  const source = message.text ?? message.caption ?? "";
  return isPost
    ? handlePost(env, deps, message, source)
    : handleComment(env, deps, message, source);
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
  fetch: (request, env) => handleRequest(request, env, liveDeps(env)),
} satisfies ExportedHandler<Env>;
