#!/usr/bin/env node
/**
 * ダミーデータ等価性検証: testdata/dummy を JS(core.js)で変換し、
 * Python 参照実装の出力(testdata/dummy/output/zaim_import_5171.csv)と比較する。
 *
 *   前提: node scripts/make_dummy_data.js
 *         python scripts/amazon_to_zaim.py --base "testdata/dummy"
 *   実行: node scripts/verify_dummy.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('../web/js/core.js');

const BASE = path.resolve(__dirname, '..', 'testdata', 'dummy');
const ORDER_CSV = path.join(BASE, 'Your Orders', 'Your Amazon Orders', 'Order History.csv');
const REFUND_CSV = path.join(BASE, 'Your Orders', 'Your Returns & Refunds', 'Refund Details.csv');
const GOLDEN_CSV = path.join(BASE, 'output', 'zaim_import_5171.csv');

let ok = true;
function check(cond, label) {
  console.log(`${cond ? '[OK]' : '[NG]'} ${label}`);
  if (!cond) ok = false;
}

const orderRows = core.parseCsv(fs.readFileSync(ORDER_CSV, 'utf8'));
const refundRows = core.parseCsv(fs.readFileSync(REFUND_CSV, 'utf8'));

const { rows, notes, warnings } = core.convert(orderRows, refundRows, {});
const s = core.summarize(rows);

check(s.count === 5, `エントリ数 5 → ${s.count}`);
check(s.total === 15048, `合計 15,048 → ${s.total.toLocaleString()}`);
check(s.minDate === '2026-05-20' && s.maxDate === '2026-07-09', `期間 → ${s.minDate}〜${s.maxDate}`);
check(warnings.length === 1, `ギフト券併用警告 1 件 → ${warnings.length}`);
check(
  notes.some((n) => n.includes('実質0円')),
  '全額返金の除外メモあり'
);

const golden = fs
  .readFileSync(GOLDEN_CSV, 'utf8')
  .replace(/^﻿/, '')
  .split(/\r\n|\n/)
  .filter(Boolean);
const js = core
  .generateCsv(rows)
  .replace(/^﻿/, '')
  .split(/\r\n|\n/)
  .filter(Boolean);
check(js.length === golden.length, `行数一致 → JS=${js.length} golden=${golden.length}`);
for (let i = 0; i < Math.max(js.length, golden.length); i++) {
  if (js[i] !== golden[i]) {
    check(false, `行 ${i + 1} 不一致:\n  JS    : ${js[i]}\n  golden: ${golden[i]}`);
  }
}
if (ok) console.log('[OK] ダミーデータ: JS 出力は Python 参照実装と完全一致');
process.exitCode = ok ? 0 : 1;
