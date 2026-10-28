import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "../models/index.ts";

export interface WebAssets {
  html: Buffer;
  css: Buffer;
  js: Buffer;
}

export class WebController {
  #assets: WebAssets;

  private constructor(assets: WebAssets) {
    this.#assets = {
      html: Buffer.from(assets.html),
      css: Buffer.from(assets.css),
      js: Buffer.from(assets.js),
    };
  }

  static create(assets: WebAssets): WebController {
    return new WebController(assets);
  }

  index(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): void {
    this.#writeAsset(
      req,
      res,
      context,
      "text/html; charset=utf-8",
      this.#assets.html,
    );
  }

  css(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): void {
    this.#writeAsset(
      req,
      res,
      context,
      "text/css; charset=utf-8",
      this.#assets.css,
    );
  }

  javascript(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): void {
    this.#writeAsset(
      req,
      res,
      context,
      "text/javascript; charset=utf-8",
      this.#assets.js,
    );
  }

  #writeAsset(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
    contentType: string,
    content: Buffer,
  ): void {
    if (!context.canRespond()) {
      return;
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", content.length);
    res.writeHead(200);
    res.end(req.method === "HEAD" ? undefined : content);
  }
}
