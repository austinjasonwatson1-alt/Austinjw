// Builds the game into one self-contained HTML page (JS and CSS inlined) for hosting.
// Usage: npm run build:page -- <output.html>
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'dist/road-to-the-nfl.html';
execSync('npx vite build --base=./', { stdio: 'inherit' });
const assets = readdirSync('dist/assets');
const js = readFileSync(join('dist/assets', assets.find((f) => f.endsWith('.js'))), 'utf8');
let css = readFileSync(join('dist/assets', assets.find((f) => f.endsWith('.css'))), 'utf8');
// Inline the fonts as data URIs (woff2 only; every current browser reads it) so the page works offline.
css = css.replace(/,\s*url\([^)]*\.woff\)\s*format\(["']?woff["']?\)/g, '');
css = css.replace(/url\(["']?(?:\.\/|\/assets\/|\.\/assets\/)?([^)"']+\.woff2)["']?\)/g, (m, file) => {
  const name = file.split('/').pop();
  if (!assets.includes(name)) return m;
  return `url(data:font/woff2;base64,${readFileSync(join('dist/assets', name)).toString('base64')})`;
});
if (/url\([^)]*\.woff2?\)/.test(css)) throw new Error('a font was left as an external file');
if (js.includes('</script')) throw new Error('bundle contains a closing script tag');

const page = `<meta charset="utf-8">
<title>Road to the NFL</title>
<style>
:root { color-scheme: dark; background: #070b17; }
html, body { height: 100%; }
${css}
</style>
<div id="root"></div>
<script type="module">
${js}
</script>
`;
writeFileSync(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
