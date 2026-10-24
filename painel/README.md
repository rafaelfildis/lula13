# Painel da apuração 2026 (protótipo)

Mapa do Brasil com a apuração do TSE em tempo real (esquerda) e sala ao vivo com chat, câmera e microfone (direita).
Entrada só com nome, sem cadastro. Antes da primeira urna apurada, o painel fica em branco ("aguardando o início da apuração").

**No ar:** https://rafaelfildis.github.io/lula13/

## Como funciona

Tudo roda no navegador, por isso o site pode ficar no GitHub Pages, sem servidor:

- **Resultados:** `public/lib/tse.js` lê os JSON públicos de resultados.tse.jus.br (o TSE libera CORS) e atualiza a cada 30 s.
- **Quem está na sala e chat:** `public/lib/mensageiro.js` usa dois brokers MQTT públicos (EMQX e Mosquitto) por WebSocket. Funciona em qualquer rede (4G, Wi-Fi de empresa), porque não depende de conexão direta entre aparelhos. Todo mundo, no celular ou no computador, fica na mesma sala; em `localhost` o site usa uma sala de testes à parte. Quem chega recebe as últimas 50 mensagens de quem já está lá.
- **Câmera e microfone:** [Trystero](https://github.com/dmotz/trystero) conecta os navegadores por WebRTC (sinalização por relays Nostr). Entre algumas redes a conexão direta falha; para esses casos, preencha `TURN` no topo de `public/app.js` com as credenciais de um serviço TURN (ex.: conta gratuita em metered.ca).
- **Mapa:** `public/brasil-ufs.json`, gerado por `ferramentas/gerar-mapa.mjs` a partir do GeoJSON dos estados (click_that_hood).

Parâmetro de URL: `?turno=1` mostra os resultados reais do 1º turno.

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

- **Vídeo em malha P2P:** cada câmera é enviada direto para cada pessoa. Máximo de 8 câmeras abertas; para muita gente com vídeo, use um servidor de mídia (LiveKit, mediasoup).
- **Sem TURN configurado**, o vídeo pode não aparecer entre algumas redes (o chat e a lista de pessoas continuam funcionando).
- Os brokers MQTT são públicos e gratuitos, sem garantia de disponibilidade; qualquer um que conheça o tópico pode ler e publicar nele.
- Não há moderação, denúncia nem bloqueio no chat, e o histórico só existe enquanto houver alguém na sala.
- Cada visitante consulta o TSE diretamente (~35 arquivos a cada 30 s), assim como o app oficial.
