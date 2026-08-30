/**
 * navigation.js
 * -----------------------------------------------------------------------
 * Navegação até um ponto ("IR PARA") e bússola.
 *
 * Usa a posição GPS atual + coordenada de destino para calcular distância
 * e azimute em tempo real, atualizando uma seta indicadora na tela.
 *
 * Bússola: usa o evento `deviceorientationabsolute` (ou `deviceorientation`
 * como alternativa) para orientação do aparelho, combinado com o rumo
 * (heading) fornecido pelo GPS quando o usuário está em movimento — que
 * costuma ser mais confiável que o magnetômetro em celulares baratos.
 *
 * LIMITAÇÃO TÉCNICA: no iOS Safari, o acesso ao magnetômetro
 * (webkitCompassHeading) exige uma solicitação explícita de permissão do
 * usuário (DeviceOrientationEvent.requestPermission()), que só pode ser
 * chamada a partir de um gesto do usuário (ex.: toque em um botão). O
 * aplicativo solicita essa permissão ao ativar a bússola.
 */

(function () {
  let destination = null; // {lat, lon, name}
  let listeners = new Set();
  let compassHeading = null;
  let orientationActive = false;
  let arrowEl = null;

  function emit() {
    listeners.forEach((cb) => cb(Navigation.getState()));
  }

  function handleOrientation(ev) {
    let heading = null;
    if (ev.webkitCompassHeading != null) {
      heading = ev.webkitCompassHeading; // iOS: já é o heading verdadeiro (0 = Norte)
    } else if (ev.alpha != null) {
      // Android: alpha cresce no sentido anti-horário a partir do Norte quando
      // o evento é 'absolute'; fazemos a compensação para obter heading (0-360, horário).
      heading = 360 - ev.alpha;
    }
    if (heading != null) {
      compassHeading = (heading + 360) % 360;
      emit();
    }
  }

  const Navigation = {
    async enableCompass() {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const perm = await DeviceOrientationEvent.requestPermission();
          if (perm !== 'granted') {
            throw new Error('Permissão de orientação/bússola negada pelo usuário.');
          }
        } catch (e) {
          throw new Error('Não foi possível acessar o sensor de orientação (bússola) deste aparelho.');
        }
      }
      const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
      window.addEventListener(eventName, handleOrientation, true);
      orientationActive = true;
    },

    disableCompass() {
      window.removeEventListener('deviceorientationabsolute', handleOrientation, true);
      window.removeEventListener('deviceorientation', handleOrientation, true);
      orientationActive = false;
    },

    isCompassSupported() {
      return typeof window.DeviceOrientationEvent !== 'undefined';
    },

    setDestination(point) {
      destination = point ? { lat: point.lat, lon: point.lon, name: point.name || point.code } : null;
      emit();
    },

    clearDestination() {
      destination = null;
      emit();
    },

    getDestination() {
      return destination;
    },

    getState() {
      const gpsPos = GPS.getLastPosition();
      const state = {
        destination,
        compassHeading,
        distance: null,
        azimuth: null,
        cardinal: null,
      };
      if (destination && gpsPos) {
        const c = gpsPos.coords;
        state.distance = Coordinates.haversineDistance(c.latitude, c.longitude, destination.lat, destination.lon);
        state.azimuth = Coordinates.azimuth(c.latitude, c.longitude, destination.lat, destination.lon);
        state.cardinal = Coordinates.azimuthToCardinal(state.azimuth);
        state.gpsHeading = c.heading;
      }
      return state;
    },

    /** Rotação a aplicar na seta de navegação: aponta para o destino relativo à orientação do aparelho. */
    getArrowRotation() {
      const state = Navigation.getState();
      if (state.azimuth == null) return 0;
      const deviceHeading = compassHeading != null ? compassHeading : state.gpsHeading || 0;
      return state.azimuth - deviceHeading;
    },

    on(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  // Atualiza automaticamente quando a posição GPS muda
  GPS.on((event) => {
    if (event === 'position') emit();
  });

  window.Navigation = Navigation;
})();
