#!/usr/bin/env node
/**
 * 実機の Zaim の挙動を測るための探り用 CSV を作る(2種類)。
 *
 *   実行: node scripts/make_zaim_probe.js
 *   出力: data/output/zaim_probe_field_limits.csv … 項目の文字数上限を測る
 *         data/output/zaim_probe_grouping.csv     … 記録の束ね方(何を変えれば分かれるか)を測る
 *   (どちらも gitignore 対象・PII なしの合成データ)
 *
 * なぜ要るか: Zaim 側の仕様に、**ドキュメントに書かれておらず実機でしか測れないもの**が
 * 2つ残っているから。どちらも1変数ずつ振ったデータを入れて、結果を見るのが確実。
 *
 * 1. **項目の文字数上限**: 実機で赤字になったのはメモ(100文字)だけで、品目は未確認。
 *    実装は安全側に 60 文字で切っているが、本当の上限が分かれば `ITEM_FIELD_MAX` を
 *    1行直すだけで追随できる。品目を 24 → 120 文字まで振ってある。
 * 2. **記録の束ね方**: Zaim は「同日・同一口座・同店」の行を1記録(レシート記帳)に
 *    まとめる。何を変えれば分かれるのかを、品目・お店・内訳で1つずつ振って測る。
 *
 * どちらにも**対照実験の行を入れてある**(メモ101文字 / 束ねられるはずの2行)。
 * そこが期待どおりにならなければ、その探り方自体が無効だと分かる。
 *
 * 金額はすべて 1 円・日付は 2020-01-01 と 2020-01-02 に固定してある。誤って本番に
 * 取り込んでも、その2日を見ればすぐ見つけて消せるようにするため。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('../web/js/core.js');

const OUT_DIR = path.resolve(__dirname, '..', 'data', 'output');
const OUT_FILE = 'zaim_probe_field_limits.csv';
const GROUPING_FILE = 'zaim_probe_grouping.csv';

const PROBE_DATE = '2020-01-01'; // 本番に紛れても一目で分かる日付
const GROUPING_DATE = '2020-01-02'; // 束ね検査は別日にして、上の探りと混ざらないようにする
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

/**
 * 束ね(レシート記帳)の検査用。
 *
 * Zaim は CSV 取込時に「同日・同一口座・同店」の支出を1記録にまとめる(実機で確認済み)。
 * **1変数ずつ**振って、何を変えれば分かれるのかを測る。全行 1円・同じ日付。
 *
 * [内訳, お店, 品目, メモ, 何を見る行か]
 */
const YUSUKE = core.SUBCATEGORY_CHOICES[0];
const TOMOKA = core.SUBCATEGORY_CHOICES[1];
const GROUPING_ROWS = [
  [YUSUKE.value, 'Amazon', '束ね確認A', 'G1 基準', '★G1とG2が1記録になるはず(対照・既知の挙動)'],
  [YUSUKE.value, 'Amazon', '束ね確認B', 'G2 基準', ''],
  [YUSUKE.value, 'Amazon', '', 'G3 品目なし', '★品目を空にすると分かれるか(G3とG4)'],
  [YUSUKE.value, 'Amazon', '', 'G4 品目なし', ''],
  [YUSUKE.value, 'Amazonテスト店', '店違い', 'G5 お店だけ違う', '★お店を変えると分かれるか'],
  [TOMOKA.value, 'Amazon', '内訳違い', 'G6 内訳だけ違う', '★内訳で分かれるか(支払元は変えていない)'],
];

/** 9列の1行を組み立てる(列順の定義は core の COL に従う)。 */
function probeRow({ date, subcategory, store, source, memo, item }) {
  const row = [];
  row[core.COL.date] = date;
  row[core.COL.category] = core.DEFAULT_OPTIONS.category;
  row[core.COL.subcategory] = subcategory;
  row[core.COL.memo] = memo;
  row[core.COL.store] = store;
  row[core.COL.source] = source;
  row[core.COL.receiver] = '';
  row[core.COL.item] = item;
  row[core.COL.amount] = PROBE_AMOUNT;
  return row;
}

function writeGroupingProbe() {
  const rows = GROUPING_ROWS.map(([subcategory, store, item, memo]) =>
    probeRow({
      date: GROUPING_DATE,
      subcategory,
      store,
      // 支払元は「内訳から決まる」規則に従う(G6 だけ内訳が違うが、支払元も連動する点に注意)
      source: YUSUKE.source,
      memo,
      item,
    })
  );
  const outPath = path.join(OUT_DIR, GROUPING_FILE);
  fs.writeFileSync(outPath, core.generateCsv(rows));

  console.log('');
  console.log(`[OK] 出力: ${outPath}`);
  console.log(`     ${rows.length} 行 / 合計 ${rows.length} 円 / 日付はすべて ${GROUPING_DATE}`);
  console.log('');
  console.log('  #  内訳            お店             品目        見るところ');
  GROUPING_ROWS.forEach(([sub, store, item, memo, note], i) => {
    console.log(
      `  ${i + 1}  ${sub.padEnd(14)}${store.padEnd(16)}${(item || '(空)').padEnd(11)}${note}`
    );
  });
  console.log('');
  console.log(`取り込んだあと、家計簿の ${GROUPING_DATE} を開いて**記録が何件できたか**を見てください。`);
  console.log('  ・G3/G4 が別々の記録 → 品目を空にすれば分けられる(アプリに設定を足せます)');
  console.log('  ・G3/G4 も1記録      → 品目は関係ない。お店を変えるしか手が無い');
  console.log('  ・G5/G6 が別の記録   → その項目が束ねの鍵に含まれている');
}

function main() {
  const rows = PROBE_ROWS.map(([item, memo]) =>
    probeRow({
      date: PROBE_DATE,
      subcategory: YUSUKE.value,
      store: core.DEFAULT_OPTIONS.store,
      source: YUSUKE.source,
      memo,
      item,
    })
  );

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

  writeGroupingProbe();
  console.log('');
  console.log('※ 束ねの検査(2つ目のファイル)は、テストではなく**本番に取り込まないと分かりません**');
  console.log('   (「アップロードをテスト」の画面は行単位の表示で、束ねた結果が出ないため)。');
  console.log('   全6行・合計6円・日付は 2020-01-02 に固めてあるので、確認後に消してください。');
}

main();
