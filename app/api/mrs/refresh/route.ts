import { z } from "zod";
import { apiError, jsonBody, noStoreJson } from "@/src/server/http";
import { getRuntime } from "@/src/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    z.strictObject({}).parse(await jsonBody(request));
    return noStoreJson(await (await getRuntime()).refreshMrs());
  } catch (error) {
    return apiError(error);
  }
}
