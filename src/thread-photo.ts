import { editPhoto, profilePhoto, sendPhoto } from "./telegram";
import { threadHtml, type Author } from "./thread-image";
import {
  claimPhoto,
  getProfiles,
  getThread,
  listComments,
  saveProfile,
  settlePhoto,
  type Thread,
} from "./threads";
import type { Deps, Upstream } from "./upstream";

const MAX_SHOWN_COMMENTS = 30;
const PROFILE_TTL_SECONDS = 7 * 24 * 3600;
const SYNC_ROUNDS = 3;

/** Profile photos for these authors, fetched from Telegram when missing or a week old. */
async function authorsWithPhotos(env: Env, deps: Deps, authors: { id: number; name: string }[]) {
  const unique = [...new Map(authors.map((a) => [a.id, a])).values()];
  const cached = await getProfiles(env.DB, unique.map((a) => a.id));
  const now = deps.now();
  const resolved = await Promise.all(
    unique.map(async (author): Promise<Author> => {
      let profile = cached.get(author.id);
      if (!profile || now - profile.fetchedAt > PROFILE_TTL_SECONDS) {
        const photo = (await profilePhoto(deps, env.TELEGRAM_BOT_TOKEN, author.id)) ?? "";
        profile = { id: author.id, name: author.name, photo, fetchedAt: now };
        await saveProfile(env.DB, profile);
      }
      return { id: author.id, name: author.name, photo: profile.photo || undefined };
    }),
  );
  return new Map(resolved.map((a) => [a.id, a]));
}

async function renderThread(env: Env, deps: Deps, thread: Thread): Promise<Upstream<Uint8Array>> {
  const comments = await listComments(env.DB, thread);
  const shown = comments.slice(-MAX_SHOWN_COMMENTS);
  const channelId = Number(env.CHANNEL_ID);
  const channelName = (await getProfiles(env.DB, [channelId])).get(channelId)?.name ?? "Channel";
  const authors = await authorsWithPhotos(env, deps, [
    { id: channelId, name: channelName },
    ...shown.map((c) => ({ id: c.authorId, name: c.authorName })),
  ]);
  const html = threadHtml({
    channel: authors.get(channelId)!,
    post: { text: thread.translation ?? thread.text, date: thread.postDate },
    comments: shown.map((c) => ({
      author: { ...authors.get(c.authorId)!, name: c.authorName },
      text: c.text,
      date: c.date,
    })),
    hiddenComments: comments.length - shown.length,
  });
  try {
    return { ok: true, value: await deps.render(html) };
  } catch (error) {
    return { ok: false, transient: true, detail: `render: ${error instanceof Error ? error.message : error}` };
  }
}

/**
 * Brings the thread's photo up to date: sends it the first time, edits it afterwards.
 * Requests that run at once each redraw until the photo shows the latest version,
 * so a slow request can't leave an older picture in place.
 * Returns the photo's message id, or undefined when another request is sending it.
 */
export async function syncThreadPhoto(
  env: Env,
  deps: Deps,
  chatId: number,
  postId: number,
): Promise<Upstream<number | undefined>> {
  let photoId: number | undefined;
  for (let round = 0; round < SYNC_ROUNDS; round++) {
    const thread = await getThread(env.DB, chatId, postId);
    if (!thread) return { ok: true, value: undefined };
    const sending = !thread.photoMessageId;
    if (sending && !(await claimPhoto(env.DB, thread, deps.now()))) {
      return { ok: true, value: undefined };
    }

    const renderStart = Date.now();
    const png = await renderThread(env, deps, thread);
    const telegramStart = Date.now();
    if (!png.ok) {
      if (sending) await settlePhoto(env.DB, thread, null);
      return png;
    }
    if (sending) {
      const sent = await sendPhoto(deps, env.TELEGRAM_BOT_TOKEN, chatId, postId, png.value);
      await settlePhoto(env.DB, thread, sent.ok ? sent.value : null);
      if (!sent.ok) return sent;
      photoId = sent.value;
    } else {
      const edited = await editPhoto(deps, env.TELEGRAM_BOT_TOKEN, chatId, thread.photoMessageId!, png.value);
      if (!edited.ok) return edited;
      photoId = thread.photoMessageId!;
    }

    console.log(
      JSON.stringify({
        event: "photo_timing",
        round,
        method: sending ? "sendPhoto" : "editMessageMedia",
        render_ms: telegramStart - renderStart,
        telegram_ms: Date.now() - telegramStart,
      }),
    );
    const latest = await getThread(env.DB, chatId, postId);
    if (latest?.version === thread.version) break;
  }
  return { ok: true, value: photoId };
}
