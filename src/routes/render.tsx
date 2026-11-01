import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/ui-bits";
import { RenderStudio } from "@/components/RenderStudio";
import { AutoVideo } from "@/components/AutoVideo";

export const Route = createFileRoute("/render")({
  head: () => ({
    meta: [
      { title: "Render video — Tony AI YouTube Studio" },
      {
        name: "description",
        content:
          "Turn a script into a finished MP4: voiceover, visuals, music, subtitles and transitions.",
      },
    ],
  }),
  component: Render,
});

function Render() {
  return (
    <>
      <PageHeader
        title="Render video"
        desc="Turn a script into a finished, YouTube-ready MP4: voiceover, visuals, background music, automatic subtitles and transitions. Everything renders in your browser, so it costs nothing to run."
      />
      <AutoVideo />
      <RenderStudio />
    </>
  );
}
