import type { Metadata } from "next";
import ReviewWorkspace from "@/app/components/review-workspace";
import { createReviewPreviewData } from "@/src/preview/mr-fixtures";

export const metadata: Metadata = { title: "MR 样式预览 · ReviewX" };

export default function PreviewPage() {
  return <ReviewWorkspace previewData={createReviewPreviewData()} />;
}
