/**
 * gps.js
 * -----------------------------------------------------------------------
 * Monitoramento de GPS em tempo real usando a Geolocation API do navegador.
 *
 * A Geolocation API funciona totalmente offline: ela conversa diretamente
 * com o chip de GNSS do aparelho (GPS/GLONASS/Galileo/BeiDou conforme o
 * hardware) através do sistema operacional. Não é necessária internet,
 * exceto em alguns Android antigos que usam localização "assistida" por
 * rede para acelerar o primeiro fix (A-GPS) — em modo avião com GPS
 * habilitado, a maioria dos aparelhos modernos ainda obtém posição via
 * satélite puro, apenas com um tempo de aquisição inicial maior.
 *
 * Limitação técnica documentada: navegadores não expõem o número de
 * satélites nem a relação sinal/ruído (isso só está disponível para apps
 * nativos via APIs de baixo nível). Por isso, a "qualidade do sinal"
 * exibida aqui é inferida a partir da precisão horizontal (accuracy)
 * retornada pela API, que é a melhor aproximação possível em um navegador.
 */

(function () {
  const listeners = new Set();
  let watchId = null;
  let lastPosition = null;
  let totalDistance = 0; // metros, desde o início do monitoramento contínuo
  let history = [];

  function classifyQuality(accuracy) {
    if (accuracy == null) return 'unknown';
    if (accuracy <= 5) return 'excellent';
    if (accuracy <= 15) return 'good';
    if (accuracy <= 30) return 'moderate';
    return 'weak';
  }

  function friendlyGeoError(err) {
    switch (err.code) {
      case err.PERMISSION_DENIED:
        return 'Permissão de localização negada. Habilite o GPS/Localização para este site nas configurações do navegador.';
      case err.POSITION_UNAVAILABLE:
        return 'GPS indisponível no momento. Verifique se a localização está habilitada no aparelho.';
      case err.TIMEOUT:
        return 'Tempo esgotado ao tentar obter a posição GPS. Tente novamente em um local aberto.';
      default:
        return 'Não foi possível acessar o GPS.';
    }
  }

  function emit(event, data) {
    listeners.forEach((cb) => cb(event, data));
  }

  function handlePosition(pos) {
    const c = pos.coords;
    if (lastPosition) {
      const d = Coordinates.haversineDistance(lastPosition.coords.latitude, lastPosition.coords.longitude, c.latitude, c.longitude);
      // Ignora saltos irreais (ruído de GPS parado) menores que 1m
      if (d > 1) totalDistance += d;
    }
    lastPosition = pos;
    history.push({ lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: c.accuracy, speed: c.speed, heading: c.heading, time: pos.timestamp });
    if (history.length > 500) history.shift();

    emit('position', {
      lat: c.latitude,
      lon: c.longitude,
      altitude: c.altitude,
      accuracy: c.accuracy,
      altitudeAccuracy: c.altitudeAccuracy,
      speed: c.speed,
      heading: c.heading,
      timestamp: pos.timestamp,
      quality: classifyQuality(c.accuracy),
      totalDistance,
    });
  }

  function handleError(err) {
    emit('error', { message: friendlyGeoError(err), raw: err });
  }

  const GPS = {
    isSupported() {
      return 'geolocation' in navigator;
    },

    on(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    /** Inicia o monitoramento contínuo (watchPosition). */
    start(options = {}) {
      if (!GPS.isSupported()) {
        emit('error', { message: 'Este navegador/aparelho não possui suporte a GPS/Geolocalização.' });
        return;
      }
      if (watchId != null) return;
      const opts = Object.assign({ enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }, options);
      watchId = navigator.geolocation.watchPosition(handlePosition, handleError, opts);
      emit('started', {});
    },

    stop() {
      if (watchId != null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        emit('stopped', {});
      }
    },

    /** Obtém uma única leitura pontual (usado ao criar um ponto). */
    getCurrentPosition(options = {}) {
      return new Promise((resolve, reject) => {
        if (!GPS.isSupported()) {
          reject(new Error('GPS não suportado neste aparelho/navegador.'));
          return;
        }
        const opts = Object.assign({ enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }, options);
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve(pos),
          (err) => reject(new Error(friendlyGeoError(err))),
          opts
        );
      });
    },

    getLastPosition() {
      return lastPosition;
    },

    getHistory() {
      return history.slice();
    },

    resetDistance() {
      totalDistance = 0;
    },

    getTotalDistance() {
      return totalDistance;
    },

    classifyQuality,
  };

  window.GPS = GPS;
})();
