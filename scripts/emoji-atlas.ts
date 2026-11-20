// Regenerates render/assets/emoji.png and emoji.txt from Twemoji (CC-BY 4.0).
// Needs ImageMagick (`magick`). Run: bun scripts/emoji-atlas.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export {};

const TWEMOJI = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72";
// Tile size in pixels: the renderer draws text at 13.5 px × 2.
const TILE = 28;
const OUT = join(import.meta.dir, "../render/assets");

// Common chat emoji: faces, hands, hearts, symbols, objects, and the flags this channel uses.
const EMOJI = `
😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔
🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓
🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿
💀 ☠️ 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 🙈 🙉 🙊 🫠 🫡 🥹 🫢 🫣
👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💪 🧠 👀 👁️ 🫵
❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 💬 💭 💤
🔥 ✨ ⭐ 🌟 ⚡ ☀️ 🌈 ❄️ 💧 🌊 🌸 🌹 🌻 🍀 🌱 🌿 🍁
☕ 🍺 🍷 🥂 🍕 🍔 🍰 🎂 🍫 🍎 🍌 🍓 🍉
🎉 🎊 🎁 🏆 🥇 🎯 🎮 🎧 🎵 🎶 📚 📖 ✏️ 📝 📌 📎 📅 📈 📉 📊 💡 🔍 🔗 🔒 🔑 💻 ⌨️ 🖥️ 📱 📷 🎥 📺 🔋 ⏰ ⏳ ⌛
🚀 ✈️ 🚗 🏠 🌍 🌎 🗺️ 💰 💸 💵 🛒 🎓 🏃 🚶 🤷 🤦 🙋 🙅 🙆 🧑‍💻 👨‍💻 👩‍💻
✅ ❌ ❗ ❓ ⚠️ 🚫 ⛔ 🔴 🟢 🟡 🔵 ⚪ ⚫ ➡️ ⬅️ ⬆️ ⬇️ 🔝 🆗 🆕 ♻️ ➕ ➖ ✔️ 🔔 📢 📣 🙌 🤝
🇺🇦 🇺🇸 🇬🇧 🇪🇺 🇩🇪 🇵🇱 🇫🇮 🏳️ 🏴
`
  .split(/\s+/)
  .filter(Boolean);

const unique = [...new Set(EMOJI)];
// Twemoji names files by code point, dropping U+FE0F unless the sequence has a zero-width joiner.
const twemojiName = (emoji: string) => {
  const points = [...emoji].map((c) => c.codePointAt(0)!.toString(16));
  return (emoji.includes("‍") ? points : points.filter((p) => p !== "fe0f")).join("-");
};

const dir = mkdtempSync(join(tmpdir(), "emoji-"));
try {
  const tiles: string[] = [];
  const kept: string[] = [];
  for (const emoji of unique) {
    const response = await fetch(`${TWEMOJI}/${twemojiName(emoji)}.png`);
    if (!response.ok) {
      console.warn(`skip ${emoji} (${twemojiName(emoji)}): HTTP ${response.status}`);
      continue;
    }
    const file = join(dir, `${kept.length}.png`);
    await Bun.write(file, response);
    tiles.push(file);
    kept.push(emoji);
  }
  const atlas = Bun.spawnSync([
    "magick",
    ...tiles.flatMap((t) => [t, "-resize", `${TILE}x${TILE}`]),
    "-background",
    "none",
    "+append",
    "-define",
    "png:color-type=6",
    join(OUT, "emoji.png"),
  ]);
  if (atlas.exitCode !== 0) throw new Error(atlas.stderr.toString());
  await Bun.write(join(OUT, "emoji.txt"), `${kept.join("\n")}\n`);
  console.log(`${kept.length} emoji, ${TILE}px tiles -> render/assets/emoji.png`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
