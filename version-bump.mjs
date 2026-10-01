import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
    console.error("Error: npm_package_version is not set. Run this script via 'npm run version'.");
    process.exit(1);
}

// read minAppVersion from manifest.json and bump version to target version
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));

// Keep RELEASE_NOTES.md to a single current-version block. The file tends to
// accumulate older version blocks across releases; the published notes should
// only show the block for the version being released.
try {
    const notesPath = "RELEASE_NOTES.md";
    const notes = readFileSync(notesPath, "utf8");
    const lines = notes.split("\n");
    let secondHeading = -1;
    let seen = 0;
    for (let i = 0; i < lines.length; i++) {
        if (/^#\s+\d+\.\d+\.\d+/.test(lines[i])) {
            seen++;
            if (seen === 2) { secondHeading = i; break; }
        }
    }
    if (secondHeading !== -1) {
        const trimmed = lines.slice(0, secondHeading).join("\n").replace(/\s+$/, "") + "\n";
        writeFileSync(notesPath, trimmed);
    }
} catch { /* no RELEASE_NOTES.md to trim */ }
