import { z } from "zod";
import { apiError, jsonBody, noStoreJson } from "@/src/server/http";
import { getRuntime } from "@/src/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ decision: z.enum(["dismissed", "pending"]) });
const paramsSchema = z.object({
  attemptId: z.string().min(1).max(200),
  ordinal: z.string().regex(/^[1-9]\d*$/u).transform(Number).refine(Number.isSafeInteger),
});

export async function PATCH(request: Request, context: { params: Promise<{ attemptId: string; ordinal: string }> }): Promise<Response> {
  try {
    const body = bodySchema.parse(await jsonBody(request));
    const { attemptId, ordinal } = paramsSchema.parse(await context.params);
    return noStoreJson(await (await getRuntime()).decideFinding(attemptId, ordinal, body.decision));
  } catch (error) {
    return apiError(error);
  }
}
