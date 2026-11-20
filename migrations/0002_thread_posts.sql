-- Channel post text, kept so comments deep in a thread can send the post to DeepL as context.
CREATE TABLE thread_posts (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
