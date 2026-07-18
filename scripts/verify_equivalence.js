#!/usr/bin/env node
/**
 * 等価性検証: web/js/core.js の出力が Python 版ゴールデン出力
 * (data/output/zaim_import_5171.csv)と一致することを確認する。
 *
 *   実行: node scripts/verify_equivalence.js
 *
 * 実データ(data/ 配下・PII 含む・gitignore 対象)が必要。CI では実行しない。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('../web/js/core.js');

const ROOT = path.resolve(__dirname, '..');
const ORDER_CSV = path.join(ROOT, 'data', 'Your Orders', 'Your Amazon Orders', 'Order History.csv');
const REFUND_CSV = path.join(ROOT, 'data', 'Your Orders', 'Your Returns & Refunds', 'Refund Details.csv');
const GOLDEN_CSV = path.join(ROOT, 'data', 'output', 'zaim_import_5171.csv');

function fail(msg) {
  console.error(`[NG] ${msg}`);
  process.exitCode = 1;
}

function normalizeLines(text) {
  return text
    .replace(/^﻿/, '')
    .split(/\r\n|\n/)
    .filter((l) => l !== '');
}

function main() {
  for (const p of [ORDER_CSV, GOLDEN_CSV]) {
    if (!fs.existsSync(p)) {
      console.error(`[SKIP] 実データが見つかりません: ${p}`);
      process.exitCode = 2;
      return;
    }
  }

  const orderRows = core.parseCsv(fs.readFileSync(ORDER_CSV, 'utf8'));
  const refundRows = fs.existsSync(REFUND_CSV)
    ? core.parseCsv(fs.readFileSync(REFUND_CSV, 'utf8'))
    : [];
  console.log(`[INFO] Order History.csv: ${orderRows.length} 明細 / Refund: ${refundRows.length} 行`);

  const { rows, notes } = core.convert(orderRows, refundRows, {});
  const summary = core.summarize(rows);
  console.log(
    `[INFO] JS 出力: ${summary.count} エントリ / 合計 ${summary.total.toLocaleString()} 円 / ` +
      `期間 ${summary.minDate} 〜 ${summary.maxDate}`
  );
  for (const n of notes) console.log(`       - ${n}`);

  // ランドマーク検証値(docs/IMPLEMENTATION.md §3)
  if (summary.count !== 39) fail(`エントリ数 39 期待 → ${summary.count}`);
  if (summary.total !== 126896) fail(`合計 126,896 期待 → ${summary.total}`);

  // 行単位比較
  const jsLines = normalizeLines(core.generateCsv(rows));
  const goldenLines = normalizeLines(fs.readFileSync(GOLDEN_CSV, 'utf8'));
  if (jsLines.length !== goldenLines.length) {
    fail(`行数不一致: JS=${jsLines.length} / golden=${goldenLines.length}`);
  }
  const n = Math.max(jsLines.length, goldenLines.length);
  let diff = 0;
  for (let i = 0; i < n; i++) {
    if (jsLines[i] !== goldenLines[i]) {
      diff++;
      fail(`行 ${i + 1} 不一致:\n  JS    : ${jsLines[i]}\n  golden: ${goldenLines[i]}`);
    }
  }
  if (diff === 0 && process.exitCode !== 1) {
    console.log(`[OK] 全 ${goldenLines.length} 行(ヘッダ含む)がゴールデンと完全一致`);
  }

  // バイト一致(BOM + CRLF)も確認
  const jsBytes = Buffer.from(core.generateCsv(rows), 'utf8');
  const goldenBytes = fs.readFileSync(GOLDEN_CSV);
  if (jsBytes.equals(goldenBytes)) {
    console.log('[OK] バイト単位でも完全一致(BOM + CRLF)');
  } else {
    console.log(
      `[WARN] バイト一致せず(行単位は一致)。JS=${jsBytes.length}B / golden=${goldenBytes.length}B`
    );
  }
}

main();
