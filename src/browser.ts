import puppeteer, { type Browser, type BrowserWorker } from "@cloudflare/puppeteer";

// Browser Rendering limits how many new browsers start per minute, so renders reuse an
// idle session and leave it running for the next comment instead of closing it.
const KEEP_ALIVE_MS = 120_000;

const OPEN_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1_000;

async function openBrowser(binding: BrowserWorker): Promise<Browser> {
  for (let attempt = 1; ; attempt++) {
    const sessions = await puppeteer.sessions(binding);
    for (const session of sessions.filter((s) => !s.connectionId)) {
      try {
        return await puppeteer.connect(binding, session.sessionId);
      } catch {
        // Another request took it first, or it just expired.
      }
    }
    try {
      return await puppeteer.launch(binding, { keep_alive: KEEP_ALIVE_MS });
    } catch (error) {
      // A session that was just disconnected takes a moment to show as free. Until then a
      // launch can hit the new-browser rate limit, so wait and look for a free session again.
      if (attempt === OPEN_ATTEMPTS || !String(error).includes("429")) throw error;
      await scheduler.wait(RETRY_DELAY_MS);
    }
  }
}

export async function renderPng(binding: BrowserWorker, html: string): Promise<Uint8Array> {
  const browser = await openBrowser(binding);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 480, height: 800, deviceScaleFactor: 2 });
    // The page is self-contained (inline CSS, data: images), so "load" is enough.
    await page.setContent(html, { waitUntil: "load", timeout: 15_000 });
    const element = await page.$("#thread");
    if (!element) throw new Error("#thread not found");
    return (await element.screenshot({ type: "png" })) as Uint8Array;
  } finally {
    await page.close().catch(() => {});
    await browser.disconnect();
  }
}
