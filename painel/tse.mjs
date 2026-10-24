// Leitura dos JSON públicos da divulgação de resultados do TSE (resultados.tse.jus.br).
// O TSE não envia cabeçalhos CORS, então quem busca é o servidor e repassa aos navegadores.

export const BASE = "https://resultados.tse.jus.br/oficial";
export const CICLO = "ele2026";
export const CARGO_PRESIDENTE = "1";
export const CARGO_GOVERNADOR = "3";
export const TODAS_UFS = "ac al am ap ba ce df es go ma mg ms mt pa pb pe pi pr rj rn ro rr rs sc se sp to".split(" ");

const num = (s) => Number(String(s ?? "0").replace(/\./g, "").replace(",", ".")) || 0;

export async function getJson(url) {
  const r = await fetch(url, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r.json();
}

export const urlResultado = (eleicao, uf, cargo) =>
  `${BASE}/${CICLO}/${eleicao}/dados/${uf}/${uf}-c${cargo.padStart(4, "0")}-e${eleicao.padStart(6, "0")}-u.json`;

// Descobre, no arquivo de configuração, os códigos das eleições do turno e as UFs com governador.
export async function descobrirEleicoes(turno) {
  const cfg = await getJson(`${BASE}/comum/config/ele-c.json`);
  const eleicoes = cfg.pl.filter((p) => p.c === CICLO).flatMap((p) => p.e);
  const res = { turno, presidente: null, governador: null };
  for (const e of eleicoes) {
    if (e.t !== String(turno) || !/Ordinária (Federal|Estadual)/.test(e.nm)) continue;
    for (const abr of e.abr) {
      for (const cp of abr.cp ?? []) {
        if (cp.cd === CARGO_PRESIDENTE) res.presidente = { eleicao: e.cd };
        if (cp.cd === CARGO_GOVERNADOR) {
          res.governador ??= { eleicao: e.cd, ufs: [] };
          // 1º turno: abrangência "br" = todas as UFs; 2º turno: uma entrada por UF
          res.governador.ufs.push(...(abr.cd === "br" ? TODAS_UFS : [abr.cd]));
        }
      }
    }
  }
  if (res.governador) res.governador.ufs = [...new Set(res.governador.ufs)].sort();
  if (!res.presidente) throw new Error(`Eleição presidencial do ${turno}º turno não encontrada na configuração do TSE`);
  return res;
}

// Normaliza um arquivo de resultado do TSE para o formato usado pelo painel
export function extrair(d) {
  const cands = [];
  for (const agr of d.carg?.[0]?.agr ?? [])
    for (const par of agr.par ?? [])
      for (const c of par.cand ?? [])
        cands.push({
          numero: c.n,
          nome: c.nmu || c.nm,
          partido: par.sg,
          votos: num(c.vap),
          pct: num(c.pvap),
          // "e" = "s" também marca quem passou ao 2º turno; a situação ("st") desempata
          eleito: c.e === "s" && !/2º turno/i.test(c.st || ""),
          segundoTurno: /2º turno/i.test(c.st || ""),
        });
  cands.sort((a, b) => b.votos - a.votos || Number(a.numero) - Number(b.numero));
  return {
    atualizado: `${d.dg} ${d.hg}`,
    totalizado: d.tf === "s",
    secoesPct: num(d.s?.pst),
    eleitorado: num(d.e?.te),
    comparecimento: num(d.e?.c),
    comparecimentoPct: num(d.e?.pc),
    brancosPct: num(d.v?.pvb),
    nulosPct: num(d.v?.ptvn),
    cands,
  };
}

async function buscar(eleicao, uf, cargo) {
  try {
    return extrair(await getJson(urlResultado(eleicao, uf, cargo)));
  } catch (err) {
    return { erro: err.message };
  }
}

// Busca presidente (Brasil, cada UF e exterior) e governadores de uma vez
export async function buscarSnapshot(eleicoes) {
  const { presidente, governador } = eleicoes;
  const abrPres = ["br", ...TODAS_UFS, "zz"];
  const ufsGov = governador?.ufs ?? [];
  const [pres, gov] = await Promise.all([
    Promise.all(abrPres.map((uf) => buscar(presidente.eleicao, uf, CARGO_PRESIDENTE))),
    Promise.all(ufsGov.map((uf) => buscar(governador.eleicao, uf, CARGO_GOVERNADOR))),
  ]);
  const snap = { turno: eleicoes.turno, presidente: { br: pres[0], ufs: {} }, governador: {} };
  abrPres.slice(1).forEach((uf, i) => (snap.presidente.ufs[uf] = pres[i + 1]));
  ufsGov.forEach((uf, i) => (snap.governador[uf] = gov[i]));
  return snap;
}
