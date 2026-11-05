// OAuth クライアント ID（Google Cloud の「OAuth 2.0 クライアント ID（ウェブ アプリケーション）」）。
// ブラウザに渡る値なので公開してよい。同意画面を「内部」にしたプロジェクトで作ると、会社のアカウントしかログインできない。
window.NCW = {
  CLIENT_ID: 'REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com',
  DOMAIN: 'asiro.co.jp',
  SCOPES: 'openid email profile https://www.googleapis.com/auth/calendar.events.readonly',
};
