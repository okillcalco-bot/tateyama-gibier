# 04 接続手順と OpenAI 公式仕様への対応

## 公式仕様（2026-10-03 に developers.openai.com の .md 版を読取り）と、この実装の対応
| 公式の要求 | この実装 | 実機で確認済みか |
|---|---|---|
| Streamable HTTP（`/mcp`） | POST `/mcp` に JSON で応答（SSE 不使用）。initialize / tools/list / tools/call / ping | ローカルのみ |
| 保護リソースメタデータ（RFC 9728）と 401 の `WWW-Authenticate: Bearer resource_metadata=…` | `/.well-known/oauth-protected-resource`（関数パス配下）と 401 応答 | ローカルのみ |
| 認可サーバーのメタデータ・PKCE S256・DCR または CIMD | Supabase Auth OAuth 2.1 サーバー（`/.well-known/oauth-authorization-server/auth/v1`、PKCE、DCR） | **未確認**（CIMD・RFC 9207 の iss 返却に Supabase が対応しているかは未確認。非対応なら ChatGPT は callback-ID 付きリダイレクトURIと DCR を使う） |
| **`resource` をトークンの aud に入れ、MCP は aud を検証** | Supabase は `aud=authenticated` 固定。**`authenticated` を受け入れ、client_id の許可リストで絞る** | **未確認。公式要求からの逸脱**。代替: Auth0 等の resource 対応 IdP（費用あり）。判断が必要 |
| 署名・iss・aud・exp・scope を毎回検証 | 署名（RS256/ES256・JWKS）・iss・aud・exp/nbf/iat・最大寿命1時間・client_id・主体の登録/失効・スコープ（DB の principals） | ローカルのみ |
| ツールごとの `securitySchemes`、権限不足時 `_meta["mcp/www_authenticate"]` | 全ツール `oauth2`。スコープ不足は `insufficient_scope` の _meta 付き | ローカルのみ |
| 注釈（readOnlyHint / destructiveHint / openWorldHint） | 読取り3つ readOnly、書込み2つは非readOnly・非破壊・closed world | ローカルのみ |
| MCP Events（新着通知） | **第2段階。未実装** | — |

## 本人が行う接続手順（承認後）
1. 03 の A〜I を順に適用（B のロールにパスワードを付けるのは本人が SQL エディタで）。
2. Supabase ダッシュボード > Authentication > OAuth Server: 有効化・Authorization Path `/oauth-consent.html`・Dynamic Client Registration を有効化。
3. ChatGPT > 設定 > セキュリティとログイン > **開発者モード** を ON。
4. https://chatgpt.com/plugins で「＋」→ 名前「館山ジビエ受発注」・接続先 URL `https://clpdyrehdgzgiidbfucj.supabase.co/functions/v1/seamalt-mcp/mcp`。
5. 表示されたツールが5つであることを確認 → 認証で同意画面（oauth-consent.html）が開く → 本人のメールでログイン → 許可。
6. Supabase の OAuth クライアント一覧で ChatGPT のクライアントIDを確認し、`SEAMALT_CLIENT_IDS` に設定する（空のままだとクライアントでは絞らない。その間も principals に登録した本人以外は拒否される）。設定後は他のクライアントのトークンを拒否する。
7. シーモルトの会話で「O-DEMO-001 を検索して」（読取り）→ 架空注文の取込（03 の K）→ `orders_get` で再読確認。

## 公開ドキュメントと実接続の区別
- この文書の「対応」は**公開ドキュメントを読んだうえでの実装**であり、ChatGPT からの実際の接続（ツール発見・OAuth・読取り成功）は**未実施**。
- 未確認の主なリスク: (1) aud が resource でないトークンを ChatGPT/OpenAI 側がどう扱うか、(2) Supabase OAuth サーバー（ベータ）と ChatGPT の DCR の相性、(3) Edge Function から Supavisor への `npm:pg` 接続。
