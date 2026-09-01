import { ZodError } from "zod";
import { AppError, unexpectedError, validationError } from "./errors";
import { Redactor } from "./redaction";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export function assertSameOrigin(request: Request): void {
  const expected = process.env.REVIEWX_ORIGIN ?? "http://127.0.0.1:3210";
  const expectedHost = new URL(expected).host;
  if (request.headers.get("host") !== expectedHost || request.headers.get("origin") !== expected) {
    throw new AppError({
      code: "FORBIDDEN_ORIGIN",
      message: "ReviewX 已拒绝非同源请求。",
      reason: "请求 Host 或 Origin 与当前 loopback 服务地址不一致。",
      impact: "请求未执行。",
      nextStep: `只从 ${expected} 页面操作 ReviewX。`,
      technical: "Mutation Host/Origin validation failed.",
      httpStatus: 403,
    });
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new AppError({
    code: "INVALID_CONTENT_TYPE",
    message: "ReviewX 只接受 JSON 状态变更请求。",
    reason: "Content-Type 不是 application/json。",
    impact: "请求未执行。",
    nextStep: "刷新页面后重试。",
    technical: "Mutation content type validation failed.",
    httpStatus: 415,
  });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_JSON_BODY_BYTES) throw new AppError({
    code: "REQUEST_TOO_LARGE",
    message: "ReviewX 拒绝过大的请求正文。",
    reason: "JSON 请求超过 1 MiB。",
    impact: "请求未执行。",
    nextStep: "刷新页面并使用正常的 ReviewX 控件重试。",
    technical: "Mutation body exceeded one MiB.",
    httpStatus: 413,
  });
}

export async function jsonBody(request: Request): Promise<unknown> {
  assertSameOrigin(request);
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Request body is empty.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AppError({
          code: "REQUEST_TOO_LARGE",
          message: "ReviewX 拒绝过大的请求正文。",
          reason: "实际 JSON 请求超过 1 MiB。",
          impact: "请求未执行。",
          nextStep: "刷新页面并使用正常的 ReviewX 控件重试。",
          technical: "Mutation body exceeded one MiB while streaming.",
          httpStatus: 413,
        });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError({
      code: "INVALID_JSON",
      message: "请求 JSON 无法解析。",
      reason: "请求正文不是合法 JSON。",
      impact: "请求未执行。",
      nextStep: "刷新页面后重试。",
      technical: error instanceof Error ? error.message : String(error),
      httpStatus: 400,
      cause: error,
    });
  }
}

export function noStoreJson(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(value, { ...init, headers });
}

export function apiError(error: unknown): Response {
  const appError = error instanceof ZodError
    ? validationError("请求参数不符合 ReviewX 接口约定。")
    : unexpectedError(error, "请求");
  const redactor = new Redactor(process.env);
  return noStoreJson({ error: appError.toSafeView((value) => redactor.redact(value)) }, { status: appError.httpStatus });
}
