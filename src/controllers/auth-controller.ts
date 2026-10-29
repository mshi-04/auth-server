import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "../models/index.ts";
import type { CredentialsRequest, UserIdResponse } from "../schemas/index.ts";
import type { AuthService } from "../services/index.ts";

export class AuthController {
  #service: AuthService;

  private constructor(service: AuthService) {
    this.#service = service;
  }

  static create(service: AuthService): AuthController {
    return new AuthController(service);
  }

  async register(
    _req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
    input: CredentialsRequest,
  ): Promise<void> {
    const result = await this.#service.register(
      { email: input.email, rawPassword: input.password },
      context.signal,
    );
    this.#writeResult(res, context, 201, { user_id: result.userId });
  }

  async login(
    _req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
    input: CredentialsRequest,
  ): Promise<void> {
    const result = await this.#service.login(
      { email: input.email, rawPassword: input.password },
      context.signal,
    );
    this.#writeResult(res, context, 200, { user_id: result.userId });
  }

  #writeResult(
    res: ServerResponse,
    context: RequestContext,
    status: number,
    result: UserIdResponse,
  ): void {
    if (!context.canRespond()) {
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(status);
    res.end(JSON.stringify(result));
  }
}
