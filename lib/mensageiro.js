// Canal de mensagens da sala (presença e chat) por brokers MQTT públicos via WebSocket.
// Diferente da conexão direta entre navegadores (WebRTC), isso funciona em qualquer rede — 4G, Wi-Fi de
// empresa, CGNAT — porque cada navegador só abre uma conexão comum (wss://) com o broker.
// Usa dois brokers ao mesmo tempo: se um cair, o outro segura; mensagens repetidas são descartadas pelo "pid".

import mqtt from "https://cdn.jsdelivr.net/npm/mqtt@5.15.2/dist/mqtt.esm.js";

const BROKERS = ["wss://broker.emqx.io:8084/mqtt", "wss://test.mosquitto.org:8081"];
const aleatorio = () => Math.random().toString(36).slice(2, 12);

export function criarCanal(topico, { aoReceber, aoConectar, aoMudarConexao, despedida }) {
  const vistos = new Set();
  const ordem = [];
  const lembrar = (pid) => {
    vistos.add(pid);
    ordem.push(pid);
    if (ordem.length > 3000) vistos.delete(ordem.shift());
  };

  // A "despedida" é publicada pelo próprio broker se a conexão cair sem aviso (aba fechada, sinal perdido)
  const vontade = despedida && { topic: topico, payload: JSON.stringify({ ...despedida, pid: "will-" + aleatorio() }), qos: 0, retain: false };

  const clientes = BROKERS.map((url) => {
    const c = mqtt.connect(url, {
      clientId: "lula13-" + aleatorio(),
      clean: true,
      keepalive: 30,
      connectTimeout: 10000,
      reconnectPeriod: 4000,
      will: vontade,
    });
    c.on("connect", () => {
      c.subscribe(topico, { qos: 0 }, () => aoConectar?.());
      aoMudarConexao?.(conectado());
    });
    for (const ev of ["close", "offline", "reconnect"]) c.on(ev, () => aoMudarConexao?.(conectado()));
    c.on("error", (err) => console.warn("MQTT", url, err.message));
    c.on("message", (_, buf) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (!m || typeof m !== "object" || !m.pid || vistos.has(m.pid)) return;
      lembrar(m.pid);
      aoReceber(m);
    });
    return c;
  });

  const conectado = () => clientes.some((c) => c.connected);

  function publicar(m) {
    const pid = aleatorio() + aleatorio();
    const pacote = JSON.stringify({ ...m, pid });
    for (const c of clientes) if (c.connected) c.publish(topico, pacote, { qos: 0 });
  }

  function fechar(ultima) {
    if (ultima) publicar(ultima);
    for (const c of clientes) c.end(false);
  }

  return { publicar, conectado, fechar };
}
