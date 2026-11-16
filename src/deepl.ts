import { fetchWithRetry, type Deps, type Upstream } from "./upstream";

const endpoint = (apiKey: string) =>
  apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";

export async function translateToEnglish(
  deps: Deps,
  apiKey: string,
  text: string,
): Promise<Upstream<string>> {
  const result = await fetchWithRetry(deps, endpoint(apiKey), {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: [text], source_lang: "UK", target_lang: "EN-US" }),
  });
  if (!result.ok) return result;
  const body = await result.value.json<{ translations?: { text?: string }[] }>();
  const translated = body.translations?.[0]?.text;
  return translated
    ? { ok: true, value: translated }
    : { ok: false, transient: false, detail: "DeepL returned no translation" };
}
