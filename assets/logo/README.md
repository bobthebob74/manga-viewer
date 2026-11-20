# Manga Viewer ロゴ一式（決定版：N-1 オレンジ / T-2）

Claude Code への指示用ファイルです。このフォルダごとリポジトリ（https://github.com/bobthebob74/manga-viewer ）に渡し、下の「Claude Code への依頼文」を貼り付けてください。

## ファイル

| ファイル | 用途 |
|---|---|
| `logo.svg` | メインロゴ（横組み・背景透過）。濃い青など暗い背景の上で使う |
| `logo-on-navy.svg` / `logo-on-navy.png` | 濃紺背景つきロゴ（OGP画像・SNS・資料用） |
| `logo-light.svg` | 白など明るい背景用（本・anga＝濃紺、Viewer＝濃いオレンジ #E07B12） |
| `logo@2x.png` | メインロゴのPNG（透過・860×340） |
| `mark.svg` | 本の「M」マークのみ（白・透過） |
| `app-icon.svg`, `icon-512.png`, `icon-192.png`, `apple-touch-icon.png` | アプリアイコン（濃紺の角丸＋白い本、下縁オレンジ） |
| `favicon.svg`, `favicon-32.png`, `favicon-16.png` | ファビコン（オレンジの角丸＋濃紺の本） |

文字はすべてアウトライン化済み（パス）なので、フォントを読み込まなくても同じ見た目で表示されます。

## デザイン仕様

- 構成：開いた本＝「M」＋右に「anga」（上段）／「Viewer」（下段）。2行は左右の端を揃える（ジャスティファイ）
- 書体：Nunito ExtraBold（800）
- 本のマーク：外枠＋内ページ線（太さ 6.5、間を塗りつぶし）／本の背・下縁は細め（4.0＝約60%）
- 色
  - 背景（濃い青）：`#163A7D`
  - 濃い背景（フッター等）：`#081A3D`
  - 本・anga：`#FFFFFF`
  - Viewer（アクセント）：`#FF9F40`
- 縦横比：430 × 170（約 2.53 : 1）
- 余白：ロゴの周囲に「本のマークの幅 × 0.25」以上の余白を取る
- 最小サイズ：ロゴは高さ 32px 以上。それより小さい場所は `mark.svg` または `favicon.svg` を使う
- してはいけないこと：縦横比の変更、Viewer 以外の色変更、影・グラデーションの追加

## CSS 変数（サイトに合わせる場合）

```css
:root {
  --mv-navy: #163A7D;
  --mv-navy-deep: #081A3D;
  --mv-orange: #FF9F40;
  --mv-white: #FFFFFF;
}
```

## HTML の例

```html
<!-- <head> 内 -->
<link rel="icon" href="assets/logo/favicon.svg" type="image/svg+xml">
<link rel="icon" href="assets/logo/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="assets/logo/apple-touch-icon.png">
<meta name="theme-color" content="#163A7D">

<!-- ヘッダー -->
<header class="site-header">
  <a href="./" class="site-logo">
    <img src="assets/logo/logo.svg" alt="Manga Viewer" width="152" height="60">
  </a>
</header>
```

```css
.site-header { background: var(--mv-navy); padding: 12px 20px; }
.site-logo img { display: block; height: 48px; width: auto; }
@media (max-width: 480px) { .site-logo img { height: 40px; } }
```

## Claude Code への依頼文（そのまま貼り付け可）

```
manga-viewer-logo/ フォルダに新しいロゴ一式があります。README.md の仕様に従って、サイトに組み込んでください。

1. ロゴファイルを assets/logo/ にコピーする（既存の構成に画像フォルダがあればそれに合わせる）
2. 各ページの <head> にファビコン・apple-touch-icon・theme-color を追加し、既存のファビコン指定があれば置き換える
3. ヘッダーのサイト名表示を logo.svg（alt="Manga Viewer"）に置き換え、ヘッダー背景を #163A7D にする。明るい背景の箇所では logo-light.svg を使う
4. README の CSS 変数を共通 CSS に追加し、サイト内のアクセント色を #FF9F40 に揃える
5. manifest.json（PWA）があれば icons に icon-192.png / icon-512.png を登録する
6. ロゴの縦横比を変えない、ヘッダーで高さ 40〜48px 程度に収める
7. 変更後、スマホ幅（375px）と PC 幅でヘッダーの表示を確認する
```
