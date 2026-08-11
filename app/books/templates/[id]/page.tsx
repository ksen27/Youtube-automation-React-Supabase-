import { TemplateReview } from "./template-review";

export const dynamic = "force-dynamic";

// Review a cloned template: confirm what the extractor decided is replaceable,
// and correct it where it got that wrong. This is what fixes a cloned page that
// still carries the reference site's own words.
export default async function TemplateReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TemplateReview templateId={id} />;
}
