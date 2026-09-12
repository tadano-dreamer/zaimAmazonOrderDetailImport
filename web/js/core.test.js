/**
 * core.js の単体テスト(Node 組み込み test runner)
 *   実行: node --test web/js/
 * フィクスチャは docs/IMPLEMENTATION.md §7 の合成データ(PII なし)。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAmount,
  formatDate,
  parseCsv,
  combineNames,
  loadRefunds,
  detectCards,
  convert,
  generateCsv,
  summarize,
} = require('./core.js');

// ---------------------------------------------------------------- parseAmount
test('parseAmount: カンマ・¥・空白を除去して整数化', () => {
  assert.equal(parseAmount('2,200'), 2200);
  assert.equal(parseAmount('¥1,000'), 1000);
  assert.equal(parseAmount(' 477 '), 477);
  assert.equal(parseAmount('15,980'), 15980);
});

test('parseAmount: 不正値は null', () => {
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(undefined), null);
});

test('parseAmount: 0 は 0 を返す(null ではない)', () => {
  assert.equal(parseAmount('0'), 0);
});

// ----------------------------------------------------------------- formatDate
test('formatDate: JST 変換(UTC 21:06 → 翌日)― 今治ケース', () => {
  assert.equal(formatDate('2026-07-08T21:06:11.011Z', true), '2026-07-09');
});

test('formatDate: UTC モードでは変換しない', () => {
  assert.equal(formatDate('2026-07-08T21:06:11.011Z', false), '2026-07-08');
});

test('formatDate: ミリ秒あり ISO・日を跨がないケース', () => {
  assert.equal(formatDate('2026-06-30T03:50:57.832Z', true), '2026-06-30');
});

test('formatDate: ミリ秒なし ISO', () => {
  assert.equal(formatDate('2025-04-13T07:22:17Z', true), '2025-04-13');
});

test('formatDate: パース不能時は先頭10文字フォールバック', () => {
  assert.equal(formatDate('not-a-date-string', true), 'not-a-date');
  assert.equal(formatDate('', true), '');
});

// ------------------------------------------------------------------- parseCsv
test('parseCsv: 基本のヘッダ付きパース', () => {
  const rows = parseCsv('a,b,c\r\n1,2,3\r\n4,5,6\r\n');
  assert.deepEqual(rows, [
    { a: '1', b: '2', c: '3' },
    { a: '4', b: '5', c: '6' },
  ]);
});

test('parseCsv: 引用符内のカンマ・改行・エスケープ引用符', () => {
  const rows = parseCsv('name,memo\r\n"A, B","line1\nline2"\r\n"say ""hi""",x\r\n');
  assert.deepEqual(rows, [
    { name: 'A, B', memo: 'line1\nline2' },
    { name: 'say "hi"', memo: 'x' },
  ]);
});

test('parseCsv: BOM を除去してヘッダを読む', () => {
  const rows = parseCsv('﻿ASIN,Total Amount\r\nB000,100\r\n');
  assert.deepEqual(rows, [{ ASIN: 'B000', 'Total Amount': '100' }]);
});

test('parseCsv: LF のみの改行・末尾改行なしにも対応', () => {
  const rows = parseCsv('a,b\n1,2');
  assert.deepEqual(rows, [{ a: '1', b: '2' }]);
});

// --------------------------------------------------------------- combineNames
test('combineNames: 同名は ×N 統合・出現順保持', () => {
  assert.equal(combineNames(['今治', '今治']), '今治×2');
  assert.equal(combineNames(['A', 'B']), 'A / B');
  assert.equal(combineNames(['A', 'B', 'A']), 'A×2 / B');
});

// ------------------------------------------------------ フィクスチャ(§7 準拠)
const H =
  'Payment Method Type,Order ID,Order Date,Ship Date,Product Name,Total Amount,Order Status';
function orderRow(pay, oid, ship, name, amount, status, orderDate) {
  return {
    'Payment Method Type': pay,
    'Order ID': oid,
    'Order Date': orderDate || ship || '',
    'Ship Date': ship,
    'Product Name': name,
    'Total Amount': amount,
    'Order Status': status,
  };
}

const FIXTURE_ORDERS = [
  orderRow('Visa - 5171', 'A', '2026-06-30T03:50:00Z', '紙コップ', '477', 'Closed'),
  orderRow('Visa - 5171', 'A', '2026-06-30T03:50:00Z', 'シート', '1,180', 'Closed'),
  orderRow('Visa - 5171', 'B', '2026-06-30T11:28:00Z', 'レノア', '1,811', 'Closed'),
  orderRow('Visa - 5171', 'C', '2026-07-08T21:06:00Z', '今治', '2,370', 'Closed'),
  orderRow('Visa - 5171', 'C', '2026-07-08T21:06:00Z', '今治', '2,370', 'Closed'),
  orderRow(
    'Gift Certificate/Card and Visa - 5171',
    'D',
    '2026-05-19T10:00:00Z',
    '敷パッド',
    '2,880',
    'Closed'
  ),
  orderRow('Visa - 5171', 'E', '2026-06-01T00:00:00Z', 'キャンセル品', '999', 'Cancelled'),
  orderRow('Visa - 1745', 'F', '2026-06-02T00:00:00Z', '対象外カード', '500', 'Closed'),
];

const FIXTURE_REFUNDS = [{ 'Order ID': 'B', 'Refund Amount': '200' }];

const DEFAULTS = {
  card: '5171',
  category: '生活費',
  subcategory: 'ゆうすけAmazon',
  store: 'Amazon',
  source: 'ゆうEPOS',
  aggregate: true,
  jst: true,
};

// -------------------------------------------------------------------- convert
test('convert: フィクスチャ全体 ― 4エントリ・合計10,888円', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  assert.equal(rows.length, 4);
  const total = rows.reduce((s, r) => s + Number(r[8]), 0);
  assert.equal(total, 1657 + 1611 + 4740 + 2880); // 10,888
});

test('convert: 同一注文・同一発送日は合算(477+1180=1657)', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const a = rows.find((r) => r[7].includes('紙コップ'));
  assert.ok(a);
  assert.equal(a[8], '1657');
  // 品目には予算いっぱいまで商品名を並べる(「ほか1点」で中身が消えない)
  assert.equal(a[7], '紙コップ / シート');
  // 既定のメモは注記と注文IDだけ(商品名は品目欄が持つ)
  assert.equal(a[3], '注文 A');
  assert.equal(a[0], '2026-06-30');
});

test('convert: 返金をネット集約(1811-200=1611)', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const b = rows.find((r) => r[7] === 'レノア');
  assert.ok(b);
  assert.equal(b[8], '1611');
});

test('convert: 数量2は ×2 表記で合算(2370×2=4740)・JST で 7/9 計上', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const c = rows.find((r) => r[7].includes('今治'));
  assert.ok(c);
  assert.equal(c[8], '4740');
  assert.equal(c[7], '今治×2');
  assert.equal(c[0], '2026-07-09');
});

test('convert: UTC モードでは今治は 7/8 計上', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, jst: false });
  const c = rows.find((r) => r[7].includes('今治'));
  assert.equal(c[0], '2026-07-08');
});

test('convert: ギフト券併用注文も部分一致で抽出される', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const d = rows.find((r) => r[7] === '敷パッド');
  assert.ok(d);
  assert.equal(d[8], '2880');
  assert.equal(d[0], '2026-05-19');
});

test('convert: キャンセル・対象外カードは除外される', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  assert.ok(!rows.some((r) => r[7].includes('キャンセル品')));
  assert.ok(!rows.some((r) => r[7].includes('対象外カード')));
});

test('convert: 全額返金(net<=0)は出力しない', () => {
  const orders = [
    orderRow('Visa - 5171', 'X', '2026-06-01T00:00:00Z', '全額返金品', '1,000', 'Closed'),
  ];
  const refunds = [{ 'Order ID': 'X', 'Refund Amount': '1000' }];
  const { rows, notes } = convert(orders, refunds, DEFAULTS);
  assert.equal(rows.length, 0);
  assert.ok(notes.some((n) => n.includes('実質0円')));
});

test('convert: 返金は最新発送日のグループから差し引く', () => {
  const orders = [
    orderRow('Visa - 5171', 'Y', '2026-06-01T00:00:00Z', '先発送', '1,000', 'Closed'),
    orderRow('Visa - 5171', 'Y', '2026-06-05T00:00:00Z', '後発送', '2,000', 'Closed'),
  ];
  const refunds = [{ 'Order ID': 'Y', 'Refund Amount': '500' }];
  const { rows } = convert(orders, refunds, DEFAULTS);
  const first = rows.find((r) => r[7] === '先発送');
  const last = rows.find((r) => r[7] === '後発送');
  assert.equal(first[8], '1000');
  assert.equal(last[8], '1500');
});

test('convert: 対象外注文への返金は無視される', () => {
  const refunds = [{ 'Order ID': 'ZZZ', 'Refund Amount': '999' }];
  const { rows } = convert(FIXTURE_ORDERS, refunds, DEFAULTS);
  const total = rows.reduce((s, r) => s + Number(r[8]), 0);
  assert.equal(total, 1657 + 1811 + 4740 + 2880);
});

test('convert: 日付昇順に整列される', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const dates = rows.map((r) => r[0]);
  assert.deepEqual(dates, [...dates].sort());
});

test('convert: Ship Date 空なら Order Date にフォールバック', () => {
  const orders = [
    orderRow('Visa - 5171', 'G', '', '未発送品', '300', 'Closed', '2026-06-15T00:00:00Z'),
  ];
  const { rows } = convert(orders, [], DEFAULTS);
  assert.equal(rows[0][0], '2026-06-15');
});

test('convert: 固定値が Zaim の取込設定と同じ列位置に入る(9列)', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const { COL, ZAIM_HEADER } = require('./core.js');
  assert.deepEqual(ZAIM_HEADER, [
    '日付',
    'カテゴリ',
    'カテゴリの内訳',
    'メモ',
    'お店',
    '支払元',
    '入金先',
    '品目',
    '支出金額',
  ]);
  for (const r of rows) {
    assert.equal(r.length, 9);
    assert.equal(r[COL.category], '生活費');
    assert.equal(r[COL.subcategory], 'ゆうすけAmazon');
    assert.equal(r[COL.store], 'Amazon');
    assert.equal(r[COL.source], 'ゆうEPOS');
    assert.equal(r[COL.receiver], ''); // 支出では使わないが列は空けておく
    assert.ok(r[COL.memo].length > 0);
  }
});

test('convert: aggregate=false は明細1行=1エントリ・返金無視', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, {
    ...DEFAULTS,
    aggregate: false,
  });
  assert.equal(rows.length, 6); // A×2, B, C×2, D(キャンセル・他カード除外)
  const b = rows.find((r) => r[7] === 'レノア');
  assert.equal(b[8], '1811'); // 返金は引かれない
});

test('convert: dateSource=order は注文日で計上する', () => {
  const orders = [
    orderRow(
      'Visa - 5171',
      'H',
      '2026-06-30T03:50:00Z', // Ship Date
      '注文日計上品',
      '500',
      'Closed',
      '2026-06-29T14:30:00Z' // Order Date
    ),
  ];
  const ship = convert(orders, [], DEFAULTS);
  assert.equal(ship.rows[0][0], '2026-06-30');
  const order = convert(orders, [], { ...DEFAULTS, dateSource: 'order' });
  assert.equal(order.rows[0][0], '2026-06-29');
});

test('convert: ギフト券併用の警告情報を返す', () => {
  const { warnings } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].names.includes('敷パッド'));
});

// -------------------------------------------------------------------- refunds
test('loadRefunds: Order ID ごとに返金額を合算・0/不正はスキップ', () => {
  const map = loadRefunds([
    { 'Order ID': 'B', 'Refund Amount': '200' },
    { 'Order ID': 'B', 'Refund Amount': '100' },
    { 'Order ID': 'C', 'Refund Amount': '0' },
    { 'Order ID': 'D', 'Refund Amount': 'abc' },
  ]);
  assert.deepEqual(map, { B: 300 });
});

// ---------------------------------------------------------------- detectCards
test('detectCards: Payment Method Type からカードを件数付きで検出', () => {
  const cards = detectCards(FIXTURE_ORDERS);
  const c5171 = cards.find((c) => c.card === '5171');
  const c1745 = cards.find((c) => c.card === '1745');
  assert.ok(c5171);
  assert.equal(c5171.count, 7); // キャンセル含む明細ベース(Visa-5171 ×6 + ギフト併用1)
  assert.equal(c5171.brand, 'Visa');
  assert.ok(c1745);
  assert.equal(c1745.count, 1);
  // 件数降順
  assert.equal(cards[0].card, '5171');
});

// ---------------------------------------------------------------- generateCsv
test('generateCsv: ヘッダ + BOM + CRLF・カンマ含みフィールドをクオート', () => {
  const csv = generateCsv([
    ['2026-06-30', '生活費', 'ゆうすけAmazon', 'memo', 'Amazon', 'ゆうEPOS', '', 'A / B', '1657'],
    ['2026-07-01', '生活費', 'ゆうすけAmazon', 'memo', 'Amazon', 'ゆうEPOS', '', 'X, Y', '100'],
  ]);
  assert.ok(
    csv.startsWith('﻿日付,カテゴリ,カテゴリの内訳,メモ,お店,支払元,入金先,品目,支出金額\r\n')
  );
  assert.ok(csv.includes('"X, Y"'));
  assert.ok(csv.endsWith('\r\n'));
  // クオート不要なフィールドはクオートしない(Python csv.writer と同じ最小クオート)
  assert.ok(csv.includes('A / B'));
  assert.ok(!csv.includes('"A / B"'));
});

test('generateCsv: 引用符を含むフィールドは "" にエスケープ', () => {
  const csv = generateCsv([['2026-01-01', 'c', 's', 'm', 'st', 'so', '', 'say "hi"', '1']]);
  assert.ok(csv.includes('"say ""hi"""'));
});

// ------------------------------------------------------------------ summarize
test('summarize: 件数・合計・期間を返す', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const s = summarize(rows);
  assert.equal(s.count, 4);
  assert.equal(s.total, 10888);
  assert.equal(s.minDate, '2026-05-19');
  assert.equal(s.maxDate, '2026-07-09');
});

// =====================================================================
// 2026-09-06 追加: 実データ(Zaim実績との突合)で判明した欠陥への対応
//   1) カード再発行で下4桁が変わると以降が丸ごと落ちる → 複数カード選択
//   2) 月次で取り込むため期間フィルタが要る
//   3) 複合 Ship Date("… and …")で TZ 変換が飛ぶ
//   4) ギフト券併用は実請求額を手動で上書きできないと Zaim と一致しない
// =====================================================================

const { splitDateValues, suggestSuccessors, listMonths } = require('./core.js');

// ------------------------------------------------- 複合 Ship Date(" and ")
test('splitDateValues: " and " 連結値を分解する', () => {
  assert.deepEqual(
    splitDateValues('2026-07-21T08:14:39.090Z and 2026-07-21T08:14:53.428Z'),
    ['2026-07-21T08:14:39.090Z', '2026-07-21T08:14:53.428Z']
  );
  assert.deepEqual(splitDateValues('2026-07-21T08:14:39.090Z'), ['2026-07-21T08:14:39.090Z']);
  assert.deepEqual(splitDateValues(''), []);
});

test('formatDate: " and " 連結値でも先頭値を TZ 変換する(従来は変換が飛んでいた)', () => {
  // UTC 20:00 は JST では翌日。連結値でも +9h されること。
  assert.equal(
    formatDate('2026-07-21T20:00:00.000Z and 2026-07-21T20:00:10.000Z', true),
    '2026-07-22'
  );
  assert.equal(
    formatDate('2026-07-21T20:00:00.000Z and 2026-07-21T20:00:10.000Z', false),
    '2026-07-21'
  );
});

test('convert: 複合 Ship Date で出荷日が異なる場合は注記を出す', () => {
  const rows = [
    orderRow(
      'Visa - 5171',
      'X',
      '2026-07-21T08:00:00Z and 2026-07-23T08:00:00Z',
      '箱',
      '900',
      'Closed'
    ),
  ];
  const { notes } = convert(rows, [], DEFAULTS);
  assert.ok(
    notes.some((n) => n.includes('出荷日が複数')),
    notes.join(' / ')
  );
});

// ------------------------------------------------------------ 複数カード選択
test('convert: cards 配列で複数カードを合算できる(カード再発行対応)', () => {
  const rows = [
    orderRow('Visa - 5171', 'A', '2026-07-08T00:00:00Z', '旧カード品', '1,000', 'Closed'),
    orderRow('Visa - 7474', 'B', '2026-07-20T00:00:00Z', '新カード品', '2,000', 'Closed'),
  ];
  const single = convert(rows, [], Object.assign({}, DEFAULTS, { cards: ['5171'] }));
  assert.equal(single.rows.length, 1);

  const both = convert(rows, [], Object.assign({}, DEFAULTS, { cards: ['5171', '7474'] }));
  assert.equal(both.rows.length, 2);
  assert.equal(
    both.rows.reduce((s, r) => s + Number(r[8]), 0),
    3000
  );
});

test('convert: cards 未指定なら従来どおり card 単体で動く(後方互換)', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  assert.equal(rows.length, 4);
});

test('convert: cards が空配列なら card にフォールバックする', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, Object.assign({}, DEFAULTS, { cards: [] }));
  assert.equal(rows.length, 4);
});

test('detectCards: カードごとの利用期間(初回・最終の計上日)を返す', () => {
  const rows = [
    orderRow('Visa - 5171', 'A', '2026-03-01T00:00:00Z', 'a', '100', 'Closed'),
    orderRow('Visa - 5171', 'B', '2026-07-09T00:00:00Z', 'b', '100', 'Closed'),
    orderRow('Visa - 7474', 'C', '2026-07-19T00:00:00Z', 'c', '100', 'Closed'),
  ];
  const cards = detectCards(rows);
  const c5171 = cards.find((c) => c.card === '5171');
  assert.equal(c5171.firstDate, '2026-03-01');
  assert.equal(c5171.lastDate, '2026-07-09');
  const c7474 = cards.find((c) => c.card === '7474');
  assert.equal(c7474.firstDate, '2026-07-19');
});

test('suggestSuccessors: 選択カードの利用停止後に始まったカードを後継候補として返す', () => {
  const cards = [
    { card: '5171', firstDate: '2026-03-01', lastDate: '2026-07-09' },
    { card: '7474', firstDate: '2026-07-19', lastDate: '2026-09-03' },
    { card: '1745', firstDate: '2026-02-02', lastDate: '2026-07-05' }, // 期間が重なるので後継ではない
  ];
  const s = suggestSuccessors(cards, ['5171']);
  assert.deepEqual(
    s.map((c) => c.card),
    ['7474']
  );
  // すでに両方選んでいれば提案しない
  assert.deepEqual(suggestSuccessors(cards, ['5171', '7474']), []);
});

// ---------------------------------------------------------------- 期間フィルタ
test('convert: dateFrom / dateTo で計上日を月単位に絞り込める', () => {
  const { rows } = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-06-01', dateTo: '2026-06-30' })
  );
  assert.equal(rows.length, 2); // 1657(6/30) と 1611(6/30)
  assert.equal(
    rows.reduce((s, r) => s + Number(r[8]), 0),
    1657 + 1611
  );
});

test('convert: 期間で切り出しても返金差引後の金額が保たれる', () => {
  const june = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-06-01', dateTo: '2026-06-30' })
  );
  assert.ok(june.rows.some((r) => Number(r[8]) === 1611));
});

test('convert: months に期間フィルタ前の全月とその件数・合計が入る', () => {
  const { months } = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-06-01', dateTo: '2026-06-30' })
  );
  assert.deepEqual(
    months.map((m) => m.month),
    ['2026-05', '2026-06', '2026-07']
  );
  const jun = months.find((m) => m.month === '2026-06');
  assert.equal(jun.count, 2);
  assert.equal(jun.total, 1657 + 1611);
});

test('listMonths: 出力行から月ごとの件数・合計を集計する', () => {
  const months = listMonths([
    ['2026-06-30', '', '', '', '', '', '', 'a', '100'],
    ['2026-06-01', '', '', '', '', '', '', 'b', '200'],
    ['2026-07-01', '', '', '', '', '', '', 'c', '300'],
  ]);
  assert.deepEqual(months, [
    { month: '2026-06', count: 2, total: 300 },
    { month: '2026-07', count: 1, total: 300 },
  ]);
});

// ------------------------------------------------- ギフト券併用の実請求額上書き
test('convert: amountOverrides で実請求額に上書きできる(ギフト券併用)', () => {
  const base = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const gift = base.warnings[0];
  assert.equal(gift.amount, 2880);

  const overrides = {};
  overrides[gift.key] = 1500;
  const fixed = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { amountOverrides: overrides })
  );
  const row = fixed.rows.find((r) => r[0] === gift.date);
  assert.equal(row[8], '1500');
  assert.ok(
    fixed.notes.some((n) => n.includes('金額を手動指定')),
    fixed.notes.join(' / ')
  );
});

test('convert: 上書き額が0以下なら出力しない', () => {
  const base = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const overrides = {};
  overrides[base.warnings[0].key] = 0;
  const fixed = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { amountOverrides: overrides })
  );
  assert.equal(fixed.rows.length, 3);
});

test('convert: warnings に上書き用のキーと元金額が入る', () => {
  const { warnings } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].key, 'D\t2026-05-19');
  assert.equal(warnings[0].rawAmount, 2880);
});

// -------------------------------------- カード明細が出荷単位で分割されるケース
// 実データ(収納ボックス 9,900円)では Amazon 1明細に対し EPOS は 4,950円×2件だった。
// 分割の要因は数量ではなく「出荷回数」(Ship Date が " and " 連結される)。
test('convert: 複数出荷の明細は meta.splitShipment で注意喚起できる', () => {
  const row = orderRow(
    'Visa - 7474',
    'Q',
    '2026-07-21T08:14:39.090Z and 2026-07-21T08:14:53.428Z',
    '収納ボックス',
    '9,900',
    'Closed'
  );
  const { meta, notes } = convert([row], [], Object.assign({}, DEFAULTS, { cards: ['7474'] }));
  assert.equal(meta.length, 1);
  assert.equal(meta[0].splitShipment, true);
  assert.equal(meta[0].shipmentCount, 2);
  assert.ok(
    notes.some((n) => n.includes('分割計上')),
    notes.join(' / ')
  );
});

test('convert: 数量2でも1回の出荷なら分割注記は出さない(誤検知防止)', () => {
  // 実データのセロテープ(564円・数量2)は EPOS 側でも1件のまま
  const row = orderRow('Visa - 5171', 'S', '2026-06-10T00:00:00Z', 'セロテープ', '564', 'Closed');
  row['Original Quantity'] = '2';
  const { meta, notes } = convert([row], [], DEFAULTS);
  assert.equal(meta[0].splitShipment, false);
  assert.equal(
    notes.some((n) => n.includes('分割計上')),
    false,
    notes.join(' / ')
  );
});

test('convert: meta は rows と同じ並び・同じ長さで返る', () => {
  const { rows, meta } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  assert.equal(meta.length, rows.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(meta[i].date, rows[i][0]);
    assert.equal(String(meta[i].amount), rows[i][8]);
  }
});

// ---------------------------------------------------------------------
// コードレビュー(2026-09-06)指摘の修正に対する回帰テスト
// ---------------------------------------------------------------------

test('convert: 期間フィルタは warnings にも効く(他月のギフト券注文を出さない)', () => {
  // D(ギフト券併用)は 2026-05-19。7月だけ切り出したら警告に出てはいけない
  const july = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-07-01', dateTo: '2026-07-31' })
  );
  assert.equal(july.warnings.length, 0);

  const may = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-05-01', dateTo: '2026-05-31' })
  );
  assert.equal(may.warnings.length, 1);
});

test('convert: 期間フィルタは notes にも効く(他月の返金・除外メモを出さない)', () => {
  const july = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-07-01', dateTo: '2026-07-31' })
  );
  assert.equal(
    july.notes.some((n) => n.includes('返金反映')),
    false,
    july.notes.join(' / ')
  );
  const june = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-06-01', dateTo: '2026-06-30' })
  );
  assert.ok(june.notes.some((n) => n.includes('返金反映')), june.notes.join(' / '));
});

test('convert: overrideKey は Order ID なので計上日の設定を変えても補正が外れない', () => {
  const base = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const gift = base.warnings[0];
  assert.equal(gift.overrideKey, 'D'); // 1注文=1グループなので Order ID 単独

  const overrides = {};
  overrides[gift.overrideKey] = 1500;

  for (const opts of [
    { dateSource: 'ship', jst: true },
    { dateSource: 'order', jst: true },
    { dateSource: 'ship', jst: false },
  ]) {
    const r = convert(
      FIXTURE_ORDERS,
      FIXTURE_REFUNDS,
      Object.assign({}, DEFAULTS, opts, { amountOverrides: overrides })
    );
    const row = r.rows.find((x) => x[7].includes('敷パッド'));
    assert.equal(row[8], '1500', `dateSource=${opts.dateSource} jst=${opts.jst} で補正が外れた`);
    assert.deepEqual(r.unmatchedOverrides, []);
  }
});

test('convert: どの注文にも当たらない上書きは握り潰さず表に出す', () => {
  const r = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { amountOverrides: { 'ZZZ\t2020-01-01': 999 } })
  );
  assert.deepEqual(r.unmatchedOverrides, ['ZZZ\t2020-01-01']);
  assert.ok(
    r.notes.some((n) => n.includes('適用できませんでした')),
    r.notes.join(' / ')
  );
});

test('convert: 1注文が複数グループに割れる場合は Order ID 単独キーを使わない', () => {
  // 同じ注文が別々の日に出荷 → どちらに当てるべきか決まらないので誤適用しない
  const rows = [
    orderRow('Visa - 5171', 'M', '2026-07-01T00:00:00Z', '前半', '1,000', 'Closed'),
    orderRow('Visa - 5171', 'M', '2026-07-05T00:00:00Z', '後半', '2,000', 'Closed'),
  ];
  const r = convert(rows, [], Object.assign({}, DEFAULTS, { amountOverrides: { M: 500 } }));
  assert.equal(r.rows.length, 2);
  assert.deepEqual(
    r.rows.map((x) => x[8]),
    ['1000', '2000']
  );
  assert.deepEqual(r.unmatchedOverrides, ['M']);

  // グループキー指定なら効く
  const r2 = convert(
    rows,
    [],
    Object.assign({}, DEFAULTS, { amountOverrides: { 'M\t2026-07-05': 500 } })
  );
  assert.deepEqual(
    r2.rows.map((x) => x[8]),
    ['1000', '500']
  );
  assert.deepEqual(r2.unmatchedOverrides, []);
});

// ------------------------------------------------- 日単位の期間指定(2026-09-06)
const { dateRange } = require('./core.js');

test('dateRange: 出力行の計上日レンジを返す(空なら空文字)', () => {
  assert.deepEqual(
    dateRange([
      ['2026-06-30', '', '', '', '', '', '', 'a', '1'],
      ['2026-05-01', '', '', '', '', '', '', 'b', '1'],
      ['2026-07-09', '', '', '', '', '', '', 'c', '1'],
    ]),
    { min: '2026-05-01', max: '2026-07-09' }
  );
  assert.deepEqual(dateRange([]), { min: '', max: '' });
});

test('convert: range は期間フィルタ前の全体レンジを返す', () => {
  const { range } = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-06-01', dateTo: '2026-06-30' })
  );
  assert.deepEqual(range, { min: '2026-05-19', max: '2026-07-09' });
});

test('convert: 日単位で1日だけ切り出せる', () => {
  const oneDay = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-06-30', dateTo: '2026-06-30' })
  );
  assert.equal(oneDay.rows.length, 2);
  assert.ok(oneDay.rows.every((r) => r[0] === '2026-06-30'));

  const empty = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-06-29', dateTo: '2026-06-29' })
  );
  assert.equal(empty.rows.length, 0);
});

test('convert: 月をまたぐ任意の日付範囲を切り出せる', () => {
  const { rows } = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-06-30', dateTo: '2026-07-09' })
  );
  assert.equal(rows.length, 3); // 1657 / 1611 / 4740
  assert.equal(
    rows.reduce((s, r) => s + Number(r[8]), 0),
    1657 + 1611 + 4740
  );
});

test('convert: dateFrom だけ / dateTo だけの片側指定も効く', () => {
  const from = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateFrom: '2026-07-01' })
  );
  assert.deepEqual(from.rows.map((r) => r[0]), ['2026-07-09']);

  const to = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { dateTo: '2026-05-31' })
  );
  assert.deepEqual(to.rows.map((r) => r[0]), ['2026-05-19']);
});

// =====================================================================
// 2026-09-07 追加: Zaim の取込画面に合わせた列構成と、品目/メモの整形
//   Zaim は CSV のヘッダ名を見ず「N 列目」で列を指定する。実機では
//   「支出の金額の列 = 6 列目」(＝品目の位置)が選ばれていて取込が壊れていた。
// =====================================================================

const { shortenName, itemLabel, zaimImportSettings } = require('./core.js');

// ------------------------------------------------------------- shortenName
test('shortenName: 宣伝ブロックを落として詰める', () => {
  assert.equal(
    shortenName('【まとめ買い】ニトリ 毎日とりかえキッチンスポンジ'),
    'ニトリ 毎日とりかえキッチンスポンジ'
  );
  assert.equal(shortenName('【Amazon限定】[2個セット]石けん'), '石けん');
  assert.equal(shortenName('レノア ハピネス【大容量】柔軟剤'), 'レノア ハピネス 柔軟剤');
});

test('shortenName: 開き括弧と同じ種類の閉じ括弧で1組にする', () => {
  // 種類を問わず最も近い閉じ括弧で止めると "C】" が残ってしまう
  assert.equal(shortenName('【A[B]C】ネスト'), 'ネスト');
});

test('shortenName: 括弧が閉じない・全部が装飾・空文字でも壊れない', () => {
  assert.equal(shortenName('【閉じ忘れ 商品名'), '【閉じ忘れ 商品名');
  assert.equal(shortenName('【全部装飾】'), '【全部装飾】'); // 空になるなら元を返す
  assert.equal(shortenName(''), '');
  assert.equal(shortenName(null), '');
  assert.equal(shortenName(undefined), '');
});

test('shortenName: 長い名前は切り詰めて … を付ける', () => {
  const s = 'あ'.repeat(40);
  const out = shortenName(s);
  assert.equal(Array.from(out).length, 25); // 24文字 + …
  assert.ok(out.endsWith('…'));
  assert.equal(shortenName('あ'.repeat(24)), 'あ'.repeat(24)); // ちょうどは切らない
});

test('shortenName: サロゲートペアを分断しない(CSVに � が混ざらない)', () => {
  // slice はコード単位で切るため、絵文字がちょうど境界にあると片方だけ残り、
  // UTF-8 に書き出した時点で置換文字になる
  const out = shortenName(`${'A'.repeat(23)}🎉BBBB`);
  const roundTrip = new TextDecoder().decode(new TextEncoder().encode(out));
  assert.equal(roundTrip, out);
  assert.ok(!roundTrip.includes('�'), `孤立サロゲート: ${JSON.stringify(out)}`);
});

// --------------------------------------------------------------- itemLabel
test('itemLabel: 1種類はそのまま、同名は ×N、複数種類は予算まで並べる', () => {
  assert.equal(itemLabel(['タオル']), 'タオル');
  assert.equal(itemLabel(['タオル', 'タオル']), 'タオル×2');
  assert.equal(itemLabel(['タオル', '石けん']), 'タオル / 石けん');
  assert.equal(itemLabel(['タオル', '石けん', '洗剤']), 'タオル / 石けん / 洗剤');
  assert.equal(itemLabel([]), '');
});

test('itemLabel: 予算を超える分だけ「ほかN点」に畳む(全体は予算内)', () => {
  const { ITEM_FIELD_MAX } = require('./core.js');
  const names = ['あ'.repeat(24), 'い'.repeat(24), 'う'.repeat(24), 'え'.repeat(24)];
  const out = itemLabel(names);
  assert.ok(Array.from(out).length <= ITEM_FIELD_MAX, `${out} (${Array.from(out).length}字)`);
  assert.ok(out.includes('あ') && out.includes('い'), out); // 入るだけ並べる
  assert.ok(/ ほか2点$/.test(out), out); // 残りは点数で示す
});

test('itemLabel: 「ほかN点」を足して予算を超えるなら、その1件は並べない', () => {
  // tail を足す前に判定すると、ちょうど境界で予算を1〜5文字はみ出す
  const { ITEM_FIELD_MAX } = require('./core.js');
  for (let len = 10; len <= 30; len++) {
    const names = ['あ'.repeat(len), 'い'.repeat(len), 'う'.repeat(len)];
    const out = itemLabel(names);
    assert.ok(
      Array.from(out).length <= ITEM_FIELD_MAX,
      `商品名${len}字: ${out} (${Array.from(out).length}字)`
    );
  }
});

test('itemLabel: 予算を指定できる(Zaim 側の上限が判明したら定数1つで追随する)', () => {
  assert.equal(itemLabel(['タオル', '石けん'], 8), 'タオル ほか1点');
  assert.ok(Array.from(itemLabel(['タオル', '石けん'], 8)).length <= 8);
});

// ------------------------------------------------------------------- メモ
test('convert: 既定のメモは注記と注文IDだけ(商品名は品目欄が持つ)', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const { COL } = require('./core.js');
  const a = rows.find((r) => r[COL.item].includes('紙コップ'));
  assert.equal(a[COL.memo], '注文 A');
});

test('convert: memo=full なら全商品名も入る / memo=none なら空欄', () => {
  const { COL } = require('./core.js');
  const full = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, memo: 'full' });
  const a = full.rows.find((r) => r[COL.item].includes('紙コップ'));
  assert.equal(a[COL.memo], '紙コップ / シート / 注文 A');

  const none = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, memo: 'none' });
  assert.ok(none.rows.every((r) => r[COL.memo] === ''), 'memo=none で空欄にならない行がある');
  // 金額・件数は変わらない
  assert.equal(none.rows.length, full.rows.length);
});

test('convert: メモに返金の注記が入る', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const { COL } = require('./core.js');
  const b = rows.find((r) => r[COL.item] === 'レノア');
  assert.ok(b[COL.memo].includes('返金200円を差引済み'), b[COL.memo]);
});

test('convert: 返金とギフト券併用が重なっても両方の注記が出る', () => {
  // 片方を else if にすると、返金がある注文だけギフト券の注記が静かに消える
  const rows = [
    orderRow(
      'Gift Certificate/Card and Visa - 5171',
      'G',
      '2026-06-01T00:00:00Z',
      'ギフト券+返金',
      '3,300',
      'Closed'
    ),
  ];
  const { rows: out } = convert(rows, [{ 'Order ID': 'G', 'Refund Amount': '300' }], DEFAULTS);
  const { COL } = require('./core.js');
  assert.equal(out[0][COL.amount], '3000');
  assert.ok(out[0][COL.memo].includes('返金300円を差引済み'), out[0][COL.memo]);
  assert.ok(out[0][COL.memo].includes('ギフト券併用'), out[0][COL.memo]);
});

test('convert: 実請求額を上書きしたらメモにも残る', () => {
  const base = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const overrides = {};
  overrides[base.warnings[0].overrideKey] = 1500;
  const fixed = convert(
    FIXTURE_ORDERS,
    FIXTURE_REFUNDS,
    Object.assign({}, DEFAULTS, { amountOverrides: overrides })
  );
  const { COL } = require('./core.js');
  const d = fixed.rows.find((r) => r[COL.item] === '敷パッド');
  assert.equal(d[COL.amount], '1500');
  assert.ok(d[COL.memo].includes('注文総額2880円→実請求額に補正'), d[COL.memo]);
});

test('convert: 複数出荷の注記がメモに入る', () => {
  const row = orderRow(
    'Visa - 5171',
    'S',
    '2026-07-21T08:00:00Z and 2026-07-21T08:00:10Z',
    '収納ボックス',
    '9,900',
    'Closed'
  );
  const { rows } = convert([row], [], DEFAULTS);
  const { COL } = require('./core.js');
  assert.ok(rows[0][COL.memo].includes('2回に分けて出荷'), rows[0][COL.memo]);
});

// ------------------------------------------------------- zaimImportSettings
test('zaimImportSettings: 列番号を ZAIM_HEADER から機械的に導く', () => {
  const { ZAIM_HEADER } = require('./core.js');
  const settings = zaimImportSettings();
  const valueOf = (label) => (settings.find((s) => s.label === label) || {}).value;
  const colOf = (label) => Number(String(valueOf(label)).replace(/\D/g, '')) - 1;

  // 案内の列番号が、実際のヘッダ位置と一致していること(ここがズレると取込が壊れる)
  assert.equal(ZAIM_HEADER[colOf('日付の列')], '日付');
  assert.equal(ZAIM_HEADER[colOf('カテゴリの列')], 'カテゴリ');
  assert.equal(ZAIM_HEADER[colOf('カテゴリ内訳の列')], 'カテゴリの内訳');
  assert.equal(ZAIM_HEADER[colOf('メモの列')], 'メモ');
  assert.equal(ZAIM_HEADER[colOf('お店の列')], 'お店');
  assert.equal(ZAIM_HEADER[colOf('支払元の列')], '支払元');
  assert.equal(ZAIM_HEADER[colOf('入金先の列')], '入金先');
  assert.equal(ZAIM_HEADER[colOf('品目の列')], '品目');
  assert.equal(ZAIM_HEADER[colOf('支出の金額の列')], '支出金額');

  // Zaim の画面と同じ順序で並んでいる = 上から順に 1,2,3… と入れるだけになる
  const columnValues = settings
    .filter((s) => /列目$/.test(s.value))
    .map((s) => Number(s.value.replace(/\D/g, '')));
  assert.deepEqual(columnValues, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // 使わない列は「存在しない」
  assert.equal(valueOf('収入の金額の列'), '存在しない');
  assert.equal(valueOf('振替の金額の列'), '存在しない');
  assert.equal(valueOf('区切り文字'), 'カンマ');
});

// =====================================================================
// 2026-09-12 追加: 実機で1件取り込んで判明した不具合への対応
//   A) メモが100文字を超えると Zaim が赤字を出して保存できない
//   B) 品目が「先頭 ほか1点」で、もう1品が何なのか分からない
//   C) 1支払い=複数明細は CSV 取込では不可能 → 商品ごとに1行(返金は按分)
//   D) カテゴリの内訳は2択に閉じる
//   E) 出力する行を選べるよう、非合算モードでも meta.key を一意にする
// =====================================================================

const { truncate, FIELD_MAX_LEN, ITEM_FIELD_MAX, MEMO_MODES, SUBCATEGORY_CHOICES } =
  require('./core.js');

// 実機で赤字になった注文の再現(長い商品名2品 + 注文ID で 100文字を超える)
const LONG_NAME_A =
  'サンプル乳液 モイスチャライジング つめかえ用 豆乳イソフラボン配合 130mL 医薬部外品';
const LONG_NAME_B =
  'サンプル浄水器ポット型 交換用カートリッジ 6個入 高除去タイプ 日本仕様 正規品';
const LONG_ORDERS = [
  orderRow('Visa - 5171', '503-1000012-0000122', '2026-06-05T04:00:00Z', LONG_NAME_A, '1,375', 'Closed'),
  orderRow('Visa - 5171', '503-1000012-0000122', '2026-06-05T04:00:00Z', LONG_NAME_B, '2,625', 'Closed'),
  ...FIXTURE_ORDERS,
];

const charLen = (s) => Array.from(s).length;
const sumAmount = (rows) => rows.reduce((s, r) => s + Number(r[8]), 0);

// -------------------------------------------------------------------- truncate
test('truncate: 戻り値は必ず maxLen 以下(… を足してはみ出さない)', () => {
  assert.equal(truncate('あいうえお', 10), 'あいうえお');
  assert.equal(truncate('あいうえお', 5), 'あいうえお'); // ちょうどは切らない
  assert.equal(truncate('あいうえお', 4), 'あいう…'); // 4文字に収まる
  assert.equal(truncate('あいうえお', 1), '…');
  assert.equal(truncate('あいうえお', 0), '');
  assert.equal(truncate('', 5), '');
  assert.equal(truncate(null, 5), '');
});

test('truncate: サロゲートペアを分断しない(CSVに ? が混ざらない)', () => {
  const out = truncate(`${'A'.repeat(9)}🎉BBB`, 10);
  const roundTrip = new TextDecoder().decode(new TextEncoder().encode(out));
  assert.equal(roundTrip, out);
  assert.ok(!roundTrip.includes('�'), JSON.stringify(out));
});

// ------------------------------------------- §9-1 / §9-2 全行が上限に収まること
test('convert: どのメモモードでも、全出力行のメモが100文字以下', () => {
  const { COL } = require('./core.js');
  for (const mode of MEMO_MODES) {
    const { rows } = convert(LONG_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, memo: mode });
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(
        charLen(r[COL.memo]) <= FIELD_MAX_LEN,
        `memo=${mode} で ${charLen(r[COL.memo])}字: ${r[COL.memo]}`
      );
    }
  }
});

test('convert: 全出力行の品目が予算以下(1件抜き取りでは長い注文を取りこぼす)', () => {
  const { COL } = require('./core.js');
  for (const opt of [{}, { splitByItem: true }, { aggregate: false }]) {
    const { rows } = convert(LONG_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, ...opt });
    for (const r of rows) {
      assert.ok(
        charLen(r[COL.item]) <= ITEM_FIELD_MAX,
        `${JSON.stringify(opt)} で ${charLen(r[COL.item])}字: ${r[COL.item]}`
      );
    }
  }
});

test('convert: 長い2品でも品目に両方の名前が出る(「ほか1点」の退行検知)', () => {
  const { COL } = require('./core.js');
  const { rows } = convert(LONG_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const row = rows.find((r) => r[COL.date] === '2026-06-05');
  assert.ok(row, '対象行が無い');
  assert.ok(row[COL.item].includes('乳液'), row[COL.item]);
  assert.ok(row[COL.item].includes('浄水器'), row[COL.item]);
  assert.ok(!row[COL.item].includes('ほか'), row[COL.item]);
  // 実機で赤字になったメモは、既定では注文IDだけになる
  assert.equal(row[COL.memo], '注文 503-1000012-0000122');
});

// ------------------------------------------------------- §9-3 注記が消えないこと
test('convert: memo=full で注記3種(返金・ギフト券・分割出荷)が同時に残る', () => {
  // 商品名を先に詰める実装だと、注記が末尾から押し出されて静かに消える
  const { COL } = require('./core.js');
  const row = orderRow(
    'Gift Certificate/Card and Visa - 5171',
    'T',
    '2026-06-01T00:00:00Z and 2026-06-02T00:00:00Z',
    `${LONG_NAME_A}${LONG_NAME_B}`, // わざと長い商品名
    '5,000',
    'Closed'
  );
  const { rows } = convert([row], [{ 'Order ID': 'T', 'Refund Amount': '500' }], {
    ...DEFAULTS,
    memo: 'full',
  });
  const memo = rows[0][COL.memo];
  assert.ok(charLen(memo) <= FIELD_MAX_LEN, `${charLen(memo)}字: ${memo}`);
  assert.ok(memo.includes('返金500円を差引済み'), memo);
  assert.ok(memo.includes('ギフト券併用'), memo);
  assert.ok(memo.includes('2回に分けて出荷'), memo);
  assert.ok(memo.includes('注文 T'), memo);
});

// --------------------------------------------------- §9-5 商品ごとに1行(splitByItem)
test('convert: splitByItem は行が増えても合計金額が合算モードと一致する', () => {
  const agg = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const split = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, splitByItem: true });
  assert.ok(split.rows.length > agg.rows.length, '行が分かれていない');
  assert.equal(sumAmount(split.rows), sumAmount(agg.rows));
});

test('convert: splitByItem で同一注文の2品が別行になり、品目に1品ずつ残る', () => {
  const { COL } = require('./core.js');
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, splitByItem: true });
  const a = rows.filter((r) => r[COL.date] === '2026-06-30' && Number(r[COL.amount]) !== 1611);
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((r) => r[COL.item]).sort(), ['シート', '紙コップ']);
  assert.deepEqual(a.map((r) => r[COL.amount]).sort(), ['1180', '477']);
});

test('convert: splitByItem でも同名商品は1行に ×N でまとまる', () => {
  const { COL } = require('./core.js');
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, splitByItem: true });
  const c = rows.find((r) => r[COL.item].includes('今治'));
  assert.equal(c[COL.item], '今治×2');
  assert.equal(c[COL.amount], '4740');
});

// ------------------------------------------------------------- §9-6 返金の按分
test('convert: 1商品の額を超える返金は注文内の他の行へ繰り越す(過大計上の防止)', () => {
  const orders = [
    orderRow('Visa - 5171', 'R', '2026-06-01T00:00:00Z', '安い品', '500', 'Closed'),
    orderRow('Visa - 5171', 'R', '2026-06-01T00:00:00Z', '高い品', '2,000', 'Closed'),
  ];
  const refunds = [{ 'Order ID': 'R', 'Refund Amount': '2200' }];
  const { rows } = convert(orders, refunds, { ...DEFAULTS, splitByItem: true });
  // 2,500 − 2,200 = 300。高い品(2,000)を使い切り、残り200を安い品から引く
  assert.equal(sumAmount(rows), 300);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][7], '安い品');
  assert.equal(rows[0][8], '300');
});

test('convert: 使い切れなかった返金は握り潰さず注記に出す', () => {
  const orders = [
    orderRow('Visa - 5171', 'R2', '2026-06-01T00:00:00Z', '品', '1,000', 'Closed'),
  ];
  const { rows, notes } = convert(orders, [{ 'Order ID': 'R2', 'Refund Amount': '3000' }], DEFAULTS);
  assert.equal(rows.length, 0);
  assert.ok(
    notes.some((n) => n.includes('差し引く明細がありません')),
    notes.join(' / ')
  );
});

test('convert: 返金は発送日が新しいグループから順に充当する(合算モードは従来どおり)', () => {
  const orders = [
    orderRow('Visa - 5171', 'Y2', '2026-06-01T00:00:00Z', '先発送', '1,000', 'Closed'),
    orderRow('Visa - 5171', 'Y2', '2026-06-05T00:00:00Z', '後発送', '2,000', 'Closed'),
  ];
  const { rows } = convert(orders, [{ 'Order ID': 'Y2', 'Refund Amount': '2,500' }], DEFAULTS);
  // 後発送(2,000)を使い切り、残り500を先発送から引く
  assert.deepEqual(
    rows.map((r) => [r[7], r[8]]),
    [['先発送', '500']]
  );
});

// --------------------------------------------------- §6 行の選択に使う meta.key
test('convert: aggregate=false でも meta.key が行ごとに一意(空文字にしない)', () => {
  // 空文字のままだと全行が同一キーになり、1行外した瞬間に全行が消える
  const { meta } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, aggregate: false });
  const keys = meta.map((m) => m.key);
  assert.ok(
    keys.every((k) => k),
    '空のキーがある'
  );
  assert.equal(new Set(keys).size, keys.length, `重複キー: ${keys.join(' , ')}`);
  assert.ok(
    meta.every((m) => m.oid),
    '注文IDが入っていない'
  );
});

test('convert: splitByItem でも meta.key は行ごとに一意', () => {
  const { rows, meta } = convert(LONG_ORDERS, FIXTURE_REFUNDS, {
    ...DEFAULTS,
    splitByItem: true,
  });
  const keys = meta.map((m) => m.key);
  assert.equal(meta.length, rows.length);
  assert.equal(new Set(keys).size, keys.length);
});

// ------------------------------------------------------- §5 カテゴリの内訳(2択)
test('SUBCATEGORY_CHOICES: 選択肢は2つ・既定は先頭・ファイル名タグを持つ', () => {
  const { DEFAULT_OPTIONS } = require('./core.js');
  assert.deepEqual(
    SUBCATEGORY_CHOICES.map((c) => c.value),
    ['ゆうすけAmazon', 'ともかAmazon']
  );
  assert.equal(DEFAULT_OPTIONS.subcategory, 'ゆうすけAmazon');
  assert.ok(
    SUBCATEGORY_CHOICES.every((c) => /^[a-z]+$/.test(c.tag)),
    'タグは ASCII'
  );
});

test('convert: subcategory を切り替えると3列目が変わる', () => {
  const { COL } = require('./core.js');
  for (const choice of SUBCATEGORY_CHOICES) {
    const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, {
      ...DEFAULTS,
      subcategory: choice.value,
    });
    assert.ok(rows.every((r) => r[COL.subcategory] === choice.value));
  }
});

// ------------------------------------------- 内訳と支払元の連動(2026-09-12 追加)
// 内訳と支払元は1:1で決まる(ともかAmazon の買い物は ともEPOS 払い)。選ばせない。
const { sourceForSubcategory } = require('./core.js');

test('sourceForSubcategory: 内訳に対応する支払元を返す(未知なら null)', () => {
  assert.equal(sourceForSubcategory('ゆうすけAmazon'), 'ゆうEPOS');
  assert.equal(sourceForSubcategory('ともかAmazon'), 'ともEPOS');
  assert.equal(sourceForSubcategory('存在しない内訳'), null);
  assert.equal(sourceForSubcategory(''), null);
});

test('SUBCATEGORY_CHOICES: 支払元は Zaim に実在する口座名(綴りを変えない)', () => {
  // 1文字でも違うと Zaim 側に新しい口座が増える。実エクスポートで確認した綴り。
  assert.deepEqual(
    SUBCATEGORY_CHOICES.map((c) => c.source),
    ['ゆうEPOS', 'ともEPOS']
  );
});

test('convert: source 未指定なら内訳に対応する支払元が入る', () => {
  const { COL } = require('./core.js');
  const base = { ...DEFAULTS };
  delete base.source;

  const yusuke = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, base);
  assert.ok(yusuke.rows.every((r) => r[COL.source] === 'ゆうEPOS'));

  const tomoka = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, {
    ...base,
    subcategory: 'ともかAmazon',
  });
  assert.ok(
    tomoka.rows.every((r) => r[COL.source] === 'ともEPOS'),
    tomoka.rows.map((r) => r[COL.source]).join(',')
  );
  // 金額は変わらない
  assert.equal(
    tomoka.rows.reduce((s, r) => s + Number(r[COL.amount]), 0),
    yusuke.rows.reduce((s, r) => s + Number(r[COL.amount]), 0)
  );
});

test('convert: source を明示したらそちらが優先される(空文字は空欄の指定)', () => {
  const { COL } = require('./core.js');
  const base = { ...DEFAULTS, subcategory: 'ともかAmazon' };

  const explicit = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...base, source: '楽天カード' });
  assert.ok(explicit.rows.every((r) => r[COL.source] === '楽天カード'));

  // 空文字は「自動で埋める」ではなく「空欄にする」
  const blank = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...base, source: '' });
  assert.ok(blank.rows.every((r) => r[COL.source] === ''));
});
