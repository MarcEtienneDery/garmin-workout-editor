/*
 * foodPhoto.js — gets a photo of a meal ready to send: shrunk, upright and without the phone's metadata.
 *
 * A phone photo is 3 to 12 MB and 4000 px wide; Claude reads one at 1568 px just as well, and the upload, the image tokens and the
 * wait all grow with the size. So the photo is decoded here, drawn on a canvas no larger than MAX_EDGE on its long side and encoded
 * again as a JPEG. Re-encoding applies the camera's rotation and drops the EXIF data (the GPS position included): only the pixels
 * leave the phone.
 *
 * A photo comes from a file the person picks (prepare) or from the camera, live in a dialog (startCamera: HTTPS only, like the barcode
 * scanner's). fitWithin, cameraAvailable and explainCamera are pure and have tests; the rest is the DOM part. Loaded by the page as a
 * plain script; the tests require() it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FoodPhoto = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_EDGE = 1568;
  const QUALITY = 0.85;
  const UNREADABLE = "That photo can't be read here. Use a JPEG or PNG.";

  /** Why a photo could not be used, in words for the person. */
  class PhotoError extends Error {}

  /** The size to draw a width × height picture at so that its long edge is at most `max`: never larger than it is, whole pixels; null for a size that is no picture. */
  function fitWithin(width, height, max = MAX_EDGE) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) return null;
    const scale = Math.min(1, max / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  /** The picture of a file, upright: createImageBitmap where the browser has it, an <img> otherwise. `close` frees it. */
  async function decode(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => { if (bitmap.close) bitmap.close(); } };
      } catch { /* an option or a format this browser lacks: the <img> below decodes it, or fails the same way */ }
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

  /** A blob as base64, without the data: prefix. */
  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new PhotoError(UNREADABLE));
      reader.readAsDataURL(blob);
    });
  }

  /** A picture (an <img>, an ImageBitmap or a <video> showing a frame) as what the server takes: { blob, mediaType: "image/jpeg", data (base64), width, height }. */
  async function encode(source, width, height) {
    const size = fitWithin(width, height);
    if (!size) throw new PhotoError(UNREADABLE);
    const canvas = document.createElement("canvas");
    canvas.width = size.width; canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size.width, size.height); // a PNG with transparency becomes white, not black
    ctx.drawImage(source, 0, 0, size.width, size.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    if (!blob) throw new PhotoError(UNREADABLE);
    return { blob, mediaType: "image/jpeg", data: await toBase64(blob), width: size.width, height: size.height };
  }

  /** A picked photo as what the server takes (see encode). Throws a PhotoError the person can read. */
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

  /** Whether a page can open the camera itself: the browser has getUserMedia and the page is secure (HTTPS or localhost); `secure` false is an insecure page. */
  function cameraAvailable(nav, secure) {
    return !!(nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === "function") && secure !== false;
  }

  function canUseCamera() {
    return typeof navigator !== "undefined" && cameraAvailable(navigator, typeof window !== "undefined" ? window.isSecureContext : undefined);
  }

  /** Why the camera could not be used, in words for the person. */
  function explainCamera(error) {
    const name = error && error.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") return new PhotoError("The camera was refused. Allow it for this site in the browser's settings, then try again, or upload a photo.");
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return new PhotoError("No camera was found on this device. Upload a photo instead.");
    if (name === "NotReadableError" || name === "TrackStartError") return new PhotoError("The camera is in use by another app. Close it and try again.");
    if (name === "SecurityError") return new PhotoError("The camera needs a secure page (HTTPS). Upload a photo instead.");
    return new PhotoError(`The camera could not be started${error && error.message ? `: ${error.message}` : "."}`);
  }

  /**
   * Open the camera into `video` (the back one on a phone). Resolves with { snap(), stop() }: snap() takes the frame on screen as a
   * photo (see encode); the caller stops the camera when its dialog closes, however it closes. Rejects with a PhotoError.
   */
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
      // iPhone plays a video fullscreen, or not at all, unless it is muted and inline
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
