/**
 * map.js
 * -----------------------------------------------------------------------
 * Módulo do mapa principal do FieldGIS, construído sobre a biblioteca
 * Leaflet (vendorizada em /vendor/leaflet.js, licença BSD — não depende de
 * nenhum serviço do Google e funciona inteiramente offline quando não há
 * camada online ativa).
 *
 * Responsabilidades:
 *   - Inicializar o mapa e os controles (zoom, escala);
 *   - Gerenciar mapas base (importados offline: GeoTIFF/imagem georreferenciada,
 *     ou online opcional quando houver internet disponível);
 *   - Exibir marcador de posição atual com círculo de precisão e seta de rumo;
 *   - Exibir grade de coordenadas UTM sobreposta;
 *   - Exibir coordenadas do centro/cursor do mapa;
 *   - Gerenciar camadas vetoriais (pontos, trilhas, polígonos) através do
 *     LayerManager (ver layers.js), mantendo referência aos objetos Leaflet.
 *
 * ORIENTAÇÃO — Modo bússola (Norte do mapa alinhado com o Norte real):
 *   Quando a bússola do aparelho está ativa (compass.js), o mapa inteiro
 *   (tiles OSM/satélite, pontos/trilhas/polígonos e qualquer PDF/mapa
 *   importado) gira junto para acompanhar o rumo lido pela bússola — assim
 *   o Norte do mapa e do PDF ficam sempre alinhados com o Norte real. A
 *   seta do marcador de posição, por sua vez, fica travada apontando pra
 *   cima da tela (Norte de grade/tela): é o mapa que gira ao redor dela, não
 *   o contrário — o mesmo comportamento do modo "bússola"/"direção de
 *   deslocamento" usado por apps de navegação. Essa rotação é puramente
 *   visual (CSS transform no container do mapa), já que o Leaflet não
 *   suporta rotação nativa do "mundo"; por isso o arraste manual do mapa
 *   fica desativado enquanto esse modo está ativo (ver setRotationEnabled).
 */

(function () {
  let map = null;
  let baseLayers = {}; // name -> L.Layer
  let currentBaseLayerName = null;
  let activeOverlayLayers = {}; // layerId -> L.LayerGroup (pontos/trilhas/polígonos)
  let gridLayer = null;
  let positionMarker = null;
  let accuracyCircle = null;
  let settingsCache = null;
  let cursorCoordCallback = null;
  let viewportEl = null; // #map — a "janela" fixa que recorta a visão
  let innerEl = null; // #map-inner — onde o Leaflet roda de fato
  let currentHeading = 0; // último ângulo aplicado, usado ao redimensionar
  let rotacaoAtiva = false; // se true, #map-inner fica inflado (cobre a diagonal); se false, do tamanho exato da tela

  const DEFAULT_CENTER = [-15.7801, -47.9292]; // Brasília, apenas ponto de partida caso não haja GPS/projeto
  const DEFAULT_ZOOM = 5;

  /**
   * Dimensiona #map-inner. Quando a rotação por bússola está ativa, cobre a
   * DIAGONAL da janela visível (#map), garantindo que, em qualquer ângulo,
   * os quatro cantos da tela sempre estejam cobertos por conteúdo de
   * mapa/PDF — sem isso, apareceriam faixas/triângulos pretos nos cantos
   * (a área originalmente carregada pelo Leaflet é retangular, do tamanho
   * da tela). Quando a rotação está desligada (a maior parte do tempo),
   * fica do tamanho exato da tela — sem isso, o app carregaria tiles extras
   * à toa o tempo todo, mesmo sem nunca girar. Chamada no início, ao
   * ligar/desligar a rotação, e sempre que a janela for redimensionada.
   */
  function redimensionarMapaInterno() {
    if (!viewportEl || !innerEl) return;
    const w = viewportEl.clientWidth;
    const h = viewportEl.clientHeight;
    let novaW = w;
    let novaH = h;
    if (rotacaoAtiva) {
      // +12% de folga sobre a diagonal exata, evitando qualquer costura
      // visível nas bordas por arredondamento/antialiasing.
      const diagonal = Math.ceil(Math.sqrt(w * w + h * h) * 1.12);
      novaW = diagonal;
      novaH = diagonal;
    }
    innerEl.style.width = `${novaW}px`;
    innerEl.style.height = `${novaH}px`;
    aplicarTransformInner();
    if (map) map.invalidateSize();
  }

  /** Aplica a centralização (sempre) + rotação atual (quando houver) em #map-inner. */
  function aplicarTransformInner() {
    if (!innerEl) return;
    innerEl.style.transform = `translate(-50%, -50%) rotate(${-currentHeading}deg)`;
  }

  function createPositionIcon() {
    return L.divIcon({
      className: 'fg-position-icon',
      html: `<div class="fg-position-arrow" id="fg-position-arrow">
               <svg width="34" height="34" viewBox="0 0 34 34">
                 <circle cx="17" cy="17" r="8" fill="#1a73e8" stroke="#fff" stroke-width="2"/>
                 <path d="M17 2 L23 15 L17 11.5 L11 15 Z" fill="#1a73e8" stroke="#fff" stroke-width="1"/>
               </svg>
             </div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  const MapModule = {
    init(containerId, settings) {
      settingsCache = settings || DB.defaultSettings();
      viewportEl = document.getElementById(containerId);
      innerEl = document.getElementById('map-inner');

      redimensionarMapaInterno();
      window.addEventListener('resize', redimensionarMapaInterno);
      window.addEventListener('orientationchange', redimensionarMapaInterno);

      map = L.map('map-inner', {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        zoomControl: false,
        attributionControl: false,
        maxZoom: 22,
        // Permite zoom fracionário (ex.: 11.98 em vez de forçar 11 ou 12).
        // Essencial para o enquadramento automático (fitBounds) conseguir
        // preencher a tela com precisão ao abrir um projeto/PDF — com
        // apenas zooms inteiros, o zoom ideal quase nunca cai exatamente
        // num número redondo, e arredondar pra baixo (por segurança, pra
        // nada ficar cortado fora da tela) podia deixar a imagem com quase
        // metade do tamanho que deveria (cada nível de zoom dobra a escala).
        zoomSnap: 0,
        zoomDelta: 0.5, // cada toque no zoom (pinça/duplo toque) varia em passos menores, mais suaves
      });

      // Controles nativos do Leaflet (zoom +/-, escala, atribuição) removidos
      // de propósito: o app tem zoom por gesto de pinça/duplo toque e sua
      // própria barra de ferramentas, então esses widgets ficavam soltos por
      // cima da interface do app sem necessidade.

      // Mapa base "em branco" (papel quadriculado) — não depende de internet.
      baseLayers['blank'] = L.layerGroup(); // vazio, apenas fundo CSS
      MapModule.setBaseLayer('blank');

      // Mapas base online (só carregam de fato quando há internet; depois de
      // vistos uma vez, os tiles ficam salvos pelo Service Worker e continuam
      // aparecendo offline nas áreas já visitadas — ver service-worker.js).
      baseLayers['osm'] = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      });
      baseLayers['satellite'] = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          maxZoom: 19,
          attribution: 'Esri, Maxar, Earthstar Geographics',
        }
      );

      // Restaura o último mapa de fundo usado (ou mantém "blank" se nunca escolheu nenhum).
      const ultimoBase = localStorage.getItem('fieldgis-basemap');
      if (ultimoBase && baseLayers[ultimoBase]) {
        MapModule.setBaseLayer(ultimoBase);
      }

      map.on('mousemove', (e) => {
        if (cursorCoordCallback) cursorCoordCallback(e.latlng);
      });
      map.on('move', () => {
        if (cursorCoordCallback) cursorCoordCallback(map.getCenter(), true);
      });

      positionMarker = L.marker(DEFAULT_CENTER, { icon: createPositionIcon(), zIndexOffset: 1000, interactive: false });
      accuracyCircle = L.circle(DEFAULT_CENTER, { radius: 0, className: 'fg-accuracy-circle', color: '#1a73e8', weight: 1, fillOpacity: 0.12 });

      return map;
    },

    getMap() {
      return map;
    },

    onCursorMove(cb) {
      cursorCoordCallback = cb;
    },

    setBaseLayer(name) {
      if (currentBaseLayerName && baseLayers[currentBaseLayerName]) {
        map.removeLayer(baseLayers[currentBaseLayerName]);
      }
      const layer = baseLayers[name];
      if (layer) {
        layer.addTo(map);
        currentBaseLayerName = name;
        try { localStorage.setItem('fieldgis-basemap', name); } catch (e) { /* ignora se indisponível */ }
      }
    },

    getCurrentBaseLayer() {
      return currentBaseLayerName;
    },

    /** Adiciona um mapa raster offline (GeoTIFF/imagem/PDF georreferenciado) como camada base. */
    addRasterBaseLayer(id, imageUrl, bounds, opts = {}) {
      const layer = L.imageOverlay(imageUrl, bounds, { opacity: opts.opacity ?? 1, className: 'fg-raster-layer' });
      baseLayers[id] = layer;
      return layer;
    },

    removeBaseLayerDef(id) {
      if (baseLayers[id]) {
        if (currentBaseLayerName === id) MapModule.setBaseLayer('blank');
        delete baseLayers[id];
      }
    },

    listBaseLayers() {
      return Object.keys(baseLayers);
    },

    /** Atualiza a posição/precisão do marcador "Minha localização". A seta NUNCA gira — fica sempre travada apontando para cima da tela (ver setMapRotation). */
    updatePosition(lat, lon, accuracy) {
      const latlng = [lat, lon];
      positionMarker.setLatLng(latlng);
      if (!map.hasLayer(positionMarker)) positionMarker.addTo(map);
      accuracyCircle.setLatLng(latlng);
      accuracyCircle.setRadius(accuracy || 0);
      if (!map.hasLayer(accuracyCircle)) accuracyCircle.addTo(map);
    },

    /**
     * Gira o mapa inteiro (tiles OSM/satélite + qualquer PDF/mapa importado
     * + pontos/trilhas/polígonos — tudo dentro do mesmo container) para
     * acompanhar o rumo da bússola do aparelho. É assim que o Norte do mapa
     * e do PDF ficam sempre alinhados com o Norte real lido pela bússola: a
     * seta do marcador de posição fica travada apontando pra cima da tela
     * (Norte de grade/tela) e é o MUNDO que gira ao redor dela — o mesmo
     * modo "bússola"/"direção de deslocamento" usado por apps de navegação.
     *
     * Quem gira é #map-inner (maior que a tela, ver redimensionarMapaInterno),
     * não a janela visível #map — assim os cantos revelados pela rotação
     * sempre mostram mapa/PDF de verdade, nunca uma faixa preta vazia.
     */
    setMapRotation(heading) {
      if (heading == null || Number.isNaN(heading)) return;
      currentHeading = heading;
      aplicarTransformInner();

      // A seta do marcador de posição é um marcador Leaflet — portanto um
      // FILHO do próprio #map-inner — então ao girar o container inteiro ela
      // gira junto sem querer. Aqui aplicamos a rotação OPOSTA só nela: as
      // duas rotações se cancelam, e ela fica visualmente travada apontando
      // sempre pra cima da tela, como pedido.
      const arrow = document.getElementById('fg-position-arrow');
      if (arrow) arrow.style.transform = `rotate(${heading}deg)`;
    },

    /**
     * Liga/desliga o modo de rotação do mapa pela bússola. O Leaflet não
     * compensa os eventos de ponteiro pela rotação CSS, então o arraste
     * manual do mapa é desativado enquanto esse modo está ativo (o mapa se
     * recentraliza automaticamente na posição do GPS).
     */
    setRotationEnabled(enabled) {
      map.dragging[enabled ? 'disable' : 'enable']();
      rotacaoAtiva = enabled;
      if (!enabled) {
        currentHeading = 0;
      }
      redimensionarMapaInterno();
      if (!enabled) {
        const arrow = document.getElementById('fg-position-arrow');
        if (arrow) arrow.style.transform = '';
      }
    },

    centerOnPosition(lat, lon, zoom) {
      map.setView([lat, lon], zoom || Math.max(map.getZoom(), 17));
    },

    /**
     * Recentraliza suavemente na posição, mantendo o zoom ATUAL (sem forçar
     * um mínimo, diferente de centerOnPosition). Usada continuamente pelo
     * modo "seguir GPS" (ver wireLocate/wireGPS em app.js) — assim o cursor
     * nunca sai da tela durante uma gravação de trilha, mas sem brigar com
     * o nível de zoom que o usuário escolheu manualmente.
     */
    followPosition(lat, lon) {
      map.panTo([lat, lon], { animate: true, duration: 0.25 });
    },

    getCenter() {
      return map.getCenter();
    },

    /** Desenha/atualiza a grade UTM sobre a área visível do mapa. */
    toggleGrid(show, datum) {
      if (gridLayer) {
        map.removeLayer(gridLayer);
        gridLayer = null;
        map.off('moveend', redrawGrid);
      }
      if (show) {
        gridLayer = L.layerGroup().addTo(map);
        const redraw = () => redrawGrid(datum);
        map.on('moveend', redraw);
        redrawGrid.current = redraw;
        redraw();
      }
    },

    addOverlayLayer(layerId, leafletLayerGroup) {
      activeOverlayLayers[layerId] = leafletLayerGroup;
      leafletLayerGroup.addTo(map);
    },

    getOverlayLayer(layerId) {
      return activeOverlayLayers[layerId];
    },

    removeOverlayLayer(layerId) {
      const l = activeOverlayLayers[layerId];
      if (l) {
        map.removeLayer(l);
        delete activeOverlayLayers[layerId];
      }
    },

    /**
     * Ajusta o mapa para enquadrar as coordenadas informadas, ocupando a
     * tela toda (menos uma margem de 30px). Calcula o zoom IDEAL de forma
     * matemática e direta (via log2), em vez de testar zooms inteiros um a
     * um — com zoomSnap:0 habilitado (ver init), o mapa aceita esse zoom
     * fracionário exato, preenchendo a tela com precisão em vez de ficar
     * limitado a saltos inteiros (que podiam deixar a imagem com quase
     * metade do tamanho ideal, dependendo de quão perto do próximo nível
     * inteiro o zoom "certo" caísse). Usa o tamanho REAL da janela visível
     * (#map), nunca o de #map-inner (que fica inflado durante a rotação por
     * bússola).
     */
    fitBounds(bounds) {
      const b = L.latLngBounds(bounds);
      const padding = [30, 30];
      const tamanhoJanela = viewportEl
        ? { x: viewportEl.clientWidth, y: viewportEl.clientHeight }
        : map.getSize();
      const larguraAlvo = Math.max(1, tamanhoJanela.x - padding[0] * 2);
      const alturaAlvo = Math.max(1, tamanhoJanela.y - padding[1] * 2);

      const noroeste = L.latLng(b.getNorth(), b.getWest());
      const sudeste = L.latLng(b.getSouth(), b.getEast());

      // Mede a largura/altura das bounds em pixels num zoom de referência
      // qualquer, e a partir disso calcula matematicamente o zoom exato que
      // faz caber perfeitamente na janela (dobrar o zoom dobra os pixels,
      // então a diferença de zoom necessária é log2 da razão de escala).
      const zRef = 10;
      const p1 = map.project(noroeste, zRef);
      const p2 = map.project(sudeste, zRef);
      const larguraRef = Math.abs(p2.x - p1.x);
      const alturaRef = Math.abs(p2.y - p1.y);

      let zoomIdeal = map.getMaxZoom();
      if (larguraRef > 0) zoomIdeal = Math.min(zoomIdeal, zRef + Math.log2(larguraAlvo / larguraRef));
      if (alturaRef > 0) zoomIdeal = Math.min(zoomIdeal, zRef + Math.log2(alturaAlvo / alturaRef));
      zoomIdeal = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoomIdeal));

      map.setView(b.getCenter(), zoomIdeal);
    },

    invalidateSize() {
      map.invalidateSize();
    },
  };

  function redrawGrid(datum) {
    if (!gridLayer) return;
    gridLayer.clearLayers();
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    // Escolhe um espaçamento de grade (em metros) adequado ao nível de zoom.
    const spacing = zoom >= 16 ? 100 : zoom >= 13 ? 500 : zoom >= 10 ? 2000 : 10000;

    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const centerLat = (sw.lat + ne.lat) / 2;
    const centerLon = (sw.lng + ne.lng) / 2;
    const utmCenter = Coordinates.toUTM(centerLat, centerLon, datum || 'SIRGAS2000');
    const zone = utmCenter.zone;
    const isSouth = centerLat < 0;

    const utmSW = Coordinates.toUTM(sw.lat, sw.lng, datum || 'SIRGAS2000', zone);
    const utmNE = Coordinates.toUTM(ne.lat, ne.lng, datum || 'SIRGAS2000', zone);

    const eStart = Math.floor(utmSW.easting / spacing) * spacing;
    const eEnd = Math.ceil(utmNE.easting / spacing) * spacing;
    const nStart = Math.floor(utmSW.northing / spacing) * spacing;
    const nEnd = Math.ceil(utmNE.northing / spacing) * spacing;

    const style = { color: '#ffb300', weight: 1, opacity: 0.6, interactive: false, dashArray: '4,4' };

    for (let e = eStart; e <= eEnd; e += spacing) {
      const p1 = Coordinates.fromUTM(e, utmSW.northing - spacing, zone, isSouth, datum || 'SIRGAS2000');
      const p2 = Coordinates.fromUTM(e, utmNE.northing + spacing, zone, isSouth, datum || 'SIRGAS2000');
      L.polyline([[p1.lat, p1.lon], [p2.lat, p2.lon]], style).addTo(gridLayer);
      L.marker([p2.lat, p2.lon], { icon: L.divIcon({ className: 'fg-grid-label', html: `${Math.round(e)}mE`, iconSize: [0, 0] }), interactive: false }).addTo(gridLayer);
    }
    for (let n = nStart; n <= nEnd; n += spacing) {
      const p1 = Coordinates.fromUTM(utmSW.easting - spacing, n, zone, isSouth, datum || 'SIRGAS2000');
      const p2 = Coordinates.fromUTM(utmNE.easting + spacing, n, zone, isSouth, datum || 'SIRGAS2000');
      L.polyline([[p1.lat, p1.lon], [p2.lat, p2.lon]], style).addTo(gridLayer);
      L.marker([p1.lat, p1.lon], { icon: L.divIcon({ className: 'fg-grid-label', html: `${Math.round(n)}mN`, iconSize: [0, 0] }), interactive: false }).addTo(gridLayer);
    }
  }

  window.MapModule = MapModule;
})();
