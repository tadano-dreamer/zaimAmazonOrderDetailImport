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
const GOLDEN_CSV_7474 = path.join(BASE, 'output', 'zaim_import_7474.csv');

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
// --- カード更新(5171 → 7474)・期間フィルタ・複数出荷 -----------------------
// カード下4桁1つで絞ると、更新後の番号で買った分が丸ごと落ちる(実データで発生済み)。
const succ = core.suggestSuccessors(core.detectCards(orderRows), ['5171']);
check(
  succ.some((c) => c.card === '7474'),
  `5171 の後継カード候補として 7474 を検出 → ${succ.map((c) => c.card).join(',') || 'なし'}`
);

const newCard = core.convert(orderRows, refundRows, { cards: ['7474'] });
const sNew = core.summarize(newCard.rows);
check(sNew.count === 3 && sNew.total === 14670, `7474 単体 → ${sNew.count}件 / ${sNew.total}円`);
// 7474 側にはギフト券併用かつ部分返金の注文が入っている。メモの注記は
// 片方を elif にすると静かに消えるので、Python 出力とバイト単位で突き合わせる。
check(
  core.generateCsv(newCard.rows) === fs.readFileSync(GOLDEN_CSV_7474, 'utf8'),
  '7474: JS 出力が Python 参照実装とバイト単位で一致(メモの注記含む)'
);
const giftRefundRow = newCard.rows.find((r) => r[core.COL.date] === '2026-07-24');
check(
  giftRefundRow[core.COL.memo].includes('返金300円を差引済み') &&
    giftRefundRow[core.COL.memo].includes('ギフト券併用'),
  `返金とギフト券併用の注記が両方出る → ${giftRefundRow[core.COL.memo].slice(0, 70)}`
);
check(
  newCard.notes.some((n) => n.includes('分割計上')),
  '複数出荷(" and " 連結)の分割計上メモあり'
);

const bothCards = core.convert(orderRows, refundRows, { cards: ['5171', '7474'] });
const sBoth = core.summarize(bothCards.rows);
check(
  sBoth.count === 8 && sBoth.total === 15048 + 14670,
  `5171+7474 合算 → ${sBoth.count}件 / ${sBoth.total}円`
);

const july = core.convert(orderRows, refundRows, {
  cards: ['5171', '7474'],
  dateFrom: '2026-07-01',
  dateTo: '2026-07-31',
});
const sJuly = core.summarize(july.rows);
check(
  sJuly.count === 5 && sJuly.total === 4740 + 1280 + 1770 + 9900 + 3000,
  `2026-07 のみ → ${sJuly.count}件 / ${sJuly.total}円`
);
check(
  july.months.length === 3 && july.months[july.months.length - 1].month === '2026-07',
  `months は期間フィルタ前の全月 → ${july.months.map((m) => m.month).join(',')}`
);

// --- 出力列が Zaim の取込設定と一致していること ------------------------------
const settings = core.zaimImportSettings();
const colOf = (label) => {
  const v = (settings.find((x) => x.label === label) || {}).value || '';
  return /列目/.test(v) ? Number(v.replace(/\D/g, '')) - 1 : -1;
};
check(
  core.ZAIM_HEADER[colOf('支出の金額の列')] === '支出金額' &&
    core.ZAIM_HEADER[colOf('品目の列')] === '品目' &&
    core.ZAIM_HEADER[colOf('日付の列')] === '日付',
  `取込設定の列番号が実ヘッダと一致(${core.ZAIM_HEADER.length}列)`
);

// --- ギフト券併用の実請求額上書き ------------------------------------------
const gift = core.convert(orderRows, refundRows, {}).warnings[0];
const fixed = core.convert(orderRows, refundRows, { amountOverrides: { [gift.key]: 4091 } });
check(
  core.summarize(fixed.rows).total === 15048 - gift.rawAmount + 4091,
  `ギフト券併用を実請求額(4,091円)に補正 → ${core.summarize(fixed.rows).total}円`
);

if (ok) console.log('[OK] ダミーデータ: JS 出力は Python 参照実装と完全一致');
process.exitCode = ok ? 0 : 1;
