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

  /**
   * 出力列。Zaim の「一般的な CSV ファイルをアップロードする」設定画面に並ぶ
   * 項目と**同じ順序・同じ個数**にしてある。こうすると取込設定を上から順に
   * 1,2,3… と入れるだけで済み、列番号の数え間違い(金額を1つ手前の品目列に
   * 指定してしまう等)が起きない。ヘッダ名は Zaim 側では使われない。
   */
  const ZAIM_HEADER = [
    '日付',
    'カテゴリ',
    'カテゴリの内訳',
    'メモ',
    'お店',
    '支払元',
    '入金先',
    '品目',
    '支出金額',
  ];

  /** ZAIM_HEADER の列番号(0始まり)。 */
  const COL = {
    date: 0,
    category: 1,
    subcategory: 2,
    memo: 3,
    store: 4,
    source: 5,
    receiver: 6,
    item: 7,
    amount: 8,
  };

  /** 1商品あたりの見出し長。家計簿の一覧で読める長さに収める。 */
  const ITEM_MAX_LEN = 24;

  /**
   * Zaim の1項目に入る最大文字数。実機(iOS アプリ「支出の詳細」)のメモ欄で
   * 100文字を超えると赤字になり保存できないことを確認済み。
   */
  const FIELD_MAX_LEN = 100;

  /**
   * 品目欄の予算。**Zaim 側の上限は未確認**(赤字が出たのはメモだけだった)。
   * 超過すると取込時に弾かれるので安全側に振ってある。上限が判明したらここ1行を直す。
   * 60 あれば 24文字の商品名を2つ並べて「ほかN点」を足しても収まる。
   */
  const ITEM_FIELD_MAX = 60;

  /** メモ欄の中身。notes=注記+注文IDのみ(既定) / none=空欄 / full=全商品名も入れる。 */
  const MEMO_MODES = ['notes', 'none', 'full'];

  /**
   * カテゴリの内訳の選択肢。自由入力だと打ち間違いがそのまま新しい内訳として
   * Zaim 側に増えるため、選択肢に閉じる(増やすときはここを直す)。
   * tag は出力ファイル名に入れる ASCII 表記(どちらへ取り込んだかを控えるため)。
   */
  const SUBCATEGORY_CHOICES = [
    { value: 'ゆうすけAmazon', tag: 'yusuke' },
    { value: 'ともかAmazon', tag: 'tomoka' },
  ];

  const NON_PURCHASE_STATUSES = new Set(['Cancelled', 'Canceled']);
  const ITEM_JOIN = ' / ';
  const MEMO_JOIN = ' / ';
  const JST_OFFSET_MS = 9 * 3600 * 1000;
  const BOM = '﻿';

  const DEFAULT_OPTIONS = {
    card: '5171',
    cards: null, // 配列を渡すと複数カードを合算(カード再発行で下4桁が変わるケース用)
    category: '生活費',
    subcategory: SUBCATEGORY_CHOICES[0].value,
    store: 'Amazon',
    source: 'ゆうEPOS',
    aggregate: true,
    splitByItem: false, // true で「商品ごとに1行」(Zaim では別レコードになる)
    memo: 'notes', // MEMO_MODES のいずれか
    jst: true,
    dateSource: 'ship', // 'ship'=発送日(既定・oracle と同じ) / 'order'=注文日
    dateFrom: '', // 'YYYY-MM-DD' 以降(含む)。空なら下限なし
    dateTo: '', // 'YYYY-MM-DD' 以前(含む)。空なら上限なし
    amountOverrides: null, // { '<OrderID>\t<計上日>': 実請求額 } ギフト券併用等の手動補正
  };

  /** Amazon は同一注文の複数出荷を " and " で連結して1セルに入れることがある。 */
  const MULTI_VALUE_SEP = ' and ';

  // ------------------------------------------------------------------ 基本関数

  /**
   * "2,200" / "¥1,000" → 整数。数値にできなければ null。
   * 注: JPY 整数のみを想定。小数 x.5 ちょうどの丸め方向は Python 参照実装
   * (round = 偶数丸め)と異なるが、実データでは発生しない。
   */
  function parseAmount(raw) {
    const s = String(raw == null ? '' : raw).replace(/,/g, '').replace(/¥/g, '').trim();
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  }

  /**
   * '"A and B"' 形式(同一注文が複数出荷された行)を個々の値へ分解する。
   * 単一値ならそのまま1要素、空なら空配列。
   */
  function splitDateValues(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return [];
    return s
      .split(MULTI_VALUE_SEP)
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }

  /**
   * ISO 日時("2026-07-08T21:06:11.011Z" 等)→ "YYYY-MM-DD"。
   * jst=true なら +9h して日本時間の日付を取る。パース不能なら先頭10文字。
   * 複数出荷が " and " で連結された値は先頭(最初の出荷)を採用する。
   */
  function formatDate(raw, jst) {
    const values = splitDateValues(raw);
    const s = values.length > 0 ? values[0] : '';
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

  /**
   * 文字列を maxLen 文字以内に収める(切ったら末尾を … にする)。
   * 戻り値の長さは **必ず maxLen 以下**。Zaim の項目上限を超えると取込時に弾かれるため、
   * 「… を足したら1文字はみ出す」ことがあってはいけない。
   *
   * コードポイント単位で数える: JS の slice はコード単位で切るため、絵文字などの
   * サロゲートペアを分断し、UTF-8 に書き出した時点で「�」になる。
   */
  function truncate(text, maxLen) {
    const chars = Array.from(String(text == null ? '' : text));
    if (chars.length <= maxLen) return chars.join('');
    if (maxLen <= 0) return '';
    return `${chars.slice(0, maxLen - 1).join('')}…`;
  }

  /**
   * Amazon の商品名を家計簿で読める見出しに整える。
   * 「【まとめ買い】」「[大容量]」のような宣伝ブロックを落として詰め、
   * 長すぎるものは切る(落とした情報はメモに全文が残る)。
   */
  function shortenName(raw, maxLen) {
    const limit = maxLen == null ? ITEM_MAX_LEN : maxLen;
    // 開き括弧と同じ種類の閉じ括弧までを1組として落とす。種類を問わず最も近い
    // 閉じ括弧で止めると "【A[B]C】" で "C】" が残る
    let s = String(raw == null ? '' : raw)
      .replace(/【[^】]*】|［[^］]*］|\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (s === '') s = String(raw == null ? '' : raw).trim();
    // slice はコード単位で切るため、絵文字などのサロゲートペアを分断して
    // 孤立サロゲートを残す。UTF-8 に書き出す時点で「�」になり品目が壊れるので、
    // コードポイント単位で数える。
    const chars = Array.from(s);
    return chars.length <= limit ? s : `${chars.slice(0, limit).join('').trim()}…`;
  }

  /**
   * 出荷グループの商品名リスト → 品目欄の1行。
   * 同名は ×N。**予算いっぱいまで商品名を並べ**、入りきらない分だけ「ほかN点」に畳む。
   *
   * 先頭1件だけ出して「ほか1点」にすると、何を買ったのか家計簿から分からなくなる
   * (実機で「乳液… ほか1点」となり、消えた浄水器カートリッジが追えなかった)。
   */
  function itemLabel(names, maxLen) {
    // `maxLen || 既定` にすると 0 を渡したとき黙って既定に戻る(0 は有効な予算)
    const budget = maxLen == null ? ITEM_FIELD_MAX : maxLen;
    const counts = new Map();
    for (const raw of names || []) {
      const n = String(raw == null ? '' : raw).trim();
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    const labels = [...counts.entries()].map(
      ([n, c]) => shortenName(n) + (c > 1 ? `×${c}` : '')
    );
    if (labels.length === 0) return '';

    let text = labels[0];
    let shown = 1;
    for (let i = 1; i < labels.length; i++) {
      const candidate = `${text}${ITEM_JOIN}${labels[i]}`;
      const rest = labels.length - i - 1;
      // 「ほかN点」を付けた瞬間に予算を超えないよう、先に足して判定する
      const tail = rest > 0 ? ` ほか${rest}点` : '';
      if (Array.from(candidate + tail).length > budget) break;
      text = candidate;
      shown = i + 1;
    }
    const omitted = labels.length - shown;
    return truncate(omitted > 0 ? `${text} ほか${omitted}点` : text, budget);
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
   * 明細件数と利用期間(初回・最終の計上日)付きで返す。件数降順。
   * 例: [{card:"5171", brand:"Visa", count:56, firstDate:"2025-03-27",
   *       lastDate:"2026-07-09", label:"Visa - 5171(56件)"}, ...]
   */
  function detectCards(orderRows, jst) {
    const useJst = jst === undefined ? true : jst;
    const found = new Map(); // last4 → {brand, count, firstDate, lastDate}
    const re = /([A-Za-z][A-Za-z ]*?)\s*-\s*(\d{4})(?!\d)/g;
    for (const row of orderRows || []) {
      const pay = row['Payment Method Type'] || '';
      const date = formatDate(row['Ship Date'] || row['Order Date'] || '', useJst);
      const seen = new Set(); // 同一明細内の重複カウント防止
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(pay)) !== null) {
        const brand = m[1].trim();
        const last4 = m[2];
        if (seen.has(last4)) continue;
        seen.add(last4);
        const e = found.get(last4) || { brand, count: 0, firstDate: '', lastDate: '' };
        e.count += 1;
        // ギフト券併用表記("...Card and Visa - 5171")より素のブランド名を優先
        if (!e.brand || brand.length < e.brand.length) e.brand = brand;
        if (date) {
          if (!e.firstDate || date < e.firstDate) e.firstDate = date;
          if (!e.lastDate || date > e.lastDate) e.lastDate = date;
        }
        found.set(last4, e);
      }
    }
    const cards = [];
    for (const [last4, e] of found) {
      cards.push({
        card: last4,
        brand: e.brand,
        count: e.count,
        firstDate: e.firstDate,
        lastDate: e.lastDate,
        label: `${e.brand} - ${last4}(${e.count}件)`,
      });
    }
    cards.sort((a, b) => b.count - a.count || a.card.localeCompare(b.card));
    return cards;
  }

  /**
   * 選択中カードの「後継カード候補」を返す。
   *
   * カード更新・再発行で下4桁が変わると、Amazon 側の Payment Method Type だけが
   * 切り替わり、家計簿上は同じ口座のまま。下4桁1つで絞ると切替以降が丸ごと
   * 落ちるため、「選択カードが使われなくなった後に使われ始めたカード」を
   * 候補として提示する(利用期間が重なるカードは別物なので除外)。
   */
  function suggestSuccessors(cards, selectedCards) {
    const selected = new Set(selectedCards || []);
    const picked = (cards || []).filter((c) => selected.has(c.card) && c.lastDate);
    if (picked.length === 0) return [];
    const lastUsed = picked.reduce((a, c) => (c.lastDate > a ? c.lastDate : a), '');
    return (cards || []).filter(
      (c) => !selected.has(c.card) && c.firstDate && c.firstDate > lastUsed
    );
  }

  /** 出力行 → {min, max} の計上日レンジ(空なら両方 '')。日付昇順前提ではなく走査する。 */
  function dateRange(rows) {
    let min = '';
    let max = '';
    for (const r of rows || []) {
      const d = String(r[0] || '');
      if (!d) continue;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    }
    return { min, max };
  }

  /** 出力行 → [{month:'YYYY-MM', count, total}] を日付昇順で。 */
  function listMonths(rows) {
    const acc = new Map();
    for (const r of rows || []) {
      const month = String(r[0] || '').slice(0, 7);
      if (!month) continue;
      const e = acc.get(month) || { month, count: 0, total: 0 };
      e.count += 1;
      e.total += Number(r[COL.amount]) || 0;
      acc.set(month, e);
    }
    return [...acc.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  }

  // ---------------------------------------------------------------- 変換本体

  /**
   * 返金を該当注文へ充当する(発送日が新しい順 → 金額が大きい順に、0円になるまで)。
   *
   * 1グループから全額引くと、商品ごとに行を分けたときに 1商品の額を超える返金が
   * その行だけにぶつかり、**その行が実質マイナスで丸ごと落ちて、同じ注文の他の行が
   * 返金前の金額のまま残る**(= 過大計上)。使い切れなかった分は握り潰さず注記に出す。
   *
   * @returns {Map<string, Array<Object>>} 注文ID → グループ配列(呼び出し側でも使う)
   */
  function applyRefunds(groups, refunds, notes) {
    const groupsOfOrder = new Map(); // oid → [group]
    for (const g of groups.values()) {
      if (!groupsOfOrder.has(g.oid)) groupsOfOrder.set(g.oid, []);
      groupsOfOrder.get(g.oid).push(g);
    }
    for (const [oid, refundAmt] of Object.entries(refunds)) {
      const list = groupsOfOrder.get(oid);
      if (!list || refundAmt <= 0) continue;
      const order = list
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.amount - a.amount));
      let remaining = refundAmt;
      for (const g of order) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, g.amount);
        if (take <= 0) continue;
        g.amount -= take;
        g.refund = (g.refund || 0) + take;
        remaining -= take;
        notes.push(`返金反映: ${g.date} -${take}円 (注文 ${oid}) → 実質 ${g.amount}円`, g.date);
      }
      if (remaining > 0) {
        notes.push(
          `返金${refundAmt}円のうち ${remaining}円は差し引く明細がありません(注文 ${oid})`,
          order.length > 0 ? order[0].date : ''
        );
      }
    }
    return groupsOfOrder;
  }

  /** 選択カード(下4桁)のいずれかを含むか。ギフト券併用表記も部分一致で拾う。 */
  function matchesCard(paymentMethodType, cards) {
    const pay = paymentMethodType || '';
    for (const c of cards) if (c && pay.includes(c)) return true;
    return false;
  }

  /** opt から実際に使うカード下4桁の配列を決める(cards 優先・空なら card)。 */
  function resolveCards(opt) {
    const list = Array.isArray(opt.cards) ? opt.cards.filter((c) => c) : [];
    return list.length > 0 ? list : [opt.card].filter((c) => c);
  }

  /** 計上日が [dateFrom, dateTo] に入るか。空文字は無制限。 */
  function inRange(date, from, to) {
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  }

  /**
   * 注文明細+返金 → Zaim 7列の出力行。amazon_to_zaim.py の convert() と等価。
   * @param {Array<Object>} orderRows  Order History.csv の行配列
   * @param {Array<Object>|Object} refundRows Refund Details.csv の行配列(または loadRefunds 済みマップ)
   * @param {Object} options {card|cards, category, subcategory, store, source, aggregate,
   *                          jst, dateSource, dateFrom, dateTo, amountOverrides}
   * @returns {{rows: string[][], notes: string[], warnings: Array<Object>,
   *            meta: Array<Object>, months: Array<Object>}}
   *   warnings: ギフト券併用注文(カード実請求額と差が出得るもの)の一覧
   *   meta    : rows と1:1で対応する付帯情報(グループキー・上書き有無・数量分割など)
   *   months  : 期間フィルタ前の全月サマリ(月次出力の選択肢生成用)
   */
  function convert(orderRows, refundRows, options) {
    const opt = Object.assign({}, DEFAULT_OPTIONS, options || {});
    const cards = resolveCards(opt);
    const overrides = opt.amountOverrides || {};
    const refunds = Array.isArray(refundRows) ? loadRefunds(refundRows) : refundRows || {};

    // 注記は計上日つきで貯め、最後に期間フィルタと同じ範囲へ絞る。
    // 月次で切り出したとき、他の月の返金・除外メモが混ざると読み手が混乱するため。
    const noteEntries = [];
    const notes = {
      push(text, date) {
        noteEntries.push({ text, date: date || '' });
      },
    };
    const collectNotes = () =>
      noteEntries
        .filter((n) => !n.date || inRange(n.date, opt.dateFrom, opt.dateTo))
        .map((n) => n.text);

    const entryDate = (r) =>
      opt.dateSource === 'order'
        ? formatDate(r['Order Date'] || r['Ship Date'] || '', opt.jst)
        : formatDate(r['Ship Date'] || r['Order Date'] || '', opt.jst);

    // 1) カード一致(部分一致: ギフト券併用も拾う)& 購入成立の明細だけ残す
    const picked = [];
    for (const row of orderRows || []) {
      const pay = row['Payment Method Type'] || '';
      if (!matchesCard(pay, cards)) continue;
      const status = (row['Order Status'] || '').trim();
      if (NON_PURCHASE_STATUSES.has(status)) {
        notes.push(
          `除外(キャンセル): ${formatDate(row['Order Date'], opt.jst)} ` +
            `${(row['Product Name'] || '').slice(0, 30)}`,
          entryDate(row)
        );
        continue;
      }
      if (parseAmount(row['Total Amount']) === null) {
        notes.push(
          `除外(金額不正): ${JSON.stringify(row['Total Amount'])} ` +
            `${(row['Product Name'] || '').slice(0, 30)}`,
          entryDate(row)
        );
        continue;
      }
      picked.push(row);
    }

    if (!opt.aggregate) {
      // 旧挙動: 明細 1 行 = 1 エントリ(返金は無視)
      //
      // meta.key は「出力する行を選ぶ」機能の識別子なので、**1行ごとに一意**でなければ
      // ならない。同一注文・同一日の明細が複数あるため、連番まで含めてキーにする。
      const seq = new Map(); // "<注文ID>\t<計上日>" → その組で何件目か
      const built = picked.map((r) => {
        const oid = r['Order ID'] || '';
        const date = entryDate(r);
        const name = (r['Product Name'] || '').trim();
        const amount = parseAmount(r['Total Amount']);
        const base = `${oid}\t${date}`;
        const n = (seq.get(base) || 0) + 1;
        seq.set(base, n);
        return {
          row: zaimRow({
            date,
            memo: buildMemo([name], { oid, memo: opt.memo }),
            item: itemLabel([name]),
            amount,
            opt,
          }),
          meta: { key: `${base}\t#${n}`, oid, date, amount, names: name },
        };
      });
      built.sort((a, b) => (a.row[0] < b.row[0] ? -1 : a.row[0] > b.row[0] ? 1 : 0));
      const allRows = built.map((b) => b.row);
      const months = listMonths(allRows);
      const range = dateRange(allRows);
      const kept = built.filter((b) => inRange(b.row[0], opt.dateFrom, opt.dateTo));
      return {
        rows: kept.map((b) => b.row),
        notes: collectNotes(),
        warnings: [],
        unmatchedOverrides: [],
        meta: kept.map((b) => b.meta),
        months,
        range,
      };
    }

    // 2) 出荷単位 (Order ID × 発送日) でグループ化
    //    splitByItem のときは商品名もキーに足して「商品ごとに1行」にする。
    //    合算モードのキー形式は変えない(amountOverrides が "<注文ID>\t<計上日>" 前提)。
    const groups = new Map(); // key = oid + "\t" + date [+ "\t" + 商品名]
    for (const r of picked) {
      const oid = r['Order ID'] || '';
      const ship = entryDate(r);
      const key = opt.splitByItem
        ? `${oid}\t${ship}\t${(r['Product Name'] || '').trim()}`
        : `${oid}\t${ship}`;
      let g = groups.get(key);
      if (!g) {
        g = { oid, date: ship, amount: 0, names: [], gift: false, shipmentCount: 1, shipmentDates: [] };
        groups.set(key, g);
      }
      g.amount += parseAmount(r['Total Amount']) || 0;
      g.names.push(r['Product Name'] || '');
      if (/Gift/i.test(r['Payment Method Type'] || '')) g.gift = true;

      // 1明細が複数回に分けて出荷されると、Amazon は Ship Date を " and " で連結する。
      // カードは出荷ごとに請求が立つため、明細1件がカード側では複数件に分かれる。
      const shipValues = splitDateValues(
        opt.dateSource === 'order'
          ? r['Order Date'] || r['Ship Date']
          : r['Ship Date'] || r['Order Date']
      );
      if (shipValues.length > g.shipmentCount) {
        g.shipmentCount = shipValues.length;
        g.shipmentDates = [...new Set(shipValues.map((v) => formatDate(v, opt.jst)))];
      }
    }

    // 3) 返金を該当注文へ充当する(規則は applyRefunds 参照)
    const groupsOfOrder = applyRefunds(groups, refunds, notes);

    // 4) 実請求額の手動上書き(ギフト券併用など、CSV からは復元できない差額の補正)
    //
    // キーは "<OrderID>	<計上日>" だが、計上日は dateSource / jst 設定で変わる。
    // 設定を切り替えたとたんに補正が無言で外れると、ギフト券注文が総額のまま
    // CSV に出てしまうため、注文が1グループしか持たない場合は Order ID 単独の
    // キーも受け付ける(UI はこちらを使う)。どれにも当たらなかった上書きは
    // 握り潰さず、注記と unmatchedOverrides で必ず表に出す。
    const usedOverrideKeys = new Set();
    for (const [key, g] of groups) {
      const single = (groupsOfOrder.get(g.oid) || []).length === 1;
      let hit = null;
      if (Object.prototype.hasOwnProperty.call(overrides, key)) hit = key;
      else if (single && Object.prototype.hasOwnProperty.call(overrides, g.oid)) hit = g.oid;
      if (hit === null) continue;
      usedOverrideKeys.add(hit);
      const manual = parseAmount(overrides[hit]);
      if (manual === null || manual === g.amount) continue;
      notes.push(
        `金額を手動指定: ${g.date} ${g.amount}円 → ${manual}円 (注文 ${g.oid})`,
        g.date
      );
      g.overriddenFrom = g.amount;
      g.amount = manual;
    }
    const unmatchedOverrides = Object.keys(overrides).filter((k) => !usedOverrideKeys.has(k));
    for (const k of unmatchedOverrides) {
      notes.push(`手動指定した金額を適用できませんでした(該当する注文なし): ${k}`);
    }

    // 5) Zaim 行へ整形(実質0円以下は除外)・ギフト券併用は警告に積む
    const built = []; // {row, meta} を計上日でソートしてから期間で絞る
    const warnings = [];
    for (const [key, g] of groups) {
      if (g.amount <= 0) {
        notes.push(
          `除外(実質0円/全額返金): ${g.date} ${combineNames(g.names).slice(0, 30)}`,
          g.date
        );
        continue;
      }
      const names = combineNames(g.names);
      built.push({
        row: zaimRow({
          date: g.date,
          memo: buildMemo(g.names, {
            oid: g.oid,
            gift: g.gift,
            refund: g.refund || 0,
            shipmentCount: g.shipmentCount,
            overriddenFrom: g.overriddenFrom,
            memo: opt.memo,
          }),
          item: itemLabel(g.names),
          amount: g.amount,
          opt,
        }),
        meta: {
          key,
          oid: g.oid,
          date: g.date,
          amount: g.amount,
          names,
          gift: g.gift,
          splitShipment: g.shipmentCount > 1,
          shipmentCount: g.shipmentCount,
          refund: g.refund || 0,
          overriddenFrom: g.overriddenFrom === undefined ? null : g.overriddenFrom,
        },
      });
      if (g.shipmentCount > 1) {
        const multiDay =
          g.shipmentDates.length > 1
            ? ` ※出荷日が複数(${g.shipmentDates.join(', ')})あるため先頭日で計上`
            : '';
        notes.push(
          `${g.date} ${g.amount}円 は ${g.shipmentCount} 回に分けて出荷: ` +
            `カード明細では出荷ごとに分割計上されることがあります(合計は一致)${multiDay}`,
          g.date
        );
      }
      if (g.gift) {
        warnings.push({
          key,
          // 計上日が変わってもズレない上書きキー(1注文=1グループなら Order ID)
          overrideKey: (groupsOfOrder.get(g.oid) || []).length === 1 ? g.oid : key,
          date: g.date,
          amount: g.amount,
          rawAmount: g.overriddenFrom === undefined ? g.amount : g.overriddenFrom,
          names,
          reason:
            'ギフト券併用注文: カードの実請求額はこの金額より少ない可能性があります(内訳分離不能・総額計上)',
        });
      }
    }
    built.sort((a, b) => (a.row[0] < b.row[0] ? -1 : a.row[0] > b.row[0] ? 1 : 0));

    const allRows = built.map((b) => b.row);
    const months = listMonths(allRows);
    const range = dateRange(allRows); // 期間フィルタ前の全体レンジ(日付入力の初期値に使う)
    const kept = built.filter((b) => inRange(b.row[0], opt.dateFrom, opt.dateTo));
    // 警告も出力範囲に合わせる。月次で切り出しているのに他月のギフト券注文が
    // 並ぶと、対象外の注文へ実請求額を入力してしまう。
    const keptKeys = new Set(kept.map((b) => b.meta.key));
    return {
      rows: kept.map((b) => b.row),
      notes: collectNotes(),
      warnings: warnings.filter((w) => keptKeys.has(w.key)),
      meta: kept.map((b) => b.meta),
      months,
      range,
      unmatchedOverrides,
    };
  }

  /** 出力1行を ZAIM_HEADER の並びで組み立てる(列順の唯一の定義点)。 */
  function zaimRow({ date, memo, item, amount, opt }) {
    const row = [];
    row[COL.date] = date;
    row[COL.category] = opt.category;
    row[COL.subcategory] = opt.subcategory;
    row[COL.memo] = memo;
    row[COL.store] = opt.store;
    row[COL.source] = opt.source;
    row[COL.receiver] = ''; // 入金先は支出では使わないが、Zaim の設定画面と列番号を揃えるため残す
    row[COL.item] = item;
    row[COL.amount] = String(amount);
    return row;
  }

  /**
   * メモ欄。**Zaim の上限(100文字)を必ず守る**。
   *
   * 既定(notes)は注記と注文IDだけ。商品名は品目欄が持つようになったので外してある。
   * 注記を残すのは、あとからカード明細と突合するときに要るため:
   *   返金/ギフト券/複数出荷 = 注文額とカード請求額が違う理由、注文ID = Amazon 側を引くキー。
   *
   * full のときは **注記を先に確保してから残り枠に商品名を入れる**。商品名を先に詰めると
   * 注記が末尾から押し出されて静かに消え、金額のズレに気付けなくなる。
   */
  function buildMemo(names, info) {
    const mode = MEMO_MODES.includes(info.memo) ? info.memo : 'notes';
    if (mode === 'none') return '';

    const notes = [];
    if (info.refund) notes.push(`返金${info.refund}円を差引済み`);
    if (info.overriddenFrom !== undefined && info.overriddenFrom !== null) {
      notes.push(`注文総額${info.overriddenFrom}円→実請求額に補正`);
    } else if (info.gift) {
      notes.push('ギフト券併用のため実請求額と差がある可能性あり');
    }
    if (info.shipmentCount > 1) {
      notes.push(`${info.shipmentCount}回に分けて出荷(カード明細では分割計上のことあり)`);
    }
    if (info.oid) notes.push(`注文 ${info.oid}`);

    const tail = truncate(notes.filter((x) => x).join(MEMO_JOIN), FIELD_MAX_LEN);
    if (mode === 'notes') return tail;

    const used = tail ? Array.from(tail).length + MEMO_JOIN.length : 0;
    const budget = FIELD_MAX_LEN - used;
    const head = budget > 0 ? truncate(combineNames(names), budget) : '';
    return [head, tail].filter((x) => x).join(MEMO_JOIN);
  }

  /**
   * Zaim の「一般的な CSV ファイルをアップロードする」画面で選ぶ値を、
   * 実際の出力列から組み立てて返す。画面の項目と同じ並び・同じ文言。
   *
   * 列番号を人が数えると取り違える(実際に金額を1つ手前の列に指定していた)。
   * ZAIM_HEADER から機械的に導くことで、列を足しても案内がズレない。
   */
  function zaimImportSettings() {
    const at = (name) => {
      const i = ZAIM_HEADER.indexOf(name);
      return i < 0 ? '存在しない' : `${i + 1} 列目`;
    };
    return [
      { label: '日付の列', value: at('日付'), required: true },
      { label: 'カテゴリの列', value: at('カテゴリ') },
      { label: 'カテゴリ内訳の列', value: at('カテゴリの内訳') },
      { label: 'メモの列', value: at('メモ') },
      { label: 'お店の列', value: at('お店') },
      { label: '支払元の列', value: at('支払元') },
      { label: '入金先の列', value: at('入金先') },
      { label: '品目の列', value: at('品目') },
      { label: '支出の金額の列', value: at('支出金額'), required: true },
      { label: '収入の金額の列', value: '存在しない' },
      { label: '振替の金額の列', value: '存在しない' },
      { label: '振替か判別する列', value: '存在しない' },
      { label: '集計の設定の列', value: '存在しない' },
      { label: '金額表示', value: '支出の金額にマイナスがついていない' },
      { label: 'タイトル', value: '1 行目はタイトルなのでアップロード対象から除く' },
      { label: '区切り文字', value: 'カンマ' },
    ];
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
    for (const r of list) total += Number(r[COL.amount]) || 0;
    return {
      count: list.length,
      total,
      minDate: list.length ? list[0][0] : '',
      maxDate: list.length ? list[list.length - 1][0] : '',
    };
  }

  const api = {
    ZAIM_HEADER,
    COL,
    DEFAULT_OPTIONS,
    FIELD_MAX_LEN,
    ITEM_FIELD_MAX,
    MEMO_MODES,
    SUBCATEGORY_CHOICES,
    parseAmount,
    formatDate,
    splitDateValues,
    parseCsv,
    combineNames,
    truncate,
    shortenName,
    itemLabel,
    loadRefunds,
    detectCards,
    suggestSuccessors,
    listMonths,
    dateRange,
    convert,
    generateCsv,
    summarize,
    zaimImportSettings,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.ZaimCore = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
