#!/usr/bin/env node
/**
 * ダミーデータ生成: 本番の Your Orders.zip と同一構造・PII なしの合成データを作る。
 *
 *   実行: node scripts/make_dummy_data.js
 *
 * 生成物(testdata/dummy/ 配下・コミット可):
 *   - Your Orders/Your Amazon Orders/Order History.csv   (実物と同じ28列・BOM・CRLF)
 *   - Your Orders/Your Returns & Refunds/Refund Details.csv (実物と同じ13列)
 *   - Your Orders/Your Amazon Orders/Cart History.csv     (アプリが無視すべきファイル)
 *   - Your Orders/Additional Data/.../*.pdf               (実物にある大量PDFの模擬)
 *   - Your Orders.zip                                     (上記をまとめた投入用ZIP)
 *
 * 収録シナリオ(単体テストと同じ検証観点を実データ形式で再現):
 *   D001 同一注文2品を合算 / D002 部分返金 / D003 JST日跨ぎ+数量2 /
 *   D004 ギフト券併用 / D005 キャンセル除外 / D007 全額返金除外 /
 *   D008 単品 / 別カード(1745, Amex 1002)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('../web/vendor/jszip.min.js');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'testdata', 'dummy');
const BOM = '﻿';

const DUMMY_ADDR =
  'ダミー 太郎 100-8111 東京都千代田区千代田1-1 ダミーマンション101号室 JP';

// --- CSV 書き出し(実物同様: BOM + CRLF + 必要時のみクオート) ---------------
function q(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(header, rows) {
  return (
    BOM + [header, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n'
  );
}
function comma(n) {
  return n.toLocaleString('en-US'); // 実物と同じ "1,811" 形式
}

// --- Order History.csv(28列・実物と同じ並び) ------------------------------
const ORDER_HEADER = [
  'ASIN', 'Billing Address', 'Carrier Name & Tracking Number', 'Currency',
  'Gift Message', 'Gift Recipient Contact', 'Gift Sender Name', 'Item Serial Number',
  'Order Date', 'Order ID', 'Order Status', 'Original Quantity',
  'Payment Method Type', 'Product Condition', 'Product Name', 'Purchase Order Number',
  'Ship Date', 'Shipment Item Subtotal', 'Shipment Item Subtotal Tax', 'Shipment Status',
  'Shipping Address', 'Shipping Charge', 'Shipping Option', 'Total Amount',
  'Total Discounts', 'Unit Price', 'Unit Price Tax', 'Website',
];

/** 使うカラムだけ指定し、残りは実物風の既定値で埋める。 */
function orderRow(o) {
  const total = o.total;
  const subtotal = Math.round(total / 1.1);
  return [
    o.asin,
    DUMMY_ADDR,
    `ヤマト運輸 - ${o.tracking || '000000000000'}`,
    'JPY',
    'Not Available', 'Not Available', 'Not Available', 'Not Available',
    o.orderDate,
    o.orderId,
    o.status || 'Closed',
    String(o.qty || 1),
    o.payment,
    'New',
    o.name,
    'Not Applicable',
    o.shipDate,
    comma(subtotal),
    comma(total - subtotal),
    o.status === 'Cancelled' ? 'Not Available' : 'Shipped',
    DUMMY_ADDR,
    '0',
    'std-jp-local',
    comma(total),
    '0',
    comma(subtotal),
    comma(total - subtotal),
    'Amazon.co.jp',
  ];
}

const ORDERS = [
  // D001: 同一注文・同一発送日の2品 → 477 + 1,180 = 1,657 に合算される
  orderRow({
    asin: 'B0DUMMY0001', orderId: '503-1000001-0000011',
    orderDate: '2026-06-29T14:30:46Z', shipDate: '2026-06-30T03:50:57.832Z',
    payment: 'Visa - 5171', total: 477, tracking: '498765432101',
    name: 'サンプル紙皿 ホワイト 業務用 200枚入 使い捨て 22cm パーティー用',
  }),
  orderRow({
    asin: 'B0DUMMY0002', orderId: '503-1000001-0000011',
    orderDate: '2026-06-29T14:30:46Z', shipDate: '2026-06-30T03:50:57.832Z',
    payment: 'Visa - 5171', total: 1180, tracking: '498765432101',
    name: 'サンプルウェットティッシュ ノンアルコール除菌 詰替 320枚(80枚×4個)',
  }),
  // D002: 部分返金あり → 1,811 − 200 = 1,611
  orderRow({
    asin: 'B0DUMMY0003', orderId: '503-1000002-0000022',
    orderDate: '2026-06-29T10:15:30Z', shipDate: '2026-06-30T11:28:44.120Z',
    payment: 'Visa - 5171', total: 1811, tracking: '498765432102',
    name: 'サンプル柔軟剤 フローラルの香り 詰め替え 大容量 1900mL',
  }),
  // D003: JST 日跨ぎ(UTC 7/8 21:06 → JST 7/9)+ 同一商品2個 → ×2 で 4,740
  orderRow({
    asin: 'B0DUMMY0004', orderId: '503-1000003-0000033',
    orderDate: '2026-07-07T09:45:12Z', shipDate: '2026-07-08T21:06:11.011Z',
    payment: 'Visa - 5171', total: 2370, tracking: '498765432103',
    name: 'サンプルフェイスタオル 綿100% 5枚組 ホテル仕様 (ネイビー)',
  }),
  orderRow({
    asin: 'B0DUMMY0004', orderId: '503-1000003-0000033',
    orderDate: '2026-07-07T09:45:12Z', shipDate: '2026-07-08T21:06:11.011Z',
    payment: 'Visa - 5171', total: 2370, tracking: '498765432103',
    name: 'サンプルフェイスタオル 綿100% 5枚組 ホテル仕様 (ネイビー)',
  }),
  // D004: ギフト券併用 → 抽出されるが警告表示の対象
  orderRow({
    asin: 'B0DUMMY0005', orderId: '503-1000004-0000044',
    orderDate: '2026-05-19T02:10:05Z', shipDate: '2026-05-20T08:22:39.500Z',
    payment: 'Gift Certificate/Card and Visa - 5171', total: 5760, tracking: '498765432104',
    name: 'サンプル冷感敷きパッド セミダブル 夏用 リバーシブル 洗える (ブルー)',
  }),
  // D005: キャンセル → 除外される
  orderRow({
    asin: 'B0DUMMY0006', orderId: '503-1000005-0000055',
    orderDate: '2026-06-01T12:00:00Z', shipDate: '',
    payment: 'Visa - 5171', total: 999, status: 'Cancelled',
    name: 'サンプルキャンセル品 タンブラー 450mL',
  }),
  // D007: 全額返金 → net 0 円で出力されない
  orderRow({
    asin: 'B0DUMMY0007', orderId: '503-1000007-0000077',
    orderDate: '2026-06-10T03:33:21Z', shipDate: '2026-06-11T01:05:59.900Z',
    payment: 'Visa - 5171', total: 1000, tracking: '498765432105',
    name: 'サンプル全額返金品 LED電球 60W相当 2個セット',
  }),
  // D008: 単品(品目にカンマ入り → CSV クオートの検証を兼ねる)
  orderRow({
    asin: 'B0DUMMY0008', orderId: '503-1000008-0000088',
    orderDate: '2026-07-04T22:11:08Z', shipDate: '2026-07-05T04:40:17.300Z',
    payment: 'Visa - 5171', total: 1280, tracking: '498765432106',
    name: 'サンプルシャンプー 詰め替え用 400mL (無香料, 敏感肌用)',
  }),
  // 別カード: Visa - 1745(プルダウン検証用・5171 では抽出されない)
  orderRow({
    asin: 'B0DUMMY0101', orderId: '503-2000001-0000111',
    orderDate: '2026-06-15T05:00:00Z', shipDate: '2026-06-16T02:30:00.000Z',
    payment: 'Visa - 1745', total: 3480, tracking: '498765432201',
    name: 'サンプル収納ボックス 折りたたみ 3個セット (グレー)',
  }),
  orderRow({
    asin: 'B0DUMMY0102', orderId: '503-2000002-0000222',
    orderDate: '2026-07-01T08:20:00Z', shipDate: '2026-07-02T03:10:00.000Z',
    payment: 'Visa - 1745', total: 890, tracking: '498765432202',
    name: 'サンプル食器用スポンジ 10個入',
  }),
  // 別カード: American Express - 1002(3種類目)
  orderRow({
    asin: 'B0DUMMY0201', orderId: '503-3000001-0000333',
    orderDate: '2026-06-20T11:11:11Z', shipDate: '2026-06-21T06:45:00.000Z',
    payment: 'American Express - 1002', total: 12800, tracking: '498765432301',
    name: 'サンプル電気ケトル 1.0L 温度調節機能付き ブラック',
  }),
];

// --- Refund Details.csv(13列・実物と同じ並び) -----------------------------
const REFUND_HEADER = [
  'Creation Date', 'Currency', 'Direct Debit Refund Amount', 'Disbursement Type',
  'Order ID', 'Payment Status', 'Quantity', 'Refund Amount', 'Refund Date',
  'Reversal Amount State', 'Reversal Reason', 'Reversal Status', 'Website',
];

const REFUNDS = [
  // D002 への部分返金(発送遅延 200円)
  ['2026-06-29T22:00:52.027Z', 'JPY', '0', 'Refund', '503-1000002-0000022',
    'Completed', '1', '200', '2026-07-01T16:02:06.468Z', 'Final',
    'Item shipped late', 'Completed', 'Amazon.co.jp'],
  // D007 への全額返金(返品 1,000円)
  ['2026-06-14T10:30:00.000Z', 'JPY', '0', 'Refund', '503-1000007-0000077',
    'Completed', '1', '1,000', '2026-06-15T09:00:00.000Z', 'Final',
    'Customer return', 'Completed', 'Amazon.co.jp'],
];

// --- アプリが無視すべきダミーファイル ---------------------------------------
const CART_HISTORY = toCsv(
  ['Action', 'Added Date', 'ASIN', 'Cart Domain', 'Cart List', 'Quantity', 'One Click Buyable', 'To Be Gift Wrapped'],
  [['AddToCart', '2026-06-29T14:00:00Z', 'B0DUMMY0001', 'Amazon.co.jp', 'Active', '1', 'No', 'No']]
);

/** 最小の正しい PDF(1ページ・空)― Additional Data の大量 PDF の模擬。 */
const MINI_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n0\n%%EOF\n',
  'latin1'
);

// --- 出力 --------------------------------------------------------------------
async function main() {
  const orderCsv = toCsv(ORDER_HEADER, ORDERS);
  const refundCsv = toCsv(REFUND_HEADER, REFUNDS);

  // 1) 展開済みフォルダ(Python 参照実装 --base testdata/dummy 用)
  const dirs = [
    path.join(OUT_DIR, 'Your Orders', 'Your Amazon Orders'),
    path.join(OUT_DIR, 'Your Orders', 'Your Returns & Refunds'),
    path.join(OUT_DIR, 'Your Orders', 'Additional Data', 'Retail.TransactionalInvoicing.3.1'),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs[0], 'Order History.csv'), orderCsv);
  fs.writeFileSync(path.join(dirs[0], 'Cart History.csv'), CART_HISTORY);
  fs.writeFileSync(path.join(dirs[1], 'Refund Details.csv'), refundCsv);
  fs.writeFileSync(path.join(dirs[2], 'Retail.TransactionalInvoicing.1.pdf'), MINI_PDF);
  fs.writeFileSync(path.join(dirs[2], 'Retail.TransactionalInvoicing.2.pdf'), MINI_PDF);

  // 2) 投入用 ZIP(実物と同じ内部パス)
  const zip = new JSZip();
  zip.file('Your Orders/Your Amazon Orders/Order History.csv', orderCsv);
  zip.file('Your Orders/Your Amazon Orders/Cart History.csv', CART_HISTORY);
  zip.file('Your Orders/Your Returns & Refunds/Refund Details.csv', refundCsv);
  zip.file(
    'Your Orders/Additional Data/Retail.TransactionalInvoicing.3.1/Retail.TransactionalInvoicing.1.pdf',
    MINI_PDF
  );
  zip.file(
    'Your Orders/Additional Data/Retail.TransactionalInvoicing.3.1/Retail.TransactionalInvoicing.2.pdf',
    MINI_PDF
  );
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const zipPath = path.join(OUT_DIR, 'Your Orders.zip');
  fs.writeFileSync(zipPath, zipBuf);

  console.log(`[OK] ダミーデータ生成完了: ${OUT_DIR}`);
  console.log(`     - Order History.csv: ${ORDERS.length} 明細(カード3種)`);
  console.log(`     - Refund Details.csv: ${REFUNDS.length} 返金`);
  console.log(`     - Your Orders.zip: ${(zipBuf.length / 1024).toFixed(1)} KB`);
  console.log('期待値(card=5171, JST, 合算, 返金ネット):');
  console.log('     5 エントリ / 合計 15,048 円 / 期間 2026-05-20 〜 2026-07-09');
}

main().catch((e) => {
  console.error('[NG] 生成失敗:', e);
  process.exitCode = 1;
});
