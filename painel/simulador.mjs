// Simula a apuração do 2º turno para demonstrar o painel antes de o TSE começar a divulgar.
// Usa os candidatos reais do 2º turno e, como ponto de partida de cada UF, a divisão de votos
// entre os dois finalistas no 1º turno. Os números gerados são fictícios.

import { descobrirEleicoes, buscarSnapshot, TODAS_UFS } from "./tse.mjs";

const rand = (a, b) => a + Math.random() * (b - a);
const agoraTse = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function novaDisputa(finalistas, res1t, atraso = 0) {
  const pct1 = (n) => res1t?.cands?.find((c) => c.numero === n)?.pct ?? 0;
  const [a, b] = finalistas;
  const soma = pct1(a.numero) + pct1(b.numero);
  return {
    finalistas,
    baseA: soma ? pct1(a.numero) / soma : 0.5,
    comparecimento: Math.round((res1t?.comparecimento || 1_000_000) * rand(0.94, 0.99)),
    eleitorado: res1t?.eleitorado || 0,
    velocidade: rand(0.75, 1.35),
    atraso,
    votos: [0, 0],
    secoesPct: 0,
  };
}

function avancar(disp, t) {
  const alvo = Math.min(100, Math.max(0, (t - disp.atraso) * disp.velocidade) ** 0.85 * 100);
  if (alvo <= disp.secoesPct) return;
  disp.secoesPct = alvo >= 99.5 ? 100 : alvo;
  const validos = disp.comparecimento * 0.95;
  const delta = (validos * disp.secoesPct) / 100 - (disp.votos[0] + disp.votos[1]);
  // As primeiras urnas oscilam mais; a divisão converge para a base conforme a apuração avança
  const share = Math.min(0.98, Math.max(0.02, disp.baseA + rand(-0.06, 0.06) * (1 - disp.secoesPct / 100)));
  disp.votos[0] += Math.round(delta * share);
  disp.votos[1] += Math.round(delta * (1 - share));
}

function comoResultado(finalistas, votos, secoesPct, extra) {
  const total = votos[0] + votos[1];
  const fechado = secoesPct >= 100;
  const cands = finalistas
    .map((c, i) => ({
      ...c,
      votos: votos[i],
      pct: total ? Math.round((votos[i] / total) * 10000) / 100 : 0,
      eleito: false,
      segundoTurno: false,
    }))
    .sort((x, y) => y.votos - x.votos || Number(x.numero) - Number(y.numero));
  if (fechado && cands[0].votos > 0) cands[0].eleito = true;
  return {
    atualizado: agoraTse(),
    totalizado: fechado,
    secoesPct: Math.round(secoesPct * 100) / 100,
    brancosPct: 1.6,
    nulosPct: 3.1,
    ...extra,
    cands,
  };
}

export async function criarSimulador({ duracaoSeg = 300 } = {}) {
  const [e2, e1] = await Promise.all([descobrirEleicoes(2), descobrirEleicoes(1)]);
  const [real2, real1] = await Promise.all([buscarSnapshot(e2), buscarSnapshot(e1)]);
  const finalistas = (res) => (res?.cands ?? []).slice(0, 2).map(({ numero, nome, partido }) => ({ numero, nome, partido }));

  let inicio, pres, gov;
  function reiniciar() {
    inicio = Date.now();
    const fp = finalistas(real2.presidente.br);
    pres = Object.fromEntries(
      [...TODAS_UFS, "zz"].map((uf) => [uf, novaDisputa(fp, real1.presidente.ufs[uf], uf === "zz" ? 0.15 : rand(0, 0.08))])
    );
    gov = Object.fromEntries(
      Object.entries(real2.governador).map(([uf, r]) => [uf, novaDisputa(finalistas(r), real1.governador[uf], rand(0, 0.1))])
    );
  }
  reiniciar();

  return {
    descricao: `simulação (${duracaoSeg}s, recomeça sozinha)`,
    async snapshot() {
      const t = (Date.now() - inicio) / 1000 / duracaoSeg;
      if (t > 1.4) reiniciar(); // segura o resultado final por um tempo e recomeça
      const snap = { turno: 2, simulado: true, presidente: { br: null, ufs: {} }, governador: {} };

      let votosBr = [0, 0], peso = 0, apurado = 0;
      for (const [uf, d] of Object.entries(pres)) {
        avancar(d, t);
        snap.presidente.ufs[uf] = comoResultado(d.finalistas, d.votos, d.secoesPct, {
          eleitorado: d.eleitorado,
          comparecimento: d.comparecimento,
          comparecimentoPct: d.eleitorado ? Math.round((d.comparecimento / d.eleitorado) * 10000) / 100 : 0,
        });
        votosBr = [votosBr[0] + d.votos[0], votosBr[1] + d.votos[1]];
        peso += d.comparecimento;
        apurado += (d.comparecimento * d.secoesPct) / 100;
      }
      const eleitoradoBr = Object.values(pres).reduce((s, d) => s + d.eleitorado, 0);
      snap.presidente.br = comoResultado(Object.values(pres)[0].finalistas, votosBr, Math.min(100, (apurado / peso) * 100), {
        eleitorado: eleitoradoBr,
        comparecimento: peso,
        comparecimentoPct: eleitoradoBr ? Math.round((peso / eleitoradoBr) * 10000) / 100 : 0,
      });

      for (const [uf, d] of Object.entries(gov)) {
        avancar(d, t);
        snap.governador[uf] = comoResultado(d.finalistas, d.votos, d.secoesPct, {
          eleitorado: d.eleitorado,
          comparecimento: d.comparecimento,
          comparecimentoPct: d.eleitorado ? Math.round((d.comparecimento / d.eleitorado) * 10000) / 100 : 0,
        });
      }
      return snap;
    },
  };
}
