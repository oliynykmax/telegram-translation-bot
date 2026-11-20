import { fetchWithRetry, type Deps, type Upstream } from "./upstream";

export interface Message {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  sender_chat?: { id: number };
  is_automatic_forward?: boolean;
  message_thread_id?: number;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
  text?: string;
  caption?: string;
  entities?: { type: string; offset: number; length: number }[];
}

export function parseMessage(update: unknown): Message | undefined {
  if (typeof update !== "object" || update === null || !("message" in update)) return undefined;
  const message = update.message as Partial<Message> | null;
  if (
    typeof message?.message_id !== "number" ||
    typeof message.date !== "number" ||
    typeof message.chat?.id !== "number"
  ) {
    return undefined;
  }
  return message as Message;
}

export function isStartCommand(message: Message): boolean {
  const command = message.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (!command || !message.text) return false;
  return message.text.slice(0, command.length).split("@")[0] === "/start";
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
