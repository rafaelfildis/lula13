// Converte o GeoJSON dos estados (click_that_hood/brazil-states.geojson) em caminhos SVG
// já projetados e simplificados, para o front-end não precisar de biblioteca de mapas.
//
// Uso: node ferramentas/gerar-mapa.mjs <brazil-states.geojson> public/brasil-ufs.json

import { readFileSync, writeFileSync } from "node:fs";

const [entrada, saida] = process.argv.slice(2);
if (!entrada || !saida) {
  console.error("Uso: node ferramentas/gerar-mapa.mjs <geojson> <saida.json>");
  process.exit(1);
}

const LARGURA = 1000;
const TOLERANCIA = 0.7; // px, Douglas-Peucker
const AREA_MIN = 4; // px², descarta ilhotas

const geo = JSON.parse(readFileSync(entrada, "utf8"));
const COS = Math.cos((-15 * Math.PI) / 180); // latitude média do Brasil

let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
const bruto = ([lon, lat]) => [lon * COS, -lat];
for (const f of geo.features)
  for (const poly of f.geometry.coordinates)
    for (const anel of poly)
      for (const p of anel) {
        const [x, y] = bruto(p);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
const escala = LARGURA / (maxX - minX);
const ALTURA = Math.ceil((maxY - minY) * escala);
const proj = (p) => {
  const [x, y] = bruto(p);
  return [(x - minX) * escala, (y - minY) * escala];
};

function distSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function simplificar(pts) {
  if (pts.length < 3) return pts;
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distSeg(pts[i], pts[0], pts[pts.length - 1]);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= TOLERANCIA) return [pts[0], pts[pts.length - 1]];
  return [...simplificar(pts.slice(0, idx + 1)).slice(0, -1), ...simplificar(pts.slice(idx))];
}
const area = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
function centroide(pts) {
  let a = 0, cx = 0, cy = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
  });
  return [cx / (3 * a), cy / (3 * a)];
}
const r1 = (n) => Math.round(n * 10) / 10;

const ufs = geo.features.map((f) => {
  let d = "";
  let maior = null, maiorArea = 0;
  for (const poly of f.geometry.coordinates) {
    poly.forEach((anel, i) => {
      const pts = simplificar(anel.map(proj));
      const a = Math.abs(area(pts));
      if (a < AREA_MIN || pts.length < 4) return;
      if (i === 0 && a > maiorArea) { maiorArea = a; maior = pts; }
      d += "M" + pts.map((p) => `${r1(p[0])},${r1(p[1])}`).join("L") + "Z";
    });
  }
  const [cx, cy] = centroide(maior);
  return { uf: f.properties.sigla.toLowerCase(), nome: f.properties.name, d, cx: r1(cx), cy: r1(cy) };
});

writeFileSync(saida, JSON.stringify({ largura: LARGURA, altura: ALTURA, ufs }));
console.log(`${ufs.length} UFs · ${LARGURA}x${ALTURA} · ${(JSON.stringify(ufs).length / 1024).toFixed(0)} KB → ${saida}`);
