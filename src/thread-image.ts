export interface Author {
  id: number;
  name: string;
  /** `data:image/jpeg;base64,…` profile photo, or undefined to draw initials. */
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

/** One line in the picture. Mirrors `Row` in render/src/lib.rs. */
export interface RenderRow {
  name: string;
  color: string;
  text: string;
  time: string;
  initials: string;
  /** Base64 JPEG. */
  avatar?: string;
}

/** Input of the WASM renderer. Mirrors `Thread` in render/src/lib.rs. */
export interface RenderInput {
  scale: number;
  post: RenderRow;
  comments: RenderRow[];
  note?: string;
}

const row = (author: Author, text: string, date: number): RenderRow => ({
  name: author.name,
  color: peerColor(author.id),
  text,
  time: time(date),
  initials: initials(author.name),
  avatar: author.photo?.slice(author.photo.indexOf(",") + 1),
});

export function threadImage(view: ThreadView): RenderInput {
  return {
    scale: 2,
    post: row(view.channel, view.post.text ? clip(view.post.text, MAX_POST_CHARS) : "(media post)", view.post.date),
    comments: view.comments.map((c) => row(c.author, clip(c.text, MAX_COMMENT_CHARS), c.date)),
    note: view.hiddenComments ? `${view.hiddenComments} earlier comments not shown` : undefined,
  };
}
