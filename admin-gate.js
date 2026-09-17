/* 管理者専用ページの入口（解析・過年度・買取金額・LCA・売上分析・捕獲条件分析）。
   捕獲者の口座や経営の数字を含むページは管理者だけが見られるようにする。

   使い方:
     <head> に <script src="admin-gate.js"></script> を置き、
     ページの初期化（データ読込）を adminGate(function(){ ... }) で包む。
   業務アプリ（index.html）で管理者コードを入れたセッション（sessionStorage tg_role_v1 = admin）はそのまま通る。
   まだ管理者でないときは、コードを入れるまでデータを読まない（画面も隠す）。 */
(function () {
  var ROLE = 'tg_role_v1', ACCESS = 'tg_access_v1', CODE = '2468';
  function isAdmin() { try { return sessionStorage.getItem(ROLE) === 'admin'; } catch (e) { return false; } }

  function show(onOk) {
    var st = document.createElement('style');
    st.id = 'admin-gate-style';
    st.textContent = 'html[data-admin-gate="closed"] body > :not(#admin-gate){visibility:hidden}';
    document.head.appendChild(st);
    document.documentElement.setAttribute('data-admin-gate', 'closed');
    var g = document.createElement('div');
    g.id = 'admin-gate'; g.setAttribute('role', 'dialog'); g.setAttribute('aria-modal', 'true');
    g.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#eef3ee;display:flex;align-items:center;justify-content:center;padding:16px;font-family:"Noto Sans JP",sans-serif;';
    g.innerHTML = '<div style="background:#fff;border-radius:14px;padding:26px 22px;max-width:380px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.12);text-align:center;">'
      + '<div style="font-size:30px;">🔒</div>'
      + '<h2 style="margin:6px 0 4px;font-size:18px;color:#1a3d1a;">管理者専用ページ</h2>'
      + '<p style="color:#555;font-size:13px;line-height:1.6;margin:0 0 14px;">解析・過年度・買取金額・LCA は、捕獲者の口座や経営の数字を含むため管理者だけが見られます。管理者コードを入力してください。</p>'
      + '<input id="admin-gate-code" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" aria-label="管理者コード" style="font-size:24px;letter-spacing:10px;text-align:center;width:170px;padding:8px 4px;border:2px solid #cbd5cb;border-radius:8px;">'
      + '<div id="admin-gate-err" role="alert" style="color:#c0392b;font-size:13px;min-height:18px;margin-top:6px;"></div>'
      + '<button id="admin-gate-btn" type="button" style="margin-top:8px;background:#2d6a2d;color:#fff;border:0;border-radius:8px;padding:10px 26px;font-size:15px;cursor:pointer;">開く</button>'
      + '<div style="margin-top:14px;font-size:13px;"><a href="index.html" style="color:#2d6a2d;">業務アプリへ戻る</a></div>'
      + '</div>';
    document.body.appendChild(g);
    var inp = g.querySelector('#admin-gate-code'), err = g.querySelector('#admin-gate-err'), btn = g.querySelector('#admin-gate-btn');
    function check() {
      var v = (inp.value || '').trim();
      if (v.length < 4) { err.textContent = '4桁のコードを入れてください'; return; }
      if (v === CODE) {
        try { sessionStorage.setItem(ROLE, 'admin'); sessionStorage.setItem(ACCESS, 'ok'); } catch (e) {}
        document.documentElement.removeAttribute('data-admin-gate');
        g.remove(); st.remove();
        onOk();
        return;
      }
      err.textContent = 'コードが違います';
      inp.value = ''; inp.style.borderColor = '#c0392b';
      setTimeout(function () { inp.style.borderColor = ''; }, 1200);
      inp.focus();
    }
    btn.addEventListener('click', check);
    inp.addEventListener('input', function () { inp.value = inp.value.replace(/[^0-9]/g, ''); if (inp.value.length === 4) check(); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') check(); });
    setTimeout(function () { inp.focus(); }, 50);
  }

  window.adminGate = function (init) {
    if (isAdmin()) return init();
    if (document.body) show(init); else document.addEventListener('DOMContentLoaded', function () { show(init); });
  };
})();
