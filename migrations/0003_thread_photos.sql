-- Each channel post's thread is shown as one rendered photo that is edited as comments arrive.
-- photo_message_id: NULL = no photo yet, 0 = a request is sending it (lease in photo_claimed_at).
-- version counts comment changes, so concurrent requests re-render until the photo is current.
ALTER TABLE thread_posts ADD COLUMN translation TEXT;
ALTER TABLE thread_posts ADD COLUMN photo_message_id INTEGER;
ALTER TABLE thread_posts ADD COLUMN photo_claimed_at INTEGER;
ALTER TABLE thread_posts ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE thread_comments (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  date INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX thread_comments_by_thread ON thread_comments (chat_id, thread_id, date);

-- Profile photos as data: URIs (empty string = none), refreshed weekly.
CREATE TABLE profiles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  photo TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
