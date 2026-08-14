const assert = require('node:assert/strict');
const { diagnose, cleanTable, scoreIssues } = require('../core.js');

function finding(issues, title) {
  return issues.find((issue) => issue.title === title);
}

{
  const headers = ['Customer ID', ' Amount ', 'Customer ID', ''];
  const rows = [
    ['1', ' $1,200.00 ', '1', ''],
    ['1', ' $1,200.00 ', '1', ''],
    ['2', 'pending', '2', 'x'],
  ];
  const issues = diagnose(rows, headers);
  assert.equal(finding(issues, 'Duplicate column names')?.count, 1);
  assert.equal(finding(issues, 'Blank column headers')?.count, 1);
  assert.equal(finding(issues, 'Exact duplicate rows')?.count, 1);
  assert.ok(finding(issues, 'Mixed data types'));
  assert.ok(finding(issues, 'Numbers stored as formatted text'));
  assert.ok(finding(issues, 'Hidden leading or trailing spaces'));
  assert.ok(scoreIssues(issues) < 100);
}

{
  const headers = [' Name ', 'Amount', 'Amount', ''];
  const rows = [
    [' Alice ', '$1,000', '$1,000', ''],
    [' Alice ', '$1,000', '$1,000', ''],
    ['Bob', '25%', '25%', 'ok'],
  ];
  const cleaned = cleanTable(rows, headers);
  assert.deepEqual(cleaned.headers, ['Name', 'Amount', 'Amount_2', 'column_4']);
  assert.equal(cleaned.rows.length, 2);
  assert.deepEqual(cleaned.rows[0], ['Alice', '1000', '1000', '']);
  assert.deepEqual(cleaned.rows[1], ['Bob', '0.25', '0.25', 'ok']);
}

{
  const issues = diagnose([['1', 'Alice'], ['2', 'Bob']], ['id', 'name']);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, 'No major structural issues detected');
  assert.equal(scoreIssues(issues), 95);
}

console.log('PowerSnap core tests passed');
