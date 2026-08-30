/**
 * import.js
 * -----------------------------------------------------------------------
 * Importação de dados: CSV, GeoJSON, KML/KMZ, GPX, GeoTIFF e PDF/imagem
 * georreferenciada manualmente.
 *
 * Todas as rotinas rodam inteiramente no navegador (parsing local), sem
 * enviar nenhum arquivo para servidores externos.
 */

(function () {
  // ------------------------------------------------------------------
  // CSV
  // ------------------------------------------------------------------

  /** Parser CSV simples com suporte a aspas e delimitador , ou ; (detectado automaticamente). */
  function parseCSV(text) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const firstLine = text.split('\n')[0];
    const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += c;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }

    const headers = rows.shift() || [];
    return { headers: headers.map((h) => h.trim()), rows, delimiter };
  }

  /**
   * Importa pontos de linhas de CSV já parseadas.
   * mapping: { nameField, codeField, xField, yField, coordType: 'geo'|'utm', datum, zone, hemisphere, attributeFields:[names] }
   */
  async function importCSVPoints(headers, rows, mapping, projectId, layerId) {
    const idx = (field) => headers.indexOf(field);
    const iName = idx(mapping.nameField);
    const iCode = idx(mapping.codeField);
    const iX = idx(mapping.xField);
    const iY = idx(mapping.yField);
    const attrIdx = (mapping.attributeFields || []).map((f) => ({ field: f, i: idx(f) }));

    const created = [];
    for (const r of rows) {
      if (!r.length || (r.length === 1 && !r[0])) continue;
      const xVal = parseFloat(String(r[iX]).replace(',', '.'));
      const yVal = parseFloat(String(r[iY]).replace(',', '.'));
      if (Number.isNaN(xVal) || Number.isNaN(yVal)) continue;

      let lat, lon;
      if (mapping.coordType === 'utm') {
        const res = Coordinates.fromUTM(xVal, yVal, mapping.zone, mapping.hemisphere === 'S', mapping.datum);
        lat = res.lat;
        lon = res.lon;
      } else {
        lon = xVal;
        lat = yVal;
      }

      const attributes = {};
      attrIdx.forEach(({ field, i }) => {
        if (i >= 0) attributes[field] = r[i];
      });

      const point = {
        projectId,
        layerId,
        name: iName >= 0 ? r[iName] : `IMP-${created.length + 1}`,
        code: iCode >= 0 ? r[iCode] : '',
        lat,
        lon,
        alt: null,
        accuracy: null,
        capturedAt: new Date().toISOString(),
        description: '',
        attributes,
        photos: [],
        imported: true,
      };
      created.push(await DB.put('points', point));
    }
    return created;
  }

  // ------------------------------------------------------------------
  // GeoJSON / KML / GPX (todos convergem para GeoJSON antes de importar)
  // ------------------------------------------------------------------

  async function importGeoJSON(geojson, projectId, layerIds) {
    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    const result = { points: 0, tracks: 0, polygons: 0 };

    for (const f of features) {
      if (!f.geometry) continue;
      const props = f.properties || {};
      switch (f.geometry.type) {
        case 'Point': {
          const [lon, lat, alt] = f.geometry.coordinates;
          await DB.put('points', {
            projectId,
            layerId: layerIds.points,
            name: props.name || props.Name || `IMP-${result.points + 1}`,
            code: props.code || '',
            lat,
            lon,
            alt: alt ?? null,
            accuracy: null,
            capturedAt: new Date().toISOString(),
            description: props.description || '',
            attributes: props,
            photos: [],
            imported: true,
          });
          result.points++;
          break;
        }
        case 'LineString': {
          const points = f.geometry.coordinates.map(([lon, lat, alt], i) => ({ lat, lon, alt: alt ?? null, time: Date.now() + i }));
          const stats = Tracks.computeStats(points);
          await DB.put('tracks', {
            projectId,
            layerId: layerIds.tracks,
            name: props.name || `Trilha importada ${result.tracks + 1}`,
            points,
            stats,
            imported: true,
          });
          result.tracks++;
          break;
        }
        case 'Polygon': {
          const ring = f.geometry.coordinates[0];
          const vertices = ring.map(([lon, lat]) => ({ lat, lon }));
          const area = Coordinates.polygonArea(vertices.map((v) => ({ lat: v.lat, lng: v.lon })));
          const perimeter = Coordinates.polygonPerimeter(vertices.map((v) => ({ lat: v.lat, lng: v.lon })), true);
          await DB.put('polygons', {
            projectId,
            layerId: layerIds.polygons,
            name: props.name || `Polígono importado ${result.polygons + 1}`,
            vertices,
            area,
            perimeter,
            attributes: props,
            imported: true,
          });
          result.polygons++;
          break;
        }
        case 'MultiLineString': {
          for (const line of f.geometry.coordinates) {
            const points = line.map(([lon, lat, alt], i) => ({ lat, lon, alt: alt ?? null, time: Date.now() + i }));
            await DB.put('tracks', { projectId, layerId: layerIds.tracks, name: props.name || `Trilha importada ${result.tracks + 1}`, points, stats: Tracks.computeStats(points), imported: true });
            result.tracks++;
          }
          break;
        }
        case 'MultiPolygon': {
          for (const poly of f.geometry.coordinates) {
            const vertices = poly[0].map(([lon, lat]) => ({ lat, lon }));
            const area = Coordinates.polygonArea(vertices.map((v) => ({ lat: v.lat, lng: v.lon })));
            const perimeter = Coordinates.polygonPerimeter(vertices.map((v) => ({ lat: v.lat, lng: v.lon })), true);
            await DB.put('polygons', { projectId, layerId: layerIds.polygons, name: props.name || `Polígono importado ${result.polygons + 1}`, vertices, area, perimeter, attributes: props, imported: true });
            result.polygons++;
          }
          break;
        }
        default:
          break;
      }
    }
    return result;
  }

  async function parseKML(text) {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    return toGeoJSON.kml(dom);
  }

  async function parseGPX(text) {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    return toGeoJSON.gpx(dom);
  }

  /** KMZ é um .zip contendo um doc.kml (+ recursos). Extraímos o primeiro .kml encontrado. */
  async function parseKMZ(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    let kmlEntry = null;
    zip.forEach((path, entry) => {
      if (!kmlEntry && path.toLowerCase().endsWith('.kml')) kmlEntry = entry;
    });
    if (!kmlEntry) throw new Error('Arquivo KMZ não contém um documento KML válido.');
    const text = await kmlEntry.async('text');
    return parseKML(text);
  }

  // ------------------------------------------------------------------
  // GeoTIFF (raster georreferenciado)
  // ------------------------------------------------------------------

  // Tabela de EPSG conhecidos -> definição UTM (zona/hemisfério/datum).
  // Cobre os casos de uso mais comuns no Brasil (SIRGAS2000 e WGS84).
  function utmFromEPSG(code) {
    if (code >= 32601 && code <= 32660) return { zone: code - 32600, south: false, datum: 'WGS84' };
    if (code >= 32701 && code <= 32760) return { zone: code - 32700, south: true, datum: 'WGS84' };
    if (code >= 31971 && code <= 31976) return { zone: code - 31954, south: false, datum: 'SIRGAS2000' }; // 31971=17N .. 31976=22N
    if (code >= 31977 && code <= 31985) return { zone: code - 31960, south: true, datum: 'SIRGAS2000' }; // 31977=17S .. 31985=25S
    return null;
  }

  /**
   * Importa um GeoTIFF: lê os pixels, monta uma imagem RGB/escala de cinza em
   * canvas e determina a extensão geográfica (bounding box) a partir dos
   * metadados de georreferenciamento embutidos no arquivo.
   *
   * LIMITAÇÃO DOCUMENTADA: se o GeoTIFF estiver rotacionado (ModelTransformation
   * com componente de rotação) ou usar uma projeção fora da tabela UTM acima,
   * o app assume os cantos como um retângulo alinhado a lat/lon (aproximação).
   * Isso é suficiente para a grande maioria das cartas e ortomosaicos de campo,
   * que normalmente são exportados alinhados ao norte.
   */
  async function importGeoTIFF(arrayBuffer) {
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY] no CRS nativo da imagem

    let geoKeys = {};
    try {
      geoKeys = image.getGeoKeys() || {};
    } catch (e) {
      /* algumas imagens não trazem GeoKeys legíveis */
    }

    const epsgCode = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey || null;
    let corners; // {sw:{lat,lon}, ne:{lat,lon}}

    if (epsgCode && epsgCode >= 4000 && epsgCode < 5000) {
      // CRS já geográfico (graus) — bbox já está em lon/lat
      corners = { sw: { lat: bbox[1], lon: bbox[0] }, ne: { lat: bbox[3], lon: bbox[2] } };
    } else if (epsgCode && utmFromEPSG(epsgCode)) {
      const u = utmFromEPSG(epsgCode);
      const sw = Coordinates.fromUTM(bbox[0], bbox[1], u.zone, u.south, u.datum);
      const ne = Coordinates.fromUTM(bbox[2], bbox[3], u.zone, u.south, u.datum);
      corners = { sw, ne };
    } else {
      // CRS não reconhecido: melhor esforço — assume que os valores já estão em graus.
      corners = { sw: { lat: bbox[1], lon: bbox[0] }, ne: { lat: bbox[3], lon: bbox[2] } };
      corners.unrecognizedCRS = true;
    }

    // Renderiza os pixels em um canvas (RGB direto se houver 3+ bandas, escala de cinza c/ contraste automático caso contrário)
    const rasters = await image.readRasters();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);

    const bandCount = rasters.length;
    if (bandCount >= 3) {
      for (let i = 0; i < width * height; i++) {
        imgData.data[i * 4] = rasters[0][i];
        imgData.data[i * 4 + 1] = rasters[1][i];
        imgData.data[i * 4 + 2] = rasters[2][i];
        imgData.data[i * 4 + 3] = bandCount >= 4 ? rasters[3][i] : 255;
      }
    } else {
      // Banda única: aplica alongamento de contraste (stretch) linear min-max
      const band = rasters[0];
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < band.length; i++) {
        if (band[i] < min) min = band[i];
        if (band[i] > max) max = band[i];
      }
      const range = max - min || 1;
      for (let i = 0; i < width * height; i++) {
        const v = Math.round(((band[i] - min) / range) * 255);
        imgData.data[i * 4] = v;
        imgData.data[i * 4 + 1] = v;
        imgData.data[i * 4 + 2] = v;
        imgData.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return {
      blob,
      bounds: [[corners.sw.lat, corners.sw.lon], [corners.ne.lat, corners.ne.lon]],
      width,
      height,
      unrecognizedCRS: !!corners.unrecognizedCRS,
      epsgCode,
    };
  }

  // ------------------------------------------------------------------
  /**
   * Tenta extrair automaticamente o georreferenciamento embutido em um GeoPDF
   * real (padrão OGC / ISO 32000-2 Geospatial, gerado por Esri ArcMap/ArcPress,
   * QGIS, Avenza etc.), lendo os dicionários /Measure /Subtype/GEO com os
   * arrays /GPTS (coordenadas geográficas) e /LPTS (pontos correspondentes,
   * normalizados 0–1, no viewport da página).
   *
   * Só retorna um resultado quando o LPTS forma um retângulo alinhado aos
   * eixos (todos os valores são 0 ou 1) — ou seja, mapa sem rotação. Nesse
   * caso, o bounding box geográfico (min/max de lat/lon do GPTS) já é exato.
   * Para GeoPDFs rotacionados/com perspectiva (LPTS com valores intermediários),
   * retorna null e o app cai de volta no georreferenciamento manual por 2 pontos.
   */
  function extractGeoPdfBounds(arrayBuffer) {
    try {
      const bytes = new Uint8Array(arrayBuffer);
      // Decodifica como Latin1 (1 byte = 1 char) só para permitir regex sobre
      // a estrutura de texto do PDF — não afeta a leitura binária normal.
      let raw = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        raw += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }

      // Procura todos os dicionários /Measure /Subtype/GEO do arquivo (pode
      // haver mais de uma camada/viewport; usamos o primeiro que for válido).
      const measureRegex = /\/Type\s*\/Measure\s*\/Subtype\s*\/GEO[^>]*?\/GPTS\s*\[([^\]]+)\][^>]*?\/LPTS\s*\[([^\]]+)\]|\/Type\s*\/Measure\s*\/Subtype\s*\/GEO[^>]*?\/LPTS\s*\[([^\]]+)\][^>]*?\/GPTS\s*\[([^\]]+)\]/g;

      let m;
      while ((m = measureRegex.exec(raw)) !== null) {
        const gptsStr = m[1] || m[4];
        const lptsStr = m[2] || m[3];
        if (!gptsStr || !lptsStr) continue;

        const gpts = gptsStr.trim().split(/\s+/).map(Number);
        const lpts = lptsStr.trim().split(/\s+/).map(Number);
        if (gpts.length < 8 || gpts.length !== lpts.length) continue;
        if (gpts.some(Number.isNaN) || lpts.some(Number.isNaN)) continue;

        // Só aceitamos o caso simples (sem rotação): todo valor de LPTS é 0 ou 1.
        const semRotacao = lpts.every((v) => Math.abs(v) < 1e-6 || Math.abs(v - 1) < 1e-6);
        if (!semRotacao) continue;

        const lats = [];
        const lons = [];
        for (let i = 0; i < gpts.length; i += 2) {
          lats.push(gpts[i]);
          lons.push(gpts[i + 1]);
        }
        return {
          sw: { lat: Math.min(...lats), lon: Math.min(...lons) },
          ne: { lat: Math.max(...lats), lon: Math.max(...lons) },
        };
      }
      return null;
    } catch (e) {
      console.error('Falha ao extrair GeoPDF:', e);
      return null;
    }
  }

  // PDF / imagem com georreferenciamento manual (2 pontos de controle)
  // ------------------------------------------------------------------

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  /** Renderiza a primeira página de um PDF em um canvas de alta resolução. */
  async function renderPDFPage(arrayBuffer, pageNumber = 1, scale = 2) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { canvas, numPages: pdf.numPages };
  }

  /**
   * Calcula os limites geográficos (bounds) de uma imagem a partir de DOIS
   * pontos de controle informados pelo usuário (pixel <-> coordenada real).
   * Assume a imagem alinhada ao Norte (sem rotação) — transformação afim
   * simples de escala + translação por eixo. Para a maioria dos mapas/plantas
   * escaneados isso é suficiente; rotação arbitrária exigiria um terceiro
   * ponto de controle e reamostragem da imagem (não implementado nesta versão).
   */
  function computeBoundsFromControlPoints(imgWidth, imgHeight, p1, p2) {
    // p1, p2: { px, py, lat, lon }
    const dPxX = p2.px - p1.px;
    const dPxY = p2.py - p1.py;
    if (Math.abs(dPxX) < 1e-6 || Math.abs(dPxY) < 1e-6) {
      throw new Error('Os dois pontos de controle precisam estar em posições X e Y distintas na imagem.');
    }
    const lonPerPx = (p2.lon - p1.lon) / dPxX;
    const latPerPy = (p2.lat - p1.lat) / dPxY;

    const lonAtOrigin = p1.lon - p1.px * lonPerPx;
    const latAtOrigin = p1.lat - p1.py * latPerPy;

    const lonTopLeft = lonAtOrigin;
    const latTopLeft = latAtOrigin;
    const lonBottomRight = lonAtOrigin + imgWidth * lonPerPx;
    const latBottomRight = latAtOrigin + imgHeight * latPerPy;

    return {
      sw: { lat: Math.min(latTopLeft, latBottomRight), lon: Math.min(lonTopLeft, lonBottomRight) },
      ne: { lat: Math.max(latTopLeft, latBottomRight), lon: Math.max(lonTopLeft, lonBottomRight) },
    };
  }

  window.Importer = {
    parseCSV,
    importCSVPoints,
    importGeoJSON,
    parseKML,
    parseGPX,
    parseKMZ,
    importGeoTIFF,
    renderPDFPage,
    extractGeoPdfBounds,
    computeBoundsFromControlPoints,
    utmFromEPSG,
  };
})();
