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
    () => document.scrollingElement.scrollWidth - window.innerWidth
  );
  check(overflow <= 0, `横オーバーフローなし(${overflow}px)`);

  // --- シナリオ D: 不正ファイル → エラー表示 -------------------------------
  const badFile = path.join(SHOT_DIR, 'not-a-zip.zip');
  fs.writeFileSync(badFile, 'これはZIPではありません');
  await page.setInputFiles('#zip-input', badFile);
  await page.waitForSelector('#load-error:not([hidden])', { timeout: 10000 });
  const errText = await page.textContent('#load-error');
  check(errText.includes('読み込めませんでした'), `不正ZIPでエラー表示: "${errText.slice(0, 30)}…"`);
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
    await page.check('input[name="aggregate"][value="off"]');
    const rawCount = parseInt(await page.textContent('#sum-count'), 10);
    check(rawCount > 39, `合算OFFで明細ごと表示(${rawCount}件)`);
    await page.check('input[name="aggregate"][value="on"]');
    check((await page.textContent('#sum-count')) === '39件', '合算ONに戻すと39件');

    // 注文日基準: 期間が変わる(今治は注文 7/7)
    await page.check('input[name="date-source"][value="order"]');
    const orderRange = await page.textContent('#sum-range');
    check(orderRange !== range, `注文日基準で期間が変化 → ${orderRange}`);
    await page.check('input[name="date-source"][value="ship"]');

    // 固定値変更が CSV に反映される(details を開いてから入力)
    await page.evaluate(() => {
      document.querySelector('details.field').open = true;
    });
    await page.fill('#opt-source', 'テスト支払い元');
    const csv2 = await captureCsvViaDownload(page);
    check(csv2.includes('テスト支払い元'), '支払い元の変更がCSVに反映');
    await page.fill('#opt-source', 'ゆうEPOS');
    await page.evaluate(() => {
      document.querySelector('details.field').open = false;
    });
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
    () => document.getElementById('sum-count').textContent === '5件'
  );
  check((await page.textContent('#sum-total')) === '15,048円', 'ダミー: 合計 15,048円');
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
    () => document.getElementById('sum-count').textContent === '7件'
  );
  check((await page.textContent('#sum-count')) === '7件', '「追加」で 5171+7474 の 7件になる');
  check(
    (await page.textContent('#sum-total')) === '26,718円',
    `5171+7474 合計 26,718円 → ${await page.textContent('#sum-total')}`
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
    () => document.getElementById('sum-count').textContent === '4件'
  );
  check((await page.textContent('#sum-count')) === '4件', '2026-07 のみ → 4件');
  check(
    (await page.textContent('#sum-total')) === '17,690円',
    `2026-07 のみ → 17,690円(${await page.textContent('#sum-total')})`
  );
  const julyCsv = await captureCsvViaDownload(page);
  check(
    normalize(julyCsv).slice(1).every((l) => l.startsWith('2026-07-')),
    '月指定のCSVはその月の行だけ'
  );
  await page.selectOption('#period-select', 'all');
  await page.waitForFunction(
    () => document.getElementById('sum-count').textContent === '7件'
  );

  // --- シナリオ G: ギフト券併用の実請求額を手動補正 -------------------------
  // ギフト券の充当額は注文履歴に載らず、総額のままだと Zaim とズレる(実データ 5,760 vs 4,091)。
  const beforeFix = await page.textContent('#sum-total');
  await page.fill('#gift-warnings input[type="number"]', '4091');
  await page.locator('#gift-warnings input[type="number"]').blur();
  await page.waitForFunction(
    (before) => document.getElementById('sum-total').textContent !== before,
    beforeFix
  );
  check(
    (await page.textContent('#sum-total')) === '25,049円',
    `実請求額 4,091円に補正 → ${await page.textContent('#sum-total')}(26,718 − 5,760 + 4,091)`
  );
  check(
    (await page.textContent('#notes-box')).includes('金額を手動指定'),
    '手動補正が処理メモに残る'
  );
  const fixedCsv = await captureCsvViaDownload(page);
  check(fixedCsv.includes(',4091'), '補正後の金額がCSVに入る');

  // 元に戻す(以降のシナリオへの影響を避ける)
  await page.fill('#gift-warnings input[type="number"]', '');
  await page.locator('#gift-warnings input[type="number"]').blur();
  await selectCards(page, ['5171']);
  await page.selectOption('#period-select', 'all');
  await page.waitForFunction(
    () => document.getElementById('sum-count').textContent === '5件'
  );

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
  // 表示が「全期間」なら5件、月指定なら2件でなければ、表示と中身が矛盾している
  check(
    (reloadedPeriod === 'all') === (reloadedCount === '5件'),
    `表示(${reloadedPeriod})と実際の出力件数(${reloadedCount})が矛盾しない`
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
    () => document.scrollingElement.scrollWidth - window.innerWidth
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
    await page.waitForFunction(() => document.getElementById('sum-count').textContent === '5件');
    check((await page.textContent('#sum-count')) === '5件', '分割ZIP: 件数 5件(全パーツ読込)');
    check(
      (await page.textContent('#sum-total')) === '15,048円',
      '分割ZIP: 合計 15,048円(重複返金の二重差引なし)'
    );
    await browser.close();
  }

  // 4) 最小幅 320px(小さい iPhone SE 相当)でレイアウト崩れがないこと
  {
    const browser = await webkit.launch();
    const ctx = await browser.newContext({
      viewport: { width: 320, height: 568 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    console.log('\n=== 320px 幅(最小)レイアウト ===');
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.setInputFiles('#zip-input', DUMMY_ZIP);
    await page.waitForSelector('#settings-section:not([hidden])', { timeout: 30000 });
    await selectCards(page, ['5171']);
    const overflow = await page.evaluate(
      () => document.scrollingElement.scrollWidth - window.innerWidth
    );
    check(overflow <= 0, `320px幅で横オーバーフローなし(${overflow}px)`);
    await page.screenshot({ path: path.join(SHOT_DIR, `se-320-dummy.png`), fullPage: true });
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
