// Painel da apuração: mapa (esquerda) + sala ao vivo com chat, câmera e microfone (direita).
// Vídeo/áudio vão direto entre os navegadores (WebRTC em malha); o servidor só repassa a sinalização.

const $ = (s) => document.querySelector(s);
const el = (tag, cls, texto) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (texto != null) e.textContent = texto;
  return e;
};
const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
const fmtPct = (n) => Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const iniciais = (nome) => nome.split(" ").filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");

const PALETA = ["#ef6a4c", "#3d8bfd", "#f5b83d", "#33c3a0", "#b07cf0", "#9aa5b1"];
const ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

const estado = {
  eu: null,
  usuarios: new Map(),
  apuracao: null,
  cargo: "presidente",
  sel: "br", // "br", "zz" ou sigla da UF
  mapa: null,
  stream: null,
};
let ws;

// ======================= entrada =======================
try { $("#nome").value = localStorage.getItem("apuracao-nome") || ""; } catch {}

$("#form-entrada").addEventListener("submit", (e) => {
  e.preventDefault();
  const nome = $("#nome").value.trim();
  if (nome.length < 2) return ($("#erro-entrada").textContent = "Digite um nome com pelo menos 2 letras.");
  try { localStorage.setItem("apuracao-nome", nome); } catch {}
  $("#erro-entrada").textContent = "";
  conectar(nome);
});

function conectar(nome) {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => enviar({ tipo: "entrar", nome });
  ws.onmessage = (e) => tratar(JSON.parse(e.data));
  ws.onerror = () => { if (!estado.eu) $("#erro-entrada").textContent = "Não foi possível conectar ao servidor."; };
  ws.onclose = () => {
    if (!estado.eu) return;
    avisar("Conexão perdida. Recarregue a página para voltar à sala.", 0);
    for (const id of peers.keys()) fecharPeer(id);
  };
}
const enviar = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function tratar(m) {
  switch (m.tipo) {
    case "bemvindo":
      estado.eu = m.eu;
      m.usuarios.forEach((u) => estado.usuarios.set(u.id, u));
      $("#entrada").hidden = true;
      $("#painel").hidden = false;
      $("#convite-midia").hidden = false;
      m.historico.forEach(adicionarMsg);
      renderPresenca();
      carregarMapa().then(() => m.apuracao && receberApuracao(m.apuracao));
      // Conexão com quem já está na sala (o vídeo só flui quando alguém liga a câmera/microfone)
      m.usuarios.forEach((u) => { criarPeer(u.id); atualizarTile(u.id); });
      break;
    case "erro":
      if (!estado.eu) { $("#erro-entrada").textContent = m.texto; ws.close(); }
      else avisar(m.texto);
      break;
    case "entrou":
      estado.usuarios.set(m.usuario.id, m.usuario);
      criarPeer(m.usuario.id);
      renderPresenca();
      break;
    case "saiu":
      estado.usuarios.delete(m.id);
      fecharPeer(m.id);
      document.getElementById("tile-" + m.id)?.remove();
      renderPresenca();
      break;
    case "msg":
      adicionarMsg(m);
      break;
    case "midia": {
      if (m.id === estado.eu.id) {
        // o servidor pode recusar a câmera (limite da sala)
        if (!m.cam && estado.stream) estado.stream.getVideoTracks().forEach((t) => (t.enabled = false));
        estado.eu.cam = m.cam; estado.eu.mic = m.mic;
        renderControles(); atualizarTile(m.id);
        break;
      }
      const u = estado.usuarios.get(m.id);
      if (u) { u.cam = m.cam; u.mic = m.mic; atualizarTile(m.id); }
      break;
    }
    case "sinal":
      receberSinal(m.de, m.dados);
      break;
    case "apuracao":
      receberApuracao(m.dados);
      break;
  }
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
function adicionarMsg(m) {
  const lista = $("#mensagens");
  const noFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 60;
  const li = el("li");
  if (m.sistema) {
    li.className = "sistema" + (m.texto.startsWith("🗳️") ? " destaque" : "");
    li.textContent = m.texto;
  } else {
    const quem = el("span", "quem", m.nome);
    quem.style.color = m.cor;
    li.append(quem, document.createTextNode(m.texto));
    li.append(el("span", "hora", new Date(m.em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })));
  }
  lista.append(li);
  while (lista.children.length > 200) lista.firstChild.remove();
  if (noFim || m.de === estado.eu?.id) lista.scrollTop = lista.scrollHeight;
}

$("#form-msg").addEventListener("submit", (e) => {
  e.preventDefault();
  const texto = $("#texto").value.trim();
  if (!texto) return;
  enviar({ tipo: "msg", texto });
  $("#texto").value = "";
});

function renderPresenca() {
  const n = estado.usuarios.size + 1;
  $("#online").textContent = `${n} ${n === 1 ? "pessoa" : "pessoas"} na sala`;
}

// ======================= câmera e microfone =======================
async function ativarMidia() {
  if (estado.stream) return true;
  try {
    estado.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
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
  for (const p of peers.values()) estado.stream.getTracks().forEach((t) => p.pc.addTrack(t, estado.stream));
  $("#convite-midia").hidden = true;
  return true;
}

function publicarMidia() {
  const v = estado.stream?.getVideoTracks()[0];
  const a = estado.stream?.getAudioTracks()[0];
  estado.eu.cam = !!v?.enabled;
  estado.eu.mic = !!a?.enabled;
  enviar({ tipo: "midia", cam: estado.eu.cam, mic: estado.eu.mic });
  renderControles();
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

// ---------- WebRTC em malha com "perfect negotiation" ----------
const peers = new Map(); // id -> { pc, educado, fazendoOferta, ignorarOferta, stream }

function criarPeer(id) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const p = { pc, educado: estado.eu.id < id, fazendoOferta: false, ignorarOferta: false, stream: null };
  peers.set(id, p);

  pc.onnegotiationneeded = async () => {
    try {
      p.fazendoOferta = true;
      await pc.setLocalDescription();
      enviar({ tipo: "sinal", para: id, dados: { descricao: pc.localDescription } });
    } catch (err) {
      console.warn("negociação", err);
    } finally {
      p.fazendoOferta = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => candidate && enviar({ tipo: "sinal", para: id, dados: { candidato: candidate } });
  pc.ontrack = ({ streams }) => {
    p.stream = streams[0];
    atualizarTile(id);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") pc.restartIce();
  };
  if (estado.stream) estado.stream.getTracks().forEach((t) => pc.addTrack(t, estado.stream));
  return p;
}

async function receberSinal(de, { descricao, candidato }) {
  const p = criarPeer(de);
  const { pc } = p;
  try {
    if (descricao) {
      const colisao = descricao.type === "offer" && (p.fazendoOferta || pc.signalingState !== "stable");
      p.ignorarOferta = !p.educado && colisao;
      if (p.ignorarOferta) return;
      await pc.setRemoteDescription(descricao);
      if (descricao.type === "offer") {
        await pc.setLocalDescription();
        enviar({ tipo: "sinal", para: de, dados: { descricao: pc.localDescription } });
      }
    } else if (candidato) {
      try { await pc.addIceCandidate(candidato); } catch (err) { if (!p.ignorarOferta) throw err; }
    }
  } catch (err) {
    console.warn("sinalização", err);
  }
}

function fecharPeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close();
  peers.delete(id);
  pararMedidor(id);
}

// ---------- quadros de vídeo ----------
function atualizarTile(id) {
  const souEu = id === estado.eu.id;
  const u = souEu ? estado.eu : estado.usuarios.get(id);
  if (!u) return;
  const stream = souEu ? estado.stream : peers.get(id)?.stream;
  const visivel = (u.cam || u.mic) && (souEu ? !!stream : true);
  let tile = document.getElementById("tile-" + id);
  if (!visivel) { tile?.remove(); pararMedidor(id); return; }

  if (!tile) {
    tile = el("div", "tile" + (souEu ? " eu" : ""));
    tile.id = "tile-" + id;
    const video = el("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = souEu; // nunca reproduz o próprio áudio
    const avatar = el("div", "avatar", iniciais(u.nome));
    avatar.style.color = u.cor;
    const rotulo = el("div", "rotulo");
    rotulo.append(el("span", "nm", souEu ? `${u.nome} (você)` : u.nome), el("span", "mic"));
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

// ======================= apuração e mapa =======================
async function carregarMapa() {
  if (estado.mapa) return;
  const dados = await (await fetch("brasil-ufs.json")).json();
  estado.mapa = dados;
  const svg = $("#mapa");
  svg.setAttribute("viewBox", `0 0 ${dados.largura} ${dados.altura}`);
  const ns = "http://www.w3.org/2000/svg";
  const PEQUENOS = new Set(["df", "se", "al", "pb", "rn", "pe", "es", "rj"]);
  const gPaths = document.createElementNS(ns, "g");
  const gAneis = document.createElementNS(ns, "g");
  const gTextos = document.createElementNS(ns, "g");
  for (const uf of dados.ufs) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", uf.d);
    path.dataset.uf = uf.uf;
    path.addEventListener("mousemove", (e) => mostrarTooltip(uf.uf, e));
    path.addEventListener("mouseleave", () => ($("#tooltip").hidden = true));
    path.addEventListener("click", () => selecionar(uf.uf));
    gPaths.append(path);
    const anel = document.createElementNS(ns, "path");
    anel.setAttribute("d", uf.d);
    anel.setAttribute("class", "anel-gov");
    anel.dataset.uf = uf.uf;
    gAneis.append(anel);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", uf.cx);
    t.setAttribute("y", uf.cy);
    if (PEQUENOS.has(uf.uf)) t.setAttribute("class", "peq");
    t.textContent = uf.uf.toUpperCase();
    gTextos.append(t);
  }
  svg.append(gPaths, gAneis, gTextos);
}
const nomeUf = (uf) => (uf === "br" ? "Brasil" : uf === "zz" ? "Exterior" : estado.mapa?.ufs.find((u) => u.uf === uf)?.nome ?? uf.toUpperCase());

// Cor fixa por candidato dentro de cada disputa: ordem crescente do número na urna
function corDe(res, numero) {
  const nums = (res?.cands ?? []).map((c) => Number(c.numero)).sort((a, b) => a - b);
  return PALETA[Math.max(0, nums.indexOf(Number(numero))) % PALETA.length];
}

function receberApuracao(dados) {
  estado.apuracao = dados;
  const fonte = $("#fonte");
  fonte.textContent = dados.simulado ? "SIMULAÇÃO · números fictícios" : dados.fonte;
  fonte.classList.toggle("simulado", !!dados.simulado);
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
  const [a, b] = [...r.cands].slice(0, 2).sort((x, y) => Number(x.numero) - Number(y.numero));
  const linha = el("div", "placar-linha");
  for (const [c, lado] of [[a, ""], [b, "dir"]]) {
    if (!c) continue;
    const bloco = el("div", "placar-cand " + lado);
    const pct = el("span", "pct", fmtPct(c.pct) + "%");
    pct.style.color = corDe(r, c.numero);
    bloco.append(pct, el("span", "nm", `${c.nome} (${c.partido})`));
    if (c.eleito) bloco.append(el("span", "eleito-tag", "ELEITO"));
    bloco.append(el("span", "vt", fmt(c.votos) + " votos"));
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
    el("span", null, r.totalizado ? "Totalizado" : `${fmtPct(r.secoesPct)}% das seções apuradas`),
    el("span", null, `Presidente · atualizado ${r.atualizado?.split(" ")[1] ?? ""}`)
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
    if (!r || r.erro || !l1 || !r.secoesPct || !l1.votos) {
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
}

function blocoResultado(r, titulo) {
  const frag = document.createDocumentFragment();
  if (titulo) frag.append(el("h4", null, titulo));
  if (!r) { frag.append(el("p", "meta", "Sem disputa neste turno.")); return frag; }
  if (r.erro) { frag.append(el("p", "meta", "Dados indisponíveis no momento.")); return frag; }
  const prog = el("div", "progresso");
  const ps = el("span");
  ps.style.width = r.secoesPct + "%";
  prog.append(ps);
  frag.append(el("div", "meta", r.totalizado ? "Totalizado" : `${fmtPct(r.secoesPct)}% das seções · ${r.atualizado?.split(" ")[1] ?? ""}`), prog);
  for (const c of r.cands.slice(0, 6)) {
    const linha = el("div", "res-cand");
    const cor = el("span", "cor");
    cor.style.background = corDe(r, c.numero);
    const nm = el("span", "nm", `${c.nome} · ${c.partido}`);
    if (c.eleito) nm.append(" ", el("span", "eleito-tag", "ELEITO"));
    const mini = el("div", "mini");
    const ms = el("span");
    ms.style.width = c.pct + "%";
    ms.style.background = corDe(r, c.numero);
    mini.append(ms);
    linha.append(cor, nm, el("span", "pc", fmtPct(c.pct) + "%"), mini, el("span", "vt", fmt(c.votos) + " votos"));
    frag.append(linha);
  }
  return frag;
}

function renderDetalhe() {
  const d = $("#detalhe");
  const uf = estado.sel;
  d.replaceChildren(el("h3", null, nomeUf(uf)));
  const pres = resultadoDe(uf, "presidente");
  if (pres?.comparecimentoPct) d.append(el("div", "meta", `Comparecimento ${fmtPct(pres.comparecimentoPct)}%`));
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
}

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
