CREATE TABLE posts (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  reply_message_id INTEGER,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
