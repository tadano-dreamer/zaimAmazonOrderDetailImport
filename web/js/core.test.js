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
  subcategory: 'ゆうすけインポート',
  store: 'Amazon',
  source: 'ゆうEPOS',
  aggregate: true,
  jst: true,
};

// -------------------------------------------------------------------- convert
test('convert: フィクスチャ全体 ― 4エントリ・合計10,888円', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  assert.equal(rows.length, 4);
  const total = rows.reduce((s, r) => s + Number(r[6]), 0);
  assert.equal(total, 1657 + 1611 + 4740 + 2880); // 10,888
});

test('convert: 同一注文・同一発送日は合算(477+1180=1657)', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const a = rows.find((r) => r[5].includes('紙コップ'));
  assert.ok(a);
  assert.equal(a[6], '1657');
  assert.equal(a[5], '紙コップ / シート');
  assert.equal(a[0], '2026-06-30');
});

test('convert: 返金をネット集約(1811-200=1611)', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const b = rows.find((r) => r[5] === 'レノア');
  assert.ok(b);
  assert.equal(b[6], '1611');
});

test('convert: 数量2は ×2 表記で合算(2370×2=4740)・JST で 7/9 計上', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const c = rows.find((r) => r[5].includes('今治'));
  assert.ok(c);
  assert.equal(c[6], '4740');
  assert.equal(c[5], '今治×2');
  assert.equal(c[0], '2026-07-09');
});

test('convert: UTC モードでは今治は 7/8 計上', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, { ...DEFAULTS, jst: false });
  const c = rows.find((r) => r[5].includes('今治'));
  assert.equal(c[0], '2026-07-08');
});

test('convert: ギフト券併用注文も部分一致で抽出される', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  const d = rows.find((r) => r[5] === '敷パッド');
  assert.ok(d);
  assert.equal(d[6], '2880');
  assert.equal(d[0], '2026-05-19');
});

test('convert: キャンセル・対象外カードは除外される', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  assert.ok(!rows.some((r) => r[5].includes('キャンセル品')));
  assert.ok(!rows.some((r) => r[5].includes('対象外カード')));
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
  const first = rows.find((r) => r[5] === '先発送');
  const last = rows.find((r) => r[5] === '後発送');
  assert.equal(first[6], '1000');
  assert.equal(last[6], '1500');
});

test('convert: 対象外注文への返金は無視される', () => {
  const refunds = [{ 'Order ID': 'ZZZ', 'Refund Amount': '999' }];
  const { rows } = convert(FIXTURE_ORDERS, refunds, DEFAULTS);
  const total = rows.reduce((s, r) => s + Number(r[6]), 0);
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

test('convert: 固定値(カテゴリ・内訳・お店・支払い元)が7列に入る', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, DEFAULTS);
  for (const r of rows) {
    assert.equal(r.length, 7);
    assert.equal(r[1], '生活費');
    assert.equal(r[2], 'ゆうすけインポート');
    assert.equal(r[3], 'Amazon');
    assert.equal(r[4], 'ゆうEPOS');
  }
});

test('convert: aggregate=false は明細1行=1エントリ・返金無視', () => {
  const { rows } = convert(FIXTURE_ORDERS, FIXTURE_REFUNDS, {
    ...DEFAULTS,
    aggregate: false,
  });
  assert.equal(rows.length, 6); // A×2, B, C×2, D(キャンセル・他カード除外)
  const b = rows.find((r) => r[5] === 'レノア');
  assert.equal(b[6], '1811'); // 返金は引かれない
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
    ['2026-06-30', '生活費', 'ゆうすけインポート', 'Amazon', 'ゆうEPOS', 'A / B', '1657'],
    ['2026-07-01', '生活費', 'ゆうすけインポート', 'Amazon', 'ゆうEPOS', 'X, Y', '100'],
  ]);
  assert.ok(csv.startsWith('﻿日付,カテゴリ,カテゴリの内訳,お店,支払い元,品目,支出金額\r\n'));
  assert.ok(csv.includes('"X, Y"'));
  assert.ok(csv.endsWith('\r\n'));
  // クオート不要なフィールドはクオートしない(Python csv.writer と同じ最小クオート)
  assert.ok(csv.includes('A / B'));
  assert.ok(!csv.includes('"A / B"'));
});

test('generateCsv: 引用符を含むフィールドは "" にエスケープ', () => {
  const csv = generateCsv([['2026-01-01', 'c', 's', 'st', 'so', 'say "hi"', '1']]);
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
