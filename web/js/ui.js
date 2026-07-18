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
    cardSelect: $('card-select'),
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

    el.cardSelect.replaceChildren(
      ...cards.map((c) => {
        const o = document.createElement('option');
        o.value = c.card;
        o.textContent = c.label;
        return o;
      })
    );

    setStatus(
      `読み込み完了: 明細 ${state.orderRows.length} 件 / 返金 ${state.refundRows.length} 件 / カード ${cards.length} 種${multiNote}`
    );
    el.settings.hidden = false;
    el.result.hidden = false;
    render();
  }

  // ------------------------------------------------------------ プレビュー生成

  function currentOptions() {
    const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
    return {
      card: el.cardSelect.value,
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

  function renderGiftWarnings(warnings) {
    if (warnings.length > 0) {
      el.giftWarnings.replaceChildren();
      const head = document.createElement('strong');
      head.textContent = `⚠️ ギフト券併用の注文が ${warnings.length} 件あります`;
      const p = document.createElement('p');
      p.style.margin = '4px 0 0';
      p.textContent =
        'カードの実請求額は表示金額より少ない可能性があります。Zaim取込後に手動で調整してください。';
      el.giftWarnings.append(head, p);
      const ul = document.createElement('ul');
      ul.style.margin = '6px 0 0';
      ul.style.paddingLeft = '18px';
      for (const w of warnings) {
        const li = document.createElement('li');
        li.textContent = `${w.date} ${formatYen(w.amount)} ${w.names.slice(0, 40)}`;
        ul.appendChild(li);
      }
      el.giftWarnings.appendChild(ul);
      el.giftWarnings.hidden = false;
    } else {
      el.giftWarnings.hidden = true;
    }
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
  function renderTable(rows, warnings) {
    const giftDates = new Set(warnings.map((w) => `${w.date}\t${w.amount}\t${w.names}`));
    el.previewBody.replaceChildren(
      ...rows.map((r) => {
        const tr = document.createElement('tr');
        if (giftDates.has(`${r[0]}\t${Number(r[6])}\t${r[5]}`)) tr.classList.add('row-gift');
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
    const { rows, notes, warnings } = Core.convert(state.orderRows, state.refundRows, opt);

    state.csvText = Core.generateCsv(rows);
    state.fileName = `zaim_import_${opt.card}.csv`;

    renderSummary(Core.summarize(rows));
    renderGiftWarnings(warnings);
    renderNotes(notes);
    renderTable(rows, warnings);

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

  for (const input of document.querySelectorAll(
    '#settings-section select, #settings-section input'
  )) {
    input.addEventListener('change', render);
  }
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
