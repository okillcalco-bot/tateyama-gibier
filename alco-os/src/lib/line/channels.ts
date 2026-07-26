import { env } from "@/lib/env";

/**
 * LINEチャネル定義。
 *
 * 1つの Webhook エンドポイント（/api/line）で複数のLINE公式アカウントを扱う。
 * 既存アカウントのIDやQRコードは変更しない（Webhook URL を向けるだけ）。
 *
 * チャネルの特定方法（重要）:
 *   destination は「署名検証を通ったボディ」の中にしか無い。
 *   したがって検証前の destination は信用せず、
 *   **登録済み全チャネルのシークレットで順に署名検証を試し、
 *   成功したチャネルを送信元として確定する**。
 *   → ルーティングに destination（Bot User ID）は不要。
 *
 * DBに保存する識別子（0023）:
 *   destination の生値ではなく、安定ラベル `ref`（channel:hunter 等）を使う。
 *   これにより LINE_HUNTER_CHANNEL_ID を設定していなくても全機能が動き、
 *   後から設定しても既存の紐付けが引けなくなることがない。
 *   channelId（destination）は任意。設定されていれば整合性チェックにだけ使う。
 */

export type LineChannelKey = "secretary" | "hunter";

export interface LineChannel {
  key: LineChannelKey;
  /** 画面・ログ表示用の日本語名 */
  label: string;
  /**
   * DB保存用の安定ラベル（channel:hunter / channel:secretary）。
   * 環境変数に依存しないため、設定変更で既存データが迷子にならない。
   */
  ref: string;
  /**
   * webhook の destination（Bot User ID）。**任意**。
   * 設定されていれば整合性チェックに使うだけで、ルーティングには使わない。
   */
  channelId: string;
  /** 署名検証用シークレット。ログ・画面へ出さないこと */
  secret: string;
  /** 返信・プッシュ送信用トークン。ログ・画面へ出さないこと */
  accessToken: string;
  /** 既存のGAS秘書システムへ webhook を転送するか */
  forwardToGas: boolean;
  /** 誰が返信するか。gas = GAS側が replyToken を使う（ALCO OSは返信しない） */
  replyBy: "gas" | "alco_os";
}

/** DB保存用の安定ラベル。環境変数から独立させるための唯一の生成点 */
export function channelRef(key: LineChannelKey): string {
  return `channel:${key}`;
}

/**
 * 環境変数から有効なチャネル一覧を組み立てる。
 * シークレット未設定のチャネルは「無効」として一覧に含めない。
 */
export function resolveLineChannels(): LineChannel[] {
  const channels: LineChannel[] = [];

  if (env.lineSecretaryChannelSecret) {
    channels.push({
      key: "secretary",
      label: "秘書チャネル",
      ref: channelRef("secretary"),
      channelId: env.lineSecretaryChannelId,
      secret: env.lineSecretaryChannelSecret,
      accessToken: env.lineSecretaryAccessToken,
      // 既存挙動の維持: GAS_WEBHOOK_URL があれば転送し、返信はGASに任せる
      forwardToGas: true,
      replyBy: env.gasWebhookUrl ? "gas" : "alco_os",
    });
  }

  if (env.lineHunterChannelSecret) {
    channels.push({
      key: "hunter",
      label: "捕獲者チャネル",
      ref: channelRef("hunter"),
      channelId: env.lineHunterChannelId,
      secret: env.lineHunterChannelSecret,
      accessToken: env.lineHunterAccessToken,
      // 捕獲者チャネルはGASへ転送しない。ALCO OS が受信も返信も行う
      forwardToGas: false,
      replyBy: "alco_os",
    });
  }

  return channels;
}

/** 秘密情報を含まない、ログ・デバッグ用の要約 */
export function describeChannels(channels: LineChannel[]): string[] {
  return channels.map((c) => `${c.key}(${c.channelId ? "id設定済" : "id未設定"})`);
}

export const CHANNEL_LABELS: Record<LineChannelKey, string> = {
  secretary: "秘書チャネル",
  hunter: "捕獲者チャネル",
};
