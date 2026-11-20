import type { RenderInput } from "./thread-image";
import wasm from "./thread-render.wasm";

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  render(ptr: number, len: number): number;
  output_ptr(): number;
}

const instantiate = () => new WebAssembly.Instance(wasm, {}).exports as unknown as Exports;
let wasmExports = instantiate();

/** Draws the thread picture with the Rust renderer in render/. */
export function renderPng(input: RenderInput): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(input));
  try {
    const ex = wasmExports;
    const ptr = ex.alloc(json.length);
    new Uint8Array(ex.memory.buffer, ptr, json.length).set(json);
    const length = ex.render(ptr, json.length);
    ex.dealloc(ptr, json.length);
    if (length === 0) throw new Error("renderer rejected its input");
    return new Uint8Array(ex.memory.buffer, ex.output_ptr(), length).slice();
  } catch (error) {
    // A Rust panic traps and can leave the instance's state half-updated, so start fresh.
    wasmExports = instantiate();
    throw error;
  }
}

// Warm up while the Worker starts: font parsing and glyph rasterization then count against
// the 1-second startup limit instead of the first request's 10 ms of CPU.
const ALPHABET =
  "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 .,:;!?'’\"-—()… " +
  "абвгґдеєжзиіїйклмнопрстуфхцчшщьюя АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ";
const warm = { name: "Ab", color: "#000000", text: ALPHABET, time: "00:00", initials: "AB" };
renderPng({ scale: 2, post: warm, comments: [warm], note: "1" });
