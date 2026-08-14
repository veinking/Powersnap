(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PowerSnapCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const numericLike = /^[-+]?[$€£]?\s*\d[\d,]*(?:\.\d+)?%?$/;
  const severityWeight = { high: 18, medium: 10, low: 5 };

  function asText(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function diagnose(rows, headers) {
    const issues = [];
    const totalCells = Math.max(1, rows.length * Math.max(1, headers.length));
    const normalizedHeaders = headers.map((header) => asText(header).trim().toLowerCase());

    const blankHeaders = normalizedHeaders.filter((header) => !header).length;
    if (blankHeaders) {
      issues.push({
        severity: "high",
        title: "Blank column headers",
        count: blankHeaders,
        detail: "Unnamed columns make joins, formulas, exports, and downstream reporting harder to trust.",
      });
    }

    const seenHeaders = new Set();
    let duplicateHeaders = 0;
    normalizedHeaders.forEach((header) => {
      if (!header) return;
      if (seenHeaders.has(header)) duplicateHeaders += 1;
      else seenHeaders.add(header);
    });
    if (duplicateHeaders) {
      issues.push({
        severity: "high",
        title: "Duplicate column names",
        count: duplicateHeaders,
        detail: "Duplicate headers can overwrite fields or send the wrong values into dashboards and automation.",
      });
    }

    let missing = 0;
    let whitespace = 0;
    let formattedNumeric = 0;
    let duplicateRows = 0;
    const signatures = new Set();

    rows.forEach((row) => {
      const values = headers.map((_, index) => asText(row[index]));
      const signature = JSON.stringify(values);
      if (signatures.has(signature)) duplicateRows += 1;
      else signatures.add(signature);

      values.forEach((raw) => {
        const trimmed = raw.trim();
        if (!trimmed) missing += 1;
        if (trimmed && raw !== trimmed) whitespace += 1;
        if (trimmed && numericLike.test(trimmed) && /[$€£,%]/.test(trimmed)) formattedNumeric += 1;
      });
    });

    let mixedColumns = 0;
    headers.forEach((_, columnIndex) => {
      let numeric = 0;
      let text = 0;
      rows.slice(0, 1500).forEach((row) => {
        const value = asText(row[columnIndex]).trim();
        if (!value) return;
        if (numericLike.test(value)) numeric += 1;
        else text += 1;
      });
      if (numeric && text) mixedColumns += 1;
    });

    const missingRate = missing / totalCells;
    if (missing) {
      issues.push({
        severity: missingRate > 0.15 ? "high" : "medium",
        title: "Missing values",
        count: missing,
        detail: `${Math.round(missingRate * 100)}% of cells are blank. Missing fields can distort KPIs, segmentation, and operational reporting.`,
      });
    }
    if (mixedColumns) {
      issues.push({
        severity: "high",
        title: "Mixed data types",
        count: mixedColumns,
        detail: "Some columns mix numeric and text values, which can break totals, sorting, charts, and calculations.",
      });
    }
    if (formattedNumeric) {
      issues.push({
        severity: "medium",
        title: "Numbers stored as formatted text",
        count: formattedNumeric,
        detail: "Currency symbols, commas, and percent signs can stop numeric fields from aggregating correctly.",
      });
    }
    if (whitespace) {
      issues.push({
        severity: "low",
        title: "Hidden leading or trailing spaces",
        count: whitespace,
        detail: "Extra spaces can create fake duplicates and cause exact-match joins or filters to miss records.",
      });
    }
    if (duplicateRows) {
      issues.push({
        severity: "medium",
        title: "Exact duplicate rows",
        count: duplicateRows,
        detail: "Duplicate records can inflate counts, revenue totals, inventory, and customer metrics.",
      });
    }
    if (!issues.length) {
      issues.push({
        severity: "low",
        title: "No major structural issues detected",
        count: 0,
        detail: "This file looks structurally clean in the current deterministic checks.",
      });
    }

    return issues.slice(0, 7);
  }

  function normalizeHeaders(headers) {
    const seen = new Map();
    return headers.map((header, index) => {
      const base = asText(header).trim().replace(/\s+/g, " ") || `column_${index + 1}`;
      const key = base.toLowerCase();
      const count = (seen.get(key) || 0) + 1;
      seen.set(key, count);
      return count === 1 ? base : `${base}_${count}`;
    });
  }

  function cleanValue(value) {
    const trimmed = asText(value).trim();
    if (!trimmed || !numericLike.test(trimmed)) return trimmed;
    const isPercent = trimmed.endsWith("%");
    const parsed = Number(trimmed.replace(/[$€£,%\s]/g, ""));
    if (!Number.isFinite(parsed)) return trimmed;
    return String(isPercent ? parsed / 100 : parsed);
  }

  function cleanTable(rows, headers) {
    const cleanHeaders = normalizeHeaders(headers);
    const unique = new Set();
    const cleanedRows = [];

    rows.forEach((row) => {
      const next = cleanHeaders.map((_, index) => cleanValue(row[index]));
      const signature = JSON.stringify(next);
      if (!unique.has(signature)) {
        unique.add(signature);
        cleanedRows.push(next);
      }
    });

    return { headers: cleanHeaders, rows: cleanedRows };
  }

  function scoreIssues(issues) {
    const penalty = issues.reduce((sum, issue) => sum + (severityWeight[issue.severity] || 0), 0);
    return Math.max(20, Math.min(100, 100 - penalty));
  }

  return { diagnose, cleanTable, scoreIssues, numericLike };
});
