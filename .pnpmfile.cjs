// Local development convenience: when a sibling @anupheaus package is checked out
// next to this repo, resolve it from that local source (a live symlink) instead of the
// registry. In CI only this repo is checked out, so the siblings are absent and the
// registry versions declared in `dependencies` are used unchanged.
//
// This hook only rewrites the in-memory manifest during install resolution — it never
// edits package.json on disk and never affects the published tarball.
const fs = require('fs');
const path = require('path');

const SIBLINGS = ['@anupheaus/common', '@anupheaus/react-ui', '@anupheaus/nexus', '@anupheaus/mxdb'];

function readPackage(pkg) {
  for (const name of SIBLINGS) {
    if (pkg.dependencies?.[name] == null) continue;
    const shortName = name.slice('@anupheaus/'.length);
    if (fs.existsSync(path.resolve(__dirname, '..', shortName))) pkg.dependencies[name] = `link:../${shortName}`;
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
