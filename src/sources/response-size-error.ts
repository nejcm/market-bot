export class SourceResponseTooLargeError extends Error {
  constructor(adapter: string, maxResponseBytes: number) {
    super(`${adapter} source response exceeded ${String(maxResponseBytes)} bytes`);
    this.name = "SourceResponseTooLargeError";
  }
}
