import { describe, expect, it } from "vitest";
import { renderPng } from "../src/render";
import { threadImage } from "../src/thread-image";

const pngSize = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

describe("WASM renderer", () => {
  it("draws a thread as a 960 px wide PNG that grows with its comments", () => {
    const author = { id: 5, name: "Олена Коваленко" };
    const view = (comments: number) =>
      threadImage({
        channel: { id: -100, name: "Neuromax" },
        post: { text: "Post with an emoji 🇺🇦", date: 1_800_000_000 },
        comments: Array.from({ length: comments }, (_, i) => ({
          author,
          text: `Comment ${i} ❤️`,
          date: 1_800_000_000 + i,
        })),
        hiddenComments: 0,
      });

    const short = renderPng(view(0));
    const long = renderPng(view(4));
    expect([...short.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngSize(short).width).toBe(960);
    expect(pngSize(long).height).toBeGreaterThan(pngSize(short).height + 4 * 36);
  });
});
