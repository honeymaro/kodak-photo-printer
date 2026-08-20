/**
 * Generates a test image sized for the printer's square media.
 *
 * Useful for a first print: the colour bar and the border make it obvious
 * whether the geometry and the colour pipeline are right.
 *
 *   node tools/make-test-image.mjs out.png [size]
 */

import sharp from 'sharp';

const out = process.argv[2] ?? 'test-print.png';
const S = Number(process.argv[3] ?? 873);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
  <rect width="${S}" height="${S}" fill="#ffffff"/>
  <rect x="0" y="0" width="${S}" height="128" fill="#e4002b"/>
  <rect x="0" y="128" width="${S}" height="34" fill="#ffb81c"/>
  <text x="${S / 2}" y="88" font-family="Arial, Helvetica, sans-serif" font-size="66" font-weight="bold" fill="#ffffff" text-anchor="middle">KODAK RETRO 3</text>
  <text x="${S / 2}" y="330" font-family="Arial, Helvetica, sans-serif" font-size="50" fill="#111111" text-anchor="middle">hello from</text>
  <text x="${S / 2}" y="404" font-family="Arial, Helvetica, sans-serif" font-size="60" font-weight="bold" fill="#111111" text-anchor="middle">kodak-photo-printer</text>
  <text x="${S / 2}" y="474" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="#555555" text-anchor="middle">Bluetooth SPP, reverse engineered</text>
  <rect x="60" y="560" width="125" height="130" fill="#000000"/>
  <rect x="185" y="560" width="125" height="130" fill="#e4002b"/>
  <rect x="310" y="560" width="125" height="130" fill="#ffb81c"/>
  <rect x="435" y="560" width="125" height="130" fill="#00a651"/>
  <rect x="560" y="560" width="125" height="130" fill="#0072ce"/>
  <rect x="685" y="560" width="128" height="130" fill="#7d3f98"/>
  <rect x="60" y="560" width="753" height="130" fill="none" stroke="#000000" stroke-width="3"/>
  <text x="${S / 2}" y="790" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#888888" text-anchor="middle">${S} x ${S} | first print</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`wrote ${out} (${S}x${S})`);
