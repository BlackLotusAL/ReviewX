import { z } from "zod";
import { apiError, jsonBody, noStoreJson } from "@/src/server/http";
import { getRuntime } from "@/src/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ projectId: z.string().regex(/^[1-9]\d*$/u) });

export async function POST(request: Request): Promise<Response> {
  try {
    const body = bodySchema.parse(await jsonBody(request));
    return noStoreJson(await (await getRuntime()).addProject(body.projectId));
  } catch (error) {
    return apiError(error);
  }
}
