/**
 * service-worker.js
 * -----------------------------------------------------------------------
 * Cache offline do aplicativo (application shell) usando a estratégia
 * "cache first, falling back to network". Após a primeira visita, todo o
 * HTML/CSS/JS e as bibliotecas vendorizadas ficam disponíveis mesmo sem
 * nenhuma conexão de rede.
 *
 * IMPORTANTE: mapas georreferenciados, fotos, pontos, trilhas e polígonos
 * NÃO passam pelo Service Worker — eles ficam gravados diretamente no
 * IndexedDB (ver database.js), que é persistente e não depende de cache
 * de rede. O Service Worker cuida apenas dos arquivos do próprio aplicativo.
 */

const CACHE_NAME = 'fieldgis-cache-v28';
const TILES_CACHE_NAME = 'fieldgis-tiles-v1';
const TILES_CACHE_MAX_ENTRADAS = 6000; // limite aproximado para não estourar o armazenamento do navegador

// Reconhece requisições de tiles de mapa (qualquer servidor, padrão .../{z}/{x}/{y}
// ou .../{z}/{y}/{x}), independentemente do domínio — cobre OpenStreetMap, Esri
// World Imagery e qualquer outro provedor XYZ que venha a ser adicionado depois.
function ehRequisicaoDeTile(url) {
  return /\/\d{1,2}\/\d{1,7}\/\d{1,7}(\.[a-z]{3,4})?(\?.*)?$/i.test(url);
}

/** Remove as entradas mais antigas do cache de tiles quando ele cresce demais. */
async function limitarCacheDeTiles() {
  const cache = await caches.open(TILES_CACHE_NAME);
  const keys = await cache.keys();
  if (keys.length > TILES_CACHE_MAX_ENTRADAS) {
    const excedente = keys.length - TILES_CACHE_MAX_ENTRADAS;
    for (let i = 0; i < excedente; i++) {
      await cache.delete(keys[i]);
    }
  }
}

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/mobile.css',
  './js/database.js',
  './js/coordinates.js',
  './js/gps.js',
  './js/compass.js',
  './js/map.js',
  './js/camera.js',
  './js/points.js',
  './js/tracks.js',
  './js/polygons.js',
  './js/navigation.js',
  './js/layers.js',
  './js/projects.js',
  './js/import.js',
  './js/export.js',
  './js/offline.js',
  './js/app.js',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/proj4.js',
  './vendor/jszip.min.js',
  './vendor/togeojson.js',
  './vendor/geotiff.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/images/marker-icon.png',
  './vendor/images/marker-icon-2x.png',
  './vendor/images/marker-shadow.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Usamos fetch manual com {cache:'reload'} em vez de cache.addAll()
      // de propósito: cache.addAll() por padrão respeita o cache HTTP normal
      // do navegador, então mesmo detectando corretamente que existe uma
      // versão nova do app, ele podia acabar recachando arquivos ANTIGOS que
      // ainda estivessem no cache HTTP (comum no GitHub Pages, que manda
      // Cache-Control com alguns minutos de validade). {cache:'reload'}
      // força uma busca genuinamente nova na rede para cada arquivo.
      const resultados = await Promise.allSettled(
        APP_SHELL.map(async (url) => {
          const resp = await fetch(url, { cache: 'reload' });
          if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
          return cache.put(url, resp);
        })
      );
      const falhas = resultados.filter((r) => r.status === 'rejected');
      if (falhas.length) {
        console.warn('[service-worker] Falha ao cachear alguns arquivos (não fatal):', falhas.map((f) => f.reason));
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== TILES_CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // Tiles de mapa (OSM, Esri, etc.): cache-first, salvando em cache dedicado.
  // Funciona mesmo entre domínios diferentes — usamos { mode: 'no-cors' } para
  // não sermos bloqueados por CORS (a resposta fica "opaca", mas o Cache API
  // aceita e reexibe normalmente como imagem).
  if (ehRequisicaoDeTile(url)) {
    event.respondWith(
      caches.open(TILES_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const response = await fetch(event.request.url, { mode: 'no-cors' });
          // Respostas opacas (cross-origin) têm status 0, mas ainda são válidas para exibir.
          if (response && (response.status === 200 || response.type === 'opaque')) {
            cache.put(event.request, response.clone());
            limitarCacheDeTiles();
          }
          return response;
        } catch (e) {
          // Offline e este tile específico nunca foi visitado antes: devolve
          // vazio (o Leaflet simplesmente deixa o quadradinho em branco).
          return new Response('', { status: 504, statusText: 'Tile indisponível offline.' });
        }
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          // Cacheia dinamicamente novos recursos do próprio app (mesma origem)
          if (response && response.status === 200 && event.request.url.startsWith(self.location.origin)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Sem rede e sem cache: se for navegação, devolve a shell principal.
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('', { status: 504, statusText: 'Offline e recurso não está em cache.' });
        });
    })
  );
});
