/**
 * offline.js
 * -----------------------------------------------------------------------
 * Registro do Service Worker e monitoramento do estado de conectividade.
 * Também cuida da recuperação automática do último projeto aberto e de
 * avisos amigáveis relacionados a armazenamento/offline.
 */

(function () {
  // Precisa bater com TILES_CACHE_NAME em service-worker.js. Usamos um prefixo
  // (em vez do nome exato) para continuar funcionando mesmo se a versão do
  // cache mudar no futuro (ex.: 'fieldgis-tiles-v1' -> 'fieldgis-tiles-v2').
  const TILES_CACHE_PREFIX = 'fieldgis-tiles';

  const Offline = {
    status: navigator.onLine ? 'online' : 'offline',
    listeners: new Set(),

    init() {
      window.addEventListener('online', () => Offline._set('online'));
      window.addEventListener('offline', () => Offline._set('offline'));

      if ('serviceWorker' in navigator) {
        // Necessário servir via http(s):// (não funciona em file://). Documentado no README.
        //
        // updateViaCache:'none' é essencial ao hospedar no GitHub Pages: o
        // GitHub Pages manda cabeçalhos de cache HTTP normais nos arquivos
        // estáticos (alguns minutos de validade). Sem essa opção, o
        // navegador podia checar se o service-worker.js mudou usando uma
        // cópia em cache do PRÓPRIO ARQUIVO DE VERIFICAÇÃO, concluindo
        // erroneamente "nada mudou" mesmo depois de publicarmos uma versão
        // nova — exatamente o sintoma de "atualizei mas continua mostrando
        // a versão antiga". Com 'none', essa checagem específica sempre
        // busca a rede de verdade, ignorando qualquer cache HTTP.
        navigator.serviceWorker
          .register('service-worker.js', { updateViaCache: 'none' })
          .then((reg) => {
            console.log('[offline] Service worker registrado com sucesso.', reg.scope);

            // Força uma checagem de atualização agora (em vez de depender só
            // do timing automático do navegador, que às vezes só verifica
            // uma vez a cada 24h).
            reg.update().catch(() => {});

            // Se um novo service worker assumir o controle da página (após
            // uma atualização), recarrega automaticamente uma única vez —
            // assim o usuário não precisa lembrar de forçar fechar/reabrir
            // o app manualmente para ver a versão nova.
            let jaRecarregou = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
              if (jaRecarregou) return;
              jaRecarregou = true;
              location.reload();
            });
          })
          .catch((err) => {
            console.warn('[offline] Não foi possível registrar o service worker (normal se aberto via file://).', err);
          });
      }
    },

    _set(status) {
      Offline.status = status;
      Offline.listeners.forEach((cb) => cb(status));
    },

    on(cb) {
      Offline.listeners.add(cb);
      return () => Offline.listeners.delete(cb);
    },

    isOnline() {
      return navigator.onLine;
    },

    async checkStorageWarning() {
      const estimate = await DB.estimateStorage();
      if (estimate && estimate.quota) {
        const usedPct = (estimate.usage / estimate.quota) * 100;
        if (usedPct > 90) {
          return `Atenção: o armazenamento local está ${usedPct.toFixed(0)}% ocupado. Vá em Configurações > "Limpar cache de mapas offline" ou exporte/exclua projetos antigos.`;
        }
      }
      return null;
    },

    /** Solicita armazenamento persistente ao navegador (evita que o sistema apague os dados sob pressão de espaço). */
    async requestPersistentStorage() {
      if (navigator.storage && navigator.storage.persist) {
        return navigator.storage.persist();
      }
      return false;
    },

    /**
     * Retorna informações sobre o cache de tiles de mapa (imagens de fundo
     * OSM/satélite) baixadas para uso offline: quantidade de tiles e uma
     * estimativa de espaço ocupado (quando o navegador suporta medir o
     * tamanho de cada resposta em cache).
     */
    async getTileCacheInfo() {
      if (!('caches' in window)) return { supported: false, count: 0, bytes: null };
      const names = await caches.keys();
      const tileCacheNames = names.filter((n) => n.startsWith(TILES_CACHE_PREFIX));
      if (!tileCacheNames.length) return { supported: true, count: 0, bytes: 0 };

      let count = 0;
      let bytes = 0;
      let bytesKnown = true;
      for (const name of tileCacheNames) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        count += requests.length;
        for (const req of requests) {
          try {
            const res = await cache.match(req);
            const blob = res && (await res.clone().blob());
            // Respostas "opacas" (cross-origin, sem CORS) reportam tamanho 0
            // mesmo tendo conteúdo real — nesse caso não dá pra confiar no total.
            if (blob && res.type !== 'opaque' && blob.size > 0) {
              bytes += blob.size;
            } else {
              bytesKnown = false;
            }
          } catch (e) {
            bytesKnown = false;
          }
        }
      }
      return { supported: true, count, bytes: bytesKnown ? bytes : null };
    },

    /** Apaga apenas o cache de tiles de mapa. NÃO afeta o cache do próprio app (HTML/JS/CSS) nem os dados salvos (IndexedDB: projetos, pontos, trilhas, polígonos, fotos). */
    async clearTileCache() {
      if (!('caches' in window)) return false;
      const names = await caches.keys();
      const tileCacheNames = names.filter((n) => n.startsWith(TILES_CACHE_PREFIX));
      for (const name of tileCacheNames) {
        await caches.delete(name);
      }
      return true;
    },
  };

  window.Offline = Offline;
})();
