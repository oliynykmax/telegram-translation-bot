import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DM_HINT, DM_TOO_LONG, handleRequest, START_REPLY, WEBHOOK_PATH } from "../src/index";
import { isEnglish, isUkrainian } from "../src/language";
import type { RenderInput } from "../src/thread-image";
import type { Deps } from "../src/upstream";

const NOW = 1_800_000_000;
const CHANNEL = -1001000000001;
const GROUP = -1001000000002;
const UKRAINIAN = "Привіт, світе! Сьогодні гарний день.";
const PNG = new Uint8Array([137, 80, 78, 71]);

type Route = (url: string, body: any) => Response | Promise<Response>;

const formFields = (form: FormData) =>
  Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"]));

function fakeDeps(route: Route, onRender: (input: RenderInput) => void = () => {}) {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const sleeps: number[] = [];
  const renders: string[] = [];
  const deps: Deps = {
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
    fetch: async (input, init) => {
      const url = String(input);
      const raw = init?.body;
      const body = raw instanceof FormData ? formFields(raw) : raw ? JSON.parse(String(raw)) : undefined;
      calls.push({ url, body, headers: new Headers(init?.headers) });
      return route(url, body);
    },
    render: (input) => {
      renders.push(JSON.stringify(input));
      onRender(input);
      return PNG;
    },
  };
  const to = (part: string) => calls.filter((c) => c.url.includes(part));
  return {
    deps,
    calls,
    sleeps,
    renders,
    deepl: () => to("deepl.com"),
    telegram: () => to("api.telegram.org"),
    sent: () => calls.filter((c) => /\/(sendPhoto|editMessageMedia|sendMessage)$/.test(c.url)),
  };
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers });

const healthyRoute: Route = (url, body) => {
  if (url.includes("deepl.com")) return json({ translations: [{ text: `EN(${body.text[0]})` }] });
  if (url.includes("/getChat?")) return json({ ok: true, result: { id: CHANNEL } });
  if (url.includes("/getUserProfilePhotos?")) return json({ ok: true, result: { total_count: 0, photos: [] } });
  if (url.includes("/getChatMember?")) return json({ ok: true, result: { status: "member" } });
  return json({ ok: true, result: { message_id: 777 } });
};

function channelPost(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      date: NOW - 2,
      chat: { id: GROUP, type: "supergroup" },
      sender_chat: { id: CHANNEL, type: "channel", title: "Neuromax" },
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
    from: { id: 5, is_bot: false, first_name: "Olena", last_name: "K" },
    message_thread_id: 42,
    reply_to_message: { message_id: 42, text: "Порада дня: спробуйте техніку «помідора»." },
    text: "Капець, а я думала що це просто про задоволення",
    ...overrides,
  };
}

function webhook(update: unknown, secret: string | null = env.TELEGRAM_WEBHOOK_SECRET) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (secret !== null) headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
  return new Request(`https://tg-translator.example.com${WEBHOOK_PATH}`, {
    method: "POST",
    headers,
    body: typeof update === "string" ? update : JSON.stringify(update),
  });
}

const send = (update: unknown, deps: Deps = fakeDeps(healthyRoute).deps) =>
  handleRequest(webhook(update), env, deps);

const postRow = (messageId = 42) =>
  env.DB.prepare("SELECT state, reply_message_id, error FROM posts WHERE message_id = ?1")
    .bind(messageId)
    .first<{ state: string; reply_message_id: number | null; error: string | null }>();

const threadRow = () =>
  env.DB.prepare("SELECT translation, photo_message_id, version FROM thread_posts WHERE message_id = 42").first<{
    translation: string | null;
    photo_message_id: number | null;
    version: number;
  }>();

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.exec(
    "DELETE FROM posts; DELETE FROM thread_posts; DELETE FROM thread_comments; DELETE FROM profiles;",
  );
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

describe("thread photo", () => {
  it("answers a Ukrainian channel post with a rendered photo of its translation", async () => {
    const fake = fakeDeps(healthyRoute);
    expect((await send(channelPost(), fake.deps)).status).toBe(200);

    const [deepl] = fake.deepl();
    expect(deepl.url).toBe("https://api-free.deepl.com/v2/translate");
    expect(deepl.headers.get("Authorization")).toBe(`DeepL-Auth-Key ${env.DEEPL_API_KEY}`);
    expect(deepl.body).toEqual({ text: [UKRAINIAN], source_lang: "UK", target_lang: "EN-US" });

    expect(fake.renders).toHaveLength(1);
    expect(fake.renders[0]).toContain(`EN(${UKRAINIAN})`);
    expect(fake.renders[0]).toContain("Neuromax");
    const [photo] = fake.sent();
    expect(photo.url).toBe(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`);
    expect(photo.body).toEqual({
      chat_id: String(GROUP),
      reply_parameters: JSON.stringify({ message_id: 42 }),
      photo: "<file>",
    });
    expect(await postRow()).toEqual({ state: "done", reply_message_id: 777, error: null });
    expect(await threadRow()).toMatchObject({ translation: `EN(${UKRAINIAN})`, photo_message_id: 777 });
  });

  it("uses the pro DeepL endpoint for keys without the :fx suffix", async () => {
    const fake = fakeDeps(healthyRoute);
    await handleRequest(webhook(channelPost()), { ...env, DEEPL_API_KEY: "pro-key" }, fake.deps);
    expect(fake.deepl()[0].url).toBe("https://api.deepl.com/v2/translate");
  });

  it("translates photo captions", async () => {
    const fake = fakeDeps(healthyRoute);
    await send(channelPost({ text: undefined, caption: UKRAINIAN }), fake.deps);
    expect(fake.renders[0]).toContain(`EN(${UKRAINIAN})`);
  });

  it("adds a translated comment with its writer's name by editing the same photo", async () => {
    await send(channelPost());
    const fake = fakeDeps(healthyRoute);
    expect((await send(channelPost(comment()), fake.deps)).status).toBe(200);

    expect(fake.deepl()[0].body.context).toBe("Порада дня: спробуйте техніку «помідора».");
    expect(fake.renders[0]).toContain("Olena K");
    expect(fake.renders[0]).toContain("EN(Капець, а я думала що це просто про задоволення)");
    expect(fake.renders[0]).toContain(`EN(${UKRAINIAN})`);
    const [edit] = fake.sent();
    expect(edit.url).toContain("/editMessageMedia");
    expect(edit.body).toMatchObject({ chat_id: String(GROUP), message_id: "777" });
    expect(await postRow(50)).toEqual({ state: "done", reply_message_id: 777, error: null });
  });

  it("adds English comments as written to a thread that already has a photo", async () => {
    await send(channelPost());
    const fake = fakeDeps(healthyRoute);
    await send(channelPost(comment({ text: "Great post, thanks!" })), fake.deps);
    expect(fake.deepl()).toHaveLength(0);
    expect(fake.renders[0]).toContain("Great post, thanks!");
    expect(fake.sent()[0].url).toContain("/editMessageMedia");
  });

  it("starts the photo at the first Ukrainian comment under an English post, with earlier comments", async () => {
    const english = "My study setup: brown switches.";
    const first = fakeDeps(healthyRoute);
    await send(channelPost({ text: english }), first.deps);
    expect(first.calls).toHaveLength(0);
    await send(channelPost(comment({ message_id: 49, text: "Nice setup!" })), first.deps);
    expect(first.calls).toHaveLength(0);

    const fake = fakeDeps(healthyRoute);
    await send(channelPost(comment()), fake.deps);
    expect(fake.renders[0]).toContain(english);
    expect(fake.renders[0]).toContain("Nice setup!");
    expect(fake.renders[0].indexOf("Nice setup!")).toBeLessThan(fake.renders[0].indexOf("EN(Капець"));
    expect(fake.sent()[0].url).toContain("/sendPhoto");
  });

  it("gives a nested reply both the channel post and the comment it answers as context", async () => {
    const post = "Ділюся сетапом: клавіатура з коричневими світчами.";
    await send(channelPost({ text: post }));
    const fake = fakeDeps(healthyRoute);
    const nested = comment({ text: "Сині взагалі зло", reply_to_message: { message_id: 49, text: "Та ні, це ж не сині" } });
    await send(channelPost(nested), fake.deps);
    expect(fake.deepl()[0].body.context).toBe(`Post: ${post}\nComment: Та ні, це ж не сині`);
  });

  it.each([
    ["an anonymous group admin", { id: GROUP, type: "supergroup", title: "Neuromax Chat" }, "Neuromax Chat"],
    ["the channel itself", { id: CHANNEL, type: "channel", title: "Neuromax" }, "Neuromax"],
  ])("shows a comment sent as %s under the chat's name", async (_, sender_chat, name) => {
    await send(channelPost());
    const fake = fakeDeps(healthyRoute);
    await send(channelPost(comment({ sender_chat, from: { id: 1087968824, is_bot: true, first_name: "Group" } })), fake.deps);
    expect(fake.renders[0]).toMatch(new RegExp(`"name":"${name}"[^}]*"text":"EN\\(`));
    expect(await env.DB.prepare("SELECT count(*) n FROM thread_posts").first("n")).toBe(1);
  });

  it("draws profile photos and caches them for a week", async () => {
    await send(channelPost());
    const route: Route = (url, body) => {
      if (url.includes("/getUserProfilePhotos?")) {
        return json({ ok: true, result: { total_count: 1, photos: [[{ file_id: "small" }]] } });
      }
      if (url.includes("/getFile?")) return json({ ok: true, result: { file_path: "photos/a.jpg" } });
      if (url.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
      return healthyRoute(url, body);
    };
    const fake = fakeDeps(route);
    await send(channelPost(comment()), fake.deps);
    expect(fake.renders[0]).toContain('"avatar":"AQID"');

    const again = fakeDeps(route);
    await send(channelPost(comment({ message_id: 51 })), again.deps);
    expect(again.renders[0]).toContain('"avatar":"AQID"');
    expect(again.calls.filter((c) => c.url.includes("/getUserProfilePhotos"))).toHaveLength(0);
  });

  it("redraws when another comment lands while the photo is being uploaded", async () => {
    await send(channelPost());
    let racing = true;
    const fake = fakeDeps(async (url, body) => {
      if (racing && url.endsWith("/editMessageMedia")) {
        racing = false;
        await send(channelPost(comment({ message_id: 60, text: "Мені теж цікаво" })));
      }
      return healthyRoute(url, body);
    });
    await send(channelPost(comment()), fake.deps);
    expect(fake.renders).toHaveLength(2);
    expect(fake.renders[1]).toContain("EN(Мені теж цікаво)");
    expect(fake.sent()).toHaveLength(2);
  });

  it("lets the request that is sending the first photo pick up comments that arrive meanwhile", async () => {
    await send(channelPost({ text: "English post" }));
    await env.DB.prepare("UPDATE thread_posts SET photo_message_id = 0, photo_claimed_at = ?1").bind(NOW).run();
    const fake = fakeDeps(healthyRoute);
    expect((await send(channelPost(comment()), fake.deps)).status).toBe(200);
    expect(fake.renders).toHaveLength(0);
    expect(fake.sent()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT count(*) n FROM thread_comments").first("n")).toBe(1);
  });

  it("records a render failure as permanent and frees the photo claim", async () => {
    const fake = fakeDeps(healthyRoute, () => {
      throw new Error("renderer rejected its input");
    });
    expect((await send(channelPost(), fake.deps)).status).toBe(200);
    expect(await postRow()).toMatchObject({ state: "failed", error: "photo: render: renderer rejected its input" });
    expect((await threadRow())?.photo_message_id).toBeNull();
  });

  it.each([
    ["English posts", { text: "This post is already written in English." }],
    ["non-Ukrainian posts", { text: "Hola, ¿qué tal? Buenos días." }],
    ["posts without text", { text: undefined }],
    ["posts older than the age window", { date: NOW - 301 }],
    ["group messages outside a comment thread", { sender_chat: undefined, from: { id: 5, is_bot: false, first_name: "A" } }],
    ["channel messages that are not automatic forwards or in a thread", { is_automatic_forward: undefined }],
    ["comments in a thread the bot never saw", comment({ message_thread_id: 999, reply_to_message: { message_id: 999 } })],
    ["other chats", { chat: { id: -100999, type: "supergroup" } }],
  ])("skips %s", async (_, overrides) => {
    const fake = fakeDeps(healthyRoute);
    const res = await send(channelPost(overrides), fake.deps);
    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(0);
    expect(await postRow()).toBeNull();
    expect(await postRow(50)).toBeNull();
  });

  it("ignores non-message updates", async () => {
    const fake = fakeDeps(healthyRoute);
    expect((await send({ update_id: 2, channel_post: channelPost().message }, fake.deps)).status).toBe(200);
    expect(fake.calls).toHaveLength(0);
  });
});

const edit = (update: { message: Record<string, unknown> }, editDate = NOW - 1) => ({
  update_id: 3,
  edited_message: { ...update.message, edit_date: editDate },
});

describe("edits", () => {
  it("redraws the photo with the edited comment's new translation", async () => {
    await send(channelPost());
    await send(channelPost(comment()));
    const fake = fakeDeps(healthyRoute);
    expect((await send(edit(channelPost(comment({ text: "Ой, я помилилася" }))), fake.deps)).status).toBe(200);

    expect(fake.renders).toHaveLength(1);
    expect(fake.renders[0]).toContain("EN(Ой, я помилилася)");
    expect(fake.renders[0]).not.toContain("Капець");
    expect(fake.sent()).toHaveLength(1);
    expect(fake.sent()[0].url).toContain("/editMessageMedia");
    expect(await env.DB.prepare("SELECT count(*) n FROM thread_comments").first("n")).toBe(1);
  });

  it("keeps the newest edit when an older one finishes last", async () => {
    await send(channelPost());
    await send(channelPost(comment()));
    await send(edit(channelPost(comment({ text: "Друга версія" })), NOW - 1));
    const fake = fakeDeps(healthyRoute);
    await send(edit(channelPost(comment({ text: "Перша версія" })), NOW - 5), fake.deps);
    expect(fake.renders.at(-1)).toContain("EN(Друга версія)");
    expect(fake.renders.at(-1)).not.toContain("Перша");
  });

  it("keeps an edit that arrives before the original comment is processed", async () => {
    await send(channelPost());
    await send(edit(channelPost(comment({ text: "Виправлений текст" }))));
    const fake = fakeDeps(healthyRoute);
    expect((await send(channelPost(comment()), fake.deps)).status).toBe(200);
    expect(fake.renders.at(-1)).toContain("EN(Виправлений текст)");
    expect(fake.renders.at(-1)).not.toContain("Капець");
  });

  it("updates a comment edited long after it was written", async () => {
    await send(channelPost());
    await send(channelPost(comment()));
    const fake = fakeDeps(healthyRoute);
    await send(edit(channelPost(comment({ date: NOW - 86_400, text: "Оновлено" }))), fake.deps);
    expect(fake.renders[0]).toContain("EN(Оновлено)");
  });

  it("retranslates an edited post", async () => {
    await send(channelPost());
    const fake = fakeDeps(healthyRoute);
    expect((await send(edit(channelPost({ text: "Новий текст посту" })), fake.deps)).status).toBe(200);
    expect(fake.renders[0]).toContain("EN(Новий текст посту)");
    expect(fake.sent()[0].url).toContain("/editMessageMedia");
    expect(await threadRow()).toMatchObject({ translation: "EN(Новий текст посту)" });
  });

  it("shows a post edited into English as written", async () => {
    await send(channelPost());
    const fake = fakeDeps(healthyRoute);
    await send(edit(channelPost({ text: "Now in English, sorry." })), fake.deps);
    expect(fake.deepl()).toHaveLength(0);
    expect(fake.renders[0]).toContain("Now in English, sorry.");
    expect(await threadRow()).toMatchObject({ translation: null });
  });

  it("asks Telegram to resend an edit when DeepL is down", async () => {
    await send(channelPost());
    await send(channelPost(comment()));
    const fake = fakeDeps((url, body) => (url.includes("deepl.com") ? json({}, 503) : healthyRoute(url, body)));
    expect((await send(edit(channelPost(comment({ text: "Ой" }))), fake.deps)).status).toBe(503);
  });

  it("ignores edited direct messages", async () => {
    const fake = fakeDeps(healthyRoute);
    const dm = { message_id: 9, date: NOW, chat: { id: 5, type: "private" }, from: { id: 5, first_name: "O" }, text: "Привіт" };
    expect((await send({ update_id: 4, edited_message: { ...dm, edit_date: NOW } }, fake.deps)).status).toBe(200);
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

describe("direct messages", () => {
  const dm = (text?: string, from = 77) => ({
    update_id: 5,
    message: {
      message_id: 300,
      date: NOW,
      chat: { id: from, type: "private" },
      from: { id: from, is_bot: false, first_name: "Ira" },
      ...(text === undefined ? { sticker: {} } : { text }),
    },
  });
  const membership = (statuses: Record<string, string | Response>): Route => (url, body) => {
    if (!url.includes("/getChatMember?")) return healthyRoute(url, body);
    const chat = new URL(url).searchParams.get("chat_id")!;
    const status = statuses[chat] ?? "left";
    return typeof status === "string" ? json({ ok: true, result: { status } }) : status;
  };

  it("translates a member's message to English and answers in the chat", async () => {
    const fake = fakeDeps(healthyRoute);
    expect((await send(dm(UKRAINIAN), fake.deps)).status).toBe(200);
    expect(fake.calls.filter((c) => c.url.includes("/getChatMember?")).map((c) => new URL(c.url).searchParams.get("user_id"))).toEqual(["77", "77"]);
    expect(fake.deepl()[0].body).toEqual({ text: [UKRAINIAN], target_lang: "EN-US" });
    expect(fake.sent()[0].body).toEqual({ chat_id: 77, text: `EN(${UKRAINIAN})` });
    expect((await postRow(300))?.state).toBe("done");
  });

  it("translates English to Ukrainian", async () => {
    const fake = fakeDeps(healthyRoute);
    await send(dm("Good morning, how are you?"), fake.deps);
    expect(fake.deepl()[0].body.target_lang).toBe("UK");
  });

  it("accepts members of the discussion group who are not in the channel", async () => {
    const fake = fakeDeps(membership({ [String(GROUP)]: "member" }));
    await send(dm(UKRAINIAN), fake.deps);
    expect(fake.deepl()).toHaveLength(1);
  });

  it.each([
    ["users who left", { [String(CHANNEL)]: "left", [String(GROUP)]: "kicked" }],
    ["users Telegram has never seen in either chat", {
      [String(CHANNEL)]: json({ ok: false, error_code: 400, description: "Bad Request: user not found" }, 400),
      [String(GROUP)]: json({ ok: false, error_code: 400, description: "Bad Request: user not found" }, 400),
    }],
  ])("refuses %s without calling DeepL", async (_, statuses) => {
    await send(channelPost({ text: "English post" }));
    const fake = fakeDeps(membership(statuses));
    expect((await send(dm(UKRAINIAN), fake.deps)).status).toBe(200);
    expect(fake.deepl()).toHaveLength(0);
    expect(fake.sent()[0].body.text).toBe(
      "Sorry, translating messages is only for members of Neuromax. Join it, then send your message again.",
    );
  });

  it("asks for redelivery when membership can't be checked", async () => {
    const fake = fakeDeps(membership({ [String(CHANNEL)]: new Response("down", { status: 502 }), [String(GROUP)]: "member" }));
    expect((await send(dm(UKRAINIAN), fake.deps)).status).toBe(503);
    expect(fake.deepl()).toHaveLength(0);
    expect(fake.sent()).toHaveLength(0);
  });

  it.each([
    ["messages without text", undefined, DM_HINT],
    ["messages over 2,000 characters", "ї".repeat(2001), DM_TOO_LONG],
  ])("explains instead of translating %s", async (_, text, expected) => {
    const fake = fakeDeps(healthyRoute);
    await send(dm(text), fake.deps);
    expect(fake.deepl()).toHaveLength(0);
    expect(fake.sent()[0].body.text).toBe(expected);
  });

  it("does not answer twice when Telegram redelivers", async () => {
    const fake = fakeDeps(healthyRoute);
    await send(dm(UKRAINIAN), fake.deps);
    await send(dm(UKRAINIAN), fake.deps);
    expect(fake.deepl()).toHaveLength(1);
    expect(fake.sent()).toHaveLength(1);
  });
});

describe("retries and persistence", () => {
  it("does not post twice when Telegram redelivers a handled update", async () => {
    const fake = fakeDeps(healthyRoute);
    expect((await send(channelPost(), fake.deps)).status).toBe(200);
    expect((await send(channelPost(), fake.deps)).status).toBe(200);
    expect(fake.deepl()).toHaveLength(1);
    expect(fake.sent()).toHaveLength(1);
  });

  it("retries DeepL 5xx in-request, then succeeds", async () => {
    let deeplCalls = 0;
    const fake = fakeDeps((url, body) =>
      url.includes("deepl.com") && ++deeplCalls < 3
        ? new Response("busy", { status: 503 })
        : healthyRoute(url, body),
    );
    expect((await send(channelPost(), fake.deps)).status).toBe(200);
    expect(fake.deepl()).toHaveLength(3);
    expect(fake.sleeps).toEqual([500, 1000]);
    expect((await postRow())?.state).toBe("done");
  });

  it("honors Telegram retry_after on 429", async () => {
    let sends = 0;
    const fake = fakeDeps((url, body) =>
      url.endsWith("/sendPhoto") && ++sends === 1
        ? json({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, 429)
        : healthyRoute(url, body),
    );
    expect((await send(channelPost(), fake.deps)).status).toBe(200);
    expect(fake.sleeps).toEqual([2000]);
    expect(fake.sent()).toHaveLength(2);
  });

  it("releases the claim and asks Telegram to redeliver after transient failure", async () => {
    let down = true;
    const fake = fakeDeps((url, body) => {
      if (url.includes("deepl.com") && down) throw new Error("connection reset");
      return healthyRoute(url, body);
    });
    expect((await send(channelPost(), fake.deps)).status).toBe(503);
    expect(fake.deepl()).toHaveLength(3);
    expect(fake.sent()).toHaveLength(0);
    expect(await postRow()).toBeNull();

    down = false;
    expect((await send(channelPost(), fake.deps)).status).toBe(200);
    expect(fake.sent()).toHaveLength(1);
    expect((await postRow())?.state).toBe("done");
  });

  it("gives up on a retry_after longer than the in-request budget and frees the photo claim", async () => {
    const fake = fakeDeps((url, body) =>
      url.endsWith("/sendPhoto")
        ? json({ ok: false, error_code: 429, parameters: { retry_after: 30 } }, 429)
        : healthyRoute(url, body),
    );
    expect((await send(channelPost(), fake.deps)).status).toBe(503);
    expect(fake.sent()).toHaveLength(1);
    expect(fake.sleeps).toEqual([]);
    expect((await threadRow())?.photo_message_id).toBeNull();
  });

  it("records permanent failures and acknowledges so Telegram stops redelivering", async () => {
    const fake = fakeDeps((url, body) =>
      url.includes("deepl.com") ? new Response("Quota exceeded", { status: 456 }) : healthyRoute(url, body),
    );
    expect((await send(channelPost(), fake.deps)).status).toBe(200);
    expect(fake.deepl()).toHaveLength(1);
    expect(fake.sent()).toHaveLength(0);
    const row = await postRow();
    expect(row?.state).toBe("failed");
    expect(row?.error).toContain("deepl: HTTP 456");

    expect((await send(channelPost(), fake.deps)).status).toBe(200);
    expect(fake.deepl()).toHaveLength(1);
  });

  it("treats an unchanged photo edit as success", async () => {
    await send(channelPost());
    const fake = fakeDeps((url, body) =>
      url.endsWith("/editMessageMedia")
        ? json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, 400)
        : healthyRoute(url, body),
    );
    expect((await send(channelPost(comment()), fake.deps)).status).toBe(200);
    expect((await postRow(50))?.state).toBe("done");
  });

  it("asks for redelivery while another delivery holds a fresh claim", async () => {
    await env.DB.prepare(
      "INSERT INTO posts (chat_id, message_id, state, updated_at) VALUES (?1, 42, 'pending', ?2)",
    )
      .bind(GROUP, NOW - 10)
      .run();
    const fake = fakeDeps(healthyRoute);
    expect((await send(channelPost(), fake.deps)).status).toBe(503);
    expect(fake.calls).toHaveLength(0);
  });

  it("takes over a stale claim left by a crashed delivery", async () => {
    await env.DB.prepare(
      "INSERT INTO posts (chat_id, message_id, state, updated_at) VALUES (?1, 42, 'pending', ?2)",
    )
      .bind(GROUP, NOW - 61)
      .run();
    const fake = fakeDeps(healthyRoute);
    expect((await send(channelPost(), fake.deps)).status).toBe(200);
    expect(fake.sent()).toHaveLength(1);
    expect((await postRow())?.state).toBe("done");
  });
});
