/**
 * camera.js
 * -----------------------------------------------------------------------
 * Captura de fotografias de campo.
 *
 * Estratégia técnica: usamos um <input type="file" accept="image/*" capture="environment">
 * para acionar a câmera nativa do celular. Essa é a forma mais robusta e
 * universalmente compatível (Android Chrome e iPhone Safari) de acessar a
 * câmera a partir de uma PWA sem exigir permissões adicionais de mídia via
 * getUserMedia (que em iOS Safari tem suporte mais restrito em contexto de
 * PWA instalada). Como alternativa avançada, quando getUserMedia + Canvas
 * estiverem disponíveis, oferecemos também captura ao vivo dentro do app
 * (usada no modo "câmera embutida").
 *
 * Após a captura, a foto é associada automaticamente a:
 *   coordenada atual, altitude, data/hora, ponto e projeto.
 * Opcionalmente aplicamos uma marca d'água com essas informações,
 * desenhada diretamente no Canvas (sem libs externas).
 */

(function () {
  function captureViaInput() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        document.body.removeChild(input);
        if (file) resolve(file);
        else reject(new Error('Nenhuma fotografia foi capturada.'));
      });
      input.addEventListener('cancel', () => {
        document.body.removeChild(input);
        reject(new Error('Captura de fotografia cancelada.'));
      });
      input.click();
    });
  }

  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => resolve({ img, url });
      img.onerror = reject;
      img.src = url;
    });
  }

  /** Aplica marca d'água com coordenadas/data/hora/altitude/nome do ponto usando Canvas. */
  async function applyWatermark(file, info) {
    const { img, url } = await fileToImage(file);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    const lines = [
      info.pointName ? `Ponto: ${info.pointName}` : null,
      `Lat: ${info.latText}`,
      `Lon: ${info.lonText}`,
      info.altitude != null ? `Alt: ${info.altitude.toFixed(1)} m` : null,
      `Data: ${info.dateText}  Hora: ${info.timeText}`,
    ].filter(Boolean);

    const fontSize = Math.max(14, Math.round(canvas.width / 45));
    ctx.font = `${fontSize}px sans-serif`;
    const padding = fontSize * 0.6;
    const lineHeight = fontSize * 1.3;
    const boxHeight = lines.length * lineHeight + padding * 2;
    const boxWidth = Math.min(canvas.width - 20, Math.max(...lines.map((l) => ctx.measureText(l).width)) + padding * 2);

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(10, canvas.height - boxHeight - 10, boxWidth, boxHeight);

    ctx.fillStyle = '#ffffff';
    lines.forEach((line, i) => {
      ctx.fillText(line, 10 + padding, canvas.height - boxHeight - 10 + padding + (i + 1) * lineHeight - lineHeight * 0.3);
    });

    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9);
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  window.Camera = {
    isSupported() {
      return true; // input file+capture é suportado universalmente em navegadores móveis modernos
    },
    captureViaInput,
    applyWatermark,
    blobToDataURL,
  };
})();
