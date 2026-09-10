// Regenerates js/world-map-data.js from scripts/countries_raw.json
// (French name, capital, ISO 3166-1 alpha-2) and scripts/world_wrapped.js
// (SVG path data per ISO code, sourced from the jsVectorMap "world" map).
//
// Run: node scripts/generate-map-data.js
const fs = require("fs");
const path = require("path");

const countries = require("./countries_raw.json");
const map = require("./world_wrapped.js");

const countryList = countries.map(([name, capital, iso]) => ({
  name,
  capital,
  iso,
  hasMap: !!map.paths[iso],
}));

const mapPaths = {};
for (const [iso, obj] of Object.entries(map.paths)) {
  if (iso.startsWith("_")) continue; // unidentified/disputed territory blobs
  mapPaths[iso] = obj.path;
}

const out =
  "window.COUNTRIES = " + JSON.stringify(countryList) + ";\n" +
  "window.MAP_VIEWBOX = \"0 0 " + map.width + " " + map.height + "\";\n" +
  "window.MAP_PATHS = " + JSON.stringify(mapPaths) + ";\n";

const outPath = path.join(__dirname, "..", "js", "world-map-data.js");
fs.writeFileSync(outPath, out);
console.log("Written", outPath, "(" + out.length + " bytes)");
console.log(
  "Countries with a map shape:",
  countryList.filter((c) => c.hasMap).length,
  "/",
  countryList.length
);
