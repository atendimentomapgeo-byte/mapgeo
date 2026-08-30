/**
 * layers.js
 * -----------------------------------------------------------------------
 * Gerenciador de camadas do projeto atual: pontos, trilhas, polígonos e
 * mapas base importados são organizados em "camadas" que podem ser
 * ativadas/desativadas, ter sua transparência/cor/espessura ajustadas,
 * reordenadas e excluídas.
 */

(function () {
  const KIND_ICON = { points: '📍', tracks: '〰️', polygons: '⬠', raster: '🗺️' };

  const Layers = {
    async create(projectId, name, kind, style = {}) {
      const existing = await DB.byProject('layers', projectId);
      const layer = {
        projectId,
        name,
        kind, // 'points' | 'tracks' | 'polygons' | 'raster'
        visible: true,
        opacity: style.opacity ?? 1,
        color: style.color || '#1a73e8',
        weight: style.weight || 3,
        order: existing.length,
      };
      return DB.put('layers', layer);
    },

    async list(projectId) {
      const layers = await DB.byProject('layers', projectId);
      return layers.sort((a, b) => a.order - b.order);
    },

    async update(layer) {
      return DB.put('layers', layer);
    },

    async setVisible(layerId, visible) {
      const layer = await DB.get('layers', layerId);
      layer.visible = visible;
      return DB.put('layers', layer);
    },

    async setOpacity(layerId, opacity) {
      const layer = await DB.get('layers', layerId);
      layer.opacity = opacity;
      return DB.put('layers', layer);
    },

    async setStyle(layerId, { color, weight }) {
      const layer = await DB.get('layers', layerId);
      if (color) layer.color = color;
      if (weight) layer.weight = weight;
      return DB.put('layers', layer);
    },

    async reorder(projectId, orderedIds) {
      const layers = await Layers.list(projectId);
      const byId = Object.fromEntries(layers.map((l) => [l.id, l]));
      for (let i = 0; i < orderedIds.length; i++) {
        if (byId[orderedIds[i]]) {
          byId[orderedIds[i]].order = i;
          await DB.put('layers', byId[orderedIds[i]]);
        }
      }
    },

    /** Exclui a camada e todos os elementos vinculados a ela (pontos/trilhas/polígonos). */
    async delete(layerId) {
      const layer = await DB.get('layers', layerId);
      if (!layer) return;
      const stores = { points: 'points', tracks: 'tracks', polygons: 'polygons' };
      const store = stores[layer.kind];
      if (store) {
        const items = await DB.byIndex(store, 'layerId', layerId).catch(() => []);
        for (const it of items) await DB.delete(store, it.id);
      }
      return DB.delete('layers', layerId);
    },

    iconFor(kind) {
      return KIND_ICON[kind] || '📄';
    },
  };

  window.Layers = Layers;
})();
