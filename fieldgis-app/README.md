# FieldGIS — Mapas e Navegação de Campo

Aplicativo web (PWA) profissional e independente de mapas, navegação GPS e coleta de dados de campo, para uso em geoprocessamento, topografia, manejo florestal e levantamento ambiental. Funciona **inteiramente offline** depois da primeira instalação, com identidade visual e código próprios (inspirado apenas no conceito funcional de apps como o Avenza Maps, sem reaproveitar marca, layout ou código de terceiros).

---

## 1. Estrutura do projeto

```
app/
├── index.html              # Estrutura da interface (telas, sheets, modais)
├── manifest.json            # Manifesto do PWA (ícones, cores, instalação)
├── service-worker.js        # Cache offline do aplicativo (application shell)
├── css/
│   ├── style.css             # Layout base, cores, componentes
│   └── mobile.css            # Responsividade, modo campo, menus de ação
├── js/
│   ├── database.js           # Camada IndexedDB (projetos, mapas, pontos, trilhas, polígonos, fotos, formulários, config)
│   ├── coordinates.js        # Conversões DD/DMS/UTM, datum SIRGAS2000/WGS84, distância/área/azimute geodésicos
│   ├── gps.js                 # Monitoramento GPS em tempo real (Geolocation API)
│   ├── map.js                 # Mapa (Leaflet), grade UTM, marcador de posição, mapas base
│   ├── camera.js              # Captura de fotografias + marca d'água
│   ├── points.js              # Registro/edição/busca de pontos de campo
│   ├── tracks.js              # Gravação de trilhas GPS (iniciar/pausar/finalizar)
│   ├── polygons.js            # Desenho de polígonos (manual/GPS) + medição de distância/área
│   ├── navigation.js          # Navegação "Ir para" + bússola
│   ├── layers.js              # Gerenciador de camadas
│   ├── projects.js            # Gerenciador de projetos + formulários customizados
│   ├── import.js              # Importação CSV/GeoJSON/KML/KMZ/GPX/GeoTIFF/PDF
│   ├── export.js              # Exportação CSV/GeoJSON/KML/GPX + backup .fieldgis
│   ├── offline.js             # Registro do Service Worker + status de conectividade
│   └── app.js                 # Controlador principal (liga a interface aos módulos)
├── vendor/                    # Bibliotecas de terceiros vendorizadas (funcionam 100% offline)
│   ├── leaflet.js / leaflet.css   # Motor de mapa (licença BSD)
│   ├── proj4.js                    # Conversões de sistemas de coordenadas
│   ├── jszip.min.js                # Leitura/escrita de KMZ e do formato .fieldgis
│   ├── togeojson.js                # Conversão KML/GPX → GeoJSON
│   ├── geotiff.js                  # Leitura de arquivos GeoTIFF
│   └── pdf.min.js / pdf.worker.min.js  # Renderização de PDF
└── assets/icons/               # Ícones do PWA (192, 512, maskable, splash)
```

Nenhuma biblioteca é carregada de CDN externo — todas ficam dentro de `vendor/` e são cacheadas pelo Service Worker, garantindo que o aplicativo continue funcionando sem absolutamente nenhuma conexão.

---

## 2. Como executar

O navegador exige que Service Worker e alguns recursos rodem via `http://` ou `https://` (não funciona abrindo o `index.html` direto com `file://`). Use qualquer servidor estático simples:

```bash
cd app
python3 -m http.server 8080
# ou: npx serve .
```

Depois acesse `http://localhost:8080` (ou o IP da sua máquina na rede local, para testar no celular).

Para uso real em campo, publique a pasta `app/` em qualquer hospedagem estática (GitHub Pages, Netlify, Vercel, um servidor Apache/Nginx, etc.). Depois do primeiro carregamento, o aplicativo pode ser usado totalmente offline.

---

## 3. Como instalar no celular ("Adicionar à tela inicial")

**Android (Chrome):**
1. Acesse a URL do aplicativo.
2. Toque no menu (⋮) do Chrome → **"Instalar aplicativo"** (ou "Adicionar à tela inicial").
3. O FieldGIS passa a abrir como um app independente, sem a barra de endereço do navegador.

**iPhone (Safari):**
1. Acesse a URL do aplicativo pelo Safari (obrigatoriamente o Safari, não funciona pelo Chrome no iOS).
2. Toque no ícone de compartilhamento (quadrado com seta) → **"Adicionar à Tela de Início"**.
3. O ícone do FieldGIS aparecerá na tela inicial e abrirá em modo standalone.

Depois de instalado uma vez com internet, todos os arquivos do aplicativo ficam salvos no aparelho (Service Worker) e os dados de campo ficam no banco local (IndexedDB) — nada depende de conexão a partir daí.

---

## 4. Uso offline (o mais importante)

- **Mapas, pontos, trilhas, polígonos, fotos e formulários** são gravados diretamente no **IndexedDB** do navegador — um banco de dados local que não depende de rede.
- O **Service Worker** guarda uma cópia de todos os arquivos do aplicativo (HTML/CSS/JS/bibliotecas), então o app abre normalmente mesmo em modo avião.
- O **GPS** usa a Geolocation API do navegador, que conversa diretamente com o receptor de satélite do aparelho — funciona em modo avião com localização habilitada, sem necessidade de dados móveis ou Wi-Fi.
- Isso foi testado de ponta a ponta: primeira visita online (o Service Worker instala e cacheia tudo) → depois o navegador é colocado 100% offline (sem nenhuma rede) → o aplicativo recarrega normalmente e continua funcional.

---

## 5. Como importar mapas e dados

Menu (☰) → **Importar**, ou toque em **➕ → Importar dados/mapa**.

| Formato | O que acontece |
|---|---|
| **CSV** | Abre um assistente: você escolhe as colunas de X/Y (ou Lat/Lon), o sistema de coordenadas (Geográfica ou UTM + zona/hemisfério/datum) e quais colunas extras viram atributos. |
| **GeoJSON** | Pontos, linhas e polígonos são importados diretamente como pontos/trilhas/polígonos do projeto. |
| **KML / KMZ** | Convertido internamente para GeoJSON (biblioteca togeojson) e importado da mesma forma. KMZ é descompactado automaticamente. |
| **GPX** | Waypoints viram pontos; tracks/rotas viram trilhas. |
| **GeoTIFF** | O app lê os metadados de georreferenciamento (GeoKeys) embutidos no arquivo, reprojeta a extensão para latitude/longitude (suporta SIRGAS2000 e WGS84 em UTM) e adiciona o raster como uma camada de mapa base. |
| **PDF / imagem** | Como PDFs georreferenciados de verdade (GeoPDF) são raros e o navegador não tem uma biblioteca padrão para lê-los, o app oferece um **assistente de georreferenciamento manual**: você indica 2 pontos de controle (posição no arquivo + coordenada real conhecida) e o app posiciona a imagem sobre o mapa. |

Cada mapa importado vira uma **camada** (ativar/desativar, opacidade, exclusão) no gerenciador de camadas.

---

## 6. Backup e restauração

Menu (☰) → **Backup / Restaurar**.

- **Backup deste projeto**: gera um arquivo `.fieldgis` (na prática, um `.zip`) com todos os pontos, trilhas, polígonos, atributos, formulários e fotografias do projeto atual.
- **Backup de todos os projetos**: gera um `.zip` contendo um `.fieldgis` de cada projeto.
- **Restaurar backup**: escolha um arquivo `.fieldgis` gerado anteriormente (deste aparelho ou de outro) para recriar o projeto por completo, incluindo as fotos.

Isso permite guardar uma cópia de segurança fora do aparelho e também transferir um projeto inteiro para outro celular/computador.

Também é possível exportar separadamente **pontos** (CSV, GeoJSON, KML, GPX), **trilhas** (GPX, KML, GeoJSON) e **polígonos** (KML, GeoJSON) para uso em outros softwares de SIG (QGIS, ArcGIS, Google Earth etc.).

---

## 7. Funcionalidades implementadas (MVP funcional real)

- Projetos isolados (mapas/pontos/trilhas/polígonos/fotos/formulários próprios de cada projeto), com backup/restauração completos.
- Mapa interativo (Leaflet) com zoom, pan, escala gráfica, grade UTM dinâmica, marcador de posição com precisão e rumo.
- GPS em tempo real: latitude/longitude, altitude, precisão, velocidade, direção, distância percorrida, indicador visual de qualidade do sinal (🟢🟡🔴).
- Coordenadas: Decimal / GMS / Graus-minutos decimais; UTM com zona/hemisfério automáticos; datum SIRGAS2000 e WGS84.
- Pontos de campo com atributos customizáveis (texto, número, decimal, data, hora, seleção, checkbox), fotografias com marca d'água opcional (coordenada/data/hora/altitude/nome do ponto) e descrição.
- Trilhas GPS: iniciar/pausar/continuar/finalizar, com distância, tempo, velocidade média/máxima e variação de altitude.
- Polígonos: desenho manual (toque no mapa) ou percorrendo a área com GPS; cálculo de área (m²/ha/km²) e perímetro.
- Ferramentas de medição de distância e área (sem precisar salvar).
- Navegação "Ir para" um ponto: distância, azimute, seta indicativa em tempo real; bússola por magnetômetro (`deviceorientation`) combinada com o rumo do GPS.
- Busca por nome, código ou coordenada.
- Gerenciador de camadas: visibilidade, opacidade, cor, renomear, excluir.
- Importação: CSV (com assistente), GeoJSON, KML/KMZ, GPX, GeoTIFF (georreferenciamento automático), PDF/imagem (georreferenciamento manual por pontos de controle).
- Exportação: CSV, GeoJSON, KML, GPX, backup completo `.fieldgis`.
- PWA completo: manifest, Service Worker com cache offline, ícones, instalável em Android/iPhone/desktop.
- Modo Campo: tela simplificada com botões grandes para uso com uma mão.
- Configurações: precisão/distância mínima de GPS, datum, formato de coordenadas, grade, rotação do mapa, marca d'água, unidades.

## 8. Funcionalidades parcialmente implementadas

- **Rotação do mapa por bússola**: o Leaflet não suporta nativamente girar o "mundo" (tiles/overlays) sem um plugin pesado. Implementamos rotação visual do container via CSS, desativando o arraste manual enquanto ativa (o mapa se recentraliza automaticamente no GPS). A seta de posição/rumo sempre gira corretamente, independente desse modo.
- **GeoTIFF com rotação/skew**: se o arquivo tiver `ModelTransformation` com componente de rotação, o app assume um retângulo alinhado a lat/lon (aproximação). Suficiente para a grande maioria dos ortomosaicos e cartas de campo, que costumam ser exportados alinhados ao norte.
- **PDF/imagem georreferenciada**: usa transformação afim simples (escala + translação, sem rotação) a partir de 2 pontos de controle. Para plantas/mapas rotacionados em relação ao norte, seria necessário um terceiro ponto de controle e reamostragem da imagem (não implementado nesta versão).
- **Precisão do sinal GPS**: navegadores não expõem número de satélites nem relação sinal/ruído (isso só existe em apps nativos). A "qualidade do sinal" exibida é inferida a partir da precisão horizontal (accuracy) reportada pela Geolocation API — a melhor aproximação possível dentro de um navegador.
- **Formulários customizados**: por simplicidade, cada projeto tem um único formulário de atributos ("Padrão") aplicado a todos os pontos, em vez de um formulário por camada/categoria.

## 9. Limitações técnicas do navegador (documentadas, não contornáveis)

- Não é possível ler PDFs geoespaciais (GeoPDF) nativamente — não existe biblioteca padrão de navegador para isso; por isso o georreferenciamento manual.
- iOS Safari exige que a permissão do magnetômetro (`DeviceOrientationEvent.requestPermission()`) seja solicitada a partir de um toque do usuário — o app já faz isso ao ativar a navegação/bússola.
- Datum SIRGAS2000 é tratado como equivalente a WGS84 para fins de exibição em campo (diferença de poucos centímetros no Brasil) — para geodésia de precisão milimétrica seriam necessários parâmetros oficiais de transformação (IBGE/PROGRID), fora do escopo de um app em navegador.
- O File System Access API (edição de arquivos diretamente no disco) só existe no Chrome/Edge desktop; no celular, importação/exportação usam sempre a caixa de diálogo padrão de arquivos do sistema.

## 10. Compatibilidade testada

Testado de ponta a ponta em ambiente automatizado (Chromium/Playwright) cobrindo: criação de projeto, GPS, criação de ponto com atributos e coordenadas, camadas, medição de distância/área, trilha, polígono manual, configurações, importação CSV/GPX/KML/GeoTIFF/imagem georreferenciada, busca, e recarregamento 100% offline (Service Worker) — sem nenhum erro de JavaScript. Recomenda-se validação adicional em aparelhos Android/iPhone reais antes do uso profissional em campo (especialmente GPS, câmera e sensores de orientação, que variam entre fabricantes).

## 11. Próximos módulos recomendados

- Suporte a múltiplas bandas/composições coloridas para GeoTIFF multiespectral.
- Georreferenciamento por 3+ pontos de controle com rotação/reamostragem para PDF e imagens.
- Formulários por camada (em vez de um único formulário por projeto).
- Modo de sincronização opcional (quando online) para consolidar dados coletados em múltiplos aparelhos.
- Suporte a outros datums/EPSG via entrada direta de parâmetros proj4 customizados na tela de configurações.
- Exportação direta para Shapefile (.shp) — atualmente não incluída por exigir uma biblioteca adicional relativamente pesada para o formato binário.

---

## 12. Aviso legal/identidade

O FieldGIS foi desenvolvido do zero, com interface, paleta de cores, ícones e código próprios. O Avenza Maps foi usado apenas como referência de **conceito** e conjunto de funcionalidades — nenhuma marca, layout, ícone ou linha de código de aplicativos de terceiros foi copiada.
