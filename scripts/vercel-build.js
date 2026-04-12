/**
 * Vercel build step — inject MAPBOX_TOKEN into HTML files.
 *
 * Reads MAPBOX_TOKEN from env (set via Vercel dashboard or CLI) and
 * replaces every __MAPBOX_TOKEN__ placeholder in the viewer HTML files.
 */
const fs = require("fs");
const path = require("path");

const token = process.env.MAPBOX_TOKEN || "";
if (!token) {
  console.warn("[vercel-build] MAPBOX_TOKEN not set — map will not render.");
}

const files = [
  "market/viewer/app.html",
  "market/viewer/app-mockup.html",
];

for (const rel of files) {
  const abs = path.resolve(__dirname, "..", rel);
  if (!fs.existsSync(abs)) {
    console.log(`[vercel-build] skip ${rel} (not found)`);
    continue;
  }
  const content = fs.readFileSync(abs, "utf8");
  const replaced = content.replace(/__MAPBOX_TOKEN__/g, token);
  fs.writeFileSync(abs, replaced);
  console.log(`[vercel-build] injected token into ${rel}`);
}

console.log("[vercel-build] done");
