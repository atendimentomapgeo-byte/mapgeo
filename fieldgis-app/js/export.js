/**
 * export.js
 * -----------------------------------------------------------------------
 * Exportação de dados para formatos padrão do mercado (CSV, GeoJSON, KML,
 * GPX) e backup/restauração completa do projeto no formato proprietário
 * `.fieldgis` (na verdade um arquivo ZIP renomeado, contendo um JSON com
 * todos os dados estruturados + as fotografias em uma subpasta).
 */

(function () {
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function pointsToGeoJSON(points) {
    return {
      type: 'FeatureCollection',
      features: points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat, p.alt || 0] },
        properties: Object.assign({ name: p.name, code: p.code, description: p.description, accuracy: p.accuracy, capturedAt: p.capturedAt }, p.attributes || {}),
      })),
    };
  }

  function tracksToGeoJSON(tracks) {
    return {
      type: 'FeatureCollection',
      features: tracks.map((t) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: t.points.map((p) => [p.lon, p.lat, p.alt || 0]) },
        properties: { name: t.name, distance: t.stats.distance, duration: t.stats.duration },
      })),
    };
  }

  function polygonsToGeoJSON(polygons) {
    return {
      type: 'FeatureCollection',
      features: polygons.map((pg) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [pg.vertices.concat([pg.vertices[0]]).map((v) => [v.lon, v.lat])] },
        properties: Object.assign({ name: pg.name, area_m2: pg.area, area_ha: Coordinates.convertArea(pg.area, 'ha'), perimeter_m: pg.perimeter }, pg.attributes || {}),
      })),
    };
  }

  function pointsToCSV(points, datum = 'SIRGAS2000') {
    const attrKeys = new Set();
    points.forEach((p) => Object.keys(p.attributes || {}).forEach((k) => attrKeys.add(k)));
    const attrCols = Array.from(attrKeys);
    const header = ['name', 'code', 'lat', 'lon', 'utm_e', 'utm_n', 'utm_zone', 'alt', 'accuracy', 'capturedAt', 'description', ...attrCols];
    const lines = [header.join(',')];
    for (const p of points) {
      const utm = Coordinates.toUTM(p.lat, p.lon, datum);
      const row = [
        p.name,
        p.code || '',
        p.lat.toFixed(8),
        p.lon.toFixed(8),
        utm.easting.toFixed(2),
        utm.northing.toFixed(2),
        utm.label,
        p.alt != null ? p.alt.toFixed(2) : '',
        p.accuracy != null ? p.accuracy.toFixed(2) : '',
        p.capturedAt || '',
        (p.description || '').replace(/,/g, ';'),
        ...attrCols.map((k) => String((p.attributes || {})[k] ?? '').replace(/,/g, ';')),
      ];
      lines.push(row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    return lines.join('\n');
  }

  function coordsToKML(name, coords, closed) {
    return coords.map(([lon, lat, alt]) => `${lon},${lat},${alt || 0}`).join(' ') + (closed ? ` ${coords[0][0]},${coords[0][1]},${coords[0][2] || 0}` : '');
  }

  function pointsToKML(points) {
    const placemarks = points
      .map(
        (p) => `  <Placemark>
    <name>${escapeXML(p.name)}</name>
    <description>${escapeXML(p.description || '')}</description>
    <Point><coordinates>${p.lon},${p.lat},${p.alt || 0}</coordinates></Point>
  </Placemark>`
      )
      .join('\n');
    return kmlWrap(placemarks);
  }

  function tracksToKML(tracks) {
    const placemarks = tracks
      .map(
        (t) => `  <Placemark>
    <name>${escapeXML(t.name)}</name>
    <LineString><coordinates>${t.points.map((p) => `${p.lon},${p.lat},${p.alt || 0}`).join(' ')}</coordinates></LineString>
  </Placemark>`
      )
      .join('\n');
    return kmlWrap(placemarks);
  }

  function polygonsToKML(polygons) {
    const placemarks = polygons
      .map((pg) => {
        const ring = pg.vertices.concat([pg.vertices[0]]).map((v) => `${v.lon},${v.lat},0`).join(' ');
        return `  <Placemark>
    <name>${escapeXML(pg.name)}</name>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>`;
      })
      .join('\n');
    return kmlWrap(placemarks);
  }

  function kmlWrap(inner) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
${inner}
</Document>
</kml>`;
  }

  function escapeXML(str) {
    return String(str || '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  }

  function tracksToGPX(tracks) {
    const trks = tracks
      .map(
        (t) => `  <trk><name>${escapeXML(t.name)}</name><trkseg>
${t.points.map((p) => `    <trkpt lat="${p.lat}" lon="${p.lon}">${p.alt != null ? `<ele>${p.alt}</ele>` : ''}${p.time ? `<time>${new Date(p.time).toISOString()}</time>` : ''}</trkpt>`).join('\n')}
  </trkseg></trk>`
      )
      .join('\n');
    return gpxWrap(trks);
  }

  function pointsToGPX(points) {
    const wpts = points
      .map((p) => `  <wpt lat="${p.lat}" lon="${p.lon}">${p.alt != null ? `<ele>${p.alt}</ele>` : ''}<name>${escapeXML(p.name)}</name><desc>${escapeXML(p.description || '')}</desc></wpt>`)
      .join('\n');
    return gpxWrap(wpts);
  }

  function gpxWrap(inner) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FieldGIS" xmlns="http://www.topografix.com/GPX/1/1">
${inner}
</gpx>`;
  }

  const Exporter = {
    downloadBlob,
    exportPointsCSV(points, datum) {
      downloadBlob(new Blob([pointsToCSV(points, datum)], { type: 'text/csv' }), `pontos_${dateTag()}.csv`);
    },
    exportPointsGeoJSON(points) {
      downloadBlob(new Blob([JSON.stringify(pointsToGeoJSON(points), null, 2)], { type: 'application/geo+json' }), `pontos_${dateTag()}.geojson`);
    },
    exportPointsKML(points) {
      downloadBlob(new Blob([pointsToKML(points)], { type: 'application/vnd.google-earth.kml+xml' }), `pontos_${dateTag()}.kml`);
    },
    exportPointsGPX(points) {
      downloadBlob(new Blob([pointsToGPX(points)], { type: 'application/gpx+xml' }), `pontos_${dateTag()}.gpx`);
    },
    exportTracksGeoJSON(tracks) {
      downloadBlob(new Blob([JSON.stringify(tracksToGeoJSON(tracks), null, 2)], { type: 'application/geo+json' }), `trilhas_${dateTag()}.geojson`);
    },
    exportTracksKML(tracks) {
      downloadBlob(new Blob([tracksToKML(tracks)], { type: 'application/vnd.google-earth.kml+xml' }), `trilhas_${dateTag()}.kml`);
    },
    exportTracksGPX(tracks) {
      downloadBlob(new Blob([tracksToGPX(tracks)], { type: 'application/gpx+xml' }), `trilhas_${dateTag()}.gpx`);
    },
    exportPolygonsGeoJSON(polygons) {
      downloadBlob(new Blob([JSON.stringify(polygonsToGeoJSON(polygons), null, 2)], { type: 'application/geo+json' }), `poligonos_${dateTag()}.geojson`);
    },
    exportPolygonsKML(polygons) {
      downloadBlob(new Blob([polygonsToKML(polygons)], { type: 'application/vnd.google-earth.kml+xml' }), `poligonos_${dateTag()}.kml`);
    },

    /** Exporta o backup/projeto completo em um arquivo .fieldgis (ZIP renomeado). */
    async exportProject(projectId) {
      const project = await Projects.get(projectId);
      const [maps, layers, points, tracks, polygons, photos, forms] = await Promise.all([
        DB.byProject('maps', projectId),
        DB.byProject('layers', projectId),
        DB.byProject('points', projectId),
        DB.byProject('tracks', projectId),
        DB.byProject('polygons', projectId),
        DB.byProject('photos', projectId),
        DB.byProject('forms', projectId),
      ]);
      const blobs = await DB.byProject('blobs', projectId);
      const settings = await DB.getSettings();

      const zip = new JSZip();
      const manifest = {
        format: 'FIELDGIS',
        version: 1,
        exportedAt: new Date().toISOString(),
        project,
        layers,
        points,
        tracks,
        polygons,
        forms,
        settings,
        photoIndex: photos.map((p) => ({ id: p.id, pointId: p.pointId, lat: p.lat, lon: p.lon, alt: p.alt, takenAt: p.takenAt, file: `photos/${p.id}.jpg` })),
        blobIndex: blobs.map((b) => ({ id: b.id, kind: b.kind, meta: b.meta, file: `blobs/${b.id}.bin` })),
      };
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      const photoFolder = zip.folder('photos');
      for (const p of photos) photoFolder.file(`${p.id}.jpg`, p.blob);
      const blobFolder = zip.folder('blobs');
      for (const b of blobs) blobFolder.file(`${b.id}.bin`, b.blob);

      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      downloadBlob(zipBlob, `${slugify(project.name)}_${dateTag()}.fieldgis`);
    },

    /** Restaura um projeto a partir de um arquivo .fieldgis exportado anteriormente. */
    async importProjectBackup(file) {
      const zip = await JSZip.loadAsync(file);
      const manifestText = await zip.file('manifest.json').async('text');
      const manifest = JSON.parse(manifestText);
      if (manifest.format !== 'FIELDGIS') throw new Error('Arquivo de backup inválido ou incompatível.');

      const newProject = await DB.put('projects', { name: manifest.project.name + ' (restaurado)', description: manifest.project.description });
      const layerIdMap = {};
      for (const l of manifest.layers) {
        const nl = await DB.put('layers', Object.assign({}, l, { id: undefined, projectId: newProject.id }));
        layerIdMap[l.id] = nl.id;
      }
      const pointIdMap = {};
      for (const p of manifest.points) {
        const np = await DB.put('points', Object.assign({}, p, { id: undefined, projectId: newProject.id, layerId: layerIdMap[p.layerId] }));
        pointIdMap[p.id] = np.id;
      }
      for (const t of manifest.tracks) {
        await DB.put('tracks', Object.assign({}, t, { id: undefined, projectId: newProject.id, layerId: layerIdMap[t.layerId] }));
      }
      for (const pg of manifest.polygons) {
        await DB.put('polygons', Object.assign({}, pg, { id: undefined, projectId: newProject.id, layerId: layerIdMap[pg.layerId] }));
      }
      for (const f of manifest.forms || []) {
        await DB.put('forms', Object.assign({}, f, { id: undefined, projectId: newProject.id }));
      }
      for (const ph of manifest.photoIndex || []) {
        const blob = await zip.file(ph.file).async('blob');
        await DB.put('photos', { projectId: newProject.id, pointId: pointIdMap[ph.pointId], blob, lat: ph.lat, lon: ph.lon, alt: ph.alt, takenAt: ph.takenAt });
      }
      for (const b of manifest.blobIndex || []) {
        const blob = await zip.file(b.file).async('blob');
        await DB.put('blobs', { projectId: newProject.id, kind: b.kind, meta: b.meta, blob });
      }
      return newProject;
    },

    /** Backup rápido de TODOS os projetos do aplicativo em um único arquivo. */
    async fullBackup() {
      const projects = await Projects.list();
      const zip = new JSZip();
      for (const p of projects) {
        // reaproveita exportProject por projeto, mas empacota tudo junto
      }
      // Para simplicidade e robustez, o backup completo gera um .fieldgis por projeto,
      // compactados juntos em um único arquivo .zip de backup geral.
      for (const p of projects) {
        const singleZip = new JSZip();
        await Exporter._fillProjectZip(singleZip, p.id);
        const blob = await singleZip.generateAsync({ type: 'blob' });
        zip.file(`${slugify(p.name)}.fieldgis`, blob);
      }
      const finalBlob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(finalBlob, `backup_${dateTag()}.zip`);
    },

    async _fillProjectZip(zip, projectId) {
      const project = await Projects.get(projectId);
      const [layers, points, tracks, polygons, photos, forms, blobs] = await Promise.all([
        DB.byProject('layers', projectId),
        DB.byProject('points', projectId),
        DB.byProject('tracks', projectId),
        DB.byProject('polygons', projectId),
        DB.byProject('photos', projectId),
        DB.byProject('forms', projectId),
        DB.byProject('blobs', projectId),
      ]);
      const manifest = { format: 'FIELDGIS', version: 1, exportedAt: new Date().toISOString(), project, layers, points, tracks, polygons, forms, photoIndex: photos.map((p) => ({ id: p.id, pointId: p.pointId, lat: p.lat, lon: p.lon, alt: p.alt, takenAt: p.takenAt, file: `photos/${p.id}.jpg` })), blobIndex: blobs.map((b) => ({ id: b.id, kind: b.kind, meta: b.meta, file: `blobs/${b.id}.bin` })) };
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      const pf = zip.folder('photos');
      photos.forEach((p) => pf.file(`${p.id}.jpg`, p.blob));
      const bf = zip.folder('blobs');
      blobs.forEach((b) => bf.file(`${b.id}.bin`, b.blob));
    },
  };

  function dateTag() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function slugify(str) {
    return String(str || 'projeto').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  window.Exporter = Exporter;
})();
