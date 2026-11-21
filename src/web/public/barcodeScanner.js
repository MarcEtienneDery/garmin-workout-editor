(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./nutritionModel.js") : root.NutritionModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BarcodeScanner = api;
})(typeof self !== "undefined" ? self : this, function (NM) {
  "use strict";

  const NATIVE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
  const INTERVAL_MS = 220;
  const MAX_FRAME_WIDTH = 1280;

  class ScanError extends Error {}

  function explain(error) {
    const name = error && error.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") return new ScanError("The camera was refused. Allow it for this site in the browser's settings, then try again.");
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return new ScanError("No camera was found on this device.");
    if (name === "NotReadableError" || name === "TrackStartError") return new ScanError("The camera is in use by another app. Close it and try again.");
    if (name === "SecurityError") return new ScanError("The camera needs a secure page (HTTPS).");
    return new ScanError(`The camera could not be started${error && error.message ? `: ${error.message}` : "."}`);
  }

  function toLuminance(rgba, width, height) {
    const out = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    return out;
  }

  const readers = new WeakMap();
  function readerOf(ZX) {
    let reader = readers.get(ZX);
    if (!reader) {
      reader = new ZX.MultiFormatReader();
      reader.setHints(new Map([
        [ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E]],
        [ZX.DecodeHintType.TRY_HARDER, true],
      ]));
      readers.set(ZX, reader);
    }
    return reader;
  }

  function turnQuarter(lum, width, height) {
    const out = new Uint8ClampedArray(lum.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[x * height + (height - 1 - y)] = lum[y * width + x];
    return out;
  }

  function read(ZX, lum, width, height) {
    const bitmap = new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.RGBLuminanceSource(lum, width, height)));
    try {
      return NM.normalizeBarcode(readerOf(ZX).decodeWithState(bitmap).getText());
    } catch {
      return null;
    }
  }

  function decodeFrame(ZX, rgba, width, height) {
    const lum = toLuminance(rgba, width, height);
    return read(ZX, lum, width, height) || read(ZX, turnQuarter(lum, width, height), height, width);
  }

  let zxingLoading = null;
  function loadZxing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    zxingLoading = zxingLoading || fetch("/vendor/zxing/index.min.js")
      .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.text(); })
      .then((code) => {
        new Function("define", "exports", "module", code)();
        if (!window.ZXing) throw new Error("ZXing did not load");
        return window.ZXing;
      })
      .catch(() => { zxingLoading = null; throw new ScanError("The barcode reader could not be loaded. Check the connection and try again."); });
    return zxingLoading;
  }

  async function nativeDetector() {
    if (!window.BarcodeDetector) return null;
    try {
      const formats = typeof window.BarcodeDetector.getSupportedFormats === "function" ? await window.BarcodeDetector.getSupportedFormats() : NATIVE_FORMATS;
      const use = NATIVE_FORMATS.filter((f) => formats.includes(f));
      return use.length ? new window.BarcodeDetector({ formats: use }) : null;
    } catch {
      return null;
    }
  }

  async function start(video, onCode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new ScanError(window.isSecureContext === false ? "The camera needs a secure page (HTTPS)." : "This browser cannot use the camera.");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (e) { throw explain(e); }
    let stopped = false, timer = 0;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    };
    try {
      video.muted = true;
      video.setAttribute("playsinline", "");
      video.srcObject = stream;
      await video.play();
      const detector = await nativeDetector(), ZX = detector ? null : await loadZxing();
      if (stopped) return { stop };
      const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
      const look = async () => {
        if (stopped) return null;
        if (video.readyState < 2 || !video.videoWidth) return null;
        if (detector) {
          for (const hit of await detector.detect(video)) { const code = NM.normalizeBarcode(hit.rawValue); if (code) return code; }
          return null;
        }
        const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return decodeFrame(ZX, ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      };
      const tick = async () => {
        let code = null;
        try { code = await look(); } catch { }
        if (stopped) return;
        if (code) { onCode(code); return; }
        timer = setTimeout(tick, INTERVAL_MS);
      };
      tick();
    } catch (e) {
      stop();
      throw e instanceof ScanError ? e : explain(e);
    }
    return { stop };
  }

  return { ScanError, explain, toLuminance, turnQuarter, decodeFrame, start };
});
