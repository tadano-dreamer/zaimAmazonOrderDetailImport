/**
 * E2E テスト: Amazon → Zaim CSV 変換 Web アプリ
 * iPhone(WebKit = iOS Chrome/Safari の実体エンジン)+ Chromium(Blink)の両方で、
 * 実 ZIP・ダミー ZIP の投入 → プレビュー → CSV 生成までを検証する。
 *
 *   準備: cd tests && npm install playwright && npx playwright install chromium webkit
 *   実行: node tests/e2e.cjs (リポジトリ直下から / tests 内どちらでも可)
 *   実データ(data/Your Orders.zip)が無い環境ではそのシナリオを自動スキップする。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { webkit, chromium, devices } = require('playwright');

const REPO = path.resolve(__dirname, '..');
const WEB_ROOT = path.join(REPO, 'web');
const REAL_ZIP = path.join(REPO, 'data', 'Your Orders.zip');
const REAL_GOLDEN = path.join(REPO, 'data', 'output', 'zaim_import_5171.csv');
const DUMMY_ZIP = path.join(REPO, 'testdata', 'dummy', 'Your Orders.zip');
const DUMMY_GOLDEN = path.join(REPO, 'testdata', 'dummy', 'output', 'zaim_import_5171.csv');
const SHOT_DIR = path.join(__dirname, 'screenshots'); // gitignore 対象(実データの品目名が写り得るため)
const PORT = 8899;

fs.mkdirSync(SHOT_DIR, { recursive: true });

// ---------------------------------------------------------------- 静的サーバ
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(WEB_ROOT, urlPath === '/' ? 'index.html' : urlPath);
      if (!file.startsWith(WEB_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// ------------------------------------------------------------------ アサート
let pass = 0;
let fail = 0;
function check(cond, label) {
  if (cond) {
    pass++;
    console.log(`  [OK] ${label}`);
  } else {
    fail++;
    console.log(`  [NG] ${label}`);
  }
}

function normalize(text) {
  return text.replace(/^﻿/, '').split(/\r\n|\n/).filter(Boolean);
}

// ---------------------------------------------------------------- テスト本体
async function captureCsvViaDownload(page) {
  await page.evaluate(() => {
    window.__capturedCsv = null;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      blob.text().then((t) => {
        window.__capturedCsv = t;
      });
      return orig(blob);
    };
  });
  await page.click('#btn-download');
  await page.waitForFunction(() => window.__capturedCsv !== null, null, { timeout: 10000 });
  return page.evaluate(() => window.__capturedCsv);
}

/**
 * カードはチェックボックス(複数選択可)。指定した下4桁だけを選択状態にする。
 * カード更新で下4桁が変わるため、単一選択だと切替以降が丸ごと落ちる(実データで発生)。
 */
async function selectCards(page, cards) {
  await page.waitForSelector('#card-list input[type="checkbox"]');
  await page.$$eval(
    '#card-list input[type="checkbox"]',
    (boxes, want) => {
      for (const b of boxes) {
        if (b.checked !== want.includes(b.value)) b.click();
      }
    },
    cards
  );
}

/** 詳細設定(計上日・まとめ方・固定値)は既定で畳まれているので、触る前に開く。 */
async function openAdvanced(page, open) {
  await page.evaluate((o) => {
    document.getElementById('advanced-settings').open = o;
  }, open);
}

async function listCards(page) {
  return page.$$eval('#card-list input[type="checkbox"]', (bs) => bs.map((b) => b.value));
}

async function runScenarios(browserName, page, errors, shotPrefix) {
  console.log(`\n=== ${browserName} ===`);
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForLoadState('networkidle');
  check((await page.title()).includes('Zaim'), 'ページが開ける(タイトル)');
  await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-01-initial.png`), fullPage: true });

  // 横スクロールが発生しないこと(モバイル)
  const overflow = await page.evaluate(
    () => document.scrollingElement.scrollWidth - document.documentElement.clientWidth
  );
  check(overflow <= 0, `横オーバーフローなし(${overflow}px)`);

  // --- シナリオ D: 不正ファイル → エラー表示 -------------------------------
  // 先に正常な ZIP を読ませてから壊れた ZIP を選び直す。表示のリセット漏れは
  // 「一度成功したあとに失敗する」経路でしか出ない。
  await page.setInputFiles('#zip-input', DUMMY_ZIP);
  await page.waitForSelector('#import-section:not([hidden])', { timeout: 30000 });
  const badFile = path.join(SHOT_DIR, 'not-a-zip.zip');
  fs.writeFileSync(badFile, 'これはZIPではありません');
  await page.setInputFiles('#zip-input', badFile);
  await page.waitForSelector('#load-error:not([hidden])', { timeout: 10000 });
  const errText = await page.textContent('#load-error');
  check(errText.includes('読み込めませんでした'), `不正ZIPでエラー表示: "${errText.slice(0, 30)}…"`);
  // 読み込みに失敗したら、前回の結果や取込案内を残さない
  check(await page.isHidden('#settings-section'), '不正ZIPで抽出条件は隠れる');
  check(await page.isHidden('#result-section'), '不正ZIPでプレビューは隠れる');
  check(await page.isHidden('#import-section'), '不正ZIPで取込手順も隠れる');
  await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-02-error.png`) });
  // 不正ZIPシナリオで意図的に発生させた console.error は集計から除く
  errors.length = 0;

  // --- シナリオ A: 実 ZIP 投入 → ゴールデン一致 ----------------------------
  if (fs.existsSync(REAL_ZIP)) {
    await page.setInputFiles('#zip-input', REAL_ZIP);
    await page.waitForSelector('#settings-section:not([hidden])', { timeout: 60000 });
    check(true, '実ZIP(19MB)を読み込めた');
    check(
      (await page.textContent('#load-error', { strict: false }).catch(() => '')) === '' ||
        (await page.isHidden('#load-error')),
      '実ZIPでエラーなし'
    );

    const cardValues = await listCards(page);
    check(cardValues.length >= 2, `カードが複数検出される(${cardValues.length}種)`);
    check(cardValues.includes('5171'), `5171 が検出される(${cardValues.join(',')})`);

    await selectCards(page, ['5171']);
    await page.waitForFunction(
      () => document.getElementById('sum-count').textContent !== '–'
    );
    const count = await page.textContent('#sum-count');
    const total = await page.textContent('#sum-total');
    const range = await page.textContent('#sum-range');
    check(count === '39件', `件数 39件 → ${count}`);
    check(total === '126,896円', `合計 126,896円 → ${total}`);
    check(range === '2025-03-27 〜 2026-07-09', `期間 → ${range}`);

    // ギフト券併用警告が出る(実データに Matdeco 併用あり)
    check(await page.isVisible('#gift-warnings'), 'ギフト券併用の警告表示');
    // 返金の処理メモ
    check(await page.isVisible('#notes-box'), '処理メモ(返金反映)表示');

    await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-03-real-preview.png`), fullPage: true });

    // ダウンロード CSV がゴールデンと一致
    const csv = await captureCsvViaDownload(page);
    const golden = fs.readFileSync(REAL_GOLDEN, 'utf8');
    const a = normalize(csv);
    const b = normalize(golden);
    check(
      a.length === b.length && a.every((l, i) => l === b[i]),
      `ダウンロードCSVがゴールデンと一致(${a.length}行)`
    );

    // --- シナリオ B: オプション切替 ---------------------------------------
    // 計上日・まとめ方は「詳細設定」に畳まれている(通常は触らない設定のため)
    check(
      await page.isHidden('input[name="tz"][value="utc"]'),
      '計上日・まとめ方は既定で畳まれている'
    );
    await openAdvanced(page, true);
    // UTC: 今治(最終行)が 7/9 → 7/8 に変わる
    await page.check('input[name="tz"][value="utc"]');
    const utcRange = await page.textContent('#sum-range');
    check(utcRange.endsWith('2026-07-08'), `UTC切替で期間末尾が 7/8 に → ${utcRange}`);
    await page.check('input[name="tz"][value="jst"]');
    check(
      (await page.textContent('#sum-range')).endsWith('2026-07-09'),
      'JSTに戻すと 7/9 に戻る'
    );

    // 合算OFF: 件数が増える(39 → 明細数)
    await page.check('input[name="grouping"][value="detail"]');
    const rawCount = parseInt(await page.textContent('#sum-count'), 10);
    check(rawCount > 39, `合算OFFで明細ごと表示(${rawCount}件)`);
    await page.check('input[name="grouping"][value="shipment"]');
    check((await page.textContent('#sum-count')) === '39件', '出荷単位に戻すと39件');

    // 注文日基準: 期間が変わる(今治は注文 7/7)
    await page.check('input[name="date-source"][value="order"]');
    const orderRange = await page.textContent('#sum-range');
    check(orderRange !== range, `注文日基準で期間が変化 → ${orderRange}`);
    await page.check('input[name="date-source"][value="ship"]');

    // 固定値変更が CSV に反映される
    await page.fill('#opt-source', 'テスト支払い元');
    const csv2 = await captureCsvViaDownload(page);
    check(csv2.includes('テスト支払い元'), '支払い元の変更がCSVに反映');
    await page.fill('#opt-source', 'ゆうEPOS');
    await openAdvanced(page, false);
  } else {
    console.log('  [SKIP] 実ZIPなし');
  }

  // --- シナリオ C: ダミー ZIP ----------------------------------------------
  await page.setInputFiles('#zip-input', DUMMY_ZIP);
  await page.waitForFunction(
    () => document.getElementById('load-status').textContent.includes('読み込み完了'),
    null,
    { timeout: 30000 }
  );
  await selectCards(page, ['5171']);
  await page.waitForFunction(
    () => document.getElementById('sum-count').textContent === '6件'
  );
  check((await page.textContent('#sum-total')) === '19,048円', 'ダミー: 合計 19,048円');
  check(
    (await page.textContent('#sum-range')) === '2026-05-20 〜 2026-07-09',
    'ダミー: 期間 2026-05-20〜2026-07-09'
  );
  check(await page.isVisible('#gift-warnings'), 'ダミー: ギフト券警告表示');
  const dummyCsv = await captureCsvViaDownload(page);
  const dummyGolden = fs.readFileSync(DUMMY_GOLDEN, 'utf8');
  const da = normalize(dummyCsv);
  const db = normalize(dummyGolden);
  check(
    da.length === db.length && da.every((l, i) => l === db[i]),
    `ダミー: ダウンロードCSVがPython出力と一致(${da.length}行)`
  );
  await page.screenshot({ path: path.join(SHOT_DIR, `${shotPrefix}-04-dummy-preview.png`), fullPage: true });

  // --- シナリオ E: カード更新(5171 → 7474)への追従 -----------------------
  // 実データでは 2026-07 にカードが切り替わり、5171 だけ選ぶと 41,139 円が消えた。
  check(await page.isVisible('#card-switch-note'), 'ダミー: カード切替の警告が出る');
  const switchText = await page.textContent('#card-switch-note');
  check(switchText.includes('7474'), `警告に後継カード 7474 が出る → ${switchText.slice(0, 40)}…`);

  await page.click('#card-switch-note button');
  await page.waitForFunction(
    () => document.getElementById('sum-count').textContent === '9件'
  );
  check((await page.textContent('#sum-count')) === '9件', '「追加」で 5171+7474 の 9件になる');
  check(
    (await page.textContent('#sum-total')) === '33,718円',
    `5171+7474 合計 33,718円 → ${await page.textContent('#sum-total')}`
  );
  check(await page.isHidden('#card-switch-note'), '両方選ぶと切替警告が消える');
  check(
    (await page.textContent('#notes-box')).includes('分割計上'),
    '複数出荷の分割計上メモが出る'
  );

  // --- シナリオ F: 期間(月)フィルタ ---------------------------------------
  const periodOptions = await page.$$eval('#period-select option', (os) =>
    os.map((o) => o.value)
  );
  check(
    periodOptions[0] === 'all' && periodOptions.includes('2026-07'),
    `期間プルダウンに月が並ぶ → ${periodOptions.join(',')}`
  );
  await page.selectOption('#period-select', '2026-07');
  await page.waitForFunction(
    () => document.getElementById('sum-count').textContent === '5件'
  );
  check((await page.textContent('#sum-count')) === '5件', '2026-07 のみ → 5件');
  check(
    (await page.textContent('#sum-total')) === '20,690円',
    `2026-07 のみ → 20,690円(${await page.textContent('#sum-total')})`
  );
  const julyCsv = await captureCsvViaDownload(page);
  check(
    normalize(julyCsv).slice(1).every((l) => l.startsWith('2026-07-')),
    '月指定のCSVはその月の行だけ'
  );
  // 月を選ぶと日付入力にもその月の範囲が入る
  check(
    (await page.inputValue('#period-from')) === '2026-07-01' &&
      (await page.inputValue('#period-to')) === '2026-07-31',
    `月選択で日付が連動 → ${await page.inputValue('#period-from')} 〜 ${await page.inputValue('#period-to')}`
  );

  // --- シナリオ F2: 日単位の切り出し -------------------------------------
  // 取り込み済みの翌日から、といった使い方ができること
  await page.fill('#period-from', '2026-07-20');
  await page.fill('#period-to', '2026-07-22');
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '2件');
  check(
    (await page.textContent('#sum-total')) === '11,670円',
    `7/20〜7/22 の3日間 → 2件 / ${await page.textContent('#sum-total')}`
  );
  check(
    (await page.inputValue('#period-select')) === 'custom',
    '日付を直接変えるとプリセットは「日付で指定」になる'
  );
  const dayCsv = await captureCsvViaDownload(page);
  check(
    normalize(dayCsv)
      .slice(1)
      .every((l) => l >= '2026-07-20' && l < '2026-07-23'),
    '日付指定のCSVはその範囲の行だけ'
  );

  // 1日だけ・該当なしの日
  await page.fill('#period-from', '2026-07-21');
  await page.fill('#period-to', '2026-07-21');
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '0件');
  check((await page.textContent('#sum-count')) === '0件', '該当のない1日を指定すると0件');
  check(await page.isVisible('#empty-result'), '0件のとき案内が出る');

  // 開始日 > 終了日 は破綻させず、触った側に寄せる
  await page.fill('#period-from', '2026-07-25');
  await page.fill('#period-to', '2026-07-01');
  check(
    (await page.inputValue('#period-from')) <= (await page.inputValue('#period-to')),
    `開始>終了の入力を補正 → ${await page.inputValue('#period-from')} 〜 ${await page.inputValue('#period-to')}`
  );

  await page.selectOption('#period-select', 'all');
  await page.waitForFunction(
    () => document.getElementById('sum-count').textContent === '9件'
  );
  check(
    (await page.inputValue('#period-from')) === '2026-05-20' &&
      (await page.inputValue('#period-to')) === '2026-07-24',
    `全期間に戻すと日付もデータ全体に戻る → ${await page.inputValue('#period-from')} 〜 ${await page.inputValue('#period-to')}`
  );

  // --- シナリオ F3: 期間がカードのデータ範囲外になったら全期間へ戻す -----------
  // 7月を選んでから、7月に明細が無いカード(Amex 1002 = 6/21のみ)へ切り替える
  await page.selectOption('#period-select', '2026-07');
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '5件');
  await selectCards(page, ['1002']);
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '1件');
  check(
    (await page.inputValue('#period-select')) === 'all',
    `データ範囲外になった期間は全期間へ戻る → ${await page.inputValue('#period-select')}`
  );
  check(
    (await page.inputValue('#period-from')) === '2026-06-21' &&
      (await page.inputValue('#period-to')) === '2026-06-21',
    `日付もそのカードの範囲に入る → ${await page.inputValue('#period-from')} 〜 ${await page.inputValue('#period-to')}`
  );
  await selectCards(page, ['5171', '7474']);
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '9件');

  // --- シナリオ F4: 日付欄の片側だけ編集しても、もう一方は確定させない ---------
  // 日付欄は未指定のときデータ全体の端を「表示上の初期値」として出しているだけ。
  // それを確定させると、後からカードを足したときにその日より前が無警告で落ちる。
  await selectCards(page, ['7474']); // 利用期間 2026-07-20〜2026-07-24
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '3件');
  await page.fill('#period-to', '2026-07-21'); // 終了日だけを編集(開始日は触らない)
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '1件');
  await selectCards(page, ['5171', '7474']); // 開始が古い 5171 を追加
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '7件');
  check(
    (await page.textContent('#sum-total')) === '20,818円',
    `終了日だけ指定 → カード追加で古い明細も出る → 7件 / ${await page.textContent('#sum-total')}`
  );
  check(
    (await page.inputValue('#period-from')) === '2026-05-20',
    `開始日は追加カードのデータ先頭に追従する → ${await page.inputValue('#period-from')}`
  );
  await page.selectOption('#period-select', 'all');
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '9件');

  // --- シナリオ F5: 「日付で指定」を選んでも巻き戻らない ----------------------
  await page.selectOption('#period-select', 'custom');
  await page.waitForTimeout(100);
  check(
    (await page.inputValue('#period-select')) === 'custom',
    `「日付で指定」の選択が保持される → ${await page.inputValue('#period-select')}`
  );
  check(
    (await page.textContent('#sum-count')) === '9件',
    '「日付で指定」を選ぶだけでは出力は変わらない'
  );
  await page.selectOption('#period-select', 'all');
  await page.waitForTimeout(100);
  check((await page.inputValue('#period-select')) === 'all', '全期間へ戻せる');

  // --- シナリオ F6: 日付を打ち直している途中に入力を奪われない -----------------
  // <input type=date> は年や日のセグメントを1つ消しただけでも value が "" になる。
  // これを「クリアした」と解釈して再描画すると、打っている途中の欄がデータ先頭日へ
  // 飛ばされ、表示も件数も勝手に全期間へ戻ってしまう。
  await page.selectOption('#period-select', '2026-07');
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '5件');
  await page.focus('#period-from');
  await page.evaluate(() => {
    const i = document.getElementById('period-from');
    i.value = ''; // 年セグメントを消した状態を再現
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(120);
  check(
    (await page.inputValue('#period-from')) === '',
    `編集中の欄が勝手に書き換わらない → "${await page.inputValue('#period-from')}"`
  );
  check(
    (await page.textContent('#sum-count')) === '5件',
    `打ち直し途中で全期間へ戻らない → ${await page.textContent('#sum-count')}`
  );
  // 打ち直しを完了すれば正しく反映される
  await page.evaluate(() => {
    const i = document.getElementById('period-from');
    i.value = '2026-07-19';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '3件');
  check((await page.textContent('#sum-count')) === '3件', '打ち直し完了で 7/19〜7/31 の3件になる');
  await page.selectOption('#period-select', 'all');
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '9件');

  // --- シナリオ G: ギフト券併用の実請求額を手動補正 -------------------------
  // ギフト券の充当額は注文履歴に載らず、総額のままだと Zaim とズレる(実データ 5,760 vs 4,091)。
  const beforeFix = await page.textContent('#sum-total');
  const giftInput = page.locator('#gift-warnings input[type="number"]').first();
  await giftInput.fill('4091');
  await giftInput.blur();
  await page.waitForFunction(
    (before) => document.getElementById('sum-total').textContent !== before,
    beforeFix
  );
  check(
    (await page.textContent('#sum-total')) === '32,049円',
    `実請求額 4,091円に補正 → ${await page.textContent('#sum-total')}(33,718 − 5,760 + 4,091)`
  );
  check(
    (await page.textContent('#notes-box')).includes('金額を手動指定'),
    '手動補正が処理メモに残る'
  );
  const fixedCsv = await captureCsvViaDownload(page);
  check(fixedCsv.includes(',4091'), '補正後の金額がCSVに入る');

  // 元に戻す(以降のシナリオへの影響を避ける)
  await giftInput.fill('');
  await giftInput.blur();
  await selectCards(page, ['5171']);
  await page.selectOption('#period-select', 'all');
  await page.waitForFunction(
    () => document.getElementById('sum-count').textContent === '6件'
  );

  // --- シナリオ J: 出力する行を選ぶ -----------------------------------------
  // 抽出結果と Zaim の実記録には、どうしても残る差がある(別アカウントの購入・
  // Zaim 側の記録漏れ)。取り込みたくない行をその場で外せること。
  const allCsv = normalize(await captureCsvViaDownload(page));
  const firstAmount = await page.$eval('#preview-body tr:first-child td.col-amount', (td) =>
    Number(td.textContent.replace(/[^0-9]/g, ''))
  );
  const allTotal = Number((await page.textContent('#sum-total')).replace(/[^0-9]/g, ''));
  await page.locator('#preview-body tr:first-child .row-select input').click();
  await page.waitForFunction(() =>
    document.getElementById('sum-count').textContent.includes('全6件中')
  );
  check(
    (await page.textContent('#sum-count')) === '5件(全6件中)',
    `1行外すと件数が減る → ${await page.textContent('#sum-count')}`
  );
  const pickedTotal = Number((await page.textContent('#sum-total')).replace(/[^0-9]/g, ''));
  check(
    pickedTotal === allTotal - firstAmount,
    `合計がその行の金額分だけ減る → ${pickedTotal}(${allTotal} − ${firstAmount})`
  );
  const pickedCsv = normalize(await captureCsvViaDownload(page));
  check(
    pickedCsv.length === allCsv.length - 1,
    `CSVの行数も1減る → ${pickedCsv.length} 行(外す前 ${allCsv.length} 行)`
  );

  // 外したままカードを足す: 増えた行は既定でチェック済み、外した行は外れたまま
  await selectCards(page, ['5171', '7474']);
  await page.waitForFunction(
    () => document.getElementById('sum-count').textContent === '8件(全9件中)'
  );
  check(
    (await page.textContent('#sum-count')) === '8件(全9件中)',
    'カードを足すと増えた3件はチェック済みで出る(外した1件だけ除外のまま)'
  );

  // 全解除 → 保存させない + 理由を出す
  await page.click('#select-all');
  await page.waitForFunction(
    () => document.getElementById('sum-count').textContent === '0件(全9件中)'
  );
  check(
    (await page.textContent('#empty-result')).includes('選択されていません'),
    `全解除で案内が出る → ${(await page.textContent('#empty-result')).slice(0, 24)}…`
  );
  check(await page.isDisabled('#btn-download'), '全解除でダウンロードが無効になる');
  check(await page.isDisabled('#btn-copy'), '全解除でコピーも無効になる');
  check(await page.isVisible('#table-wrap'), '全解除でも表は残る(付け直せる)');

  await page.click('#select-all');
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '9件');
  check((await page.textContent('#sum-count')) === '9件', '全選択に戻すと9件');
  check(!(await page.isDisabled('#btn-download')), 'ダウンロードが再び有効になる');

  // --- シナリオ K: カテゴリの内訳(2択)--------------------------------------
  // 取り込み先の内訳を間違えると家計簿が汚れる。CSV の3列目に出ること。
  const yusukeCsv = normalize(await captureCsvViaDownload(page));
  check(
    yusukeCsv.slice(1).every((l) => l.split(',')[2] === 'ゆうすけAmazon'),
    `既定の内訳が3列目に入る → ${yusukeCsv[1].split(',')[2]}`
  );
  await page.check('input[name="subcategory"][value="ともかAmazon"]');
  const tomokaCsv = normalize(await captureCsvViaDownload(page));
  check(
    tomokaCsv.slice(1).every((l) => l.split(',')[2] === 'ともかAmazon'),
    `内訳を切り替えると3列目が変わる → ${tomokaCsv[1].split(',')[2]}`
  );
  check(
    tomokaCsv.length === yusukeCsv.length &&
      (await page.textContent('#sum-total')) === '33,718円',
    '内訳を切り替えても件数・金額は変わらない'
  );
  await page.check('input[name="subcategory"][value="ゆうすけAmazon"]');

  // --- シナリオ L: 商品ごとに1行(1支払い=複数明細の代替)--------------------
  await openAdvanced(page, true);

  // まとめ方を変えたら行の選択は持ち越さない。行の識別子はまとめ方ごとに形が違うので、
  // 持ち越すと「別のまとめ方では黙って出力される」状態になる
  await page.locator('#preview-body tr:first-child .row-select input').click();
  await page.waitForFunction(() =>
    document.getElementById('sum-count').textContent.includes('全9件中')
  );
  await page.check('input[name="grouping"][value="item"]');
  await page.waitForFunction(
    () => !document.getElementById('sum-count').textContent.includes('中')
  );
  check(
    !(await page.textContent('#sum-count')).includes('中'),
    `まとめ方を変えると行の選択は戻る → ${await page.textContent('#sum-count')}`
  );
  check(
    (await page.textContent('#action-status')).includes('行の選択'),
    `戻したことを画面で知らせる → ${await page.textContent('#action-status')}`
  );
  await page.waitForFunction(
    () => Number(document.getElementById('sum-count').textContent.replace(/[^0-9]/g, '')) > 9
  );
  const splitCount = Number((await page.textContent('#sum-count')).replace(/[^0-9]/g, ''));
  check(splitCount > 9, `商品ごとに1行で行が増える → ${splitCount}件`);
  check(
    (await page.textContent('#sum-total')) === '33,718円',
    `行が増えても合計は変わらない → ${await page.textContent('#sum-total')}`
  );
  await page.check('input[name="grouping"][value="shipment"]');
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '9件');
  check((await page.textContent('#sum-count')) === '9件', '出荷単位に戻すと9件');
  await openAdvanced(page, false);

  // 5171 のみ・全期間に戻す(以降のシナリオへの影響を避ける)
  await selectCards(page, ['5171']);
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '6件');

  // --- シナリオ H: 同じ ZIP を選び直しても、期間の表示と実際の出力範囲が一致する ---
  // 選択肢の中身が前回と同一だとプルダウンの再構築がスキップされる。表示だけ
  // 「7月」のまま出力が全期間になると、取込済みの月まで再出力して Zaim で重複計上する。
  await page.selectOption('#period-select', '2026-07');
  await page.waitForFunction(() => document.getElementById('sum-count').textContent === '2件');
  await page.evaluate(() => {
    document.getElementById('load-status').textContent = '';
  });
  await page.setInputFiles('#zip-input', []);
  await page.setInputFiles('#zip-input', DUMMY_ZIP); // カード選択も 5171 のまま復元される
  await page.waitForFunction(
    () => document.getElementById('load-status').textContent.includes('読み込み完了'),
    null,
    { timeout: 30000 }
  );
  const reloadedPeriod = await page.inputValue('#period-select');
  const reloadedCount = await page.textContent('#sum-count');
  check(reloadedPeriod === 'all', `ZIP再選択で期間の表示も全期間に戻る → ${reloadedPeriod}`);
  // 表示が「全期間」なら6件、月指定なら2件でなければ、表示と中身が矛盾している
  check(
    (reloadedPeriod === 'all') === (reloadedCount === '6件'),
    `表示(${reloadedPeriod})と実際の出力件数(${reloadedCount})が矛盾しない`
  );

  // --- シナリオ I: Zaim の取込設定の案内 --------------------------------------
  // 実機で「支出の金額の列」を 6 列目(=品目)に指定していた。人が数えると取り違えるので、
  // 出力列から機械的に導いた設定値を画面に出す。
  check(await page.isVisible('#import-section'), 'Zaimの取込手順が表示される');
  const settings = await page.$$eval('#import-settings dt', (dts) =>
    dts.map((dt) => [dt.textContent, dt.nextElementSibling.textContent])
  );
  const find = (label) => (settings.find((s) => s[0] === label) || [])[1];
  check(find('日付の列') === '1 列目', `日付の列 → ${find('日付の列')}`);
  check(find('メモの列') === '4 列目', `メモの列 → ${find('メモの列')}`);
  check(find('品目の列') === '8 列目', `品目の列 → ${find('品目の列')}`);
  check(find('支出の金額の列') === '9 列目', `支出の金額の列 → ${find('支出の金額の列')}`);
  check(find('収入の金額の列') === '存在しない', '収入の金額の列 → 存在しない');
  check(find('区切り文字') === 'カンマ', '区切り文字 → カンマ');
  // 案内の列番号と、実際に出力される CSV の列位置が一致していること
  const headerCells = normalize(dummyCsv)[0].split(',');
  check(
    headerCells[Number(find('支出の金額の列').replace(/\D/g, '')) - 1] === '支出金額',
    `案内の列番号が実CSVと一致(${headerCells.length}列)`
  );
  check(
    headerCells[Number(find('品目の列').replace(/\D/g, '')) - 1] === '品目',
    '品目の列番号が実CSVと一致'
  );
  await page.evaluate(() => {
    document.getElementById('settings-status').textContent = '';
  });
  await page.click('#btn-copy-settings');
  await page.waitForFunction(
    () => document.getElementById('settings-status').textContent !== ''
  );
  check(
    (await page.textContent('#settings-status')).includes('コピー'),
    '設定内容のコピーに応答がある'
  );

  // コピー(成功メッセージ or フォールバックの明示メッセージが出ること)
  await page.evaluate(() => {
    document.getElementById('action-status').textContent = '';
  });
  await page.click('#btn-copy');
  await page.waitForFunction(
    () => document.getElementById('action-status').textContent !== ''
  );
  const copyMsg = await page.textContent('#action-status');
  check(copyMsg.includes('コピー'), `コピー操作で応答表示: "${copyMsg}"`);

  // 横オーバーフロー再確認(結果表示後)
  const overflow2 = await page.evaluate(
    () => document.scrollingElement.scrollWidth - document.documentElement.clientWidth
  );
  check(overflow2 <= 0, `結果表示後も横オーバーフローなし(${overflow2}px)`);

  check(errors.length === 0, `ページエラー/コンソールエラーなし(${errors.length}件)`);
  if (errors.length) errors.forEach((e) => console.log(`      console: ${e}`));
}

async function main() {
  const server = await startServer();

  // 1) iPhone 14(WebKit ― iOS の Chrome/Safari 実体エンジン)
  {
    const browser = await webkit.launch();
    const ctx = await browser.newContext({ ...devices['iPhone 14'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });
    await runScenarios('iPhone 14 (WebKit / iOS engine)', page, errors, 'iphone-webkit');
    await browser.close();
  }

  // 2) Chromium ― iPhone Chrome の UA・ビューポートを模擬(Blink での回帰確認)
  {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });
    await runScenarios('Chromium (iPhone Chrome UA emulation)', page, errors, 'iphone-chromium');
    await browser.close();
  }

  // 3) 分割エクスポート対応: Order History.csv が複数に分割された ZIP を統合して読めること
  //    (重複コピーの Refund Details.csv は二重計上されないこと)
  {
    const JSZip = require(path.join(REPO, 'web', 'vendor', 'jszip.min.js'));
    const orderText = fs.readFileSync(
      path.join(REPO, 'testdata', 'dummy', 'Your Orders', 'Your Amazon Orders', 'Order History.csv'),
      'utf8'
    );
    const refundText = fs.readFileSync(
      path.join(REPO, 'testdata', 'dummy', 'Your Orders', 'Your Returns & Refunds', 'Refund Details.csv'),
      'utf8'
    );
    // ヘッダ + 前半 / ヘッダ + 後半 の2ファイルに分割
    const lines = orderText.split('\r\n').filter(Boolean);
    const header = lines[0];
    const half = Math.ceil((lines.length - 1) / 2);
    const part1 = [header, ...lines.slice(1, 1 + half)].join('\r\n') + '\r\n';
    const part2 = [header, ...lines.slice(1 + half)].join('\r\n') + '\r\n';
    const zip = new JSZip();
    zip.file('Your Orders/Retail.OrderHistory.1/Order History.csv', part1);
    zip.file('Your Orders/Retail.OrderHistory.2/Order History.csv', part2);
    zip.file('Your Orders/Your Returns & Refunds/Refund Details.csv', refundText);
    zip.file('Your Orders/backup/Refund Details.csv', refundText); // 完全同一の重複コピー
    const splitZip = path.join(SHOT_DIR, 'split-orders.zip');
    fs.writeFileSync(splitZip, await zip.generateAsync({ type: 'nodebuffer' }));

    const browser = await webkit.launch();
    const page = await (await browser.newContext({ ...devices['iPhone 14'] })).newPage();
    console.log('\n=== 分割CSV統合(複数 Order History.csv) ===');
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.setInputFiles('#zip-input', splitZip);
    await page.waitForSelector('#settings-section:not([hidden])', { timeout: 30000 });
    const status = await page.textContent('#load-status');
    check(status.includes('統合'), `統合の注記が表示される: "${status}"`);
    await selectCards(page, ['5171']);
    await page.waitForFunction(() => document.getElementById('sum-count').textContent === '6件');
    check((await page.textContent('#sum-count')) === '6件', '分割ZIP: 件数 6件(全パーツ読込)');
    check(
      (await page.textContent('#sum-total')) === '19,048円',
      '分割ZIP: 合計 19,048円(重複返金の二重差引なし)'
    );
    await browser.close();
  }

  // 4) 最小幅 320px(小さい iPhone SE 相当)でレイアウト崩れがないこと。
  //    ネイティブ日付入力の最小幅はエンジンで違い、Chromium だけ溢れたことがあるため両方で見る。
  console.log('\n=== 320px 幅(最小)レイアウト ===');
  for (const [engineName, engine] of [
    ['WebKit', webkit],
    ['Chromium', chromium],
  ]) {
    const browser = await engine.launch();
    const ctx = await browser.newContext({
      viewport: { width: 320, height: 568 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.setInputFiles('#zip-input', DUMMY_ZIP);
    await page.waitForSelector('#settings-section:not([hidden])', { timeout: 30000 });
    await selectCards(page, ['5171']);
    const overflow = await page.evaluate(
      // innerWidth はモバイルエミュレーション時に実幅より大きくなり溢れを隠すので、
      // clientWidth(スクロールバーを除いた実表示幅)と比べる
      () => document.scrollingElement.scrollWidth - document.documentElement.clientWidth
    );
    check(overflow <= 0, `${engineName} 320px幅で横オーバーフローなし(${overflow}px)`);
    // 期間の日付欄が2つ並んでもカードからはみ出さない
    const fits = await page.evaluate(() => {
      const card = document.getElementById('settings-section').getBoundingClientRect();
      const dr = document.querySelector('.date-range').getBoundingClientRect();
      return dr.left >= card.left - 0.5 && dr.right <= card.right + 0.5;
    });
    check(fits, `${engineName} 320px幅で日付欄がカード内に収まる`);
    // ネイティブの日付ウィジェットが指定幅を無視して隣に重なることがある(実機 iOS で発生)
    const geo = await page.evaluate(() => {
      const f = document.getElementById('period-from').getBoundingClientRect();
      const t = document.getElementById('period-to').getBoundingClientRect();
      const fl = document.getElementById('period-from').closest('.date-field').getBoundingClientRect();
      return {
        gap: Math.round(t.left - f.right),
        overflowsOwnCell: Math.round(f.right - fl.right),
        widthDiff: Math.round(Math.abs(f.width - t.width)),
      };
    });
    check(geo.gap >= 0, `${engineName} 開始日と終了日が重ならない(間隔 ${geo.gap}px)`);
    check(
      geo.overflowsOwnCell <= 0,
      `${engineName} 日付入力が自分の枠からはみ出さない(${geo.overflowsOwnCell}px)`
    );
    check(geo.widthDiff <= 1, `${engineName} 開始日と終了日が同じ幅(差 ${geo.widthDiff}px)`);
    // 選択列を足したぶん、品目が潰れたり日付が列から溢れたりしていないこと
    const tableGeo = await page.evaluate(() => {
      const item = document.querySelector('#preview-body td.item-cell');
      const date = document.querySelector('#preview-body td.col-date');
      const pick = document.querySelector('#preview-body .row-select');
      const wrap = document.getElementById('table-wrap');
      const table = document.getElementById('preview-table');
      const r = pick.getBoundingClientRect();
      return {
        item: Math.round(item.getBoundingClientRect().width),
        dateOverflow: Math.round(date.scrollWidth - date.clientWidth),
        tapW: Math.round(r.width),
        tapH: Math.round(r.height),
        tableOverflow: Math.round(table.scrollWidth - wrap.clientWidth),
      };
    });
    check(tableGeo.item >= 60, `${engineName} 320px幅でも品目列に幅が残る(${tableGeo.item}px)`);
    check(
      tableGeo.dateOverflow <= 0,
      `${engineName} 日付が列からはみ出さない(${tableGeo.dateOverflow}px)`
    );
    check(
      tableGeo.tapW >= 40 && tableGeo.tapH >= 44,
      `${engineName} 行選択のタップ領域 ${tableGeo.tapW}×${tableGeo.tapH}px`
    );
    check(
      tableGeo.tableOverflow <= 0,
      `${engineName} 表が枠内に収まる(${tableGeo.tableOverflow}px)`
    );
    if (engineName === 'WebKit') {
      await page.screenshot({ path: path.join(SHOT_DIR, `se-320-dummy.png`), fullPage: true });
    }
    await browser.close();
  }

  // 5) 640px 以上(タブレット/PC)で操作ボタンが半分幅にならないこと
  {
    console.log('\n=== 800px 幅レイアウト ===');
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 800, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.setInputFiles('#zip-input', DUMMY_ZIP);
    await page.waitForSelector('#import-section:not([hidden])', { timeout: 30000 });
    const widths = await page.evaluate(() => {
      const row = document.querySelector('#import-section .actions');
      const btn = document.getElementById('btn-copy-settings');
      return {
        row: Math.round(row.getBoundingClientRect().width),
        btn: Math.round(btn.getBoundingClientRect().width),
      };
    });
    check(
      widths.btn >= widths.row - 1,
      `ボタン1つの操作列はフル幅(${widths.btn}px / 枠 ${widths.row}px)`
    );
    await browser.close();
  }


  server.close();
  console.log(`\n==== 結果: ${pass} passed / ${fail} failed ====`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error('E2E 実行エラー:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    // ブラウザ/サーバの残留でプロセスが生き残らないよう明示終了
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  });
