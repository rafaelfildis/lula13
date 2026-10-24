#!/usr/bin/env node
// Acompanha a apuração das Eleições 2026 a partir dos JSON públicos do TSE
// (os mesmos arquivos usados pelo app oficial resultados.tse.jus.br).
//
// Uso:
//   node apuracao.mjs                    -> 2º turno: presidente + governadores, atualiza a cada 60 s
//   node apuracao.mjs --intervalo 30     -> consulta a cada 30 s (mínimo 15)
//   node apuracao.mjs --uf df,es         -> só esses estados no governador
//   node apuracao.mjs --sem-governador   -> só presidente
//   node apuracao.mjs --uma-vez          -> consulta uma vez e sai
//   node apuracao.mjs --turno 1 --uf sp  -> 1º turno (útil para testar com dados já fechados)
//   node apuracao.mjs --csv log.csv      -> grava cada atualização nova em CSV
//
// Requer Node 18+ (fetch nativo). Sem dependências.

import { appendFileSync, existsSync } from "node:fs";

const BASE = "https://resultados.tse.jus.br/oficial";
const CICLO = "ele2026";
const CARGO_PRESIDENTE = "1";
const CARGO_GOVERNADOR = "3";
const TODAS_UFS = "ac al am ap ba ce df es go ma mg ms mt pa pb pe pi pr rj rn ro rr rs sc se sp to".split(" ");

// ---------- argumentos ----------
const args = process.argv.slice(2);
const flag = (nome) => args.includes(nome);
const valor = (nome, padrao) => {
  const i = args.indexOf(nome);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};
const opts = {
  turno: valor("--turno", "2"),
  intervalo: Math.max(15, Number(valor("--intervalo", "60")) || 60),
  ufs: valor("--uf", "") ? valor("--uf", "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean) : null,
  semGovernador: flag("--sem-governador"),
  umaVez: flag("--uma-vez"),
  csv: valor("--csv", ""),
};

// ---------- utilidades ----------
const num = (s) => Number(String(s ?? "0").replace(/\./g, "").replace(",", ".")) || 0;
const fmtInt = (n) => n.toLocaleString("pt-BR");
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);
const cor = process.stdout.isTTY
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` }
  : { b: (s) => s, g: (s) => s, y: (s) => s, d: (s) => s };

async function getJson(url) {
  const r = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r.json();
}

const urlResultado = (eleicao, uf, cargo) =>
  `${BASE}/${CICLO}/${eleicao}/dados/${uf}/${uf}-c${cargo.padStart(4, "0")}-e${eleicao.padStart(6, "0")}-u.json`;

// ---------- descobre as eleições do turno no arquivo de configuração ----------
async function descobrirAlvos() {
  const cfg = await getJson(`${BASE}/comum/config/ele-c.json`);
  // O ciclo aparece em mais de um "pleito" (1º turno e 2º turno ficam em entradas separadas)
  const pleitos = cfg.pl.filter((p) => p.c === CICLO);
  if (!pleitos.length) throw new Error(`Ciclo ${CICLO} não encontrado na configuração do TSE`);

  const alvos = [];
  for (const e of pleitos.flatMap((p) => p.e)) {
    if (e.t !== opts.turno || !/Ordinária (Federal|Estadual)/.test(e.nm)) continue;
    for (const abr of e.abr) {
      for (const cp of abr.cp ?? []) {
        if (cp.cd === CARGO_PRESIDENTE) {
          alvos.push({ eleicao: e.cd, uf: "br", cargo: cp.cd, rotulo: "PRESIDENTE — BRASIL" });
        } else if (cp.cd === CARGO_GOVERNADOR && !opts.semGovernador) {
          // No 1º turno a abrangência vem como "br" (todas as UFs); no 2º, uma entrada por UF.
          const ufs = abr.cd === "br" ? TODAS_UFS : [abr.cd];
          for (const uf of ufs) {
            if (opts.ufs && !opts.ufs.includes(uf)) continue;
            alvos.push({ eleicao: e.cd, uf, cargo: cp.cd, rotulo: `GOVERNADOR — ${uf.toUpperCase()}` });
          }
        }
      }
    }
  }
  // Presidente primeiro, depois governadores em ordem alfabética de UF
  alvos.sort((a, b) => (a.uf === "br" ? -1 : b.uf === "br" ? 1 : a.uf.localeCompare(b.uf)));
  return alvos;
}

// ---------- lê um arquivo de resultado ----------
function extrair(d) {
  const cargo = d.carg?.[0] ?? {};
  const cands = [];
  for (const agr of cargo.agr ?? [])
    for (const par of agr.par ?? [])
      for (const c of par.cand ?? [])
        cands.push({
          numero: c.n,
          nome: c.nmu || c.nm,
          partido: par.sg,
          votos: num(c.vap),
          pct: c.pvap ?? "0,00",
          // "e" = "s" também marca quem passou ao 2º turno; a situação ("st") desempata
          eleito: c.e === "s" && !/2º turno/i.test(c.st || ""),
          situacao: c.st || "",
        });
  cands.sort((a, b) => b.votos - a.votos);
  return {
    atualizado: `${d.dg} ${d.hg}`,
    totalizado: d.tf === "s",
    secoesPct: d.s?.pst ?? "0,00",
    secoes: `${fmtInt(num(d.s?.st))}/${fmtInt(num(d.s?.ts))}`,
    comparecimentoPct: d.e?.pc ?? "0,00",
    abstencaoPct: d.e?.pa ?? "0,00",
    validos: num(d.v?.vv),
    brancosPct: d.v?.pvb ?? "0,00",
    nulosPct: d.v?.ptvn ?? "0,00",
    cands,
  };
}

// ---------- exibição ----------
function bloco(alvo, r, novo) {
  const linhas = [];
  const status = r.totalizado ? cor.g("TOTALIZADO") : `${r.secoesPct}% das seções (${r.secoes})`;
  linhas.push(`${cor.b(alvo.rotulo)}  ${status}  ${cor.d("atualizado " + r.atualizado)}${novo ? cor.y("  ● novo") : ""}`);
  for (const c of r.cands) {
    const barra = "█".repeat(Math.round(num(c.pct) / 4));
    const tag = c.eleito ? cor.g(" ELEITO") : /2º turno/i.test(c.situacao) ? cor.y(" → 2º turno") : c.situacao ? cor.d(" " + c.situacao) : "";
    linhas.push(
      `  ${padL(c.numero, 2)} ${pad(c.nome, 26)} ${pad(c.partido, 14)} ${padL(fmtInt(c.votos), 12)}  ${padL(c.pct, 6)}%  ${barra}${tag}`
    );
  }
  if (r.cands.length >= 2 && r.cands[0].votos > 0) {
    const dif = r.cands[0].votos - r.cands[1].votos;
    linhas.push(cor.d(`  vantagem: ${fmtInt(dif)} votos · comparecimento ${r.comparecimentoPct}% · brancos ${r.brancosPct}% · nulos ${r.nulosPct}%`));
  }
  return linhas.join("\n");
}

function gravarCsv(alvo, r) {
  if (!opts.csv) return;
  if (!existsSync(opts.csv)) appendFileSync(opts.csv, "﻿consulta;atualizado_tse;cargo;uf;secoes_pct;numero;candidato;partido;votos;pct;eleito\n");
  const agora = new Date().toLocaleString("pt-BR");
  const cargo = alvo.cargo === CARGO_PRESIDENTE ? "Presidente" : "Governador";
  for (const c of r.cands)
    appendFileSync(
      opts.csv,
      [agora, r.atualizado, cargo, alvo.uf.toUpperCase(), r.secoesPct, c.numero, c.nome, c.partido, c.votos, c.pct, c.eleito ? "sim" : "não"].join(";") + "\n"
    );
}

// ---------- laço principal ----------
const vistos = new Map(); // url -> "dg hg" da última versão exibida

async function ciclo(alvos) {
  const resultados = await Promise.all(
    alvos.map(async (alvo) => {
      const url = urlResultado(alvo.eleicao, alvo.uf, alvo.cargo);
      try {
        const r = extrair(await getJson(url));
        const novo = vistos.has(url) && vistos.get(url) !== r.atualizado;
        if (vistos.get(url) !== r.atualizado) gravarCsv(alvo, r);
        vistos.set(url, r.atualizado);
        return bloco(alvo, r, novo);
      } catch (err) {
        return `${cor.b(alvo.rotulo)}  ${cor.y("erro: " + err.message)}`;
      }
    })
  );
  if (process.stdout.isTTY && !opts.umaVez) process.stdout.write("\x1b[2J\x1b[H");
  console.log(cor.b(`Apuração ${CICLO} · ${opts.turno}º turno · fonte: TSE (resultados.tse.jus.br)`));
  console.log(cor.d(`consulta em ${new Date().toLocaleString("pt-BR")}` + (opts.umaVez ? "" : ` · próxima em ${opts.intervalo}s · Ctrl+C para sair`)) + "\n");
  console.log(resultados.join("\n\n"));
}

const alvos = await descobrirAlvos();
if (!alvos.length) {
  console.error("Nenhuma eleição encontrada para os filtros informados.");
  process.exit(1);
}
await ciclo(alvos);
if (!opts.umaVez) setInterval(() => ciclo(alvos).catch((e) => console.error(e.message)), opts.intervalo * 1000);
