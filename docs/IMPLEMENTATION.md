# 実装手順書(セッション引き継ぎ用ハンドオフ)

> **このドキュメントの役割**: 新しいセッション(この会話の記憶なし)が、
> `PLAN.md` とこの文書だけを読んで、前提知識ゼロから Web アプリを実装しきれるようにする。
> まず `PLAN.md`(設計・確定事項)→ 本書(実装手順)の順で読むこと。

---

## 0. まず読む・使うリポジトリ資産

このフォルダには、実装に必要な「正解」がすでに揃っている。**新規に推測で作らず、これらに従う**。

| ファイル | 役割 | 実装時の扱い |
|---|---|---|
| `scripts/amazon_to_zaim.py` | **参照実装(oracle)**。確定した変換ロジックそのもの | JS 移植の元。挙動を1:1で再現する |
| `data/output/zaim_import_5171.csv` | **ゴールデン出力**。UTF-8 BOM・CRLF・39行・合計126,896円 | JS 出力がこれと一致すれば正解 |
| `data/Your Orders.zip` | 実データ(≈19MB)。中に必要 CSV 2つ | 疎通テストの入力。**氏名・住所を含む(PII)** |
| `data/Your Orders/`(解凍済) | 上記 ZIP の展開先 | ローカル検証に利用可 |
| `reference/zaim_import_base_7columns.csv` | 出力ヘッダの正 | ヘッダ文字列の唯一の正 |

> パス基準: 上表は**リポジトリ直下**からの相対。以降 §1 の CSV パスは `data/` 直下からの相対。
| `PLAN.md` | 設計・確定事項・画面仕様 | 仕様の source of truth |

> **PII 注意**: `Order History.csv` の `Billing Address` に氏名・住所が入る。
> テストコードやリポジトリに**実データを埋め込まない**(§7 の合成フィクスチャを使う)。
> アプリはクライアント完結でデータを端末外に出さない設計(理由は PLAN.md §2)。

---

## 1. データ契約(入力仕様)

### 1-1. ZIP 内の対象ファイル(他の大量の PDF は無視)
- 必須: `Your Orders/Your Amazon Orders/Order History.csv`
- 任意: `Your Orders/Your Returns & Refunds/Refund Details.csv`(無い/空でも動作すること)

### 1-2. エンコーディング(重要な落とし穴)
- 両 CSV とも **UTF-8 + BOM(先頭 `EF BB BF`)**。読み込み時に BOM を除去する。
- 中身は正しい UTF-8。※ターミナルに出すと文字化けして見えることがあるが、**データは壊れていない**
  (Windows コンソールの表示エンコーディングの問題)。デコードは常に UTF-8 で行う。

### 1-3. `Order History.csv` の使用カラム(全28列中、使うのはこれだけ)
| カラム名(正確に) | 用途 | 例 |
|---|---|---|
| `Payment Method Type` | カード判定 | `Visa - 5171` / `Gift Certificate/Card and Visa - 5171` |
| `Order Date` | 日付フォールバック | `2026-06-29T14:30:46Z` |
| `Ship Date` | **計上日の基準(既定)** | `2026-06-30T03:50:57.832Z`(ミリ秒あり) |
| `Product Name` | 品目 | `サンナップ(Sunnap) 紙コップ ...` |
| `Total Amount` | 金額(税込・送料込・割引後) | `2,200`(カンマ区切り) |
| `Order ID` | 合算キー | `503-9219336-1401461` |
| `Order Status` | キャンセル除外 | `Closed` / まれに `Cancelled` |

### 1-4. `Refund Details.csv` の使用カラム
| カラム名 | 用途 | 例 |
|---|---|---|
| `Order ID` | 返金を注文に紐付け | `503-2593646-0152603` |
| `Refund Amount` | 返金額(注文から差引) | `200` |

### 1-5. 日付フォーマットの注意
- ISO8601・末尾 `Z`(UTC)。**ミリ秒を含む場合がある**(`...:57.832Z`)。JS の `new Date(iso)` で解釈可。
- **JST への変換が必須**(既定)。`toISOString()` は UTC を返すので使わない。次の手順で計算する:
  ```js
  // iso 例: "2026-07-08T21:06:11.011Z" → JST日付 "2026-07-09"
  const t = new Date(iso).getTime() + 9 * 3600 * 1000; // +9h
  const j = new Date(t);
  const ymd = `${j.getUTCFullYear()}-${String(j.getUTCMonth()+1).padStart(2,'0')}-${String(j.getUTCDate()).padStart(2,'0')}`;
  ```
  UTC モード時は `+9h` を足さずに同じ `getUTC*` で読む。

---

## 2. 変換アルゴリズム(確定・`amazon_to_zaim.py` と等価)

```
入力: orderRows[], refundRows[], 設定{ card, tz(jst|utc), aggregate, category, subcategory, store, source }

1. refundByOrder = {}                      // Order ID → 返金合計
   for r in refundRows: refundByOrder[r.OrderID] += parseAmount(r["Refund Amount"])

2. picked = []                             // 抽出対象の明細
   for row in orderRows:
       if card NOT in row["Payment Method Type"]: continue      // 部分一致(ギフト券併用も拾う)
       if row["Order Status"] in {Cancelled, Canceled}: continue // キャンセル除外
       if parseAmount(row["Total Amount"]) is invalid: continue
       picked.push(row)

3. (aggregate=false の旧挙動) 明細1行=1エントリ。日付=shipDate、返金無視。→ 通常は使わない

4. groups = {}                             // key = (OrderID, 計上日文字列)
   for row in picked:
       date = formatDate(row["Ship Date"] or row["Order Date"], tz)
       key  = OrderID + "\t" + date
       groups[key].amount += parseAmount(row["Total Amount"])
       groups[key].names.push(row["Product Name"])
       groups[key].date = date

5. 返金を差引:
   for orderId, refund in refundByOrder:
       該当 = groups の中で key の OrderID==orderId のもの
       if 該当なし or refund<=0: continue
       target = 該当のうち date が最も新しいグループ
       target.amount -= refund

6. 出力行:
   for g in groups:
       if g.amount <= 0: skip(全額返金など)      // 注記に残す
       row = [ g.date, category, subcategory, store, source, combineNames(g.names), String(g.amount) ]
   日付昇順にソート

補助:
  parseAmount(s)  = s から "," "¥" 空白を除去 → 整数(round)。不能なら invalid
  combineNames(names) = 出現順を保ちつつ同名を統合し "×N" を付す。区切りは " / "
                        例: ["今治","今治"] → "今治×2"、["A","B"] → "A / B"
```

### 出力 CSV 形式(ゴールデンと一致させる)
- ヘッダ(固定・順序厳守): `日付,カテゴリ,カテゴリの内訳,お店,支払い元,品目,支出金額`
- **カンマ/引用符/改行を含むフィールドは CSV クオートする**(品目にカンマが入り得る)。
  PapaParse `unparse` か同等のクオート実装を使う。
- **バイト一致させるなら**: 先頭に UTF-8 BOM、行末は **CRLF**(`\r\n`)。
  (ゴールデンは BOM+CRLF。行単位比較で検証するなら BOM/改行差は無視してよい)

### 固定値の既定
`category=生活費` / `subcategory=ゆうすけインポート` / `store=Amazon` / `source=ゆうEPOS`

---

## 3. ランドマーク検証値(これに一致すれば正しい)

カード `5171`・既定設定(JST・合算・ネット返金)での期待:
- **エントリ数 39 / 合計 126,896 円 / 期間 2025-03-27〜2026-07-09**
- 代表3行:
  | 日付 | 金額 | 品目(先頭) | 意味 |
  |---|---|---|---|
  | 2026-06-30 | 1657 | サンナップ 紙コップ / シルコット | 同一注文2品を合算(477+1180) |
  | 2026-06-30 | 1611 | レノア ハピネス【大容量】... | 1,811 − 返金200(発送遅延) |
  | 2026-07-09 | 4740 | ブルーム 今治タオル... | 同一注文2個を合算(2,370×2)・JSTで7/9 |
- **要注意**: `2026-05-20 / 5760 / Matdeco 冷感敷きパッド` はギフト券併用注文。
  カード実請求はこれより少ないが内訳を分離できないため総額計上(UI で注記する)。

---

## 4. 実装タスク(順序付き・各ステップに受入基準)

### Phase 1 — コアロジック(UI なし)
1. `web/js/core.js` に §2 のアルゴリズムを実装(`parseAmount` / `formatDate(iso,tz)` / `combineNames` / `convert`)。
2. `web/js/core.test.js` に §7 の合成フィクスチャで単体テストを先に書く(TDD)。
   - 受入: 合算1,657 / 返金ネット1,611 / 数量合算4,740 / JST境界(7/8→7/9)/ キャンセル除外 が緑。
3. **等価性テスト**: 実 `Your Orders.zip` を解凍 → `Order History.csv`+`Refund Details.csv` を `core.js` に通し、
   `zaim_import_5171.csv` と**行単位で完全一致**することを確認(§5)。
   - 受入: 39行すべて一致・合計126,896。

### Phase 2 — 最小 UI
4. `web/index.html` + `web/js/ui.js`:
   - `<input type=file accept=.zip>` → JSZip で対象2ファイルだけ取り出し。
   - `Payment Method Type` を集計して**プルダウン**(件数付き)に。
   - オプション(§ PLAN.md §4。まず動くものを作り、選択肢は 2〜3 個に間引く。TZ 既定 JST、返金ネット固定)。
   - プレビュー表(件数・合計・期間・ギフト券/返金の注記)→ ダウンロード。
   - 受入: 実 ZIP をブラウザに入れて 5171 を選ぶと、Phase1 と同じ 39行が出て保存できる。

### Phase 3 — スマホ最適化 & 公開
5. レスポンシブ CSS。iOS Safari 対策で 保存経路を ダウンロード/共有/コピー から実機で確実な方式に。
6. **GitHub Pages 公開**(§6)。実機(iPhone/Android)で ZIP 投入→CSV 取得を確認(スクショ)。

### Phase 4 — 将来拡張(任意)
7. PWA 化(ホーム追加・オフライン)、Web Share Target(共有メニューから ZIP 受け取り)、localStorage で前回設定記憶。

---

## 5. 等価性検証のやり方(具体)

Python 版を「正解」として突き合わせる。ローカルで:
```bash
# 1) 参照出力(既に存在。無ければ再生成)
python scripts/amazon_to_zaim.py    # → data/output/zaim_import_5171.csv (JST/ゆうEPOS/合算/ネット)

# 2) JS 版の出力を作り、行単位で比較(BOM/改行を無視して比較)
#    Node で core.js を実 CSV に通し、生成 CSV と data/output/zaim_import_5171.csv を diff する小スクリプトを用意
```
比較は **行の集合が一致**すること(順序も日付昇順で揃う)。バイト一致まで求めるなら BOM+CRLF を付与。

---

## 6. GitHub Pages デプロイ手順(コスト0)

```bash
git init
git add web/ docs/ scripts/ reference/ README.md .gitignore
# ※ data/(Your Orders.zip / Your Orders/ / output/*.csv)は PII を含むためコミットしない
#   → リポジトリ直下の .gitignore で /data/ を除外済み
git commit -m "feat: Amazon->Zaim CSV 変換Webアプリ"
gh repo create <name> --public --source=. --push
# GitHub の Settings > Pages で Branch=main / dir=/ (または /web) を Pages に設定
# 公開 URL にスマホからアクセスして確認
```
`.gitignore`(リポジトリ直下・作成済み)で除外している主なもの:
```
/data/          # 実データZIP・解凍済みCSV・生成CSV(すべてPII扱い)
```

---

## 7. 単体テスト用・合成フィクスチャ(PII なし)

実データの代わりにテストへ埋め込む最小データ(`Order History.csv` 相当の行):

| Payment Method Type | Order ID | Ship Date | Product Name | Total Amount | Order Status | 期待 |
|---|---|---|---|---|---|---|
| Visa - 5171 | A | 2026-06-30T03:50Z | 紙コップ | 477 | Closed | A: 紙コップ / シート = **1657** |
| Visa - 5171 | A | 2026-06-30T03:50Z | シート | 1180 | Closed | 〃 |
| Visa - 5171 | B | 2026-06-30T11:28Z | レノア | 1811 | Closed | B: **1611**(返金200) |
| Visa - 5171 | C | 2026-07-08T21:06Z | 今治 | 2370 | Closed | C: 今治×2 = **4740** / 日付 **2026-07-09** |
| Visa - 5171 | C | 2026-07-08T21:06Z | 今治 | 2370 | Closed | 〃 |
| Gift Certificate/Card and Visa - 5171 | D | 2026-05-19T..Z | 敷パッド | 2880 | Closed | D: ギフト券併用でも抽出される |
| Visa - 5171 | E | 2026-06-01T..Z | キャンセル品 | 999 | Cancelled | E: **除外**される |
| Visa - 1745 | F | ... | 対象外カード | 500 | Closed | F: **抽出されない** |

`Refund Details.csv` 相当: `Order ID=B, Refund Amount=200`。

期待サマリ(このフィクスチャ・card=5171・JST・合算・ネット):
- エントリ数 **4**(A,B,C,D)/ 合計 **1657+1611+4740+2880 = 10,888**
- A と B は 2026-06-30、C は 2026-07-09、D は 2026-05-19。

---

## 8. 落とし穴チェックリスト(先人が踏んだ順)

- [ ] BOM を除去して読む(付いたまま `ASIN` が `﻿ASIN` にならないように)。
- [ ] 日付は **JST 変換してから** YYYY-MM-DD 化(`toISOString` は UTC で誤り)。ミリ秒付き ISO に対応。
- [ ] カード一致は**部分一致**(`includes`)。完全一致だとギフト券併用を取りこぼす。
- [ ] `Total Amount` はカンマ除去してから数値化。
- [ ] 合算キーは (Order ID, **計上日**)。日付を跨ぐ分割発送は別エントリ(実データには無いが将来対応)。
- [ ] 返金は Order ID 単位。該当注文が抽出対象に無ければ無視。net≤0 は出力しない。
- [ ] 品目にカンマが入り得るので **CSV クオート**する。
- [ ] 実データ(ZIP・住所入り CSV・生成 CSV)は **git に含めない**。
- [ ] バイト一致を狙うなら BOM + CRLF。狙わないなら行単位比較で BOM/改行差を無視。
