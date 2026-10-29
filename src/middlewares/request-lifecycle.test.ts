import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestContext } from "./request-lifecycle.ts";

function requestAndResponse() {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  const response = new ServerResponse(request);
  return { request, response };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("request lifecycle", () => {
  it("keeps the signal active when the completed request body closes", () => {
    const { request, response } = requestAndResponse();
    const context = createRequestContext(response, 30000);
    request.emit("end");
    request.emit("close");
    expect(context.signal.aborted).toBe(false);
    expect(context.canRespond()).toBe(true);
    context.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts pending work and destroys the connection at the deadline", () => {
    const { response } = requestAndResponse();
    const context = createRequestContext(response, 30000);
    const reasons: unknown[] = [];
    context.signal.addEventListener("abort", () => {
      reasons.push(context.signal.reason);
    });
    vi.advanceTimersByTime(29999);
    expect(context.canRespond()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(context.deadlineSignal.aborted).toBe(true);
    expect(context.disconnectedSignal.aborted).toBe(false);
    expect(context.signal.reason).toBe(context.deadlineSignal.reason);
    expect(reasons).toEqual([context.deadlineSignal.reason]);
    expect(response.destroyed).toBe(true);
    expect(context.canRespond()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    response.emit("close");
    expect(context.disconnectedSignal.aborted).toBe(false);
  });

  it("uses only the time remaining since the request callback entry", () => {
    const { request, response } = requestAndResponse();
    vi.advanceTimersByTime(8000);
    const context = createRequestContext(response, 30000);
    vi.advanceTimersByTime(1000);
    request.emit("end");
    request.emit("close");
    vi.advanceTimersByTime(20999);
    expect(context.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(context.deadlineSignal.aborted).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(context.deadline).toBe(30000);
  });

  it("rejects a late response even when the deadline timer has not run", () => {
    const { response } = requestAndResponse();
    const context = createRequestContext(response, 30000);
    vi.spyOn(performance, "now").mockReturnValue(30000);
    expect(context.deadlineSignal.aborted).toBe(false);
    expect(context.canRespond()).toBe(false);
    expect(context.deadlineSignal.aborted).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("immediately expires a context created after its original deadline", () => {
    const { response } = requestAndResponse();
    vi.advanceTimersByTime(30001);
    const context = createRequestContext(response, 30000);
    expect(context.signal.aborted).toBe(true);
    expect(context.deadlineSignal.aborted).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts unfinished responses on client disconnection", () => {
    const { response } = requestAndResponse();
    const context = createRequestContext(response, 30000);
    response.emit("close");
    expect(context.signal.aborted).toBe(true);
    expect(context.disconnectedSignal.aborted).toBe(true);
    expect(context.deadlineSignal.aborted).toBe(false);
    expect(context.signal.reason).toBe(context.disconnectedSignal.reason);
    expect(context.canRespond()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles response transport errors without an uncaught event", () => {
    const { response } = requestAndResponse();
    const context = createRequestContext(response, 30000);
    expect(() =>
      response.emit("error", new Error("transport failed")),
    ).not.toThrow();
    expect(context.disconnectedSignal.aborted).toBe(true);
    expect(context.deadlineSignal.aborted).toBe(false);
    expect(response.destroyed).toBe(true);
    expect(context.canRespond()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels its timer and removes only its listeners on disposal", () => {
    const { response } = requestAndResponse();
    const unrelatedClose = () => {};
    response.on("close", unrelatedClose);
    const context = createRequestContext(response, 30000);
    context.dispose();
    context.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(response.listeners("close")).toEqual([unrelatedClose]);
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
    expect(context.canRespond()).toBe(false);
    vi.advanceTimersByTime(30000);
    expect(context.signal.aborted).toBe(false);
  });

  it("keeps the deadline active after end until the response finishes", () => {
    const { response } = requestAndResponse();
    const context = createRequestContext(response, 30000);
    response.end("pending output");
    expect(response.writableEnded).toBe(true);
    expect(response.writableFinished).toBe(false);
    context.dispose();
    expect(context.canRespond()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30000);
    expect(context.deadlineSignal.aborted).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up on successful finish without aborting the request", () => {
    const { response } = requestAndResponse();
    const context = createRequestContext(response, 30000);
    response.end("done");
    response.emit("finish");
    response.emit("close");
    expect(context.signal.aborted).toBe(false);
    expect(context.canRespond()).toBe(false);
    expect(response.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30000);
    expect(context.signal.aborted).toBe(false);
  });

  it("does not leave listeners or a timer on an already destroyed response", () => {
    const { response } = requestAndResponse();
    response.destroy();
    const context = createRequestContext(response, 30000);
    expect(context.disconnectedSignal.aborted).toBe(true);
    expect(context.canRespond()).toBe(false);
    expect(response.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
