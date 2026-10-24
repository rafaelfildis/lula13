// Servidor local só para desenvolvimento: entrega a pasta public/ (o mesmo conteúdo publicado no GitHub Pages).
// Dados do TSE, chat e vídeo rodam no navegador; não há lógica aqui.
//
//   node server.mjs               -> http://localhost:3000
//   node server.mjs --porta 8080

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const i = args.indexOf("--porta");
const PORTA = Number(i >= 0 ? args[i + 1] : process.env.PORT || 3000);
const PUBLICO = fileURLToPath(new URL("./public/", import.meta.url));
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

http
  .createServer(async (req, res) => {
    const caminho = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const arquivo = normalize(join(PUBLICO, caminho.endsWith("/") ? caminho + "index.html" : caminho));
    if (!arquivo.startsWith(normalize(PUBLICO))) return res.writeHead(403).end();
    try {
      const corpo = await readFile(arquivo);
      res.writeHead(200, { "content-type": TIPOS[extname(arquivo)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(corpo);
    } catch {
      res.writeHead(404).end("não encontrado");
    }
  })
  .listen(PORTA, () => {
    console.log(`Painel em http://localhost:${PORTA}`);
  });
