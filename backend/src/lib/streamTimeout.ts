const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS) || 180_000;

export class StreamTimeoutError extends Error {
  constructor() {
    super("LLM stream timed out");
    this.name = "StreamTimeoutError";
  }
}

export function withStreamTimeout<T>(
  promise: Promise<T>,
  timeoutMs = STREAM_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StreamTimeoutError()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
