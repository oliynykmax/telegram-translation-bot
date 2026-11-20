export type PostState = "pending" | "done" | "failed";

const LEASE_SECONDS = 60;

export async function claimPost(
  db: D1Database,
  chatId: number,
  messageId: number,
  now: number,
): Promise<{ claimed: true } | { claimed: false; state: PostState }> {
  const claimed = await db
    .prepare(
      `INSERT INTO posts (chat_id, message_id, state, updated_at) VALUES (?1, ?2, 'pending', ?3)
       ON CONFLICT (chat_id, message_id) DO UPDATE SET updated_at = ?3
       WHERE posts.state = 'pending' AND posts.updated_at <= ?3 - ?4
       RETURNING message_id`,
    )
    .bind(chatId, messageId, now, LEASE_SECONDS)
    .first();
  if (claimed) return { claimed: true };
  const existing = await db
    .prepare("SELECT state FROM posts WHERE chat_id = ?1 AND message_id = ?2")
    .bind(chatId, messageId)
    .first<{ state: PostState }>();
  return { claimed: false, state: existing?.state ?? "pending" };
}

export async function settlePost(
  db: D1Database,
  chatId: number,
  messageId: number,
  now: number,
  outcome: { state: "done"; replyMessageId: number } | { state: "failed"; error: string },
): Promise<void> {
  await db
    .prepare(
      "UPDATE posts SET state = ?3, reply_message_id = ?4, error = ?5, updated_at = ?6 WHERE chat_id = ?1 AND message_id = ?2",
    )
    .bind(
      chatId,
      messageId,
      outcome.state,
      outcome.state === "done" ? outcome.replyMessageId : null,
      outcome.state === "failed" ? outcome.error : null,
      now,
    )
    .run();
}

export async function releasePost(db: D1Database, chatId: number, messageId: number) {
  await db
    .prepare("DELETE FROM posts WHERE chat_id = ?1 AND message_id = ?2 AND state = 'pending'")
    .bind(chatId, messageId)
    .run();
}
