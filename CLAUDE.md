## 横断タスク管理への報告（`TASKS.md`）

このプロジェクトは、横断タスク管理 manager（`tadano-dreamer/task-portfolio`）に
**リポジトリ直下の `TASKS.md` 1枚**で状況を報告する。

### セッションの始めにやること

1. manager からの依頼を読む。**ローカルを先に見て、無ければ GitHub を見る。**

   ```bash
   # ローカル
   cat "C:/Users/yusuk/Local_SelfStudy/タスク管理/yusukeTaskManagement/state/outbox/zaim-amazon-import.md"
   # クラウド（ローカルが無いとき）
   gh api repos/tadano-dreamer/task-portfolio/contents/state/outbox/zaim-amazon-import.md \
     --jq '.content' | base64 -d
   ```

   🔴 **どちらも読めなければ、黙って飛ばして作業を続ける。**
   outbox が読めないことでセッションを止めない。存在しないのが正常な状態。

2. 「完了依頼」があれば `TASKS.md` の `open_tasks` に反映する。
3. 対応したものを `manager_ack` に積む。**`id` だけでなく `effect` を必ず書く。**

   ```yaml
   manager_ack:
     - { id: m-20260913-01, effect: zaim-amazon-import-001 を open_tasks から削除 }
   ```

   `effect` は **manager 側が実際に照合できる事実**を書く。「対応しました」は不可。
   照合できないと manager は依頼を消さず、翌朝のブリーフに「未確認」として出す。

### セッションの終わりにやること

**タスクに変化があったら `TASKS.md` を更新し、`updated_at` を今の時刻にしてコミット・プッシュする。**

- **コミットしていない報告は、存在しないのと同じ。**
- 変化が無い日は更新しなくてよい。ただし長く止まると manager が「未報告」として拾う。
- 形式は `TASKS.md` の frontmatter に書いてある。**契約に無いキーを足すとパースが止まる**ので、
  足りない属性が出たら押し込まず manager に伝える。

### 🔴 やってはいけないこと

| | 代わりにどうするか |
|---|---|
| **manager のリポジトリに書き込む** | 報告は自分の `TASKS.md` にだけ書く。manager が読みに来る |
| `manager_ack` に `id` だけ書く | `effect`（観測可能な副作用）を必ず添える |
| `open_tasks` に全タスクを並べる | **20件以内。** 期限90日以内のものとブロッカーだけ。残りは元の台帳に置く |
| ゆるい期限を `due_kind: hard` にする | `approx` / `relative` を使う。毎朝鳴り続けると仕組みごと使われなくなる |
| タスクが無いのに `TASKS.md` を消す | `open_tasks: []` で残す。ファイルが消えると manager は「報告が壊れた」と判断する |
