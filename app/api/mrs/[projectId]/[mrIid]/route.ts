import { z } from "zod";
import { apiError, noStoreJson } from "@/src/server/http";
import { getRuntime } from "@/src/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ projectId: string; mrIid: string }> }): Promise<Response> {
  try {
    const params = await context.params;
    z.strictObject({
      projectId: z.string().regex(/^[1-9]\d*$/u),
      mrIid: z.string().regex(/^[1-9]\d*$/u),
    }).parse(params);
    return noStoreJson(await (await getRuntime()).getMrDetail(params.projectId, params.mrIid));
  } catch (error) {
    return apiError(error);
  }
}
