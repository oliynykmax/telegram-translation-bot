import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleRequest, START_REPLY, WEBHOOK_PATH } from "../src/index";
import { isEnglish, isUkrainian } from "../src/language";
import type { Deps } from "../src/upstream";

const NOW = 1_800_000_000;
const CHANNEL = -1001000000001;
const GROUP = -1001000000002;
const UKRAINIAN = "Привіт, світе! Сьогодні гарний день.";

type Route = (url: string, body: unknown) => Response | Promise<Response>;

function fakeDeps(route: Route) {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const sleeps: number[] = [];
  const deps: Deps = {
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
    fetch: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body, headers: new Headers(init?.headers) });
      return route(url, body);
    },
  };
  const to = (host: string) => calls.filter((c) => c.url.includes(host));
  return { deps, calls, sleeps, deepl: () => to("deepl.com"), telegram: () => to("api.telegram.org") };
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers });

const healthyRoute: Route = (url, body: any) =>
  url.includes("deepl.com")
    ? json({ translations: [{ text: `EN(${body.text[0]})` }] })
    : json({ ok: true, result: { message_id: 777 } });

function channelPost(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      date: NOW - 2,
      chat: { id: GROUP, type: "supergroup" },
      sender_chat: { id: CHANNEL, type: "channel" },
      is_automatic_forward: true,
      text: UKRAINIAN,
      ...overrides,
    },
  };
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 50,
    sender_chat: undefined,
    is_automatic_forward: undefined,
    from: { id: 5, is_bot: false },
    message_thread_id: 42,
    reply_to_message: { message_id: 42, text: "Порада дня: спробуйте техніку «помідора»." },
    ...overrides,
  };
}

function webhook(update: unknown, secret: string | null = env.TELEGRAM_WEBHOOK_SECRET) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (secret !== null) headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
  return new Request(`https://tg-translator.oliinyk.dev${WEBHOOK_PATH}`, {
    method: "POST",
    headers,
    body: typeof update === "string" ? update : JSON.stringify(update),
  });
}

const postRow = (messageId = 42) =>
  env.DB.prepare("SELECT state, reply_message_id, error FROM posts WHERE message_id = ?1")
    .bind(messageId)
    .first<{ state: string; reply_message_id: number | null; error: string | null }>();

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.exec("DELETE FROM posts; DELETE FROM thread_posts;");
});

describe("language detection matches the Python bot", () => {
  it.each([
    ["Привіт, як справи?", true, false],
    ["Привет, как дела?", true, false],
    ["Hello, this is an English post.", false, true],
    ["Hello world with a word привіт", true, false],
    ["12345 !!!", false, false],
    ["Hola, ¿qué tal?", false, true],
    ["Ёлка ёж ЁЖ", true, false],
    ["Сьогодні OpenAI випустила GPT", true, false],
    ["Мир", true, false],
  ])("%s", (text, ukrainian, english) => {
    expect(isUkrainian(text)).toBe(ukrainian);
    expect(isEnglish(text)).toBe(english);
  });
});

describe("webhook auth and routing", () => {
  it("rejects a missing or wrong secret token without calling upstreams", async () => {
    const fake = fakeDeps(healthyRoute);
    expect((await handleRequest(webhook(channelPost(), null), env, fake.deps)).status).toBe(401);
    expect((await handleRequest(webhook(channelPost(), "wrong"), env, fake.deps)).status).toBe(401);
    expect(
      (await handleRequest(webhook(channelPost(), `${env.TELEGRAM_WEBHOOK_SECRET}x`), env, fake.deps))
        .status,
    ).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it("serves health, 404 and 405", async () => {
    const fake = fakeDeps(healthyRoute);
    const get = (path: string, method = "GET") =>
      handleRequest(new Request(`https://x${path}`, { method }), env, fake.deps);
    expect((await get("/")).status).toBe(200);
    expect((await get("/other")).status).toBe(404);
    expect((await get(WEBHOOK_PATH)).status).toBe(405);
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await handleRequest(webhook("{not json"), env, fakeDeps(healthyRoute).deps);
    expect(res.status).toBe(400);
  });

  it.each([
    ["an empty chat id", { CHANNEL_ID: "" }],
    ["an empty webhook secret", { TELEGRAM_WEBHOOK_SECRET: "" }],
  ])("fails closed with %s", async (_, overrides) => {
    const fake = fakeDeps(healthyRoute);
    const res = await handleRequest(webhook(channelPost(), "undefined"), { ...env, ...overrides }, fake.deps);
    expect(res.status).toBe(500);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("translation", () => {
  it("translates a Ukrainian channel post and replies to it in the discussion group", async () => {
    const fake = fakeDeps(healthyRoute);
    const res = await handleRequest(webhook(channelPost()), env, fake.deps);
    expect(res.status).toBe(200);

    const [deepl] = fake.deepl();
    expect(deepl.url).toBe("https://api-free.deepl.com/v2/translate");
    expect(deepl.headers.get("Authorization")).toBe(`DeepL-Auth-Key ${env.DEEPL_API_KEY}`);
    expect(deepl.body).toEqual({ text: [UKRAINIAN], source_lang: "UK", target_lang: "EN-US" });

    const [send] = fake.telegram();
    expect(send.url).toBe(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`);
    expect(send.body).toEqual({
      chat_id: GROUP,
      text: `EN(${UKRAINIAN})`,
      reply_parameters: { message_id: 42 },
    });
    expect(await postRow()).toEqual({ state: "done", reply_message_id: 777, error: null });
  });

  it("uses the pro DeepL endpoint for keys without the :fx suffix", async () => {
    const fake = fakeDeps(healthyRoute);
    await handleRequest(webhook(channelPost()), { ...env, DEEPL_API_KEY: "pro-key" }, fake.deps);
    expect(fake.deepl()[0].url).toBe("https://api.deepl.com/v2/translate");
  });

  it("translates photo captions", async () => {
    const fake = fakeDeps(healthyRoute);
    await handleRequest(webhook(channelPost({ text: undefined, caption: UKRAINIAN })), env, fake.deps);
    expect(fake.telegram()[0].body.text).toBe(`EN(${UKRAINIAN})`);
  });

  it.each([
    ["English posts", { text: "This post is already written in English." }],
    ["non-Ukrainian posts", { text: "Hola, ¿qué tal? Buenos días." }],
    ["posts without text", { text: undefined }],
    ["posts older than the age window", { date: NOW - 301 }],
    ["group messages outside a comment thread", { sender_chat: undefined, from: { id: 5, is_bot: false } }],
    ["channel messages that are not automatic forwards or in a thread", { is_automatic_forward: undefined }],
    ["English comments", { ...comment(), text: "Great post, thanks for sharing!" }],
    ["other chats", { chat: { id: -100999, type: "supergroup" } }],
  ])("skips %s", async (_, overrides) => {
    const fake = fakeDeps(healthyRoute);
    const res = await handleRequest(webhook(channelPost(overrides)), env, fake.deps);
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(0);
    expect(await postRow()).toBeNull();
  });

  it.each([
    ["a direct comment under a post", comment()],
    ["a reply to another comment", comment({ reply_to_message: { message_id: 49, text: "А запис стріму буде?" } })],
  ])("translates %s and replies to that comment", async (_, overrides) => {
    const fake = fakeDeps(healthyRoute);
    const res = await handleRequest(webhook(channelPost(overrides)), env, fake.deps);
    expect(res.status).toBe(200);
    expect(fake.deepl()[0].body.context).toBe(
      (overrides.reply_to_message as { text: string }).text,
    );
    expect(fake.telegram()[0].body).toEqual({
      chat_id: GROUP,
      text: `EN(${UKRAINIAN})`,
      reply_parameters: { message_id: 50 },
    });
    expect(await postRow(50)).toEqual({ state: "done", reply_message_id: 777, error: null });
  });

  it("gives a nested reply both the channel post and the comment it answers as context", async () => {
    const post = "Ділюся сетапом: клавіатура з коричневими світчами.";
    await handleRequest(webhook(channelPost({ text: post })), env, fakeDeps(healthyRoute).deps);

    const fake = fakeDeps(healthyRoute);
    const nested = comment({ text: "Сині взагалі зло", reply_to_message: { message_id: 49, text: "Та ні, це ж не сині" } });
    await handleRequest(webhook(channelPost(nested)), env, fake.deps);
    expect(fake.deepl()[0].body.context).toBe(`Post: ${post}\nComment: Та ні, це ж не сині`);
  });

  it("remembers English channel posts so their Ukrainian comments still get the post as context", async () => {
    const post = "My study setup: brown switches.";
    await handleRequest(webhook(channelPost({ text: post })), env, fakeDeps(healthyRoute).deps);

    const fake = fakeDeps(healthyRoute);
    const nested = comment({ reply_to_message: { message_id: 49, text: "Та ні, це ж не сині" } });
    await handleRequest(webhook(channelPost(nested)), env, fake.deps);
    expect(fake.deepl()[0].body.context).toBe(`Post: ${post}\nComment: Та ні, це ж не сині`);
  });

  it.each([
    ["an anonymous group admin", { from: { id: 1087968824, is_bot: true }, sender_chat: { id: GROUP, type: "supergroup" } }],
    ["the channel itself", { from: { id: 136817688, is_bot: true }, sender_chat: { id: CHANNEL, type: "channel" } }],
  ])("translates a comment sent as %s without storing it as a post", async (_, sender) => {
    const fake = fakeDeps(healthyRoute);
    await handleRequest(webhook(channelPost(comment(sender))), env, fake.deps);
    expect(fake.telegram()[0].body.reply_parameters).toEqual({ message_id: 50 });
    expect(await env.DB.prepare("SELECT count(*) n FROM thread_posts").first("n")).toBe(0);
  });

  it("ignores edited messages and non-message updates", async () => {
    const fake = fakeDeps(healthyRoute);
    const edited = { update_id: 2, edited_message: channelPost().message };
    expect((await handleRequest(webhook(edited), env, fake.deps)).status).toBe(200);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("/start", () => {
  it("answers /start in a private chat without quoting", async () => {
    const fake = fakeDeps(healthyRoute);
    const update = {
      update_id: 3,
      message: {
        message_id: 9,
        date: NOW,
        chat: { id: 123, type: "private" },
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    };
    expect((await handleRequest(webhook(update), env, fake.deps)).status).toBe(200);
    expect(fake.telegram()[0].body).toEqual({ chat_id: 123, text: START_REPLY });
  });

  it("answers /start@bot in a group as a reply", async () => {
    const fake = fakeDeps(healthyRoute);
    const update = {
      update_id: 4,
      message: {
        message_id: 10,
        date: NOW,
        chat: { id: -500, type: "group" },
        text: "/start@translator_bot",
        entities: [{ type: "bot_command", offset: 0, length: 21 }],
      },
    };
    await handleRequest(webhook(update), env, fake.deps);
    expect(fake.telegram()[0].body).toEqual({
      chat_id: -500,
      text: START_REPLY,
      reply_parameters: { message_id: 10 },
    });
  });
});

describe("retries and persistence", () => {
  it("does not post twice when Telegram redelivers a handled update", async () => {
    const fake = fakeDeps(healthyRoute);
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(200);
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(200);
    expect(fake.deepl()).toHaveLength(1);
    expect(fake.telegram()).toHaveLength(1);
  });

  it("retries DeepL 5xx in-request, then succeeds", async () => {
    let deeplCalls = 0;
    const fake = fakeDeps((url, body) =>
      url.includes("deepl.com") && ++deeplCalls < 3
        ? new Response("busy", { status: 503 })
        : healthyRoute(url, body),
    );
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(200);
    expect(fake.deepl()).toHaveLength(3);
    expect(fake.sleeps).toEqual([500, 1000]);
    expect((await postRow())?.state).toBe("done");
  });

  it("honors Telegram retry_after on 429", async () => {
    let sends = 0;
    const fake = fakeDeps((url, body) =>
      url.includes("api.telegram.org") && ++sends === 1
        ? json({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, 429)
        : healthyRoute(url, body),
    );
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(200);
    expect(fake.sleeps).toEqual([2000]);
    expect(fake.telegram()).toHaveLength(2);
  });

  it("releases the claim and asks Telegram to redeliver after transient failure", async () => {
    let down = true;
    const fake = fakeDeps((url, body) => {
      if (url.includes("deepl.com") && down) throw new Error("connection reset");
      return healthyRoute(url, body);
    });
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(503);
    expect(fake.deepl()).toHaveLength(3);
    expect(fake.telegram()).toHaveLength(0);
    expect(await postRow()).toBeNull();

    down = false;
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(200);
    expect(fake.telegram()).toHaveLength(1);
    expect((await postRow())?.state).toBe("done");
  });

  it("gives up on a retry_after longer than the in-request budget", async () => {
    const fake = fakeDeps((url, body) =>
      url.includes("api.telegram.org")
        ? json({ ok: false, error_code: 429, parameters: { retry_after: 30 } }, 429)
        : healthyRoute(url, body),
    );
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(503);
    expect(fake.telegram()).toHaveLength(1);
    expect(fake.sleeps).toEqual([]);
  });

  it("records permanent failures and acknowledges so Telegram stops redelivering", async () => {
    const fake = fakeDeps((url, body) =>
      url.includes("deepl.com") ? new Response("Quota exceeded", { status: 456 }) : healthyRoute(url, body),
    );
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(200);
    expect(fake.deepl()).toHaveLength(1);
    expect(fake.telegram()).toHaveLength(0);
    const row = await postRow();
    expect(row?.state).toBe("failed");
    expect(row?.error).toContain("deepl: HTTP 456");

    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(200);
    expect(fake.deepl()).toHaveLength(1);
  });

  it("asks for redelivery while another delivery holds a fresh claim", async () => {
    await env.DB.prepare(
      "INSERT INTO posts (chat_id, message_id, state, updated_at) VALUES (?1, 42, 'pending', ?2)",
    )
      .bind(GROUP, NOW - 10)
      .run();
    const fake = fakeDeps(healthyRoute);
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(503);
    expect(fake.calls).toHaveLength(0);
  });

  it("takes over a stale claim left by a crashed delivery", async () => {
    await env.DB.prepare(
      "INSERT INTO posts (chat_id, message_id, state, updated_at) VALUES (?1, 42, 'pending', ?2)",
    )
      .bind(GROUP, NOW - 61)
      .run();
    const fake = fakeDeps(healthyRoute);
    expect((await handleRequest(webhook(channelPost()), env, fake.deps)).status).toBe(200);
    expect(fake.telegram()).toHaveLength(1);
    expect((await postRow())?.state).toBe("done");
  });
});
