# 05. AIワークフロー

## 全体像

```
ワークフロー呼び出し（server action / domain）
  → ai/model-router.ts     どのプロバイダ・モデル・パラメータを使うか解決
  → ai/providers/*         API呼び出し（Anthropic / mock）
  → run-workflow.ts        共通ランナー:
       1. provider.complete()
       2. 出力を Zod でバリデーション（失敗も ai_runs に記録）
       3. ai_runs に実行ログ insert
       4. generated_drafts に draft として保存
  → 人間承認（/drafts） → domain/drafts/draft-service で業務反映
```

## 実装済みワークフロー

| ワークフロー | 入力 | 出力（draft_type） | 反映先（承認後） |
|---|---|---|---|
| classify_voice_memo | メモ原文・種別 | voice_memo_result | tasks + voice_memos.status |
| generate_grant_draft | 補助金名・要領原文・事実・経費 | grant_application | grant_documents |
| generate_nature_report | サイト・観察・管理作業（実データ） | nature_report | （承認のみ。文書化は将来） |
| generate_presentation | メディアブリーフ（ターゲット・時間・型・伝えたいこと・元資料・写真名） | presentation_outline | media_projects.approved_content（→ PPTXダウンロード） |
| generate_video_plan | 同上（動画向け） | video_plan | media_projects.approved_content（台本・メタデータ確定） |
| generate_social_posts | 一次データ（メモ/FB/文字起こし）+ 対象チャンネル | social_posts | social_projects.approved_content（HP/Instagram/FB/YouTube別原稿） |
| generate_advisor_brief | 士業相談（分野+相談文） | advisor_brief | advisor_consultations.approved_content（論点整理・専門家への質問リスト。**法的助言ではない**） |
| parse_field_note | 現場メモ（音声文字起こし・走り書き） | field_note_result | （承認のみ。観察記録の確定は人が /nature/quick で行う）**種を確定しない・危険語はサーバー側でも保護側に倒す** — docs/10 |
| classify_hunter_message | 捕獲者からのLINE本文（+ 照合済み氏名・位置情報の有無） | hunter_message_result | tasks + line_inbound_messages.status + capture_reports.ai_suggestion（**候補のみ。individuals / hunters には書き込まない**）|
| analyze_crosspost_source | FB投稿の原文 | crosspost_fact_sheet | social_sources.fact_sheet（事実・数値・引用を1回だけ固定）|
| generate_crosspost_drafts | 事実シート + 媒体2〜3件 + スタイル設定 | crosspost_ai_output | social_channel_drafts.ai_body（**承認対象ではない**。再生成すると置き換わるが、過去のAI出力は generated_drafts に残る）|
| （承認時に生成） | 人が編集した本文のスナップショット | crosspost_approval | social_channel_drafts.approved_body |
| summarize_meeting | （プロンプト定義のみ。実装は次段） | meeting_minutes | - |

FB横展開（0029）は AI を2段階で呼ぶ。事実整理を1回だけ実行して媒体間で数値がぶれないようにし、
媒体別の生成は2〜3件ずつのバッチに分ける。**1バッチが失敗しても成功した媒体は残り**、
失敗した媒体だけ作り直せる。文字数が上限を超えても生成全体は失敗させず、その媒体だけ要確認にする。
センシティブ判定は `domain/social/crosspost/sensitive.ts` の辞書が最終権限で、
AIが「問題なし」と言っても辞書に当たれば要確認になる。

**Crosspostの承認は `alco_crosspost_approve()` を唯一の本番承認経路とする。**
これは運用上の約束ではなく **DB側で強制**している。承認関数は
`set_config('app.crosspost_approval_rpc', 'on', true)` でトランザクション内だけ
有効な印を立て、トリガーはこの印があるときしか `approved` への遷移・
`approved_body` の設定・`approval_draft_id` の設定を通さない。
owner/manager がテーブルを直接 UPDATE しても承認済みにはできない。
投稿済み（`published`）も同じ仕組みで
`alco_crosspost_record_publication()` の中だけに限っている。
`generated_drafts` への承認証跡、業務反映（`social_channel_drafts` の
`approved_body` / `approved_at` / `approved_by` / `approval_draft_id`）、監査ログを
**同一トランザクション**で記録する。同様に、投稿済みの登録は
`alco_crosspost_record_publication()` が唯一の本番経路で、投稿履歴・下書きの状態・
監査ログを同一トランザクションで記録する。

`draft-service.ts` / `publication-service.ts` の逐次処理は
**テスト用フォールバック**であり、`rpc` 引数を渡さなかった場合にだけ動く。
本番コード（`src/app/crosspost/actions.ts`）は常に `rpc` を渡すため、
**テスト用フォールバックは本番コードから呼べない**。

共有ボードのタグ付けは AI ではなく辞書ベース（domain/board/board-service の
TAG_RULES）。AI提案タグを足す場合も必ずドラフト承認フローを通すこと。

メディア系は「添付した素材ファイル名以外の割付」をスキーマ検証
（superRefine）で保存前に拒否する（nature_report の証跡実在チェックと同じ方式）。

classify_hunter_message はリッチメニューの5分類（捕獲報告 / 搬入連絡 /
受入状況 / 買取状況 / 使い方）+ その他。ただし**メニュー操作は文字列で
確実に振り分ける**（domain/hunters/hunter-keywords.ts）ため、AIが呼ばれるのは
メニュー語に当たらない自由文と、捕獲報告の会話中の本文だけ。
捕獲報告での出力は `capture_reports.ai_suggestion` に入る**候補**であり、
獣種・捕獲方法の確定は職員が /gibier/reports で行う。捕獲場所・わな・私有地などの語、または
位置情報メッセージが含まれる場合は、AIの判定に関わらずサーバー側で
`sensitivity_flag` を true に上書きする（parse_field_note と共通の
`detectSensitiveKeywords`）。捕獲者への返信文をAIが自動送信することはなく、
職員が /line で読んで編集したものだけを送る。

## ワークフローを追加する手順（Opus向けチェックリスト）

1. `ai/schemas/<name>.schema.ts` — 入力・出力の Zod スキーマ
2. `ai/prompts/<name>.prompt.ts` — システムプロンプト + PROMPT_VERSION
   - 必ず先頭に `[workflow:<name>]` マーカーを入れる（MockProvider が判別に使う）
3. `ai/model-router.ts` — WorkflowName に追加し、WORKFLOW_CONFIG に設定
4. `ai/workflows/<name>.ts` — runWorkflow() を呼ぶだけの薄い関数
5. `ai/providers/mock-provider.ts` — DEFAULT_RESPONSES にモック応答を追加
6. 反映が必要なら `domain/drafts/draft-service.ts` の applyDraft() に分岐追加
7. tests/ にスキーマ・ワークフロー・承認のテストを追加

## プロンプトの絶対ルール

- 事実・数字・引用・観察の捏造禁止を明文化する
- 不足情報は「missing_*」フィールドに列挙させる
- 出力はJSONのみ・日本語と指定する
- プロンプト変更時は PROMPT_VERSION を必ず上げる（ai_runs で追跡可能にする）

## モデル運用方針

- 骨格・設計・複雑な実装: Fable（高単価。ここぞの時だけ）
- 日常の機能追加・文言調整・保守: Opus（docs/07 参照）
- アプリ実行時のモデルは AI_DEFAULT_MODEL 環境変数 + model-router で管理。
  コード中へのモデル名ハードコード禁止。
- 分類系は小maxTokens、長文生成系は高maxTokens を WORKFLOW_CONFIG で使い分ける
  （temperature は最新モデルで廃止されたため送らない）。

## データ取り扱いの注意

- ai_runs.input_summary には個人情報の生データを入れない（要約のみ）。
  classify_hunter_message は本文・氏名・電話番号を入れず、文字数と
  位置情報の有無だけを記録する
- 顧客実名・財務実数を含む本番データをAIに渡す運用を始める前に、
  利用するAPIプランのデータ保持ポリシーを確認する
- 設計・検証段階はダミーデータ（seed.sql）で行う
