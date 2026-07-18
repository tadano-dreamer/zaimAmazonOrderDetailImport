#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Amazon 注文履歴 (Order History.csv) から特定のクレジットカードの注文を抽出し、
Zaim インポート用 CSV (日付,カテゴリ,カテゴリの内訳,お店,支払い元,品目,支出金額) を生成する。

■ 実態(カード明細/Zaim連携)に合わせた集計ルール
  1. 出荷単位で合算 : 同じ注文で同じ日に発送された明細を 1 エントリにまとめ、金額を合計する。
                      (例: サンナップ紙コップ 477 + シルコット 1,180 = 1,657)
                      (例: 今治タオル 2,370 × 2個 = 4,740)
  2. 発送日で計上   : 日付は Order Date ではなく Ship Date(発送日)を使う。
                      カードは発送時に請求されるため、6/29 注文→6/30 発送は 6/30 計上。
  3. 返金を差引     : Refund Details.csv の返金額を該当注文から差し引く。
                      (例: レノア 1,811 − 発送遅延返金 200 = 実質 1,611)

使い方 (PowerShell / bash 共通):
    python amazon_to_zaim.py                       # 既定 (カード5171)
    python amazon_to_zaim.py --card 1745           # 別のカード下4桁で抽出
    python amazon_to_zaim.py --zip "Your Orders.zip"  # ZIP から解凍してから処理
    python amazon_to_zaim.py --no-aggregate        # 合算せず明細1行=1エントリ(旧挙動)
"""
from __future__ import annotations

import argparse
import csv
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

# --- 既定値 ---------------------------------------------------------------
DEFAULT_CARD = "5171"                       # 抽出するカード下4桁
DEFAULT_CATEGORY = "生活費"                  # Zaim カテゴリ (固定)
DEFAULT_SUBCATEGORY = "ゆうすけインポート"    # Zaim カテゴリの内訳 (固定)
DEFAULT_STORE = "Amazon"                    # Zaim お店
DEFAULT_SOURCE = "ゆうEPOS"                  # Zaim 支払い元 (EPOS = Visa 5171)
DEFAULT_TZ = "jst"                          # 計上日のタイムゾーン (jst / utc)

JST = timezone(timedelta(hours=9))          # 日本時間

ORDER_CSV_REL = Path("Your Orders") / "Your Amazon Orders" / "Order History.csv"
REFUND_CSV_REL = Path("Your Orders") / "Your Returns & Refunds" / "Refund Details.csv"

ZAIM_HEADER = ["日付", "カテゴリ", "カテゴリの内訳", "お店", "支払い元", "品目", "支出金額"]
NON_PURCHASE_STATUSES = {"Cancelled", "Canceled"}
ITEM_JOIN = " / "                           # 複数商品をまとめる際の区切り


def unzip_if_needed(base_dir: Path, zip_name: str | None) -> None:
    if not zip_name:
        return
    zip_path = base_dir / zip_name
    if not zip_path.exists():
        sys.exit(f"[ERROR] ZIP が見つかりません: {zip_path}")
    print(f"[INFO] 解凍中: {zip_path}")
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(base_dir)
    print("[INFO] 解凍完了")


def parse_amount(raw: str) -> int | None:
    s = (raw or "").replace(",", "").replace("¥", "").strip()
    try:
        return int(round(float(s)))
    except (ValueError, TypeError):
        return None


def parse_date(raw: str, jst: bool = True) -> str:
    """'2025-04-13T07:22:17Z' -> '2025-04-13'。

    Amazon の日時は UTC(末尾 Z)。jst=True なら日本時間へ変換してから日付を取る
    (カード明細は日本時間基準のため、既定で JST)。失敗時は先頭10文字。
    """
    raw = (raw or "").strip()
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if jst:
            dt = dt.astimezone(JST)
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return raw[:10]


def load_csv(path: Path, required: bool = True) -> list[dict]:
    if not path.exists():
        if required:
            sys.exit(f"[ERROR] CSV が見つかりません: {path}")
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_refunds(path: Path) -> dict[str, int]:
    """Order ID -> 返金合計額。返金ファイルが無ければ空。"""
    refunds: dict[str, int] = defaultdict(int)
    for r in load_csv(path, required=False):
        amt = parse_amount(r.get("Refund Amount", ""))
        if amt:
            refunds[r.get("Order ID", "")] += amt
    return dict(refunds)


def combine_names(names: list[str]) -> str:
    """商品名リストを重複統合 (同名は ×N) して連結。出現順を保持。"""
    counts: dict[str, int] = {}
    for n in names:
        n = (n or "").strip()
        counts[n] = counts.get(n, 0) + 1
    return ITEM_JOIN.join(f"{n}×{c}" if c > 1 else n for n, c in counts.items())


def convert(rows: list[dict], refunds: dict[str, int], card: str,
            category: str, subcategory: str, store: str, source: str,
            aggregate: bool, jst: bool) -> tuple[list[list[str]], list[str]]:
    """抽出条件に合う行を Zaim 形式へ変換。戻り値: (出力行, 注記メッセージ)."""
    notes: list[str] = []

    # 1) カード一致 & 購入成立の明細だけ残す
    picked: list[dict] = []
    for row in rows:
        if card not in row.get("Payment Method Type", ""):
            continue
        status = (row.get("Order Status") or "").strip()
        if status in NON_PURCHASE_STATUSES:
            notes.append(f"除外(キャンセル): {parse_date(row.get('Order Date',''), jst)} "
                         f"{(row.get('Product Name') or '')[:30]}")
            continue
        if parse_amount(row.get("Total Amount", "")) is None:
            notes.append(f"除外(金額不正): {row.get('Total Amount')!r} "
                         f"{(row.get('Product Name') or '')[:30]}")
            continue
        picked.append(row)

    if not aggregate:
        # 旧挙動: 明細 1 行 = 1 エントリ (返金は無視)
        out = [[
            parse_date(r.get("Ship Date") or r.get("Order Date", ""), jst),
            category, subcategory, store, source,
            (r.get("Product Name") or "").strip(),
            str(parse_amount(r.get("Total Amount", ""))),
        ] for r in picked]
        out.sort(key=lambda x: x[0])
        return out, notes

    # 2) 出荷単位 (Order ID × 発送日) でグループ化
    groups: dict[tuple[str, str], dict] = {}
    for r in picked:
        oid = r.get("Order ID", "")
        ship = parse_date(r.get("Ship Date") or r.get("Order Date", ""), jst)
        key = (oid, ship)
        g = groups.setdefault(key, {"date": ship, "amount": 0, "names": []})
        g["amount"] += parse_amount(r.get("Total Amount", "")) or 0
        g["names"].append(r.get("Product Name") or "")

    # 3) 返金を該当注文の(最も遅い発送日の)グループから差し引く
    order_keys: dict[str, list] = defaultdict(list)
    for key in groups:
        order_keys[key[0]].append(key)
    for oid, refund_amt in refunds.items():
        keys = order_keys.get(oid)
        if not keys or refund_amt <= 0:
            continue
        target = max(keys, key=lambda k: k[1])  # 最新発送日のグループへ
        groups[target]["amount"] -= refund_amt
        groups[target]["refund"] = refund_amt
        notes.append(f"返金反映: {groups[target]['date']} -{refund_amt}円 "
                     f"(注文 {oid}) → 実質 {groups[target]['amount']}円")

    # 4) Zaim 行へ整形
    out: list[list[str]] = []
    for key, g in groups.items():
        amt = g["amount"]
        if amt <= 0:
            notes.append(f"除外(実質0円/全額返金): {g['date']} {combine_names(g['names'])[:30]}")
            continue
        out.append([g["date"], category, subcategory, store, source,
                    combine_names(g["names"]), str(amt)])
    out.sort(key=lambda x: x[0])
    return out, notes


def main() -> None:
    ap = argparse.ArgumentParser(description="Amazon注文履歴 -> Zaimインポート用CSV")
    # 既定の作業フォルダ = リポジトリ直下の data/ (scripts/ の1つ上の階層)
    default_base = Path(__file__).resolve().parent.parent / "data"
    ap.add_argument("--base", default=str(default_base),
                    help="作業フォルダ (既定: リポジトリの data/ ・Your Orders/ が置かれた場所)")
    ap.add_argument("--zip", dest="zip_name", default=None,
                    help="解凍する ZIP ファイル名 (未指定なら解凍済み前提)")
    ap.add_argument("--card", default=DEFAULT_CARD, help="抽出するカード下4桁")
    ap.add_argument("--category", default=DEFAULT_CATEGORY)
    ap.add_argument("--subcategory", default=DEFAULT_SUBCATEGORY)
    ap.add_argument("--store", default=DEFAULT_STORE)
    ap.add_argument("--source", default=DEFAULT_SOURCE, help="Zaim 支払い元")
    ap.add_argument("--tz", default=DEFAULT_TZ, choices=["jst", "utc"],
                    help="計上日のタイムゾーン (既定 jst=日本時間, utc=変換なし)")
    ap.add_argument("--no-aggregate", dest="aggregate", action="store_false",
                    help="出荷単位で合算せず、明細1行=1エントリで出力する")
    ap.add_argument("--out", default=None, help="出力ファイル名 (既定: zaim_import_<card>.csv)")
    args = ap.parse_args()

    base_dir = Path(args.base)
    unzip_if_needed(base_dir, args.zip_name)

    rows = load_csv(base_dir / ORDER_CSV_REL)
    refunds = load_refunds(base_dir / REFUND_CSV_REL)
    print(f"[INFO] Order History.csv: {len(rows)} 明細 / 返金データ: {len(refunds)} 注文")

    out_rows, notes = convert(
        rows, refunds, args.card, args.category, args.subcategory,
        args.store, args.source, args.aggregate, jst=(args.tz == "jst"),
    )

    out_name = args.out or f"zaim_import_{args.card}.csv"
    out_dir = base_dir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / out_name
    with open(out_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(ZAIM_HEADER)
        w.writerows(out_rows)

    total = sum(int(r[6]) for r in out_rows)
    mode = "出荷単位で合算" if args.aggregate else "明細1行=1エントリ"
    tzlabel = "日付=発送日/JST" if args.tz == "jst" else "日付=発送日/UTC"
    print(f"[OK] 出力: {out_path}  ({mode}, {tzlabel}, 支払い元={args.source or '空欄'})")
    print(f"[OK] カード {args.card}: {len(out_rows)} エントリ / 合計 {total:,} 円")
    if out_rows:
        print(f"[OK] 期間: {out_rows[0][0]} 〜 {out_rows[-1][0]}")
    if notes:
        print(f"[NOTE] 特記 {len(notes)} 件:")
        for n in notes:
            print(f"       - {n}")


if __name__ == "__main__":
    main()
