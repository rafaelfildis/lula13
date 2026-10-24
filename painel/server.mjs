// Painel da apuração 2026: mapa + chat ao vivo + câmera/microfone (WebRTC em malha).
//
//   node server.mjs                  -> 2º turno real (TSE), consulta a cada 30 s
//   node server.mjs --simular        -> apuração fictícia acelerada, para demonstrar
//   node server.mjs --turno 1        -> dados do 1º turno (já totalizados)
//   node server.mjs --porta 8080 --intervalo 45

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { descobrirEleicoes, buscarSnapshot } from "./tse.mjs";
import { criarSimulador } from "./simulador.mjs";

const args = process.argv.slice(2);
const valor = (nome, padrao) => {
  const i = args.indexOf(nome);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};
const PORTA = Number(valor("--porta", process.env.PORT || "3000"));
const SIMULAR = args.includes("--simular");
const TURNO = Number(valor("--turno", "2"));
const INTERVALO = Math.max(15, Number(valor("--intervalo", "30")) || 30) * 1000;
const MAX_CAMERAS = 8; // malha P2P: acima disso cada navegador envia vídeo demais
const PUBLICO = fileURLToPath(new URL("./public/", import.meta.url));

// ---------- fonte de dados da apuração ----------
let fonte;
if (SIMULAR) {
  fonte = await criarSimulador({ duracaoSeg: Number(valor("--duracao", "300")) });
} else {
  const eleicoes = await descobrirEleicoes(TURNO);
  fonte = { descricao: `TSE ao vivo · ${TURNO}º turno`, snapshot: () => buscarSnapshot(eleicoes) };
}

let apuracao = null;
const eleitosAnunciados = new Set();

async function atualizarApuracao() {
  try {
    const snap = await fonte.snapshot();
    snap.fonte = fonte.descricao;
    snap.consultadoEm = new Date().toISOString();
    const mudou = JSON.stringify(snap.presidente) !== JSON.stringify(apuracao?.presidente) ||
      JSON.stringify(snap.governador) !== JSON.stringify(apuracao?.governador);
    apuracao = snap;
    if (mudou) transmitir({ tipo: "apuracao", dados: apuracao });
    anunciarEleitos(snap);
  } catch (err) {
    console.error("Falha ao atualizar apuração:", err.message);
  }
}

// Avisa no chat quando o TSE marca alguém como eleito
function anunciarEleitos(snap) {
  const disputas = [["presidente", "br", snap.presidente.br], ...Object.entries(snap.governador).map(([uf, r]) => ["governador", uf, r])];
  const ativos = new Set();
  for (const [cargo, uf, r] of disputas) {
    const eleito = r?.cands?.find((c) => c.eleito);
    if (!eleito) continue;
    const chave = `${cargo}:${uf}:${eleito.numero}`;
    ativos.add(chave);
    if (eleitosAnunciados.has(chave)) continue;
    eleitosAnunciados.add(chave);
    if (!apuracaoInicialCarregada) continue; // não anuncia o que já estava decidido quando o servidor subiu
    const onde = cargo === "presidente" ? "presidente do Brasil" : `governador(a) — ${uf.toUpperCase()}`;
    postarSistema(`🗳️ ${snap.simulado ? "[SIMULAÇÃO · fictício] " : ""}${eleito.nome} (${eleito.partido}) está eleito(a) ${onde} com ${eleito.pct.toLocaleString("pt-BR")}% dos votos válidos.`);
  }
  // Na simulação a apuração recomeça; libera os anúncios para a próxima rodada
  for (const k of eleitosAnunciados) if (!ativos.has(k)) eleitosAnunciados.delete(k);
  apuracaoInicialCarregada = true;
}
let apuracaoInicialCarregada = false;

// ---------- arquivos estáticos ----------
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const servidor = http.createServer(async (req, res) => {
  const caminho = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (caminho === "/api/apuracao") {
    res.writeHead(apuracao ? 200 : 503, { "content-type": TIPOS[".json"], "cache-control": "no-store" });
    return res.end(JSON.stringify(apuracao ?? { erro: "carregando" }));
  }
  const arquivo = normalize(join(PUBLICO, caminho === "/" ? "index.html" : caminho));
  if (!arquivo.startsWith(normalize(PUBLICO))) return res.writeHead(403).end();
  try {
    const corpo = await readFile(arquivo);
    res.writeHead(200, { "content-type": TIPOS[extname(arquivo)] ?? "application/octet-stream" });
    res.end(corpo);
  } catch {
    res.writeHead(404).end("não encontrado");
  }
});

// ---------- chat, presença e sinalização WebRTC ----------
const wss = new WebSocketServer({ server: servidor, path: "/ws", maxPayload: 256 * 1024 });
const usuarios = new Map(); // id -> { ws, id, nome, cor, cam, mic, ultimaMsg }
const historico = [];
const CORES = ["#ff8a65", "#4fc3f7", "#aed581", "#ffd54f", "#ba68c8", "#4db6ac", "#f06292", "#9575cd", "#e57373", "#81c784"];

const publico = (u) => ({ id: u.id, nome: u.nome, cor: u.cor, cam: u.cam, mic: u.mic });
const enviar = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
function transmitir(msg, excetoId) {
  const dados = JSON.stringify(msg);
  for (const u of usuarios.values()) if (u.id !== excetoId && u.ws.readyState === 1) u.ws.send(dados);
}
function guardar(msg) {
  historico.push(msg);
  if (historico.length > 150) historico.shift();
}
function postarSistema(texto) {
  const msg = { tipo: "msg", sistema: true, texto, em: Date.now() };
  guardar(msg);
  transmitir(msg);
}

wss.on("connection", (ws) => {
  let eu = null;

  ws.on("message", (bruto) => {
    let m;
    try { m = JSON.parse(bruto); } catch { return; }

    if (m.tipo === "entrar" && !eu) {
      const nome = String(m.nome ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
      if (nome.length < 2) return enviar(ws, { tipo: "erro", texto: "Digite um nome com pelo menos 2 letras." });
      eu = { ws, id: randomUUID().slice(0, 8), nome, cor: CORES[usuarios.size % CORES.length], cam: false, mic: false, ultimaMsg: 0 };
      enviar(ws, { tipo: "bemvindo", eu: publico(eu), usuarios: [...usuarios.values()].map(publico), historico, apuracao });
      usuarios.set(eu.id, eu);
      transmitir({ tipo: "entrou", usuario: publico(eu) }, eu.id);
      postarSistema(`${nome} entrou na sala`);
      return;
    }
    if (!eu) return;

    switch (m.tipo) {
      case "msg": {
        const texto = String(m.texto ?? "").trim().slice(0, 500);
        if (!texto || Date.now() - eu.ultimaMsg < 400) return;
        eu.ultimaMsg = Date.now();
        const msg = { tipo: "msg", de: eu.id, nome: eu.nome, cor: eu.cor, texto, em: Date.now() };
        guardar(msg);
        transmitir(msg);
        break;
      }
      case "midia": {
        const querCam = !!m.cam;
        const camerasAtivas = [...usuarios.values()].filter((u) => u.cam && u.id !== eu.id).length;
        if (querCam && !eu.cam && camerasAtivas >= MAX_CAMERAS) {
          enviar(ws, { tipo: "erro", texto: `A sala já tem ${MAX_CAMERAS} câmeras abertas. Você pode participar pelo microfone.` });
          eu.mic = !!m.mic;
        } else {
          eu.cam = querCam;
          eu.mic = !!m.mic;
        }
        transmitir({ tipo: "midia", id: eu.id, cam: eu.cam, mic: eu.mic });
        break;
      }
      case "sinal": {
        // Repassa oferta/resposta/ICE entre dois participantes
        const alvo = usuarios.get(m.para);
        if (alvo) enviar(alvo.ws, { tipo: "sinal", de: eu.id, dados: m.dados });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!eu) return;
    usuarios.delete(eu.id);
    transmitir({ tipo: "saiu", id: eu.id });
    postarSistema(`${eu.nome} saiu`);
  });
});

// Mantém conexões vivas atrás de proxies/túneis
setInterval(() => wss.clients.forEach((c) => c.readyState === 1 && c.ping()), 25000);

await atualizarApuracao();
setInterval(atualizarApuracao, SIMULAR ? 3000 : INTERVALO);

servidor.listen(PORTA, () => {
  console.log(`Painel da apuração em http://localhost:${PORTA}  ·  fonte: ${fonte.descricao}`);
});
