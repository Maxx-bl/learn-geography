// Downloads one SVG flag per country (keyed by ISO 3166-1 alpha-2 code) into
// assets/flags/, sourced once from the flag-icons project (MIT licensed,
// https://github.com/lipis/flag-icons) so the site stays fully offline at
// runtime - no CDN calls while playing.
//
// Run: npm run generate-flags
const fs = require("fs");
const path = require("path");
const https = require("https");

const FLAG_ICONS_VERSION = "7";
const OUT_DIR = path.join(__dirname, "..", "assets", "flags");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

async function main() {
  const countries = require("./countries_raw.json"); // [name, capital, iso]
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let ok = 0;
  const failed = [];
  for (const [name, , iso] of countries) {
    const code = iso.toLowerCase();
    const dest = path.join(OUT_DIR, code + ".svg");
    if (fs.existsSync(dest)) {
      ok++;
      continue;
    }
    const url = `https://cdn.jsdelivr.net/npm/flag-icons@${FLAG_ICONS_VERSION}/flags/4x3/${code}.svg`;
    try {
      await download(url, dest);
      ok++;
    } catch (err) {
      failed.push({ iso, name, error: err.message });
    }
  }

  console.log(`Flags ready: ${ok}/${countries.length}`);
  if (failed.length) {
    console.log("Missing flags:");
    failed.forEach((f) => console.log("  ", f.iso, f.name, "-", f.error));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
