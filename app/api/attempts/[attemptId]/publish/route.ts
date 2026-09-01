import { z } from "zod";
import { apiError, jsonBody, noStoreJson } from "@/src/server/http";
import { getRuntime } from "@/src/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ ordinals: z.array(z.number().int().positive()).min(1) });

export async function POST(request: Request, context: { params: Promise<{ attemptId: string }> }): Promise<Response> {
  try {
    const body = bodySchema.parse(await jsonBody(request));
    const { attemptId } = await context.params;
    z.string().min(1).max(200).parse(attemptId);
    return noStoreJson(await (await getRuntime()).publishFindings(attemptId, body.ordinals));
  } catch (error) {
    return apiError(error);
  }
}
