/**
 * polygons.js
 * -----------------------------------------------------------------------
 * Ferramentas de polígono (área) e de medição (distância/área).
 *
 * Dois modos de criação de polígono:
 *   - Manual: o usuário toca no mapa para adicionar vértices;
 *   - GPS (percurso): o usuário caminha pelo limite da área enquanto o
 *     aplicativo registra automaticamente os vértices a partir da posição
 *     GPS (com filtro de distância mínima para evitar pontos redundantes).
 *
 * A mesma engine de desenho é reaproveitada pela ferramenta de MEDIÇÃO
 * (distância e área), que não persiste dados — apenas calcula e mostra o
 * resultado, podendo opcionalmente ser convertida em polígono salvo.
 */

(function () {
  let map = null;
  let drawing = false;
  let mode = null; // 'manual' | 'gps'
  let vertices = []; // [{lat,lon}]
  let tempLayerGroup = null;
  let polylinePreview = null;
  let polygonPreview = null;
  let vertexMarkers = [];
  let unsubscribeGPS = null;
  let lastGpsVertex = null;
  let clickHandler = null;
  let onChangeCb = null;

  function refreshPreview() {
    if (!tempLayerGroup) return;
    tempLayerGroup.clearLayers();
    vertexMarkers = [];
    const latlngs = vertices.map((v) => [v.lat, v.lon]);

    if (latlngs.length >= 3) {
      polygonPreview = L.polygon(latlngs, { color: '#2e7d32', weight: 2, fillOpacity: 0.25 }).addTo(tempLayerGroup);
    } else if (latlngs.length >= 1) {
      polylinePreview = L.polyline(latlngs, { color: '#2e7d32', weight: 3 }).addTo(tempLayerGroup);
    }
    vertices.forEach((v, i) => {
      const m = L.circleMarker([v.lat, v.lon], { radius: 5, color: '#2e7d32', fillColor: '#fff', fillOpacity: 1, weight: 2 }).addTo(tempLayerGroup);
      vertexMarkers.push(m);
    });

    if (onChangeCb) onChangeCb(Polygons.getStats());
  }

  const Polygons = {
    startManual() {
      map = MapModule.getMap();
      drawing = true;
      mode = 'manual';
      vertices = [];
      tempLayerGroup = L.layerGroup().addTo(map);
      clickHandler = (e) => {
        vertices.push({ lat: e.latlng.lat, lon: e.latlng.lng });
        refreshPreview();
      };
      map.on('click', clickHandler);
    },

    /**
     * @param {number} minDistanceMeters Distância mínima do último vértice para registrar um novo.
     * @param {number} minAccuracy Precisão mínima aceitável em metros — fixes piores que isso são ignorados.
     */
    startGPSWalk(minDistanceMeters = 3, minAccuracy = 30) {
      map = MapModule.getMap();
      drawing = true;
      mode = 'gps';
      vertices = [];
      lastGpsVertex = null;
      tempLayerGroup = L.layerGroup().addTo(map);
      GPS.start();
      unsubscribeGPS = GPS.on((event, data) => {
        if (event !== 'position' || !drawing || mode !== 'gps') return;
        if (data.accuracy != null && data.accuracy > minAccuracy) return;
        if (lastGpsVertex) {
          const d = Coordinates.haversineDistance(lastGpsVertex.lat, lastGpsVertex.lon, data.lat, data.lon);
          if (d < minDistanceMeters) return;
        }
        lastGpsVertex = { lat: data.lat, lon: data.lon };
        vertices.push(lastGpsVertex);
        refreshPreview();
      });
    },

    undoLastVertex() {
      vertices.pop();
      refreshPreview();
    },

    onChange(cb) {
      onChangeCb = cb;
    },

    getVertices() {
      return vertices.slice();
    },

    getStats() {
      if (vertices.length < 2) return { area: 0, perimeter: 0, vertexCount: vertices.length };
      const area = vertices.length >= 3 ? Coordinates.polygonArea(vertices.map((v) => ({ lat: v.lat, lng: v.lon }))) : 0;
      const perimeter = Coordinates.polygonPerimeter(vertices.map((v) => ({ lat: v.lat, lng: v.lon })), vertices.length >= 3);
      return { area, perimeter, vertexCount: vertices.length };
    },

    finish() {
      drawing = false;
      if (clickHandler && map) {
        map.off('click', clickHandler);
        clickHandler = null;
      }
      if (unsubscribeGPS) {
        unsubscribeGPS();
        unsubscribeGPS = null;
      }
    },

    cancel() {
      Polygons.finish();
      if (tempLayerGroup && map) map.removeLayer(tempLayerGroup);
      tempLayerGroup = null;
      vertices = [];
    },

    async save(name, projectId, layerId, attributes = {}) {
      const stats = Polygons.getStats();
      const polygon = {
        projectId,
        layerId,
        name: name || `Polígono ${new Date().toLocaleString('pt-BR')}`,
        vertices: vertices.slice(),
        area: stats.area,
        perimeter: stats.perimeter,
        attributes,
      };
      const saved = await DB.put('polygons', polygon);
      if (tempLayerGroup && map) map.removeLayer(tempLayerGroup);
      tempLayerGroup = null;
      vertices = [];
      return saved;
    },

    renderToLayerGroup(polygon, layerGroup, style = {}) {
      const latlngs = polygon.vertices.map((v) => [v.lat, v.lon]);
      const poly = L.polygon(latlngs, Object.assign({ color: '#2e7d32', weight: 2, fillOpacity: 0.2 }, style));
      const areaHa = Coordinates.convertArea(polygon.area, 'ha');
      poly.bindPopup(`<b>${polygon.name}</b><br>Área: ${areaHa.toFixed(4)} ha<br>Perímetro: ${polygon.perimeter.toFixed(2)} m`);
      poly.addTo(layerGroup);
      return poly;
    },
  };

  // -----------------------------------------------------------------
  // Ferramentas de medição (não persistem, reaproveitam a engine acima)
  // -----------------------------------------------------------------
  const Measure = {
    mode: null, // 'distance' | 'area'
    points: [],
    layerGroup: null,

    startDistance() {
      Measure._start('distance');
    },
    startArea() {
      Measure._start('area');
    },
    _start(kind) {
      Measure.cancel();
      Measure.mode = kind;
      Measure.points = [];
      const map = MapModule.getMap();
      Measure.layerGroup = L.layerGroup().addTo(map);
      Measure._handler = (e) => {
        Measure.points.push({ lat: e.latlng.lat, lon: e.latlng.lng });
        Measure._redraw();
      };
      map.on('click', Measure._handler);
    },
    _redraw() {
      Measure.layerGroup.clearLayers();
      const latlngs = Measure.points.map((p) => [p.lat, p.lon]);
      if (Measure.mode === 'area' && latlngs.length >= 3) {
        L.polygon(latlngs, { color: '#f57c00', weight: 2, fillOpacity: 0.2 }).addTo(Measure.layerGroup);
      } else if (latlngs.length >= 1) {
        L.polyline(latlngs, { color: '#f57c00', weight: 3, dashArray: '6,4' }).addTo(Measure.layerGroup);
      }
      Measure.points.forEach((p) => {
        L.circleMarker([p.lat, p.lon], { radius: 4, color: '#f57c00', fillColor: '#fff', fillOpacity: 1, weight: 2 }).addTo(Measure.layerGroup);
      });
      if (Measure._onChange) Measure._onChange(Measure.getResult());
    },
    onChange(cb) {
      Measure._onChange = cb;
    },
    undo() {
      Measure.points.pop();
      Measure._redraw();
    },
    getResult() {
      const pts = Measure.points.map((p) => ({ lat: p.lat, lng: p.lon }));
      if (Measure.mode === 'area') {
        return { area: pts.length >= 3 ? Coordinates.polygonArea(pts) : 0, perimeter: Coordinates.polygonPerimeter(pts, true), points: Measure.points.length };
      }
      const segments = [];
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = Coordinates.haversineDistance(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
        segments.push(d);
        total += d;
      }
      return { distance: total, segments, points: Measure.points.length };
    },
    cancel() {
      const map = MapModule.getMap();
      if (Measure._handler && map) map.off('click', Measure._handler);
      if (Measure.layerGroup && map) map.removeLayer(Measure.layerGroup);
      Measure.layerGroup = null;
      Measure.points = [];
      Measure.mode = null;
    },
  };

  window.Polygons = Polygons;
  window.Measure = Measure;
})();
