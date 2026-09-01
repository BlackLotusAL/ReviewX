import { z } from "zod";
import { apiError, jsonBody, noStoreJson } from "@/src/server/http";
import { getRuntime } from "@/src/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ attemptId: string }> }): Promise<Response> {
  try {
    z.strictObject({}).parse(await jsonBody(request));
    const { attemptId } = await context.params;
    z.string().min(1).max(200).parse(attemptId);
    return noStoreJson(await (await getRuntime()).stopAttempt(attemptId));
  } catch (error) {
    return apiError(error);
  }
}
