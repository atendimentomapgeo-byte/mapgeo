/**
 * projects.js
 * -----------------------------------------------------------------------
 * Gerenciamento de projetos (cada projeto é isolado: possui seus próprios
 * mapas, camadas, pontos, trilhas, polígonos, fotografias e formulários).
 * Também gerencia os formulários customizados de atributos.
 */

(function () {
  let currentProjectId = null;

  const Projects = {
    async create(name, description = '') {
      const project = { name, description };
      const saved = await DB.put('projects', project);
      // Cria camadas padrão para começar a trabalhar imediatamente
      await Layers.create(saved.id, 'Pontos de coleta', 'points', { color: '#1a73e8' });
      await Layers.create(saved.id, 'Trilhas', 'tracks', { color: '#e53935' });
      await Layers.create(saved.id, 'Polígonos', 'polygons', { color: '#2e7d32' });
      return saved;
    },

    async list() {
      const all = await DB.all('projects');
      return all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    },

    async get(id) {
      return DB.get('projects', id);
    },

    async rename(id, name, description) {
      const p = await DB.get('projects', id);
      p.name = name;
      if (description != null) p.description = description;
      return DB.put('projects', p);
    },

    async remove(id) {
      return DB.deleteProjectCascade(id);
    },

    setCurrent(id) {
      currentProjectId = id;
      localStorage.setItem('fieldgis:lastProject', id);
    },

    getCurrent() {
      if (!currentProjectId) {
        currentProjectId = localStorage.getItem('fieldgis:lastProject');
      }
      return currentProjectId;
    },

    /** Resumo com contagem de elementos, usado na tela "Meus Projetos". */
    async summary(projectId) {
      const [maps, points, tracks, polygons, photos] = await Promise.all([
        DB.byProject('maps', projectId),
        DB.byProject('points', projectId),
        DB.byProject('tracks', projectId),
        DB.byProject('polygons', projectId),
        DB.byProject('photos', projectId),
      ]);
      return {
        maps: maps.length,
        points: points.length,
        tracks: tracks.length,
        polygons: polygons.length,
        photos: photos.length,
      };
    },

    // ---------------- Formulários customizados ----------------
    async createForm(projectId, name, fields) {
      return DB.put('forms', { projectId, name, fields });
    },

    async listForms(projectId) {
      return DB.byProject('forms', projectId);
    },

    async updateForm(form) {
      return DB.put('forms', form);
    },

    async deleteForm(id) {
      return DB.delete('forms', id);
    },
  };

  window.Projects = Projects;
})();
