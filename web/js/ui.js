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
    periodFrom: $('period-from'),
    periodTo: $('period-to'),
    periodScope: $('period-scope'),
    subcategoryChoices: $('subcategory-choices'),
    category: $('opt-category'),
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
    selectAll: $('select-all'),
    btnDownload: $('btn-download'),
    btnShare: $('btn-share'),
    btnCopy: $('btn-copy'),
    actionStatus: $('action-status'),
    importSection: $('import-section'),
    importSettings: $('import-settings'),
    btnCopySettings: $('btn-copy-settings'),
    settingsStatus: $('settings-status'),
  };

  const state = {
    orderRows: null,
    refundRows: [],
    csvText: '',
    fileName: 'zaim_import.csv',
    cards: [], // detectCards の結果
    selectedCards: [], // 選択中のカード下4桁(複数可)
    dateFrom: '', // 出力する計上日の下限('' = 制限なし)
    dateTo: '', //   同上限。プルダウンはこの2値を埋めるショートカット
    customPeriod: false, // 「日付で指定」を選んだ / 日付を直接編集した
    months: [], // 期間フィルタ前の月サマリ(プリセット生成用)
    fullRange: { min: '', max: '' }, // 期間フィルタ前の全体レンジ
    overrides: {}, // 上書きキー(通常は Order ID) → 実請求額(ギフト券併用等の手動補正)
    rows: [], // 直近の変換結果(選択の付け外しで使い回す)
    meta: [],
    // 出力しない行のキー。「選んだ行」ではなく「外した行」を覚えるのは、期間やカードを
    // 変えて行が増えたときに、新しい行が既定で出力対象になるようにするため。
    excluded: new Set(),
  };

  /**
   * 日付欄の編集に起因する再描画かどうか({source, isCommit} か null)。
   * 「いま打っている欄を書き換えない」「打った日付を勝手に全期間へ戻さない」の
   * 2つを、フォーカス状態に頼らず確実に判定するために持つ。
   */
  let dateEdit = null;

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
    el.importSection.hidden = true; // 読み込みに失敗したとき古い案内を残さない

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
    state.dateFrom = '';
    state.dateTo = '';
    state.customPeriod = false;
    state.overrides = {};
    state.excluded.clear(); // 別のデータなので、外した行の記憶は引き継がない
    renderCardList();

    setStatus(
      `読み込み完了: 明細 ${state.orderRows.length} 件 / 返金 ${state.refundRows.length} 件 / カード ${cards.length} 種${multiNote}`
    );
    el.settings.hidden = false;
    el.result.hidden = false;
    renderImportSettings();
    el.importSection.hidden = false;
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
  //
  // 真実の源は「開始日・終了日」の2つの日付。プルダウンは月をまとめて入れるための
  // ショートカットに過ぎない。こうすることで月次でも1日単位でも同じ仕組みで切り出せる。

  /** 'YYYY-MM' → その月の月初・月末。 */
  function monthRange(month) {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
  }

  /** 全期間(=データ全体を覆う指定)かどうか。 */
  function isFullRange() {
    const { min, max } = state.fullRange;
    if (!min || !max) return !state.dateFrom && !state.dateTo;
    return (
      (!state.dateFrom || state.dateFrom <= min) && (!state.dateTo || state.dateTo >= max)
    );
  }

  /**
   * 選択中の期間が、そのカードのデータと 1日も重ならないか。
   * カードを切り替えたときに起こる。0件のまま日付ピッカーもデータ範囲外を指す
   * 状態が残ると「このカードには何も無い」と誤読しかねないので、全期間へ戻す。
   */
  function isOutsideData(range) {
    if (!range.min || !range.max) return false;
    if (!state.dateFrom && !state.dateTo) return false;
    const from = state.dateFrom || range.min;
    const to = state.dateTo || range.max;
    return from > range.max || to < range.min;
  }

  /** 現在の日付指定に一致するプリセット値('all' / 'YYYY-MM' / 'custom')。 */
  function currentPreset() {
    // 「日付で指定」を選んだ状態は、たまたま全期間と同じ範囲でも維持する
    // (選んだ直後に 'all' へ巻き戻ると、選択操作が何も起きないように見える)
    if (state.customPeriod) return 'custom';
    if (isFullRange()) return 'all';
    for (const m of state.months) {
      const r = monthRange(m.month);
      if (state.dateFrom === r.from && state.dateTo === r.to) return m.month;
    }
    return 'custom';
  }

  /**
   * 期間プルダウンと日付入力を、現在の state に合わせて描画する。
   *
   * 組み直しをスキップした場合でも、表示値と state は必ず最後に同期させる。
   * ここを早期 return の内側に置くと、同じ ZIP を選び直したときに
   * 「プルダウンは7月なのに出力は全期間」という状態になり、
   * 取込済みの月まで再出力して Zaim 側で重複計上する。
   */
  function renderPeriodControls(months, range) {
    state.months = months;
    state.fullRange = range;

    const signature = months.map((m) => `${m.month}:${m.count}:${m.total}`).join('|');
    if (el.periodSelect.dataset.signature !== signature) {
      el.periodSelect.dataset.signature = signature;
      const total = months.reduce((s, m) => s + m.count, 0);
      const opts = [
        { value: 'all', text: `全期間(${total}件)` },
        ...months
          .slice()
          .reverse() // 新しい月を上に
          .map((m) => ({
            value: m.month,
            text: `${m.month.replace('-', '年')}月(${m.count}件 / ${Number(m.total).toLocaleString('ja-JP')}円)`,
          })),
        { value: 'custom', text: '日付で指定' },
      ];
      el.periodSelect.replaceChildren(
        ...opts.map((o) => {
          const option = document.createElement('option');
          option.value = o.value;
          option.textContent = o.text;
          return option;
        })
      );
    }

    // 空なら属性ごと外す。前のカードのレンジが残ると日付ピッカーが嘘をつく
    for (const input of [el.periodFrom, el.periodTo]) {
      input.min = range.min || '';
      input.max = range.max || '';
    }
    syncPeriodDisplay();
  }

  /**
   * 日付欄とプルダウンの表示を state に合わせる(空欄ならデータ全体の端を表示)。
   *
   * **編集中の欄には書き戻さない**。`<input type=date>` は年や日のセグメントを
   * 1つ消しただけでも value が "" になるため、打ち直している途中に書き戻すと
   * 入力がデータ先頭日へ飛ばされて操作を奪う。
   */
  function syncPeriodDisplay() {
    const range = state.fullRange;
    // 打鍵の途中(確定前)だけは、その欄への書き戻しを止める
    const editing = dateEdit && !dateEdit.isCommit ? dateEdit.source : null;
    if (editing !== el.periodFrom) {
      el.periodFrom.value = state.dateFrom || range.min || '';
    }
    if (editing !== el.periodTo) {
      el.periodTo.value = state.dateTo || range.max || '';
    }
    el.periodSelect.value = currentPreset();
  }

  /** ファイル名に入れる期間タグ。全期間=all / 月ぴったり=YYYY-MM / それ以外=from_to。 */
  function periodTag() {
    const preset = currentPreset();
    if (preset !== 'custom') return preset;
    const from = el.periodFrom.value || 'start';
    const to = el.periodTo.value || 'end';
    return from === to ? from : `${from}_${to}`;
  }

  function onPresetChange() {
    const v = el.periodSelect.value;
    state.customPeriod = v === 'custom';
    if (v === 'all') {
      state.dateFrom = '';
      state.dateTo = '';
    } else if (v !== 'custom') {
      const r = monthRange(v);
      state.dateFrom = r.from;
      state.dateTo = r.to;
    }
    render();
    // 'custom' は範囲を変えない。何を操作すればよいか分かるよう開始日へ寄せる
    if (v === 'custom') el.periodFrom.focus();
  }

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;


  /**
   * 日付入力の反映。
   *
   * `change` だけに頼らない: WebKit(iOS Safari を含む)では日付欄の change が
   * 発火しないことがあり、入力したのに出力範囲が変わらない状態になる。
   * `input` も拾い、値が空か完全な YYYY-MM-DD のときだけ反映する
   * (入力途中の "2026-07-2" のような値で再計算しないため)。
   *
   * **触っていない側は state を書き換えない**。日付欄は未指定のときデータ全体の
   * 端を「表示上の初期値」として出しているだけで、それを確定させてしまうと、
   * 後からカードを足したときにその日付より前の明細が無警告で落ちる
   * (7474 だけ選んで終了日を直すと、開始日が 7474 の初回利用日で固定され、
   *  あとから 5171 を足しても 5171 の古い明細が出てこない)。
   */
  function onDateInputChange(source, isCommit) {
    const raw = source.value;
    if (raw !== '' && !ISO_DATE.test(raw)) return;
    // 入力途中は value が "" になる(年だけ消した等)。確定(change/blur)まで
    // 「クリアした」とは解釈しない。ここで反映すると打鍵のたびに全期間へ戻る。
    if (raw === '' && !isCommit) return;

    let from = source === el.periodFrom ? raw : state.dateFrom;
    let to = source === el.periodTo ? raw : state.dateTo;

    // 開始 > 終了 になる入力だけは、触った側を優先してもう一方を寄せる。
    // ここで未指定側が確定するが、その結果は日付欄にそのまま出るので黙って消えない。
    const shownFrom = from || el.periodFrom.value;
    const shownTo = to || el.periodTo.value;
    if (shownFrom && shownTo && shownFrom > shownTo) {
      if (source === el.periodFrom) to = shownFrom;
      else from = shownTo;
    }

    state.customPeriod = true;
    if (from === state.dateFrom && to === state.dateTo) {
      if (isCommit) syncPeriodDisplay(); // 入力途中で空になった表示を戻す
      else el.periodSelect.value = currentPreset();
      return;
    }
    state.dateFrom = from;
    state.dateTo = to;
    dateEdit = { source, isCommit: Boolean(isCommit) };
    try {
      render();
    } finally {
      dateEdit = null;
    }
  }

  // ------------------------------------------------------------ プレビュー生成

  /** 選択中のラジオ値(未生成・未選択でも既定値で必ず答える)。 */
  function radio(name, fallback) {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    return checked ? checked.value : fallback;
  }

  function currentOptions() {
    // まとめ方は3択。合算(既定) / 商品ごとに1行 / 明細ごと
    const grouping = radio('grouping', 'shipment');
    return {
      cards: state.selectedCards,
      card: state.selectedCards[0] || '',
      dateFrom: state.dateFrom,
      dateTo: state.dateTo,
      amountOverrides: state.overrides,
      category: el.category.value.trim() || Core.DEFAULT_OPTIONS.category,
      subcategory: radio('subcategory', Core.SUBCATEGORY_CHOICES[0].value),
      store: el.store.value.trim(),
      source: el.source.value.trim(),
      aggregate: grouping !== 'detail',
      splitByItem: grouping === 'item',
      memo: radio('memo', Core.DEFAULT_OPTIONS.memo),
      jst: radio('tz', 'jst') === 'jst',
      dateSource: radio('date-source', 'ship'),
    };
  }

  /**
   * カテゴリの内訳のラジオ。選択肢は core の SUBCATEGORY_CHOICES が唯一の定義点。
   * 自由入力にすると打ち間違いがそのまま新しい内訳として Zaim 側に増える。
   */
  function renderSubcategoryChoices() {
    el.subcategoryChoices.replaceChildren(
      ...Core.SUBCATEGORY_CHOICES.map((choice, i) => {
        const label = document.createElement('label');
        label.className = 'radio-chip';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'subcategory';
        input.value = choice.value;
        input.checked = i === 0;
        input.addEventListener('change', render);
        const span = document.createElement('span');
        span.textContent = choice.value;
        label.append(input, span);
        return label;
      })
    );
  }

  /** 件数チップは「選択中の件数」。一部だけ外しているときだけ全体件数も出す。 */
  function renderSummary(summary, totalCount) {
    const total = totalCount === undefined ? summary.count : totalCount;
    el.sumCount.textContent =
      summary.count === total ? `${summary.count}件` : `${summary.count}件(全${total}件中)`;
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

        // 出力する行の選択。セル全体を当たり判定にする(実機で押しにくいと使われない)
        const tdSelect = document.createElement('td');
        tdSelect.className = 'col-select';
        const pick = document.createElement('label');
        pick.className = 'row-select';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !state.excluded.has(m.key);
        box.setAttribute('aria-label', `${r[0]} ${r[Core.COL.item]} を出力する`);
        tr.classList.toggle('row-off', !box.checked);
        box.addEventListener('change', () => {
          if (box.checked) state.excluded.delete(m.key);
          else state.excluded.add(m.key);
          tr.classList.toggle('row-off', !box.checked);
          refreshSelection();
        });
        pick.appendChild(box);
        tdSelect.appendChild(pick);

        const tdDate = document.createElement('td');
        tdDate.className = 'col-date';
        tdDate.textContent = r[0];
        const tdItem = document.createElement('td');
        tdItem.className = 'item-cell';
        const clamp = document.createElement('div');
        clamp.className = 'item-clamp';
        clamp.textContent = r[Core.COL.item];
        tdItem.title = m.names || r[Core.COL.item];
        tdItem.appendChild(clamp);
        const tdAmount = document.createElement('td');
        tdAmount.className = 'col-amount';
        tdAmount.textContent = Number(r[Core.COL.amount]).toLocaleString('ja-JP');
        tr.append(tdSelect, tdDate, tdItem, tdAmount);
        return tr;
      })
    );
  }

  /**
   * 選択中の行から CSV・サマリ・ボタンの状態を作り直す。
   * 表そのものは組み直さない(チェックのたびに DOM を捨てるとフォーカスが飛ぶ)。
   */
  function refreshSelection() {
    const rows = state.rows;
    const meta = state.meta;
    const out = rows.filter((r, i) => !state.excluded.has((meta[i] || {}).key));

    state.csvText = Core.generateCsv(out);
    renderSummary(Core.summarize(out), rows.length);

    // 全選択チェックボックス: 全部選択 / 全部解除 / 一部だけ
    el.selectAll.checked = out.length > 0;
    el.selectAll.indeterminate = out.length > 0 && out.length < rows.length;

    const noneSelected = rows.length > 0 && out.length === 0;
    el.emptyResult.textContent = noneSelected
      ? '出力する行が選択されていません。表のチェックを付け直してください。'
      : '条件に一致する明細がありませんでした。カードや期間の設定を確認してください。';
    el.emptyResult.hidden = !(rows.length === 0 || noneSelected);
    el.tableWrap.hidden = rows.length === 0;

    const nothingToSave = out.length === 0;
    el.btnDownload.disabled = nothingToSave;
    el.btnShare.disabled = nothingToSave;
    el.btnCopy.disabled = nothingToSave;
  }

  function render() {
    if (!state.orderRows) return;
    const opt = currentOptions();
    if (opt.cards.length === 0) {
      // カード未選択: 誤って全件出さないよう、空表示にして選択を促す
      state.csvText = '';
      state.rows = [];
      state.meta = [];
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

    let result = Core.convert(state.orderRows, state.refundRows, opt);
    // 自分で日付を打った結果が範囲外なら、それは意図した指定なので勝手に戻さない
    if (!dateEdit && isOutsideData(result.range)) {
      // 1回だけやり直す(全期間に戻せば必ずデータ範囲に収まるので再帰しない)
      state.dateFrom = '';
      state.dateTo = '';
      state.customPeriod = false;
      result = Core.convert(
        state.orderRows,
        state.refundRows,
        Object.assign({}, opt, { dateFrom: '', dateTo: '' })
      );
      setActionStatus('選択中の期間にこのカードの明細が無いため、全期間に戻しました。');
    }
    const { rows, notes, warnings, meta, months, range, unmatchedOverrides } = result;
    // 対象カード・計上日の設定を変えて、入力済みの補正がどの注文にも当たらなくなった場合。
    // 黙って総額に戻ると気付けないため、その旨を明示する。
    if (unmatchedOverrides.length > 0) {
      setActionStatus(
        `入力済みの実請求額 ${unmatchedOverrides.length} 件は、現在の条件では適用されていません(処理メモを確認してください)。`
      );
    }
    renderPeriodControls(months, range);

    // 取り込み先(内訳)をファイル名に入れておくと、二重取込の管理がしやすい
    const tag = (Core.SUBCATEGORY_CHOICES.find((c) => c.value === opt.subcategory) || {}).tag;
    state.fileName =
      `zaim_import_${state.selectedCards.join('-')}_${periodTag()}` +
      `${tag ? `_${tag}` : ''}.csv`;

    state.rows = rows;
    state.meta = meta;
    renderGiftWarnings(warnings);
    renderNotes(notes);
    renderTable(rows, meta);
    refreshSelection(); // CSV・サマリ・ボタンの状態は選択中の行から作る

    const grand = months.reduce((s, m) => s + m.total, 0);
    const grandCount = months.reduce((s, m) => s + m.count, 0);
    el.periodScope.textContent = isFullRange()
      ? `対象カード ${state.selectedCards.join('・')} の全期間を出力します。`
      : `${el.periodFrom.value} 〜 ${el.periodTo.value} 分のみを出力します` +
        `(このカードの全期間は ${grandCount}件 / ${formatYen(grand)})。`;
  }

  // ------------------------------------------------- Zaim の取込設定の案内

  /** 列番号は ZAIM_HEADER から機械的に導く(人が数えると取り違える)。 */
  function renderImportSettings() {
    el.importSettings.replaceChildren(
      ...Core.zaimImportSettings().flatMap((s) => {
        const dt = document.createElement('dt');
        dt.textContent = s.label;
        if (s.required) dt.className = 'is-required';
        const dd = document.createElement('dd');
        dd.textContent = s.value;
        if (/列目$/.test(s.value)) dd.className = 'is-column';
        return [dt, dd];
      })
    );
  }

  function importSettingsText() {
    return [
      'Zaim「一般的な CSV ファイルをアップロードする」の設定',
      ...Core.zaimImportSettings().map((s) => `${s.label}: ${s.value}`),
    ].join('\n');
  }

  async function copyImportSettings() {
    const text = importSettingsText();
    try {
      await navigator.clipboard.writeText(text);
      el.settingsStatus.textContent = '設定内容をコピーしました';
    } catch (e) {
      console.error('設定コピー失敗:', e);
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      el.settingsStatus.textContent = ok ? '設定内容をコピーしました' : 'コピーできませんでした';
    }
    clearTimeout(copyImportSettings._t);
    copyImportSettings._t = setTimeout(() => {
      el.settingsStatus.textContent = '';
    }, 4000);
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

  // 内訳のラジオは選択肢を core から作る(生成側で個別に配線している)
  renderSubcategoryChoices();

  // カードのチェックボックス・期間プルダウン・内訳ラジオは動的生成側で個別に配線して
  // いるため、ここでは固定のラジオ(計上日・まとめ方・メモ)だけをまとめて拾う。
  for (const input of document.querySelectorAll(
    '#settings-section input[type="radio"]:not([name="subcategory"])'
  )) {
    input.addEventListener('change', render);
  }

  // 全選択 / 全解除。表は組み直す(各行のチェックと打ち消し線を揃えるため)
  el.selectAll.addEventListener('change', () => {
    for (const m of state.meta) {
      if (el.selectAll.checked) state.excluded.delete(m.key);
      else state.excluded.add(m.key);
    }
    renderTable(state.rows, state.meta);
    refreshSelection();
  });
  el.periodSelect.addEventListener('change', onPresetChange);
  for (const input of [el.periodFrom, el.periodTo]) {
    // どちらを編集したかを渡す(触っていない側の表示値を確定させないため)
    input.addEventListener('blur', () => onDateInputChange(input, true)); // 離れた時点を確定とみなす
    input.addEventListener('change', () => onDateInputChange(input, true));
    input.addEventListener('input', () => onDateInputChange(input, false)); // WebKit で change が来ない対策
  }
  for (const id of ['opt-category', 'opt-store', 'opt-source']) {
    $(id).addEventListener('input', render);
  }

  el.btnDownload.addEventListener('click', download);
  el.btnCopySettings.addEventListener('click', () => {
    copyImportSettings();
  });
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
