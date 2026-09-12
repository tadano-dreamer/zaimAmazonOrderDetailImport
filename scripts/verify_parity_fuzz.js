#!/usr/bin/env node
/**
 * JS(web/js/core.js)と Python 参照実装(scripts/amazon_to_zaim.py)の同値性を、
 * **ランダム生成データ**で確かめる。
 *
 *   実行: node scripts/verify_parity_fuzz.js   (要 python。引数に seed 数を渡せる)
 *
 * なぜ要るか: 固定のダミーデータ(testdata/dummy)は境界を薄くしか踏まない。
 * 「メモがちょうど100文字」「品目の予算ぎりぎり」「返金が明細の合計を超える」
 * といった際どい組み合わせは、長さと構成を振ったデータを何本も通して初めて出る。
 * 2つの実装は別々に書いてあるので、切り詰めの計算が1文字ずれただけで出力が食い違う。
 *
 * 実データ(PII)には一切触らない。生成物は OS の一時フォルダに置く。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const core = require(path.join(REPO, 'web', 'js', 'core.js'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'zaim-parity-'));

/** python / python3 のどちらで動くか、実際に呼んで決める。 */
function resolvePython() {
  for (const cmd of ['python', 'python3']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'pipe' });
      return cmd;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

// --- 決定的な乱数(seed を変えれば別のデータになる) -------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ORDER_HEADER = [
  'Order ID', 'Order Date', 'Ship Date', 'Product Name', 'Total Amount',
  'Order Status', 'Payment Method Type',
];
const REFUND_HEADER = ['Order ID', 'Refund Amount'];
const BOM = '﻿';

function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (header, rows) =>
  BOM + [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';

/** 長さを振った商品名(装飾ブロック・絵文字・カンマを混ぜる)。 */
function productName(rand, i) {
  const len = 1 + Math.floor(rand() * 60);
  const base = 'あいうえおカキクケコ漢字テスト商品名ABCdef0123'.repeat(4);
  const deco = rand() < 0.3 ? '【まとめ買い】' : rand() < 0.2 ? '[大容量]' : '';
  const emoji = rand() < 0.15 ? '🎉' : ''; // サロゲートペアを境界に置く
  const comma = rand() < 0.15 ? ', 詰替' : ''; // CSV クオートを踏ませる
  return `${deco}商品${i}${base.slice(0, len)}${emoji}${comma}`;
}

function makeData(seed) {
  const rand = rng(seed);
  const orders = [];
  const refunds = [];
  const orderCount = 3 + Math.floor(rand() * 12);
  for (let o = 0; o < orderCount; o++) {
    const oid = `503-${1000000 + o}-${9000000 + o}`;
    const day = 1 + Math.floor(rand() * 28);
    const month = 5 + Math.floor(rand() * 3);
    const hour = Math.floor(rand() * 24); // JST の日跨ぎを踏ませる
    const ship =
      `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` +
      `T${String(hour).padStart(2, '0')}:30:00.000Z`;
    const items = 1 + Math.floor(rand() * 4);
    let total = 0;
    for (let k = 0; k < items; k++) {
      const amount = 100 + Math.floor(rand() * 9000);
      total += amount;
      // 同じ商品名を2回出して ×N もテストする
      const name =
        k > 0 && rand() < 0.3 ? productName(rand, o * 10) : productName(rand, o * 10 + k);
      const multiShip = rand() < 0.15 ? ` and ${ship}` : ''; // 複数出荷
      orders.push([
        oid,
        ship,
        ship + multiShip,
        name,
        amount.toLocaleString('en-US'),
        rand() < 0.08 ? 'Cancelled' : 'Closed',
        rand() < 0.2 ? 'Gift Certificate/Card and Visa - 5171' : 'Visa - 5171',
      ]);
    }
    // 返金: 一部 / 全額 / 明細合計を超える額(按分を使い切る)を混ぜる
    if (rand() < 0.35) {
      const kind = rand();
      const amt = kind < 0.5 ? Math.floor(total * 0.2) : kind < 0.8 ? total : total + 5000;
      if (amt > 0) refunds.push([oid, String(amt)]);
    }
  }
  return { orders, refunds };
}

const MODES = [
  { label: '既定', cli: [], js: {} },
  { label: 'memo=full', cli: ['--memo', 'full'], js: { memo: 'full' } },
  { label: 'memo=none', cli: ['--memo', 'none'], js: { memo: 'none' } },
  { label: '商品ごとに1行', cli: ['--split-items'], js: { splitByItem: true } },
  { label: '明細ごと', cli: ['--no-aggregate'], js: { aggregate: false } },
  { label: 'UTC', cli: ['--tz', 'utc'], js: { jst: false } },
  {
    label: '内訳=ともか',
    cli: ['--subcategory', 'ともかAmazon'],
    js: { subcategory: 'ともかAmazon' },
  },
];

const toLines = (t) => t.replace(/^﻿/, '').split(/\r\n|\n/).filter(Boolean);
const charLen = (s) => Array.from(s).length;

function main() {
  const python = resolvePython();
  if (!python) {
    console.error('[SKIP] python が見つかりません(この検証には参照実装の実行が要る)');
    process.exitCode = 2;
    return;
  }

  const count = Number(process.argv[2]) || 10;
  const seeds = Array.from({ length: count }, (_, i) => (i + 1) * 7919); // 適当な素数間隔
  let ng = 0;
  let compared = 0;

  const orderDir = path.join(WORK, 'Your Orders', 'Your Amazon Orders');
  const refundDir = path.join(WORK, 'Your Orders', 'Your Returns & Refunds');
  fs.mkdirSync(orderDir, { recursive: true });
  fs.mkdirSync(refundDir, { recursive: true });

  for (const seed of seeds) {
    const { orders, refunds } = makeData(seed);
    fs.writeFileSync(path.join(orderDir, 'Order History.csv'), toCsv(ORDER_HEADER, orders));
    fs.writeFileSync(path.join(refundDir, 'Refund Details.csv'), toCsv(REFUND_HEADER, refunds));

    const orderRows = core.parseCsv(
      fs.readFileSync(path.join(orderDir, 'Order History.csv'), 'utf8')
    );
    const refundRows = core.parseCsv(
      fs.readFileSync(path.join(refundDir, 'Refund Details.csv'), 'utf8')
    );

    for (const mode of MODES) {
      const out = `fuzz_${seed}.csv`;
      execFileSync(
        python,
        [
          path.join(REPO, 'scripts', 'amazon_to_zaim.py'),
          '--base', WORK, '--card', '5171', '--out', out,
          ...mode.cli,
        ],
        { stdio: 'pipe', encoding: 'utf8' }
      );
      const golden = toLines(fs.readFileSync(path.join(WORK, 'output', out), 'utf8'));
      const rows = core.convert(orderRows, refundRows, mode.js).rows;
      const js = toLines(core.generateCsv(rows));
      compared++;

      if (js.length !== golden.length || js.some((l, i) => l !== golden[i])) {
        ng++;
        console.log(`[NG] seed=${seed} ${mode.label}: JS=${js.length}行 Python=${golden.length}行`);
        for (let i = 0; i < Math.max(js.length, golden.length); i++) {
          if (js[i] !== golden[i]) {
            console.log(`   行${i + 1}\n     JS    : ${js[i]}\n     Python: ${golden[i]}`);
            break;
          }
        }
      }

      // 上限も一緒に見る(両実装とも守っていること = 取込で弾かれないこと)
      for (const r of rows) {
        if (charLen(r[core.COL.memo]) > core.FIELD_MAX_LEN) {
          ng++;
          console.log(`[NG] seed=${seed} ${mode.label}: メモが ${charLen(r[core.COL.memo])} 字`);
        }
        if (charLen(r[core.COL.item]) > core.ITEM_FIELD_MAX) {
          ng++;
          console.log(`[NG] seed=${seed} ${mode.label}: 品目が ${charLen(r[core.COL.item])} 字`);
        }
      }
    }
  }

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(
    `${ng === 0 ? '[OK]' : '[NG]'} ランダム生成 ${seeds.length} 本 × ${MODES.length} モード ` +
      `= ${compared} 通りを比較 / 不一致 ${ng} 件`
  );
  process.exitCode = ng === 0 ? 0 : 1;
}

main();
