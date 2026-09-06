# Amazon → Zaim インポートCSV 変換

Amazon の注文履歴 ZIP から、特定のクレジットカードで購入した注文だけを抽出し、
Zaim インポート用 CSV(`日付,カテゴリ,カテゴリの内訳,お店,支払い元,品目,支出金額`)を生成する。

**Web アプリ実装済み**(`web/` ― クライアント完結・サーバ不要)。
スマホ(iPhone 等)のブラウザで ZIP を投入すると、その場で Zaim 取込用 CSV を生成できる。

**公開URL(GitHub Pages)**: https://tadano-dreamer.github.io/zaimAmazonOrderDetailImport/
(`main` への push で `.github/workflows/deploy-pages.yml` がテスト通過後に自動デプロイ)
PC 用 CLI(`scripts/amazon_to_zaim.py`)は参照実装(oracle)として維持。
設計・実装手順は `docs/` 参照。

## Web アプリの使い方

1. `web/index.html` をブラウザで開く(ローカルなら `python -m http.server -d web` → `http://localhost:8000`)
2. Amazon「データをリクエスト」で入手した `Your Orders.zip` をそのまま選択
3. **カードを選ぶ(複数選択可・利用期間付きで自動検出)**
   - カードを更新・再発行すると下4桁が変わる。家計簿上は同じ口座なので**旧番号と新番号を両方選ぶ**。
   - 切替を検出すると画面が警告し、ワンタップで後継カードを追加できる。
4. **出力する期間を選ぶ**(全期間 / 月単位)。Zaim へは月ごとに取り込む想定。
5. ギフト券併用の警告が出たら、カード明細の**実請求額を入力して補正**する
   (ギフト券の充当額は注文履歴に含まれないため、そのままだと総額で出る)
6. プレビューを確認して「CSVをダウンロード」(iPhone は共有シート経由の保存も可)

処理はすべてブラウザ内で完結し、注文データ・氏名・住所は外部送信されない。

### テスト

```bash
node --test web/js/core.test.js        # 単体テスト(57件)
node scripts/verify_equivalence.js     # 実データ vs ゴールデンCSV(要 data/)
node scripts/verify_dummy.js           # ダミーデータ vs Python参照実装
cd tests && npm install && npx playwright install chromium webkit
node tests/e2e.cjs                     # E2E(iPhone WebKit + Chromium エミュレーション)
```

ダミーデータ(PIIなし・本番と同一構造)は `node scripts/make_dummy_data.js` で再生成できる。

## フォルダ構成

```
.
├── README.md                # このファイル
├── .gitignore               # data/(PII)をコミット対象外にする
├── docs/                    # 設計・実装手順
│   ├── PLAN.md              #   設計・確定事項(まず読む)
│   ├── IMPLEMENTATION.md    #   実装手順書(データ契約・アルゴリズム・検証値)
│   └── screenshots/         #   iPhoneエミュレーションでの動作スクリーンショット(ダミーデータ)
├── scripts/
│   ├── amazon_to_zaim.py    #   参照実装(oracle): Amazon履歴 → Zaim CSV 変換 CLI
│   ├── verify_equivalence.js#   JS出力と実データゴールデンCSVの等価性検証
│   ├── make_dummy_data.js   #   PIIなしダミー Your Orders.zip 生成
│   └── verify_dummy.js      #   ダミーデータでのJS/Python等価性検証
├── reference/               # 参照用データ
│   ├── zaim_import_base_7columns.csv  # 出力ヘッダの正
│   └── FileDescriptions.csv           # Amazonの各ファイル説明
├── web/                     # ★Webアプリ本体(静的・ビルド不要)
│   ├── index.html           #   単一画面
│   ├── css/style.css        #   モバイルファーストCSS
│   ├── js/core.js           #   変換ロジック(Python移植・UI非依存)
│   ├── js/core.test.js      #   単体テスト(node --test)
│   ├── js/ui.js             #   DOM操作・イベント
│   └── vendor/jszip.min.js  #   ZIP解凍(ローカル同梱・CDN非依存)
├── testdata/dummy/          # PIIなしダミーデータ(投入用ZIP+期待出力CSV)
├── tests/                   # E2Eテスト(Playwright・iPhoneエミュレーション)
└── data/                    # ★PII含む・gitignore対象(入力と生成物)
    ├── Your Orders.zip      #   Amazonからダウンロードした履歴ZIP
    ├── Your Orders/         #   解凍済み(Order History.csv 等)
    └── output/              #   生成された Zaim 取込用 CSV
        └── zaim_import_5171.csv
```

## 使い方(CLI)

```bash
# 既定: カード5171 / 生活費・ゆうすけインポート / 発送日JST / 出荷単位で合算 / 返金差引
python scripts/amazon_to_zaim.py

# 別カードで抽出
python scripts/amazon_to_zaim.py --card 1745

# カード更新で下4桁が変わった場合は両方指定(片方だけだと切替以降が丸ごと落ちる)
python scripts/amazon_to_zaim.py --card 5171,7474

# 月次で取り込む
python scripts/amazon_to_zaim.py --card 5171,7474 --month 2026-07

# ZIPから解凍込みで実行(data/ に Your Orders.zip がある前提)
python scripts/amazon_to_zaim.py --zip "Your Orders.zip"

# タイムゾーンをUTCに / 支払い元を変更
python scripts/amazon_to_zaim.py --tz utc --source "楽天カード"
```

出力は `data/output/zaim_import_<card>.csv`(UTF-8 BOM 付き)に書き出される。

## 変換ルール(実態=カード明細に一致・検証済み)

- **出荷単位で合算**: 同一注文・同一発送日の明細を1件に合計
- **発送日(既定 JST)で計上**: `Ship Date` を日本時間に変換して日付化
- **返金を差引**: `Refund Details.csv` の返金額を該当注文から減算
- **複数カードを合算**: カード更新で下4桁が変わっても取りこぼさない
- **期間で絞り込み**: 月単位で切り出して Zaim へ取り込む
- **ギフト券併用は手動補正**: 実請求額を入力するとその額で出力する

詳細・根拠・検証値は `docs/IMPLEMENTATION.md` を参照。

## Zaim 実績との突合状況(2026-09-06)

Zaim のカード連携実績(2026-02〜07)と1件ずつ突合し、**6か月中5か月が1円まで一致**。
残る差は Zaim 側の記録漏れ 1件(2,569円)だけで、これは本ツールが埋めるべき差分。
検出した3つの欠陥(カード切替での欠落 41,139円 / ギフト券併用の過大 1,669円 /
複数出荷の分割計上)と対策は `docs/IMPLEMENTATION.md` §9 に記載。

> ⚠️ Amazon アカウントが違うと抽出できない: Zaim の「ともEPOS × Amazon」(21件)は
> 別アカウントの購入で、このエクスポートには含まれない。取り込むにはそのアカウントで
> 別途「データをリクエスト」する必要がある。
