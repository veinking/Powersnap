(() => {
  const $ = (id) => document.getElementById(id);
  const fileInput = $('fileInput');
  const dropZone = $('dropZone');
  const results = $('results');
  const issueList = $('issueList');
  const core = window.PowerSnapCore;
  let state = { file: null, rows: [], headers: [], issues: [] };

  if (!core) {
    $('fileMeta').textContent = 'PowerSnap could not load its cleaning engine.';
    return;
  }

  function render() {
    issueList.innerHTML = '';
    state.issues.forEach((issue) => {
      const item = document.createElement('div');
      item.className = 'issue';
      item.innerHTML = `<span class="dot ${issue.severity}"></span><div><strong>${issue.title}</strong><p>${issue.detail}</p></div><span class="count">${issue.count.toLocaleString()} found</span>`;
      issueList.appendChild(item);
    });

    const score = core.scoreIssues(state.issues);
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
      header: false,
      dynamicTyping: false,
      skipEmptyLines: false,
      complete(output) {
        const matrix = Array.isArray(output.data) ? output.data : [];
        const headers = (matrix[0] || []).map((value) => String(value ?? ''));
        const rows = matrix.slice(1).map((row) => Array.from({ length: headers.length }, (_, index) => String(row?.[index] ?? '')));
        state = { file, rows, headers, issues: core.diagnose(rows, headers) };
        $('fileMeta').textContent = `${file.name} • ${(file.size / 1024).toFixed(1)} KB`;
        render();
      },
      error(error) {
        $('fileMeta').textContent = error?.message || 'Could not parse this CSV.';
      },
    });
  }

  function downloadCleaned() {
    const cleaned = core.cleanTable(state.rows, state.headers);
    const csv = Papa.unparse([cleaned.headers, ...cleaned.rows], { newline: '\r\n' });
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
  ['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag');
  }));
  dropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files?.[0];
    if (file && /\.csv$/i.test(file.name)) parse(file);
    else $('fileMeta').textContent = 'Choose a CSV file.';
  });
  $('fixBtn').addEventListener('click', downloadCleaned);
  $('resetBtn').addEventListener('click', () => {
    state = { file: null, rows: [], headers: [], issues: [] };
    results.classList.add('hidden');
    fileInput.value = '';
    $('fileMeta').textContent = '';
  });
})();
