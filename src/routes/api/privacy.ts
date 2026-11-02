import { createFileRoute } from "@tanstack/react-router";

// Public privacy policy page (needed for the Google app consent screen). No data is read or stored here.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy - Tony AI YouTube Studio</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6;color:#111}h1{font-size:1.6rem}</style></head><body>
<h1>Privacy Policy - Tony AI YouTube Studio</h1>
<p>Tony AI YouTube Studio is a personal tool used by its owner, Ninsiima Anthony, to create videos and upload them to the owner's own YouTube channel.</p>
<h2>What we access</h2>
<p>With the owner's permission through Google sign-in, the app can upload videos to the owner's YouTube channel and read basic channel information. It does not access any other Google data.</p>
<h2>What we store</h2>
<p>The app stores the sign-in token needed to upload videos for the owner, and the owner's video drafts. Nothing is sold, shared with third parties, or used for advertising.</p>
<h2>Google API Services</h2>
<p>The use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>
<h2>Deleting your data</h2>
<p>The owner can disconnect the app at any time at myaccount.google.com/permissions, which removes its access.</p>
<h2>Contact</h2>
<p>ninsiimatony@gmail.com</p>
</body></html>`;

export const Route = createFileRoute("/api/privacy")({
  server: {
    handlers: {
      GET: async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
  },
});
