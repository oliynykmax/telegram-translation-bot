export interface Thread {
  chatId: number;
  postId: number;
  /** Original post text, empty for media without a caption. */
  text: string;
  /** English text when the post was Ukrainian. */
  translation: string | null;
  postDate: number;
  /** null = no photo yet, 0 = being sent, otherwise the photo's message id. */
  photoMessageId: number | null;
  photoClaimedAt: number | null;
  version: number;
}

export interface Comment {
  messageId: number;
  authorId: number;
  authorName: string;
  text: string;
  date: number;
}

export interface Profile {
  id: number;
  name: string;
  photo: string;
  fetchedAt: number;
}

const PHOTO_LEASE_SECONDS = 60;

export async function rememberThreadPost(
  db: D1Database,
  chatId: number,
  postId: number,
  text: string,
  date: number,
) {
  await db
    .prepare(
      "INSERT INTO thread_posts (chat_id, message_id, text, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING",
    )
    .bind(chatId, postId, text, date)
    .run();
}

export async function getThread(db: D1Database, chatId: number, postId: number) {
  const row = await db
    .prepare(
      `SELECT text, translation, created_at, photo_message_id, photo_claimed_at, version
       FROM thread_posts WHERE chat_id = ?1 AND message_id = ?2`,
    )
    .bind(chatId, postId)
    .first<{
      text: string;
      translation: string | null;
      created_at: number;
      photo_message_id: number | null;
      photo_claimed_at: number | null;
      version: number;
    }>();
  if (!row) return undefined;
  return {
    chatId,
    postId,
    text: row.text,
    translation: row.translation,
    postDate: row.created_at,
    photoMessageId: row.photo_message_id,
    photoClaimedAt: row.photo_claimed_at,
    version: row.version,
  } satisfies Thread;
}

export async function setTranslation(db: D1Database, thread: Thread, translation: string) {
  await db
    .prepare(
      "UPDATE thread_posts SET translation = ?3, version = version + 1 WHERE chat_id = ?1 AND message_id = ?2",
    )
    .bind(thread.chatId, thread.postId, translation)
    .run();
}

/** Upserts the comment and bumps the thread version, so an in-flight render redraws. */
export async function saveComment(db: D1Database, thread: Thread, comment: Comment) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO thread_comments (chat_id, message_id, thread_id, author_id, author_name, text, date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (chat_id, message_id) DO UPDATE SET text = excluded.text, author_name = excluded.author_name`,
      )
      .bind(
        thread.chatId,
        comment.messageId,
        thread.postId,
        comment.authorId,
        comment.authorName,
        comment.text,
        comment.date,
      ),
    db
      .prepare("UPDATE thread_posts SET version = version + 1 WHERE chat_id = ?1 AND message_id = ?2")
      .bind(thread.chatId, thread.postId),
  ]);
}

export async function listComments(db: D1Database, thread: Thread): Promise<Comment[]> {
  const { results } = await db
    .prepare(
      `SELECT message_id, author_id, author_name, text, date FROM thread_comments
       WHERE chat_id = ?1 AND thread_id = ?2 ORDER BY date, message_id`,
    )
    .bind(thread.chatId, thread.postId)
    .all<{ message_id: number; author_id: number; author_name: string; text: string; date: number }>();
  return results.map((r) => ({
    messageId: r.message_id,
    authorId: r.author_id,
    authorName: r.author_name,
    text: r.text,
    date: r.date,
  }));
}

/** Only one request sends the first photo. A crashed sender's lease expires after a minute. */
export async function claimPhoto(db: D1Database, thread: Thread, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE thread_posts SET photo_message_id = 0, photo_claimed_at = ?3
       WHERE chat_id = ?1 AND message_id = ?2
         AND (photo_message_id IS NULL OR (photo_message_id = 0 AND photo_claimed_at <= ?3 - ?4))
       RETURNING message_id`,
    )
    .bind(thread.chatId, thread.postId, now, PHOTO_LEASE_SECONDS)
    .first();
  return row !== null;
}

export async function settlePhoto(db: D1Database, thread: Thread, photoMessageId: number | null) {
  await db
    .prepare(
      "UPDATE thread_posts SET photo_message_id = ?3, photo_claimed_at = NULL WHERE chat_id = ?1 AND message_id = ?2",
    )
    .bind(thread.chatId, thread.postId, photoMessageId)
    .run();
}

export async function getProfiles(db: D1Database, ids: number[]): Promise<Map<number, Profile>> {
  if (ids.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT id, name, photo, fetched_at FROM profiles WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(...ids)
    .all<{ id: number; name: string; photo: string; fetched_at: number }>();
  return new Map(
    results.map((r) => [r.id, { id: r.id, name: r.name, photo: r.photo, fetchedAt: r.fetched_at }]),
  );
}

/** Records a display name, leaving any cached photo in place (fetched_at 0 = fetch on next render). */
export async function rememberName(db: D1Database, id: number, name: string) {
  await db
    .prepare(
      "INSERT INTO profiles (id, name, photo, fetched_at) VALUES (?1, ?2, '', 0) ON CONFLICT (id) DO UPDATE SET name = excluded.name",
    )
    .bind(id, name)
    .run();
}

export async function saveProfile(db: D1Database, profile: Profile) {
  await db
    .prepare(
      `INSERT INTO profiles (id, name, photo, fetched_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, photo = excluded.photo, fetched_at = excluded.fetched_at`,
    )
    .bind(profile.id, profile.name, profile.photo, profile.fetchedAt)
    .run();
}
