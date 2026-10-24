// Carimba ?v=<versão> nos arquivos do site (CSS, JS e imports entre módulos).
// O GitHub Pages manda o navegador guardar arquivos por 10 min; sem isso, quem já abriu o site
// continuaria com o JavaScript antigo depois de uma publicação e não conversaria com quem tem o novo.
//
// Uso: node ferramentas/versionar.mjs   (o "npm run publicar" já chama)

import { readFileSync, writeFileSync } from "node:fs";
// Também grava public/versao.txt e window.VERSAO_SITE no index.html: a página compara os dois ao abrir.
import { fileURLToPath } from "node:url";

const versao = new Date().toISOString().replace(/\D/g, "").slice(0, 12); // AAAAMMDDhhmm
const publico = fileURLToPath(new URL("../public/", import.meta.url));

// referências locais: href="style.css", src="app.js", from "./lib/x.js" — com ou sem ?v= anterior
const padrao = /((?:href|src)="|from ")(\.\/)?((?:lib\/)?[\w-]+\.(?:css|js))(\?v=\w+)?"/g;

for (const arquivo of ["index.html", "app.js", "lib/tse.js", "lib/mensageiro.js"]) {
  let texto;
  try { texto = readFileSync(publico + arquivo, "utf8"); } catch { continue; }
  const novo = texto
    .replace(padrao, (_, antes, ponto = "", caminho) => `${antes}${ponto}${caminho}?v=${versao}"`)
    .replace(/window\.VERSAO_SITE = "\w*"/, `window.VERSAO_SITE = "${versao}"`);
  if (novo !== texto) {
    writeFileSync(publico + arquivo, novo);
    console.log(`${arquivo}: v=${versao}`);
  }
}
writeFileSync(publico + "versao.txt", versao + "\n");
