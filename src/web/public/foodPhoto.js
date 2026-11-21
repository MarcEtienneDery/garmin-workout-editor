(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FoodPhoto = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_EDGE = 1568;
  const QUALITY = 0.85;
  const UNREADABLE = "That photo can't be read here. Use a JPEG or PNG.";

  class PhotoError extends Error {}

  function fitWithin(width, height, max = MAX_EDGE) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) return null;
    const scale = Math.min(1, max / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  async function decode(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => { if (bitmap.close) bitmap.close(); } };
      } catch { }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new PhotoError(UNREADABLE));
      reader.readAsDataURL(blob);
    });
  }

  async function encode(source, width, height) {
    const size = fitWithin(width, height);
    if (!size) throw new PhotoError(UNREADABLE);
    const canvas = document.createElement("canvas");
    canvas.width = size.width; canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(source, 0, 0, size.width, size.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    if (!blob) throw new PhotoError(UNREADABLE);
    return { blob, mediaType: "image/jpeg", data: await toBase64(blob), width: size.width, height: size.height };
  }

  async function prepare(file) {
    if (!file || (file.type && !/^image\//.test(file.type))) throw new PhotoError("That is not a photo.");
    let picture;
    try { picture = await decode(file); } catch { throw new PhotoError(UNREADABLE); }
    try {
      return await encode(picture.source, picture.width, picture.height);
    } finally {
      picture.close();
    }
  }

  function cameraAvailable(nav, secure) {
    return !!(nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === "function") && secure !== false;
  }

  function canUseCamera() {
    return typeof navigator !== "undefined" && cameraAvailable(navigator, typeof window !== "undefined" ? window.isSecureContext : undefined);
  }

  function explainCamera(error) {
    const name = error && error.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") return new PhotoError("The camera was refused. Allow it for this site in the browser's settings, then try again, or upload a photo.");
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return new PhotoError("No camera was found on this device. Upload a photo instead.");
    if (name === "NotReadableError" || name === "TrackStartError") return new PhotoError("The camera is in use by another app. Close it and try again.");
    if (name === "SecurityError") return new PhotoError("The camera needs a secure page (HTTPS). Upload a photo instead.");
    return new PhotoError(`The camera could not be started${error && error.message ? `: ${error.message}` : "."}`);
  }

  async function startCamera(video) {
    if (!canUseCamera()) throw new PhotoError(window.isSecureContext === false ? "The camera needs a secure page (HTTPS). Upload a photo instead." : "This browser cannot use the camera. Upload a photo instead.");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) { throw explainCamera(e); }
    const stop = () => {
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    };
    try {
      video.muted = true;
      video.setAttribute("playsinline", "");
      video.srcObject = stream;
      await video.play();
    } catch (e) {
      stop();
      throw explainCamera(e);
    }
    const snap = async () => {
      if (!video.videoWidth) throw new PhotoError("The camera is not ready yet.");
      return encode(video, video.videoWidth, video.videoHeight);
    };
    return { snap, stop };
  }

  return { PhotoError, MAX_EDGE, fitWithin, prepare, cameraAvailable, canUseCamera, explainCamera, startCamera };
});
