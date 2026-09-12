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

check(s.count === 6, `エントリ数 6 → ${s.count}`);
check(s.total === 19048, `合計 19,048 → ${s.total.toLocaleString()}`);
check(s.minDate === '2026-05-20' && s.maxDate === '2026-07-09', `期間 → ${s.minDate}〜${s.maxDate}`);
check(warnings.length === 1, `ギフト券併用警告 1 件 → ${warnings.length}`);
check(
  notes.some((n) => n.includes('実質0円')),
  '全額返金の除外メモあり'
);

/**
 * CSV を行の配列に正規化する。BOM と改行コードは比較対象にしない
 * ― git が環境によって CRLF/LF を変換するため、バイト比較は
 * Windows で通っても Linux(CI)で落ちる。
 */
const toLines = (text) =>
  text
    .replace(/^﻿/, '')
    .split(/\r\n|\n/)
    .filter(Boolean);

const golden = toLines(fs.readFileSync(GOLDEN_CSV, 'utf8'));
const js = toLines(core.generateCsv(rows));
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
const js7474 = toLines(core.generateCsv(newCard.rows));
const golden7474 = toLines(fs.readFileSync(GOLDEN_CSV_7474, 'utf8'));
check(
  js7474.length === golden7474.length && js7474.every((l, i) => l === golden7474[i]),
  '7474: JS 出力が Python 参照実装と一致(メモの注記含む)'
);
for (let i = 0; i < Math.max(js7474.length, golden7474.length); i++) {
  if (js7474[i] !== golden7474[i]) {
    console.log(`     行 ${i + 1}:`);
    console.log(`       JS    : ${js7474[i]}`);
    console.log(`       golden: ${golden7474[i]}`);
  }
}
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
  sBoth.count === 9 && sBoth.total === 19048 + 14670,
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
  core.summarize(fixed.rows).total === 19048 - gift.rawAmount + 4091,
  `ギフト券併用を実請求額(4,091円)に補正 → ${core.summarize(fixed.rows).total}円`
);

// --- 項目の文字数上限(実機で赤字になったのはここ) --------------------------
// 1件の抜き取りでは長い注文を取りこぼすので、**全出力行**を機械的に検査する。
const charLen = (s) => Array.from(s).length;
for (const [label, opt] of [
  ['既定', {}],
  ['memo=full', { memo: 'full' }],
  ['商品ごとに1行', { splitByItem: true }],
  ['明細ごと', { aggregate: false }],
]) {
  const out = core.convert(orderRows, refundRows, Object.assign({ cards: ['5171', '7474'] }, opt));
  const tooLongMemo = out.rows.filter((r) => charLen(r[core.COL.memo]) > core.FIELD_MAX_LEN);
  const tooLongItem = out.rows.filter((r) => charLen(r[core.COL.item]) > core.ITEM_FIELD_MAX);
  check(
    tooLongMemo.length === 0,
    `${label}: 全 ${out.rows.length} 行のメモが ${core.FIELD_MAX_LEN} 文字以内` +
      (tooLongMemo.length ? ` (超過 ${tooLongMemo.length} 行: ${tooLongMemo[0][core.COL.memo]})` : '')
  );
  check(
    tooLongItem.length === 0,
    `${label}: 全 ${out.rows.length} 行の品目が ${core.ITEM_FIELD_MAX} 文字以内` +
      (tooLongItem.length ? ` (超過 ${tooLongItem.length} 行: ${tooLongItem[0][core.COL.item]})` : '')
  );
}

// D012: 実機で「乳液… ほか1点」となり、もう1品が何なのか分からなかったケース
const longRow = rows.find((r) => r[core.COL.date] === '2026-06-05');
check(
  longRow &&
    longRow[core.COL.item].includes('乳液') &&
    longRow[core.COL.item].includes('浄水器') &&
    !longRow[core.COL.item].includes('ほか'),
  `長い2品の注文は品目に両方出る → ${longRow ? longRow[core.COL.item] : 'なし'}`
);
check(
  longRow && longRow[core.COL.memo] === '注文 503-1000012-0000122',
  `既定のメモは注記と注文IDだけ → ${longRow ? longRow[core.COL.memo] : 'なし'}`
);
const longFull = core.convert(orderRows, refundRows, { memo: 'full' }).rows.find(
  (r) => r[core.COL.date] === '2026-06-05'
);
check(
  charLen(longFull[core.COL.memo]) <= core.FIELD_MAX_LEN,
  `memo=full でも 100 文字以内に収まる → ${charLen(longFull[core.COL.memo])}字`
);

// --- 商品ごとに1行(splitByItem)------------------------------------------
const bothSplit = core.convert(orderRows, refundRows, {
  cards: ['5171', '7474'],
  splitByItem: true,
});
const sSplit = core.summarize(bothSplit.rows);
check(
  sSplit.total === sBoth.total,
  `商品ごとに1行でも合計は変わらない → ${sSplit.count}行 / ${sSplit.total}円(合算 ${sBoth.count}行)`
);
check(sSplit.count > sBoth.count, `商品ごとに1行で行が増える → ${sSplit.count} > ${sBoth.count}`);
check(
  new Set(bothSplit.meta.map((m) => m.key)).size === bothSplit.meta.length,
  '商品ごとに1行でも meta.key が一意(行の選択が壊れない)'
);
const detail = core.convert(orderRows, refundRows, { cards: ['5171', '7474'], aggregate: false });
check(
  new Set(detail.meta.map((m) => m.key)).size === detail.meta.length &&
    detail.meta.every((m) => m.key),
  '明細ごとでも meta.key が一意(1行外すと全行消える不具合の防止)'
);

// --- カテゴリの内訳(2択)---------------------------------------------------
check(
  core.SUBCATEGORY_CHOICES.map((c) => c.value).join(',') === 'ゆうすけAmazon,ともかAmazon',
  `内訳の選択肢 → ${core.SUBCATEGORY_CHOICES.map((c) => c.value).join(' / ')}`
);
check(
  rows.every((r) => r[core.COL.subcategory] === 'ゆうすけAmazon'),
  '既定の内訳が全行に入る'
);
const tomoka = core.convert(orderRows, refundRows, { subcategory: 'ともかAmazon' });
check(
  tomoka.rows.every((r) => r[core.COL.subcategory] === 'ともかAmazon') &&
    core.summarize(tomoka.rows).total === s.total,
  '内訳を切り替えても金額は変わらない'
);

// --- 新しいモードも Python 参照実装とバイト単位で一致すること -----------------
// JS と Python は別々に書いた同じロジックなので、切り詰めの計算が1文字ずれただけでも
// 出力が食い違う。モードごとにゴールデンを持って機械的に突き合わせる。
for (const [label, opt, goldenPath] of [
  ['memo=full', { memo: 'full' }, path.join(BASE, 'output', 'zaim_import_5171_full.csv')],
  ['商品ごとに1行', { splitByItem: true }, path.join(BASE, 'output', 'zaim_import_5171_split.csv')],
]) {
  const js = toLines(core.generateCsv(core.convert(orderRows, refundRows, opt).rows));
  const golden = toLines(fs.readFileSync(goldenPath, 'utf8'));
  const same = js.length === golden.length && js.every((l, i) => l === golden[i]);
  check(same, `${label}: JS 出力が Python 参照実装と一致(${golden.length}行)`);
  if (!same) {
    for (let i = 0; i < Math.max(js.length, golden.length); i++) {
      if (js[i] !== golden[i]) {
        console.log(`     行 ${i + 1}:`);
        console.log(`       JS    : ${js[i]}`);
        console.log(`       golden: ${golden[i]}`);
      }
    }
  }
}

if (ok) console.log('[OK] ダミーデータ: JS 出力は Python 参照実装と完全一致');
process.exitCode = ok ? 0 : 1;
