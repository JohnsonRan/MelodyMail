# MelodyMail

[English](README.md) · [简体中文](README.zh-CN.md)

MelodyMail は、自分のドメインで使う 1 人用のメール サービスで、Workers Free プランの 1 つの Cloudflare Worker で動作します。メールの受信、保存、整理、送信を行い、所有者はパスワードではなくパスキーでサインインします。

## 必要なもの

- Cloudflare アカウントと、DNS を Cloudflare で管理しているドメイン。
- Bun 1.4.4、Node.js (wrangler は Node で動作します)、git。
- 任意: 送信用の Resend アカウント、新着メール カード用の Telegram ボット。

## デプロイ

新しい Cloudflare アカウントから始める最短の手順です。すべての確認と任意の機能を含む完全な手順は、[docs/RUNBOOK.md](docs/RUNBOOK.md) (英語) を参照してください。

1. 最初に最終的なホスト名を決めます (例: `mail.example.com`)。パスキーはこのホストに結び付けられるため、別のホストで作成したパスキーはここでは使えません。
2. インストールしてチェックを実行します。

   ```sh
   git clone https://github.com/JohnsonRan/MelodyMail.git
   cd MelodyMail
   bun install --frozen-lockfile
   bun run check
   ```

3. Cloudflare にサインインします。以降のコマンドはすべて `worker/` で実行します。

   ```sh
   cd worker
   bun run wrangler login
   ```

4. データベース、バケット、キューを作成し、ローカルのデプロイ ファイルを用意します。

   ```sh
   bun run wrangler d1 create melodymail --no-update-config
   bun run wrangler r2 bucket create melodymail-mail --no-update-config
   bun run wrangler queues create melodymail-inbound
   cp deploy.example.jsonc deploy.local.jsonc
   ```

   `deploy.local.jsonc` で、`database_id` に `d1 create` が出力した ID を、ルートの pattern にホスト名を設定します。このファイルは git の管理対象外です。

5. マイグレーションを適用してデプロイし、ヘルス チェック エンドポイントを確認します。

   ```sh
   git pull
   bun run migrate:prod
   bun run deploy:prod
   curl https://mail.example.com/api/health
   ```

   `{"ok":true}` が返されます。`migrate:prod` と `deploy:prod` は、コミットされていない変更がない `main` が `origin/main` と一致しているときだけ実行され、それ以外は拒否されます (終了コード 1)。

6. セットアップ トークンを設定します。wrangler に求められたら、生成したランダムな値を貼り付けます。

   ```sh
   openssl rand -base64 32
   bun run wrangler secret put SETUP_TOKEN --config .wrangler-production.jsonc
   ```

7. Cloudflare ダッシュボードで、ドメインを Email Routing に追加し ([Compute] > [Email Service] > [Email Routing] > [Onboard Domain])、追加されるレコードを承認して、catch-all アドレスを [Send to a Worker] の `melodymail` に設定します。`_dmarc` に DMARC の TXT レコードを追加します。

任意の機能は Worker のシークレットで有効になります。

| 機能 | シークレット |
| --- | --- |
| Resend による送信 | `RESEND_API_KEY`、`RESEND_WEBHOOK_SECRET`、`UPLOAD_URL_KEY` |
| Web Push 通知 | `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` |
| Telegram カード | `TELEGRAM_BOT_TOKEN` |

それぞれの手順は [docs/RUNBOOK.md](docs/RUNBOOK.md#optional-features) を参照してください。

## 初めて使う

1. `https://mail.example.com/setup` を開きます。セットアップ トークンを入力し、パスキーを作成して、TOTP のシードを認証アプリに追加します。回復キーはコンピューターの外に保管してください。
2. セットアップ トークンを削除します。セットアップは 1 回だけ実行できます。

   ```sh
   bun run wrangler secret delete SETUP_TOKEN --config .wrangler-production.jsonc
   ```

3. [設定] > [ドメイン] でドメインを追加し、[DNS を確認] を選択します。
4. [設定] > [アドレス] でアドレスを追加します (例: `you@example.com`)。
5. 別のアカウントからそのアドレスにメールを送ります。1 分以内に [受信トレイ] に表示されます。

## 更新とロールバック

リポジトリのルートで実行します。

```sh
git pull
bun install --frozen-lockfile
bun run check
cd worker
bun run migrate:prod
bun run deploy:prod
```

マイグレーションは常にコードより先に実行され、前に進むだけです。ランブックの[更新](docs/RUNBOOK.md#update)セクションでは最初に復元ポイントを記録します。[ロールバック](docs/RUNBOOK.md#roll-back)セクションでは、コードのロールバックと、ロールバック後に残る影響を説明しています。

## バックアップ

D1 Time Travel を使うと、データベースを過去 7 日間の任意の 1 分の時点に復元できます。Worker はデータベースを毎日 R2 にエクスポートもします。元のメールはアカウント内に 2 つ目のコピーがないため、毎月バケットを自分のディスクにコピーしてください。復元、アカウント外のコピー、定期確認については [docs/RUNBOOK.md](docs/RUNBOOK.md#backups) を参照してください。

## ローカルでの開発

リポジトリのルートで実行します。

```sh
cp worker/.dev.vars.example worker/.dev.vars
bun run --cwd web build
bun run --cwd worker db:migrate:local
bun run --cwd worker dev
```

先に `worker/.dev.vars` で `SETUP_TOKEN` を設定し、`http://localhost:8787/setup` を開きます。`127.0.0.1` ではなく `localhost` を使ってください。ブラウザーは IP アドレスでのパスキーを受け付けません。`bun run check` はマージ ゲートです。

## 詳細

- [docs/REFERENCE.md](docs/REFERENCE.md): 各機能の説明 (ルール、転送、通知、送信、REST API)、英語。
- [worker/src/api/openapi.json](worker/src/api/openapi.json): REST API の OpenAPI ドキュメント。
- [docs/RUNBOOK.md](docs/RUNBOOK.md): デプロイ、更新、バックアップ、復元、監視、英語。
