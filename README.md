# Amazon → Zaim インポートCSV 変換

Amazon の注文履歴 ZIP から、特定のクレジットカードで購入した注文だけを抽出し、
Zaim インポート用 CSV(`日付,カテゴリ,カテゴリの内訳,お店,支払い元,品目,支出金額`)を生成する。

**Web アプリ実装済み**(`web/` ― クライアント完結・サーバ不要)。
スマホ(iPhone 等)のブラウザで ZIP を投入すると、その場で Zaim 取込用 CSV を生成できる。
PC 用 CLI(`scripts/amazon_to_zaim.py`)は参照実装(oracle)として維持。
設計・実装手順は `docs/` 参照。

## Web アプリの使い方

1. `web/index.html` をブラウザで開く(ローカルなら `python -m http.server -d web` → `http://localhost:8000`)
2. Amazon「データをリクエスト」で入手した `Your Orders.zip` をそのまま選択
3. カード(自動検出・件数付き)と計上日(発送日JST推奨)を選ぶ
4. プレビューを確認して「CSVをダウンロード」(iPhone は共有シート経由の保存も可)

処理はすべてブラウザ内で完結し、注文データ・氏名・住所は外部送信されない。

### テスト

```bash
node --test web/js/core.test.js        # 単体テスト(34件)
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

詳細・根拠・検証値は `docs/IMPLEMENTATION.md` を参照。
