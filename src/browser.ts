import puppeteer, { type Browser, type BrowserWorker } from "@cloudflare/puppeteer";

// Browser Rendering limits how many new browsers start per minute, so renders reuse an
// idle session and leave it running for the next comment instead of closing it.
const KEEP_ALIVE_MS = 120_000;

const OPEN_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1_000;

async function openBrowser(binding: BrowserWorker): Promise<{ browser: Browser; reused: boolean }> {
  for (let attempt = 1; ; attempt++) {
    const sessions = await puppeteer.sessions(binding);
    for (const session of sessions.filter((s) => !s.connectionId)) {
      try {
        return { browser: await puppeteer.connect(binding, session.sessionId), reused: true };
      } catch {
        // Another request took it first, or it just expired.
      }
    }
    try {
      return { browser: await puppeteer.launch(binding, { keep_alive: KEEP_ALIVE_MS }), reused: false };
    } catch (error) {
      // A session that was just disconnected takes a moment to show as free. Until then a
      // launch can hit the new-browser rate limit, so wait and look for a free session again.
      if (attempt === OPEN_ATTEMPTS || !String(error).includes("429")) throw error;
      await scheduler.wait(RETRY_DELAY_MS);
    }
  }
}

export async function renderPng(binding: BrowserWorker, html: string): Promise<Uint8Array> {
  const started = Date.now();
  const { browser, reused } = await openBrowser(binding);
  const opened = Date.now();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 480, height: 800, deviceScaleFactor: 2 });
    // The page is self-contained (inline CSS, data: images), so "load" is enough.
    await page.setContent(html, { waitUntil: "load", timeout: 15_000 });
    const element = await page.$("#thread");
    if (!element) throw new Error("#thread not found");
    const loaded = Date.now();
    const png = (await element.screenshot({ type: "png" })) as Uint8Array;
    console.log(
      JSON.stringify({
        event: "render_timing",
        reused,
        open_ms: opened - started,
        page_ms: loaded - opened,
        screenshot_ms: Date.now() - loaded,
        bytes: png.byteLength,
      }),
    );
    return png;
  } finally {
    await page.close().catch(() => {});
    await browser.disconnect();
  }
}
