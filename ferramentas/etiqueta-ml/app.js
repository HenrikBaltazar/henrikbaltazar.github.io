const PDFJS_CDN_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build';
const STORAGE_KEY = 'etiqueta-ml-settings-v1';
const MM_TO_PT = 72 / 25.4;

const DEFAULT_SETTINGS = {
  autoPrint: true,
  skipSummaryPages: true,
  dropLastPage: true,
  splitMultiLabels: true,
  widthMm: 100,
  heightMm: 150,
  marginMm: 2,
  printMode: 'pdf',
};

const els = {
  dropOverlay: document.getElementById('drop-overlay'),
  dropzone: document.getElementById('dropzone'),
  pdfInput: document.getElementById('pdf-input'),
  statusBanner: document.getElementById('status-banner'),
  statusIcon: document.getElementById('status-icon'),
  statusTitle: document.getElementById('status-title'),
  statusDetail: document.getElementById('status-detail'),
  resultSection: document.getElementById('result-section'),
  resultMeta: document.getElementById('result-meta'),
  previewGrid: document.getElementById('preview-grid'),
  btnPrint: document.getElementById('btn-print'),
  btnDownload: document.getElementById('btn-download'),
  btnOpen: document.getElementById('btn-open'),
  btnClear: document.getElementById('btn-clear'),
  btnResetSettings: document.getElementById('btn-reset-settings'),
  settingsForm: document.getElementById('settings-form'),
  settingsSummaryMeta: document.getElementById('settings-summary-meta'),
  optAutoPrint: document.getElementById('opt-auto-print'),
  optSkipSummary: document.getElementById('opt-skip-summary'),
  optDropLast: document.getElementById('opt-drop-last'),
  optSplitMulti: document.getElementById('opt-split-multi'),
  optWidth: document.getElementById('opt-width'),
  optHeight: document.getElementById('opt-height'),
  optMargin: document.getElementById('opt-margin'),
  optPrintMode: document.getElementById('opt-print-mode'),
  printSheet: document.getElementById('print-sheet'),
  printFrame: document.getElementById('print-frame'),
};

let settings = loadSettings();
let pdfjsLibPromise = null;
let loadedFiles = []; // [{ name, bytes: Uint8Array }]
let currentResult = null; // { pdfBytes, pdfUrl, fileName, labelCount, skippedPages, pageImages }
let printFrameLoadedUrl = null;
let dragDepth = 0;

/* -------------------- Initialization -------------------- */

applySettingsToForm();
syncDynamicPageStyle();
bindEvents();

// Pre-warm pdf.js in background so the very first drop feels instantaneous
getPdfJs().catch(() => {});

function bindEvents() {
  els.pdfInput.addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length > 0) {
      handleIncomingFiles(files);
    }
  });

  // Dropzone local highlight
  els.dropzone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    els.dropzone.classList.add('is-dragover');
  });

  els.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropzone.classList.add('is-dragover');
  });

  els.dropzone.addEventListener('dragleave', () => {
    els.dropzone.classList.remove('is-dragover');
  });

  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('is-dragover');
    hideDropOverlay();
    const files = extractPdfFiles(e.dataTransfer?.files);
    if (files.length > 0) {
      handleIncomingFiles(files);
    } else if (e.dataTransfer?.files?.length) {
      setStatus('error', 'Arquivo inválido', 'Envie apenas arquivos no formato PDF (.pdf).');
    }
  });

  // Full-window drag & drop
  window.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    els.dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
  });

  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      els.dropOverlay.hidden = true;
    }
  });

  window.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    hideDropOverlay();
    // Avoid double handling if dropped directly onto #dropzone
    if (els.dropzone.contains(e.target)) return;
    const files = extractPdfFiles(e.dataTransfer?.files);
    if (files.length > 0) {
      handleIncomingFiles(files);
    } else if (e.dataTransfer?.files?.length) {
      setStatus('error', 'Arquivo inválido', 'Envie apenas arquivos no formato PDF (.pdf).');
    }
  });

  // Paste PDF via Ctrl+V
  window.addEventListener('paste', (e) => {
    const files = extractPdfFiles(e.clipboardData?.files);
    if (files.length > 0) {
      e.preventDefault();
      handleIncomingFiles(files);
    }
  });

  // Intercept Ctrl+P / Cmd+P to print the cropped label directly
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && currentResult) {
      e.preventDefault();
      printCurrentResult();
    }
  });

  // Action buttons
  els.btnPrint.addEventListener('click', () => {
    if (currentResult) printCurrentResult();
  });

  els.btnDownload.addEventListener('click', () => {
    if (currentResult) downloadCurrentPdf();
  });

  els.btnOpen.addEventListener('click', () => {
    if (currentResult) {
      window.open(currentResult.pdfUrl, '_blank', 'noopener');
    }
  });

  els.btnClear.addEventListener('click', () => {
    clearCurrentState();
  });

  // Settings change listeners
  els.settingsForm.addEventListener('change', () => {
    settings = readSettingsFromForm();
    saveSettings(settings);
    updateSettingsSummaryMeta();
    syncDynamicPageStyle();
    if (loadedFiles.length > 0) {
      processLoadedFiles({ triggerAutoPrint: false });
    }
  });

  els.btnResetSettings.addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings(settings);
    applySettingsToForm();
    syncDynamicPageStyle();
    if (loadedFiles.length > 0) {
      processLoadedFiles({ triggerAutoPrint: false });
    }
  });
}

function hideDropOverlay() {
  dragDepth = 0;
  els.dropOverlay.hidden = true;
}

function hasDraggedFiles(event) {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes('Files'));
}

function extractPdfFiles(fileList) {
  if (!fileList) return [];
  return Array.from(fileList).filter(
    (file) =>
      file.type === 'application/pdf' ||
      file.name.toLowerCase().endsWith('.pdf')
  );
}

/* -------------------- Settings Persistence -------------------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      widthMm: clampNumber(parsed.widthMm, 40, 210, DEFAULT_SETTINGS.widthMm),
      heightMm: clampNumber(parsed.heightMm, 40, 297, DEFAULT_SETTINGS.heightMm),
      marginMm: clampNumber(parsed.marginMm, 0, 15, DEFAULT_SETTINGS.marginMm),
      printMode: parsed.printMode === 'page' ? 'page' : 'pdf',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota / private mode errors
  }
}

function applySettingsToForm() {
  els.optAutoPrint.checked = settings.autoPrint;
  els.optSkipSummary.checked = settings.skipSummaryPages;
  els.optDropLast.checked = settings.dropLastPage;
  els.optSplitMulti.checked = settings.splitMultiLabels;
  els.optWidth.value = String(settings.widthMm);
  els.optHeight.value = String(settings.heightMm);
  els.optMargin.value = String(settings.marginMm);
  els.optPrintMode.value = settings.printMode;
  updateSettingsSummaryMeta();
}

function readSettingsFromForm() {
  return {
    autoPrint: els.optAutoPrint.checked,
    skipSummaryPages: els.optSkipSummary.checked,
    dropLastPage: els.optDropLast.checked,
    splitMultiLabels: els.optSplitMulti.checked,
    widthMm: clampNumber(els.optWidth.value, 40, 210, DEFAULT_SETTINGS.widthMm),
    heightMm: clampNumber(els.optHeight.value, 40, 297, DEFAULT_SETTINGS.heightMm),
    marginMm: clampNumber(els.optMargin.value, 0, 15, DEFAULT_SETTINGS.marginMm),
    printMode: els.optPrintMode.value === 'page' ? 'page' : 'pdf',
  };
}

function updateSettingsSummaryMeta() {
  const autoLabel = settings.autoPrint ? 'Auto-imprimir ligado' : 'Auto-imprimir desligado';
  els.settingsSummaryMeta.textContent = `${settings.widthMm}×${settings.heightMm}mm · ${autoLabel}`;
  const dimTag = document.querySelector('.dim-tag');
  if (dimTag) {
    dimTag.textContent = `${settings.widthMm}×${settings.heightMm}mm`;
  }
}

function syncDynamicPageStyle() {
  let styleEl = document.getElementById('dynamic-page-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dynamic-page-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `@page { size: ${settings.widthMm}mm ${settings.heightMm}mm; margin: 0; }`;
  document.documentElement.style.setProperty('--print-width-mm', `${settings.widthMm}mm`);
  document.documentElement.style.setProperty('--print-height-mm', `${settings.heightMm}mm`);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* -------------------- Library Loading -------------------- */

async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const pdfjs = await import(`${PDFJS_CDN_BASE}/pdf.min.mjs`);
      try {
        const res = await fetch(`${PDFJS_CDN_BASE}/pdf.worker.min.mjs`, { mode: 'cors' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const workerCode = await res.text();
        const blob = new Blob([workerCode], { type: 'text/javascript' });
        pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
      } catch {
        const shim = new Blob(
          [`import "${PDFJS_CDN_BASE}/pdf.worker.min.mjs";`],
          { type: 'text/javascript' }
        );
        pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(shim);
      }
      return pdfjs;
    })();
  }
  return pdfjsLibPromise;
}

async function getPdfLib() {
  if (window.PDFLib) return window.PDFLib;
  // Wait briefly if deferred script is still loading
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    if (window.PDFLib) return window.PDFLib;
  }
  throw new Error('Não foi possível carregar a biblioteca pdf-lib. Verifique sua conexão com a internet.');
}

/* -------------------- Core Processing Pipeline -------------------- */

async function handleIncomingFiles(files) {
  setStatus('working', 'Lendo arquivo PDF...', 'Preparando recorte automático da etiqueta.');

  try {
    const readResults = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }))
    );
    loadedFiles = readResults;
    await processLoadedFiles({ triggerAutoPrint: settings.autoPrint });
  } catch (err) {
    console.error(err);
    setStatus('error', 'Erro ao ler o PDF', err?.message || 'Não foi possível abrir o arquivo selecionado.');
  }
}

async function processLoadedFiles({ triggerAutoPrint }) {
  const startedAt = performance.now();
  setStatus('working', 'Recortando etiqueta...', 'Detectando bordas e removendo páginas extras.');

  try {
    const [pdfjs, PDFLib] = await Promise.all([getPdfJs(), getPdfLib()]);
    const { PDFDocument, degrees } = PDFLib;

    const outDoc = await PDFDocument.create();
    outDoc.setTitle('Etiqueta Mercado Livre 100x150mm');
    outDoc.setProducer('Etiqueta ML Browser Tool');

    const outW = settings.widthMm * MM_TO_PT;
    const outH = settings.heightMm * MM_TO_PT;
    const marginPt = settings.marginMm * MM_TO_PT;
    const availW = Math.max(20, outW - marginPt * 2);
    const availH = Math.max(20, outH - marginPt * 2);

    let totalLabels = 0;
    let totalSkippedPages = 0;
    const skippedReasons = [];

    for (const fileItem of loadedFiles) {
      // pdf.js transfers/detaches buffers in worker mode, so always pass a copy
      const pdfjsDoc = await pdfjs.getDocument({ data: fileItem.bytes.slice() }).promise;
      const srcDoc = await PDFDocument.load(fileItem.bytes, { ignoreEncryption: true });
      const numPages = pdfjsDoc.numPages;

      const pageDecision = await classifyPages(pdfjsDoc, numPages);
      totalSkippedPages += pageDecision.skipped.length;
      for (const s of pageDecision.skipped) {
        skippedReasons.push(s.reason);
      }

      for (const pageNum of pageDecision.included) {
        const pdfjsPage = await pdfjsDoc.getPage(pageNum);
        const srcPage = srcDoc.getPage(pageNum - 1);
        const regions = await detectLabelRegions(pdfjsPage, settings.splitMultiLabels);

        const baseRotation = normalizeRotation(pdfjsPage.rotate || 0);

        for (const region of regions) {
          const embedded = await outDoc.embedPage(srcPage, {
            left: region.left,
            bottom: region.bottom,
            right: region.right,
            top: region.top,
          });

          let effectiveRot = baseRotation;
          let visW = effectiveRot === 90 || effectiveRot === 270 ? embedded.height : embedded.width;
          let visH = effectiveRot === 90 || effectiveRot === 270 ? embedded.width : embedded.height;

          // If target is portrait and label is clearly sideways, rotate 90° automatically
          if (outH > outW && visW > visH * 1.15) {
            effectiveRot = (effectiveRot + 90) % 360;
            [visW, visH] = [visH, visW];
          }

          const fitScale = Math.min(availW / visW, availH / visH);
          const drawW = embedded.width * fitScale;
          const drawH = embedded.height * fitScale;
          const placedVisW = visW * fitScale;
          const placedVisH = visH * fitScale;

          const tx = (outW - placedVisW) / 2;
          const ty = (outH - placedVisH) / 2;

          const outPage = outDoc.addPage([outW, outH]);
          drawRotatedEmbeddedPage(outPage, embedded, {
            tx,
            ty,
            drawW,
            drawH,
            clockwiseRot: effectiveRot,
            degrees,
          });
          totalLabels += 1;
        }
      }

      await pdfjsDoc.destroy();
    }

    if (totalLabels === 0) {
      throw new Error('Nenhuma etiqueta visível foi encontrada no PDF enviado.');
    }

    const pdfBytes = await outDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
    const pdfUrl = URL.createObjectURL(pdfBlob);

    revokeCurrentResultUrl();

    const baseName = buildOutputFileName(loadedFiles);
    currentResult = {
      pdfBytes,
      pdfUrl,
      fileName: baseName,
      labelCount: totalLabels,
      skippedPages: totalSkippedPages,
      pageImages: null,
    };
    printFrameLoadedUrl = null;

    await renderPreviewFromOutputPdf(pdfjs, pdfBytes);

    const elapsedMs = Math.round(performance.now() - startedAt);
    const labelWord = totalLabels === 1 ? 'etiqueta pronta' : 'etiquetas prontas';
    const skippedInfo =
      totalSkippedPages > 0
        ? ` · ${totalSkippedPages} ${totalSkippedPages === 1 ? 'página extra removida' : 'páginas extras removidas'}`
        : '';

    els.resultMeta.textContent = `${totalLabels} ${labelWord} (${settings.widthMm} × ${settings.heightMm} mm)${skippedInfo} · ${elapsedMs} ms`;
    els.resultSection.hidden = false;
    els.dropzone.classList.add('is-compact');

    setStatus(
      'success',
      `${totalLabels} ${labelWord} para impressão`,
      triggerAutoPrint
        ? 'Abrindo o diálogo de impressão automaticamente...'
        : 'Use o botão Imprimir ou pressione Ctrl+P.'
    );

    if (triggerAutoPrint) {
      await printCurrentResult();
      setStatus(
        'success',
        `${totalLabels} ${labelWord} para impressão`,
        'Diálogo de impressão acionado. Pressione Ctrl+P ou clique em Imprimir para outra cópia.'
      );
    }
  } catch (err) {
    console.error(err);
    setStatus(
      'error',
      'Não foi possível processar o PDF',
      err?.message || 'Verifique se o arquivo é um PDF válido de etiqueta do Mercado Livre.'
    );
  }
}

/**
 * Decide which pages of a PDF contain shipping labels vs unnecessary summary/packing-list pages.
 */
async function classifyPages(pdfjsDoc, numPages) {
  if (numPages <= 1) {
    return { included: [1], skipped: [] };
  }

  const included = [];
  const skipped = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum += 1) {
    const page = await pdfjsDoc.getPage(pageNum);
    let isSummary = false;
    let reason = '';

    if (settings.skipSummaryPages) {
      const textContent = await page.getTextContent();
      const rawText = textContent.items.map((item) => item.str || '').join(' ');
      const normalized = normalizeText(rawText);

      if (isMercadoLivreSummaryText(normalized)) {
        isSummary = true;
        reason = 'Lista de separação';
      }
    }

    if (!isSummary && settings.dropLastPage && pageNum === numPages) {
      isSummary = true;
      reason = 'Última página';
    }

    if (isSummary) {
      skipped.push({ pageNum, reason });
    } else {
      included.push(pageNum);
    }
  }

  // Safety guard: never drop every single page
  if (included.length === 0) {
    return { included: [1], skipped: skipped.filter((s) => s.pageNum !== 1) };
  }

  return { included, skipped };
}

function normalizeText(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isMercadoLivreSummaryText(text) {
  if (!text) return false;
  if (text.includes('despache a sua venda')) return true;
  if (text.includes('comprador esta esperando')) return true;

  const hasSummaryTable =
    text.includes('identificacao') &&
    text.includes('produto') &&
    (text.includes('quantidade') || text.includes('sku:'));
  const hasLabelAddressMarkers =
    text.includes('cep:') ||
    text.includes('cidade de destino') ||
    text.includes('despachar:');

  return hasSummaryTable && !hasLabelAddressMarkers;
}

/**
 * Renders a PDF page onto an offscreen canvas, detects ink bounding box(es),
 * optionally splits side-by-side batch labels, and converts bounds to PDF coordinates.
 */
async function detectLabelRegions(pdfjsPage, splitMultiLabels) {
  const baseViewport = pdfjsPage.getViewport({ scale: 1 });
  const maxDim = Math.max(baseViewport.width, baseViewport.height);
  const analysisScale = Math.min(2.0, 2200 / maxDim);
  const viewport = pdfjsPage.getViewport({ scale: analysisScale });

  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  await pdfjsPage.render({ canvasContext: ctx, viewport }).promise;

  const { data } = ctx.getImageData(0, 0, width, height);
  const colCounts = new Uint32Array(width);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const idx = rowOffset + x * 4;
      const a = data[idx + 3];
      if (a > 16 && (data[idx] < 240 || data[idx + 1] < 240 || data[idx + 2] < 240)) {
        colCounts[x] += 1;
      }
    }
  }

  const pxPerMm = MM_TO_PT * analysisScale;
  const minGapPx = Math.max(4, Math.round(2.0 * pxPerMm));

  // Step 1: Collect contiguous horizontal ink runs separated by >= 2mm blank gutters
  const rawRuns = [];
  let runStart = -1;
  let blankStreak = 0;

  for (let x = 0; x < width; x += 1) {
    if (colCounts[x] > 0) {
      if (runStart === -1) runStart = x;
      blankStreak = 0;
    } else if (runStart !== -1) {
      blankStreak += 1;
      if (blankStreak >= minGapPx) {
        rawRuns.push({ x0: runStart, x1: x - blankStreak });
        runStart = -1;
        blankStreak = 0;
      }
    }
  }
  if (runStart !== -1) {
    rawRuns.push({ x0: runStart, x1: width - 1 - blankStreak });
  }

  if (rawRuns.length === 0) {
    // Fallback: whole page if nothing detected
    return [canvasRectToPdfBox(viewport, 0, 0, width, height)];
  }

  // Step 2: Merge runs into individual label horizontal spans
  let horizontalSpans = [];
  if (!splitMultiLabels) {
    horizontalSpans = [{ x0: rawRuns[0].x0, x1: rawRuns[rawRuns.length - 1].x1 }];
  } else {
    const maxSingleLabelWidthPx = 112 * pxPerMm;
    for (const run of rawRuns) {
      const prev = horizontalSpans[horizontalSpans.length - 1];
      if (prev && run.x1 - prev.x0 <= maxSingleLabelWidthPx) {
        prev.x1 = run.x1;
      } else {
        horizontalSpans.push({ ...run });
      }
    }

    // Handle touching side-by-side labels (e.g., 2 or 3 labels joined by cut lines)
    horizontalSpans = horizontalSpans.flatMap((span) =>
      splitWideTouchingSpan(span, colCounts, pxPerMm)
    );
  }

  // Step 3: For each horizontal span, compute tight vertical bounds and convert to PDF points
  const padPx = Math.max(2, Math.round(1.0 * pxPerMm));
  const regions = [];

  for (const span of horizontalSpans) {
    let minY = height;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width * 4;
      let rowHasInk = false;
      for (let x = span.x0; x <= span.x1; x += 1) {
        const idx = rowOffset + x * 4;
        const a = data[idx + 3];
        if (a > 16 && (data[idx] < 240 || data[idx + 1] < 240 || data[idx + 2] < 240)) {
          rowHasInk = true;
          break;
        }
      }
      if (rowHasInk) {
        if (y < minY) minY = y;
        maxY = y;
      }
    }

    if (maxY < minY) continue;

    const spanWidthMm = (span.x1 - span.x0 + 1) / pxPerMm;
    const spanHeightMm = (maxY - minY + 1) / pxPerMm;

    // Ignore tiny stray marks (< 20mm) unless it's the only span
    if (horizontalSpans.length > 1 && (spanWidthMm < 20 || spanHeightMm < 20)) {
      continue;
    }

    const cx0 = Math.max(0, span.x0 - padPx);
    const cy0 = Math.max(0, minY - padPx);
    const cx1 = Math.min(width, span.x1 + 1 + padPx);
    const cy1 = Math.min(height, maxY + 1 + padPx);

    regions.push(canvasRectToPdfBox(viewport, cx0, cy0, cx1, cy1));
  }

  if (regions.length === 0) {
    return [canvasRectToPdfBox(viewport, 0, 0, width, height)];
  }

  return regions;
}

/**
 * If 2 or 3 Mercado Livre labels sit side-by-side with a dashed cut line between them,
 * find the clearest low-ink valley(s) near 1/2 or 1/3 & 2/3 of the span width.
 */
function splitWideTouchingSpan(span, colCounts, pxPerMm) {
  const spanWidth = span.x1 - span.x0 + 1;
  const spanWidthMm = spanWidth / pxPerMm;

  // Only split if clearly wider than a single label (~135mm+)
  if (spanWidthMm < 135) return [span];

  const expectedCount = spanWidthMm >= 230 ? 3 : 2;
  let maxColInk = 1;
  for (let x = span.x0; x <= span.x1; x += 1) {
    if (colCounts[x] > maxColInk) maxColInk = colCounts[x];
  }

  const splitPoints = [];
  const searchRadius = Math.round(12 * pxPerMm);

  for (let i = 1; i < expectedCount; i += 1) {
    const targetX = Math.round(span.x0 + (spanWidth * i) / expectedCount);
    const fromX = Math.max(span.x0 + 10, targetX - searchRadius);
    const toX = Math.min(span.x1 - 10, targetX + searchRadius);

    let bestX = targetX;
    let bestInk = Infinity;
    for (let x = fromX; x <= toX; x += 1) {
      if (colCounts[x] < bestInk) {
        bestInk = colCounts[x];
        bestX = x;
      }
    }

    // Only split if there is a genuine low-ink valley (<= 15% of peak column ink)
    if (bestInk <= maxColInk * 0.15) {
      splitPoints.push(bestX);
    }
  }

  if (splitPoints.length !== expectedCount - 1) {
    return [span];
  }

  const subSpans = [];
  let cursor = span.x0;
  for (const cut of splitPoints) {
    const trimmed = trimHorizontalSpan(cursor, cut - 1, colCounts);
    if (trimmed) subSpans.push(trimmed);
    cursor = cut + 1;
  }
  const tail = trimHorizontalSpan(cursor, span.x1, colCounts);
  if (tail) subSpans.push(tail);

  return subSpans.length > 0 ? subSpans : [span];
}

function trimHorizontalSpan(fromX, toX, colCounts) {
  let x0 = fromX;
  let x1 = toX;
  while (x0 <= x1 && colCounts[x0] === 0) x0 += 1;
  while (x1 >= x0 && colCounts[x1] === 0) x1 -= 1;
  return x0 <= x1 ? { x0, x1 } : null;
}

function canvasRectToPdfBox(viewport, cx0, cy0, cx1, cy1) {
  const pts = [
    viewport.convertToPdfPoint(cx0, cy0),
    viewport.convertToPdfPoint(cx1, cy0),
    viewport.convertToPdfPoint(cx0, cy1),
    viewport.convertToPdfPoint(cx1, cy1),
  ];
  const left = Math.min(pts[0][0], pts[1][0], pts[2][0], pts[3][0]);
  const right = Math.max(pts[0][0], pts[1][0], pts[2][0], pts[3][0]);
  const bottom = Math.min(pts[0][1], pts[1][1], pts[2][1], pts[3][1]);
  const top = Math.max(pts[0][1], pts[1][1], pts[2][1], pts[3][1]);
  return { left, bottom, right, top };
}

function normalizeRotation(angle) {
  const normalized = ((angle % 360) + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
  return 0;
}

function drawRotatedEmbeddedPage(outPage, embedded, { tx, ty, drawW, drawH, clockwiseRot, degrees }) {
  switch (clockwiseRot) {
    case 90:
      outPage.drawPage(embedded, {
        x: tx,
        y: ty + drawW,
        width: drawW,
        height: drawH,
        rotate: degrees(-90),
      });
      break;
    case 180:
      outPage.drawPage(embedded, {
        x: tx + drawW,
        y: ty + drawH,
        width: drawW,
        height: drawH,
        rotate: degrees(180),
      });
      break;
    case 270:
      outPage.drawPage(embedded, {
        x: tx + drawH,
        y: ty,
        width: drawW,
        height: drawH,
        rotate: degrees(90),
      });
      break;
    default:
      outPage.drawPage(embedded, {
        x: tx,
        y: ty,
        width: drawW,
        height: drawH,
        rotate: degrees(0),
      });
      break;
  }
}

/* -------------------- Preview Rendering -------------------- */

async function renderPreviewFromOutputPdf(pdfjs, pdfBytes) {
  els.previewGrid.innerHTML = '';
  const doc = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise;
  const total = doc.numPages;

  for (let i = 1; i <= total; i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.6 });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    const figure = document.createElement('figure');
    figure.className = 'label-card';

    const paper = document.createElement('div');
    paper.className = 'label-paper';
    paper.appendChild(canvas);

    const caption = document.createElement('figcaption');
    caption.className = 'label-caption';
    caption.textContent =
      total === 1
        ? `Etiqueta 1 · ${settings.widthMm} × ${settings.heightMm} mm`
        : `Etiqueta ${i} de ${total} · ${settings.widthMm} × ${settings.heightMm} mm`;

    figure.appendChild(paper);
    figure.appendChild(caption);
    els.previewGrid.appendChild(figure);
  }

  await doc.destroy();
}

/* -------------------- Printing & Download -------------------- */

async function printCurrentResult() {
  if (!currentResult) return;

  if (settings.printMode === 'page') {
    await printViaPageMedia();
    return;
  }

  try {
    await printViaVectorIframe(currentResult.pdfUrl);
  } catch (err) {
    console.warn('Impressão via iframe PDF indisponível, usando fallback @page:', err);
    await printViaPageMedia();
  }
}

function printViaVectorIframe(pdfUrl) {
  return new Promise((resolve, reject) => {
    const frame = els.printFrame;

    const triggerPrint = () => {
      try {
        const win = frame.contentWindow;
        if (!win) throw new Error('Janela do iframe indisponível');
        win.focus();
        win.print();
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    if (printFrameLoadedUrl === pdfUrl) {
      triggerPrint();
      return;
    }

    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Tempo esgotado ao carregar o PDF no visualizador de impressão.'));
      }
    }, 6000);

    frame.onload = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      printFrameLoadedUrl = pdfUrl;
      // Brief pause so built-in browser PDF plugin finishes mounting before print()
      window.setTimeout(triggerPrint, 180);
    };

    frame.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      reject(new Error('Falha ao carregar PDF para impressão.'));
    };

    frame.src = pdfUrl;
  });
}

async function printViaPageMedia() {
  if (!currentResult) return;
  syncDynamicPageStyle();

  if (!currentResult.pageImages) {
    const pdfjs = await getPdfJs();
    const doc = await pdfjs.getDocument({ data: currentResult.pdfBytes.slice() }).promise;
    const images = [];
    // 300 DPI rasterization for crisp thermal barcodes/QR codes in fallback mode
    const scale = 300 / 72;

    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      images.push(canvas.toDataURL('image/png'));
    }

    await doc.destroy();
    currentResult.pageImages = images;
  }

  els.printSheet.innerHTML = '';
  for (const dataUrl of currentResult.pageImages) {
    const pageEl = document.createElement('div');
    pageEl.className = 'print-page';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '';
    pageEl.appendChild(img);
    els.printSheet.appendChild(pageEl);
  }

  // Wait for decoded images before calling window.print()
  await Promise.all(
    Array.from(els.printSheet.querySelectorAll('img')).map((img) =>
      img.decode ? img.decode().catch(() => {}) : Promise.resolve()
    )
  );

  window.print();
}

function downloadCurrentPdf() {
  if (!currentResult) return;
  const link = document.createElement('a');
  link.href = currentResult.pdfUrl;
  link.download = currentResult.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function buildOutputFileName(files) {
  const dim = `${settings.widthMm}x${settings.heightMm}`;
  if (files.length === 1) {
    const clean = files[0].name.replace(/\.pdf$/i, '');
    return `${clean}-${dim}.pdf`;
  }
  return `etiquetas-ml-${files.length}-${dim}.pdf`;
}

/* -------------------- UI State Helpers -------------------- */

function setStatus(kind, title, detail) {
  els.statusBanner.hidden = false;
  els.statusBanner.className = `status-banner is-${kind}`;
  els.statusTitle.textContent = title;
  els.statusDetail.textContent = detail;

  if (kind === 'working') {
    els.statusIcon.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  } else if (kind === 'success') {
    els.statusIcon.innerHTML =
      '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';
  } else {
    els.statusIcon.innerHTML =
      '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg>';
  }
}

function revokeCurrentResultUrl() {
  if (currentResult?.pdfUrl) {
    URL.revokeObjectURL(currentResult.pdfUrl);
  }
}

function clearCurrentState() {
  revokeCurrentResultUrl();
  loadedFiles = [];
  currentResult = null;
  printFrameLoadedUrl = null;
  els.printFrame.removeAttribute('src');
  els.printSheet.innerHTML = '';
  els.previewGrid.innerHTML = '';
  els.resultSection.hidden = true;
  els.statusBanner.hidden = true;
  els.dropzone.classList.remove('is-compact');
}
