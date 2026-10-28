export class SourceIdValidationError extends Error {
  readonly unknownSourceIds: readonly string[];

  constructor(message: string, unknownSourceIds: readonly string[]) {
    super(message);
    this.name = "SourceIdValidationError";
    this.unknownSourceIds = unknownSourceIds;
  }
}
