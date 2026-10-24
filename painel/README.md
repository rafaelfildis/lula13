# Painel da apuração 2026 (protótipo)

Mapa do Brasil com a apuração do TSE em tempo real (esquerda) e sala ao vivo com chat, câmera e microfone (direita).
Entrada só com nome, sem cadastro.

## Rodar

```bash
npm install
npm start          # 2º turno real (TSE), consulta a cada 30 s
npm run simular    # apuração fictícia acelerada (5 min, recomeça sozinha) para demonstrar
npm run turno1     # dados do 1º turno, já totalizados
```

Abra http://localhost:3000. Opções: `--porta 8080`, `--intervalo 45` (segundos, mínimo 15), `--duracao 120` (simulação).

## Como funciona

- `tse.mjs`: lê os JSON públicos de resultados.tse.jus.br. O TSE não libera CORS, então quem busca é o servidor, que repassa os dados aos navegadores pelo WebSocket. Assim, cada pessoa na sala não consulta o TSE por conta própria.
- `simulador.mjs`: gera uma apuração fictícia com os candidatos reais do 2º turno, partindo do resultado de cada UF no 1º turno. O painel e o chat mostram claramente que é simulação.
- `server.mjs`: arquivos estáticos + WebSocket (`/ws`) para chat, presença e sinalização WebRTC.
- `public/`: front-end sem framework. O mapa (`brasil-ufs.json`) foi gerado por `ferramentas/gerar-mapa.mjs` a partir do GeoJSON dos estados (click_that_hood).
- Vídeo e áudio vão direto entre os navegadores (malha P2P). O limite é de 8 câmeras abertas por sala.

## Limites do protótipo

- **Câmera e microfone exigem HTTPS** (ou `localhost`). Para outras pessoas acessarem, publique atrás de HTTPS, por exemplo com um túnel (Cloudflare Tunnel, ngrok) ou numa hospedagem com certificado.
- Só usa STUN: em algumas redes (4G, redes corporativas) a conexão de vídeo precisa de um servidor TURN.
- O chat fica na memória do servidor (últimas 150 mensagens) e não tem moderação, denúncia nem bloqueio. Isso é essencial antes de abrir ao público.
- A malha P2P não escala para muitas câmeras. Para salas grandes, use um SFU (LiveKit, mediasoup, Janus).
