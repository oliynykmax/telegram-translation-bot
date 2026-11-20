export interface Author {
  id: number;
  name: string;
  /** `data:` URI of the profile photo, or undefined to draw initials. */
  photo?: string;
}

export interface ThreadView {
  channel: Author;
  /** Empty text means a media post without a caption. */
  post: { text: string; date: number };
  comments: { author: Author; text: string; date: number }[];
  /** Older comments left out to keep the image within Telegram's photo size limits. */
  hiddenComments: number;
}

const MAX_POST_CHARS = 1500;
const MAX_COMMENT_CHARS = 600;
const clip = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max).join("")}…` : text);

// Seven name colors, dark enough to read on white, picked by sender id so a person keeps theirs.
const PEER_COLORS = ["#c0392b", "#c25400", "#6f52c4", "#2e7d32", "#127c76", "#2468a8", "#b0306f"];
const peerColor = (id: number) => PEER_COLORS[Math.abs(id) % 7];

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0])
    .join("")
    .toUpperCase();

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Kyiv",
  hour: "2-digit",
  minute: "2-digit",
});
const time = (unix: number) => clock.format(new Date(unix * 1000));

function avatar(author: Author, size: number) {
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  return author.photo
    ? `<img class="avatar" style="${style}" src="${author.photo}" alt="">`
    : `<div class="avatar" style="${style};background:${peerColor(author.id)}">${escape(initials(author.name))}</div>`;
}

const CSS = `
* { box-sizing: border-box; margin: 0; }
body { background: #fff; font-family: "Noto Sans", Roboto, Arial, sans-serif; color: #1b1f23; }
#thread { width: 480px; padding: 8px 10px 9px; background: #fff; font-size: 13.5px; line-height: 1.35; }
.avatar { border-radius: 50%; flex: none; object-fit: cover; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 500; }
.row { display: flex; gap: 6px; align-items: flex-start; }
.row + .row { margin-top: 4px; }
.body { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.name { font-weight: 500; }
.t { color: #8a939c; font-size: 11px; margin-left: 4px; white-space: nowrap; }
.post { padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px solid #e6e9ec; }
.media, .more { color: #8a939c; font-style: italic; }
.more { font-size: 12px; margin-bottom: 4px; }
`;

const row = (author: Author, size: number, body: string, date: number) =>
  `<div class="row">${avatar(author, size)}<div class="body"><span class="name" style="color:${peerColor(author.id)}">${escape(author.name)}</span> ${body}<span class="t">${time(date)}</span></div></div>`;

export function threadHtml(view: ThreadView): string {
  const post = view.post.text
    ? escape(clip(view.post.text, MAX_POST_CHARS))
    : `<span class="media">Media post</span>`;
  const more = view.hiddenComments
    ? `<div class="more">${view.hiddenComments} earlier comments not shown</div>`
    : "";
  const comments = view.comments
    .map((c) => row(c.author, 18, escape(clip(c.text, MAX_COMMENT_CHARS)), c.date))
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${CSS}</style></head><body><div id="thread">
<div class="post">${row(view.channel, 22, `<br>${post}`, view.post.date)}</div>
${more}${comments}
</div></body></html>`;
}
