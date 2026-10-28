export interface RequestContext {
  readonly signal: AbortSignal;
  readonly disconnectedSignal: AbortSignal;
  readonly deadlineSignal: AbortSignal;
  readonly deadline: number;
  canRespond(): boolean;
}
