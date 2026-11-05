// ログイン（Google Identity Services のトークン方式）と Google カレンダー API の呼び出し。
// サーバーは持たない。予定は見る人のトークンで読むので、見える範囲は Google カレンダーの共有設定どおりになる。
(function () {
  const STORE = 'ncw_token_v1';
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
            w.reject(new Error(msg));
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

  NCW.api = async function (url, params) {
    const t = saved();
    if (!t) throw Object.assign(new Error('ログインが必要です。'), {code: 401});
    const u = new URL(url);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
    });
    const r = await fetch(u, {headers: {Authorization: 'Bearer ' + t.token}});
    if (r.status === 401) { clear(); throw Object.assign(new Error('ログインが必要です。'), {code: 401}); }
    if (!r.ok) throw Object.assign(new Error('読み込めませんでした（' + r.status + '）。'), {code: r.status});
    return r.json();
  };

  NCW.me = function () {
    return NCW.api('https://openidconnect.googleapis.com/v1/userinfo');
  };

  // その週（月曜0時〜7日間・日本時間）の予定を、部品で使う形にして返す
  NCW.week = async function (cal, weekStartMs, hideTitles) {
    const items = [];
    let pageToken;
    do {
      const r = await NCW.api('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(cal) + '/events', {
        timeMin: new Date(weekStartMs).toISOString(),
        timeMax: new Date(weekStartMs + 7 * 864e5).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: '250', pageToken: pageToken,
        fields: 'nextPageToken,items(summary,start,end,colorId,status,visibility,eventType,attendees(self,responseStatus))',
      });
      (r.items || []).forEach(function (ev) {
        const x = pick(ev, hideTitles);
        if (x) items.push(x);
      });
      pageToken = r.nextPageToken;
    } while (pageToken);
    return items;
  };

  // Google カレンダーの予定の色（colorId）。色を付けていない予定は既定の青にする
  const COLORS = {1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000'};

  function pick(ev, hideTitles) {
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
      color: COLORS[ev.colorId] || '#039be5',
      tentative: !!(self && self.responseStatus === 'needsAction'),
    };
  }

  // 日本時間の日付・曜日の計算
  function jstDateMs(ymd) {
    const p = ymd.split('-').map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2]) - TZ_OFFSET;
  }
  NCW.jst = function (ms) { return new Date(ms + TZ_OFFSET); }; // getUTC* で日本時間の値を読む
  NCW.dayStart = function (ms) {
    const d = NCW.jst(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TZ_OFFSET;
  };
  NCW.weekStart = function (ms) {
    const s = NCW.dayStart(ms);
    const back = (NCW.jst(s).getUTCDay() + 6) % 7; // 月曜を0にする
    return s - back * 864e5;
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

  // 埋め込みリンクの設定は # の後ろに置く（サーバーへ送られない）
  NCW.readHash = function () {
    const q = new URLSearchParams(location.hash.replace(/^#/, ''));
    return {
      cal: q.get('cal') || '',
      name: q.get('name') || '',
      view: q.get('view') === 'day' ? 'day' : q.get('view') === 'week' ? 'week' : 'auto',
      days: q.get('days') === '5' ? 5 : 7,
      hide: q.get('hide') === '1',
      theme: q.get('theme') === 'dark' ? 'dark' : 'light',
    };
  };
  NCW.makeHash = function (o) {
    const q = new URLSearchParams();
    q.set('cal', o.cal);
    if (o.name) q.set('name', o.name);
    if (o.view && o.view !== 'auto') q.set('view', o.view);
    if (o.days === 5) q.set('days', '5');
    if (o.hide) q.set('hide', '1');
    if (o.theme === 'dark') q.set('theme', 'dark');
    return '#' + q.toString();
  };
})();
