# Postiz + Zernio YouTube

このフォークは upstream の [Postiz](https://github.com/gitroomhq/postiz-app) に、
**YouTube だけを [Zernio API](https://docs.zernio.com) 経由で投稿する小さなパッチ**を
載せたものです。X と Instagram は Postiz 既存の公式 API 連携をそのまま使います。

```text
Postiz (self-host / Docker)
├── X          → Postiz 既存 X provider          → X 公式 API
├── Instagram  → Postiz 既存 Instagram provider  → Meta 公式 API
└── YouTube    → YouTube (Zernio) provider       → Zernio API → YouTube
```

自分の Google Cloud Project や YouTube Data API の監査は不要です。YouTube との
OAuth 接続とアップロードは Zernio 側で行われます。

> 情報は 2026-09-18 時点で Zernio 公式ドキュメント / OpenAPI v1.21.1
> (https://zernio.com/openapi.json) / 料金ページで確認したものです。

---

## Architecture

### 変更の全体像

| 種別 | ファイル | 目的 |
| --- | --- | --- |
| 新規 | `libraries/nestjs-libraries/src/integrations/zernio/zernio.client.ts` | Zernio API client。Zernio 呼び出しはすべてここに集約 |
| 新規 | `libraries/nestjs-libraries/src/integrations/social/youtube.zernio.provider.ts` | `youtube-zernio` provider（接続・投稿・状態確認・retry） |
| 新規 | `apps/frontend/public/icons/platforms/youtube-zernio.png` | チャンネルアイコン（YouTube アイコンの複製） |
| 1行追加 | `libraries/nestjs-libraries/src/integrations/integration.manager.ts` | provider 登録（import + リスト 1 行） |
| 3行追加 | `libraries/nestjs-libraries/src/dtos/posts/providers-settings/all.providers.settings.ts` | 設定 DTO の登録（`YoutubeSettingsDto` を継承した `YoutubeZernioSettingsDto`） |
| 新規 | `libraries/nestjs-libraries/src/dtos/posts/providers-settings/youtube.zernio.settings.dto.ts` | category / playlist / AI 生成開示 / first comment を追加した設定 DTO |
| 5行追加 | `apps/frontend/src/components/new-launch/providers/show.all.providers.tsx` | 投稿画面に YouTube (Zernio) 設定 UI を割り当て |
| 新規 | `apps/frontend/src/components/new-launch/providers/youtube-zernio/*.tsx` | 設定 UI（YouTube と同じ項目 + category / playlist / AI 生成開示 / first comment） |
| 4行追加 | `apps/frontend/src/components/platform-analytics/platform.analytics.tsx` | Analytics 画面の対象チャンネル一覧に `youtube-zernio` を追加 |
| 1行追加 | `apps/frontend/src/components/new-launch/providers/continue-provider/list.tsx` | 接続時のチャンネル選択に既存 YouTube 画面を割り当て |
| 3行追加 | `.dockerignore` | `.env` を build context に入れない（secret 混入防止） |
| 新規 | `docker-compose.override.yml`, `.env.docker.example` | 自前 image の build と環境変数（upstream の compose は無変更） |
| 新規 | `libraries/nestjs-libraries/src/integrations/zernio/*.spec.ts`, `jest.config.js`, `tools/zernio-mock/` | テストと Zernio mock server |
| 新規 | `tools/sync-upstream.sh`, `.github/workflows/zernio-upstream-sync.yml` | upstream 追従 |

DB schema、scheduler / workflow、認証、既存 provider（X / Instagram / YouTube）は変更していません。

### 投稿の流れ

```text
Postiz UI（カレンダーで予約）
 ↓ POST /posts
backend: 投稿を DB に保存し Temporal workflow を開始
 ↓
orchestrator: post workflow が予約時刻まで sleep（upstream のまま）
 ↓ 予約時刻
YoutubeZernioProvider.postPending    … 動画/サムネイルの presign（POST /v1/media/presign）
 ↓ (pending)
checkPostStatus → 'ready'
 ↓
finalizePost                         … presigned URL へ動画/サムネイルを PUT
                                        POST /v1/posts (publishNow, x-request-id)
 ↓ (pending)
checkPostStatus（20 秒ごと）          … GET /v1/posts/{id}
   published → 完了（YouTube URL を Postiz に記録）
   failed(一時的) → finalizePost で POST /v1/posts/{id}/retry（最大 ZERNIO_MAX_RETRIES 回）
   failed(恒久的) → Postiz 上で投稿エラー + 通知
```

- **予約・タイムゾーン**は Postiz 本体が管理します（UI で選んだ日時を UTC で保存し、
  その時刻に workflow が provider を呼ぶ）。Zernio には公開時刻に `publishNow: true`
  で渡します。
- **二重投稿防止**: Zernio の `x-request-id`（5 分間の冪等キー）と、同一内容の 24 時間
  重複検知（HTTP 409 → 既存 post id を採用）を使います。presign は postPending で
  1 回だけ行うため、再試行時もメディア URL が変わらず重複検知が効きます。
- **ローカルストレージ**: Postiz の local storage ではメディア URL が
  `http://localhost:4007/uploads/...` になり、コンテナ内からは到達できません。provider は
  このパスを `UPLOAD_DIRECTORY` 内のファイルに読み替えて Zernio へストリーム送信します。
  Cloudflare R2 等の外部ストレージの場合は URL から取得して送信します。

### 接続の流れ

```text
Add Channel → "YouTube (Zernio)"
 ↓ GET /v1/connect/youtube?profileId=..&redirect_url=<Postiz callback>
Zernio がホストする Google OAuth（チャンネル所有者の Google アカウントで許可）
 ↓ Postiz callback (/integrations/social/youtube-zernio?state=..)
GET /v1/accounts?platform=youtube → 既存の YouTube チャンネル選択画面で選ぶ
```

Postiz DB に保存されるのは Zernio の profile id と account id だけで、**API key は保存しません**
（常に環境変数 `ZERNIO_API_KEY` から読む）。

---

## Installation

前提: Docker（Mac は Docker Desktop、メモリ 8GB 以上推奨。初回 build に 4GB 以上使用）。

```bash
git clone https://github.com/<you>/postiz-app.git
cd postiz-app
git remote add upstream https://github.com/gitroomhq/postiz-app.git

cp .env.docker.example .env      # 値を記入（下記）
docker compose build postiz      # 初回は数分〜数十分（M 系 Mac + 8GB で約 5 分）
docker compose up -d
open http://localhost:4007       # アカウント登録 → ログイン
```

`docker compose up -d` は upstream の `docker-compose.yaml` と `docker-compose.override.yml`
を自動で合成し、postiz（frontend / backend / orchestrator）、postgres、redis、temporal 一式、
temporal-ui、spotlight を起動します。

---

## Environment Variables

`.env`（git 管理外）に書きます。`.env.docker.example` が雛形です。

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `POSTIZ_URL` | ○ | Postiz の公開 URL（例 `http://localhost:4007`、本番は https） |
| `JWT_SECRET` | ○ | ランダムな長い文字列（`openssl rand -hex 32`） |
| `ZERNIO_API_KEY` | ○（YouTube） | Zernio の API key（`sk_` + 64 hex）。Zernio 公式 SDK と同じ変数名 |
| `ZERNIO_PROFILE_ID` | – | 接続先の Zernio profile。未指定なら default profile |
| `ZERNIO_API_URL` | – | API base URL の上書き（既定 `https://zernio.com/api`。mock 用） |
| `ZERNIO_MAX_RETRIES` | – | Zernio 側の一時的な失敗時の自動 retry 回数（既定 2） |
| `HIDDEN_PROVIDERS` | – | `youtube` を指定すると Google Cloud 版 YouTube を Add Channel から隠す |
| `X_API_KEY` / `X_API_SECRET` | X 利用時 | X Developer Portal のアプリの API Key / Secret |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Instagram (Facebook Business) 利用時 | Meta アプリ |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Instagram (Standalone) 利用時 | Instagram アプリ |

X / Instagram の callback URL は `${POSTIZ_URL}/integrations/social/x`、
`.../instagram`、`.../instagram-standalone` です（Postiz upstream と同じ）。

---

## Zernio API Setup

1. https://zernio.com でサインアップ / ログイン
2. [API keys](https://zernio.com/dashboard/api-keys) で **Create API key**
3. 表示された key（`sk_` + 64 桁 hex）をすぐにコピーして `.env` の `ZERNIO_API_KEY` に設定
   （Zernio は SHA-256 hash しか保存しないため再表示できません）
4. `docker compose up -d` で postiz を再作成して反映

認証は `Authorization: Bearer <key>`、base URL は `https://zernio.com/api/v1`。

### 料金（2026-09-18 時点、https://zernio.com/pricing ）

- プラン制ではなく**接続したソーシャルアカウント数による段階課金**
  - 1〜2 アカウント目: 無料（クレジットカード不要）
  - 3〜10 アカウント目: $6 / 月 / アカウント
  - 11〜100 アカウント目: $3 / 月 / アカウント
  - 101 アカウント目以降: $1 / 月 / アカウント
- 全アカウントに scheduling / analytics / inbox / **API フルアクセス** / 投稿数無制限が含まれる
- この構成では Zernio に接続するのは YouTube チャンネルだけなので、YouTube 1〜2 チャンネルなら無料枠内
  （X / Instagram は Zernio に接続しません）

### 制限（Zernio 公式ドキュメント）

- API rate limit は接続アカウント数に応じて 60 / 600 / 1,200 req/min
- 投稿 velocity 上限 25 posts / hour / account

---

## Connecting YouTube

YouTube 連携の条件（Zernio docs `/platforms/youtube`）:

- YouTube チャンネルを所有する Google アカウント（個人またはブランドアカウント。ブランドアカウントは owner / manager 権限）
- 未確認（未認証）チャンネルは動画 15 分まで。電話番号確認（https://www.youtube.com/verify）で最長 12 時間
- カスタムサムネイルは電話番号確認済みチャンネルのみ、JPEG / PNG / GIF、2MB 以下、推奨 1280×720。Shorts には不可
- ファイルサイズ上限 256GB

手順:

1. Postiz → **Add Channel** → **YouTube (Zernio)**
2. Zernio 経由の Google 画面で YouTube チャンネルのアカウントを選んで許可
3. Postiz に戻り、表示されたチャンネルを選択して保存

Zernio ダッシュボードで既に接続済みのチャンネルも同じ選択画面に表示されます。

---

## Creating a Scheduled YouTube Post

1. カレンダーで **Create Post**、チャンネルに **YouTube (Zernio)** を選択
2. 本文 = YouTube の説明文（最大 5000 文字）
3. 動画を 1 本添付（mp4 / mov / webm / m4v / mpeg / avi）
4. YouTube (Zernio) の設定タブ:
   - **Title**（必須、2〜100 文字）
   - **Type**: Public / Private / Unlisted
   - **Made for kids**
   - **Tags**（合計 500 文字まで）
   - **Category**（未選択なら People & Blogs）
   - **Playlist**（Zernio 経由でチャンネルの再生リストを取得）
   - **Contains AI-generated / altered content**（YouTube の合成コンテンツ開示）
   - **First comment**（公開直後に投稿される最初のコメント、10,000 文字まで）
   - **Thumbnail**（任意）
5. 日時（ブラウザ / Postiz 設定のタイムゾーンで表示）を選んで **Add to calendar**

予約時刻になると Postiz が Zernio に投稿し、公開後はカレンダー上の投稿に YouTube の URL が
付きます。失敗時は投稿がエラー表示になり、通知にエラー内容（Zernio の `errorMessage`）が出ます。
Zernio 側の一時的な失敗（`platform_error` 等）は `ZERNIO_MAX_RETRIES` 回まで自動で retry します。
それでも失敗した場合は、原因（通知のメッセージ）を解消してから同じ内容で投稿を作成し直してください。

**安全な確認手順**: 最初は Private か Unlisted、短いテスト動画、数分後の予約時刻で試し、
成功を確認してから Public を使ってください。

---

## Updating from upstream Postiz

`main` は「upstream/main + 少数のパッチ commit」という形を保ちます。

```bash
tools/sync-upstream.sh           # backup branch 作成 → rebase → install → Zernio テスト
docker compose build postiz && docker compose up -d   # 動作確認
git push --force-with-lease origin main
# または tools/sync-upstream.sh --push
```

手動で行う場合:

```bash
git fetch upstream
git checkout main
git rebase upstream/main
pnpm install --frozen-lockfile
pnpm exec jest -c libraries/nestjs-libraries/src/integrations/zernio/jest.config.js
git push --force-with-lease origin main
```

### GitHub Actions

`.github/workflows/zernio-upstream-sync.yml` が毎日（と手動実行で）:

1. `upstream/main` へ rebase
2. `pnpm install` → Zernio テスト → `pnpm run build`
3. 成功: `sync/upstream` ブランチへ push（repository variable `AUTO_UPDATE_MAIN=true` なら main も更新。
   ※ この場合レビューなしで main が force-with-lease 更新されるため、既定の false を推奨）
4. 失敗: issue を作成 / 追記

フォークでは Actions が既定で無効です。GitHub の Actions タブで有効化してください。
upstream 由来の `stale.yml` / `staging-conflicts.yml`（10〜30 分ごとの schedule）はフォークでは
不要なので `gh workflow disable stale.yml` 等で無効化を推奨します。

### conflict しやすい箇所

パッチは既存ファイルに計 19 行しか触れていません。conflict するのは upstream が同じ行の
周辺を変更した場合だけです。

- `integration.manager.ts`: `YoutubeProvider` の import 直後 / `new YoutubeProvider(),` の直後
- `all.providers.settings.ts`: `'youtube'` の型・配列要素の直後
- `show.all.providers.tsx`: YouTube provider の import 直後 / `identifier: 'youtube'` ブロックの直後
- `platform.analytics.tsx`: 各 allowlist の `'youtube'` の直後（upstream が analytics 対応チャンネルを増減すると衝突しやすい）
- `continue-provider/list.tsx`: `youtube: YoutubeContinue,` の直後
- `.dockerignore`: 末尾

provider interface（`social.integrations.interface.ts`）や pending フロー
（`checkPostStatus` / `finalizePost`）の契約が upstream で変わった場合は
`youtube.zernio.provider.ts` の追従が必要です。テストが検知します。

---

## Tests

```bash
pnpm install --frozen-lockfile
pnpm exec jest -c libraries/nestjs-libraries/src/integrations/zernio/jest.config.js
```

- unit: API client（認証ヘッダ、エラー、key のマスク、レスポンス解析、冪等性、409）、provider（検証、接続、投稿フロー、追加設定、playlist、analytics、retry、失敗）
- integration: `tools/zernio-mock/server.mjs` を起動し、実 HTTP で account 取得 → media upload → post 作成（追加設定込み）→ 公開 / retry / 失敗、playlist 一覧、チャンネル / 投稿 analytics

Docker 上で UI から試す（実 YouTube に投稿しない）:

```bash
# .env に ZERNIO_API_URL=http://zernio-mock:4010/api と ZERNIO_API_KEY=sk_mock を設定
docker compose --profile zernio-mock up -d
```

mock はタイトルに `[fail-once]`（1 回失敗→retry で成功）、`[fail]`（常に一時的失敗）、
`[user-error]`（恒久的失敗）を含めると失敗を再現します。状態は
`http://localhost:4010/__mock/state` で確認できます。

---

## Troubleshooting

| 症状 | 原因 / 対処 |
| --- | --- |
| Add Channel で YouTube (Zernio) を押しても何も起きない / エラー | `ZERNIO_API_KEY` 未設定か不正。`docker compose logs postiz` を確認、`.env` 修正後 `docker compose up -d` |
| 「Zernio rejected the API key」 | key の失効・誤り。Zernio で key を再発行 |
| チャンネル選択画面が空 | Google 画面でキャンセルした、または別 profile に接続された。`ZERNIO_PROFILE_ID` と Zernio ダッシュボードの Accounts を確認 |
| 「The YouTube account is disconnected in Zernio」 | Zernio 側でトークン失効。Postiz でチャンネルを「Reconnect」 |
| 「Could not confirm the post status」 | 約 30 分（upstream workflow のポーリング上限）以内に Zernio が完了を返さなかった。YouTube / Zernio ダッシュボードで実際の状態を確認し、重複投稿しないこと |
| 「Video too long」系 | 未確認チャンネルの 15 分制限。youtube.com/verify |
| サムネイルが反映されない | チャンネル未確認、2MB 超、または Shorts |
| `Set JWT_SECRET in .env` で compose が止まる | `.env` がない / `JWT_SECRET` 空 |
| `docker compose ps` で postiz が `unhealthy`、画面が 502 | 起動直後に backend / orchestrator が応答しないまま止まることがある（検証では cold start 31 回中 4 回、upstream image では 18 回中 0 回。原因は未特定）。`docker compose restart postiz` で復旧 |
| temporal が `Exited (1)`（`no usable database connection`） | upstream compose は DB 起動を待たないため。override で `restart: on-failure` と healthcheck を追加済み。postiz は temporal が準備完了してから起動する |

---

## Security

- `ZERNIO_API_KEY` は `.env`（`.gitignore` 済み）→ 環境変数でのみ渡し、ソース・DB・Git に入れない
- `.env` / `.env.*` は `.dockerignore` で build context から除外（image layer に入らない）
- API key は `Authorization` ヘッダでのみ送信。URL・body・ログ・Temporal history・UI に出るエラー文からは
  client がマスク（`[REDACTED]`）
- presigned upload URL へは API key を送らない
- Postiz DB に保存されるのは Zernio profile id / account id のみ
- 本番では `POSTIZ_URL` を https にし、`DISABLE_REGISTRATION=true` を推奨

---

## Known limitations

- 予約は Postiz 側で管理し、公開時刻に Zernio へ `publishNow` で送信します。YouTube の
  `publishAt`（事前アップロード）は使わないため、大きな動画は公開時刻からアップロード・処理時間分
  遅れて公開されます
- 状態確認は upstream workflow の上限（20 秒 × 90 回 ≒ 30 分）まで。超えると「未確認」エラー扱い
- category の選択肢は Zernio docs に記載の ID のみ（YouTube 側で地域により選べない ID があれば Zernio がエラーを返す）
- `notifySubscribers` は Zernio API に存在しないため未対応
- Shorts は YouTube が自動判定（3 分以下かつ縦長）。専用フラグなし
- analytics: Postiz の Analytics 画面（チャンネル単位: Views / Estimated Minutes Watched / Average View Duration /
  Subscribers Gained / Subscribers Lost）と投稿の Statistics（Views / Likes / Comments / Shares）に表示。
  YouTube 側のデータは 2〜3 日遅れ、チャンネル集計は最大 89 日（90 日表示は 89 日に丸める）。
  チャンネルに `yt-analytics.readonly` 権限が無いと Zernio が 412 を返し、データなし表示になる（再接続で解消）。
  旧プランの Zernio アカウントは Analytics add-on が必要（402）。従量制プランは追加費用なし
- Postiz で公開済み投稿を削除しても YouTube 側の動画は削除されない
- `ZERNIO_API_KEY` はインスタンス全体で 1 つ（全 organization が同じ Zernio アカウントを使う）
