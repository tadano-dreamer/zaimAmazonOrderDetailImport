/**
 * ui.js ― DOM 操作・イベント処理(変換ロジックは core.js に委譲)
 *
 * 流れ: ZIP選択 → JSZipで対象2CSVのみ抽出 → カード自動検出 → 設定変更のたびに
 *       即時プレビュー再生成 → ダウンロード / 共有(iOS向け) / コピー。
 * すべてブラウザ内で完結し、ネットワーク送信は行わない。
 */
(function () {
  'use strict';

  const Core = window.ZaimCore;

  const $ = (id) => document.getElementById(id);
  const el = {
    zipInput: $('zip-input'),
    pickerLabel: $('file-picker-label'),
    loadStatus: $('load-status'),
    loadError: $('load-error'),
    settings: $('settings-section'),
    cardList: $('card-list'),
    cardSwitchNote: $('card-switch-note'),
    periodSelect: $('period-select'),
    periodScope: $('period-scope'),
    category: $('opt-category'),
    subcategory: $('opt-subcategory'),
    store: $('opt-store'),
    source: $('opt-source'),
    result: $('result-section'),
    sumCount: $('sum-count'),
    sumTotal: $('sum-total'),
    sumRange: $('sum-range'),
    giftWarnings: $('gift-warnings'),
    notesBox: $('notes-box'),
    notesSummary: $('notes-summary'),
    notesList: $('notes-list'),
    emptyResult: $('empty-result'),
    tableWrap: $('table-wrap'),
    previewBody: $('preview-body'),
    btnDownload: $('btn-download'),
    btnShare: $('btn-share'),
    btnCopy: $('btn-copy'),
    actionStatus: $('action-status'),
  };

  const state = {
    orderRows: null,
    refundRows: [],
    csvText: '',
    fileName: 'zaim_import.csv',
    cards: [], // detectCards の結果
    selectedCards: [], // 選択中のカード下4桁(複数可)
    period: 'all', // 'all' | 'YYYY-MM'
    overrides: {}, // 上書きキー(通常は Order ID) → 実請求額(ギフト券併用等の手動補正)
  };

  const IS_IOS =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // ------------------------------------------------------------ ユーティリティ

  function showError(message) {
    el.loadError.textContent = message;
    el.loadError.hidden = false;
    el.loadStatus.textContent = '';
  }

  function clearError() {
    el.loadError.hidden = true;
    el.loadError.textContent = '';
  }

  function setStatus(message) {
    el.loadStatus.textContent = message;
  }

  function setActionStatus(message) {
    el.actionStatus.textContent = message;
    if (message) {
      clearTimeout(setActionStatus._t);
      setActionStatus._t = setTimeout(() => {
        el.actionStatus.textContent = '';
      }, 4000);
    }
  }

  function formatYen(n) {
    return `${Number(n).toLocaleString('ja-JP')}円`;
  }

  // ------------------------------------------------------------ ZIP 読み込み

  async function handleZip(file) {
    clearError();
    state.orderRows = null;
    state.refundRows = [];
    el.settings.hidden = true;
    el.result.hidden = true;

    if (!file) return;
    el.pickerLabel.textContent = file.name;
    setStatus(`読み込み中… (${(file.size / 1024 / 1024).toFixed(1)} MB)`);

    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch (e) {
      console.error('ZIP 解凍失敗:', e);
      showError(
        'ZIPファイルを読み込めませんでした。Amazonからダウンロードした「Your Orders.zip」をそのまま選択してください。'
      );
      return;
    }

    // フォルダ構成の揺れに備えてパス末尾で検索(大量のPDFは触らない)。
    // 分割エクスポート等で同名CSVが複数あり得るため、全件を返す。
    const findEntries = (suffix) => {
      const hits = [];
      zip.forEach((path, entry) => {
        if (!entry.dir && path.endsWith(suffix)) hits.push({ path, entry });
      });
      hits.sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
      return hits;
    };

    // 複数ファイルは統合して読む。完全同一内容の重複コピーだけはスキップ(二重計上防止)。
    const readAllRows = async (entries) => {
      const seenTexts = new Set();
      const rows = [];
      for (const { entry } of entries) {
        const text = await entry.async('string');
        if (seenTexts.has(text)) continue;
        seenTexts.add(text);
        rows.push(...Core.parseCsv(text));
      }
      return rows;
    };

    const orderEntries = findEntries('Order History.csv');
    if (orderEntries.length === 0) {
      showError(
        'ZIP内に「Order History.csv」が見つかりませんでした。注文履歴(Your Orders)を含むZIPか確認してください。'
      );
      return;
    }
    const refundEntries = findEntries('Refund Details.csv'); // 無くても動く

    try {
      setStatus('注文履歴を解析中…');
      state.orderRows = await readAllRows(orderEntries);
      state.refundRows = await readAllRows(refundEntries);
    } catch (e) {
      console.error('CSV 解析失敗:', e);
      showError('CSVの解析に失敗しました。ZIPが壊れていないか確認してください。');
      return;
    }
    const multiNote =
      orderEntries.length > 1 || refundEntries.length > 1
        ? ` ※同名CSVを統合(注文履歴 ${orderEntries.length} / 返金 ${refundEntries.length} ファイル)`
        : '';

    const cards = Core.detectCards(state.orderRows);
    if (cards.length === 0) {
      showError(
        'カード情報(Payment Method Type)が見つかりませんでした。注文履歴が空でないか確認してください。'
      );
      return;
    }

    state.cards = cards;
    state.selectedCards = [cards[0].card]; // 既定は最多利用カード
    state.period = 'all';
    state.overrides = {};
    renderCardList();

    setStatus(
      `読み込み完了: 明細 ${state.orderRows.length} 件 / 返金 ${state.refundRows.length} 件 / カード ${cards.length} 種${multiNote}`
    );
    el.settings.hidden = false;
    el.result.hidden = false;
    render();
  }

  // ------------------------------------------------------- カード選択(複数可)

  /** 検出カードをチェックボックスで一覧表示。利用期間も出して切替に気付けるようにする。 */
  function renderCardList() {
    el.cardList.replaceChildren(
      ...state.cards.map((c) => {
        const label = document.createElement('label');
        label.className = 'card-item';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = c.card;
        box.checked = state.selectedCards.includes(c.card);
        box.addEventListener('change', () => {
          state.selectedCards = state.selectedCards.filter((x) => x !== c.card);
          if (box.checked) state.selectedCards.push(c.card);
          renderCardSwitchNote();
          render();
        });
        const text = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = `${c.brand} - ${c.card}`;
        const sub = document.createElement('small');
        sub.textContent =
          c.firstDate && c.lastDate
            ? `${c.count}件 / ${c.firstDate} 〜 ${c.lastDate}`
            : `${c.count}件`;
        text.append(name, sub);
        label.append(box, text);
        return label;
      })
    );
    renderCardSwitchNote();
  }

  /**
   * 選択カードが使われなくなった後に始まったカードを「更新後の番号かもしれない」
   * として提示する。ここを見落とすと切替以降が丸ごと欠落する(実データで発生済み)。
   */
  function renderCardSwitchNote() {
    const successors = Core.suggestSuccessors(state.cards, state.selectedCards);
    if (successors.length === 0) {
      el.cardSwitchNote.hidden = true;
      el.cardSwitchNote.replaceChildren();
      return;
    }
    const selected = state.cards.filter((c) => state.selectedCards.includes(c.card));
    const lastUsed = selected.reduce((a, c) => (c.lastDate > a ? c.lastDate : a), '');
    el.cardSwitchNote.replaceChildren();
    const head = document.createElement('strong');
    head.textContent = '⚠️ カードが切り替わっている可能性があります';
    const p = document.createElement('p');
    p.style.margin = '4px 0 0';
    p.textContent =
      `選択中のカードは ${lastUsed} を最後に使われていません。その後に ` +
      successors.map((c) => `${c.brand} - ${c.card}(${c.firstDate}〜)`).join('、') +
      ' が使われています。同じカードの更新後の番号なら、こちらも選んでください。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.style.marginTop = '8px';
    btn.textContent = `＋ ${successors.map((c) => c.card).join('・')} も対象に追加`;
    btn.addEventListener('click', () => {
      for (const c of successors) {
        if (!state.selectedCards.includes(c.card)) state.selectedCards.push(c.card);
      }
      renderCardList();
      render();
    });
    el.cardSwitchNote.append(head, p, btn);
    el.cardSwitchNote.hidden = false;
  }

  // ------------------------------------------------------------- 期間フィルタ

  /** 'YYYY-MM' → その月の月初・月末('all' なら無制限)。 */
  function periodRange(period) {
    if (!period || period === 'all') return { dateFrom: '', dateTo: '' };
    const [y, m] = period.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { dateFrom: `${period}-01`, dateTo: `${period}-${String(lastDay).padStart(2, '0')}` };
  }

  /**
   * 月プルダウンを(選択肢が変わったときだけ)組み直す。
   *
   * 組み直しをスキップした場合でも、表示値と state は必ず最後に同期させる。
   * ここを早期 return の内側に置くと、同じ ZIP を選び直したときに
   * 「プルダウンは7月なのに出力は全期間」という状態になり、
   * 取込済みの月まで再出力して Zaim 側で重複計上する。
   */
  function renderPeriodOptions(months) {
    const signature = months.map((m) => `${m.month}:${m.count}:${m.total}`).join('|');
    if (el.periodSelect.dataset.signature !== signature) {
      el.periodSelect.dataset.signature = signature;
      const total = months.reduce((s, m) => s + m.count, 0);
      const opts = [{ value: 'all', text: `全期間(${total}件)` }].concat(
        months
          .slice()
          .reverse() // 新しい月を上に
          .map((m) => ({
            value: m.month,
            text: `${m.month.replace('-', '年')}月(${m.count}件 / ${Number(m.total).toLocaleString('ja-JP')}円)`,
          }))
      );
      el.periodSelect.replaceChildren(
        ...opts.map((o) => {
          const option = document.createElement('option');
          option.value = o.value;
          option.textContent = o.text;
          return option;
        })
      );
    }
    // 選択中の月が選択肢に無ければ全期間へ戻し、表示と state を常に一致させる
    const values = Array.from(el.periodSelect.options, (o) => o.value);
    if (!values.includes(state.period)) state.period = 'all';
    el.periodSelect.value = state.period;
  }

  // ------------------------------------------------------------ プレビュー生成

  function currentOptions() {
    const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
    const { dateFrom, dateTo } = periodRange(state.period);
    return {
      cards: state.selectedCards,
      card: state.selectedCards[0] || '',
      dateFrom,
      dateTo,
      amountOverrides: state.overrides,
      category: el.category.value.trim() || Core.DEFAULT_OPTIONS.category,
      subcategory: el.subcategory.value.trim(),
      store: el.store.value.trim(),
      source: el.source.value.trim(),
      aggregate: radio('aggregate') === 'on',
      jst: radio('tz') === 'jst',
      dateSource: radio('date-source'),
    };
  }

  function renderSummary(summary) {
    el.sumCount.textContent = `${summary.count}件`;
    el.sumTotal.textContent = formatYen(summary.total);
    el.sumRange.textContent = summary.count ? `${summary.minDate} 〜 ${summary.maxDate}` : '–';
  }

  /**
   * ギフト券併用注文の警告。ギフト券の充当額は Order History に載らないため
   * 総額で出るしかなく、カード実請求額とズレる(実データで 5,760円 vs 4,091円)。
   * 取込前に正しい額へ直せるよう、ここで実請求額を入力できるようにする。
   */
  function renderGiftWarnings(warnings) {
    if (warnings.length === 0) {
      el.giftWarnings.hidden = true;
      el.giftWarnings.replaceChildren();
      el.giftWarnings.dataset.signature = '';
      return;
    }
    // 入力のたびに DOM を作り直すとフォーカスが飛んで連続入力できなくなるので、
    // 対象の注文が変わっていないときは中身をそのまま残す(値はユーザーの入力が正)。
    const signature = warnings.map((w) => `${w.overrideKey}:${w.rawAmount}:${w.date}`).join('|');
    if (el.giftWarnings.dataset.signature === signature && !el.giftWarnings.hidden) return;
    el.giftWarnings.dataset.signature = signature;
    el.giftWarnings.replaceChildren();
    const head = document.createElement('strong');
    head.textContent = `⚠️ ギフト券併用の注文が ${warnings.length} 件あります`;
    const p = document.createElement('p');
    p.style.margin = '4px 0 0';
    p.textContent =
      'ギフト券の充当額は注文履歴に含まれないため、総額で計上されます。' +
      'カード明細の実請求額が分かる場合は、下の欄に入力すればその額で出力します。';
    el.giftWarnings.append(head, p);

    const ul = document.createElement('ul');
    ul.className = 'gift-list';
    for (const w of warnings) {
      const li = document.createElement('li');
      const desc = document.createElement('div');
      desc.textContent = `${w.date} ${w.names.slice(0, 40)}`;
      const row = document.createElement('div');
      row.className = 'gift-fix';
      const orig = document.createElement('span');
      orig.textContent = `注文総額 ${formatYen(w.rawAmount)} → 実請求額`;
      const input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'numeric';
      input.min = '0';
      input.step = '1';
      input.placeholder = String(w.rawAmount);
      input.setAttribute('aria-label', `${w.date} の実請求額`);
      const saved = state.overrides[w.overrideKey];
      if (saved !== undefined && saved !== null && saved !== '') input.value = saved;
      input.addEventListener('change', () => {
        const v = input.value.trim();
        if (v === '') delete state.overrides[w.overrideKey];
        else state.overrides[w.overrideKey] = Number(v);
        render();
      });
      const unit = document.createElement('span');
      unit.textContent = '円';
      row.append(orig, input, unit);
      li.append(desc, row);
      ul.appendChild(li);
    }
    el.giftWarnings.appendChild(ul);
    el.giftWarnings.hidden = false;
  }

  function renderNotes(notes) {
    if (notes.length > 0) {
      el.notesSummary.textContent = `処理メモ(${notes.length}件)`;
      el.notesList.replaceChildren(
        ...notes.map((n) => {
          const li = document.createElement('li');
          li.textContent = n;
          return li;
        })
      );
      el.notesBox.hidden = false;
    } else {
      el.notesBox.hidden = true;
    }
  }

  // プレビュー表(商品名はtextContentで挿入・XSS安全)
  function renderTable(rows, meta) {
    el.previewBody.replaceChildren(
      ...rows.map((r, i) => {
        const m = meta[i] || {};
        const tr = document.createElement('tr');
        if (m.gift) tr.classList.add('row-gift');
        if (m.splitShipment) tr.classList.add('row-split');
        const tdDate = document.createElement('td');
        tdDate.className = 'col-date';
        tdDate.textContent = r[0];
        const tdItem = document.createElement('td');
        tdItem.className = 'item-cell';
        const clamp = document.createElement('div');
        clamp.className = 'item-clamp';
        clamp.textContent = r[5];
        tdItem.title = r[5];
        tdItem.appendChild(clamp);
        const tdAmount = document.createElement('td');
        tdAmount.className = 'col-amount';
        tdAmount.textContent = Number(r[6]).toLocaleString('ja-JP');
        tr.append(tdDate, tdItem, tdAmount);
        return tr;
      })
    );
  }

  function render() {
    if (!state.orderRows) return;
    const opt = currentOptions();
    if (opt.cards.length === 0) {
      // カード未選択: 誤って全件出さないよう、空表示にして選択を促す
      state.csvText = '';
      renderSummary({ count: 0, total: 0, minDate: '', maxDate: '' });
      renderGiftWarnings([]);
      renderNotes([]);
      renderTable([], []);
      el.periodScope.textContent = '';
      el.emptyResult.textContent = 'カードが1つも選択されていません。上でカードを選んでください。';
      el.emptyResult.hidden = false;
      el.tableWrap.hidden = true;
      el.btnDownload.disabled = true;
      el.btnShare.disabled = true;
      el.btnCopy.disabled = true;
      return;
    }

    const { rows, notes, warnings, meta, months, unmatchedOverrides } = Core.convert(
      state.orderRows,
      state.refundRows,
      opt
    );
    // 対象カード・計上日の設定を変えて、入力済みの補正がどの注文にも当たらなくなった場合。
    // 黙って総額に戻ると気付けないため、その旨を明示する。
    if (unmatchedOverrides.length > 0) {
      setActionStatus(
        `入力済みの実請求額 ${unmatchedOverrides.length} 件は、現在の条件では適用されていません(処理メモを確認してください)。`
      );
    }
    renderPeriodOptions(months);

    state.csvText = Core.generateCsv(rows);
    const periodTag = state.period === 'all' ? 'all' : state.period;
    state.fileName = `zaim_import_${state.selectedCards.join('-')}_${periodTag}.csv`;

    renderSummary(Core.summarize(rows));
    renderGiftWarnings(warnings);
    renderNotes(notes);
    renderTable(rows, meta);

    const grand = months.reduce((s, m) => s + m.total, 0);
    const grandCount = months.reduce((s, m) => s + m.count, 0);
    el.periodScope.textContent =
      state.period === 'all'
        ? `対象カード ${state.selectedCards.join('・')} の全期間を出力します。`
        : `${state.period} 分のみを出力します(このカードの全期間は ${grandCount}件 / ${formatYen(grand)})。`;

    el.emptyResult.textContent =
      '条件に一致する明細がありませんでした。カードや期間の設定を確認してください。';
    const empty = rows.length === 0;
    el.emptyResult.hidden = !empty;
    el.tableWrap.hidden = empty;
    el.btnDownload.disabled = empty;
    el.btnShare.disabled = empty;
    el.btnCopy.disabled = empty;
  }

  // ------------------------------------------------------------ 保存3経路

  function csvBlob() {
    return new Blob([state.csvText], { type: 'text/csv;charset=utf-8' });
  }

  function download() {
    try {
      const url = URL.createObjectURL(csvBlob());
      const a = document.createElement('a');
      a.href = url;
      a.download = state.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setActionStatus(`${state.fileName} を保存しました`);
    } catch (e) {
      console.error('ダウンロード失敗:', e);
      setActionStatus('ダウンロードできませんでした。共有またはコピーをお試しください。');
    }
  }

  async function share() {
    const file = new File([csvBlob()], state.fileName, { type: 'text/csv' });
    try {
      await navigator.share({ files: [file], title: state.fileName });
      setActionStatus('共有シートを開きました');
    } catch (e) {
      if (e && e.name === 'AbortError') return; // ユーザーがキャンセル
      console.error('共有失敗:', e);
      setActionStatus('共有できませんでした。ダウンロードをお試しください。');
    }
  }

  async function copyCsv() {
    try {
      await navigator.clipboard.writeText(state.csvText);
      setActionStatus('CSVをクリップボードにコピーしました');
    } catch (e) {
      console.error('コピー失敗:', e);
      // フォールバック(古いWebView向け)
      const ta = document.createElement('textarea');
      ta.value = state.csvText;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      setActionStatus(ok ? 'CSVをコピーしました' : 'コピーできませんでした');
    }
  }

  // ------------------------------------------------------------ イベント配線

  el.zipInput.addEventListener('change', (e) => {
    handleZip(e.target.files && e.target.files[0]).catch((err) => {
      console.error('ZIP 処理で予期しないエラー:', err);
      showError('予期しないエラーが発生しました。ページを再読み込みして再度お試しください。');
    });
  });

  // カードのチェックボックスと期間プルダウンは動的生成側で個別に配線しているため、
  // ここでは固定のラジオ(計上日・まとめ方)だけをまとめて拾う。
  for (const input of document.querySelectorAll('#settings-section input[type="radio"]')) {
    input.addEventListener('change', render);
  }
  el.periodSelect.addEventListener('change', () => {
    state.period = el.periodSelect.value;
    render();
  });
  for (const id of ['opt-category', 'opt-subcategory', 'opt-store', 'opt-source']) {
    $(id).addEventListener('input', render);
  }

  el.btnDownload.addEventListener('click', download);
  el.btnCopy.addEventListener('click', () => {
    copyCsv();
  });

  // 共有ボタンは Web Share API(ファイル共有)対応時のみ表示。iOS では最有力の保存経路。
  const probeFile = new File(['x'], 'probe.csv', { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [probeFile] })) {
    el.btnShare.hidden = false;
    el.btnShare.addEventListener('click', () => {
      share();
    });
    if (IS_IOS) {
      // iPhone/iPad では共有シート経由の保存が最も確実なので先頭に出す
      el.btnShare.classList.add('btn-primary');
      el.btnDownload.classList.remove('btn-primary');
      el.btnShare.parentNode.insertBefore(el.btnShare, el.btnDownload);
    }
  }
})();
