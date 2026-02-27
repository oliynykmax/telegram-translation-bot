# Telegram Translation Bot

Bot that translates non-English posts to English using DeepL API.

## Setup

1. Get a Telegram Bot Token from @BotFather
2. Get a DeepL API key (free tier available at deepl.com/pro-api)
3. Invite the bot to your channel

## Deployment to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Init project
cd telegram-translation-bot
railway init

# Set environment variables
railway variables set TELEGRAM_BOT_TOKEN=your_token
railway variables set DEEPL_API_KEY=your_api_key

# Deploy
railway up
```

## Local Development

```bash
cp .env.example .env
# Edit .env with your credentials
pip install -r requirements.txt
python main.py
```

## Environment Variables

- `TELEGRAM_BOT_TOKEN` - Your bot token from @BotFather
- `DEEPL_API_KEY` - Your DeepL API key
- `CHANNEL_ID` - (optional) Your channel ID
