import { z } from "zod";
import { apiError } from "@/src/server/http";
import { getRuntime } from "@/src/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ attemptId: string }> }): Promise<Response> {
  try {
    const { attemptId } = await context.params;
    z.string().min(1).max(200).parse(attemptId);
    return new Response(await (await getRuntime()).readReport(attemptId), {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
