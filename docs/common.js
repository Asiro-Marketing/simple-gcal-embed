// ログイン（Google Identity Services のトークン方式）と Google の API の呼び出し。
// サーバーは持たない。予定は見る人のトークンで読むので、見える範囲は Google カレンダーの共有設定どおりになる。
(function () {
  const STORE = 'ncw_token_v2';
  const TZ_OFFSET = 9 * 3600e3; // 表示は日本時間に固定する
  let client = null;
  let waiting = null;

  function saved() {
    try {
      const t = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (t && t.exp > Date.now() + 60e3) return t;
    } catch (e) { /* 保存できない環境では毎回ログインになるだけ */ }
    return null;
  }
  function save(t) { try { localStorage.setItem(STORE, JSON.stringify(t)); } catch (e) {} }
  function clear() { try { localStorage.removeItem(STORE); } catch (e) {} }

  // GIS のスクリプトは async で読むので、読み終わるまで待つ
  NCW.ready = new Promise(function (resolve) {
    (function poll() {
      if (window.google && google.accounts && google.accounts.oauth2) {
        client = google.accounts.oauth2.initTokenClient({
          client_id: NCW.CLIENT_ID,
          scope: NCW.SCOPES,
          hosted_domain: NCW.DOMAIN,
          prompt: '',
          callback: function (r) {
            const w = waiting; waiting = null;
            if (!w) return;
            if (r.error) return w.reject(new Error(r.error_description || r.error));
            const t = {token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000};
            save(t);
            w.resolve(t);
          },
          error_callback: function (e) {
            const w = waiting; waiting = null;
            if (!w) return;
            const msg = e && e.type === 'popup_closed' ? 'ログインの画面が閉じられました。'
              : e && e.type === 'popup_failed_to_open' ? 'ログインの画面を開けませんでした（ポップアップが止められています）。'
              : 'ログインできませんでした。';
            w.reject(Object.assign(new Error(msg), {type: e && e.type}));
          },
        });
        resolve();
      } else {
        setTimeout(poll, 50);
      }
    })();
  });

  // ボタンを押した処理の中で同期的に呼ぶ（ポップアップを止められないため）
  NCW.login = function () {
    return new Promise(function (resolve, reject) {
      if (!client) return reject(new Error('まだ読み込み中です。数秒待ってからもう一度押してください。'));
      waiting = {resolve: resolve, reject: reject};
      client.requestAccessToken();
    });
  };
  NCW.loggedIn = function () { return !!saved(); };
  NCW.logout = function () {
    const t = saved();
    clear();
    if (t && window.google) google.accounts.oauth2.revoke(t.token, function () {});
  };

  NCW.api = async function (url, params, init) {
    const t = saved();
    if (!t) throw Object.assign(new Error('ログインが必要です。'), {code: 401});
    const u = new URL(url);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
    });
    init = init || {};
    init.headers = Object.assign({Authorization: 'Bearer ' + t.token}, init.headers || {});
    const r = await fetch(u, init);
    if (r.status === 401) { clear(); throw Object.assign(new Error('ログインが必要です。'), {code: 401}); }
    if (r.status === 403) {
      const body = await r.text();
      // 新しく足した権限にまだ同意していないときは、ログインし直してもらう
      if (/insufficient.*(scope|permission)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body)) { clear(); throw Object.assign(new Error('ログインが必要です。'), {code: 401}); }
      throw Object.assign(new Error('読み込めませんでした（403）。'), {code: 403});
    }
    if (!r.ok) throw Object.assign(new Error('読み込めませんでした（' + r.status + '）。'), {code: r.status});
    return r.status === 204 ? null : r.json();
  };

  NCW.me = function () {
    return NCW.api('https://openidconnect.googleapis.com/v1/userinfo');
  };

  // 自分が Google カレンダーで見ているカレンダーの一覧（自分の・同僚の・共有カレンダー）
  NCW.calendars = async function () {
    const r = await NCW.api('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      minAccessRole: 'freeBusyReader', maxResults: '250',
      fields: 'items(id,summary,summaryOverride,backgroundColor,primary)',
    });
    return (r.items || []).map(function (c) {
      return {id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '#039be5', primary: !!c.primary};
    }).sort(function (a, b) { return (b.primary - a.primary) || a.name.localeCompare(b.name, 'ja'); });
  };

  // 期間内の予定を、枠で使う形にして返す。cal.color が 'auto' なら予定ごとの色を使う
  NCW.events = async function (cal, fromMs, toMs, hideTitles) {
    const items = [];
    let pageToken;
    do {
      const r = await NCW.api('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(cal.id) + '/events', {
        timeMin: new Date(fromMs).toISOString(),
        timeMax: new Date(toMs).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: '250', pageToken: pageToken,
        fields: 'nextPageToken,items(summary,start,end,colorId,status,visibility,eventType,attendees(self,responseStatus))',
      });
      (r.items || []).forEach(function (ev) {
        const x = pick(ev, hideTitles, cal);
        if (x) items.push(x);
      });
      pageToken = r.nextPageToken;
    } while (pageToken);
    return items;
  };

  // Google カレンダーの予定の色（colorId）
  const COLORS = {1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000'};

  function pick(ev, hideTitles, cal) {
    if (ev.status === 'cancelled') return null;
    if (ev.eventType === 'workingLocation') return null; // 勤務場所の札は時間割に出さない
    const self = (ev.attendees || []).filter(function (a) { return a.self; })[0];
    if (self && self.responseStatus === 'declined') return null;
    const allDay = !!(ev.start && ev.start.date);
    // 非公開の予定は、見る人が持ち主本人でも中身を出さない（埋め込んだ先は他の人も開くため）
    const hide = hideTitles || ev.visibility === 'private' || ev.visibility === 'confidential' || !ev.summary;
    return {
      title: hide ? '予定あり' : ev.summary,
      allDay: allDay,
      start: allDay ? jstDateMs(ev.start.date) : Date.parse(ev.start.dateTime),
      end: allDay ? jstDateMs(ev.end.date) : Date.parse(ev.end.dateTime),
      color: cal.color && cal.color !== 'auto' ? cal.color : (COLORS[ev.colorId] || '#039be5'),
      tentative: !!(self && self.responseStatus === 'needsAction'),
      cal: cal.label || '',
    };
  }

  /* ---------- 作ったリンクの保存（各自の Google ドライブの、この道具専用の見えない場所） ---------- */
  const FILE = 'simple-gcal-embed-links.json';
  let fileId = null;
  NCW.loadLinks = async function () {
    const r = await NCW.api('https://www.googleapis.com/drive/v3/files', {spaces: 'appDataFolder', q: "name='" + FILE + "'", fields: 'files(id)'});
    fileId = r.files && r.files[0] ? r.files[0].id : null;
    if (!fileId) return [];
    const data = await NCW.api('https://www.googleapis.com/drive/v3/files/' + fileId, {alt: 'media'});
    return data && Array.isArray(data.links) ? data.links : [];
  };
  NCW.saveLinks = async function (links) {
    const body = JSON.stringify({links: links, savedAt: new Date().toISOString()});
    if (fileId) {
      return NCW.api('https://www.googleapis.com/upload/drive/v3/files/' + fileId, {uploadType: 'media'},
        {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: body});
    }
    const boundary = 'b' + Math.random().toString(36).slice(2);
    const multi = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
      + JSON.stringify({name: FILE, parents: ['appDataFolder']}) + '\r\n--' + boundary
      + '\r\nContent-Type: application/json\r\n\r\n' + body + '\r\n--' + boundary + '--';
    const r = await NCW.api('https://www.googleapis.com/upload/drive/v3/files', {uploadType: 'multipart', fields: 'id'},
      {method: 'POST', headers: {'Content-Type': 'multipart/related; boundary=' + boundary}, body: multi});
    fileId = r.id;
    return r;
  };

  /* ---------- 日本時間の日付・曜日 ---------- */
  function jstDateMs(ymd) {
    const p = ymd.split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]) - TZ_OFFSET;
  }
  NCW.jst = function (ms) { return new Date(ms + TZ_OFFSET); }; // getUTC* で日本時間の値を読む
  NCW.dayStart = function (ms) {
    const d = NCW.jst(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TZ_OFFSET;
  };
  NCW.weekStart = function (ms, sunday) {
    const s = NCW.dayStart(ms);
    const back = sunday ? NCW.jst(s).getUTCDay() : (NCW.jst(s).getUTCDay() + 6) % 7;
    return s - back * 864e5;
  };
  NCW.monthStart = function (ms) {
    const d = NCW.jst(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_OFFSET;
  };
  NCW.addMonths = function (ms, n) {
    const d = NCW.jst(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) - TZ_OFFSET;
  };
  NCW.WD = ['日', '月', '火', '水', '木', '金', '土'];
  NCW.md = function (ms) {
    const d = NCW.jst(ms);
    return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '(' + NCW.WD[d.getUTCDay()] + ')';
  };
  NCW.hm = function (ms) {
    const d = NCW.jst(ms);
    return d.getUTCHours() + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  };

  /* ---------- 埋め込みリンクの設定（# の後ろに置くので、サーバーへは送られない） ---------- */
  // c=カレンダーID|色(#rrggbb か auto)|表示名 を、カレンダーの数だけ並べる
  NCW.readHash = function (hash) {
    const q = new URLSearchParams((hash === undefined ? location.hash : hash).replace(/^#/, ''));
    let cals = q.getAll('c').map(function (v) {
      const p = v.split('|');
      return {id: p[0], color: /^#[0-9a-fA-F]{6}$/.test(p[1] || '') ? p[1] : 'auto', label: p.slice(2).join('|')};
    }).filter(function (c) { return c.id; });
    if (!cals.length && q.get('cal')) cals = [{id: q.get('cal'), color: 'auto', label: ''}]; // 最初の版のリンク
    const h = (q.get('h') || '').match(/^(\d{1,2})-(\d{1,2})$/);
    return {
      cals: cals,
      title: q.get('title') || q.get('name') || '',
      view: ['week', 'day', 'month', 'list'].indexOf(q.get('view')) >= 0 ? q.get('view') : 'auto',
      sunday: q.get('ws') === '0',
      days: q.get('days') === '5' ? 5 : 7,
      hours: h && +h[1] < +h[2] && +h[2] <= 24 ? [+h[1], +h[2]] : null,
      allday: q.get('allday') !== '0',
      hide: q.get('hide') === '1',
      theme: ['dark', 'system'].indexOf(q.get('theme')) >= 0 ? q.get('theme') : 'light',
      clear: q.get('bg') === 'clear',
      nav: q.get('nav') !== '0',
      demo: q.get('demo') === '1',
    };
  };
  NCW.makeHash = function (o) {
    const q = new URLSearchParams();
    (o.cals || []).forEach(function (c) { q.append('c', [c.id, c.color || 'auto', c.label || ''].join('|')); });
    if (o.title) q.set('title', o.title);
    if (o.view && o.view !== 'auto') q.set('view', o.view);
    if (o.sunday) q.set('ws', '0');
    if (o.days === 5) q.set('days', '5');
    if (o.hours) q.set('h', o.hours[0] + '-' + o.hours[1]);
    if (o.allday === false) q.set('allday', '0');
    if (o.hide) q.set('hide', '1');
    if (o.theme && o.theme !== 'light') q.set('theme', o.theme);
    if (o.clear) q.set('bg', 'clear');
    if (o.nav === false) q.set('nav', '0');
    if (o.demo) q.set('demo', '1');
    return '#' + q.toString();
  };
})();
