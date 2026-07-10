#!/usr/bin/env node
/**
 * profile.json → dist/ 静的サイト生成。
 *
 * - 原本は profile.json のみ。HTML/CSSに固有の内容・ファイル名を直書きしない
 * - 画像は public/ から取り、sharp で幅1200px上限にリサイズ + WebP変換
 * - src が空 / ファイルが無い場合は警告して、その画像ブロックごと出力しない
 * - "_todo" で始まる文字列は「未記入」として扱い、公開ページには出さない
 * - 将来 ALCO OS を中枢DB化するときは loadProfile() の中身だけ差し替える
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DIST = path.join(ROOT, "dist");

/** 原本の読み込み口（将来ここを ALCO OS 参照に差し替える） */
function loadProfile() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "profile.json"), "utf-8"));
}

const warn = (msg) => console.warn(`⚠  ${msg}`);

const isTodo = (value) => typeof value === "string" && value.trim().startsWith("_todo");
/** _todo文字列は未記入扱いで空にする */
const clean = (value) => (isTodo(value) ? "" : (value ?? "").trim());
const cleanList = (list) => (list ?? []).map(clean).filter(Boolean);

const escapeHtml = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * 画像を処理して dist/assets へ。返り値は <img> に必要な情報。
 * 使えない画像（src空・ファイル無し・処理失敗）は null。
 */
async function processImage(image, { webp = true } = {}) {
  if (!image || !clean(image.src)) return null;
  const file = path.join(PUBLIC_DIR, image.src);
  if (!fs.existsSync(file)) {
    warn(`画像が見つかりません: public/${image.src} — このブロックは非表示にします`);
    return null;
  }
  if (!clean(image.alt)) {
    warn(`alt がありません: ${image.src} — alt は必須です（空のまま出力します）`);
  }
  try {
    const base = path.basename(image.src, path.extname(image.src));
    if (webp) {
      const out = `${base}.webp`;
      const info = await sharp(file)
        .rotate()
        .resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(path.join(DIST, "assets", out));
      return {
        src: `assets/${out}`,
        alt: clean(image.alt),
        caption: clean(image.caption),
        width: info.width,
        height: info.height,
      };
    }
    const out = path.basename(image.src);
    fs.copyFileSync(file, path.join(DIST, "assets", out));
    return { src: `assets/${out}`, alt: clean(image.alt), caption: clean(image.caption) };
  } catch (e) {
    warn(`画像処理に失敗: ${image.src}（${e.message}）— 非表示にします`);
    return null;
  }
}

/** OG画像。public/og.png があれば 1200x630 に整えて使う。無ければ仮画像を生成 */
async function buildOgImage(profile) {
  const src = clean(profile.images?.og?.src);
  const file = src ? path.join(PUBLIC_DIR, src) : null;
  const out = path.join(DIST, "og.png");
  if (file && fs.existsSync(file)) {
    await sharp(file)
      .resize(1200, 630, { fit: "cover" })
      .png()
      .toFile(out);
    return "og.png";
  }
  // 仮OG画像（実ファイルが用意されるまで。日本語フォントが無い環境でも
  // 崩れないよう、ローマ字表記のみで構成する）
  warn(`OG画像が無いため仮画像を生成します（public/${src || "og.png"} を置くと差し替わります）`);
  const roman = escapeHtml(profile.name_roman || "PROFILE");
  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b5e20"/><stop offset="1" stop-color="#33691e"/>
    </linearGradient></defs>
    <rect width="1200" height="630" fill="url(#g)"/>
    <rect x="40" y="40" width="1120" height="550" fill="none" stroke="#ffffff55" stroke-width="2"/>
    <text x="600" y="300" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
      font-size="88" font-weight="bold" fill="#ffffff" letter-spacing="14">${roman}</text>
    <text x="600" y="390" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
      font-size="34" fill="#d7e4d8" letter-spacing="8">LLC ALCO — TATEYAMA, CHIBA</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(out);
  return "og.png";
}

const imgTag = (img, className) =>
  img
    ? `<img class="${className}" src="${img.src}" alt="${escapeHtml(img.alt)}"` +
      (img.width ? ` width="${img.width}" height="${img.height}"` : "") +
      ` loading="lazy" decoding="async">` +
      (img.caption ? `\n<p class="figure-caption">${escapeHtml(img.caption)}</p>` : "")
    : "";

async function main() {
  const profile = loadProfile();

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });

  // ── 画像 ──
  const portrait = await processImage(profile.images?.portrait);
  const ogFile = await buildOgImage(profile);

  // ── 事業カード ──
  const cards = [];
  for (const biz of profile.businesses ?? []) {
    const img = await processImage(biz.image);
    const detail = clean(biz.detail);
    const url = clean(biz.url);
    cards.push(`<article class="biz-card">
  <button class="biz-toggle" type="button" aria-expanded="false">
    <h3>${escapeHtml(clean(biz.name))}</h3>
    <p class="one-liner">${escapeHtml(clean(biz.one_liner))}</p>
    <span class="chev" aria-hidden="true">＋</span>
  </button>
  <div class="biz-detail">
    ${imgTag(img, "biz-image")}
    ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
    ${url ? `<p class="biz-link"><a href="${escapeHtml(url)}" rel="noopener">詳しく見る →</a></p>` : ""}
  </div>
</article>`);
  }

  // ── 経歴 ──
  const career = (profile.career ?? [])
    .filter((c) => clean(c.label))
    .map(
      (c) =>
        `<li><span class="year">${escapeHtml(clean(c.year) || "—")}</span><span class="label">${escapeHtml(clean(c.label))}</span></li>`,
    )
    .join("\n");

  const liList = (items, emptyNote) => {
    const rows = cleanList(items);
    if (!rows.length) return `<li class="empty">${escapeHtml(emptyNote)}</li>`;
    return rows.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n");
  };

  // ── OGP ──
  const contact = profile.contact ?? {};
  const baseUrl = (
    clean(profile.site?.url) ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "")
  ).replace(/\/$/, "");
  const pageTitle = `${profile.name}｜${profile.title}`;
  const description = clean(profile.site?.description) || clean(profile.tagline);
  const ogTags = [
    `<meta property="og:type" content="profile">`,
    `<meta property="og:title" content="${escapeHtml(pageTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    baseUrl ? `<meta property="og:url" content="${baseUrl}/">` : "",
    baseUrl
      ? `<meta property="og:image" content="${baseUrl}/${ogFile}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">`
      : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    `<link rel="icon" href="data:,">`,
  ]
    .filter(Boolean)
    .join("\n");
  if (!baseUrl) {
    warn("site.url も VERCEL_PROJECT_PRODUCTION_URL も無いため og:image は絶対URLで出せません（本番ビルドでは自動解決されます）");
  }

  // ── テンプレート差し込み ──
  const printFooter = [
    clean(contact.location),
    contact.phone ? `TEL ${contact.phone}` : "",
    clean(contact.site),
    baseUrl,
  ]
    .filter(Boolean)
    .join(" ｜ ");

  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf-8");
  const tokens = {
    PAGE_TITLE: escapeHtml(pageTitle),
    DESCRIPTION: escapeHtml(description),
    OG_TAGS: ogTags,
    PORTRAIT: portrait
      ? `<img class="portrait" src="${portrait.src}" alt="${escapeHtml(portrait.alt)}" width="${portrait.width}" height="${portrait.height}">`
      : "",
    NAME: escapeHtml(profile.name),
    NAME_ROMAN: escapeHtml(clean(profile.name_roman)),
    TITLE: escapeHtml(profile.title),
    TAGLINE: escapeHtml(clean(profile.tagline)),
    PHILOSOPHY_CORE: escapeHtml(clean(profile.philosophy?.core)),
    PHILOSOPHY_SUB: escapeHtml(clean(profile.philosophy?.sub)),
    BUSINESS_CARDS: cards.join("\n"),
    CAREER: career,
    QUALIFICATIONS: liList(profile.qualifications, "（準備中）"),
    AFFILIATIONS: liList(profile.affiliations, "（準備中）"),
    LECTURE_THEMES: liList(profile.lectures?.themes, "（準備中）"),
    LECTURE_ACHIEVEMENTS: liList(profile.lectures?.achievements, "（準備中）"),
    LOCATION: escapeHtml(clean(contact.location)),
    PHONE: escapeHtml(clean(contact.phone)),
    EMAIL_U: Buffer.from(clean(contact.email_user)).toString("base64"),
    EMAIL_D: Buffer.from(clean(contact.email_domain)).toString("base64"),
    SITE_URL: escapeHtml(clean(contact.site)),
    SITE_LABEL: escapeHtml(clean(contact.site_label) || clean(contact.site)),
    FACEBOOK: escapeHtml(clean(contact.facebook)),
    PRINT_FOOTER: escapeHtml(printFooter),
    UPDATED_AT: escapeHtml(clean(profile.updated_at)),
  };
  for (const [key, value] of Object.entries(tokens)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }
  const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) throw new Error(`未解決のテンプレートトークン: ${leftover.join(", ")}`);

  fs.writeFileSync(path.join(DIST, "index.html"), html);
  fs.copyFileSync(path.join(ROOT, "style.css"), path.join(DIST, "style.css"));
  fs.copyFileSync(path.join(ROOT, "print.css"), path.join(DIST, "print.css"));

  console.log(`✓ dist/ を生成しました（最終更新: ${profile.updated_at}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
