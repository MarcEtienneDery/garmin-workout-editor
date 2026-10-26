// eslint-disable-next-line @typescript-eslint/no-var-requires
const FP = require("../web/public/foodPhoto.js");

describe("sizing a photo to send", () => {
  it("shrinks a phone photo so that its long edge is 1568 px, keeping its shape", () => {
    expect(FP.MAX_EDGE).toBe(1568);
    expect(FP.fitWithin(4000, 3000)).toEqual({ width: 1568, height: 1176 });
    expect(FP.fitWithin(3000, 4000)).toEqual({ width: 1176, height: 1568 }); // a portrait photo
    expect(FP.fitWithin(2000, 2000)).toEqual({ width: 1568, height: 1568 });
    expect(FP.fitWithin(4032, 3024)).toEqual({ width: 1568, height: 1176 });
  });

  it("never makes a photo larger", () => {
    expect(FP.fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(FP.fitWithin(1568, 1000)).toEqual({ width: 1568, height: 1000 });
    expect(FP.fitWithin(10, 10, 5000)).toEqual({ width: 10, height: 10 });
  });

  it("takes another longest edge", () => {
    expect(FP.fitWithin(400, 200, 100)).toEqual({ width: 100, height: 50 });
  });

  it("keeps at least a pixel of a very thin picture", () => {
    expect(FP.fitWithin(3000, 3, 100)).toEqual({ width: 100, height: 1 });
  });

  it.each([[0, 100], [100, 0], [-5, 100], [NaN, 100], [100, Infinity], ["100", 100], [undefined, 100]])("says %s × %s is no picture", (w, h) => {
    expect(FP.fitWithin(w, h)).toBeNull();
  });

  it("has an error the person can read for a photo it cannot use", () => {
    expect(new FP.PhotoError("That is not a photo.")).toBeInstanceOf(Error);
  });
});

describe("taking a photo with the camera", () => {
  const camera = { mediaDevices: { getUserMedia: () => Promise.resolve({}) } };

  it("can open the camera on a secure page whose browser has one", () => {
    expect(FP.cameraAvailable(camera, true)).toBe(true);
    expect(FP.cameraAvailable(camera, undefined)).toBe(true); // a browser that does not say is let try
  });

  it("cannot on a page that is not secure (plain http), nor in a browser without a camera API", () => {
    expect(FP.cameraAvailable(camera, false)).toBe(false);
    expect(FP.cameraAvailable({}, true)).toBe(false);
    expect(FP.cameraAvailable({ mediaDevices: {} }, true)).toBe(false);
    expect(FP.cameraAvailable(undefined, true)).toBe(false);
  });

  it.each([
    ["NotAllowedError", /refused/],
    ["PermissionDeniedError", /refused/],
    ["NotFoundError", /No camera/],
    ["OverconstrainedError", /No camera/],
    ["NotReadableError", /in use/],
    ["SecurityError", /HTTPS/],
  ])("says what %s means in words for the person", (name, words) => {
    const e = FP.explainCamera({ name });
    expect(e).toBeInstanceOf(FP.PhotoError);
    expect(e.message).toMatch(words);
  });

  it("names an unknown camera failure", () => {
    expect(FP.explainCamera({ name: "AbortError", message: "boom" }).message).toBe("The camera could not be started: boom");
    expect(FP.explainCamera(undefined).message).toBe("The camera could not be started.");
  });
});
