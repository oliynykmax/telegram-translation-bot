import os
import logging
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)
from telegram.ext.filters import UpdateType

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
DEEPL_API_KEY = os.getenv("DEEPL_API_KEY")
CHANNEL_ID = int(os.getenv("CHANNEL_ID", "0"))
SOURCE_CHANNEL_ID = int(os.getenv("SOURCE_CHANNEL_ID", "0"))

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("Bot started! Send channel posts to translate.")


def detect_language(text: str) -> str:
    import re

    cyrillic = re.compile(r"[\u0400-\u04FF]")
    arabic = re.compile(r"[\u0600-\u06FF]")
    chinese = re.compile(r"[\u4e00-\u9fff]")
    japanese = re.compile(r"[\u3040-\u309f\u30a0-\u30ff]")
    korean = re.compile(r"[\uac00-\ud7af]")

    if cyrillic.search(text):
        return "ru"
    elif arabic.search(text):
        return "ar"
    elif chinese.search(text):
        return "zh"
    elif japanese.search(text):
        return "ja"
    elif korean.search(text):
        return "ko"
    return "en"


def translate_to_english(text: str) -> str:
    try:
        lang = detect_language(text)
        if lang == "en":
            return None

        from deep_translator.deepl import DeepL

        translator = DeepL(api_key=DEEPL_API_KEY, use_free_api=True)
        result = translator.translate(text, target_lang="EN", source_lang=lang.upper())
        return result
    except Exception as e:
        logger.error(f"Translation error: {e}")
        return None


async def handle_channel_post(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.channel_post
    if not message or not message.text:
        return

    if message.chat.id != SOURCE_CHANNEL_ID:
        return

    text = message.text
    lang = detect_language(text)

    if lang == "en":
        return

    translated = translate_to_english(text)
    if translated:
        try:
            await context.bot.send_message(
                chat_id=CHANNEL_ID,
                text=f"🌐 English translation:\n{translated}",
                reply_to_message_id=message.message_id,
            )
        except Exception as e:
            logger.error(f"Failed to send translation: {e}")


def main():
    if not TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN not set")
        return
    if not DEEPL_API_KEY:
        logger.error("DEEPL_API_KEY not set")
        return

    application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(
        MessageHandler(UpdateType.CHANNEL_POST, handle_channel_post)
    )

    logger.info("Bot started...")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
