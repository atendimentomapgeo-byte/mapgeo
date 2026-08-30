/**
 * compass.js
 * -----------------------------------------------------------------------
 * Leitura da bússola/magnetômetro do aparelho (para onde o CELULAR está
 * fisicamente apontando), usando a DeviceOrientation API do navegador.
 *
 * Isso é DIFERENTE do "heading" que vem da Geolocation API (GPS): aquele só
 * existe quando o usuário está em movimento (é calculado pela variação de
 * posição entre dois pontos consecutivos) e fica indisponível parado. Já a
 * bússola do aparelho funciona mesmo parado, pois lê o magnetômetro físico.
 *
 * Particularidades por plataforma:
 *   - iOS Safari: expõe `event.webkitCompassHeading`, que já é o rumo
 *     magnético verdadeiro (0°=Norte, aumenta no sentido horário), pronto
 *     para uso direto. A partir do iOS 13, é obrigatório pedir permissão
 *     via `DeviceOrientationEvent.requestPermission()`, e essa chamada só
 *     funciona se disparada a partir de um gesto do usuário (toque em botão)
 *     — não é possível conceder essa permissão automaticamente ao abrir o
 *     app, e ela não é lembrada entre recarregamentos de página.
 *   - Android/Chrome: dispara o evento `deviceorientationabsolute` (quando
 *     disponível) com `event.alpha`, que precisa ser convertido para rumo de
 *     bússola (a API não entrega o valor pronto como no iOS). A precisão
 *     depende do magnetômetro do aparelho e pode exigir calibração (o
 *     clássico gesto de "desenhar um 8" com o celular).
 *
 * Por ser leitura de sensor físico, o valor é naturalmente "tremido"
 * (ruidoso) — aplicamos uma suavização circular (média de vetores) para dar
 * uma seta estável na tela.
 */

(function () {
  const listeners = new Set();
  let active = false;
  let activeHandler = null;
  let attachedEventNames = [];
  let smoothedHeading = null;
  let watchdogTimer = null;
  let rawEventCount = 0; // quantos eventos de orientação chegaram, utilizáveis ou não
  let usableEventCount = 0; // quantos tinham um rumo de bússola aproveitável

  function emit(event, data) {
    listeners.forEach((cb) => cb(event, data));
  }

  /** Suavização circular (evita "pulo" de 359° para 0°) via média de vetores unitários. */
  function smooth(novoValor, fator = 0.25) {
    if (smoothedHeading == null) {
      smoothedHeading = novoValor;
      return smoothedHeading;
    }
    const r1 = (smoothedHeading * Math.PI) / 180;
    const r2 = (novoValor * Math.PI) / 180;
    const x = Math.cos(r1) * (1 - fator) + Math.cos(r2) * fator;
    const y = Math.sin(r1) * (1 - fator) + Math.sin(r2) * fator;
    let deg = (Math.atan2(y, x) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    smoothedHeading = deg;
    return smoothedHeading;
  }

  /** Converte o `alpha` bruto do Android/Chrome em rumo de bússola (0°=Norte, horário). */
  function alphaParaRumo(alpha) {
    let rumo = 360 - alpha;
    const anguloTela = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    rumo = (rumo + anguloTela) % 360;
    if (rumo < 0) rumo += 360;
    return rumo;
  }

  const Compass = {
    isSupported() {
      return typeof DeviceOrientationEvent !== 'undefined';
    },

    /** Indica se é necessário pedir permissão explícita (iOS 13+) antes de usar. */
    needsExplicitPermission() {
      return typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
    },

    /**
     * Pede permissão de acesso ao sensor de orientação. DEVE ser chamada a
     * partir de um gesto do usuário (ex.: dentro de um onclick), senão o
     * iOS rejeita silenciosamente.
     */
    async requestPermission() {
      if (!Compass.isSupported()) return false;
      if (Compass.needsExplicitPermission()) {
        try {
          const resultado = await DeviceOrientationEvent.requestPermission();
          return resultado === 'granted';
        } catch (e) {
          return false;
        }
      }
      return true; // Android e navegadores que não exigem permissão explícita
    },

    on(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    start() {
      if (active || !Compass.isSupported()) return;
      smoothedHeading = null;
      rawEventCount = 0;
      usableEventCount = 0;

      const handler = (event) => {
        rawEventCount++;
        let rumo = null;
        let precisao = null;

        if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
          // iOS: valor já pronto, é o rumo magnético verdadeiro.
          rumo = event.webkitCompassHeading;
          precisao = event.webkitCompassAccuracy;
        } else if (event.alpha != null && (event.absolute === true || event.type === 'deviceorientationabsolute')) {
          rumo = alphaParaRumo(event.alpha);
        } else {
          return; // este evento chegou, mas sem dado de rumo aproveitável
        }

        usableEventCount++;
        emit('heading', { heading: smooth(rumo), rawHeading: rumo, accuracy: precisao });
      };

      // Registra os dois nomes de evento ao mesmo tempo (em vez de "adivinhar"
      // qual o navegador suporta via feature-detection): o handler ignora
      // sozinho o que não trouxer dado utilizável, então não há problema em
      // escutar ambos — isso evita depender de detecção de propriedades que
      // podem existir sem o evento realmente disparar, ou vice-versa.
      attachedEventNames = ['deviceorientationabsolute', 'deviceorientation'];
      attachedEventNames.forEach((name) => window.addEventListener(name, handler));
      activeHandler = handler;
      active = true;
      emit('started', {});

      // Watchdog: se em alguns segundos nenhum dado utilizável chegou, avisa
      // quem estiver ouvindo (a UI usa isso pra dar uma dica ao usuário em
      // vez de deixar a seta simplesmente parada sem explicação).
      clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        if (active && usableEventCount === 0) {
          emit('timeout', { rawEventCount, usableEventCount });
        }
      }, 3000);
    },

    stop() {
      clearTimeout(watchdogTimer);
      if (active && activeHandler) {
        attachedEventNames.forEach((name) => window.removeEventListener(name, activeHandler));
      }
      active = false;
      activeHandler = null;
      attachedEventNames = [];
      smoothedHeading = null;
      emit('stopped', {});
    },

    isActive() {
      return active;
    },

    /** Contadores de diagnóstico: úteis para identificar se o sensor está enviando dados. */
    getDiagnostics() {
      return { rawEventCount, usableEventCount };
    },
  };

  window.Compass = Compass;
})();
