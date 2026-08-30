/**
 * points.js
 * -----------------------------------------------------------------------
 * Registro e gerenciamento de pontos de campo.
 *
 * Cada ponto armazena coordenada, altitude, precisão, data/hora de coleta,
 * nome/código, descrição, atributos customizados (definidos por formulários
 * configuráveis — ver forms em projects.js) e fotografias associadas.
 */

(function () {
  let sequenceCache = {};

  async function nextCode(projectId) {
    if (!sequenceCache[projectId]) {
      const points = await DB.byProject('points', projectId);
      sequenceCache[projectId] = points.length;
    }
    sequenceCache[projectId] += 1;
    return `P-${String(sequenceCache[projectId]).padStart(3, '0')}`;
  }

  const Points = {
    /**
     * Captura a posição atual e cria um novo ponto (sem salvar ainda — retorna rascunho).
     *
     * Em vez de disparar uma nova chamada getCurrentPosition() isolada (o que em
     * alguns aparelhos/navegadores pode demorar para religar o receptor GNSS caso
     * o monitoramento contínuo via watchPosition já esteja ativo), reaproveitamos
     * a última posição do monitoramento contínuo do GPS (gps.js) quando ela for
     * recente o suficiente. Isso reflete exatamente a posição já exibida na tela
     * para o usuário e evita solicitações redundantes ao hardware de GPS.
     */
    async captureDraft(projectId) {
      const FRESH_MS = 8000;
      let coords, timestamp;

      const last = GPS.getLastPosition();
      if (last && Date.now() - last.timestamp < FRESH_MS) {
        coords = last.coords;
        timestamp = last.timestamp;
      } else {
        GPS.start();
        const fresh = await Points._waitForFix(15000);
        coords = fresh.coords;
        timestamp = fresh.timestamp;
      }

      const code = await nextCode(projectId);
      return {
        projectId,
        name: code,
        code,
        lat: coords.latitude,
        lon: coords.longitude,
        alt: coords.altitude,
        accuracy: coords.accuracy,
        capturedAt: new Date(timestamp).toISOString(),
        description: '',
        attributes: {},
        photos: [],
      };
    },

    /** Cria um rascunho de ponto numa coordenada arbitrária (ex.: tocada no mapa via a ferramenta "Identificar coordenada"), sem depender do GPS. */
    async draftAt(projectId, lat, lon) {
      const code = await nextCode(projectId);
      return {
        projectId,
        name: code,
        code,
        lat,
        lon,
        alt: null,
        accuracy: null,
        capturedAt: new Date().toISOString(),
        description: '',
        attributes: {},
        photos: [],
      };
    },

    /** Aguarda a próxima leitura do monitoramento contínuo de GPS (ou usa getCurrentPosition como reforço). */
    _waitForFix(timeoutMs) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const unsubscribe = GPS.on((event, data) => {
          if (event === 'position' && !settled) {
            settled = true;
            unsubscribe();
            clearTimeout(timer);
            resolve({ coords: { latitude: data.lat, longitude: data.lon, altitude: data.altitude, accuracy: data.accuracy }, timestamp: data.timestamp || Date.now() });
          }
        });
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          reject(new Error('GPS indisponível: não foi possível obter um sinal de localização a tempo. Tente novamente em um local aberto.'));
        }, timeoutMs);
      });
    },

    async save(point, layerId) {
      point.layerId = layerId;
      return DB.put('points', point);
    },

    async delete(id) {
      // Remove fotos associadas
      const photos = await DB.byIndex('photos', 'pointId', id);
      for (const p of photos) await DB.delete('photos', p.id);
      return DB.delete('points', id);
    },

    async addPhoto(pointId, projectId, blob, meta) {
      const photo = {
        projectId,
        pointId,
        blob,
        lat: meta.lat,
        lon: meta.lon,
        alt: meta.alt,
        takenAt: new Date().toISOString(),
      };
      return DB.put('photos', photo);
    },

    async getPhotos(pointId) {
      return DB.byIndex('photos', 'pointId', pointId);
    },

    async listByProject(projectId) {
      return DB.byProject('points', projectId);
    },

    /** Busca por nome, código, ou proximidade de coordenada. */
    async search(projectId, query) {
      const points = await Points.listByProject(projectId);
      const q = query.trim().toLowerCase();
      if (!q) return points;

      // Tenta interpretar como coordenada
      const coordVal = Coordinates.parseCoordString(q);
      const results = points.filter((p) => {
        if ((p.name || '').toLowerCase().includes(q)) return true;
        if ((p.code || '').toLowerCase().includes(q)) return true;
        if ((p.description || '').toLowerCase().includes(q)) return true;
        return false;
      });
      return results;
    },

    renderToLayerGroup(point, layerGroup, onClick) {
      const marker = L.marker([point.lat, point.lon], {
        icon: L.divIcon({
          className: 'fg-point-icon',
          html: `<div class="fg-point-pin"><span>${(point.code || point.name || '').replace('P-', '')}</span></div>`,
          iconSize: [28, 36],
          iconAnchor: [14, 36],
        }),
      });
      marker.on('click', () => onClick && onClick(point));
      marker.addTo(layerGroup);
      return marker;
    },

    formatPointInfo(point, settings) {
      const latText = Coordinates.formatLat(point.lat, settings.coords.format);
      const lonText = Coordinates.formatLon(point.lon, settings.coords.format);
      const utm = Coordinates.toUTM(point.lat, point.lon, settings.coords.datum);
      return { latText, lonText, utm };
    },
  };

  window.Points = Points;
})();
