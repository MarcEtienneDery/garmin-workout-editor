import { readUploadAnswer, readUploadError } from "../mcp/tools/renpho";

describe("what Garmin's upload answer says", () => {
  it("reads a file Garmin took in", () => {
    expect(readUploadAnswer({ detailedImportResult: { successes: [{ internalId: 1 }], failures: [] } })).toBe("taken in");
    expect(readUploadAnswer({ detailedImportResult: { successes: [], failures: [] } })).toBe("accepted");
    expect(readUploadAnswer({ data: { detailedImportResult: { successes: [{}], failures: [] } } })).toBe("taken in");
  });

  it("does not call a file Garmin already has a failure", () => {
    expect(readUploadAnswer({ detailedImportResult: { successes: [], failures: [{ messages: [{ code: 202, content: "Duplicate Activity." }] }] } })).toBe("Garmin already had it");
  });

  it("throws what Garmin gave as the reason when it refused the file", () => {
    expect(() => readUploadAnswer({ detailedImportResult: { successes: [], failures: [{ messages: [{ code: 500, content: "Unsupported file" }] }] } })).toThrow("Garmin refused the file: Unsupported file");
    expect(() => readUploadAnswer({ detailedImportResult: { failures: [{ messages: [{ code: 202 }] }, { messages: [] }] } })).toThrow(/no reason given/);
  });

  it("says nothing when the answer has no import result", () => {
    expect(readUploadAnswer(undefined)).toBe("");
    expect(readUploadAnswer({})).toBe("");
  });
});

describe("an upload Garmin answered with an HTTP error", () => {
  const error = (status: number, text: string, data: unknown) => new Error(`ERROR: (${status}), ${text}, ${JSON.stringify(data)}`);

  it("counts a file Garmin already has (409) as taken in", () => {
    const duplicate = { detailedImportResult: { successes: [], failures: [{ messages: [{ code: 202, content: "Duplicate Upload" }] }] } };
    expect(readUploadError(error(409, "Conflict", duplicate))).toBe("Garmin already had it");
  });

  it("throws what Garmin said when it refused the file, and the error itself when it holds no answer", () => {
    expect(() => readUploadError(error(500, "Internal Server Error", { detailedImportResult: { failures: [{ messages: [{ code: 500, content: "Bad file" }] }] } }))).toThrow("Garmin refused the file: Bad file");
    const plain = new Error("ERROR: (500), Internal Server Error, {\"message\":\"oops\"}");
    expect(() => readUploadError(plain)).toThrow(plain);
    const network = new Error("socket hang up");
    expect(() => readUploadError(network)).toThrow(network);
    const html = new Error("ERROR: (502), Bad Gateway, <html>");
    expect(() => readUploadError(html)).toThrow(html);
  });
});
