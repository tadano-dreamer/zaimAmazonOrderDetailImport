/**
 * core.js ― Amazon 注文履歴 → Zaim インポート CSV 変換ロジック(UI 非依存)
 *
 * scripts/amazon_to_zaim.py(参照実装 oracle)を 1:1 で移植したもの。
 * ブラウザ(window.ZaimCore)と Node(module.exports)の両方で動く。
 *
 * 集計ルール(実態=カード明細に一致・検証済み):
 *   1. 出荷単位で合算 : 同一注文・同一発送日の明細を 1 エントリに合計
 *   2. 発送日で計上   : Ship Date を(既定で)JST に変換して日付化
 *   3. 返金を差引     : Refund Details.csv の返金額を該当注文から減算
 */
(function (global) {
  'use strict';

  const ZAIM_HEADER = ['日付', 'カテゴリ', 'カテゴリの内訳', 'お店', '支払い元', '品目', '支出金額'];
  const NON_PURCHASE_STATUSES = new Set(['Cancelled', 'Canceled']);
  const ITEM_JOIN = ' / ';
  const JST_OFFSET_MS = 9 * 3600 * 1000;
  const BOM = '﻿';

  const DEFAULT_OPTIONS = {
    card: '5171',
    category: '生活費',
    subcategory: 'ゆうすけインポート',
    store: 'Amazon',
    source: 'ゆうEPOS',
    aggregate: true,
    jst: true,
    dateSource: 'ship', // 'ship'=発送日(既定・oracle と同じ) / 'order'=注文日
  };

  // ------------------------------------------------------------------ 基本関数

  /** "2,200" / "¥1,000" → 整数。数値にできなければ null。 */
  function parseAmount(raw) {
    const s = String(raw == null ? '' : raw).replace(/,/g, '').replace(/¥/g, '').trim();
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  }

  /**
   * ISO 日時("2026-07-08T21:06:11.011Z" 等)→ "YYYY-MM-DD"。
   * jst=true なら +9h して日本時間の日付を取る。パース不能なら先頭10文字。
   */
  function formatDate(raw, jst) {
    const s = String(raw == null ? '' : raw).trim();
    const t = Date.parse(s);
    if (Number.isNaN(t)) return s.slice(0, 10);
    const d = new Date(jst ? t + JST_OFFSET_MS : t);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * RFC4180 準拠の小型 CSV パーサ。BOM 除去・引用符内のカンマ/改行/"" に対応。
   * 先頭行をヘッダとして {列名: 値} の配列を返す。
   */
  function parseCsv(text) {
    let src = String(text == null ? '' : text);
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

    const records = [];
    let field = '';
    let record = [];
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        record.push(field);
        field = '';
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        record.push(field);
        field = '';
        records.push(record);
        record = [];
      } else {
        field += ch;
      }
    }
    if (field !== '' || record.length > 0) {
      record.push(field);
      records.push(record);
    }

    if (records.length === 0) return [];
    const header = records[0];
    const rows = [];
    for (let r = 1; r < records.length; r++) {
      const rec = records[r];
      if (rec.length === 1 && rec[0] === '') continue; // 空行
      const obj = {};
      for (let c = 0; c < header.length; c++) obj[header[c]] = rec[c] != null ? rec[c] : '';
      rows.push(obj);
    }
    return rows;
  }

  /** 商品名リストを重複統合(同名は ×N)して連結。出現順を保持。 */
  function combineNames(names) {
    const counts = new Map();
    for (const raw of names) {
      const n = String(raw == null ? '' : raw).trim();
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    const parts = [];
    for (const [n, c] of counts) parts.push(c > 1 ? `${n}×${c}` : n);
    return parts.join(ITEM_JOIN);
  }

  /** Refund Details.csv の行配列 → {Order ID: 返金合計額}。0/不正額はスキップ。 */
  function loadRefunds(refundRows) {
    const refunds = {};
    for (const r of refundRows || []) {
      const amt = parseAmount(r['Refund Amount']);
      if (!amt) continue;
      const oid = r['Order ID'] || '';
      refunds[oid] = (refunds[oid] || 0) + amt;
    }
    return refunds;
  }

  // ------------------------------------------------------------ カード自動検出

  /**
   * Order History の Payment Method Type からカード(ブランド+下4桁)を検出し、
   * 明細件数付きで返す。件数降順。
   * 例: [{card:"5171", brand:"Visa", count:56, label:"Visa - 5171(56件)"}, ...]
   */
  function detectCards(orderRows) {
    const found = new Map(); // last4 → {brand, count}
    const re = /([A-Za-z][A-Za-z ]*?)\s*-\s*(\d{4})(?!\d)/g;
    for (const row of orderRows || []) {
      const pay = row['Payment Method Type'] || '';
      const seen = new Set(); // 同一明細内の重複カウント防止
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(pay)) !== null) {
        const brand = m[1].trim();
        const last4 = m[2];
        if (seen.has(last4)) continue;
        seen.add(last4);
        const e = found.get(last4) || { brand, count: 0 };
        e.count += 1;
        if (!e.brand) e.brand = brand;
        found.set(last4, e);
      }
    }
    const cards = [];
    for (const [last4, e] of found) {
      cards.push({
        card: last4,
        brand: e.brand,
        count: e.count,
        label: `${e.brand} - ${last4}(${e.count}件)`,
      });
    }
    cards.sort((a, b) => b.count - a.count || a.card.localeCompare(b.card));
    return cards;
  }

  // ---------------------------------------------------------------- 変換本体

  /**
   * 注文明細+返金 → Zaim 7列の出力行。amazon_to_zaim.py の convert() と等価。
   * @param {Array<Object>} orderRows  Order History.csv の行配列
   * @param {Array<Object>|Object} refundRows Refund Details.csv の行配列(または loadRefunds 済みマップ)
   * @param {Object} options {card, category, subcategory, store, source, aggregate, jst}
   * @returns {{rows: string[][], notes: string[], warnings: Array<Object>}}
   *   warnings: ギフト券併用注文(カード実請求額と差が出得るもの)の一覧
   */
  function convert(orderRows, refundRows, options) {
    const opt = Object.assign({}, DEFAULT_OPTIONS, options || {});
    const refunds = Array.isArray(refundRows) ? loadRefunds(refundRows) : refundRows || {};
    const notes = [];
    const entryDate = (r) =>
      opt.dateSource === 'order'
        ? formatDate(r['Order Date'] || r['Ship Date'] || '', opt.jst)
        : formatDate(r['Ship Date'] || r['Order Date'] || '', opt.jst);

    // 1) カード一致(部分一致: ギフト券併用も拾う)& 購入成立の明細だけ残す
    const picked = [];
    for (const row of orderRows || []) {
      const pay = row['Payment Method Type'] || '';
      if (!pay.includes(opt.card)) continue;
      const status = (row['Order Status'] || '').trim();
      if (NON_PURCHASE_STATUSES.has(status)) {
        notes.push(
          `除外(キャンセル): ${formatDate(row['Order Date'], opt.jst)} ` +
            `${(row['Product Name'] || '').slice(0, 30)}`
        );
        continue;
      }
      if (parseAmount(row['Total Amount']) === null) {
        notes.push(
          `除外(金額不正): ${JSON.stringify(row['Total Amount'])} ` +
            `${(row['Product Name'] || '').slice(0, 30)}`
        );
        continue;
      }
      picked.push(row);
    }

    if (!opt.aggregate) {
      // 旧挙動: 明細 1 行 = 1 エントリ(返金は無視)
      const out = picked.map((r) => [
        entryDate(r),
        opt.category,
        opt.subcategory,
        opt.store,
        opt.source,
        (r['Product Name'] || '').trim(),
        String(parseAmount(r['Total Amount'])),
      ]);
      out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return { rows: out, notes, warnings: [] };
    }

    // 2) 出荷単位 (Order ID × 発送日) でグループ化
    const groups = new Map(); // key = oid + "\t" + date
    for (const r of picked) {
      const oid = r['Order ID'] || '';
      const ship = entryDate(r);
      const key = `${oid}\t${ship}`;
      let g = groups.get(key);
      if (!g) {
        g = { oid, date: ship, amount: 0, names: [], gift: false };
        groups.set(key, g);
      }
      g.amount += parseAmount(r['Total Amount']) || 0;
      g.names.push(r['Product Name'] || '');
      if (/Gift/i.test(r['Payment Method Type'] || '')) g.gift = true;
    }

    // 3) 返金を該当注文の(最も遅い発送日の)グループから差し引く
    const orderKeys = new Map(); // oid → [group]
    for (const g of groups.values()) {
      if (!orderKeys.has(g.oid)) orderKeys.set(g.oid, []);
      orderKeys.get(g.oid).push(g);
    }
    for (const [oid, refundAmt] of Object.entries(refunds)) {
      const list = orderKeys.get(oid);
      if (!list || refundAmt <= 0) continue;
      let target = list[0];
      for (const g of list) if (g.date > target.date) target = g;
      target.amount -= refundAmt;
      target.refund = refundAmt;
      notes.push(
        `返金反映: ${target.date} -${refundAmt}円 (注文 ${oid}) → 実質 ${target.amount}円`
      );
    }

    // 4) Zaim 行へ整形(実質0円以下は除外)・ギフト券併用は警告に積む
    const out = [];
    const warnings = [];
    for (const g of groups.values()) {
      if (g.amount <= 0) {
        notes.push(`除外(実質0円/全額返金): ${g.date} ${combineNames(g.names).slice(0, 30)}`);
        continue;
      }
      const names = combineNames(g.names);
      out.push([g.date, opt.category, opt.subcategory, opt.store, opt.source, names, String(g.amount)]);
      if (g.gift) {
        warnings.push({
          date: g.date,
          amount: g.amount,
          names,
          reason:
            'ギフト券併用注文: カードの実請求額はこの金額より少ない可能性があります(内訳分離不能・総額計上)',
        });
      }
    }
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { rows: out, notes, warnings };
  }

  // ---------------------------------------------------------------- CSV 出力

  /** Python csv.writer と同じ最小クオート。カンマ/引用符/改行を含む時だけ "..."。 */
  function csvField(value) {
    const s = String(value == null ? '' : value);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  /** 出力行 → UTF-8 BOM + CRLF の Zaim インポート CSV 文字列。 */
  function generateCsv(rows) {
    const lines = [ZAIM_HEADER, ...(rows || [])].map((r) => r.map(csvField).join(','));
    return BOM + lines.join('\r\n') + '\r\n';
  }

  /** プレビュー用サマリ: 件数・合計金額・期間。 */
  function summarize(rows) {
    const list = rows || [];
    let total = 0;
    for (const r of list) total += Number(r[6]) || 0;
    return {
      count: list.length,
      total,
      minDate: list.length ? list[0][0] : '',
      maxDate: list.length ? list[list.length - 1][0] : '',
    };
  }

  const api = {
    ZAIM_HEADER,
    DEFAULT_OPTIONS,
    parseAmount,
    formatDate,
    parseCsv,
    combineNames,
    loadRefunds,
    detectCards,
    convert,
    generateCsv,
    summarize,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.ZaimCore = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
