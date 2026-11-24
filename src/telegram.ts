import { fetchWithRetry, type Deps, type Upstream } from "./upstream";

export interface Message {
  message_id: number;
  date: number;
  /** Set only on edited messages. */
  edit_date?: number;
  chat: { id: number; type: string };
  sender_chat?: { id: number; title?: string };
  from?: { id: number; first_name: string; last_name?: string };
  is_automatic_forward?: boolean;
  message_thread_id?: number;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
  text?: string;
  caption?: string;
  entities?: Entity[];
  caption_entities?: Entity[];
}

type Entity = { type: string; offset: number; length: number };

/** Reads a new or edited message. An edited one always carries `edit_date`. */
export function parseMessage(update: unknown): Message | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const edited = "edited_message" in update;
  if (!edited && !("message" in update)) return undefined;
  const message = (edited ? update.edited_message : update.message) as Partial<Message> | null;
  if (
    typeof message?.message_id !== "number" ||
    typeof message.date !== "number" ||
    typeof message.chat?.id !== "number"
  ) {
    return undefined;
  }
  return edited ? ({ ...message, edit_date: message.edit_date ?? message.date } as Message) : (message as Message);
}

export function isStartCommand(message: Message): boolean {
  const command = message.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (!command || !message.text) return false;
  return message.text.slice(0, command.length).split("@")[0] === "/start";
}

/**
 * Whether the message calls the bot on purpose: `@username` anywhere, or `/translate`
 * (optionally `/translate@username`) at the start. Returns the text with that call removed.
 */
export function summons(message: Message, username: string): { rest: string } | undefined {
  const text = message.text ?? message.caption;
  const entities = message.text !== undefined ? message.entities : message.caption_entities;
  if (!text || !entities) return undefined;
  const name = username.toLowerCase();
  // Entity offsets count UTF-16 code units, the same as JavaScript string indices.
  const call = entities.find((e) => {
    const value = text.slice(e.offset, e.offset + e.length).toLowerCase();
    if (e.type === "mention") return value === `@${name}`;
    if (e.type !== "bot_command" || e.offset !== 0) return false;
    const [command, target] = value.split("@");
    return command === "/translate" && (target === undefined || target === name);
  });
  if (!call) return undefined;
  const rest = (text.slice(0, call.offset) + text.slice(call.offset + call.length)).trim();
  return { rest };
}

export async function reply(
  deps: Deps,
  token: string,
  message: Message,
  text: string,
): Promise<Upstream<number>> {
  const result = await fetchWithRetry(deps, `https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: message.chat.id,
      text,
      ...(message.chat.type === "private"
        ? {}
        : { reply_parameters: { message_id: message.message_id } }),
    }),
  });
  if (!result.ok) return result;
  const body = await result.value.json<{ result?: { message_id?: number } }>();
  return { ok: true, value: body.result?.message_id ?? 0 };
}

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

/**
 * Whether the user belongs to the chat. The bot must be an admin there. Telegram answers 400
 * for users it has never seen in the chat, which also means "not a member".
 */
export async function isMember(
  deps: Deps,
  token: string,
  chatId: number,
  userId: number,
): Promise<Upstream<boolean>> {
  const query = new URLSearchParams({ chat_id: String(chatId), user_id: String(userId) });
  const result = await fetchWithRetry(deps, `${api(token, "getChatMember")}?${query}`, {});
  if (!result.ok) return result.transient ? result : { ok: true, value: false };
  const body = await result.value.json<{ result?: { status?: string; is_member?: boolean } }>();
  const status = body.result?.status;
  const member =
    status === "creator" ||
    status === "administrator" ||
    status === "member" ||
    (status === "restricted" && body.result?.is_member === true);
  return { ok: true, value: member };
}

/** Who a comment is shown as: the chat for anonymous admins and channel senders, else the user. */
export function authorOf(message: Message): { id: number; name: string } {
  if (message.sender_chat) {
    return { id: message.sender_chat.id, name: message.sender_chat.title ?? "Anonymous" };
  }
  const from = message.from;
  if (!from) return { id: 0, name: "Unknown" };
  return { id: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(" ") };
}

function photoForm(fields: Record<string, string>, png: Uint8Array): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("photo", new Blob([png], { type: "image/png" }), "thread.png");
  return form;
}

export async function sendPhoto(
  deps: Deps,
  token: string,
  chatId: number,
  replyTo: number,
  png: Uint8Array,
): Promise<Upstream<number>> {
  const result = await fetchWithRetry(deps, api(token, "sendPhoto"), {
    method: "POST",
    body: photoForm(
      {
        chat_id: String(chatId),
        reply_parameters: JSON.stringify({ message_id: replyTo }),
      },
      png,
    ),
  });
  if (!result.ok) return result;
  const body = await result.value.json<{ result?: { message_id?: number } }>();
  return { ok: true, value: body.result?.message_id ?? 0 };
}

export async function editPhoto(
  deps: Deps,
  token: string,
  chatId: number,
  messageId: number,
  png: Uint8Array,
): Promise<Upstream<void>> {
  const result = await fetchWithRetry(deps, api(token, "editMessageMedia"), {
    method: "POST",
    body: photoForm(
      {
        chat_id: String(chatId),
        message_id: String(messageId),
        media: JSON.stringify({ type: "photo", media: "attach://photo" }),
      },
      png,
    ),
  });
  if (result.ok || result.detail.includes("message is not modified")) return { ok: true, value: undefined };
  return result;
}

/** Smallest profile photo as a data: URI, or undefined when there is none or it can't be fetched. */
export async function profilePhoto(deps: Deps, token: string, id: number): Promise<string | undefined> {
  const call = async <T>(method: string, params: Record<string, string | number>) => {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const result = await fetchWithRetry(deps, `${api(token, method)}?${query}`, {});
    return result.ok ? (await result.value.json<{ result?: T }>()).result : undefined;
  };
  const fileId =
    id < 0
      ? (await call<{ photo?: { small_file_id: string } }>("getChat", { chat_id: id }))?.photo
          ?.small_file_id
      : (await call<{ photos: { file_id: string }[][] }>("getUserProfilePhotos", { user_id: id, limit: 1 }))
          ?.photos[0]?.[0]?.file_id;
  if (!fileId) return undefined;
  const file = await call<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!file?.file_path) return undefined;
  const download = await fetchWithRetry(deps, `https://api.telegram.org/file/bot${token}/${file.file_path}`, {});
  if (!download.ok) return undefined;
  const bytes = Buffer.from(await download.value.arrayBuffer());
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}
