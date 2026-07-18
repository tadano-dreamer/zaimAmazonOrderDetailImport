# Amazon → Zaim インポートCSV 変換

Amazon の注文履歴 ZIP から、特定のクレジットカードで購入した注文だけを抽出し、
Zaim インポート用 CSV(`日付,カテゴリ,カテゴリの内訳,お店,支払い元,品目,支出金額`)を生成する。

現状は **PC 用 CLI スクリプト**(`scripts/amazon_to_zaim.py`)が動作する。
最終形は「スマホ(Web)で ZIP を投入すると CSV を返すクライアント完結の静的 Web アプリ」
（設計・実装手順は `docs/` 参照。実装は未着手）。

## フォルダ構成

```
.
├── README.md                # このファイル
├── .gitignore               # data/(PII)をコミット対象外にする
├── docs/                    # 設計・実装手順
│   ├── PLAN.md              #   設計・確定事項(まず読む)
│   └── IMPLEMENTATION.md    #   新セッションが記憶ゼロから実装するための手順書
├── scripts/                 # 動作する参照実装(oracle)
│   └── amazon_to_zaim.py    #   Amazon履歴 → Zaim CSV 変換 CLI
├── reference/               # 参照用データ
│   ├── zaim_import_base_7columns.csv  # 出力ヘッダの正
│   └── FileDescriptions.csv           # Amazonの各ファイル説明
├── web/                     # 将来のWebアプリ(スキャフォールドのみ)
│   ├── js/  css/  vendor/
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
