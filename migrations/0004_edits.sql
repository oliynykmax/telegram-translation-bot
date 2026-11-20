-- Edit time of the stored text (0 = never edited), so an older edit can't overwrite a newer one.
ALTER TABLE thread_posts ADD COLUMN edited_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thread_comments ADD COLUMN edited_at INTEGER NOT NULL DEFAULT 0;
