export interface LlmRequest {
  system: string;
  user: string;
  /** JSON Schema the answer must follow. */
  schema: Record<string, unknown>;
}

export interface LlmClient {
  /** Human-readable "provider/model" for reports. */
  readonly label: string;
  /** Returns the raw JSON text of the answer. */
  completeJson(req: LlmRequest): Promise<string>;
}

export class LlmRefusalError extends Error {}
