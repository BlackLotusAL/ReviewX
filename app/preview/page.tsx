import type { Metadata } from "next";
import ReviewWorkspace from "@/src/client/review-workspace/review-workspace";
import { createReviewPreviewData } from "@/src/client/review-workspace/preview-data";

export const metadata: Metadata = { title: "MR 样式预览 · ReviewX" };

export default function PreviewPage() {
  return <ReviewWorkspace previewData={createReviewPreviewData()} />;
}
