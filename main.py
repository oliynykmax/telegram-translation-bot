import os
import logging
import time
from dotenv import load_dotenv

load_dotenv()

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)
import deepl

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
DEEPL_API_KEY = os.getenv("DEEPL_API_KEY")
# Channel ID (the channel with Ukrainian posts)
CHANNEL_ID = int(os.getenv("CHANNEL_ID", "0"))
# Discussion group ID (linked to channel, where comments go)
DISCUSSION_GROUP_ID = int(os.getenv("DISCUSSION_GROUP_ID", "0"))

# Only process messages newer than this many seconds
MESSAGE_TIMEOUT = 30

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# Track bot start time to ignore old messages
BOT_START_TIME = time.time()

# Initialize DeepL translator
translator = None


def init_translator():
    global translator
    if DEEPL_API_KEY:
        translator = deepl.Translator(DEEPL_API_KEY)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        await update.message.reply_text(
            "Bot is running! I will automatically translate Ukrainian channel posts to English in the comments."
        )


def is_ukrainian(text: str) -> bool:
    """Check if text contains Ukrainian-specific characters or is primarily Cyrillic (Ukrainian)."""
    import re

    # Ukrainian-specific letters not in Russian: і, ї, є, ґ (and their uppercase)
    ukrainian_specific = re.compile(r"[іїєґІЇЄҐ]")

    # General Cyrillic pattern
    cyrillic = re.compile(r"[\u0400-\u04FF]")

    # If it has Ukrainian-specific letters, it's definitely Ukrainian
    if ukrainian_specific.search(text):
        return True

    # Check if it has significant Cyrillic content (could be Ukrainian without specific letters)
    cyrillic_chars = len(cyrillic.findall(text))
    total_alpha = len(re.findall(r"[a-zA-Zа-яА-ЯіїєґІЇЄҐ]", text))

    if total_alpha > 0 and cyrillic_chars / total_alpha > 0.5:
        return True

    return False


def is_english(text: str) -> bool:
    """Check if text is primarily English."""
    import re

    latin_chars = len(re.findall(r"[a-zA-Z]", text))
    cyrillic_chars = len(re.findall(r"[\u0400-\u04FF]", text))

    total = latin_chars + cyrillic_chars
    if total == 0:
        return False

    return latin_chars / total > 0.8


def translate_to_english(text: str) -> str | None:
    """Translate text to English using DeepL."""
    if not translator:
        logger.error("Translator not initialized")
        return None

    try:
        result = translator.translate_text(text, source_lang="UK", target_lang="EN-US")
        return result.text
    except Exception as e:
        logger.error(f"Translation error: {e}")
        return None


async def handle_discussion_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle messages in the discussion group - look for auto-forwarded channel posts."""
    message = update.message
    if not message:
        return

    # Check message age - ignore old messages
    msg_time = message.date.timestamp()
    if msg_time < BOT_START_TIME:
        logger.info("Ignoring old message from before bot started")
        return

    if time.time() - msg_time > MESSAGE_TIMEOUT:
        logger.info(f"Ignoring message older than {MESSAGE_TIMEOUT}s")
        return

    # Check if this is in our discussion group
    if message.chat.id != DISCUSSION_GROUP_ID:
        return

    # Check if this is an auto-forwarded post from our channel
    # Auto-forwarded channel posts have sender_chat set to the channel
    if not message.sender_chat or message.sender_chat.id != CHANNEL_ID:
        return

    # This is an auto-forwarded channel post in the discussion group
    logger.info(f"Detected forwarded channel post in discussion group")

    # Get text from message
    text = message.text or message.caption
    if not text:
        return

    logger.info(f"Processing: {text[:50]}...")

    # Skip if already in English
    if is_english(text):
        logger.info("Post is already in English, skipping")
        return

    # Check if it's Ukrainian
    if not is_ukrainian(text):
        logger.info("Post is not Ukrainian, skipping")
        return

    # Translate
    translated = translate_to_english(text)
    if not translated:
        logger.error("Translation failed")
        return

    logger.info(f"Translated to: {translated[:50]}...")

    # Reply to this message as a comment
    try:
        await message.reply_text(f"English translation:\n\n{translated}")
        logger.info("Translation posted as comment")
    except Exception as e:
        logger.error(f"Failed to post translation comment: {e}")


def main():
    global BOT_START_TIME
    BOT_START_TIME = time.time()

    if not TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN not set")
        return
    if not DEEPL_API_KEY:
        logger.error("DEEPL_API_KEY not set")
        return
    if not CHANNEL_ID:
        logger.error("CHANNEL_ID not set")
        return
    if not DISCUSSION_GROUP_ID:
        logger.error("DISCUSSION_GROUP_ID not set")
        return

    init_translator()

    application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    application.add_handler(CommandHandler("start", start_command))
    # Listen for messages in the discussion group (auto-forwarded channel posts)
    application.add_handler(
        MessageHandler(filters.ChatType.SUPERGROUP, handle_discussion_message)
    )

    logger.info(f"Bot started, listening for channel posts in discussion group...")
    logger.info(f"Channel ID: {CHANNEL_ID}, Discussion Group ID: {DISCUSSION_GROUP_ID}")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
