// Builds the game into one self-contained HTML page (JS and CSS inlined) for hosting.
// Usage: npm run build:page -- <output.html>
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'dist/road-to-the-nfl.html';
execSync('npx vite build --base=./', { stdio: 'inherit' });
const assets = readdirSync('dist/assets');
const js = readFileSync(join('dist/assets', assets.find((f) => f.endsWith('.js'))), 'utf8');
const css = readFileSync(join('dist/assets', assets.find((f) => f.endsWith('.css'))), 'utf8');
if (js.includes('</script')) throw new Error('bundle contains a closing script tag');

const page = `<meta charset="utf-8">
<title>Road to the NFL</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap">
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
