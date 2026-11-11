// Turns the single-file build (dist-single/index.html) into a claude.ai artifact page:
// the artifact host adds its own <!doctype>/<html>/<head>/<body>, so we strip ours.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('dist-single/index.html', 'utf8');
const head = src.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = src.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';
const cleanHead = head
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
// <title> must come first so the host finds it
const title = cleanHead.match(/<title>[\s\S]*?<\/title>/i)?.[0] ?? '<title>Clothredee</title>';
const rest = cleanHead.replace(title, '');
writeFileSync('dist-single/clothredee.html', `${title}\n${rest.trim()}\n${body.trim()}\n`);
console.log('wrote dist-single/clothredee.html', (title.length + rest.length + body.length) / 1024 | 0, 'KB');
