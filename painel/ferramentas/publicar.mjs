// Publica o painel no GitHub Pages: carimba a versão, faz commit de public/ no main,
// envia o main e copia public/ para o branch gh-pages (que é o que o Pages serve).
//
// Uso (dentro de painel/): npm run publicar

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = fileURLToPath(new URL("../../", import.meta.url));
const rodar = (cmd) => execSync(cmd, { cwd: raiz, stdio: "inherit" });

rodar("node painel/ferramentas/versionar.mjs");
rodar("git add painel/public");
try {
  rodar('git commit -q -m "Publica versão do painel"');
} catch {
  console.log("Nada novo para commitar em painel/public; publicando o que já está no main.");
}
rodar("git push origin main");
rodar("git subtree split --prefix painel/public -b gh-pages");
rodar("git push -f origin gh-pages");
console.log("\nPublicado. O GitHub Pages leva cerca de 1 minuto para atualizar: https://rafaelfildis.github.io/lula13/");
