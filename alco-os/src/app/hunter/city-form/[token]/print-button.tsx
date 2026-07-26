"use client";

/** 印刷ボタン。高齢の捕獲者が押しやすいよう大きく */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="min-h-[56px] w-full rounded-xl bg-green-700 px-5 text-base font-bold text-white"
    >
      🖨 印刷 / PDF保存
    </button>
  );
}
