import { apiError, noStoreJson } from "@/src/server/http";
import { getRuntime } from "@/src/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return noStoreJson((await getRuntime()).snapshot());
  } catch (error) {
    return apiError(error);
  }
}
