/**
 * app.js
 * -----------------------------------------------------------------------
 * Controlador principal do FieldGIS: inicializa os módulos, monta a
 * interface, gerencia o projeto ativo e conecta os eventos da UI às
 * funções dos módulos especializados (map.js, gps.js, points.js, etc).
 */

(function () {
  // Mantenha este número igual ao sufixo de CACHE_NAME em service-worker.js.
  // Serve só para conferência visual (tela "Sobre") — ajuda a confirmar se
  // o app instalado na Tela de Início já está na versão mais recente depois
  // de uma atualização, sem precisar adivinhar.
  const APP_BUILD_VERSION = 'v28';

  const $ = (id) => document.getElementById(id);
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  let settings = null;
  let currentProjectId = null;
  let map = null;

  // Grupos de camadas Leaflet em memória, indexados pelo id da camada (DB)
  const layerGroups = {}; // layerId -> L.LayerGroup (pontos/trilhas/polígonos)
  const rasterOverlays = {}; // layerId -> L.ImageOverlay
  const objectUrls = []; // para revogar ao trocar de projeto

  let pointDraft = null; // ponto sendo criado/editado
  let activeFormFields = [];
  let drawMode = null; // 'track' | 'polygon' | 'measure-distance' | 'measure-area' | null
  let toastTimer = null;

  // =======================================================================
  // Utilidades de UI
  // =======================================================================
  function openSheet(id) {
    $(id).hidden = false;
  }
  function closeSheet(id) {
    $(id).hidden = true;
  }
  function toast(msg, ms = 2800) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('fg-hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('fg-hidden'), ms);
  }
  function confirmDialog(message) {
    return window.confirm(message);
  }
  function promptDialog(message, defaultValue) {
    return window.prompt(message, defaultValue || '');
  }

  function revokeObjectUrls() {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls.length = 0;
  }

  // =======================================================================
  // Inicialização
  // =======================================================================
  async function boot() {
    try {
      settings = await DB.getSettings();
    } catch (e) {
      toast('Não foi possível iniciar o banco de dados local: ' + e.message);
      return;
    }

    map = MapModule.init('map', settings);
    MapModule.toggleGrid(settings.map.showGrid, settings.coords.datum);
    MapModule.onCursorMove(() => {}); // reservado para exibir coordenada do cursor (desktop)

    Offline.init();
    Offline.requestPersistentStorage();

    wireTopBar();
    wireBottomNav();
    wireOverlaysGeneric();
    wireLocate();
    wireGPS();
    wireAddMenu();
    wireProjectsUI();
    wireLayersUI();
    wirePointForm();
    wireSaveGeomUI();
    wireImportUI();
    wireExportUI();
    wireBackupUI();
    wireFormsUI();
    wireSettingsUI();
    wireSearchUI();
    wireFieldMode();
    wireNavigationUI();

    const lastProject = Projects.getCurrent();
    if (lastProject && (await Projects.get(lastProject))) {
      await loadProject(lastProject);
    } else {
      openSheet('overlay-projects');
      await refreshProjectsList();
    }

    const warning = await Offline.checkStorageWarning();
    if (warning) toast(warning, 5000);
  }

  // =======================================================================
  // Projeto ativo
  // =======================================================================
  async function loadProject(projectId) {
    currentProjectId = projectId;
    Projects.setCurrent(projectId);
    const project = await Projects.get(projectId);
    if (!project) return;

    $('fg-project-name').textContent = project.name;
    await refreshProjectHeader();

    // Fecha a tela de projetos JÁ (antes de renderizar as camadas), para o
    // usuário ver o mapa do projeto carregando na hora, em vez de esperar
    // atrás de uma tela fechada até tudo terminar.
    closeSheet('overlay-projects');

    if (drawMode === 'identify') stopIdentifyMode();

    // Limpa camadas anteriores do mapa
    Object.values(layerGroups).forEach((lg) => map.hasLayer(lg) && map.removeLayer(lg));
    Object.values(rasterOverlays).forEach((ov) => map.hasLayer(ov) && map.removeLayer(ov));
    Object.keys(layerGroups).forEach((k) => delete layerGroups[k]);
    Object.keys(rasterOverlays).forEach((k) => delete rasterOverlays[k]);
    revokeObjectUrls();

    const layers = await Layers.list(projectId);
    for (const layer of layers) {
      await renderLayer(layer);
    }

    await fitProjectBounds(projectId);
    toast(`Projeto "${project.name}" carregado.`);
  }

  async function renderLayer(layer) {
    if (layer.kind === 'raster') {
      const mapRecord = (await DB.byProject('maps', layer.projectId)).find((m) => m.layerId === layer.id);
      if (!mapRecord) return;
      const blobRec = await DB.get('blobs', mapRecord.blobKey);
      if (!blobRec) return;
      const url = URL.createObjectURL(blobRec.blob);
      objectUrls.push(url);
      const overlay = L.imageOverlay(url, mapRecord.bounds, { opacity: layer.opacity, className: 'fg-raster-layer' });
      rasterOverlays[layer.id] = overlay;
      if (layer.visible) overlay.addTo(map);
      return;
    }

    const group = L.layerGroup();
    layerGroups[layer.id] = group;
    if (layer.visible) group.addTo(map);

    if (layer.kind === 'points') {
      const points = await DB.byIndex('points', 'layerId', layer.id);
      points.forEach((p) => Points.renderToLayerGroup(p, group, openPointInfo));
    } else if (layer.kind === 'tracks') {
      const tracks = await DB.byIndex('tracks', 'layerId', layer.id);
      tracks.forEach((t) => Tracks.renderToLayerGroup(t, group, { color: layer.color, weight: layer.weight }));
    } else if (layer.kind === 'polygons') {
      const polygons = await DB.byIndex('polygons', 'layerId', layer.id);
      polygons.forEach((pg) => Polygons.renderToLayerGroup(pg, group, { color: layer.color, weight: layer.weight }));
    }
  }

  async function refreshProjectHeader() {
    if (!currentProjectId) return;
    const summary = await Projects.summary(currentProjectId);
    $('fg-project-sub').textContent = `${summary.points} pontos · ${summary.tracks} trilhas · ${summary.polygons} polígonos`;
  }

  async function fitProjectBounds(projectId) {
    // Quando o projeto tem mapa(s)/PDF importado(s) MARCADOS COMO VISÍVEIS
    // (controlado em Menu > Camadas), eles são o documento de referência
    // atual — sempre carregam ocupando a tela toda. Usar só os visíveis (em
    // vez de todos os já salvos, ou tentar adivinhar "o mais recente") dá
    // controle direto ao usuário: PDFs antigos de teste que ele ocultar não
    // entram mais no cálculo do zoom.
    const layers = await Layers.list(projectId);
    const rasterVisiveis = layers.filter((l) => l.kind === 'raster' && l.visible);
    if (rasterVisiveis.length) {
      const maps = await DB.byProject('maps', projectId);
      const boundsRaster = [];
      rasterVisiveis.forEach((rl) => {
        const m = maps.find((mm) => mm.layerId === rl.id);
        if (m && m.bounds) {
          boundsRaster.push(m.bounds[0]);
          boundsRaster.push(m.bounds[1]);
        }
      });
      if (boundsRaster.length) {
        MapModule.fitBounds(boundsRaster);
        return;
      }
    }

    const bounds = [];

    const points = await DB.byProject('points', projectId);
    points.forEach((p) => bounds.push([p.lat, p.lon]));

    const tracks = await DB.byProject('tracks', projectId);
    tracks.forEach((t) => (t.points || []).forEach((p) => bounds.push([p.lat, p.lon])));

    const polygons = await DB.byProject('polygons', projectId);
    polygons.forEach((pol) => (pol.vertices || []).forEach((v) => bounds.push([v.lat, v.lon])));

    if (bounds.length) {
      MapModule.fitBounds(bounds);
    }
  }

  async function refreshCurrentLayerOnMap(kind) {
    // Recarrega todas as camadas do tipo informado (usado após salvar um novo item)
    const layers = (await Layers.list(currentProjectId)).filter((l) => l.kind === kind);
    for (const layer of layers) {
      if (layerGroups[layer.id]) {
        map.removeLayer(layerGroups[layer.id]);
        delete layerGroups[layer.id];
      }
      await renderLayer(layer);
    }
  }

  async function getOrCreateDefaultLayer(kind) {
    const layers = (await Layers.list(currentProjectId)).filter((l) => l.kind === kind);
    if (layers.length) return layers[0];
    const names = { points: 'Pontos de coleta', tracks: 'Trilhas', polygons: 'Polígonos', raster: 'Mapa importado' };
    return Layers.create(currentProjectId, names[kind] || kind, kind);
  }

  // =======================================================================
  // Topo / menus
  // =======================================================================
  function wireTopBar() {
    $('btn-menu').onclick = () => openSheet('overlay-menu');
    $('btn-search').onclick = () => openSheet('search-overlay') || ($('search-overlay').hidden = false, $('search-input').focus());
  }

  function isStandaloneApp() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true // Safari/iOS
    );
  }

  function isIOSDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  async function handleFullscreenRequest() {
    if (isStandaloneApp()) {
      toast('Você já está usando o app instalado em tela cheia. ✅');
      return;
    }

    // Fullscreen API funciona em Android/Chrome/Desktop, mas o Safari no
    // iPhone NÃO oferece essa API para páginas comuns — só é possível remover
    // a barra de endereço instalando o app na Tela de Início.
    if (document.documentElement.requestFullscreen && !isIOSDevice()) {
      try {
        await document.documentElement.requestFullscreen();
        return;
      } catch (e) {
        // segue para as instruções manuais abaixo
      }
    }

    if (isIOSDevice()) {
      alert(
        'Para usar o FieldGIS em tela cheia no iPhone (sem a barra do Safari):\n\n' +
        '1. Toque no ícone de compartilhar (o quadrado com uma seta ↑) na barra do navegador.\n' +
        '2. Escolha "Adicionar à Tela de Início".\n' +
        '3. Toque em "Adicionar".\n\n' +
        'Depois disso, abra o FieldGIS sempre pelo ícone criado na tela do seu iPhone — ele abrirá sem a barra de endereço, ocupando a tela inteira.'
      );
    } else {
      alert(
        'Para usar o FieldGIS em tela cheia:\n\n' +
        '1. Abra o menu do navegador (⋮ ou ≡).\n' +
        '2. Escolha "Adicionar à tela inicial" ou "Instalar aplicativo".\n\n' +
        'Depois disso, abra o FieldGIS sempre pelo ícone criado — ele abrirá sem a barra de endereço, ocupando a tela inteira.'
      );
    }
  }


  function wireOverlaysGeneric() {
    qsa('[data-close]').forEach((btn) => {
      btn.onclick = () => closeSheet(btn.getAttribute('data-close'));
    });
    qsa('.fg-overlay').forEach((ov) => {
      ov.addEventListener('click', (e) => {
        if (e.target === ov) ov.hidden = true;
      });
    });

    $('menu-projects').onclick = async () => {
      closeSheet('overlay-menu');
      openSheet('overlay-projects');
      await refreshProjectsList();
    };
    $('menu-layers').onclick = async () => {
      closeSheet('overlay-menu');
      openSheet('overlay-layers');
      await refreshLayersList();
      atualizarSeletorBasemap();
    };
    $('menu-import').onclick = () => {
      closeSheet('overlay-menu');
      openSheet('overlay-import');
    };
    $('menu-export').onclick = () => {
      closeSheet('overlay-menu');
      openSheet('overlay-export');
      renderExportBody();
    };
    $('menu-backup').onclick = () => {
      closeSheet('overlay-menu');
      openSheet('overlay-backup');
      renderBackupBody();
    };
    $('menu-forms').onclick = async () => {
      closeSheet('overlay-menu');
      openSheet('overlay-forms');
      await renderFormsBody();
    };
    $('menu-settings').onclick = () => {
      closeSheet('overlay-menu');
      openSheet('overlay-settings');
      renderSettingsBody();
    };
    $('menu-field-mode').onclick = () => {
      closeSheet('overlay-menu');
      $('field-panel').hidden = false;
      document.body.classList.add('fg-field-mode');
    };
    $('menu-fullscreen').onclick = () => {
      closeSheet('overlay-menu');
      handleFullscreenRequest();
    };
    $('menu-about').onclick = () => {
      closeSheet('overlay-menu');
      openSheet('overlay-about');
      const el = $('about-version');
      if (el) el.textContent = `Versão de build: ${APP_BUILD_VERSION} — Identidade visual e código próprios.`;
    };
  }

  // =======================================================================
  // Menu inferior
  // =======================================================================
  function wireBottomNav() {
    $('nav-point').onclick = () => handleNewPoint();
    $('nav-add').onclick = () => openSheet('overlay-add');
    $('nav-compass').onclick = () => handleNavigateRequest();
    $('nav-measure').onclick = () => handleMeasureRequest();
    $('nav-track').onclick = () => handleTrackToggle();
  }

  function wireAddMenu() {
    $('action-new-point').onclick = () => {
      closeSheet('overlay-add');
      handleNewPoint();
    };
    $('action-identify').onclick = () => {
      closeSheet('overlay-add');
      handleIdentifyRequest();
    };
    $('action-new-polygon-manual').onclick = () => {
      closeSheet('overlay-add');
      startPolygonDrawing('manual');
    };
    $('action-new-polygon-gps').onclick = () => {
      closeSheet('overlay-add');
      startPolygonDrawing('gps');
    };
    $('action-import').onclick = () => {
      closeSheet('overlay-add');
      openSheet('overlay-import');
    };
  }

  // =======================================================================
  // GPS / badge / localizar
  // =======================================================================
  let seguindoGPS = false; // modo "seguir": recentraliza a cada atualização de posição (ver wireLocate)

  function wireGPS() {
    GPS.on((event, data) => {
      if (event === 'position') {
        updateGpsBadge(data);
        updateFieldModeTiles(data);
        // A seta do marcador nunca gira — ela fica sempre travada apontando
        // pra cima da tela. Quando a bússola está ativa, é o MAPA (ver
        // wireCompass) que gira para acompanhar o rumo, não a seta.
        MapModule.updatePosition(data.lat, data.lon, data.accuracy);

        // Modo "seguir" ativo (mira verde): recentraliza a cada atualização,
        // mantendo o cursor sempre visível — sem isso, o mapa fica parado
        // no lugar onde foi centralizado da última vez, e o cursor vai se
        // deslocando conforme você anda até sair da tela.
        if (seguindoGPS) {
          MapModule.followPosition(data.lat, data.lon);
        }
      } else if (event === 'error') {
        $('gps-status-text').textContent = 'GPS indisponível';
        $('gps-dot').className = 'fg-dot unknown';
      }
    });
    GPS.start();

    $('gps-badge').onclick = () => {
      openSheet('overlay-gps-detail');
      renderGpsDetail();
    };

    wireGpsCoordFormatToggle();
    wireCompass();
  }

  function wireCompass() {
    const btn = $('btn-compass');
    if (!btn) return;

    if (!Compass.isSupported()) {
      btn.hidden = true;
      return;
    }

    Compass.on((event, data) => {
      if (event === 'heading') {
        // O MAPA inteiro (tiles + PDFs importados + pontos/trilhas/polígonos)
        // gira para acompanhar o rumo da bússola, mantendo o Norte do mapa e
        // do PDF sempre alinhados com o Norte real. A seta fica travada
        // apontando pra cima da tela — é o mundo que gira ao redor dela.
        MapModule.setMapRotation(data.heading);
        const label = $('compass-heading-label');
        if (label) label.textContent = Math.round(data.heading) + '°';
      } else if (event === 'timeout') {
        const label = $('compass-heading-label');
        if (label) label.textContent = '⚠️';
        if (data.rawEventCount === 0) {
          toast(
            'A bússola não está enviando nenhum dado. No iPhone, confira: Ajustes > Safari > "Acesso a Movimento e Orientação" (deve estar ativado) — e reabra o app depois de mudar.',
            6000
          );
        } else {
          toast(
            'O sensor de orientação respondeu, mas sem rumo de bússola utilizável. Tente girar o celular em forma de "8" para calibrar o magnetômetro, longe de metais/ímãs.',
            6000
          );
        }
      }
    });

    btn.onclick = async () => {
      if (Compass.isActive()) {
        Compass.stop();
        MapModule.setRotationEnabled(false);
        btn.classList.remove('active');
        const label = $('compass-heading-label');
        if (label) label.textContent = '';
        await DB.saveSettings({ gps: Object.assign({}, settings.gps, { useCompass: false }) });
        settings.gps.useCompass = false;
        toast('Bússola desativada — mapa e PDFs voltam ao Norte fixo pra cima.');
        return;
      }

      const permitido = await Compass.requestPermission();
      if (!permitido) {
        toast('Permissão da bússola negada. Em iPhone: Ajustes > Safari > Localização e Movimento e Orientação.', 4500);
        return;
      }
      MapModule.setRotationEnabled(true);
      Compass.start();
      btn.classList.add('active');
      await DB.saveSettings({ gps: Object.assign({}, settings.gps, { useCompass: true }) });
      settings.gps.useCompass = true;
      toast('Bússola ativada — o mapa e os PDFs agora giram acompanhando o Norte real. A seta fica travada apontando pra cima da tela. Se oscilar, gire o aparelho em forma de "8" para calibrar o sensor.', 4500);
    };

    // Em Android (e navegadores que não exigem toque para autorizar o
    // sensor), retoma automaticamente se o usuário já tinha deixado
    // ativado da última vez. No iOS isso não é possível — a permissão
    // exige um toque a cada nova sessão, então o botão fica pronto pra
    // ativar com um toque só.
    if (settings.gps.useCompass && !Compass.needsExplicitPermission()) {
      MapModule.setRotationEnabled(true);
      Compass.start();
      btn.classList.add('active');
    }
  }

  function updateGpsBadge(data) {
    $('gps-dot').className = 'fg-dot ' + data.quality;
    const labels = { excellent: 'GPS Excelente', good: 'GPS Bom', moderate: 'GPS Moderado', weak: 'GPS Fraco', unknown: 'GPS indisponível' };
    $('gps-status-text').textContent = labels[data.quality] || 'GPS';
    if (settings.coords.format === 'utm') {
      const utm = Coordinates.toUTM(data.lat, data.lon, settings.coords.datum);
      $('gps-coord-text').textContent = `${utm.easting.toFixed(2)}E  ${utm.northing.toFixed(2)}N  ${utm.label}`;
    } else {
      $('gps-coord-text').textContent = `${Coordinates.formatLat(data.lat, settings.coords.format)}  ${Coordinates.formatLon(data.lon, settings.coords.format)}`;
    }
  }

  const ORDEM_FORMATOS_COORD = ['dms', 'utm', 'dd'];
  const NOMES_FORMATOS_COORD = { dms: 'Graus, minutos e segundos (GMS)', utm: 'UTM', dd: 'Graus decimais' };

  function wireGpsCoordFormatToggle() {
    const el = $('gps-coord-text');
    if (!el) return;
    el.title = 'Toque para trocar o formato de coordenadas';
    el.onclick = async (e) => {
      e.stopPropagation(); // não abre o painel de detalhes do GPS, só troca o formato
      const atual = ORDEM_FORMATOS_COORD.indexOf(settings.coords.format);
      const proximo = ORDEM_FORMATOS_COORD[(atual === -1 ? 0 : atual + 1) % ORDEM_FORMATOS_COORD.length];
      settings = await DB.saveSettings({ coords: Object.assign({}, settings.coords, { format: proximo }) });
      const pos = GPS.getLastPosition();
      if (pos) {
        updateGpsBadge({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          quality: GPS.classifyQuality(pos.coords.accuracy),
        });
      }
      toast(`Formato de coordenadas: ${NOMES_FORMATOS_COORD[proximo]}`);
    };
  }

  function renderGpsDetail() {
    const pos = GPS.getLastPosition();
    const body = $('gps-detail-body');
    if (!pos) {
      body.innerHTML = '<p class="fg-empty">Aguardando sinal de GPS...</p>';
      return;
    }
    const c = pos.coords;
    const utm = Coordinates.toUTM(c.latitude, c.longitude, settings.coords.datum);
    body.innerHTML = `
      <div class="fg-coord-grid">
        <div class="fg-coord-box"><div class="k">Latitude</div><div class="v">${Coordinates.formatLat(c.latitude, settings.coords.format)}</div></div>
        <div class="fg-coord-box"><div class="k">Longitude</div><div class="v">${Coordinates.formatLon(c.longitude, settings.coords.format)}</div></div>
        <div class="fg-coord-box"><div class="k">UTM Leste (E)</div><div class="v">${utm.easting.toFixed(2)}</div></div>
        <div class="fg-coord-box"><div class="k">UTM Norte (N)</div><div class="v">${utm.northing.toFixed(2)}</div></div>
        <div class="fg-coord-box"><div class="k">Zona / Datum</div><div class="v">${utm.label} · ${settings.coords.datum}</div></div>
        <div class="fg-coord-box"><div class="k">Altitude</div><div class="v">${c.altitude != null ? c.altitude.toFixed(1) + ' m' : '—'}</div></div>
        <div class="fg-coord-box"><div class="k">Precisão</div><div class="v">± ${c.accuracy != null ? c.accuracy.toFixed(1) : '—'} m</div></div>
        <div class="fg-coord-box"><div class="k">Velocidade</div><div class="v">${c.speed != null ? (c.speed * 3.6).toFixed(1) + ' km/h' : '—'}</div></div>
        <div class="fg-coord-box"><div class="k">Direção</div><div class="v">${c.heading != null && !Number.isNaN(c.heading) ? Math.round(c.heading) + '° ' + Coordinates.azimuthToCardinal(c.heading) : '—'}</div></div>
        <div class="fg-coord-box"><div class="k">Bússola do aparelho</div><div class="v">${Compass.isActive() ? '🧭 Ativa' : 'Desativada'}</div></div>
        <div class="fg-coord-box"><div class="k">Última leitura</div><div class="v">${new Date(pos.timestamp).toLocaleTimeString('pt-BR')}</div></div>
        <div class="fg-coord-box"><div class="k">Distância percorrida</div><div class="v">${(GPS.getTotalDistance() / 1000).toFixed(3)} km</div></div>
      </div>`;
  }

  function wireLocate() {
    $('btn-locate').onclick = () => {
      const pos = GPS.getLastPosition();
      if (!pos) {
        toast('Aguardando sinal de GPS...');
        GPS.start();
        return;
      }
      MapModule.centerOnPosition(pos.coords.latitude, pos.coords.longitude);
      seguindoGPS = true;
      $('btn-locate').classList.add('centered');
    };

    // 'dragstart' só dispara em arraste manual de verdade (dedo/mouse do
    // usuário) — recentralizações programáticas via setView/panTo (ex.: o
    // próprio botão de localizar, ou o modo "seguir" a cada atualização de
    // posição) não disparam esse evento, então não há conflito nem loop.
    map.on('dragstart', () => {
      seguindoGPS = false;
      $('btn-locate').classList.remove('centered');
    });
  }

  // =======================================================================
  // Pontos
  // =======================================================================
  async function handleNewPoint() {
    if (!requireProject()) return;
    try {
      toast('Obtendo posição GPS...');
      pointDraft = await Points.captureDraft(currentProjectId);
      pointDraft.id = DB.uuid();
      await openPointForm(pointDraft, true);
    } catch (e) {
      toast(e.message);
    }
  }

  async function openPointForm(point, isNew) {
    $('point-form-title').textContent = isNew ? 'Novo Ponto' : 'Editar Ponto';
    const info = Points.formatPointInfo(point, settings);
    $('point-form-coords').innerHTML = `
      <div class="fg-coord-box"><div class="k">Latitude</div><div class="v">${info.latText}</div></div>
      <div class="fg-coord-box"><div class="k">Longitude</div><div class="v">${info.lonText}</div></div>
      <div class="fg-coord-box"><div class="k">UTM</div><div class="v">${info.utm.easting.toFixed(1)} / ${info.utm.northing.toFixed(1)} (${info.utm.label})</div></div>
      <div class="fg-coord-box"><div class="k">Altitude / Precisão</div><div class="v">${point.alt != null ? point.alt.toFixed(1) + ' m' : '—'} · ±${point.accuracy != null ? point.accuracy.toFixed(1) : '—'} m</div></div>`;
    $('point-name').value = point.name || '';
    $('point-code').value = point.code || '';
    $('point-description').value = point.description || '';

    const forms = await Projects.listForms(currentProjectId);
    activeFormFields = forms.length ? forms[0].fields : [];
    $('point-attributes-container').innerHTML = renderAttributeFields(activeFormFields, point.attributes || {});

    await renderPointPhotos(point);

    openSheet('overlay-point-form');
  }

  function renderAttributeFields(fields, values) {
    if (!fields.length) return '';
    return fields
      .map((f) => {
        const val = values[f.key] ?? '';
        if (f.type === 'selecao') {
          const opts = (f.options || '').split(',').map((o) => o.trim());
          return `<label>${f.label}</label><select data-attr-key="${f.key}">${opts.map((o) => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
        }
        if (f.type === 'checkbox') {
          return `<label style="display:flex;align-items:center;gap:8px;margin-top:14px"><input type="checkbox" data-attr-key="${f.key}" style="width:auto" ${val ? 'checked' : ''}/> ${f.label}</label>`;
        }
        const typeMap = { texto: 'text', numero: 'number', decimal: 'number', data: 'date', hora: 'time' };
        return `<label>${f.label}</label><input type="${typeMap[f.type] || 'text'}" ${f.type === 'decimal' ? 'step="any"' : ''} data-attr-key="${f.key}" value="${val}"/>`;
      })
      .join('');
  }

  function collectAttributeValues(fields) {
    const values = {};
    fields.forEach((f) => {
      const el = qs(`[data-attr-key="${f.key}"]`, $('point-attributes-container'));
      if (!el) return;
      values[f.key] = f.type === 'checkbox' ? el.checked : el.value;
    });
    return values;
  }

  async function renderPointPhotos(point) {
    const container = $('point-photos');
    container.innerHTML = '';
    const photos = point.id ? await Points.getPhotos(point.id) : [];
    photos.forEach((ph) => {
      const url = URL.createObjectURL(ph.blob);
      objectUrls.push(url);
      const div = document.createElement('div');
      div.className = 'fg-photo-thumb';
      div.innerHTML = `<img src="${url}"/>`;
      container.appendChild(div);
    });
  }

  function wirePointForm() {
    $('btn-point-photo').onclick = async () => {
      if (!pointDraft) return;
      try {
        const file = await Camera.captureViaInput();
        const info = Points.formatPointInfo(pointDraft, settings);
        let blob = file;
        if (settings.watermark) {
          blob = await Camera.applyWatermark(file, {
            pointName: pointDraft.name,
            latText: info.latText,
            lonText: info.lonText,
            altitude: pointDraft.alt,
            dateText: new Date().toLocaleDateString('pt-BR'),
            timeText: new Date().toLocaleTimeString('pt-BR'),
          });
        }
        await Points.addPhoto(pointDraft.id, currentProjectId, blob, { lat: pointDraft.lat, lon: pointDraft.lon, alt: pointDraft.alt });
        await renderPointPhotos(pointDraft);
        toast('Fotografia adicionada.');
      } catch (e) {
        toast(e.message);
      }
    };

    $('btn-point-save').onclick = async () => {
      if (!pointDraft) return;
      pointDraft.name = $('point-name').value.trim() || pointDraft.name;
      pointDraft.code = $('point-code').value.trim();
      pointDraft.description = $('point-description').value.trim();
      pointDraft.attributes = collectAttributeValues(activeFormFields);
      const layer = await getOrCreateDefaultLayer('points');
      await Points.save(pointDraft, layer.id);
      closeSheet('overlay-point-form');
      pointDraft = null;
      await refreshCurrentLayerOnMap('points');
      refreshProjectHeader();
      toast('Ponto salvo com sucesso.');
    };
  }

  async function openPointInfo(point) {
    $('point-info-title').textContent = point.name || point.code || 'Ponto';
    const info = Points.formatPointInfo(point, settings);
    const photos = await Points.getPhotos(point.id);
    const photosHtml = photos
      .map((ph) => {
        const url = URL.createObjectURL(ph.blob);
        objectUrls.push(url);
        return `<div class="fg-photo-thumb"><img src="${url}"/></div>`;
      })
      .join('');

    $('point-info-body').innerHTML = `
      <div class="fg-coord-grid">
        <div class="fg-coord-box"><div class="k">Latitude</div><div class="v">${info.latText}</div></div>
        <div class="fg-coord-box"><div class="k">Longitude</div><div class="v">${info.lonText}</div></div>
        <div class="fg-coord-box"><div class="k">UTM</div><div class="v">${info.utm.easting.toFixed(1)} / ${info.utm.northing.toFixed(1)}</div></div>
        <div class="fg-coord-box"><div class="k">Zona</div><div class="v">${info.utm.label}</div></div>
        <div class="fg-coord-box"><div class="k">Altitude</div><div class="v">${point.alt != null ? point.alt.toFixed(1) + ' m' : '—'}</div></div>
        <div class="fg-coord-box"><div class="k">Precisão</div><div class="v">± ${point.accuracy != null ? point.accuracy.toFixed(1) : '—'} m</div></div>
      </div>
      <p><b>Descrição:</b> ${point.description || '<i>Sem descrição</i>'}</p>
      ${Object.keys(point.attributes || {}).length ? '<p><b>Atributos:</b><br>' + Object.entries(point.attributes).map(([k, v]) => `${k}: ${v}`).join('<br>') + '</p>' : ''}
      <div class="fg-photo-grid">${photosHtml}</div>
      <div class="fg-btn-row">
        <button class="fg-btn" id="pi-btn-photo">📷 Foto</button>
        <button class="fg-btn" id="pi-btn-edit">✏️ Editar</button>
      </div>
      <div class="fg-btn-row">
        <button class="fg-btn primary" id="pi-btn-navigate">🧭 Navegar</button>
        <button class="fg-btn danger" id="pi-btn-delete">🗑️ Excluir</button>
      </div>`;

    $('pi-btn-photo').onclick = async () => {
      try {
        const file = await Camera.captureViaInput();
        let blob = file;
        const info2 = Points.formatPointInfo(point, settings);
        if (settings.watermark) {
          blob = await Camera.applyWatermark(file, { pointName: point.name, latText: info2.latText, lonText: info2.lonText, altitude: point.alt, dateText: new Date().toLocaleDateString('pt-BR'), timeText: new Date().toLocaleTimeString('pt-BR') });
        }
        await Points.addPhoto(point.id, currentProjectId, blob, { lat: point.lat, lon: point.lon, alt: point.alt });
        await openPointInfo(point);
        toast('Fotografia adicionada.');
      } catch (e) {
        toast(e.message);
      }
    };
    $('pi-btn-edit').onclick = () => {
      pointDraft = point;
      closeSheet('overlay-point-info');
      openPointForm(point, false);
    };
    $('pi-btn-navigate').onclick = () => {
      closeSheet('overlay-point-info');
      Navigation.setDestination(point);
      showNavOverlay();
    };
    $('pi-btn-delete').onclick = async () => {
      if (!confirmDialog(`Excluir o ponto "${point.name}"? Esta ação não pode ser desfeita.`)) return;
      await Points.delete(point.id);
      closeSheet('overlay-point-info');
      await refreshCurrentLayerOnMap('points');
      refreshProjectHeader();
      toast('Ponto excluído.');
    };

    openSheet('overlay-point-info');
  }

  // =======================================================================
  // Trilhas
  // =======================================================================
  function handleTrackToggle() {
    if (!requireProject()) return;
    const state = Tracks.getState();
    if (state === 'idle') {
      Tracks.start(null, settings.gps.minAccuracy);
      Tracks.on(updateTrackDrawbar);
      drawMode = 'track';
      renderTrackDrawbar();
      $('drawbar').hidden = false;
      $('nav-track').classList.add('record');

      // Ativa o modo "seguir" automaticamente ao começar a gravar — assim o
      // cursor não sai da tela conforme você se desloca durante a trilha.
      const pos = GPS.getLastPosition();
      if (pos) {
        MapModule.centerOnPosition(pos.coords.latitude, pos.coords.longitude);
        seguindoGPS = true;
        $('btn-locate').classList.add('centered');
      }
    }
  }

  function updateTrackDrawbar() {
    if (drawMode === 'track') renderTrackDrawbar();
  }

  function renderTrackDrawbar() {
    const state = Tracks.getState();
    const stats = Tracks.getCurrentStats() || { distance: 0, avgSpeed: 0, duration: 0 };
    $('drawbar-stats').innerHTML = `
      <div class="stat"><span class="k">Distância</span><span class="v">${(stats.distance / 1000).toFixed(2)} km</span></div>
      <div class="stat"><span class="k">Tempo</span><span class="v">${Tracks.formatDuration(stats.duration)}</span></div>
      <div class="stat"><span class="k">Vel. média</span><span class="v">${(stats.avgSpeed * 3.6).toFixed(1)} km/h</span></div>`;

    const actions = $('drawbar-actions');
    actions.innerHTML = '';
    if (state === 'recording') {
      actions.appendChild(makeDrawBtn('⏸ Pausar', () => Tracks.pause()));
      actions.appendChild(makeDrawBtn('⏹ Finalizar', () => finishTrack(), 'danger'));
    } else if (state === 'paused') {
      actions.appendChild(makeDrawBtn('▶ Continuar', () => Tracks.resume()));
      actions.appendChild(makeDrawBtn('⏹ Finalizar', () => finishTrack(), 'danger'));
    }
  }

  function makeDrawBtn(label, onClick, cls) {
    const b = document.createElement('button');
    b.className = 'fg-btn' + (cls ? ' ' + cls : ' primary');
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  function finishTrack() {
    const stats = Tracks.getCurrentStats();
    if (!stats || stats.distance < 1) {
      Tracks.discard();
      resetDrawUI();
      toast('Trilha descartada (distância insuficiente).');
      return;
    }
    $('save-geom-title').textContent = 'Salvar Trilha';
    $('save-geom-stats').innerHTML = `
      <div class="fg-coord-box"><div class="k">Distância</div><div class="v">${(stats.distance / 1000).toFixed(2)} km</div></div>
      <div class="fg-coord-box"><div class="k">Duração</div><div class="v">${Tracks.formatDuration(stats.duration)}</div></div>`;
    $('save-geom-name').value = `Trilha ${new Date().toLocaleString('pt-BR')}`;
    pendingSaveType = 'track';
    openSheet('overlay-save-geom');
  }

  let pendingSaveType = null;

  function wireSaveGeomUI() {
    $('btn-save-geom-confirm').onclick = async () => {
      const name = $('save-geom-name').value.trim();
      if (pendingSaveType === 'track') {
        const layer = await getOrCreateDefaultLayer('tracks');
        await Tracks.finish(name, currentProjectId);
        await DB.byProject('tracks', currentProjectId); // no-op ensure store touched
        const tracks = await DB.byProject('tracks', currentProjectId);
        const last = tracks[tracks.length - 1];
        if (last && !last.layerId) {
          last.layerId = layer.id;
          await DB.put('tracks', last);
        }
        await refreshCurrentLayerOnMap('tracks');
        refreshProjectHeader();
        toast('Trilha salva.');
      } else if (pendingSaveType === 'polygon') {
        const layer = await getOrCreateDefaultLayer('polygons');
        await Polygons.save(name, currentProjectId, layer.id);
        await refreshCurrentLayerOnMap('polygons');
        refreshProjectHeader();
        toast('Polígono salvo.');
      }
      closeSheet('overlay-save-geom');
      resetDrawUI();
    };
  }

  function resetDrawUI() {
    drawMode = null;
    $('drawbar').hidden = true;
    $('nav-track').classList.remove('record');
  }

  // =======================================================================
  // Polígonos / Medição
  // =======================================================================
  function startPolygonDrawing(kind) {
    if (!requireProject()) return;
    drawMode = 'polygon';
    if (kind === 'manual') Polygons.startManual();
    else Polygons.startGPSWalk(settings.gps.minDistance || 3, settings.gps.minAccuracy);

    Polygons.onChange(renderPolygonDrawbar);
    renderPolygonDrawbar({ area: 0, perimeter: 0, vertexCount: 0 });
    $('drawbar').hidden = false;
  }

  function renderPolygonDrawbar(stats) {
    $('drawbar-stats').innerHTML = `
      <div class="stat"><span class="k">Área</span><span class="v">${Coordinates.convertArea(stats.area, 'ha').toFixed(4)} ha</span></div>
      <div class="stat"><span class="k">Perímetro</span><span class="v">${stats.perimeter.toFixed(1)} m</span></div>
      <div class="stat"><span class="k">Vértices</span><span class="v">${stats.vertexCount}</span></div>`;
    const actions = $('drawbar-actions');
    actions.innerHTML = '';
    actions.appendChild(makeDrawBtn('↩ Desfazer', () => Polygons.undoLastVertex()));
    actions.appendChild(makeDrawBtn('✔ Concluir', () => finishPolygon(), 'success'));
    actions.appendChild(makeDrawBtn('✕ Cancelar', () => {
      Polygons.cancel();
      resetDrawUI();
    }, 'danger'));
  }

  function finishPolygon() {
    const stats = Polygons.getStats();
    if (stats.vertexCount < 3) {
      toast('Um polígono precisa de ao menos 3 vértices.');
      return;
    }
    Polygons.finish();
    $('save-geom-title').textContent = 'Salvar Polígono';
    $('save-geom-stats').innerHTML = `
      <div class="fg-coord-box"><div class="k">Área</div><div class="v">${Coordinates.convertArea(stats.area, 'ha').toFixed(4)} ha</div></div>
      <div class="fg-coord-box"><div class="k">Perímetro</div><div class="v">${stats.perimeter.toFixed(1)} m</div></div>`;
    $('save-geom-name').value = `Polígono ${new Date().toLocaleString('pt-BR')}`;
    pendingSaveType = 'polygon';
    openSheet('overlay-save-geom');
  }

  function handleMeasureRequest() {
    if (!requireProject()) return;
    if (drawMode && drawMode.startsWith('measure')) {
      Measure.cancel();
      resetDrawUI();
      return;
    }
    const choice = confirmDialog('Medir ÁREA? (Cancelar = medir distância)');
    drawMode = choice ? 'measure-area' : 'measure-distance';
    if (choice) Measure.startArea();
    else Measure.startDistance();
    Measure.onChange(renderMeasureDrawbar);
    renderMeasureDrawbar(Measure.getResult());
    $('drawbar').hidden = false;
  }

  function renderMeasureDrawbar(result) {
    const isArea = drawMode === 'measure-area';
    $('drawbar-stats').innerHTML = isArea
      ? `<div class="stat"><span class="k">Área</span><span class="v">${Coordinates.convertArea(result.area, settings.units.area).toFixed(4)} ${settings.units.area}</span></div>
         <div class="stat"><span class="k">Perímetro</span><span class="v">${result.perimeter.toFixed(1)} m</span></div>`
      : `<div class="stat"><span class="k">Distância total</span><span class="v">${result.distance.toFixed(1)} m</span></div>
         <div class="stat"><span class="k">Segmentos</span><span class="v">${result.segments ? result.segments.length : 0}</span></div>`;
    const actions = $('drawbar-actions');
    actions.innerHTML = '';
    actions.appendChild(makeDrawBtn('↩ Desfazer', () => Measure.undo()));
    actions.appendChild(makeDrawBtn('✕ Encerrar', () => {
      Measure.cancel();
      resetDrawUI();
    }, 'danger'));
  }

  // =======================================================================
  // Identificar coordenada (toque no mapa)
  // =======================================================================
  let identifyMarker = null;

  function handleIdentifyRequest() {
    if (drawMode === 'identify') {
      stopIdentifyMode();
      return;
    }
    if (drawMode) {
      toast('Termine a ação atual antes de identificar uma coordenada.');
      return;
    }
    drawMode = 'identify';
    map.on('click', handleIdentifyClick);
    $('drawbar-stats').innerHTML = `<div class="stat"><span class="k">Identificar coordenada</span><span class="v">Toque em qualquer ponto do mapa</span></div>`;
    const actions = $('drawbar-actions');
    actions.innerHTML = '';
    actions.appendChild(makeDrawBtn('✕ Encerrar', () => stopIdentifyMode(), 'danger'));
    $('drawbar').hidden = false;

    if (Compass.isActive()) {
      toast('Atenção: com a bússola (rotação do mapa) ativa, o toque pode não corresponder exatamente ao ponto certo. Para identificar com precisão, desligue o 🧭 antes.', 5500);
    }
  }

  function stopIdentifyMode() {
    map.off('click', handleIdentifyClick);
    if (identifyMarker) {
      map.removeLayer(identifyMarker);
      identifyMarker = null;
    }
    resetDrawUI();
  }

  function handleIdentifyClick(e) {
    const { lat, lng } = e.latlng;
    if (identifyMarker) map.removeLayer(identifyMarker);
    identifyMarker = L.circleMarker([lat, lng], {
      radius: 9,
      color: '#ffb300',
      weight: 2,
      fillColor: '#ffb300',
      fillOpacity: 0.35,
      interactive: false,
    }).addTo(map);
    showIdentifyResult(lat, lng);
  }

  function showIdentifyResult(lat, lng) {
    const dms = `${Coordinates.formatLat(lat, 'dms')}  ${Coordinates.formatLon(lng, 'dms')}`;
    const dd = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const utm = Coordinates.toUTM(lat, lng, settings.coords.datum);
    const utmStr = `${utm.easting.toFixed(2)} E   ${utm.northing.toFixed(2)} N   Zona ${utm.label}`;

    $('identify-body').innerHTML = `
      <div class="fg-coord-box" style="margin-bottom:10px">
        <div class="k">GMS (toque para copiar)</div><div class="v" id="id-copy-dms">${dms}</div>
      </div>
      <div class="fg-coord-box" style="margin-bottom:10px">
        <div class="k">Decimal (toque para copiar)</div><div class="v" id="id-copy-dd">${dd}</div>
      </div>
      <div class="fg-coord-box" style="margin-bottom:16px">
        <div class="k">UTM · ${settings.coords.datum} (toque para copiar)</div><div class="v" id="id-copy-utm">${utmStr}</div>
      </div>
      <button class="fg-btn" id="id-copy-all">📋 Copiar tudo (GMS + Decimal + UTM)</button>
      <button class="fg-btn primary" id="id-save-point" style="margin-top:8px">📍 Salvar como ponto</button>`;

    $('id-copy-dms').onclick = () => copiarTextoParaAreaDeTransferencia(dms);
    $('id-copy-dd').onclick = () => copiarTextoParaAreaDeTransferencia(dd);
    $('id-copy-utm').onclick = () => copiarTextoParaAreaDeTransferencia(utmStr);
    $('id-copy-all').onclick = () =>
      copiarTextoParaAreaDeTransferencia(`GMS: ${dms}\nDecimal: ${dd}\nUTM (${settings.coords.datum}): ${utmStr}`);
    $('id-save-point').onclick = async () => {
      if (!requireProject()) return;
      closeSheet('overlay-identify');
      try {
        const draft = await Points.draftAt(currentProjectId, lat, lng);
        draft.id = DB.uuid();
        pointDraft = draft;
        await openPointForm(draft, true);
      } catch (err) {
        toast(err.message);
      }
    };

    openSheet('overlay-identify');
  }

  /** Copia texto para a área de transferência, com fallback para navegadores sem Clipboard API. */
  async function copiarTextoParaAreaDeTransferencia(texto) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(texto);
      } else {
        const ta = document.createElement('textarea');
        ta.value = texto;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast('Copiado.');
    } catch (e) {
      toast('Não foi possível copiar automaticamente — selecione o texto manualmente.');
    }
  }


  // =======================================================================
  // Navegação / bússola
  // =======================================================================
  function wireNavigationUI() {
    $('nav-close').onclick = () => {
      Navigation.clearDestination();
      $('nav-overlay').hidden = true;
    };
    Navigation.on(updateNavOverlay);
  }

  async function handleNavigateRequest() {
    if (!requireProject()) return;
    if (Navigation.getDestination()) {
      showNavOverlay();
      return;
    }
    const points = await Points.listByProject(currentProjectId);
    if (!points.length) {
      toast('Nenhum ponto cadastrado ainda para navegar até.');
      return;
    }
    const names = points.map((p, i) => `${i + 1}. ${p.name || p.code}`).join('\n');
    const answer = promptDialog(`Digite o número do ponto de destino:\n${names}`);
    const idx = parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || !points[idx]) return;
    Navigation.setDestination(points[idx]);
    if (Navigation.isCompassSupported()) {
      try {
        await Navigation.enableCompass();
      } catch (e) {
        toast(e.message);
      }
    }
    showNavOverlay();
  }

  function showNavOverlay() {
    $('nav-overlay').hidden = false;
    updateNavOverlay(Navigation.getState());
  }

  function updateNavOverlay(state) {
    if (!state.destination) {
      $('nav-overlay').hidden = true;
      return;
    }
    $('nav-dest').textContent = 'Destino: ' + (state.destination.name || 'Ponto');
    $('nav-dist').textContent = state.distance != null ? formatDistance(state.distance) : 'Aguardando GPS...';
    $('nav-az').textContent = state.azimuth != null ? `Azimute ${Coordinates.azimuthDMS(state.azimuth)} (${state.cardinal})` : '';
    $('nav-arrow').style.transform = `rotate(${Navigation.getArrowRotation()}deg)`;
  }

  function formatDistance(m) {
    if (settings.units.distance === 'km' || m > 1000) return (m / 1000).toFixed(2) + ' km';
    return m.toFixed(1) + ' m';
  }

  // =======================================================================
  // Camadas
  // =======================================================================
  function wireLayersUI() {}

  function atualizarSeletorBasemap() {
    const container = $('basemap-selector');
    if (!container) return;
    const atual = MapModule.getCurrentBaseLayer();
    qsa('[data-basemap]', container).forEach((btn) => {
      const nome = btn.getAttribute('data-basemap');
      btn.classList.toggle('primary', nome === atual);
      btn.onclick = () => {
        MapModule.setBaseLayer(nome);
        atualizarSeletorBasemap();
      };
    });
  }

  async function refreshLayersList() {
    if (!requireProject()) return;
    const layers = await Layers.list(currentProjectId);
    const container = $('layers-list');
    if (!layers.length) {
      container.innerHTML = '<p class="fg-empty">Nenhuma camada criada.</p>';
      return;
    }
    container.innerHTML = layers
      .map(
        (l) => `
      <div class="fg-layer-item" data-layer-id="${l.id}">
        <span class="fg-layer-color" style="background:${l.color}"></span>
        <div class="fg-switch ${l.visible ? 'on' : ''}" data-action="toggle"></div>
        <span class="fg-layer-name">${Layers.iconFor(l.kind)} ${l.name}</span>
        <input type="range" min="0" max="1" step="0.1" value="${l.opacity}" data-action="opacity"/>
        <button class="fg-icon-btn" style="width:32px;height:32px;font-size:14px" data-action="rename">✏️</button>
        <button class="fg-icon-btn" style="width:32px;height:32px;font-size:14px" data-action="delete">🗑️</button>
      </div>`
      )
      .join('');

    qsa('.fg-layer-item', container).forEach((item) => {
      const layerId = item.getAttribute('data-layer-id');
      qs('[data-action="toggle"]', item).onclick = async (e) => {
        const layer = await DB.get('layers', layerId);
        layer.visible = !layer.visible;
        await Layers.update(layer);
        e.target.classList.toggle('on', layer.visible);
        applyLayerVisibility(layer);
      };
      qs('[data-action="opacity"]', item).oninput = async (e) => {
        const layer = await DB.get('layers', layerId);
        layer.opacity = parseFloat(e.target.value);
        await Layers.update(layer);
        applyLayerOpacity(layer);
      };
      qs('[data-action="rename"]', item).onclick = async () => {
        const layer = await DB.get('layers', layerId);
        const name = promptDialog('Novo nome da camada:', layer.name);
        if (name) {
          layer.name = name;
          await Layers.update(layer);
          refreshLayersList();
        }
      };
      qs('[data-action="delete"]', item).onclick = async () => {
        if (!confirmDialog('Excluir esta camada e todos os elementos nela contidos?')) return;
        await Layers.delete(layerId);
        if (layerGroups[layerId]) {
          map.removeLayer(layerGroups[layerId]);
          delete layerGroups[layerId];
        }
        if (rasterOverlays[layerId]) {
          map.removeLayer(rasterOverlays[layerId]);
          delete rasterOverlays[layerId];
        }
        refreshLayersList();
      };
    });
  }

  function applyLayerVisibility(layer) {
    const target = layerGroups[layer.id] || rasterOverlays[layer.id];
    if (!target) return;
    if (layer.visible) target.addTo(map);
    else map.removeLayer(target);
  }
  function applyLayerOpacity(layer) {
    if (rasterOverlays[layer.id]) rasterOverlays[layer.id].setOpacity(layer.opacity);
    else if (layerGroups[layer.id]) layerGroups[layer.id].eachLayer((l) => l.setStyle && l.setStyle({ opacity: layer.opacity, fillOpacity: layer.opacity * 0.4 }));
  }

  // =======================================================================
  // Projetos
  // =======================================================================
  function requireProject() {
    if (!currentProjectId) {
      toast('Abra ou crie um projeto primeiro.');
      openSheet('overlay-projects');
      return false;
    }
    return true;
  }

  function wireProjectsUI() {
    $('btn-new-project').onclick = () => openSheet('overlay-new-project');
    $('btn-create-project').onclick = async () => {
      const name = $('new-project-name').value.trim();
      if (!name) {
        toast('Informe um nome para o projeto.');
        return;
      }
      const desc = $('new-project-desc').value.trim();
      const project = await Projects.create(name, desc);
      $('new-project-name').value = '';
      $('new-project-desc').value = '';
      closeSheet('overlay-new-project');
      await loadProject(project.id);
    };
  }

  async function refreshProjectsList() {
    const projects = await Projects.list();
    const container = $('projects-list');
    if (!projects.length) {
      container.innerHTML = '<p class="fg-empty">Nenhum projeto ainda. Crie o primeiro projeto para começar.</p>';
      return;
    }
    const rows = await Promise.all(
      projects.map(async (p) => {
        const s = await Projects.summary(p.id);
        return `<div class="fg-list-item" data-project-id="${p.id}">
          <span class="fg-list-icon">📁</span>
          <div class="fg-list-main">
            <div class="fg-list-title">${p.name}</div>
            <div class="fg-list-sub">${s.points} pontos · ${s.tracks} trilhas · ${s.polygons} polígonos · ${s.maps} mapas</div>
          </div>
          <button class="fg-icon-btn" style="width:32px;height:32px;font-size:14px" data-action="rename">✏️</button>
          <button class="fg-icon-btn" style="width:32px;height:32px;font-size:14px" data-action="delete">🗑️</button>
        </div>`;
      })
    );
    container.innerHTML = rows.join('');

    qsa('.fg-list-item', container).forEach((item) => {
      const id = item.getAttribute('data-project-id');
      item.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]')) return;
        loadProject(id);
      });
      qs('[data-action="rename"]', item).onclick = async (e) => {
        e.stopPropagation();
        const project = await Projects.get(id);
        const name = promptDialog('Novo nome do projeto:', project.name);
        if (name) {
          await Projects.rename(id, name);
          refreshProjectsList();
          if (id === currentProjectId) $('fg-project-name').textContent = name;
        }
      };
      qs('[data-action="delete"]', item).onclick = async (e) => {
        e.stopPropagation();
        if (!confirmDialog('Excluir este projeto e TODOS os seus dados (pontos, trilhas, polígonos, fotos, mapas)? Esta ação não pode ser desfeita.')) return;
        await Projects.remove(id);
        if (id === currentProjectId) {
          currentProjectId = null;
          location.reload();
        }
        refreshProjectsList();
      };
    });
  }

  // =======================================================================
  // Formulários de atributos
  // =======================================================================
  async function renderFormsBody() {
    if (!requireProject()) return;
    const body = $('forms-body');
    let forms = await Projects.listForms(currentProjectId);
    let form = forms[0];
    if (!form) {
      form = await Projects.createForm(currentProjectId, 'Padrão', []);
    }

    function draw() {
      body.innerHTML = `
        <p style="color:var(--fg-text-dim);font-size:13px">Estes campos aparecerão no formulário de "Novo Ponto" deste projeto.</p>
        <div id="forms-field-list"></div>
        <button class="fg-btn primary" id="btn-add-field">➕ Adicionar Campo</button>`;
      const list = $('forms-field-list');
      list.innerHTML = (form.fields || [])
        .map(
          (f, i) => `<div class="fg-list-item" data-idx="${i}">
          <span class="fg-list-icon">🏷️</span>
          <div class="fg-list-main"><div class="fg-list-title">${f.label}</div><div class="fg-list-sub">${f.type}${f.options ? ' · ' + f.options : ''}</div></div>
          <button class="fg-icon-btn" style="width:32px;height:32px;font-size:14px" data-action="del">🗑️</button>
        </div>`
        )
        .join('') || '<p class="fg-empty">Nenhum campo customizado ainda.</p>';

      qsa('[data-action="del"]', list).forEach((btn) => {
        btn.onclick = async () => {
          const idx = parseInt(btn.closest('[data-idx]').getAttribute('data-idx'), 10);
          form.fields.splice(idx, 1);
          await Projects.updateForm(form);
          draw();
        };
      });

      $('btn-add-field').onclick = async () => {
        const label = promptDialog('Nome do campo (ex: Espécie, DAP, Altura...):');
        if (!label) return;
        const type = promptDialog('Tipo do campo: texto, numero, decimal, data, hora, selecao, checkbox', 'texto') || 'texto';
        let options = '';
        if (type === 'selecao') options = promptDialog('Opções separadas por vírgula:') || '';
        const key = 'f_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + Date.now().toString(36);
        form.fields = form.fields || [];
        form.fields.push({ key, label, type, options });
        await Projects.updateForm(form);
        draw();
      };
    }
    draw();
  }

  function wireFormsUI() {}

  // =======================================================================
  // Importação
  // =======================================================================
  function wireImportUI() {
    renderImportBody();
  }

  function renderImportBody() {
    $('import-body').innerHTML = `
      <div class="fg-actionsheet-list">
        <button class="fg-action-item" id="imp-csv"><span class="fg-action-icon">📊</span>CSV (pontos com coordenadas)</button>
        <button class="fg-action-item" id="imp-geojson"><span class="fg-action-icon">🗺️</span>GeoJSON</button>
        <button class="fg-action-item" id="imp-kml"><span class="fg-action-icon">🌍</span>KML / KMZ</button>
        <button class="fg-action-item" id="imp-gpx"><span class="fg-action-icon">🛰️</span>GPX</button>
        <button class="fg-action-item" id="imp-geotiff"><span class="fg-action-icon">🖼️</span>GeoTIFF (mapa raster)</button>
        <button class="fg-action-item" id="imp-pdf"><span class="fg-action-icon">📄</span>PDF / Imagem (georreferenciar manualmente)</button>
      </div>
      <div id="import-wizard" style="margin-top:14px"></div>`;

    $('imp-csv').onclick = () => pickFile('.csv,text/csv', handleCsvFile);
    $('imp-geojson').onclick = () => pickFile('.geojson,.json,application/geo+json,application/json', handleGeoJSONFile);
    $('imp-kml').onclick = () => pickFile('.kml,.kmz', handleKmlKmzFile);
    $('imp-gpx').onclick = () => pickFile('.gpx', handleGpxFile);
    $('imp-geotiff').onclick = () => pickFile('.tif,.tiff', handleGeoTiffFile);
    $('imp-pdf').onclick = () => pickFile('.pdf,.jpg,.jpeg,.png', handlePdfOrImageFile);
  }

  function pickFile(accept, handler) {
    if (!requireProject()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      if (input.files[0]) handler(input.files[0]);
    };
    input.click();
  }

  async function handleGeoJSONFile(file) {
    try {
      const text = await file.text();
      const geojson = JSON.parse(text);
      const layerIds = { points: (await getOrCreateDefaultLayer('points')).id, tracks: (await getOrCreateDefaultLayer('tracks')).id, polygons: (await getOrCreateDefaultLayer('polygons')).id };
      const result = await Importer.importGeoJSON(geojson, currentProjectId, layerIds);
      await refreshCurrentLayerOnMap('points');
      await refreshCurrentLayerOnMap('tracks');
      await refreshCurrentLayerOnMap('polygons');
      closeSheet('overlay-import');
      refreshProjectHeader();
      toast(`Importado: ${result.points} pontos, ${result.tracks} trilhas, ${result.polygons} polígonos.`);
    } catch (e) {
      toast('Não foi possível importar este arquivo GeoJSON: ' + e.message);
    }
  }

  async function handleKmlKmzFile(file) {
    try {
      let geojson;
      if (file.name.toLowerCase().endsWith('.kmz')) {
        geojson = await Importer.parseKMZ(await file.arrayBuffer());
      } else {
        geojson = await Importer.parseKML(await file.text());
      }
      const layerIds = { points: (await getOrCreateDefaultLayer('points')).id, tracks: (await getOrCreateDefaultLayer('tracks')).id, polygons: (await getOrCreateDefaultLayer('polygons')).id };
      const result = await Importer.importGeoJSON(geojson, currentProjectId, layerIds);
      await refreshCurrentLayerOnMap('points');
      await refreshCurrentLayerOnMap('tracks');
      await refreshCurrentLayerOnMap('polygons');
      closeSheet('overlay-import');
      refreshProjectHeader();
      toast(`Importado: ${result.points} pontos, ${result.tracks} trilhas, ${result.polygons} polígonos.`);
    } catch (e) {
      toast('Este arquivo não possui referência espacial reconhecida ou está corrompido.');
    }
  }

  async function handleGpxFile(file) {
    try {
      const geojson = await Importer.parseGPX(await file.text());
      const layerIds = { points: (await getOrCreateDefaultLayer('points')).id, tracks: (await getOrCreateDefaultLayer('tracks')).id, polygons: (await getOrCreateDefaultLayer('polygons')).id };
      const result = await Importer.importGeoJSON(geojson, currentProjectId, layerIds);
      await refreshCurrentLayerOnMap('points');
      await refreshCurrentLayerOnMap('tracks');
      closeSheet('overlay-import');
      refreshProjectHeader();
      toast(`Importado: ${result.points} pontos, ${result.tracks} trilhas.`);
    } catch (e) {
      toast('Não foi possível importar este arquivo GPX.');
    }
  }

  async function handleCsvFile(file) {
    const text = await file.text();
    const { headers, rows } = Importer.parseCSV(text);
    if (!headers.length) {
      toast('Não foi possível interpretar este CSV.');
      return;
    }
    const wizard = $('import-wizard');
    const opt = (h) => `<option value="${h}">${h}</option>`;
    wizard.innerHTML = `
      <div class="fg-step-indicator"><span class="done"></span></div>
      <p style="font-size:13px;color:var(--fg-text-dim)">${rows.length} linhas encontradas. Selecione as colunas correspondentes:</p>
      <label>Sistema de coordenadas</label>
      <select id="csv-coord-type"><option value="geo">Geográfica (Latitude/Longitude)</option><option value="utm">UTM</option></select>
      <div class="fg-field-map-row">
        <div><label id="csv-x-label">Longitude (X)</label><select id="csv-x">${headers.map(opt)}</select></div>
        <div><label id="csv-y-label">Latitude (Y)</label><select id="csv-y">${headers.map(opt)}</select></div>
      </div>
      <div id="csv-utm-extra" style="display:none">
        <div class="fg-field-map-row">
          <div><label>Zona UTM</label><input type="number" id="csv-utm-zone" value="21" min="1" max="60"/></div>
          <div><label>Hemisfério</label><select id="csv-utm-hemi"><option value="S">Sul</option><option value="N">Norte</option></select></div>
        </div>
        <label>Datum</label>
        <select id="csv-datum"><option value="SIRGAS2000">SIRGAS2000</option><option value="WGS84">WGS84</option></select>
      </div>
      <div class="fg-field-map-row">
        <div><label>Nome</label><select id="csv-name">${headers.map(opt)}</select></div>
        <div><label>Código</label><select id="csv-code"><option value="">(nenhum)</option>${headers.map(opt)}</select></div>
      </div>
      <label>Campos adicionais a importar como atributos</label>
      <div id="csv-attrs">${headers.map((h) => `<label style="display:flex;align-items:center;gap:8px;margin-top:6px"><input type="checkbox" value="${h}" style="width:auto"/> ${h}</label>`).join('')}</div>
      <button class="fg-btn primary" id="csv-do-import">📥 Importar ${rows.length} pontos</button>`;

    $('csv-coord-type').onchange = (e) => {
      const isUtm = e.target.value === 'utm';
      $('csv-utm-extra').style.display = isUtm ? 'block' : 'none';
      $('csv-x-label').textContent = isUtm ? 'Easting (X)' : 'Longitude (X)';
      $('csv-y-label').textContent = isUtm ? 'Northing (Y)' : 'Latitude (Y)';
    };

    $('csv-do-import').onclick = async () => {
      const mapping = {
        coordType: $('csv-coord-type').value,
        xField: $('csv-x').value,
        yField: $('csv-y').value,
        nameField: $('csv-name').value,
        codeField: $('csv-code').value,
        zone: parseInt($('csv-utm-zone').value, 10),
        hemisphere: $('csv-utm-hemi').value,
        datum: $('csv-datum').value,
        attributeFields: qsa('#csv-attrs input:checked').map((c) => c.value),
      };
      const layer = await getOrCreateDefaultLayer('points');
      const created = await Importer.importCSVPoints(headers, rows, mapping, currentProjectId, layer.id);
      await refreshCurrentLayerOnMap('points');
      closeSheet('overlay-import');
      refreshProjectHeader();
      toast(`${created.length} pontos importados do CSV.`);
    };
  }

  async function handleGeoTiffFile(file) {
    try {
      toast('Processando GeoTIFF... isso pode levar alguns segundos.');
      const result = await Importer.importGeoTIFF(await file.arrayBuffer());
      await saveRasterLayer(file.name, result);
      if (result.unrecognizedCRS) toast('Atenção: sistema de coordenadas do GeoTIFF não reconhecido. O mapa foi posicionado com base em aproximação — confira o posicionamento.', 6000);
      else toast('Mapa GeoTIFF importado com sucesso.');
      closeSheet('overlay-import');
    } catch (e) {
      toast('Não foi possível processar este arquivo GeoTIFF: ' + e.message);
    }
  }

  async function handlePdfOrImageFile(file) {
    try {
      let canvas;
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const arrayBuffer = await file.arrayBuffer();

        // IMPORTANTE: extrai o georreferenciamento embutido (GeoPDF real) ANTES
        // de repassar o buffer para o pdf.js. O pdf.js roda a renderização num
        // Web Worker e transfere (neutraliza) o ArrayBuffer original ao mandá-lo
        // via postMessage — se a extração fosse feita depois de renderPDFPage,
        // o buffer já estaria vazio e o app nunca encontraria as coordenadas
        // (mesmo em PDFs corretamente georreferenciados), caindo sem necessidade
        // no modo manual. Usamos slice(0) para trabalhar sobre uma cópia própria.
        const bounds = Importer.extractGeoPdfBounds(arrayBuffer.slice(0));

        const res = await Importer.renderPDFPage(arrayBuffer, 1, 2.5);
        canvas = res.canvas;

        if (bounds) {
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          await saveRasterLayer(file.name, {
            blob,
            bounds: [[bounds.sw.lat, bounds.sw.lon], [bounds.ne.lat, bounds.ne.lon]],
            width: canvas.width,
            height: canvas.height,
          });
          closeSheet('overlay-import');
          toast('GeoPDF detectado — coordenadas lidas automaticamente do arquivo.');
          return;
        }
      } else {
        const img = await loadImageFile(file);
        canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
      }
      openGeoreferenceWizard(canvas, file.name);
    } catch (e) {
      toast('Não foi possível abrir este arquivo: ' + e.message);
    }
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  function openGeoreferenceWizard(canvas, filename) {
    const wizard = $('import-wizard');
    const dataUrl = canvas.toDataURL('image/png');

    wizard.innerHTML = `
      <p style="font-size:13px;color:var(--fg-text-dim)">Este arquivo não possui georreferenciamento embutido reconhecido. Informe 2 pontos de controle (posição na imagem + coordenada real conhecida) para posicionar este mapa manualmente. O app assume a imagem alinhada ao Norte, sem rotação.</p>
      <p style="font-size:12px;color:var(--fg-warn,#b45309)">⚠️ Use coordenadas reais e conferidas (ex.: a própria grade/rótulos impressos na imagem, quando existirem). Não use uma posição "aproximada" — o mapa será posicionado exatamente onde você informar.</p>
      <img src="${dataUrl}" style="width:100%;border-radius:8px;margin-bottom:10px" id="georef-preview"/>
      <div class="fg-field-map-row">
        <div><label>Ponto 1 — pixel X</label><input type="number" id="gr-p1x" placeholder="ex: 120" value="0"/></div>
        <div><label>Ponto 1 — pixel Y</label><input type="number" id="gr-p1y" placeholder="ex: 80" value="0"/></div>
      </div>
      <div class="fg-field-map-row">
        <div><label>Ponto 1 — Latitude</label><input type="text" id="gr-p1lat" placeholder="-10.7256"/></div>
        <div><label>Ponto 1 — Longitude</label><input type="text" id="gr-p1lon" placeholder="-56.0214"/></div>
      </div>
      <hr style="border-color:var(--fg-border);margin:10px 0"/>
      <div class="fg-field-map-row">
        <div><label>Ponto 2 — pixel X</label><input type="number" id="gr-p2x" placeholder="ex: 900" value="${canvas.width}"/></div>
        <div><label>Ponto 2 — pixel Y</label><input type="number" id="gr-p2y" placeholder="ex: 700" value="${canvas.height}"/></div>
      </div>
      <div class="fg-field-map-row">
        <div><label>Ponto 2 — Latitude</label><input type="text" id="gr-p2lat" placeholder="-10.7401"/></div>
        <div><label>Ponto 2 — Longitude</label><input type="text" id="gr-p2lon" placeholder="-56.0011"/></div>
      </div>
      <p style="font-size:12px;color:var(--fg-text-dim)">Dica: toque na imagem acima para preencher automaticamente as coordenadas de pixel dos cantos.</p>
      <button class="fg-btn primary" id="gr-confirm">📍 Posicionar mapa</button>`;

    let clickTarget = 1;
    $('georef-preview').onclick = (e) => {
      const rect = e.target.getBoundingClientRect();
      const px = Math.round(((e.clientX - rect.left) / rect.width) * canvas.width);
      const py = Math.round(((e.clientY - rect.top) / rect.height) * canvas.height);
      if (clickTarget === 1) {
        $('gr-p1x').value = px;
        $('gr-p1y').value = py;
        clickTarget = 2;
      } else {
        $('gr-p2x').value = px;
        $('gr-p2y').value = py;
        clickTarget = 1;
      }
    };

    $('gr-confirm').onclick = async () => {
      try {
        const campos = {
          'Ponto 1 — pixel X': $('gr-p1x').value,
          'Ponto 1 — pixel Y': $('gr-p1y').value,
          'Ponto 1 — Latitude': $('gr-p1lat').value,
          'Ponto 1 — Longitude': $('gr-p1lon').value,
          'Ponto 2 — pixel X': $('gr-p2x').value,
          'Ponto 2 — pixel Y': $('gr-p2y').value,
          'Ponto 2 — Latitude': $('gr-p2lat').value,
          'Ponto 2 — Longitude': $('gr-p2lon').value,
        };
        const vazios = Object.keys(campos).filter((nome) => !String(campos[nome]).trim());
        if (vazios.length > 0) {
          toast('Preencha o campo: ' + vazios[0]);
          return;
        }

        const p1 = { px: +$('gr-p1x').value, py: +$('gr-p1y').value, lat: Coordinates.parseCoordString($('gr-p1lat').value), lon: Coordinates.parseCoordString($('gr-p1lon').value) };
        const p2 = { px: +$('gr-p2x').value, py: +$('gr-p2y').value, lat: Coordinates.parseCoordString($('gr-p2lat').value), lon: Coordinates.parseCoordString($('gr-p2lon').value) };

        const invalidos = [];
        if (Number.isNaN(p1.lat)) invalidos.push('Ponto 1 — Latitude');
        if (Number.isNaN(p1.lon)) invalidos.push('Ponto 1 — Longitude');
        if (Number.isNaN(p2.lat)) invalidos.push('Ponto 2 — Latitude');
        if (Number.isNaN(p2.lon)) invalidos.push('Ponto 2 — Longitude');
        if (invalidos.length > 0) {
          toast('Coordenada em formato inválido: ' + invalidos.join(', '));
          return;
        }

        const bounds = Importer.computeBoundsFromControlPoints(canvas.width, canvas.height, p1, p2);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        await saveRasterLayer(filename, { blob, bounds: [[bounds.sw.lat, bounds.sw.lon], [bounds.ne.lat, bounds.ne.lon]], width: canvas.width, height: canvas.height });
        closeSheet('overlay-import');
        toast('Mapa posicionado com sucesso.');
      } catch (e) {
        toast('Erro ao posicionar o mapa: ' + e.message);
      }
    };
  }

  async function saveRasterLayer(filename, result) {
    const layer = await Layers.create(currentProjectId, filename, 'raster', { opacity: 1 });
    const blobRec = await DB.put('blobs', { projectId: currentProjectId, kind: 'raster', blob: result.blob, meta: { width: result.width, height: result.height } });
    await DB.put('maps', {
      projectId: currentProjectId,
      layerId: layer.id,
      name: filename,
      type: 'raster',
      bounds: result.bounds,
      blobKey: blobRec.id,
      meta: { width: result.width, height: result.height, epsgCode: result.epsgCode || null },
    });
    await renderLayer(layer);
    MapModule.invalidateSize();
    MapModule.fitBounds(result.bounds);
  }

  // =======================================================================
  // Exportação
  // =======================================================================
  function wireExportUI() {}

  function renderExportBody() {
    if (!requireProject()) return;
    $('export-body').innerHTML = `
      <h3 style="margin-top:0">Pontos</h3>
      <div class="fg-btn-row">
        <button class="fg-btn" id="exp-pts-csv">CSV</button>
        <button class="fg-btn" id="exp-pts-geojson">GeoJSON</button>
      </div>
      <div class="fg-btn-row">
        <button class="fg-btn" id="exp-pts-kml">KML</button>
        <button class="fg-btn" id="exp-pts-gpx">GPX</button>
      </div>
      <h3>Trilhas</h3>
      <div class="fg-btn-row">
        <button class="fg-btn" id="exp-trk-gpx">GPX</button>
        <button class="fg-btn" id="exp-trk-kml">KML</button>
        <button class="fg-btn" id="exp-trk-geojson">GeoJSON</button>
      </div>
      <h3>Polígonos</h3>
      <div class="fg-btn-row">
        <button class="fg-btn" id="exp-pol-kml">KML</button>
        <button class="fg-btn" id="exp-pol-geojson">GeoJSON</button>
      </div>
      <h3>Projeto completo</h3>
      <button class="fg-btn primary" id="exp-full">📦 Exportar Projeto Completo (.fieldgis)</button>`;

    $('exp-pts-csv').onclick = async () => Exporter.exportPointsCSV(await Points.listByProject(currentProjectId), settings.coords.datum);
    $('exp-pts-geojson').onclick = async () => Exporter.exportPointsGeoJSON(await Points.listByProject(currentProjectId));
    $('exp-pts-kml').onclick = async () => Exporter.exportPointsKML(await Points.listByProject(currentProjectId));
    $('exp-pts-gpx').onclick = async () => Exporter.exportPointsGPX(await Points.listByProject(currentProjectId));
    $('exp-trk-gpx').onclick = async () => Exporter.exportTracksGPX(await DB.byProject('tracks', currentProjectId));
    $('exp-trk-kml').onclick = async () => Exporter.exportTracksKML(await DB.byProject('tracks', currentProjectId));
    $('exp-trk-geojson').onclick = async () => Exporter.exportTracksGeoJSON(await DB.byProject('tracks', currentProjectId));
    $('exp-pol-kml').onclick = async () => Exporter.exportPolygonsKML(await DB.byProject('polygons', currentProjectId));
    $('exp-pol-geojson').onclick = async () => Exporter.exportPolygonsGeoJSON(await DB.byProject('polygons', currentProjectId));
    $('exp-full').onclick = async () => {
      toast('Gerando arquivo do projeto...');
      await Exporter.exportProject(currentProjectId);
    };
  }

  // =======================================================================
  // Backup / restauração
  // =======================================================================
  function wireBackupUI() {}

  function renderBackupBody() {
    $('backup-body').innerHTML = `
      <p style="font-size:13px;color:var(--fg-text-dim)">O backup gera um arquivo .fieldgis contendo todos os dados do projeto (mapas, pontos, trilhas, polígonos, atributos e fotografias), para guardar em outro local ou transferir para outro aparelho.</p>
      <button class="fg-btn primary" id="bk-project" ${currentProjectId ? '' : 'disabled'}>💾 Backup deste projeto</button>
      <button class="fg-btn" id="bk-all">💾 Backup de todos os projetos</button>
      <h3>Restaurar</h3>
      <button class="fg-btn success" id="bk-restore">📂 Restaurar backup (.fieldgis)</button>`;

    $('bk-project').onclick = async () => {
      if (!requireProject()) return;
      toast('Gerando backup...');
      await Exporter.exportProject(currentProjectId);
    };
    $('bk-all').onclick = async () => {
      toast('Gerando backup completo...');
      await Exporter.fullBackup();
    };
    $('bk-restore').onclick = () => {
      pickFileNoProjectCheck('.fieldgis,.zip', async (file) => {
        try {
          toast('Restaurando backup...');
          const project = await Exporter.importProjectBackup(file);
          toast('Projeto restaurado: ' + project.name);
          closeSheet('overlay-backup');
          await loadProject(project.id);
        } catch (e) {
          toast('Não foi possível restaurar este backup: ' + e.message);
        }
      });
    };
  }

  function pickFileNoProjectCheck(accept, handler) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      if (input.files[0]) handler(input.files[0]);
    };
    input.click();
  }

  // =======================================================================
  // Configurações
  // =======================================================================
  function renderSettingsBody() {
    $('settings-body').innerHTML = `
      <p style="text-align:right;font-size:11px;color:var(--fg-text-faint);margin:-4px 0 8px">build ${APP_BUILD_VERSION}</p>
      <h3 style="margin-top:0">GPS</h3>
      <label>Precisão mínima aceitável (m)</label>
      <input type="number" id="st-gps-acc" value="${settings.gps.minAccuracy}"/>
      <label>Distância mínima entre pontos de trilha/polígono (m)</label>
      <input type="number" id="st-gps-dist" value="${settings.gps.minDistance}"/>

      <h3>Coordenadas</h3>
      <label>Datum</label>
      <select id="st-datum"><option ${settings.coords.datum === 'SIRGAS2000' ? 'selected' : ''}>SIRGAS2000</option><option ${settings.coords.datum === 'WGS84' ? 'selected' : ''}>WGS84</option></select>
      <label>Formato de coordenadas</label>
      <select id="st-format">
        <option value="dms" ${settings.coords.format === 'dms' ? 'selected' : ''}>Graus, minutos e segundos (GMS)</option>
        <option value="dmm" ${settings.coords.format === 'dmm' ? 'selected' : ''}>Graus e minutos decimais</option>
        <option value="dd" ${settings.coords.format === 'dd' ? 'selected' : ''}>Graus decimais</option>
        <option value="utm" ${settings.coords.format === 'utm' ? 'selected' : ''}>UTM</option>
      </select>
      <p style="font-size:12px;color:var(--fg-text-dim);margin-top:-8px">Dica: toque direto nas coordenadas exibidas no mapa (embaixo de "GPS Bom/Excelente") para alternar rapidamente entre GMS, UTM e decimal, sem precisar abrir esta tela.</p>

      <h3>Mapa</h3>
      <div class="fg-switch-row"><span>Exibir grade UTM</span><div class="fg-switch ${settings.map.showGrid ? 'on' : ''}" id="st-grid"></div></div>

      <div class="fg-switch-row"><span>Marca d'água nas fotos</span><div class="fg-switch ${settings.watermark ? 'on' : ''}" id="st-watermark"></div></div>

      <h3>Unidades</h3>
      <label>Distância</label>
      <select id="st-unit-dist"><option value="m" ${settings.units.distance === 'm' ? 'selected' : ''}>Metros</option><option value="km" ${settings.units.distance === 'km' ? 'selected' : ''}>Quilômetros</option></select>
      <label>Área</label>
      <select id="st-unit-area"><option value="ha" ${settings.units.area === 'ha' ? 'selected' : ''}>Hectares</option><option value="m2" ${settings.units.area === 'm2' ? 'selected' : ''}>m²</option><option value="km2" ${settings.units.area === 'km2' ? 'selected' : ''}>km²</option></select>

      <button class="fg-btn primary" id="st-save">💾 Salvar Configurações</button>

      <h3>Mapas offline (cache)</h3>
      <p style="font-size:13px;color:var(--fg-text-dim)">Cada área de mapa (OSM/satélite) vista em tela fica salva automaticamente no aparelho para uso sem internet. Com o tempo esse cache cresce e pode deixar o app lento — se isso acontecer, limpe-o abaixo. <b>Isso não apaga projetos, pontos, trilhas, polígonos ou fotos</b> — apenas as imagens de fundo, que são baixadas de novo quando houver internet.</p>
      <p id="st-tile-cache-info" style="font-size:13px;color:var(--fg-text-dim)">Calculando uso do cache de mapas...</p>
      <button class="fg-btn danger" id="st-clear-tiles">🗑️ Limpar cache de mapas offline</button>`;

    $('st-grid').onclick = (e) => e.target.classList.toggle('on');
    $('st-watermark').onclick = (e) => e.target.classList.toggle('on');

    refreshTileCacheInfo();
    $('st-clear-tiles').onclick = async () => {
      if (!confirmDialog('Limpar o cache de mapas offline? As imagens de fundo (OSM/satélite) precisarão ser baixadas novamente quando houver internet. Seus projetos, pontos, trilhas, polígonos e fotos NÃO serão afetados.')) return;
      $('st-clear-tiles').disabled = true;
      $('st-tile-cache-info').textContent = 'Limpando cache de mapas...';
      await Offline.clearTileCache();
      await refreshTileCacheInfo();
      $('st-clear-tiles').disabled = false;
      toast('Cache de mapas offline limpo.');
    };

    $('st-save').onclick = async () => {
      const newSettings = {
        gps: { minAccuracy: +$('st-gps-acc').value, minDistance: +$('st-gps-dist').value, minInterval: settings.gps.minInterval, autoUpdate: true, useCompass: settings.gps.useCompass },
        coords: { datum: $('st-datum').value, format: $('st-format').value, showUTM: true },
        map: { showGrid: $('st-grid').classList.contains('on'), showScale: true, showNorth: true },
        units: { distance: $('st-unit-dist').value, area: $('st-unit-area').value },
        watermark: $('st-watermark').classList.contains('on'),
      };
      settings = await DB.saveSettings(newSettings);
      MapModule.toggleGrid(settings.map.showGrid, settings.coords.datum);
      closeSheet('overlay-settings');
      toast('Configurações salvas.');
    };
  }

  function wireSettingsUI() {}

  async function refreshTileCacheInfo() {
    const el = $('st-tile-cache-info');
    if (!el) return;
    try {
      const info = await Offline.getTileCacheInfo();
      if (!info.supported) {
        el.textContent = 'Este navegador não suporta consultar o cache de mapas.';
        return;
      }
      if (!info.count) {
        el.textContent = 'Nenhum mapa de fundo salvo em cache ainda.';
        return;
      }
      const tamanho = info.bytes != null ? ` (≈ ${(info.bytes / 1024 / 1024).toFixed(1)} MB)` : '';
      el.textContent = `${info.count} imagens de mapa salvas em cache${tamanho}.`;
    } catch (e) {
      el.textContent = 'Não foi possível calcular o uso do cache de mapas.';
    }
  }

  // =======================================================================
  // Busca
  // =======================================================================
  function wireSearchUI() {
    $('search-back').onclick = () => {
      $('search-overlay').hidden = true;
    };
    $('search-input').oninput = async (e) => {
      if (!currentProjectId) return;
      const results = await Points.search(currentProjectId, e.target.value);
      renderSearchResults(results);
    };
  }

  function renderSearchResults(results) {
    const container = $('search-results');
    if (!results.length) {
      container.innerHTML = '<p class="fg-empty">Nenhum resultado encontrado.</p>';
      return;
    }
    container.innerHTML = results
      .map((p) => `<div class="fg-list-item" data-id="${p.id}"><span class="fg-list-icon">📍</span><div class="fg-list-main"><div class="fg-list-title">${p.name}</div><div class="fg-list-sub">${p.code || ''}</div></div></div>`)
      .join('');
    qsa('.fg-list-item', container).forEach((item) => {
      item.onclick = async () => {
        const point = await DB.get('points', item.getAttribute('data-id'));
        $('search-overlay').hidden = true;
        MapModule.centerOnPosition(point.lat, point.lon, 18);
        openPointInfo(point);
      };
    });
  }

  // =======================================================================
  // Modo campo
  // =======================================================================
  function wireFieldMode() {
    $('field-exit').onclick = () => {
      $('field-panel').hidden = true;
      document.body.classList.remove('fg-field-mode');
    };
    $('field-btn-point').onclick = () => handleNewPoint();
    $('field-btn-track').onclick = () => handleTrackToggle();
    $('field-btn-measure').onclick = () => handleMeasureRequest();
    $('field-btn-navigate').onclick = () => handleNavigateRequest();
  }

  function updateFieldModeTiles(data) {
    if ($('field-panel').hidden) return;
    const dots = { excellent: '🟢', good: '🟢', moderate: '🟡', weak: '🔴', unknown: '🔴' };
    $('field-gps-dot').textContent = dots[data.quality] || '🔴';
    $('field-gps-quality').textContent = { excellent: 'Excelente', good: 'Bom', moderate: 'Moderado', weak: 'Fraco' }[data.quality] || '—';
    $('field-coords').textContent = `${Coordinates.formatLat(data.lat, settings.coords.format)}\n${Coordinates.formatLon(data.lon, settings.coords.format)}`;
    $('field-alt').textContent = data.altitude != null ? data.altitude.toFixed(0) + ' m' : '—';
    $('field-acc').textContent = data.accuracy != null ? '±' + data.accuracy.toFixed(1) + ' m' : '—';
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
