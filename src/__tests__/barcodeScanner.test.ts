import * as ZX from "@zxing/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const BS = require("../web/public/barcodeScanner.js");

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const R = L.map((p) => [...p].map((b) => (b === "0" ? "1" : "0")).join(""));
const G = R.map((p) => [...p].reverse().join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** The bars of an EAN-13 (a 12-digit UPC-A is one with a leading 0) or an EAN-8 as modules, the ZXing build having no writer for them. */
function modules(code: string): boolean[] {
  const digits = [...(code.length === 12 ? `0${code}` : code)].map(Number);
  let bits = "101";
  if (digits.length === 13) {
    digits.slice(1, 7).forEach((d, i) => (bits += PARITY[digits[0]][i] === "L" ? L[d] : G[d]));
    bits += "01010" + digits.slice(7).map((d) => R[d]).join("");
  } else {
    bits += digits.slice(0, 4).map((d) => L[d]).join("") + "01010" + digits.slice(4).map((d) => R[d]).join("");
  }
  return [...bits + "101"].map((b) => b === "1");
}

/** A barcode as the pixels of a camera frame (RGBA): bars `scale` pixels per module, 60 modules tall, on grey, optionally turned a quarter. */
function frame(code: string, { scale = 3, width = 640, height = 480, turned = false }: { scale?: number; width?: number; height?: number; turned?: boolean } = {}) {
  const row = modules(code);
  const bars = Array.from({ length: 60 }, () => row);
  const picture = turned ? bars[0].map((_, x) => bars.map((r) => r[x]).reverse()) : bars;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([200, 200, 200, 255], i * 4);
  const rows = picture.length * scale, cols = picture[0].length * scale;
  const left = Math.floor((width - cols) / 2), top = Math.floor((height - rows) / 2);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = picture[Math.floor(y / scale)][Math.floor(x / scale)] ? 20 : 245;
      rgba.set([v, v, v, 255], ((top + y) * width + left + x) * 4);
    }
  }
  return { rgba, width, height };
}

describe("reading a barcode from a camera frame with ZXing (the path an iPhone takes)", () => {
  it.each([
    ["an EAN-13", "3017620422003"],
    ["a UPC-A, which the reader reports as the 12 digits printed", "894700010137"],
    ["an EAN-8", "96385074"],
  ])("reads %s", (_, code) => {
    const f = frame(code);
    expect(BS.decodeFrame(ZX, f.rgba, f.width, f.height)).toBe(code);
  });

  it("reads a small barcode in a large frame, as when the phone is held back", () => {
    const f = frame("3017620422003", { scale: 2, width: 1280, height: 720 });
    expect(BS.decodeFrame(ZX, f.rgba, f.width, f.height)).toBe("3017620422003");
  });

  it("reads a barcode turned a quarter, as when the phone is held sideways", () => {
    const f = frame("3017620422003", { turned: true });
    expect(BS.decodeFrame(ZX, f.rgba, f.width, f.height)).toBe("3017620422003");
  });

  it("finds nothing in a frame with no barcode, and goes on reading the next one", () => {
    const blank = new Uint8ClampedArray(640 * 480 * 4).fill(180);
    expect(BS.decodeFrame(ZX, blank, 640, 480)).toBeNull();
    const f = frame("3017620422003");
    expect(BS.decodeFrame(ZX, f.rgba, f.width, f.height)).toBe("3017620422003");
  });

  it("turns a picture a quarter", () => {
    expect([...BS.turnQuarter(new Uint8ClampedArray([1, 2, 3, 4, 5, 6]), 3, 2)]).toEqual([4, 1, 5, 2, 6, 3]);
  });

  it("turns pixels into brightness", () => {
    expect([...BS.toLuminance(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]), 3, 1)]).toEqual([255, 0, 76]);
  });
});

describe("why the camera could not start", () => {
  it("says it in words", () => {
    expect(BS.explain({ name: "NotAllowedError" }).message).toMatch(/refused/);
    expect(BS.explain({ name: "NotFoundError" }).message).toMatch(/No camera/);
    expect(BS.explain({ name: "NotReadableError" }).message).toMatch(/in use/);
    expect(BS.explain({ name: "SecurityError" }).message).toMatch(/HTTPS/);
    expect(BS.explain(new Error("boom")).message).toBe("The camera could not be started: boom");
    expect(BS.explain({ name: "NotAllowedError" })).toBeInstanceOf(BS.ScanError);
  });
});
