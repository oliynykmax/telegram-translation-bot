export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type Upstream<T> =
  | { ok: true; value: T }
  | { ok: false; transient: boolean; detail: string };

const ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 5_000;

const isRetryable = (status: number) => status === 429 || status >= 500;

async function retryAfterMs(response: Response): Promise<number | undefined> {
  const header = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const body = await response
    .clone()
    .json<{ parameters?: { retry_after?: number } }>()
    .catch(() => undefined);
  const seconds = body?.parameters?.retry_after;
  return typeof seconds === "number" ? seconds * 1000 : undefined;
}

export async function fetchWithRetry(
  deps: Deps,
  url: string,
  init: RequestInit,
): Promise<Upstream<Response>> {
  let detail = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let delay = BASE_DELAY_MS * 2 ** attempt;
    try {
      const response = await deps.fetch(url, init);
      if (response.ok) return { ok: true, value: response };
      detail = `HTTP ${response.status}: ${(await response.clone().text()).slice(0, 200)}`;
      if (!isRetryable(response.status)) return { ok: false, transient: false, detail };
      delay = (await retryAfterMs(response)) ?? delay;
    } catch (error) {
      detail = `network: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (attempt === ATTEMPTS - 1 || delay > MAX_DELAY_MS) break;
    await deps.sleep(delay);
  }
  return { ok: false, transient: true, detail };
}
