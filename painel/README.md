# Painel da apuração 2026 (protótipo)

Mapa do Brasil com a apuração do TSE em tempo real (esquerda) e sala ao vivo com chat, câmera e microfone (direita).
Entrada só com nome, sem cadastro. Antes da primeira urna apurada, o painel fica em branco ("aguardando o início da apuração").

**No ar:** https://rafaelfildis.github.io/lula13/

## Como funciona

Tudo roda no navegador, por isso o site pode ficar no GitHub Pages, sem servidor:

- **Resultados:** `public/lib/tse.js` lê os JSON públicos de resultados.tse.jus.br (o TSE libera CORS) e atualiza a cada 30 s.
- **Sala ao vivo:** [Trystero](https://github.com/dmotz/trystero) conecta os navegadores entre si. Eles se encontram por relays públicos da rede Nostr; depois chat, câmera e microfone vão direto de um navegador para o outro (WebRTC). Quem chega recebe as últimas mensagens de quem já está na sala.
- **Mapa:** `public/brasil-ufs.json`, gerado por `ferramentas/gerar-mapa.mjs` a partir do GeoJSON dos estados (click_that_hood).

Parâmetros de URL: `?sala=nome` abre uma sala separada; `?turno=1` mostra os resultados reais do 1º turno.

## Rodar localmente

```bash
npm start      # http://localhost:3000 (só serve a pasta public/)
```

## Publicar

O GitHub Pages serve o branch `gh-pages`, que é uma cópia da pasta `public/`. Depois de fazer commit no `main`:

```bash
npm run publicar
```

## Limites do protótipo

- **Todos se conectam com todos (malha P2P).** Funciona bem com algumas dezenas de pessoas por sala; para mais gente, divida em salas (`?sala=`) ou use um servidor de mídia (LiveKit, mediasoup). Máximo de 8 câmeras abertas.
- Só usa STUN: em algumas redes (4G, redes corporativas) a conexão direta falha e seria preciso um servidor TURN.
- Não há moderação, denúncia nem bloqueio no chat, e o histórico só existe enquanto houver alguém na sala.
- Cada visitante consulta o TSE diretamente (~35 arquivos a cada 30 s), assim como o app oficial.
