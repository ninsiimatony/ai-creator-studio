import { createFileRoute, Link } from "@tanstack/react-router";
import { useStudio } from "@/lib/studio-store";
import { PageHeader } from "@/components/ui-bits";
import { PublishCard } from "@/components/PublishCard";

export const Route = createFileRoute("/publish")({
  head: () => ({
    meta: [
      { title: "Publishing — Tony AI YouTube Studio" },
      {
        name: "description",
        content:
          "Prepare YouTube titles, descriptions, tags and thumbnails, then upload after approval.",
      },
    ],
  }),
  component: Publish,
});

function Publish() {
  const { videos } = useStudio();
  return (
    <>
      <PageHeader
        title="Publishing"
        desc="Prepare each video's YouTube details. Uploading is only possible after you approve the video, defaults to private, and going public always needs you to type PUBLISH."
      />
      {videos.length === 0 && (
        <p className="panel p-6 text-sm text-muted-foreground">
          No videos yet. Start one in{" "}
          <Link to="/pipeline" className="text-primary underline">
            Production
          </Link>
          .
        </p>
      )}
      <div className="space-y-4">
        {videos.map((v) => (
          // Re-key on server-side changes so the editor reflects saved values.
          <PublishCard key={`${v.id}:${v.approval}:${v.youtubeStatus}`} video={v} />
        ))}
      </div>
    </>
  );
}
