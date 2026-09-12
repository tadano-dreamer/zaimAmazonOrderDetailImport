#!/usr/bin/env node
/**
 * 実機の Zaim で「項目の文字数上限」を測るための探り用 CSV を作る。
 *
 *   実行: node scripts/make_zaim_probe.js
 *   出力: data/output/zaim_probe_field_limits.csv (gitignore 対象・PII なしの合成データ)
 *
 * なぜ要るか: **Zaim の「品目」欄の上限が未確認**だから。実機で赤字になったのは
 * メモ(100文字)だけで、品目は分かっていない。現在の実装は安全側に 60 文字で
 * 切っているが、本当の上限が分かれば `ITEM_FIELD_MAX` を1行直すだけで追随できる。
 *
 * 中身: 品目の長さを 24 → 120 文字まで段階的に振った行と、メモ 100 文字ちょうど/
 * 101 文字の行。**101 文字の行は対照実験**で、ここが赤字にならないなら
 * 「この探り方では上限を検出できない」ということが分かる(検査自体の検証)。
 *
 * 金額はすべて 1 円・日付は 2020-01-01 に固定してある。誤って本番に取り込んでも
 * すぐ見つけて消せるようにするため(合計 8 円・1日に固まる)。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('../web/js/core.js');

const OUT_DIR = path.resolve(__dirname, '..', 'data', 'output');
const OUT_FILE = 'zaim_probe_field_limits.csv';

const PROBE_DATE = '2020-01-01'; // 本番に紛れても一目で分かる日付
const PROBE_AMOUNT = '1'; // 誤って取り込んでも実害が出ない額
const RULER = '0123456789'; // 何文字目かを数えられるように

/** 先頭に「何文字の行か」を書き、残りを定規で埋めてちょうど n 文字にする。 */
function sized(label, n) {
  const head = `${label}${n}字`;
  const chars = Array.from(head);
  if (chars.length >= n) return chars.slice(0, n).join('');
  const pad = RULER.repeat(Math.ceil((n - chars.length) / RULER.length));
  return head + pad.slice(0, n - chars.length);
}

const SHORT_MEMO = 'メモは短い行';
const SHORT_ITEM = '品目は短い行';

// [品目, メモ, 何を見る行か]
const PROBE_ROWS = [
  [sized('品目', 24), SHORT_MEMO, '基準(1商品ぶんの見出し長)'],
  [sized('品目', 40), SHORT_MEMO, ''],
  [sized('品目', 60), SHORT_MEMO, '★いまの実装の上限(ITEM_FIELD_MAX)'],
  [sized('品目', 80), SHORT_MEMO, ''],
  [sized('品目', 100), SHORT_MEMO, 'メモと同じ上限なら、ここまでは通るはず'],
  [sized('品目', 120), SHORT_MEMO, '★上限が100なら、ここで赤字が出るはず'],
  [SHORT_ITEM, sized('メモ', 100), 'メモ上限ちょうど(通るはず)'],
  [SHORT_ITEM, sized('メモ', 101), '★対照実験: ここが赤字にならないなら、この探り方は無効'],
];

function main() {
  const rows = PROBE_ROWS.map(([item, memo]) => {
    const row = [];
    row[core.COL.date] = PROBE_DATE;
    row[core.COL.category] = core.DEFAULT_OPTIONS.category;
    row[core.COL.subcategory] = core.SUBCATEGORY_CHOICES[0].value;
    row[core.COL.memo] = memo;
    row[core.COL.store] = core.DEFAULT_OPTIONS.store;
    row[core.COL.source] = core.SUBCATEGORY_CHOICES[0].source;
    row[core.COL.receiver] = '';
    row[core.COL.item] = item;
    row[core.COL.amount] = PROBE_AMOUNT;
    return row;
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, OUT_FILE);
  fs.writeFileSync(outPath, core.generateCsv(rows));

  const len = (s) => Array.from(s).length;
  console.log(`[OK] 出力: ${outPath}`);
  console.log(`     ${rows.length} 行 / 合計 ${rows.length} 円 / 日付はすべて ${PROBE_DATE}`);
  console.log('');
  console.log('  #  品目  メモ  見るところ');
  PROBE_ROWS.forEach(([item, memo, note], i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}  ${String(len(item)).padStart(4)}字` +
        `${String(len(memo)).padStart(5)}字  ${note}`
    );
  });
  console.log('');
  console.log('Zaim「ファイル入出力 → 一般的な CSV ファイルをアップロードする」で、');
  console.log('画面の STEP 4 と同じ設定(上から順に 1〜9)にして、');
  console.log('**まず「アップロードをテスト」**で読み込んでください。');
  console.log('プレビューで赤字になった行・切られた行が、そのまま Zaim 側の上限です。');
}

main();
