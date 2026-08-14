(() => {
  const $ = (id) => document.getElementById(id);
  const fileInput = $('fileInput');
  const dropZone = $('dropZone');
  const results = $('results');
  const issueList = $('issueList');
  let state = { file: null, rows: [], headers: [], issues: [] };

  const numericLike = /^[-+]?[$€£]?\s*\d[\d,]*(?:\.\d+)?%?$/;
  const weight = { high: 18, medium: 10, low: 5 };

  function diagnose(rows, headers) {
    const issues = [];
    const totalCells = Math.max(1, rows.length * Math.max(1, headers.length));
    const normalizedHeaders = headers.map((h) => String(h || '').trim().toLowerCase());

    const blankHeaders = normalizedHeaders.filter((h) => !h).length;
    if (blankHeaders) issues.push({ severity: 'high', title: 'Blank column headers', count: blankHeaders, detail: 'Unnamed columns make joins, formulas, exports, and downstream reporting harder to trust.' });

    const seenHeaders = new Set();
    let duplicateHeaders = 0;
    normalizedHeaders.forEach((h) => { if (!h) return; if (seenHeaders.has(h)) duplicateHeaders++; else seenHeaders.add(h); });
    if (duplicateHeaders) issues.push({ severity: 'high', title: 'Duplicate column names', count: duplicateHeaders, detail: 'Duplicate headers can overwrite fields or send the wrong values into dashboards and automation.' });

    let missing = 0;
    let whitespace = 0;
    let formattedNumeric = 0;
    const signatures = new Set();
    let duplicateRows = 0;

    rows.forEach((row) => {
      const signature = headers.map((h) => String(row[h] ?? '')).join('\u001f');
      if (signatures.has(signature)) duplicateRows++; else signatures.add(signature);
      headers.forEach((h) => {
        const raw = String(row[h] ?? '');
        const trimmed = raw.trim();
        if (!trimmed) missing++;
        if (trimmed && raw !== trimmed) whitespace++;
        if (trimmed && numericLike.test(trimmed) && /[$€£,%]/.test(trimmed)) formattedNumeric++;
      });
    });

    let mixedColumns = 0;
    headers.forEach((h) => {
      let numeric = 0;
      let text = 0;
      rows.slice(0, 1500).forEach((row) => {
        const value = String(row[h] ?? '').trim();
        if (!value) return;
        if (numericLike.test(value)) numeric++; else text++;
      });
      if (numeric && text) mixedColumns++;
    });

    const missingRate = missing / totalCells;
    if (missing) issues.push({ severity: missingRate > 0.15 ? 'high' : 'medium', title: 'Missing values', count: missing, detail: `${Math.round(missingRate * 100)}% of cells are blank. Missing fields can distort KPIs, segmentation, and operational reporting.` });
    if (mixedColumns) issues.push({ severity: 'high', title: 'Mixed data types', count: mixedColumns, detail: 'Some columns mix numeric and text values, which can break totals, sorting, charts, and calculations.' });
    if (formattedNumeric) issues.push({ severity: 'medium', title: 'Numbers stored as formatted text', count: formattedNumeric, detail: 'Currency symbols, commas, and percent signs can stop numeric fields from aggregating correctly.' });
    if (whitespace) issues.push({ severity: 'low', title: 'Hidden leading or trailing spaces', count: whitespace, detail: 'Extra spaces can create fake duplicates and cause exact-match joins or filters to miss records.' });
    if (duplicateRows) issues.push({ severity: 'medium', title: 'Exact duplicate rows', count: duplicateRows, detail: 'Duplicate records can inflate counts, revenue totals, inventory, and customer metrics.' });
    if (!issues.length) issues.push({ severity: 'low', title: 'No major structural issues detected', count: 0, detail: 'This file looks structurally clean in the current deterministic checks.' });
    return issues.slice(0, 7);
  }

  function render() {
    issueList.innerHTML = '';
    state.issues.forEach((issue) => {
      const item = document.createElement('div');
      item.className = 'issue';
      item.innerHTML = `<span class="dot ${issue.severity}"></span><div><strong>${issue.title}</strong><p>${issue.detail}</p></div><span class="count">${issue.count.toLocaleString()} found</span>`;
      issueList.appendChild(item);
    });

    const penalty = state.issues.reduce((sum, issue) => sum + (weight[issue.severity] || 0), 0);
    const score = Math.max(20, Math.min(100, 100 - penalty));
    $('score').textContent = score;
    const high = state.issues.some((issue) => issue.severity === 'high');
    const medium = state.issues.some((issue) => issue.severity === 'medium');
    $('impactTitle').textContent = high ? 'Reporting risk detected' : medium ? 'Cleanup recommended' : 'File looks healthy';
    $('impactText').textContent = high
      ? 'Structural problems in this file can cause incorrect totals, failed joins, inconsistent dashboards, or automation errors.'
      : medium
        ? 'The file is usable, but cleanup will reduce reporting noise and make downstream analysis more reliable.'
        : 'PowerSnap did not find a major structural blocker in this pass.';
    $('rowMeta').textContent = `${state.rows.length.toLocaleString()} rows • ${state.headers.length} columns • ${state.issues.length} findings`;
    results.classList.remove('hidden');
  }

  function parse(file) {
    if (!window.Papa) return setTimeout(() => parse(file), 120);
    $('fileMeta').textContent = 'Analyzing…';
    Papa.parse(file, {
      header: true,
      dynamicTyping: false,
      skipEmptyLines: false,
      complete(output) {
        const headers = output.meta.fields || [];
        const rows = output.data || [];
        state = { file, rows, headers, issues: diagnose(rows, headers) };
        $('fileMeta').textContent = `${file.name} • ${(file.size / 1024).toFixed(1)} KB`;
        render();
      },
      error(error) { $('fileMeta').textContent = error?.message || 'Could not parse this CSV.'; }
    });
  }

  function normalizeHeader(header, index, seen) {
    const base = String(header || '').trim() || `column_${index + 1}`;
    const key = base.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return count === 1 ? base : `${base}_${count}`;
  }

  function cleanValue(value) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed || !numericLike.test(trimmed)) return trimmed;
    const isPercent = trimmed.endsWith('%');
    const parsed = Number(trimmed.replace(/[$€£,%\s]/g, ''));
    if (!Number.isFinite(parsed)) return trimmed;
    return String(isPercent ? parsed / 100 : parsed);
  }

  function downloadCleaned() {
    const seenHeaders = new Map();
    const cleanHeaders = state.headers.map((h, i) => normalizeHeader(h, i, seenHeaders));
    const unique = new Set();
    const cleaned = [];

    state.rows.forEach((row) => {
      const next = {};
      state.headers.forEach((header, index) => { next[cleanHeaders[index]] = cleanValue(row[header]); });
      const signature = cleanHeaders.map((header) => next[header]).join('\u001f');
      if (!unique.has(signature)) { unique.add(signature); cleaned.push(next); }
    });

    const csv = Papa.unparse(cleaned, { newline: '\r\n' });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (state.file?.name || 'data').replace(/\.csv$/i, '') + '-cleaned.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }

  fileInput.addEventListener('change', (event) => event.target.files?.[0] && parse(event.target.files[0]));
  ['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.remove('drag'); }));
  dropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files?.[0];
    if (file && /\.csv$/i.test(file.name)) parse(file); else $('fileMeta').textContent = 'Choose a CSV file.';
  });
  $('fixBtn').addEventListener('click', downloadCleaned);
  $('resetBtn').addEventListener('click', () => {
    state = { file: null, rows: [], headers: [], issues: [] };
    results.classList.add('hidden');
    fileInput.value = '';
    $('fileMeta').textContent = '';
  });
})();
