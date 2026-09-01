import { z } from "zod";
import { apiError, jsonBody, noStoreJson } from "@/src/server/http";
import { getRuntime } from "@/src/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  try {
    z.strictObject({}).parse(await jsonBody(request));
    const { projectId } = await context.params;
    z.string().regex(/^[1-9]\d*$/u).parse(projectId);
    return noStoreJson(await (await getRuntime()).removeProject(projectId));
  } catch (error) {
    return apiError(error);
  }
}
