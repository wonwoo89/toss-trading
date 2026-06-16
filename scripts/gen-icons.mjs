// PWA/홈스크린 PNG 아이콘 생성기.
// public/favicon.svg(우상향 차트 로고)를 검정 계열 배경 위에 올려 각 크기로 렌더한다.
//   실행: node scripts/gen-icons.mjs  (또는 pnpm run gen:icons)
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BG = '#0a0a0a'; // 앱 테마와 동일한 검정 계열 배경

// 512 캔버스에 로고(48 viewBox)를 중앙 ~58% 영역에 배치(maskable 안전 영역 충족).
// nested <svg>(viewBox 0 0 48)로 좌표/그라데이션/마스크를 깔끔히 매핑.
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none">
  <rect width="512" height="512" fill="${BG}"/>
  <svg x="106" y="95" width="300" height="300" viewBox="0 0 48 48" fill="none">
    <defs>
      <linearGradient id="trend" x1="4" y1="0" x2="45" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#f2a7b1"/>
        <stop offset=".34" stop-color="#b095f0"/>
        <stop offset=".5" stop-color="#a4c4f2"/>
        <stop offset=".65" stop-color="#b095f0"/>
        <stop offset="1" stop-color="#f2a7b1"/>
      </linearGradient>
      <linearGradient id="fade" x1="0" y1="6" x2="0" y2="46" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff"/>
        <stop offset=".45" stop-color="#fff"/>
        <stop offset="1" stop-color="#4a4a4a"/>
      </linearGradient>
      <mask id="fadeMask"><rect width="48" height="48" fill="url(#fade)"/></mask>
    </defs>
    <g mask="url(#fadeMask)">
      <path d="M1.75 45 L1.75 38 L4 38 C8 37 13 24 18 23 C22 22 25 30 30 30 C36 30 40 12 45 7 L47.25 7 L47.25 45 Z" fill="url(#trend)"/>
      <path d="M4 38 C8 37 13 24 18 23 C22 22 25 30 30 30 C36 30 40 12 45 7" fill="none" stroke="url(#trend)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </svg>
</svg>`;

const targets = [
  { file: 'pwa-192.png', size: 192 },
  { file: 'pwa-512.png', size: 512 },
  { file: 'pwa-maskable-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
];

for (const { file, size } of targets) {
  const resvg = new Resvg(iconSvg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  const out = resolve(root, 'public', file);
  writeFileSync(out, png);
  console.log(`wrote public/${file} (${size}x${size}, ${png.length} bytes)`);
}
