// Painel da apuração: mapa (esquerda) + sala ao vivo com chat, câmera e microfone (direita).
// Roda 100% no navegador (GitHub Pages):
// - resultados: direto dos JSON públicos do TSE;
// - quem está na sala e o chat: brokers MQTT públicos (lib/mensageiro.js), que funcionam em qualquer rede;
// - câmera e microfone: WebRTC entre os navegadores via Trystero (sinalização por relays Nostr).

import { joinRoom, selfId } from "https://cdn.jsdelivr.net/npm/trystero@0.25.4/+esm";
import { descobrirEleicoes, buscarSnapshot } from "./lib/tse.js?v=202610251758";
import { criarCanal } from "./lib/mensageiro.js?v=202610251758";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, texto) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (texto != null) e.textContent = texto;
  return e;
};
const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
const fmtPct1 = (n) => Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtPct = (n) => Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Estrela do PT ao lado do nome de cada pessoa (símbolo #estrela-pt no index.html)
const estrelaPT = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "estrela");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#estrela-pt");
  svg.append(use);
  return svg;
};
const iniciais = (nome) => nome.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");

const params = new URLSearchParams(location.search);
const TURNO = Number(params.get("turno")) || 2;
// Uma sala só para todo mundo (celular e computador). Rodando em localhost, usa uma sala de testes à parte.
const SALA = ["localhost", "127.0.0.1"].includes(location.hostname) ? "testes-local" : "principal";
const APP_ID = "lula13-apuracao-2026";
const INTERVALO_TSE = 30000;
const MAX_CAMERAS = 8; // malha P2P: acima disso cada navegador envia vídeo demais
const PRESENCA_MS = 15000; // cada um avisa "estou aqui" a cada 15 s
const AUSENTE_MS = 45000; // sem aviso por 45 s = saiu
// Servidor TURN (Metered, app "lula13", credencial "lula13"): retransmite o vídeo quando a conexão direta
// entre redes falha (4G, CGNAT, Wi-Fi de empresa). Fica visível no site; o risco é só alguém gastar a cota.
// Para trocar: painel da Metered → TURN Server → Credentials.
const TURN = [
  {
    urls: [
      "turn:global.relay.metered.ca:80",
      "turn:global.relay.metered.ca:80?transport=tcp",
      "turn:global.relay.metered.ca:443",
      "turns:global.relay.metered.ca:443?transport=tcp",
    ],
    username: "bd5414958c9a40666ff2c412",
    credential: "q97RuwtMihZyWra5",
  },
];
const AGUARDANDO = "Aguardando o início da apuração · divulgação a partir das 17h (Brasília)";

const PALETA = ["#ff3b4e", "#3d8bfd", "#f5b83d", "#33c3a0", "#b07cf0", "#9aa5b1"];
const CORES = ["#ff8a65", "#4fc3f7", "#aed581", "#ffd54f", "#ba68c8", "#4db6ac", "#f06292", "#9575cd", "#e57373", "#81c784"];
const corDoId = (id) => CORES[[...id].reduce((s, c) => s + c.charCodeAt(0), 0) % CORES.length];

const estado = {
  eu: null,
  usuarios: new Map(), // peerId -> { id, nome, cor, cam, mic }
  streams: new Map(), // peerId -> MediaStream recebido
  mensagens: [],
  apuracao: null,
  cargo: "presidente",
  sel: "br", // "br", "zz" ou sigla da UF
  mapa: null,
  stream: null,
  vista: "sala", // só no celular: "sala" ou "mapa"
  naoLidas: 0,
};
const celular = matchMedia("(max-width: 860px)");
let sala, canal;
const vistoEm = new Map(); // peerId -> último aviso de presença

// ======================= entrada =======================
// Chuva de estrelas do PT atrás do cartão de entrada
(function chuvaDeEstrelas() {
  const caixa = $("#chuva");
  const quantas = innerWidth < 600 ? 20 : 36;
  for (let i = 0; i < quantas; i++) {
    const gota = estrelaPT();
    gota.classList.add("gota");
    if (Math.random() < 0.3) gota.classList.add("vermelha");
    const dur = 7 + Math.random() * 9;
    const props = {
      "--x": `${Math.random() * 100}%`,
      "--y": `${Math.random() * 100}%`,
      "--tam": `${16 + Math.random() * 48}px`,
      "--op": (0.35 + Math.random() * 0.6).toFixed(2),
      "--dur": `${dur.toFixed(1)}s`,
      "--atraso": `${(-Math.random() * dur).toFixed(1)}s`, // negativo: já começa espalhada pela tela
      "--deriva": `${(Math.random() * 16 - 8).toFixed(1)}vw`,
      "--giro": `${Math.round(Math.random() * 540 - 270)}deg`,
    };
    for (const [k, v] of Object.entries(props)) gota.style.setProperty(k, v);
    caixa.append(gota);
  }
})();

try { $("#nome").value = localStorage.getItem("apuracao-nome") || ""; } catch {}

$("#form-entrada").addEventListener("submit", (e) => {
  e.preventDefault();
  const nome = $("#nome").value.replace(/\s+/g, " ").trim().slice(0, 30);
  if (nome.length < 2) return ($("#erro-entrada").textContent = "Digite um nome com pelo menos 2 letras.");
  try { localStorage.setItem("apuracao-nome", nome); } catch {}
  $("#erro-entrada").textContent = "";
  entrar(nome);
});

function entrar(nome) {
  estado.eu = { id: selfId, nome, cor: corDoId(selfId), cam: false, mic: false };
  $("#entrada").hidden = true;
  $("#painel").hidden = false;
  $("#convite-midia").hidden = false;
  renderPresenca();
  carregarMapa().then(() => estado.apuracao && receberApuracao(estado.apuracao));
  adicionarMsg({ id: "local-entrou", sistema: true, texto: "Você entrou na sala. Procurando quem está assistindo…", em: Date.now() });

  // ---- presença e chat: MQTT ----
  canal = criarCanal(`lula13-apuracao-2026/v1/${SALA}`, {
    aoReceber: tratarPacote,
    aoConectar: () => anunciar("oi"),
    aoMudarConexao: renderPresenca,
    despedida: { t: "tchau", id: selfId },
  });
  setInterval(() => anunciar("presenca"), PRESENCA_MS);
  setInterval(removerAusentes, 5000);
  window.addEventListener("pagehide", () => canal.fechar({ t: "tchau", id: selfId }));

  // ---- câmera e microfone: WebRTC ----
  sala = joinRoom({ appId: APP_ID, ...(TURN.length && { turnConfig: TURN }) }, "sala-" + SALA);
  sala.onPeerJoin = (id) => {
    if (estado.stream) sala.addStream(estado.stream, { target: id });
  };
  sala.onPeerLeave = (id) => {
    estado.streams.delete(id);
    pararMedidor(id);
    atualizarTile(id);
  };
  sala.onPeerStream = (stream, id) => {
    estado.streams.set(id, stream);
    atualizarTile(id);
  };
}

const anunciar = (t) => canal?.publicar({ t, id: selfId, nome: estado.eu.nome, cam: estado.eu.cam, mic: estado.eu.mic });
const historicoRespondido = new Set(); // ids de quem já recebeu histórico de alguém

function tratarPacote(m) {
  const id = String(m.id ?? "").slice(0, 40);
  if (!id) return;
  switch (m.t) {
    case "oi":
    case "presenca": {
      if (id === selfId) return;
      const nome = String(m.nome ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
      if (nome.length < 2) return;
      const novo = !estado.usuarios.has(id);
      vistoEm.set(id, Date.now());
      estado.usuarios.set(id, { id, nome, cor: corDoId(id), cam: !!m.cam, mic: !!m.mic });
      if (novo) adicionarMsg({ id: "entrou-" + id, sistema: true, texto: `${nome} entrou na sala`, em: Date.now() });
      if (m.t === "oi") {
        // quem chegou precisa saber de mim já, sem esperar o próximo aviso
        anunciar("presenca");
        // um (só) de quem já está na sala manda as últimas mensagens para o recém-chegado
        setTimeout(() => {
          if (historicoRespondido.has(id)) return;
          const msgs = estado.mensagens.filter((x) => !x.sistema).slice(-50).map(({ id, de, nome, texto, em }) => ({ id, de, nome, texto, em }));
          if (msgs.length) canal.publicar({ t: "historico", id: selfId, para: id, msgs });
        }, 300 + Math.random() * 1500);
      }
      renderPresenca();
      atualizarTile(id);
      break;
    }
    case "tchau":
      if (id !== selfId) removerUsuario(id);
      break;
    case "msg": {
      if (id === selfId) return; // já mostrado ao enviar
      const texto = String(m.texto ?? "").trim().slice(0, 500);
      const u = estado.usuarios.get(id);
      if (!texto || estado.mensagens.some((x) => x.id === m.mid)) return;
      adicionarMsg({ id: String(m.mid), de: id, nome: u?.nome ?? String(m.nome ?? "Alguém").slice(0, 30), cor: corDoId(id), texto, em: Date.now() });
      break;
    }
    case "historico": {
      historicoRespondido.add(String(m.para));
      if (m.para !== selfId || !Array.isArray(m.msgs)) return;
      let mudou = false;
      for (const x of m.msgs.slice(-50)) {
        if (!x?.id || estado.mensagens.some((y) => y.id === x.id)) continue;
        const texto = String(x.texto ?? "").trim().slice(0, 500);
        const nome = String(x.nome ?? "").trim().slice(0, 30);
        if (!texto || !nome) continue;
        estado.mensagens.push({ id: String(x.id), de: String(x.de), nome, cor: corDoId(String(x.de)), texto, em: Number(x.em) || Date.now() });
        mudou = true;
      }
      if (mudou) {
        estado.mensagens.sort((a, b) => a.em - b.em);
        renderMensagens();
      }
      break;
    }
  }
}

function removerUsuario(id) {
  const u = estado.usuarios.get(id);
  if (!u) return;
  estado.usuarios.delete(id);
  vistoEm.delete(id);
  estado.streams.delete(id);
  pararMedidor(id);
  document.getElementById("tile-" + id)?.remove();
  adicionarMsg({ id: "saiu-" + id + Date.now(), sistema: true, texto: `${u.nome} saiu`, em: Date.now() });
  renderPresenca();
}

function removerAusentes() {
  for (const [id, quando] of vistoEm) if (Date.now() - quando > AUSENTE_MS) removerUsuario(id);
}

let avisoTimer;
function avisar(texto, ms = 5000) {
  const a = $("#aviso");
  a.textContent = texto;
  a.hidden = false;
  clearTimeout(avisoTimer);
  if (ms) avisoTimer = setTimeout(() => (a.hidden = true), ms);
}

// ======================= chat =======================
let contadorMsg = 0;

function itemMsg(m) {
  const li = el("li");
  if (m.sistema) {
    li.className = "sistema" + (m.destaque ? " destaque" : "");
    li.textContent = m.texto;
  } else {
    const quem = el("span", "quem", m.nome);
    quem.style.color = m.cor;
    quem.append(estrelaPT());
    li.append(quem, document.createTextNode(m.texto));
    li.append(el("span", "hora", new Date(m.em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })));
  }
  return li;
}

function adicionarMsg(m) {
  estado.mensagens.push(m);
  if (estado.mensagens.length > 200) estado.mensagens.shift();
  const lista = $("#mensagens");
  const noFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 60;
  lista.append(itemMsg(m));
  while (lista.children.length > 200) lista.firstChild.remove();
  if (noFim || m.de === estado.eu?.id) lista.scrollTop = lista.scrollHeight;
  if (!m.sistema && m.de !== estado.eu?.id && celular.matches && estado.vista !== "sala") {
    estado.naoLidas++;
    renderNaoLidas();
  }
}

function renderMensagens() {
  const lista = $("#mensagens");
  lista.replaceChildren(...estado.mensagens.map(itemMsg));
  lista.scrollTop = lista.scrollHeight;
}

$("#form-msg").addEventListener("submit", (e) => {
  e.preventDefault();
  const texto = $("#texto").value.trim().slice(0, 500);
  if (!texto || !canal) return;
  if (!canal.conectado()) return avisar("Sem conexão com o chat no momento. Tentando reconectar…");
  const mid = `${selfId}-${Date.now()}-${contadorMsg++}`;
  canal.publicar({ t: "msg", id: selfId, mid, nome: estado.eu.nome, texto });
  adicionarMsg({ id: mid, de: selfId, nome: estado.eu.nome, cor: estado.eu.cor, texto, em: Date.now() });
  $("#texto").value = "";
});

function renderPresenca() {
  const n = estado.usuarios.size + 1;
  $("#online").textContent = canal && !canal.conectado()
    ? "Reconectando ao chat…"
    : `${n} ${n === 1 ? "pessoa" : "pessoas"} na sala`;
  if (!$("#lista-online").hidden) renderListaOnline();
}

// Lista de quem está na sala (você primeiro, depois em ordem alfabética)
function renderListaOnline() {
  const outros = [...estado.usuarios.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const itens = [estado.eu, ...outros].map((u) => {
    const li = el("li", "pessoa");
    const av = el("span", "av", iniciais(u.nome));
    av.style.background = u.cor;
    av.setAttribute("aria-hidden", "true");
    const nm = el("span", "nm", u.nome);
    nm.append(estrelaPT());
    if (u.id === estado.eu.id) nm.append(el("span", "voce", "(você)"));
    const midia = el("span", "midia");
    const cam = el("span", u.cam ? "" : "off", "📷");
    cam.title = u.cam ? "Câmera ligada" : "Câmera desligada";
    const mic = el("span", u.mic ? "" : "off", "🎙️");
    mic.title = u.mic ? "Microfone ligado" : "Microfone desligado";
    midia.setAttribute("aria-label", `${u.cam ? "câmera ligada" : "câmera desligada"}, ${u.mic ? "microfone ligado" : "microfone desligado"}`);
    midia.append(cam, mic);
    li.append(av, nm, midia);
    return li;
  });
  $("#pessoas").replaceChildren(...itens);
  if (!outros.length) $("#pessoas").append(el("li", "vazio", "Só você por enquanto. Compartilhe o link para chamar a galera!"));
}

function alternarListaOnline(abrir = $("#lista-online").hidden) {
  $("#lista-online").hidden = !abrir;
  $("#online").setAttribute("aria-expanded", String(abrir));
  if (abrir) renderListaOnline();
}
$("#online").addEventListener("click", () => alternarListaOnline());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#lista-online").hidden) { alternarListaOnline(false); $("#online").focus(); }
});

// ======================= câmera e microfone =======================
async function ativarMidia() {
  if (estado.stream) return true;
  try {
    estado.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    try {
      // sem câmera (ou câmera negada): tenta só o microfone
      estado.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      avisar("Câmera indisponível. Entrando só com o microfone.");
    } catch {
      avisar(!window.isSecureContext
        ? "Câmera e microfone só funcionam em https:// ou em localhost."
        : "Não foi possível acessar câmera/microfone. Verifique a permissão no navegador.");
      return false;
    }
  }
  const camerasAbertas = [...estado.usuarios.values()].filter((u) => u.cam).length;
  if (camerasAbertas >= MAX_CAMERAS) {
    estado.stream.getVideoTracks().forEach((t) => (t.enabled = false));
    avisar(`A sala já tem ${MAX_CAMERAS} câmeras abertas. Você pode participar pelo microfone.`);
  }
  sala.addStream(estado.stream);
  $("#convite-midia").hidden = true;
  return true;
}

function publicarMidia() {
  const v = estado.stream?.getVideoTracks()[0];
  const a = estado.stream?.getAudioTracks()[0];
  estado.eu.cam = !!v?.enabled;
  estado.eu.mic = !!a?.enabled;
  anunciar("presenca");
  renderControles();
  renderPresenca();
  atualizarTile(estado.eu.id);
}

function renderControles() {
  $("#btn-cam").setAttribute("aria-pressed", String(!!estado.eu?.cam));
  $("#btn-mic").setAttribute("aria-pressed", String(!!estado.eu?.mic));
}

$("#btn-ativar-midia").onclick = async () => { if (await ativarMidia()) publicarMidia(); };
$("#btn-so-chat").onclick = () => ($("#convite-midia").hidden = true);
$("#btn-cam").onclick = async () => {
  if (!estado.stream) { if (await ativarMidia()) publicarMidia(); return; }
  const v = estado.stream.getVideoTracks()[0];
  if (!v) return avisar("Nenhuma câmera disponível.");
  if (!v.enabled && [...estado.usuarios.values()].filter((u) => u.cam).length >= MAX_CAMERAS)
    return avisar(`A sala já tem ${MAX_CAMERAS} câmeras abertas.`);
  v.enabled = !v.enabled;
  publicarMidia();
};
$("#btn-mic").onclick = async () => {
  if (!estado.stream) {
    if (await ativarMidia()) { estado.stream.getVideoTracks().forEach((t) => (t.enabled = false)); publicarMidia(); }
    return;
  }
  const a = estado.stream.getAudioTracks()[0];
  if (!a) return;
  a.enabled = !a.enabled;
  publicarMidia();
};

// ---------- quadros de vídeo ----------
function atualizarTile(id) {
  const souEu = id === estado.eu.id;
  const u = souEu ? estado.eu : estado.usuarios.get(id);
  if (!u) return;
  const stream = souEu ? estado.stream : estado.streams.get(id);
  const visivel = (u.cam || u.mic) && (souEu ? !!stream : true);
  let tile = document.getElementById("tile-" + id);
  if (!visivel) { tile?.remove(); pararMedidor(id); return; }

  if (!tile) {
    tile = el("div", "tile" + (souEu ? " eu" : ""));
    tile.id = "tile-" + id;
    const video = el("video");
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", ""); // Safari no iPhone: sem isso o vídeo abre em tela cheia
    video.muted = souEu; // nunca reproduz o próprio áudio
    const avatar = el("div", "avatar", iniciais(u.nome));
    avatar.style.color = u.cor;
    const rotulo = el("div", "rotulo");
    const nomeTile = el("span", "nm", souEu ? `${u.nome} (você)` : u.nome);
    nomeTile.append(estrelaPT());
    rotulo.append(nomeTile, el("span", "mic"));
    tile.append(video, avatar, rotulo);
    if (souEu) $("#videos").prepend(tile); else $("#videos").append(tile);
  }
  const video = tile.querySelector("video");
  if (stream && video.srcObject !== stream) {
    video.srcObject = stream;
    video.play().catch(() => {});
  }
  // a faixa de áudio pode chegar depois da de vídeo
  if (stream && !medidores.has(id) && stream.getAudioTracks().length) medirFala(id, stream, tile);
  tile.classList.toggle("com-video", !!(u.cam && stream));
  tile.querySelector(".mic").textContent = u.mic ? "🎙️" : "🔇";
}

// Destaca quem está falando
let audioCtx;
const medidores = new Map();
function medirFala(id, stream, tile) {
  pararMedidor(id);
  if (!stream.getAudioTracks().length) return;
  audioCtx ??= new AudioContext();
  const fonte = audioCtx.createMediaStreamSource(stream);
  const analisador = audioCtx.createAnalyser();
  analisador.fftSize = 512;
  fonte.connect(analisador);
  const buf = new Uint8Array(analisador.fftSize);
  const timer = setInterval(() => {
    analisador.getByteTimeDomainData(buf);
    let soma = 0;
    for (const v of buf) soma += (v - 128) ** 2;
    tile.classList.toggle("falando", Math.sqrt(soma / buf.length) > 6);
  }, 200);
  medidores.set(id, { timer, fonte });
}
function pararMedidor(id) {
  const m = medidores.get(id);
  if (!m) return;
  clearInterval(m.timer);
  m.fonte.disconnect();
  medidores.delete(id);
}

// ======================= dados do TSE =======================
const eleitosAnunciados = new Set();
let primeiraLeitura = true;

async function iniciarApuracao() {
  let eleicoes;
  try {
    eleicoes = await descobrirEleicoes(TURNO);
  } catch (err) {
    console.warn(err);
    $("#fonte").textContent = "TSE indisponível · tentando de novo";
    return setTimeout(iniciarApuracao, INTERVALO_TSE);
  }
  const ciclo = async () => {
    try {
      const snap = await buscarSnapshot(eleicoes);
      snap.fonte = `TSE · ${TURNO}º turno`;
      anunciarEleitos(snap);
      receberApuracao(snap);
    } catch (err) {
      console.warn("Falha ao atualizar apuração:", err);
    }
  };
  await ciclo();
  setInterval(ciclo, INTERVALO_TSE);
}

// Avisa no chat quando o TSE marca alguém como eleito
function anunciarEleitos(snap) {
  const disputas = [["presidente", "br", snap.presidente.br], ...Object.entries(snap.governador).map(([uf, r]) => ["governador", uf, r])];
  for (const [cargo, uf, r] of disputas) {
    const eleito = r?.cands?.find((c) => c.eleito);
    if (!eleito) continue;
    const chave = `${cargo}:${uf}:${eleito.numero}`;
    if (eleitosAnunciados.has(chave)) continue;
    eleitosAnunciados.add(chave);
    if (primeiraLeitura || !estado.eu) continue; // não anuncia o que já estava decidido ao abrir a página
    const onde = cargo === "presidente" ? "presidente do Brasil" : `governador(a) — ${uf.toUpperCase()}`;
    adicionarMsg({ id: "eleito-" + chave, sistema: true, destaque: true, em: Date.now(),
      texto: `🗳️ TSE: ${eleito.nome} (${eleito.partido}) está eleito(a) ${onde} com ${fmtPct(eleito.pct)}% dos votos válidos.` });
  }
  primeiraLeitura = false;
}

iniciarApuracao();

// Quem deixa a página aberta por horas é avisado quando sai uma versão nova
setInterval(async () => {
  try {
    const v = (await (await fetch("versao.txt?t=" + Date.now(), { cache: "no-store" })).text()).trim();
    if (v && window.VERSAO_SITE && v !== window.VERSAO_SITE) avisar("Saiu uma versão nova do painel. Recarregue a página para continuar no chat com todo mundo.", 0);
  } catch {}
}, 5 * 60 * 1000);

// ======================= apuração e mapa =======================
async function carregarMapa() {
  if (estado.mapa) return;
  const dados = await (await fetch("brasil-ufs.json")).json();
  estado.mapa = dados;
  const svg = $("#mapa");
  // 200 unidades extras à direita: espaço no oceano para os rótulos dos estados pequenos
  svg.setAttribute("viewBox", `0 0 ${dados.largura + 200} ${dados.altura}`);
  const ns = "http://www.w3.org/2000/svg";
  const gPaths = document.createElementNS(ns, "g");
  const gAneis = document.createElementNS(ns, "g");
  const gTextos = document.createElementNS(ns, "g");
  for (const uf of dados.ufs) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", uf.d);
    path.dataset.uf = uf.uf;
    // no toque não existe "passar o mouse": o toque seleciona o estado e o detalhe aparece abaixo do mapa
    path.addEventListener("pointermove", (e) => e.pointerType === "mouse" && mostrarTooltip(uf.uf, e));
    path.addEventListener("pointerleave", () => ($("#tooltip").hidden = true));
    path.addEventListener("click", () => selecionar(uf.uf));
    gPaths.append(path);
    const anel = document.createElementNS(ns, "path");
    anel.setAttribute("d", uf.d);
    anel.setAttribute("class", "anel-gov");
    anel.dataset.uf = uf.uf;
    gAneis.append(anel);
    gTextos.append(...criarRotulo(ns, uf));
  }
  svg.append(gPaths, gAneis, gTextos);
  // mantém o texto do mapa com o mesmo tamanho em pixels em qualquer tela
  new ResizeObserver(() => {
    const vb = svg.viewBox.baseVal;
    const escala = Math.min(svg.clientWidth / vb.width, svg.clientHeight / vb.height);
    if (escala > 0) svg.style.setProperty("--k", (1 / escala).toFixed(3));
  }).observe(svg);
}

// Estados pequenos do litoral (e o DF, dentro de GO): rótulo no oceano com uma linha-guia
const ROTULOS_FORA = { rn: [985, 250], pb: [985, 290], pe: [985, 330], al: [985, 370], se: [985, 410], es: [860, 622], rj: [815, 738], df: [690, 524], sc: [660, 822] };
// rótulos deslocados do centro para não encostarem nos vizinhos
const ROTULOS_AJUSTE = { go: [560, 562], pi: [748, 350], ma: [668, 250], sp: [628, 676], pr: [512, 742], rs: [478, 885] };

function criarRotulo(ns, uf) {
  const fora = ROTULOS_FORA[uf.uf];
  const [x, y] = fora ?? ROTULOS_AJUSTE[uf.uf] ?? [uf.cx, uf.cy];
  const t = document.createElementNS(ns, "text");
  t.dataset.uf = uf.uf;
  t.setAttribute("x", x);
  t.setAttribute("y", y);
  const sigla = document.createElementNS(ns, "tspan");
  sigla.setAttribute("class", "sigla-uf");
  sigla.textContent = uf.uf.toUpperCase();
  const pct = document.createElementNS(ns, "tspan");
  pct.setAttribute("class", "pct-uf");
  t.append(sigla, pct);
  if (!fora) return [t];

  t.classList.add("fora");
  pct.setAttribute("dx", "0.3em");
  const guia = document.createElementNS(ns, "polyline");
  guia.setAttribute("class", "guia");
  guia.setAttribute("points", `${uf.cx},${uf.cy} ${x - 8},${y}`);
  const ponto = document.createElementNS(ns, "circle");
  ponto.setAttribute("class", "guia-ponto");
  ponto.setAttribute("cx", uf.cx);
  ponto.setAttribute("cy", uf.cy);
  ponto.setAttribute("r", 3);
  return [guia, ponto, t];
}

// Atualiza "SP / 52,3%" em cada estado (sigla em cima, % do líder embaixo)
function renderRotulos() {
  const govUfs = new Set(Object.keys(estado.apuracao.governador));
  for (const t of $("#mapa").querySelectorAll("text[data-uf]")) {
    const uf = t.dataset.uf;
    const r = resultadoDe(uf);
    const lider = r?.cands?.[0];
    const valor = iniciada(r) && lider?.votos ? fmtPct1(lider.pct) + "%" : "";
    const [sigla, pct] = t.children;
    pct.textContent = valor;
    if (!t.classList.contains("fora")) {
      // duas linhas centralizadas no estado; sem % fica só a sigla no centro
      for (const s of [sigla, pct]) s.setAttribute("x", t.getAttribute("x"));
      sigla.setAttribute("dy", valor ? "-0.5em" : "0");
      pct.setAttribute("dy", valor ? "1.15em" : "0");
    }
    pct.style.fill = t.classList.contains("fora") && valor ? corDe(r, lider.numero) : "";
    t.classList.toggle("apagado", estado.cargo === "governador" && !govUfs.has(uf));
  }
}
const nomeUf = (uf) => (uf === "br" ? "Brasil" : uf === "zz" ? "Exterior" : estado.mapa?.ufs.find((u) => u.uf === uf)?.nome ?? uf.toUpperCase());

// Cor fixa por candidato dentro de cada disputa: ordem crescente do número na urna
function corDe(res, numero) {
  const nums = (res?.cands ?? []).map((c) => Number(c.numero)).sort((a, b) => a - b);
  return PALETA[Math.max(0, nums.indexOf(Number(numero))) % PALETA.length];
}

// Antes da primeira urna apurada, o painel fica em branco (sem percentuais nem votos)
const iniciada = (r) => !!r && !r.erro && (r.secoesPct > 0 || r.cands.some((c) => c.votos > 0));

function receberApuracao(dados) {
  estado.apuracao = dados;
  const br = dados.presidente.br;
  $("#fonte").textContent = iniciada(br) ? dados.fonte : `${dados.fonte} · aguardando início`;
  if (!estado.mapa) return;
  renderPlacar();
  renderMapa();
  renderDetalhe();
  renderLegenda();
}

const resultadoDe = (uf, cargo = estado.cargo) => {
  const a = estado.apuracao;
  if (!a) return null;
  if (cargo === "presidente") return uf === "br" ? a.presidente.br : a.presidente.ufs[uf];
  return a.governador[uf] ?? null;
};

function renderPlacar() {
  const r = estado.apuracao?.presidente?.br;
  const placar = $("#placar");
  placar.replaceChildren();
  if (!r?.cands?.length) return;
  const comecou = iniciada(r);
  const [a, b] = [...r.cands].slice(0, 2).sort((x, y) => Number(x.numero) - Number(y.numero));
  const linha = el("div", "placar-linha");
  for (const [c, lado] of [[a, ""], [b, "dir"]]) {
    if (!c) continue;
    const bloco = el("div", "placar-cand " + lado);
    const pct = el("span", "pct", comecou ? fmtPct(c.pct) + "%" : "—");
    pct.style.color = corDe(r, c.numero);
    bloco.append(pct, el("span", "nm", `${c.nome} (${c.partido})`));
    if (c.eleito) bloco.append(el("span", "eleito-tag", "ELEITO"));
    if (comecou) bloco.append(el("span", "vt", fmt(c.votos) + " votos"));
    linha.append(bloco);
  }
  const barra = el("div", "barra");
  const total = (a?.votos || 0) + (b?.votos || 0);
  for (const c of [a, b]) {
    if (!c) continue;
    const s = el("span");
    s.style.width = total ? `${(c.votos / total) * 100}%` : "50%";
    s.style.background = total ? corDe(r, c.numero) : "transparent";
    barra.append(s);
  }
  barra.append(el("span", "meio"));
  const rodape = el("div", "placar-rodape");
  rodape.append(
    el("span", null, !comecou ? AGUARDANDO : r.totalizado ? "Totalizado" : `${fmtPct(r.secoesPct)}% das seções apuradas`),
    el("span", null, comecou ? `Presidente · atualizado ${r.atualizado?.split(" ")[1] ?? ""}` : "Presidente")
  );
  placar.append(linha, barra, rodape);
}

function renderMapa() {
  if (!estado.mapa || !estado.apuracao) return;
  const govUfs = new Set(Object.keys(estado.apuracao.governador));
  for (const path of $("#mapa").querySelectorAll("path[data-uf]:not(.anel-gov)")) {
    const uf = path.dataset.uf;
    const r = resultadoDe(uf);
    const [l1, l2] = r?.cands ?? [];
    if (!iniciada(r) || !l1?.votos) {
      path.style.fill = "var(--neutro)";
      path.style.fillOpacity = estado.cargo === "governador" && !govUfs.has(uf) ? 0.35 : 1;
    } else {
      // intensidade pela vantagem do líder
      const margem = l1.pct - (l2?.pct ?? 0);
      const forca = Math.round(45 + 55 * Math.min(1, margem / 30));
      path.style.fill = `color-mix(in srgb, ${corDe(r, l1.numero)} ${forca}%, #5b6578)`;
      path.style.fillOpacity = 1;
    }
    path.classList.toggle("sel", uf === estado.sel);
  }
  // contorno tracejado nos estados com 2º turno para governador (aba Presidente)
  for (const anel of $("#mapa").querySelectorAll(".anel-gov"))
    anel.style.display = estado.cargo === "presidente" && govUfs.has(anel.dataset.uf) && estado.apuracao.turno === 2 ? "" : "none";
  renderRotulos();
}

function blocoResultado(r, titulo) {
  const frag = document.createDocumentFragment();
  if (titulo) frag.append(el("h4", null, titulo));
  if (!r) { frag.append(el("p", "meta", "Sem disputa neste turno.")); return frag; }
  if (r.erro) { frag.append(el("p", "meta", "Dados indisponíveis no momento.")); return frag; }
  const comecou = iniciada(r);
  if (comecou) {
    const prog = el("div", "progresso");
    const ps = el("span");
    ps.style.width = r.secoesPct + "%";
    prog.append(ps);
    const contagem = r.secoesTotal ? ` (${fmt(r.secoesApuradas)} de ${fmt(r.secoesTotal)})` : "";
    frag.append(el("div", "meta", r.totalizado ? `Totalizado${contagem}` : `${fmtPct(r.secoesPct)}% das seções${contagem} · ${r.atualizado?.split(" ")[1] ?? ""}`), prog);
  } else {
    const contagem = r.secoesTotal ? ` · 0 de ${fmt(r.secoesTotal)} seções` : "";
    frag.append(el("div", "meta", `Aguardando o início da apuração${contagem}`));
  }
  const cands = comecou ? r.cands : [...r.cands].sort((a, b) => Number(a.numero) - Number(b.numero));
  for (const c of cands.slice(0, 6)) {
    const linha = el("div", "res-cand");
    const cor = el("span", "cor");
    cor.style.background = corDe(r, c.numero);
    const nm = el("span", "nm", `${c.nome} · ${c.partido}`);
    if (c.eleito) nm.append(" ", el("span", "eleito-tag", "ELEITO"));
    linha.append(cor, nm, el("span", "pc", comecou ? fmtPct(c.pct) + "%" : "—"));
    if (comecou) {
      const mini = el("div", "mini");
      const ms = el("span");
      ms.style.width = c.pct + "%";
      ms.style.background = corDe(r, c.numero);
      mini.append(ms);
      linha.append(mini, el("span", "vt", fmt(c.votos) + " votos"));
    }
    frag.append(linha);
  }
  return frag;
}

function renderDetalhe() {
  const d = $("#detalhe");
  const uf = estado.sel;
  d.replaceChildren(el("h3", null, nomeUf(uf)));
  const pres = resultadoDe(uf, "presidente");
  if (uf === "zz") d.append(el("div", "meta", "Votos de brasileiros que vivem fora do país. O TSE divulga junto com o Brasil, a partir das 17h (Brasília)."));
  if (iniciada(pres) && pres.comparecimentoPct) d.append(el("div", "meta", `Comparecimento ${fmtPct(pres.comparecimentoPct)}%`));
  d.append(blocoResultado(pres, "Presidente"));
  if (uf !== "br" && uf !== "zz") {
    const gov = resultadoDe(uf, "governador");
    if (gov || estado.apuracao?.turno === 2) d.append(blocoResultado(gov, "Governador"));
  }
  $("#btn-brasil").classList.toggle("ativa", uf === "br");
  $("#btn-exterior").classList.toggle("ativa", uf === "zz");
}

function renderLegenda() {
  const leg = $("#legenda");
  leg.replaceChildren();
  if (estado.cargo === "presidente") {
    const r = estado.apuracao?.presidente?.br;
    for (const c of [...(r?.cands ?? [])].slice(0, 2).sort((a, b) => Number(a.numero) - Number(b.numero))) {
      const s = el("span");
      const i = el("i");
      i.style.background = corDe(r, c.numero);
      s.append(i, `${c.nome} lidera`);
      leg.append(s);
    }
    if (estado.apuracao?.turno === 2) leg.append(el("span", null, "┅ contorno amarelo: também tem 2º turno para governador"));
  } else {
    leg.append(el("span", null, "Cada estado com 2º turno usa a cor do candidato que lidera ali; passe o mouse para ver os nomes."));
  }
  leg.append(el("span", null, "Cor mais forte = vantagem maior · cinza = sem votos apurados"));
}

function mostrarTooltip(uf, e) {
  const t = $("#tooltip");
  const r = resultadoDe(uf);
  t.replaceChildren(el("strong", null, nomeUf(uf)));
  t.append(blocoResultado(r, estado.cargo === "presidente" ? "Presidente" : "Governador"));
  t.hidden = false;
  const wrap = $("#mapa-wrap").getBoundingClientRect();
  let x = e.clientX - wrap.left + 14, y = e.clientY - wrap.top + 14;
  if (x + t.offsetWidth > wrap.width) x = e.clientX - wrap.left - t.offsetWidth - 14;
  if (y + t.offsetHeight > wrap.height) y = Math.max(0, wrap.height - t.offsetHeight);
  t.style.left = x + "px";
  t.style.top = y + "px";
}

function selecionar(uf) {
  estado.sel = estado.sel === uf ? "br" : uf;
  renderMapa();
  renderDetalhe();
  if (celular.matches) $("#detalhe").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ======================= celular =======================
function mudarVista(vista) {
  estado.vista = vista;
  $("#painel").dataset.vista = vista;
  for (const b of document.querySelectorAll(".abas-mobile button")) {
    const ativa = b.dataset.vista === vista;
    b.classList.toggle("ativa", ativa);
    if (ativa) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (vista === "sala") {
    estado.naoLidas = 0;
    renderNaoLidas();
    const lista = $("#mensagens");
    lista.scrollTop = lista.scrollHeight;
  }
}
function renderNaoLidas() {
  const b = $("#nao-lidas");
  b.hidden = !estado.naoLidas;
  b.textContent = estado.naoLidas > 99 ? "99+" : String(estado.naoLidas);
  b.setAttribute("aria-label", `${estado.naoLidas} mensagens novas`);
}
for (const b of document.querySelectorAll(".abas-mobile button")) b.addEventListener("click", () => mudarVista(b.dataset.vista));

// Safari (iPhone) não encolhe a página quando o teclado abre: usa a área visível de verdade
// para o campo de mensagem ficar sempre logo acima do teclado.
function ajustarAreaVisivel() {
  const vv = window.visualViewport;
  if (!vv) return;
  const raiz = document.documentElement.style;
  raiz.setProperty("--vv-h", `${vv.height}px`);
  raiz.setProperty("--vv-top", `${vv.offsetTop}px`);
  const tecladoAberto = celular.matches && vv.height < window.innerHeight * 0.78 && document.activeElement?.tagName === "INPUT";
  $("#painel").classList.toggle("teclado", tecladoAberto);
  if (tecladoAberto) $("#mensagens").scrollTop = $("#mensagens").scrollHeight;
}
window.visualViewport?.addEventListener("resize", ajustarAreaVisivel);
window.visualViewport?.addEventListener("scroll", ajustarAreaVisivel);
$("#texto").addEventListener("focus", () => setTimeout(ajustarAreaVisivel, 300));
$("#texto").addEventListener("blur", () => setTimeout(ajustarAreaVisivel, 300));
ajustarAreaVisivel();

// Navegadores só liberam áudio depois de um toque; destrava o medidor de fala
document.addEventListener("pointerdown", () => audioCtx?.state === "suspended" && audioCtx.resume(), { passive: true });

for (const aba of document.querySelectorAll(".aba")) {
  aba.addEventListener("click", () => {
    estado.cargo = aba.dataset.cargo;
    document.querySelectorAll(".aba").forEach((a) => a.classList.toggle("ativa", a === aba));
    renderMapa();
    renderLegenda();
  });
}
$("#btn-brasil").onclick = () => { estado.sel = "br"; renderMapa(); renderDetalhe(); };
$("#btn-exterior").onclick = () => { estado.sel = "zz"; renderMapa(); renderDetalhe(); };
