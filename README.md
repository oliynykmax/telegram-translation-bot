# Telegram Channel Translation Bot

Translates Ukrainian channel posts and their comments to English with DeepL. Each post's thread is shown as one picture in the channel's linked discussion group: the translated post, then every comment with the writer's name and profile photo. The bot edits that picture in place as comments arrive. It runs as the Cloudflare Worker `tg-translator` at `https://tg-translator.oliinyk.dev`, driven by a Telegram webhook.

## Behavior

- Telegram auto-forwards each channel post into the discussion group. When the forward comes from `CHANNEL_ID`, the Worker stores the post in `thread_posts`. If the post is Ukrainian, it translates the text or caption (`UK` to `EN-US`) and replies with the thread picture.
- A comment is any message in a post's comment thread (`message_thread_id` or `reply_to_message` is set) that is not the channel's automatic forward. Comments sent by anonymous admins or as the channel count, under the chat's name. A Ukrainian comment is translated and added to the picture, which is created at that point if the post was not Ukrainian. Comments in other languages are kept as written. They never start a picture, but appear in it once a Ukrainian comment does, so the picture shows the whole conversation. Plain group messages outside a thread are ignored, and so are comments under posts from before the bot stored them.
- DeepL gets the thread as `context`, which is not billed and resolves short references such as "the tomato" meaning the Pomodoro technique. A direct comment sends the post it replies to. A reply to another comment sends the channel post and that comment, because Telegram leaves the post out of nested replies.
- The picture is HTML (`src/thread-image.ts`) rendered by Cloudflare Browser Rendering (`src/browser.ts`). It reuses a kept-alive browser session, because the plan limits how many new browsers start per minute. A render takes about 1 to 4.5 seconds. It shows the newest 30 comments and clips long texts so the image stays within Telegram's photo limits. Times are Kyiv time.
- Translated comments are stored in `thread_comments` so the picture can be redrawn. Profile photos are cached in `profiles` for a week. A version counter on each thread makes requests that run at once keep redrawing until the picture shows the latest comment.
- Posts and comments that are mostly Latin script (over 80%) are skipped. So are messages that are not Ukrainian by the original Cyrillic heuristic (`src/language.ts`). Text-less messages and messages older than `MESSAGE_MAX_AGE_SECONDS` (default 300) are skipped too.
- `/start` in any chat replies "Bot is running!".
- Only requests that carry the webhook secret in `X-Telegram-Bot-Api-Secret-Token` are processed. Everything else gets 401.
- Each post is claimed in D1 (`posts` table) before translating, so a redelivered update never posts twice. Network errors, 429 and 5xx from DeepL or Telegram are retried in-request up to 3 times, honoring `Retry-After` and Telegram's `retry_after` up to 5 seconds. If retries run out, the claim is released and the Worker answers 503, so Telegram redelivers the update. A failed render (for example the browser rate limit) is transient too. Permanent errors (other 4xx, such as DeepL quota 456) are recorded as `failed` with the error and acknowledged with 200.

## Development

```sh
bun install
bun run check   # wrangler types --check, then tsc
bun run test    # Vitest inside workerd with a local D1
cp .dev.vars.example .dev.vars && bun run dev
```

## Deploy

Prerequisites: Wrangler logged in to the account that owns `oliinyk.dev`, and the bot an admin of both the channel and the discussion group.

1. Create the database and apply the schema. `wrangler d1 create` prints a `database_id`. Add it to the `d1_databases` entry in `wrangler.jsonc`.

   ```sh
   bunx wrangler d1 create tg-translator
   bunx wrangler d1 migrations apply tg-translator --remote
   ```

   Run the `migrations apply` command again after pulling a change that adds a migration.

2. Set secrets. Each command prompts for the value, so nothing lands in shell history. Generate the webhook secret with `openssl rand -hex 32`. Telegram allows `A-Z a-z 0-9 _ -`, up to 256 characters.

   ```sh
   bunx wrangler secret put TELEGRAM_BOT_TOKEN
   bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   bunx wrangler secret put DEEPL_API_KEY
   bunx wrangler secret put CHANNEL_ID
   bunx wrangler secret put DISCUSSION_GROUP_ID
   ```

   `CHANNEL_ID` and `DISCUSSION_GROUP_ID` are the same values the Railway service used (for example `-1001234567890`). Keys ending in `:fx` use the DeepL Free endpoint. Others use DeepL Pro.

3. `bun run deploy`, then check `curl https://tg-translator.oliinyk.dev/` prints `ok`.

## Cutover from Railway

The previous version was a Python long-polling bot (`python main.py`) on Railway, project `Channel_translator`. It is not confirmed whether that service still runs.

1. Check the bot's current mode. Put `TELEGRAM_BOT_TOKEN` in a gitignored `.env` or export it, then run `bun run webhook info`. An empty `url` means no webhook is set. The old bot polled, so that is the expected starting state.
2. If the Railway service still exists, stop it in the Railway dashboard (or `railway down`). Once a webhook is set, Telegram rejects `getUpdates` with 409 Conflict, so a poller left running would only crash-loop.
3. Point Telegram at the Worker. Export `TELEGRAM_WEBHOOK_SECRET` with the value stored in step 2 of Deploy, then:

   ```sh
   bun run webhook set --drop-pending
   ```

   `--drop-pending` discards the queued backlog. The polling bot got the same effect by ignoring messages sent before it started. It only subscribes to `message` updates.
4. Post a short Ukrainian test message in the channel and watch `bunx wrangler tail tg-translator`. Expect a `translation_posted` log line and an English comment under the post.
5. Delete the Railway project when the Worker has run cleanly for a while.

Rollback: `bun run webhook delete` removes the webhook, after which a polling bot can run again.

## Limitations

- Edited and deleted comments are not reflected, because the webhook only subscribes to new messages.
- The text in the picture cannot be selected or searched in Telegram.
- `/start@otherbot` also triggers the reply, because the bot's username is not checked.
- Rows in `posts`, `thread_posts`, `thread_comments` and `profiles` are never pruned.
- If the D1 write that marks a post `done` fails after Telegram accepted the reply, a later redelivery (after the 60-second claim lease) could send the thread picture again.
