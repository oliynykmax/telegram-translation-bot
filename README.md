# Telegram Channel Translation Bot

Automatically translates Ukrainian channel posts to English in the comments using DeepL API.

## Features

- Monitors a Telegram channel for Ukrainian posts
- Translates them to English using DeepL
- Posts the translation as a comment in the linked discussion group
- Ignores posts already in English

## Quick Start

```bash
# Clone and run with uv
git clone https://github.com/YOUR_USERNAME/telegram-translation-bot.git
cd telegram-translation-bot
cp .env.example .env
# Edit .env with your credentials
uv run --with python-telegram-bot --with deepl --with python-dotenv python main.py
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `DEEPL_API_KEY` | DeepL API key (free tier at [deepl.com](https://www.deepl.com/pro-api)) |
| `CHANNEL_ID` | Your channel ID (e.g., `-1001234567890`) |
| `DISCUSSION_GROUP_ID` | Linked discussion group ID |

**Tip:** Use [@idbot](https://t.me/myidbot) to get channel/group IDs.

## Deploy to Railway

```bash
railway login
railway init
railway variables set TELEGRAM_BOT_TOKEN=xxx DEEPL_API_KEY=xxx CHANNEL_ID=xxx DISCUSSION_GROUP_ID=xxx
railway up
```

## Requirements

- Python 3.10+
- Bot must be admin in both channel and discussion group
