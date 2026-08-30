/**
 * coordinates.js
 * -----------------------------------------------------------------------
 * Módulo profissional de coordenadas do FieldGIS.
 *
 * Responsável por:
 *   - Conversão entre graus decimais, GMS (graus/min/seg) e graus/min decimais;
 *   - Conversão Geográfica <-> UTM usando proj4js (vendorizado, funciona offline);
 *   - Cálculo automático da zona UTM e hemisfério a partir da longitude/latitude;
 *   - Suporte a datum SIRGAS2000 e WGS84 (e qualquer EPSG customizado que o
 *     usuário informar, desde que uma definição proj4 válida seja fornecida);
 *   - Cálculo geodésico de distância e azimute (fórmulas de Vincenty/Haversine).
 *
 * Observação técnica importante:
 *   Para fins práticos de campo (GNSS de uso civil), SIRGAS2000 e WGS84
 *   compartilham essencialmente o mesmo elipsoide/referencial (diferenças
 *   da ordem de poucos centímetros na maior parte do Brasil), portanto o
 *   aplicativo trata a conversão entre os dois como identidade. Isso é uma
 *   simplificação documentada: para trabalhos geodésicos de alta precisão
 *   (milimétricos) seria necessário aplicar parâmetros de transformação
 *   oficiais (IBGE/PROGRID), o que está fora do escopo de um app offline
 *   em navegador.
 */

(function () {
  // Define os datums/elipsoides usados. proj4 já conhece WGS84 nativamente.
  proj4.defs('SIRGAS2000', '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs');
  proj4.defs('WGS84', '+proj=longlat +datum=WGS84 +no_defs');

  /** Retorna a definição proj4 UTM para uma zona/hemisfério/datum específicos. */
  function utmDef(zone, isSouth, datum) {
    const ellps = datum === 'SIRGAS2000' ? 'GRS80' : 'WGS84';
    const south = isSouth ? ' +south' : '';
    return `+proj=utm +zone=${zone}${south} +ellps=${ellps} +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  }

  /** Calcula a zona UTM (1-60) a partir da longitude. */
  function utmZoneFromLon(lon) {
    return Math.floor((lon + 180) / 6) + 1;
  }

  /**
   * Converte lat/lon (graus decimais, WGS84/SIRGAS2000) para UTM.
   * @returns {{easting:number, northing:number, zone:number, hemisphere:'N'|'S', epsg:string}}
   */
  function toUTM(lat, lon, datum = 'SIRGAS2000', forcedZone = null) {
    const zone = forcedZone || utmZoneFromLon(lon);
    const isSouth = lat < 0;
    const def = utmDef(zone, isSouth, datum);
    const [easting, northing] = proj4(datum === 'SIRGAS2000' ? 'SIRGAS2000' : 'WGS84', def, [lon, lat]);
    const epsgBase = datum === 'SIRGAS2000' ? 31960 : 32600; // SIRGAS2000/UTM sul começa em 31978-31985 por zona; usamos genérico
    return {
      easting,
      northing,
      zone,
      hemisphere: isSouth ? 'S' : 'N',
      datum,
      label: `${zone}${isSouth ? 'S' : 'N'}`,
    };
  }

  /** Converte UTM -> lat/lon decimal. */
  function fromUTM(easting, northing, zone, isSouth, datum = 'SIRGAS2000') {
    const def = utmDef(zone, isSouth, datum);
    const [lon, lat] = proj4(def, datum === 'SIRGAS2000' ? 'SIRGAS2000' : 'WGS84', [easting, northing]);
    return { lat, lon };
  }

  /** Converte um valor customizado via EPSG (requer definição registrada) para lat/lon WGS84. */
  function customToLatLon(x, y, epsgDef) {
    const [lon, lat] = proj4(epsgDef, 'WGS84', [x, y]);
    return { lat, lon };
  }

  /** Converte graus decimais para GMS { deg, min, sec, hemi }. */
  function decToDMS(value, isLat) {
    const hemi = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = (minFloat - min) * 60;
    return { deg, min, sec, hemi };
  }

  /** Formata graus decimais como string GMS: 10°43'32.278"S */
  function formatDMS(value, isLat, decimals = 3) {
    const { deg, min, sec, hemi } = decToDMS(value, isLat);
    const secStr = sec.toFixed(decimals).padStart(decimals + 3, '0').replace('.', ',');
    return `${deg}°${String(min).padStart(2, '0')}'${secStr}"${hemi}`;
  }

  /** Formata graus e minutos decimais: 10°43.538'S */
  function formatDMM(value, isLat, decimals = 3) {
    const hemi = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${deg}°${min.toFixed(decimals)}'${hemi}`;
  }

  /** Formata graus decimais simples: -10.725632 */
  function formatDecimal(value, decimals = 6) {
    return value.toFixed(decimals);
  }

  /** Formata segundo o formato preferido do usuário ('dms' | 'dmm' | 'dd'). */
  function formatLat(value, format = 'dms') {
    if (format === 'dd') return formatDecimal(value) + '°';
    if (format === 'dmm') return formatDMM(value, true);
    return formatDMS(value, true);
  }
  function formatLon(value, format = 'dms') {
    if (format === 'dd') return formatDecimal(value) + '°';
    if (format === 'dmm') return formatDMM(value, false);
    return formatDMS(value, false);
  }

  /** Faz o parse de uma string de coordenada em vários formatos possíveis (DD, DMS, DMM). Aceita vírgula ou ponto como separador decimal. */
  function parseCoordString(str) {
    str = str.trim();
    // Decimal simples, ex: -10.725632, -10,725632 ou 10.725632
    const decMatch = str.match(/^-?\d+([.,]\d+)?°?$/);
    if (decMatch) return parseFloat(str.replace(',', '.'));

    // DMS, ex: 10°43'32.278"S, 10°43'32,278"S ou 10 43 32.278 S
    const dmsMatch = str.match(/(\d+)[°\s]+(\d+)['\s]+([\d.,]+)["\s]*([NSEWnsew])?/);
    if (dmsMatch) {
      const [, d, m, s, hemi] = dmsMatch;
      let val = parseFloat(d) + parseFloat(m) / 60 + parseFloat(s.replace(',', '.')) / 3600;
      if (hemi && /[SWsw]/.test(hemi)) val = -val;
      return val;
    }
    // DMM, ex: 10°43.538'S ou 10°43,538'S
    const dmmMatch = str.match(/(\d+)[°\s]+([\d.,]+)['\s]*([NSEWnsew])?/);
    if (dmmMatch) {
      const [, d, m, hemi] = dmmMatch;
      let val = parseFloat(d) + parseFloat(m.replace(',', '.')) / 60;
      if (hemi && /[SWsw]/.test(hemi)) val = -val;
      return val;
    }
    return NaN;
  }

  /** Distância geodésica (m) via fórmula de Haversine — precisão suficiente para uso de campo. */
  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371008.8; // raio médio da Terra (m)
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /** Azimute inicial (graus, 0-360, 0 = Norte) do ponto 1 para o ponto 2. */
  function azimuth(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    let brng = (Math.atan2(y, x) * 180) / Math.PI;
    return (brng + 360) % 360;
  }

  /** Converte azimute (graus) para ponto cardinal textual (N, NE, E, SE, S, SO, O, NO). */
  function azimuthToCardinal(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    const idx = Math.round(deg / 45) % 8;
    return dirs[idx];
  }

  /** Formata azimute como graus/min/seg: N 42°32'15"E (estilo topográfico simplificado). */
  function azimuthDMS(deg) {
    const d = Math.floor(deg);
    const mFloat = (deg - d) * 60;
    const m = Math.floor(mFloat);
    const s = Math.round((mFloat - m) * 60);
    return `${d}° ${String(m).padStart(2, '0')}' ${String(s).padStart(2, '0')}"`;
  }

  /**
   * Área geodésica aproximada de um polígono (lat/lon) pela fórmula do
   * excesso esférico (shoelace projetada). Adequada para áreas de trabalho
   * de campo (até centenas de km²); para grandes extensões recomenda-se
   * levantamento com projeção local apropriada.
   */
  function polygonArea(latlngs) {
    if (latlngs.length < 3) return 0;
    const R = 6378137; // raio equatorial WGS84 (m)
    const toRad = (d) => (d * Math.PI) / 180;
    let total = 0;
    for (let i = 0; i < latlngs.length; i++) {
      const p1 = latlngs[i];
      const p2 = latlngs[(i + 1) % latlngs.length];
      total += toRad(p2.lng - p1.lng) * (2 + Math.sin(toRad(p1.lat)) + Math.sin(toRad(p2.lat)));
    }
    return Math.abs((total * R * R) / 2);
  }

  /** Perímetro (m) de um polígono/linha lat/lon. */
  function polygonPerimeter(latlngs, closed = true) {
    let total = 0;
    const n = latlngs.length;
    const limit = closed ? n : n - 1;
    for (let i = 0; i < limit; i++) {
      const p1 = latlngs[i];
      const p2 = latlngs[(i + 1) % n];
      total += haversineDistance(p1.lat, p1.lng, p2.lat, p2.lng);
    }
    return total;
  }

  /** Converte m² para a unidade desejada. */
  function convertArea(m2, unit = 'ha') {
    if (unit === 'ha') return m2 / 10000;
    if (unit === 'km2') return m2 / 1e6;
    return m2; // m2
  }

  function convertDistance(m, unit = 'm') {
    if (unit === 'km') return m / 1000;
    return m;
  }

  window.Coordinates = {
    utmZoneFromLon,
    toUTM,
    fromUTM,
    customToLatLon,
    decToDMS,
    formatDMS,
    formatDMM,
    formatDecimal,
    formatLat,
    formatLon,
    parseCoordString,
    haversineDistance,
    azimuth,
    azimuthToCardinal,
    azimuthDMS,
    polygonArea,
    polygonPerimeter,
    convertArea,
    convertDistance,
  };
})();
