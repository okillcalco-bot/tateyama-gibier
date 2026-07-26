"use client";

/** 印刷ボタン（高齢者UI: 高さ56px以上・何が起きるか書く） */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="min-h-[56px] rounded-xl border-2 border-stone-400 bg-white px-5 text-base font-bold text-stone-700"
    >
      🖨 印刷 / PDF保存
    </button>
  );
}
