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
| summarize_meeting | （プロンプト定義のみ。実装は次段） | meeting_minutes | - |

共有ボードのタグ付けは AI ではなく辞書ベース（domain/board/board-service の
TAG_RULES）。AI提案タグを足す場合も必ずドラフト承認フローを通すこと。

メディア系は「添付した素材ファイル名以外の割付」をスキーマ検証
（superRefine）で保存前に拒否する（nature_report の証跡実在チェックと同じ方式）。

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

- ai_runs.input_summary には個人情報の生データを入れない（要約のみ）
- 顧客実名・財務実数を含む本番データをAIに渡す運用を始める前に、
  利用するAPIプランのデータ保持ポリシーを確認する
- 設計・検証段階はダミーデータ（seed.sql）で行う
