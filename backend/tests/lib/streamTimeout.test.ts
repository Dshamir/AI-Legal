import { describe, it, expect } from "vitest";
import { withStreamTimeout, StreamTimeoutError } from "../../src/lib/streamTimeout";

describe("withStreamTimeout", () => {
  it("resolves when the promise completes before timeout", async () => {
    const result = await withStreamTimeout(Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });

  it("rejects with StreamTimeoutError when promise exceeds timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withStreamTimeout(slow, 50)).rejects.toThrow(StreamTimeoutError);
  });

  it("StreamTimeoutError has correct name", () => {
    const err = new StreamTimeoutError();
    expect(err.name).toBe("StreamTimeoutError");
    expect(err.message).toBe("LLM stream timed out");
  });

  it("cleans up timer on normal resolution", async () => {
    const result = await withStreamTimeout(Promise.resolve(42), 10000);
    expect(result).toBe(42);
  });
});
