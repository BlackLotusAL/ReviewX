import { apiError, jsonBody, noStoreJson } from "@/src/server/http";
import { getRuntime } from "@/src/server/bootstrap";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try {
    await jsonBody(request);
    return noStoreJson(await (await getRuntime()).resumeQueue());
  } catch (error) { return apiError(error); }
}
