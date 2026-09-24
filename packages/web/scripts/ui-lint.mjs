#!/usr/bin/env node
/**
 * Guards the design system (.claude/skills/duckview-ui): fails on patterns the UI must not use again —
 * browser dialogs, font sizes off the scale, colours by name instead of meaning, gradients, raw selects.
 * A line opts out with `ui-lint-ignore: <reason>` in a comment on it or on the line above.
 * Literal hex colours are reported as warnings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const RULES = [
  { re: /(?<![.\w])(alert|confirm|prompt)\(/, why: 'browser dialog: use toast / confirmAction / promptAction' },
  { re: /text-\[\d+(\.\d+)?px\]/, why: 'font size off the scale: text-2xs · text-xs · text-body · text-title · text-page (text-display for KPI values)' },
  { re: /(?<![:\w-])text-(sm|base|lg|xl|[2-9]xl)\b/, why: 'Tailwind size off the scale: text-2xs · text-xs · text-body · text-title · text-page' },
  { re: /\b(bg|text|border|fill|stroke|ring|from|to|via)-(violet|purple|indigo|pink|rose|lime|teal|cyan)-\d/, why: 'colour by name: use accent / status tones / --series-*' },
  { re: /gradient\(|bg-gradient-/, why: 'gradients are not part of the design system' },
  { re: /<select\b/, why: 'raw <select>: use Select' },
];
const WARN = [{ re: /['"`]#[0-9a-fA-F]{6}['"`]/, why: 'literal hex colour' }];

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !p.includes(`${path.sep}lib${path.sep}mosaic${path.sep}`)) files.push(p);
  }
};
walk(src);

let errors = 0;
let warnings = 0;
for (const f of files) {
  const rel = path.relative(src, f);
  // The primitives define the rules (their own dialog helpers, the theme's colours).
  if (/components\/ui\/(feedback|focus)\.tsx?$|theme\//.test(rel)) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/ui-lint-ignore/.test(line) || /ui-lint-ignore/.test(lines[i - 1] ?? '') || /^\s*(\*|\/\/)/.test(line)) return;
    for (const r of RULES) if (r.re.test(line)) { errors++; console.log(`error  ${rel}:${i + 1}  ${r.why}\n       ${line.trim().slice(0, 140)}`); }
    for (const r of WARN) if (r.re.test(line)) { warnings++; if (process.argv.includes('--warnings')) console.log(`warn   ${rel}:${i + 1}  ${r.why}`); }
  });
}
console.log(`ui-lint: ${files.length} files, ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}${warnings && !process.argv.includes('--warnings') ? ' (--warnings lists them)' : ''}`);
process.exitCode = errors ? 1 : 0;
